import { describe, expect, it } from "vitest";
import { EventLog, Evaluation, Ledger, Returns, Settings, openDb } from "../src/index.js";
import { Entry } from "../src/entry/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";

/**
 * 出戻り（退出 → 再参加 → 申請 → 運営判断 → 反映）。
 *
 * 再参加で自動復帰させないこと、以前の階級を失わないこと、亡霊復帰が
 * **評価を最初からやり直す**（過去の印も過去の招待も持ち越さない）ことが要点。
 */

registerDefaultTxTypes();
const STAFF = "user:staff";
const DAY = 86_400;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const returns = new Returns(db, settings, events);
  return { db, ledger, settings, events, entry, evaluation, returns };
}

const soulOf = (ctx: ReturnType<typeof setup>, id = "u1") => ctx.entry.getSoul(id)!;

/** 亡霊まで進めてから魔人へ上げた在籍者 */
function member(ctx: ReturnType<typeof setup>, id = "u1") {
  ctx.entry.recordJoin(id);
  ctx.entry.ghostify(id, STAFF);
  ctx.evaluation.promoteToMajin(id, STAFF);
  return id;
}

describe("退出と再参加", () => {
  it("退出では階級を落とさず、退出時刻と当時の階級だけ記録する", () => {
    const ctx = setup();
    const id = member(ctx);

    expect(ctx.returns.recordDeparture(id)).toBe(true);

    const soul = soulOf(ctx);
    expect(soul.status).toBe("majin"); // 階級は退出で消えない
    expect(soul.left_at).not.toBeNull();
    expect(soul.rank_at_leave).toBe("majin");
    expect(ctx.events.listByTarget(id).map((e) => e.type)).toContain("entry_left");
  });

  it("再参加ではいったん案内待ちへ戻し、以前の階級は退避して失わない", () => {
    const ctx = setup();
    const id = member(ctx);
    ctx.returns.recordDeparture(id);

    const previous = ctx.returns.markReturnedToWaiting(id, null);

    expect(previous).toBe("majin");
    const soul = soulOf(ctx);
    expect(soul.status).toBe("waiting"); // **自動復帰させない**
    expect(soul.rank_at_leave).toBe("majin"); // 以前の階級は残る
    expect(soul.returned_at).not.toBeNull();
    // 古い評価サイクルは畳む（期限が残ると判断を誤らせる）
    expect(soul.eval_deadline_at).toBeNull();
    expect(soul.eval_started_at).toBeNull();
    expect(ctx.events.listByTarget(id).map((e) => e.type)).toContain("entry_returned_to_waiting");
  });

  it("退出の記録が無くても、Discord側の参加時刻が新しければ再参加と認める", () => {
    const ctx = setup();
    const id = member(ctx);
    const soulJoined = soulOf(ctx).joined_at!;
    // recordDeparture を呼ばずにいきなり再参加（Bot停止中に抜けた場合）
    expect(ctx.returns.markReturnedToWaiting(id, soulJoined + 3600)).toBe("majin");
    expect(soulOf(ctx).rank_at_leave).toBe("majin");
  });

  it("退出の証拠が無ければ何もしない（在籍中の人を入城前へ落とさない）", () => {
    const ctx = setup();
    const id = member(ctx);
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(id);

    // GuildMemberAdd が在籍中の人へ再送された状況。退出記録も無く、参加時刻も動いていない
    expect(ctx.returns.markReturnedToWaiting(id, soulOf(ctx).joined_at)).toBeNull();

    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(id)).toEqual(before);
    expect(ctx.events.listByTarget(id).map((e) => e.type)).toContain("entry_rejoin_ignored");
  });

  it("迷霊だった人は ever_meirei が立つ（判断画面に出すため）", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    ctx.entry.ghostify("u1", STAFF);
    ctx.evaluation.demoteToMeirei("u1", STAFF, "期限到達");
    // 迷霊になった時点で既に立つ（再参加を待たない）
    expect(soulOf(ctx).ever_meirei).toBe(1);
    ctx.returns.recordDeparture("u1");

    ctx.returns.markReturnedToWaiting("u1", null);

    expect(soulOf(ctx).ever_meirei).toBe(1);
    expect(ctx.returns.context("u1").everMeirei).toBe(true);
    expect(ctx.returns.context("u1").rankAtLeave).toBe("meirei");
  });

  it("Landも履歴も再参加で消えない", () => {
    const ctx = setup();
    const id = member(ctx);
    ctx.evaluation.addMark(id, "promotion", "user:e1", "evaluation");
    const land = ctx.ledger.balanceOf(`user:${id}`);

    ctx.returns.markReturnedToWaiting(id, null);

    expect(ctx.ledger.balanceOf(`user:${id}`)).toBe(land);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id=?").get(id)).toEqual({ n: 1 });
  });
});

