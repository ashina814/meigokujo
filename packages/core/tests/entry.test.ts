import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Settings } from "../src/settings/service.js";
import { EventLog } from "../src/events/service.js";
import { Entry } from "../src/entry/service.js";

registerDefaultTxTypes();

const STAFF = "user:staff";
const DAY = 86_400;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  return { db, ledger, settings, events, entry };
}

describe("入城導線", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("亡霊化で初期発行30,000と評価期限（14日）が付き、事件録に残る", () => {
    ctx.entry.recordJoin("alice");
    ctx.entry.book("alice", "2026-07-05 21", { source: "disboard" });
    ctx.entry.markAttended("alice");
    const result = ctx.entry.ghostify("alice", STAFF);

    expect(result.granted).toBe(30_000);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(30_000);
    const soul = ctx.entry.getSoul("alice")!;
    expect(soul.status).toBe("ghost");
    expect(soul.eval_deadline_at! - soul.ghost_at!).toBe(14 * DAY);
    expect(ctx.events.listByTarget("alice").map((e) => e.type)).toContain("ghosted");
  });

  it("亡霊化は冪等: 2回目は発行0で期限も変わらない", () => {
    ctx.entry.book("bob", "flex", { source: "none" });
    const first = ctx.entry.ghostify("bob", STAFF);
    const second = ctx.entry.ghostify("bob", STAFF);
    expect(second.granted).toBe(0);
    expect(second.evalDeadlineAt).toBe(first.evalDeadlineAt);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(30_000);
  });

  it("招待者の評価期限が延長される（男+1日/女+2日、上限15日）", () => {
    // 招待者を先に亡霊化（評価期間中にする）
    ctx.entry.book("inviter", "flex", { source: "none" });
    ctx.entry.ghostify("inviter", STAFF);
    const before = ctx.entry.getSoul("inviter")!.eval_deadline_at!;

    ctx.entry.book("guest_m", "flex", { userId: "inviter", source: "user" });
    const r1 = ctx.entry.ghostify("guest_m", STAFF, { inviteeGender: "male" });
    expect(r1.inviterExtendedDays).toBe(1);

    ctx.entry.book("guest_f", "flex", { userId: "inviter", source: "user" });
    const r2 = ctx.entry.ghostify("guest_f", STAFF, { inviteeGender: "female" });
    expect(r2.inviterExtendedDays).toBe(2);

    const soul = ctx.entry.getSoul("inviter")!;
    expect(soul.eval_deadline_at).toBe(before + 3 * DAY);
    expect(soul.eval_extension_days).toBe(3);
  });

  it("延長は累計15日で頭打ち", () => {
    ctx.entry.book("inviter", "flex", { source: "none" });
    ctx.entry.ghostify("inviter", STAFF);
    // 女性(+2日)を8人招待 → 16日ではなく15日で止まる
    for (let i = 0; i < 8; i++) {
      const guest = `g${i}`;
      ctx.entry.book(guest, "flex", { userId: "inviter", source: "user" });
      ctx.entry.ghostify(guest, STAFF, { inviteeGender: "female" });
    }
    expect(ctx.entry.getSoul("inviter")!.eval_extension_days).toBe(15);
  });

  it("評価期間が終わっている招待者には延長が付かない", () => {
    // 亡霊化していない（waiting のまま）の招待者
    ctx.entry.recordJoin("old_member");
    ctx.entry.book("guest", "flex", { userId: "old_member", source: "user" });
    const r = ctx.entry.ghostify("guest", STAFF, { inviteeGender: "female" });
    expect(r.inviterExtendedDays).toBe(0);
  });

  it("判定: 出席と欠席が分かれ、欠席3回でキューから外れる", () => {
    ctx.entry.book("a", "2026-07-05 21", { source: "none" });
    ctx.entry.book("b", "2026-07-05 21", { source: "none" });
    ctx.entry.markAttended("a");

    const judge = ctx.entry.judgeSlot("2026-07-05 21");
    expect(judge.attended.map((r) => r.user_id)).toEqual(["a"]);
    expect(judge.absent.map((r) => r.user_id)).toEqual(["b"]);

    expect(ctx.entry.recordNoShow("b")).toEqual({ count: 1, dropped: false });
    expect(ctx.entry.recordNoShow("b")).toEqual({ count: 2, dropped: false });
    expect(ctx.entry.recordNoShow("b")).toEqual({ count: 3, dropped: true });
    expect(ctx.entry.getBooking("b")!.status).toBe("dropped");
  });

  it("再予約しても no_show_count は引き継がれる", () => {
    ctx.entry.book("c", "2026-07-05 21", { source: "none" });
    ctx.entry.recordNoShow("c");
    ctx.entry.book("c", "2026-07-06 22", { source: "none" });
    expect(ctx.entry.getBooking("c")!.no_show_count).toBe(1);
  });

  it("階級バックフィル: ロール由来の階級を写し、亡霊に14日期限・魔人は期限なし", () => {
    const r = ctx.entry.backfillStatuses(
      [
        { userId: "maj", status: "majin" },
        { userId: "gho", status: "ghost" },
        { userId: "mei", status: "meirei" },
      ],
      14,
    );
    expect(r.applied).toEqual({ majin: 1, ghost: 1, meirei: 1 });
    expect(r.ghostDeadlinesSet).toBe(1);
    const gho = ctx.entry.getSoul("gho")!;
    expect(gho.status).toBe("ghost");
    expect(gho.eval_deadline_at! - gho.ghost_at!).toBe(14 * DAY);
    expect(ctx.entry.getSoul("maj")!.eval_deadline_at).toBeNull();
  });

  it("階級バックフィルは冪等: 再実行しても既存の亡霊期限をリセットしない", () => {
    ctx.entry.backfillStatuses([{ userId: "g", status: "ghost" }], 14);
    const first = ctx.entry.getSoul("g")!.eval_deadline_at!;
    const again = ctx.entry.backfillStatuses([{ userId: "g", status: "ghost" }], 30);
    expect(again.ghostDeadlinesSet).toBe(0); // 既存期限を維持
    expect(ctx.entry.getSoul("g")!.eval_deadline_at).toBe(first);
  });

  it("見送り(skipBooking): 出席者を dropped にし、亡霊化しない", () => {
    ctx.entry.book("skip1", "2026-07-05 21", { source: "none" });
    ctx.entry.markAttended("skip1");
    expect(ctx.entry.skipBooking("skip1", STAFF)).toBe(true);
    expect(ctx.entry.getBooking("skip1")!.status).toBe("dropped");
    // dropped は判定対象に出ない
    expect(ctx.entry.judgeSlot("2026-07-05 21").attended).toHaveLength(0);
    expect(ctx.events.listByTarget("skip1").map((e) => e.type)).toContain("entry_skipped");
    // 既に dropped 済みは false
    expect(ctx.entry.skipBooking("skip1", STAFF)).toBe(false);
  });

  it("門番の後追い登録: 亡霊化の後でも招待実績が付き、期限が延びる", () => {
    // 招待者は評価期間中の亡霊
    ctx.entry.ghostify("inviter", STAFF);
    // 被招待者は招待経路なしで判定を通る（招待経路は判定の条件ではない）
    ctx.entry.recordJoin("newbie");
    ctx.entry.ghostify("newbie", STAFF);
    expect(ctx.entry.getSoul("newbie")!.inviter_user_id).toBeNull();

    const before = ctx.entry.getSoul("inviter")!.eval_deadline_at!;
    const r = ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, "female");

    expect(r.credited).toBe(true);
    expect(r.extendedDays).toBe(2);
    expect(ctx.entry.getSoul("newbie")!.inviter_user_id).toBe("inviter");
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at!).toBe(before + 2 * DAY);
  });

  it("招待実績は1人につき一度きり: 判定時に付いた相手を門番が再登録しても二重に延びない", () => {
    ctx.entry.ghostify("inviter", STAFF);
    ctx.entry.recordJoin("newbie");
    ctx.entry.book("newbie", "open", { userId: "inviter", source: "user" });
    ctx.entry.ghostify("newbie", STAFF, { inviteeGender: "male" });
    const after = ctx.entry.getSoul("inviter")!.eval_deadline_at!;

    const again = ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, "female");
    expect(again.credited).toBe(false);
    expect(again.reason).toBe("already");
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at!).toBe(after);
  });

  it("自分自身は招待者にできない", () => {
    ctx.entry.recordJoin("solo");
    const r = ctx.entry.recordInviterByStaff("solo", { userId: "solo", source: "user" }, STAFF, "male");
    expect(r.credited).toBe(false);
    expect(r.reason).toBe("self");
  });
});

