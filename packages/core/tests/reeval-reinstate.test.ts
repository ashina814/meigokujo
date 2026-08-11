import { describe, expect, it } from "vitest";
import { EventLog, Evaluation, Ledger, Settings, Tickets, openDb } from "../src/index.js";
import { Entry } from "../src/entry/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";

/**
 * 再評価面談OKの復帰（迷霊 → 亡霊）。
 *
 * **`ghostify()` の流用ではない**ことがこのテストの主眼。入城処理は初期発行・
 * 招待実績の計上・招待者の期限延長まで抱えているが、復帰は
 * 「新しい評価サイクルを始める」だけでなければならない。
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
  const tickets = new Tickets(db, events);
  return { db, ledger, settings, events, entry, evaluation, tickets };
}

/** 亡霊 → 迷霊まで落ちた人を作る */
function demoted(ctx: ReturnType<typeof setup>, userId = "u1") {
  ctx.entry.recordJoin(userId);
  ctx.entry.ghostify(userId, STAFF);
  ctx.evaluation.addMark(userId, "promotion", "user:e1", "evaluation");
  ctx.evaluation.addMark(userId, "promotion", "user:e2", "evaluation");
  ctx.evaluation.addMark(userId, "demotion", "user:e3", "evaluation");
  ctx.evaluation.demoteToMeirei(userId, STAFF, "評価期限到達");
  return userId;
}

describe("再評価面談OKの復帰", () => {
  it("迷霊から亡霊へ戻り、新しい評価サイクルが始まる", () => {
    const ctx = setup();
    const user = demoted(ctx);
    const before = ctx.entry.getSoul(user)!;

    const result = ctx.evaluation.reinstateFromMeirei(user, STAFF, { ticketThreadId: "t1", purchaseId: 7 })!;

    const soul = ctx.entry.getSoul(user)!;
    expect(soul.status).toBe("ghost");
    expect(soul.ghost_at).toBeGreaterThanOrEqual(before.ghost_at!);
    expect(soul.eval_started_at).toBe(soul.ghost_at);
    expect(soul.eval_deadline_at).toBe(soul.eval_started_at! + 14 * DAY);
    expect(soul.eval_extension_days).toBe(0);
    expect(result.deadline).toBe(soul.eval_deadline_at);
  });

  it("policy snapshot を現在値から取り直す", () => {
    const ctx = setup();
    const user = demoted(ctx);
    // 迷霊落ち後に運営が閾値を変えた
    ctx.settings.set("promotion_marks_required", 7, STAFF);
    ctx.settings.set("demotion_marks_threshold", 2, STAFF);

    ctx.evaluation.reinstateFromMeirei(user, STAFF, {});

    const soul = ctx.entry.getSoul(user)!;
    expect(soul.eval_promotion_required).toBe(7);
    expect(soul.eval_demotion_threshold).toBe(2);
    expect(ctx.evaluation.thresholdsFor(user).promotionRequired).toBe(7);
  });

  it("以前の印は履歴を残したまま revoked にする", () => {
    const ctx = setup();
    const user = demoted(ctx);
    const before = ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id = ?").get(user) as { n: number };
    expect(before.n).toBe(3);

    const result = ctx.evaluation.reinstateFromMeirei(user, STAFF, {})!;

    expect(result.revokedMarks).toBe(3);
    // 行は消えない（履歴として残す）
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id = ?").get(user)).toEqual({ n: 3 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id = ? AND revoked_at IS NULL").get(user)).toEqual({ n: 0 });
    // 有効な印としては白紙に戻る
    expect(ctx.evaluation.promotionScore(user).evalMarks).toBe(0);
    expect(ctx.evaluation.demotionCount(user)).toBe(0);
    expect(ctx.events.listByTarget(user).map((e) => e.type)).toContain("reeval_marks_reset");
  });

  it("招待実績由来の昇格スコアは引き継ぐ", () => {
    const ctx = setup();
    const user = demoted(ctx);
    // 招待実績を持たせる（invites は復帰で消さない）。閾値3人ちょうどで1アリ
    for (const guest of ["guest1", "guest2", "guest3"]) {
      ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run(user, guest, 1);
    }
    const inviteScoreBefore = ctx.evaluation.promotionScore(user).inviteScore;
    expect(inviteScoreBefore).toBe(1);

    ctx.evaluation.reinstateFromMeirei(user, STAFF, {});

    // **在籍したまま受け直す復帰なので、招待実績は持ち越す**（出戻りとは別ルール）
    const after = ctx.evaluation.promotionScore(user);
    expect(after.inviteCount).toBe(3);
    expect(after.inviteScore).toBe(1);
    expect(after.total).toBe(1); // 評価印だけが白紙
    expect(ctx.entry.getSoul(user)!.eval_invite_baseline).toBe(0);
  });

  it("初期Landを再発行しない・招待実績を再計上しない・予約行に触れない", () => {
    const ctx = setup();
    const user = demoted(ctx);
    const balanceBefore = ctx.ledger.balanceOf(`user:${user}`);
    const txBefore = ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    ctx.db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?,?,?)").run(user, "guest1", 1);
    const invitesBefore = ctx.db.prepare("SELECT COUNT(*) AS n FROM invites").get() as { n: number };
    const bookingsBefore = ctx.db.prepare("SELECT COUNT(*) AS n FROM entry_bookings").get() as { n: number };

    ctx.evaluation.reinstateFromMeirei(user, STAFF, {});

    expect(ctx.ledger.balanceOf(`user:${user}`)).toBe(balanceBefore);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual(txBefore);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM invites").get()).toEqual(invitesBefore);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM entry_bookings").get()).toEqual(bookingsBefore);
    // 入城処理の事件録は増えない
    expect(ctx.events.listByTarget(user).filter((e) => e.type === "ghosted")).toHaveLength(1); // 最初の亡霊化の1件だけ
  });

  it("招待者の評価期限を延長しない", () => {
    const ctx = setup();
    ctx.entry.recordJoin("inviter");
    ctx.entry.ghostify("inviter", STAFF);
    const inviterDeadline = ctx.entry.getSoul("inviter")!.eval_deadline_at;
    const user = demoted(ctx, "invitee");
    ctx.db.prepare("UPDATE souls SET inviter_user_id = 'inviter' WHERE user_id = ?").run(user);

    ctx.evaluation.reinstateFromMeirei(user, STAFF, {});

    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(inviterDeadline);
  });

  it("迷霊でなければ何も書かない（面談中に階級が動いた場合）", () => {
    const ctx = setup();
    ctx.entry.recordJoin("u1");
    ctx.entry.ghostify("u1", STAFF); // ghost のまま
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id='u1'").get();

    expect(ctx.evaluation.reinstateFromMeirei("u1", STAFF, {})).toBeNull();

    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id='u1'").get()).toEqual(before);
    expect(ctx.events.listByTarget("u1").map((e) => e.type)).toContain("reeval_reinstate_skipped");
    expect(ctx.events.listByTarget("u1").map((e) => e.type)).not.toContain("reeval_reinstated");
  });

  it("二度押しでも二度復帰しない", () => {
    const ctx = setup();
    const user = demoted(ctx);

    expect(ctx.evaluation.reinstateFromMeirei(user, STAFF, {})).not.toBeNull();
    expect(ctx.evaluation.reinstateFromMeirei(user, STAFF, {})).toBeNull();

    expect(ctx.events.listByTarget(user).filter((e) => e.type === "reeval_reinstated")).toHaveLength(1);
  });

  it("承認者・対象・日時・面談権を事件録へ残す", () => {
    const ctx = setup();
    const user = demoted(ctx);

    ctx.evaluation.reinstateFromMeirei(user, "user:approver", { ticketThreadId: "t-1", purchaseId: 63, approver: "approver" });

    const row = ctx.events.listByTarget(user).find((e) => e.type === "reeval_reinstated")!;
    expect(row.actor_id).toBe("user:approver");
    const payload = JSON.parse(row.payload_json!) as Record<string, any>;
    expect(payload).toMatchObject({ from: "meirei", to: "ghost", ticketThreadId: "t-1", purchaseId: 63 });
    expect(payload.policy.promotionRequired).toBeGreaterThan(0);
    expect(payload.evalDeadlineAt).toBeGreaterThan(payload.evalStartedAt);
  });
});