describe("運営が選ぶ戻し先", () => {
  function returnee(ctx: ReturnType<typeof setup>, id = "u1") {
    member(ctx, id);
    ctx.returns.recordDeparture(id);
    ctx.returns.markReturnedToWaiting(id, null);
    return id;
  }

  it("亡霊復帰は評価を最初からやり直す（必要アリ +1・印は無効化・招待は持ち越さない）", () => {
    const ctx = setup();
    const id = returnee(ctx);
    ctx.evaluation.addMark(id, "promotion", "user:e1", "evaluation");
    ctx.evaluation.addMark(id, "demotion", "user:e2", "evaluation");
    for (const guest of ["g1", "g2", "g3", "g4"]) {
      ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run(id, guest, 1);
    }

    const result = ctx.returns.reinstate(id, "ghost", STAFF, { reason: "テスト" })!;

    const soul = soulOf(ctx);
    expect(soul.status).toBe("ghost");
    expect(soul.eval_started_at).toBe(soul.ghost_at);
    expect(soul.eval_deadline_at).toBe(soul.eval_started_at! + 14 * DAY);
    // 通常5 + 出戻りの上乗せ1
    expect(soul.eval_promotion_required).toBe(6);
    expect(result.cycle!.promotionRequired).toBe(6);
    // 過去の招待4人は起点として焼かれ、今回のサイクルには持ち越さない
    expect(soul.eval_invite_baseline).toBe(4);
    expect(ctx.evaluation.promotionScore(id).inviteCount).toBe(0);
    expect(ctx.evaluation.promotionScore(id).inviteScore).toBe(0);
    // 印は履歴を残したまま無効化
    expect(result.revokedMarks).toBe(2);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id=?").get(id)).toEqual({ n: 2 });
    expect(ctx.evaluation.promotionScore(id).evalMarks).toBe(0);
    expect(ctx.evaluation.demotionCount(id)).toBe(0);
  });

  it("出戻り亡霊は新しい招待を3人集めて初めて1アリになる", () => {
    const ctx = setup();
    const id = returnee(ctx);
    ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run(id, "old1", 1);
    ctx.returns.reinstate(id, "ghost", STAFF, {});

    const add = (guest: string) => ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run(id, guest, 1);
    add("new1");
    expect(ctx.evaluation.promotionScore(id).inviteScore).toBe(0);
    add("new2");
    expect(ctx.evaluation.promotionScore(id).inviteScore).toBe(0);
    add("new3");
    expect(ctx.evaluation.promotionScore(id).inviteScore).toBe(1);
    add("new4");
    // 4人目以降も1のまま（人数比例で積み上がらない）
    expect(ctx.evaluation.promotionScore(id).inviteScore).toBe(1);
  });

  it("亡霊復帰でも初期Landは再発行しない", () => {
    const ctx = setup();
    const id = returnee(ctx);
    const land = ctx.ledger.balanceOf(`user:${id}`);
    const txs = ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions").get();

    ctx.returns.reinstate(id, "ghost", STAFF, {});

    expect(ctx.ledger.balanceOf(`user:${id}`)).toBe(land);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual(txs);
    expect(ctx.events.listByTarget(id).filter((e) => e.type === "ghosted")).toHaveLength(1); // 最初の入城の1件だけ
  });

  for (const to of ["majin", "kenma", "mazoku", "meirei"] as const) {
    it(`${to} 復帰は status を置くだけで評価サイクルを作らない`, () => {
      const ctx = setup();
      const id = returnee(ctx);
      const land = ctx.ledger.balanceOf(`user:${id}`);

      const result = ctx.returns.reinstate(id, to, STAFF, {})!;

      const soul = soulOf(ctx);
      expect(soul.status).toBe(to);
      expect(result.cycle).toBeUndefined();
      expect(soul.eval_deadline_at).toBeNull();
      expect(soul.eval_started_at).toBeNull();
      expect(soul.ghost_at).toBeNull();
      expect(ctx.ledger.balanceOf(`user:${id}`)).toBe(land);
    });
  }

  it("迷霊で戻すと ever_meirei が立つ", () => {
    const ctx = setup();
    const id = returnee(ctx);
    ctx.returns.reinstate(id, "meirei", STAFF, {});
    expect(soulOf(ctx).ever_meirei).toBe(1);
  });

  it("「今回は戻さない」は台帳を触らず判断だけ残す", () => {
    const ctx = setup();
    const id = returnee(ctx);
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(id);

    const result = ctx.returns.reinstate(id, "waiting", STAFF, { reason: "様子見" })!;

    expect(result.to).toBe("waiting");
    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(id)).toEqual(before);
    expect(ctx.events.listByTarget(id).map((e) => e.type)).toContain("entry_return_declined");
  });

  it("案内待ち以外からは反映しない（CAS）", () => {
    const ctx = setup();
    const id = returnee(ctx);
    ctx.returns.reinstate(id, "majin", STAFF, {});

    // 2回目は status が waiting でなくなっているので空振り
    expect(ctx.returns.reinstate(id, "mazoku", STAFF, {})).toBeNull();
    expect(soulOf(ctx).status).toBe("majin");
    expect(ctx.events.listByTarget(id).filter((e) => e.type === "entry_return_reinstated")).toHaveLength(1);
    expect(ctx.events.listByTarget(id).map((e) => e.type)).toContain("entry_return_skipped");
  });

  it("二重実行しても評価サイクルは1つだけ", () => {
    const ctx = setup();
    const id = returnee(ctx);

    const first = ctx.returns.reinstate(id, "ghost", STAFF, {});
    const second = ctx.returns.reinstate(id, "ghost", STAFF, {});

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(ctx.events.listByTarget(id).filter((e) => e.type === "entry_return_reinstated")).toHaveLength(1);
  });

  it("操作者・以前の状態・戻し先・理由を事件録へ残す", () => {
    const ctx = setup();
    const id = returnee(ctx);

    ctx.returns.reinstate(id, "ghost", "user:approver", { reason: "十分に反省が見られたため", rankAtLeave: "majin", everMeirei: false });

    const row = ctx.events.listByTarget(id).find((e) => e.type === "entry_return_reinstated")!;
    expect(row.actor_id).toBe("user:approver");
    const payload = JSON.parse(row.payload_json!) as Record<string, any>;
    expect(payload).toMatchObject({ to: "ghost", reason: "十分に反省が見られたため", rankAtLeave: "majin" });
    expect(payload.cycle.promotionRequired).toBe(6);
  });
});