describe("招待経路の状態（検出・補足 → 確定 → 報酬）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  /** invites 行（＝確定した招待実績）の件数 */
  const invitesCount = (db: ReturnType<typeof setup>["db"], inviteeId: string) =>
    (db.prepare("SELECT COUNT(*) AS c FROM invites WHERE invitee_id = ?").get(inviteeId) as { c: number }).c;

  it("案内待ちへの補足では招待実績が発生しない（期限延長も称号判定も動かない）", () => {
    ctx.entry.ghostify("inviter", STAFF); // 招待者は評価期間中の亡霊
    const before = ctx.entry.getSoul("inviter")!.eval_deadline_at!;
    ctx.entry.recordJoin("newbie"); // まだ waiting

    const r = ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, "female");

    expect(r.saved).toBe(true);
    expect(r.pending).toBe(true); // 確定は入城の時
    expect(r.credited).toBe(false);
    expect(r.extendedDays).toBe(0);
    expect(invitesCount(ctx.db, "newbie")).toBe(0);
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(before); // 延長されていない
    expect(ctx.entry.getSoul("newbie")!.inviter_user_id).toBeNull(); // 確定欄は空のまま
    // 検出・補足としては残っている
    expect(ctx.entry.getInviterHint("newbie")).toMatchObject({ inviterUserId: "inviter", origin: "staff" });
  });

  it("補足した相手が亡霊化した時に、一度だけ確定して期限が延びる", () => {
    ctx.entry.ghostify("inviter", STAFF);
    const before = ctx.entry.getSoul("inviter")!.eval_deadline_at!;
    ctx.entry.recordJoin("newbie");
    ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, "female");

    const result = ctx.entry.ghostify("newbie", STAFF, { inviteeGender: "female" });

    expect(result.inviterExtendedDays).toBe(2);
    expect(invitesCount(ctx.db, "newbie")).toBe(1);
    expect(ctx.entry.getSoul("newbie")!.inviter_user_id).toBe("inviter");
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(before + 2 * DAY);

    // 2回目の亡霊化（冪等）でも確定は増えない
    ctx.entry.ghostify("newbie", STAFF, { inviteeGender: "female" });
    expect(invitesCount(ctx.db, "newbie")).toBe(1);
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(before + 2 * DAY);
  });

  it("自動検出も同じ: 検出だけでは確定せず、亡霊化で確定する", () => {
    ctx.entry.ghostify("inviter", STAFF);
    ctx.entry.recordJoin("newbie");
    ctx.entry.recordInviterHint("newbie", { userId: "inviter", source: "user" }, "auto", "system:invite-tracker");

    expect(invitesCount(ctx.db, "newbie")).toBe(0);
    expect(ctx.entry.getInviterHint("newbie")).toMatchObject({ origin: "auto" });

    ctx.entry.ghostify("newbie", STAFF, { inviteeGender: "male" });
    expect(invitesCount(ctx.db, "newbie")).toBe(1);
  });

  it("亡霊化後の後追い登録では、その場で確定するが予約行は作らない", () => {
    ctx.entry.ghostify("inviter", STAFF);
    ctx.entry.recordJoin("newbie");
    ctx.entry.ghostify("newbie", STAFF); // 招待経路なしで入城

    const r = ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, "male");

    expect(r.credited).toBe(true);
    expect(r.pending).toBe(false);
    expect(r.extendedDays).toBe(1);
    expect(ctx.entry.getBooking("newbie")).toBeUndefined(); // booked/open 行を新造しない
  });

  it("案内待ちへの補足でも予約行を作らない", () => {
    ctx.entry.recordJoin("newbie");
    ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, null);
    expect(ctx.entry.getBooking("newbie")).toBeUndefined();
  });

  it("重複登録で join イベントも期限延長も増えない", () => {
    ctx.entry.ghostify("inviter", STAFF);
    ctx.entry.recordJoin("newbie");
    ctx.entry.ghostify("newbie", STAFF);

    const joinsAfterFirst = ctx.events.listByTarget("newbie").filter((e) => e.type === "join").length;
    expect(joinsAfterFirst).toBe(1);

    ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, "female");
    const deadline = ctx.entry.getSoul("inviter")!.eval_deadline_at!;

    // 同じ登録を3回繰り返す
    for (let i = 0; i < 3; i++) {
      ctx.entry.recordInviterByStaff("newbie", { userId: "inviter", source: "user" }, STAFF, "female");
    }
    expect(ctx.events.listByTarget("newbie").filter((e) => e.type === "join").length).toBe(1);
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(deadline);
    expect(invitesCount(ctx.db, "newbie")).toBe(1);
  });

  it("既存メンバーへの招待登録では join イベントを増やさない", () => {
    ctx.entry.recordJoin("member");
    expect(ctx.entry.recordJoin("member")).toBe(false); // 2回目のINSERTは成立しない
    ctx.entry.recordInviterByStaff("member", { source: "disboard" }, STAFF, null);
    expect(ctx.events.listByTarget("member").filter((e) => e.type === "join").length).toBe(1);
  });

  it("確定済みの招待者を別人で上書きしない（予約行も魂台帳も変えない）", () => {
    ctx.entry.ghostify("inviter", STAFF);
    ctx.entry.ghostify("other", STAFF);
    ctx.entry.recordJoin("newbie");
    ctx.entry.recordInviterHint("newbie", { userId: "inviter", source: "user" }, "auto", "system:invite-tracker");
    ctx.entry.ghostify("newbie", STAFF, { inviteeGender: "female" });
    const otherDeadline = ctx.entry.getSoul("other")!.eval_deadline_at!;

    const r = ctx.entry.recordInviterByStaff("newbie", { userId: "other", source: "user" }, STAFF, "female");

    expect(r.saved).toBe(false);
    expect(r.reason).toBe("already");
    expect(r.existingInviterId).toBe("inviter"); // 既存の確定内容を返す
    expect(ctx.entry.getSoul("newbie")!.inviter_user_id).toBe("inviter"); // 魂台帳は元のまま
    expect(ctx.entry.getInviterHint("newbie")!.inviterUserId).toBe("inviter"); // hint も元のまま
    expect(ctx.entry.getSoul("other")!.eval_deadline_at).toBe(otherDeadline); // 別人に延長が付かない
    expect(invitesCount(ctx.db, "newbie")).toBe(1);
  });

  it("none（誰の招待でもない）は確認済みとして扱い、未検出にならない", () => {
    ctx.entry.recordJoin("newbie");
    expect(ctx.entry.getInviterHint("newbie")).toBeNull(); // 登録前は未検出

    ctx.entry.recordInviterByStaff("newbie", { source: "none" }, STAFF, null);

    const hint = ctx.entry.getInviterHint("newbie");
    expect(hint).not.toBeNull(); // 未検出から外れる
    expect(hint!.source).toBe("none");
    expect(hint!.inviterUserId).toBeNull();
    // 招待者がいないので実績は発生しない
    expect(invitesCount(ctx.db, "newbie")).toBe(0);
  });

  it("旧データ: 予約行にだけ招待者がある人も検出済みとして読める", () => {
    ctx.entry.recordJoin("legacy");
    ctx.entry.book("legacy", "open", { userId: "inviter", source: "user" }); // PR #34 以前の形
    const hint = ctx.entry.getInviterHint("legacy");
    expect(hint).toMatchObject({ inviterUserId: "inviter", legacy: true });

    // 亡霊化すれば旧データからでも確定する
    ctx.entry.ghostify("legacy", STAFF, { inviteeGender: "male" });
    expect(invitesCount(ctx.db, "legacy")).toBe(1);
  });

  it("旧データ: 招待者も経路も無い予約行は未検出のまま", () => {
    ctx.entry.recordJoin("legacy2");
    ctx.entry.book("legacy2", "open", { source: "none" });
    expect(ctx.entry.getInviterHint("legacy2")).toBeNull();
  });

  it("確定処理は途中で失敗しても部分反映しない（invites行だけ残らない）", () => {
    // 期限延長やイベント記録の段階で落ちた時に invites 行だけが残ると、
    // 次回は already になって延長が永久に取りこぼされる。それを防げているかを見る。
    const failingEvents = new EventLog(ctx.db);
    const original = failingEvents.log.bind(failingEvents);
    failingEvents.log = ((type: string, opts?: Parameters<EventLog["log"]>[1]) => {
      if (type === "invite_credited") throw new Error("記録に失敗");
      return original(type, opts);
    }) as EventLog["log"];
    const entry = new Entry(ctx.db, ctx.ledger, ctx.settings, failingEvents);

    entry.ghostify("inviter", STAFF);
    const before = entry.getSoul("inviter")!.eval_deadline_at!;
    entry.recordJoin("newbie");
    entry.ghostify("newbie", STAFF);

    expect(() => entry.creditInvite("newbie", "inviter", "user", "female")).toThrow("記録に失敗");

    // ロールバックされている
    expect(invitesCount(ctx.db, "newbie")).toBe(0);
    expect(entry.getSoul("newbie")!.inviter_user_id).toBeNull();
    expect(entry.getSoul("inviter")!.eval_deadline_at).toBe(before);

    // やり直せば正しく確定する（already で詰まらない）
    const retry = ctx.entry.creditInvite("newbie", "inviter", "user", "female");
    expect(retry.credited).toBe(true);
    expect(retry.extendedDays).toBe(2);
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(before + 2 * DAY);
  });

  it("移行組（階級はあるが ghost_at が NULL）への後追い登録はその場で確定する", () => {
    // 2026-07-06 の移行でバックフィルされた迷霊・魔人は ghost_at が NULL のまま。
    // ghost_at だけで見ると「入城前」と誤判定され、確定の機会を永久に失う。
    ctx.entry.ghostify("inviter", STAFF);
    const before = ctx.entry.getSoul("inviter")!.eval_deadline_at!;
    ctx.entry.backfillStatuses([{ userId: "migrated", status: "meirei" }], 14);
    expect(ctx.entry.getSoul("migrated")!.ghost_at).toBeNull();

    const r = ctx.entry.recordInviterByStaff("migrated", { userId: "inviter", source: "user" }, STAFF, "female");

    expect(r.pending).toBe(false);
    expect(r.credited).toBe(true);
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(before + 2 * DAY);
  });

  it("departed は階級だけでは入城済みと扱わない（入城前の離脱と区別が付かないため）", () => {
    ctx.entry.ghostify("inviter", STAFF);
    ctx.entry.recordJoin("gone");
    ctx.db.prepare("UPDATE souls SET status = 'departed' WHERE user_id = ?").run("gone");

    const r = ctx.entry.recordInviterByStaff("gone", { userId: "inviter", source: "user" }, STAFF, "female");

    expect(r.saved).toBe(true);
    expect(r.pending).toBe(true); // 確定しない
    expect(invitesCount(ctx.db, "gone")).toBe(0);
  });

  it("同じ相手への確定は2回目が already で、延長は増えない", () => {
    ctx.entry.ghostify("inviter", STAFF);
    ctx.entry.recordJoin("newbie");
    ctx.entry.ghostify("newbie", STAFF);

    const first = ctx.entry.creditInvite("newbie", "inviter", "user", "female");
    const deadline = ctx.entry.getSoul("inviter")!.eval_deadline_at!;
    const second = ctx.entry.creditInvite("newbie", "other", "user", "female");

    expect(first.credited).toBe(true);
    expect(second.credited).toBe(false);
    expect(second.reason).toBe("already");
    expect(second.extendedDays).toBe(0);
    expect(ctx.entry.getSoul("inviter")!.eval_deadline_at).toBe(deadline);
    expect(ctx.entry.getSoul("newbie")!.inviter_user_id).toBe("inviter"); // 2回目の招待者に変わらない
  });

  it("待ち人サマリの「直近の参加」は参加日だけで数え、既存メンバーの更新を含めない", () => {
    const now = Math.floor(Date.now() / 1000);
    ctx.entry.recordJoin("today");
    ctx.entry.recordJoin("longAgo");
    // 3か月前に参加した人が、いま情報を更新された（updated_at だけが新しい）状態を作る
    ctx.db.prepare("UPDATE souls SET joined_at = ?, updated_at = ? WHERE user_id = 'longAgo'").run(now - 90 * DAY, now);

    const summary = ctx.entry.waitingSummary({ now });

    expect(summary.waiting).toBe(2);
    expect(summary.recentJoins).toBe(1); // longAgo は数えない
    expect(summary.stale).toBe(1); // 7日以上待っているのは longAgo だけ
  });

  it("待ち人サマリの未検出は、旧データの検出結果も検出済みとして扱う", () => {
    ctx.entry.recordJoin("detected");
    ctx.entry.recordJoin("legacy");
    ctx.entry.recordJoin("missing");
    ctx.entry.recordInviterHint("detected", { userId: "inviter", source: "user" }, "auto", "system:test");
    ctx.entry.book("legacy", "2026-07-05 21", { userId: "inviter", source: "user" }); // 旧導線の予約行

    expect(ctx.entry.waitingSummary().missingInviterHint).toBe(1);
  });
});