describe("再評価面談NG", () => {
  it("status・ロール・印を変えず、判断だけ残す", () => {
    const ctx = setup();
    const user = demoted(ctx);
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(user);
    const marksBefore = ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id = ? AND revoked_at IS NULL").get(user);

    ctx.evaluation.recordReevalRejection(user, "user:approver", { ticketThreadId: "t-2", purchaseId: 63, reason: "様子見" });

    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(user)).toEqual(before);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id = ? AND revoked_at IS NULL").get(user)).toEqual(marksBefore);
    const row = ctx.events.listByTarget(user).find((e) => e.type === "reeval_rejected")!;
    expect(JSON.parse(row.payload_json!)).toMatchObject({ ticketThreadId: "t-2", purchaseId: 63 });
  });
});

describe("面談権の紐付け（同じ購入を二重に使わせない）", () => {
  it("同じ購入を2つのチケットへ結べない", () => {
    const ctx = setup();
    ctx.tickets.create("t-a", "u1", "reeval", { id: "reeval", name: "再評価面談", notifyRoleIds: [], staffRoleIds: [] });
    ctx.tickets.create("t-b", "u2", "reeval", { id: "reeval", name: "再評価面談", notifyRoleIds: [], staffRoleIds: [] });

    expect(ctx.tickets.linkPurchase("t-a", 99, STAFF)).toBe(true);
    // 2件目は一意インデックスで弾かれ、例外ではなく false になる
    expect(ctx.tickets.linkPurchase("t-b", 99, STAFF)).toBe(false);
    expect(ctx.tickets.ticketByPurchase(99)?.thread_id).toBe("t-a");
  });

  it("既に面談権を持つチケットへ別の購入を上書きできない", () => {
    const ctx = setup();
    ctx.tickets.create("t-a", "u1", "reeval", { id: "reeval", name: "再評価面談", notifyRoleIds: [], staffRoleIds: [] });

    expect(ctx.tickets.linkPurchase("t-a", 1, STAFF)).toBe(true);
    expect(ctx.tickets.linkPurchase("t-a", 2, STAFF)).toBe(false);
    expect(ctx.tickets.get("t-a")!.linked_purchase_id).toBe(1);
  });
});
