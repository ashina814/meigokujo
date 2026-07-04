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
});