describe("判断材料", () => {
  it("souls行が無い人も扱える（記録なしとして返す）", () => {
    const ctx = setup();
    const c = ctx.returns.context("unknown");
    expect(c).toMatchObject({ hasSoul: false, currentStatus: null, hasHistory: false, everMeirei: false, land: 0 });
  });

  it("過去の履歴を消さずに要約して見せる", () => {
    const ctx = setup();
    const id = member(ctx);
    ctx.evaluation.addMark(id, "promotion", "user:e1", "evaluation");
    ctx.evaluation.addMark(id, "demotion", "user:e2", "evaluation");
    ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run(id, "g1", 1);
    ctx.returns.recordDeparture(id);
    ctx.returns.markReturnedToWaiting(id, null);

    const c = ctx.returns.context(id);
    expect(c).toMatchObject({ hasSoul: true, currentStatus: "waiting", hasHistory: true, rankAtLeave: "majin" });
    expect(c.pastPromotionMarks).toBe(1);
    expect(c.pastDemotionMarks).toBe(1);
    expect(c.inviteCount).toBe(1);
    expect(c.land).toBeGreaterThan(0);
  });
});

describe("招待の起点は出戻りだけのルール", () => {
  it("通常入城は過去の招待も数える（起点0）", () => {
    const ctx = setup();
    for (const g of ["g1", "g2", "g3"]) {
      ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run("u1", g, 1);
    }
    ctx.entry.recordJoin("u1");
    ctx.entry.ghostify("u1", STAFF);

    expect(soulOf(ctx).eval_invite_baseline).toBe(0);
    expect(ctx.evaluation.promotionScore("u1").inviteCount).toBe(3);
    expect(ctx.evaluation.promotionScore("u1").inviteScore).toBe(1);
  });
});

