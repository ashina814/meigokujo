import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Settings } from "../src/settings/service.js";
import { EventLog } from "../src/events/service.js";
import { Rooms } from "../src/rooms/service.js";

registerDefaultTxTypes();

afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const rooms = new Rooms(db, ledger, settings, new EventLog(db));
  const fund = (userId: string, amount: number) =>
    ledger.transfer({
      from: TREASURY, to: `user:${userId}`, amount, type: "initial",
      actor: "test", idempotencyKey: `fund:${userId}:${Math.random()}`,
      approvedBy: amount > 1_000_000 ? "test" : undefined,
    });
  for (const u of ["owner", "payer", "joiner"]) {
    ledger.ensureAccount(`user:${u}`, "user");
    fund(u, 100_000);
  }
  return { db, ledger, settings, rooms };
}

describe("部屋システム", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("料金表: 通常0 / 蜜月5,000 / 朧月30,000 / ゲームは時間別", () => {
    expect(ctx.rooms.priceFor("normal")).toBe(0);
    expect(ctx.rooms.priceFor("mitsugetsu")).toBe(5_000);
    expect(ctx.rooms.priceFor("oborozuki")).toBe(30_000);
    expect(ctx.rooms.priceFor("game", 2)).toBe(6_000);
    expect(ctx.rooms.priceFor("game", 10)).toBe(27_000);
  });

  it("ゲーム部屋の登録で前払い課金され、期限が付く", () => {
    const room = ctx.rooms.register({ kind: "game", channelId: "vc1", ownerId: "owner", hours: 3 });
    expect(ctx.ledger.balanceOf("user:owner")).toBe(92_000);
    expect(room.expires_at! - room.created_at).toBe(3 * 3600);
  });

  it("残高不足なら登録ごと失敗する（金は動かない）", () => {
    expect(() =>
      ctx.rooms.register({ kind: "oborozuki", channelId: "vc2", ownerId: "poor" }),
    ).toThrowError(/ERR_INSUFFICIENT/);
    expect(ctx.rooms.byChannel("vc2")).toBeUndefined();
  });

  it("枠課金: 押した人が払い、定員が増える", () => {
    const room = ctx.rooms.register({ kind: "normal", channelId: "vc3", ownerId: "owner" });
    const updated = ctx.rooms.addSlot(room.id, "payer");
    expect(updated.capacity).toBe(3);
    expect(ctx.ledger.balanceOf("user:payer")).toBe(95_000);
  });

  it("ゲーム部屋の延長で期限が伸び、警告フラグがリセットされる", () => {
    const room = ctx.rooms.register({ kind: "game", channelId: "vc4", ownerId: "owner", hours: 2 });
    ctx.rooms.markWarned(room.id);
    const extended = ctx.rooms.extendGame(room.id, 2, "owner");
    expect(extended.expires_at! - room.expires_at!).toBe(2 * 3600);
    expect(extended.warned_at).toBeNull();
    expect(ctx.ledger.balanceOf("user:owner")).toBe(100_000 - 6_000 * 2);
  });

  it("在室→全員退出→猶予経過で削除対象になる。未使用の蜜月は対象外", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const normal = ctx.rooms.register({ kind: "normal", channelId: "vc5", ownerId: "owner" });
    const mitsu = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc6", ownerId: "owner" });

    ctx.rooms.markOccupancy(normal.id, true); // 使われた
    vi.setSystemTime(new Date("2026-07-05T13:00:00Z"));
    ctx.rooms.markOccupancy(normal.id, false); // 全員退出

    vi.setSystemTime(new Date("2026-07-05T13:03:00Z"));
    expect(ctx.rooms.dueForDeletion(5)).toEqual([]); // 猶予内

    vi.setSystemTime(new Date("2026-07-05T13:06:00Z"));
    const due = ctx.rooms.dueForDeletion(5);
    expect(due.map((r) => r.id)).toEqual([normal.id]); // 蜜月(未使用)は募集失効側の管轄

    void mitsu;
  });

  it("一度も使われない部屋は1時間で削除対象になる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const room = ctx.rooms.register({ kind: "normal", channelId: "vc7", ownerId: "owner" });
    vi.setSystemTime(new Date("2026-07-05T13:01:00Z"));
    expect(ctx.rooms.dueForDeletion(5).map((r) => r.id)).toEqual([room.id]);
  });

  it("蜜月の募集: 無応募は失効して半額返金、成立済みは返金されない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const room1 = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc8", ownerId: "owner" });
    const r1 = ctx.rooms.createRecruit({ roomId: room1.id, ownerId: "owner", targetGender: "male", purpose: "寝落ち" });
    const room2 = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc9", ownerId: "owner" });
    const r2 = ctx.rooms.createRecruit({ roomId: room2.id, ownerId: "owner", targetGender: "female", purpose: "作業" });
    ctx.rooms.matchRecruit(r2.id, "joiner"); // こちらは成立

    const balanceAfterPay = ctx.ledger.balanceOf("user:owner"); // 100,000 - 5,000×2

    vi.setSystemTime(new Date("2026-07-05T17:30:00Z")); // 5時間経過
    const expired = ctx.rooms.expireRecruits();
    expect(expired.length).toBe(1);
    expect(expired[0]!.recruit.id).toBe(r1.id);
    expect(expired[0]!.refunded).toBe(2_500);
    expect(ctx.ledger.balanceOf("user:owner")).toBe(balanceAfterPay + 2_500);

    // 再実行しても二重返金されない（冪等）
    expect(ctx.rooms.expireRecruits()).toEqual([]);
  });

  it("募集成立は先着1名で締め切られる", () => {
    const room = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc10", ownerId: "owner" });
    const recruit = ctx.rooms.createRecruit({ roomId: room.id, ownerId: "owner", targetGender: "male", purpose: "雑談" });
    const first = ctx.rooms.matchRecruit(recruit.id, "joiner");
    expect(first.status).toBe("matched");
    const second = ctx.rooms.matchRecruit(recruit.id, "someone_else");
    expect(second.status).toBe("matched"); // 変化なし（既に成立）
  });
});