describe("退出前の評価進捗を有効なまま残さない", () => {
  function returnee2(ctx: ReturnType<typeof setup>) {
    member(ctx);
    ctx.evaluation.addMark("u1", "promotion", "user:e1", "evaluation");
    ctx.evaluation.addMark("u1", "demotion", "user:e2", "evaluation");
    ctx.returns.recordDeparture("u1");
    ctx.returns.markReturnedToWaiting("u1", null);
  }

  for (const to of ["majin", "kenma", "mazoku", "meirei"] as const) {
    it(`${to} で戻しても退出前の印は無効化される（履歴は残す）`, () => {
      const ctx = setup();
      returnee2(ctx);

      const result = ctx.returns.reinstate("u1", to, STAFF, {})!;

      expect(result.revokedMarks).toBe(2);
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id='u1'").get()).toEqual({ n: 2 });
      expect(ctx.evaluation.promotionScore("u1").evalMarks).toBe(0);
      expect(ctx.evaluation.demotionCount("u1")).toBe(0);
      expect(ctx.events.listByTarget("u1").map((e) => e.type)).toContain("entry_return_marks_reset");
    });
  }

  it("復帰させずwaitingのままにした後、通常入城しても旧印は復活しない", () => {
    const ctx = setup();
    returnee2(ctx);

    ctx.returns.reinstate("u1", "waiting", STAFF, {});
    // その後あらためて通常の入城導線を通った
    ctx.entry.ghostify("u1", STAFF);

    expect(ctx.evaluation.promotionScore("u1").evalMarks).toBe(0);
    expect(ctx.evaluation.demotionCount("u1")).toBe(0);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id='u1'").get()).toEqual({ n: 2 });
  });
});

describe("再評価面談との分離", () => {
  it("迷霊→亡霊の復帰は招待実績を持ち越し、必要アリも通常のまま（出戻りとは別ルール）", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    ctx.entry.ghostify("u1", STAFF);
    for (const g of ["g1", "g2", "g3"]) {
      ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run("u1", g, 1);
    }
    ctx.evaluation.demoteToMeirei("u1", STAFF, "期限到達");

    ctx.evaluation.reinstateFromMeirei("u1", STAFF, {});

    const soul = soulOf(ctx);
    expect(soul.eval_promotion_required).toBe(5); // 上乗せなし
    expect(soul.eval_invite_baseline).toBe(0); // 招待は持ち越す
    expect(ctx.evaluation.promotionScore("u1").inviteScore).toBe(1);
  });
});

describe("台帳に記録が無い出戻り（歴史回収）", () => {
  it("出戻り対応で作った行は出戻りとして扱われ、通常の入城導線では亡霊にできない", () => {
    const ctx = setup();
    // Bot停止中の参加などで souls 行そのものが無い人
    expect(ctx.entry.getSoul("u1")).toBeUndefined();

    const created = ctx.returns.createWaitingSoulForReturn("u1", null, STAFF, { note: "歴史回収" });

    expect(created).toBe(true);
    expect(ctx.returns.isReturnee("u1")).toBe(true);
    // 退出の記録は無いが、出戻り対応で作られた行だと判別できる
    const context = ctx.returns.context("u1");
    expect(context.hasHistory).toBe(true);
    expect(context.historyFromRecovery).toBe(true);

    // 通常の /審判 から亡霊にしようとしても弾かれる（戻し先は運営が決める）
    const result = ctx.entry.ghostify("u1", STAFF);
    expect(result.blocked).toBe("returnee");
    expect(ctx.entry.getSoul("u1")!.status).toBe("waiting");
    expect(ctx.events.listByType("entry_ghostify_blocked_returnee")).toHaveLength(1);
  });

  it("既に行がある人には作らない（元の履歴を上書きしない）", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    ctx.entry.ghostify("u1", STAFF);

    const created = ctx.returns.createWaitingSoulForReturn("u1", null, STAFF, {});

    expect(created).toBe(false);
    expect(ctx.entry.getSoul("u1")!.status).toBe("ghost");
    expect(ctx.entry.getSoul("u1")!.returned_at).toBeNull();
  });
});
