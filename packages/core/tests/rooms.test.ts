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
  for (const u of ["owner", "owner2", "payer", "joiner"]) {
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

  it("通常宿と特殊部屋を一部屋ずつ同時所有できる", () => {
    const normal = ctx.rooms.register({ kind: "normal", channelId: "normal-1", ownerId: "owner" });
    const game = ctx.rooms.register({ kind: "game", channelId: "game-1", ownerId: "owner", hours: 2 });
    expect(normal.kind).toBe("normal");
    expect(game.kind).toBe("game");
    expect(ctx.rooms.openRoomForOwner("owner", "normal")?.id).toBe(normal.id);
    expect(ctx.rooms.openRoomForOwner("owner", "special")?.id).toBe(game.id);
  });

  it("通常宿を二部屋、特殊部屋を二部屋は同時所有できず、課金もDB行も増えない", () => {
    ctx.rooms.register({ kind: "normal", channelId: "normal-1", ownerId: "owner" });
    expect(() => ctx.rooms.register({ kind: "normal", channelId: "normal-2", ownerId: "owner" })).toThrowError(/ERR_ALREADY_OWNS/);

    const before = ctx.ledger.balanceOf("user:owner");
    ctx.rooms.register({ kind: "game", channelId: "game-1", ownerId: "owner", hours: 2 });
    expect(() => ctx.rooms.register({ kind: "oborozuki", channelId: "oboro-1", ownerId: "owner" })).toThrowError(/ERR_ALREADY_OWNS/);
    expect(ctx.ledger.balanceOf("user:owner")).toBe(before - 6_000);
    expect(ctx.rooms.byChannel("oboro-1")).toBeUndefined();
  });

  it("closed部屋と他人の部屋参加は所有枠に含めない", () => {
    const normal = ctx.rooms.register({ kind: "normal", channelId: "normal-1", ownerId: "owner" });
    ctx.rooms.markDeletedAndClosed(normal.id, "test");
    expect(ctx.rooms.register({ kind: "normal", channelId: "normal-2", ownerId: "owner" }).id).not.toBe(normal.id);
    expect(ctx.rooms.register({ kind: "game", channelId: "game-joiner", ownerId: "joiner", hours: 2 }).owner_id).toBe("joiner");
    expect(ctx.rooms.register({ kind: "normal", channelId: "normal-owner2", ownerId: "owner2" }).owner_id).toBe("owner2");
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

  it("通常部屋の無料枠追加は定員だけ増やし、Land取引を作らない", () => {
    const room = ctx.rooms.register({ kind: "normal", channelId: "free-slot", ownerId: "owner" });
    const beforeBalance = ctx.ledger.balanceOf("user:payer");
    const beforeTx = (ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'room_fee'").get() as { n: number }).n;

    const updated = ctx.rooms.addSlot(room.id, "payer", { priceOverride: 0 });

    expect(updated.capacity).toBe(3);
    expect(ctx.ledger.balanceOf("user:payer")).toBe(beforeBalance);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'room_fee'").get() as { n: number }).n).toBe(beforeTx);
    expect(ctx.ledger.findByIdempotencyKey(`room:slot:${room.id}:3`)).toBeUndefined();
  });

  it("宿以外・closed部屋・最大定員超過への増枠を拒否し、課金しない", () => {
    const game = ctx.rooms.register({ kind: "game", channelId: "game-cap", ownerId: "owner", hours: 2 });
    const beforeInvalid = ctx.ledger.balanceOf("user:payer");
    expect(() => ctx.rooms.addSlot(game.id, "payer")).toThrowError(/ERR_INVALID_ROOM/);
    expect(ctx.ledger.balanceOf("user:payer")).toBe(beforeInvalid);

    const normal = ctx.rooms.register({ kind: "normal", channelId: "normal-cap", ownerId: "owner2" });
    ctx.rooms.markDeletedAndClosed(normal.id, "test");
    expect(() => ctx.rooms.addSlot(normal.id, "payer")).toThrowError(/ERR_ROOM_CLOSED/);
    expect(ctx.ledger.balanceOf("user:payer")).toBe(beforeInvalid);

    ctx.settings.set("room_normal_max_capacity", 3, "test");
    const capped = ctx.rooms.register({ kind: "normal", channelId: "normal-cap2", ownerId: "joiner" });
    ctx.rooms.addSlot(capped.id, "payer");
    const afterOne = ctx.ledger.balanceOf("user:payer");
    expect(() => ctx.rooms.addSlot(capped.id, "payer")).toThrowError(/ERR_CAPACITY_LIMIT/);
    expect(ctx.ledger.balanceOf("user:payer")).toBe(afterOne);
  });

  it("ゲーム部屋の延長で期限が伸び、警告フラグがリセットされる", () => {
    const room = ctx.rooms.register({ kind: "game", channelId: "vc4", ownerId: "owner", hours: 2 });
    ctx.rooms.markWarned(room.id);
    const extended = ctx.rooms.extendGame(room.id, 2, "owner");
    expect(extended.expires_at! - room.expires_at!).toBe(2 * 3600);
    expect(extended.warned_at).toBeNull();
    expect(ctx.ledger.balanceOf("user:owner")).toBe(100_000 - 6_000 * 2);
  });

  it("期限切れゲーム部屋の延長を拒否し、課金しない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const room = ctx.rooms.register({ kind: "game", channelId: "game-expired", ownerId: "owner", hours: 2 });
    vi.setSystemTime(new Date("2026-07-05T14:01:00Z"));
    const before = ctx.ledger.balanceOf("user:owner");
    expect(() => ctx.rooms.extendGame(room.id, 2, "owner")).toThrowError(/ERR_ROOM_EXPIRED/);
    expect(ctx.ledger.balanceOf("user:owner")).toBe(before);
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

  it("蜜月の募集: 無応募は失効して設定額を返金し、成立済みは返金されない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const room1 = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc8", ownerId: "owner" });
    const r1 = ctx.rooms.createRecruit({ roomId: room1.id, ownerId: "owner", targetGender: "male", purpose: "寝落ち" });
    const room2 = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc9", ownerId: "owner2" });
    const r2 = ctx.rooms.createRecruit({ roomId: room2.id, ownerId: "owner2", targetGender: "female", purpose: "作業" });
    ctx.rooms.matchRecruit(r2.id, "joiner"); // こちらは成立

    const ownerBalanceAfterPay = ctx.ledger.balanceOf("user:owner");
    const owner2BalanceAfterPay = ctx.ledger.balanceOf("user:owner2");

    vi.setSystemTime(new Date("2026-07-05T17:30:00Z")); // 5時間経過
    const expired = ctx.rooms.expireRecruits();
    expect(expired.length).toBe(1);
    expect(expired[0]!.recruit.id).toBe(r1.id);
    expect(expired[0]!.refunded).toBe(2_500);
    expect(ctx.ledger.balanceOf("user:owner")).toBe(ownerBalanceAfterPay + 2_500);
    expect(ctx.ledger.balanceOf("user:owner2")).toBe(owner2BalanceAfterPay);

    // 再実行しても二重返金されない（冪等）
    expect(ctx.rooms.expireRecruits()).toEqual([]);
  });

  it("未利用の有料部屋はBot整理返金が一度だけ行われ、無料宿は返金しない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const game = ctx.rooms.register({ kind: "game", channelId: "refund-game", ownerId: "owner", hours: 3 });
    const normal = ctx.rooms.register({ kind: "normal", channelId: "refund-normal", ownerId: "owner" });
    const afterPay = ctx.ledger.balanceOf("user:owner");
    expect(ctx.rooms.refundUnusedPaidRoom(game.id).refunded).toBe(8_000);
    expect(ctx.rooms.refundUnusedPaidRoom(game.id).refunded).toBe(0);
    expect(ctx.rooms.refundUnusedPaidRoom(normal.id).refunded).toBe(0);
    expect(ctx.ledger.balanceOf("user:owner")).toBe(afterPay + 8_000);
  });

  it("unused削除要求済みなら削除再試行が期限後になっても未利用返金できる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const game = ctx.rooms.register({ kind: "game", channelId: "refund-after-retry", ownerId: "owner", hours: 2 });
    const afterPay = ctx.ledger.balanceOf("user:owner");
    ctx.rooms.requestDelete(game.id, "unused");

    vi.setSystemTime(new Date("2026-07-05T15:00:00Z"));
    expect(ctx.rooms.refundUnusedPaidRoom(game.id).refunded).toBe(6_000);
    expect(ctx.rooms.refundUnusedPaidRoom(game.id).refunded).toBe(0);
    expect(ctx.ledger.balanceOf("user:owner")).toBe(afterPay + 6_000);
  });

  it("チャンネル削除失敗時はpending_deleteのまま再試行情報を残し、closedにしない", () => {
    const room = ctx.rooms.register({ kind: "normal", channelId: "delete-retry", ownerId: "owner" });
    ctx.rooms.requestDelete(room.id, "manual", "user:owner");
    const failed = ctx.rooms.markDeleteFailed(room.id, new Error("temporary"));
    expect(failed.status).toBe("open");
    expect(failed.pending_delete).toBe(1);
    expect(failed.delete_attempts).toBe(1);
    expect(failed.next_delete_retry_at).toBeGreaterThan(failed.updated_at);
    expect(ctx.rooms.listPendingDelete(failed.next_delete_retry_at!).map((r) => r.id)).toEqual([room.id]);
    expect(ctx.rooms.markDeletedAndClosed(room.id, "manual")).toBe(true);
    expect(ctx.rooms.get(room.id).status).toBe("closed");
  });

  it("募集成立は先着1名で締め切られる", () => {
    const room = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc10", ownerId: "owner" });
    const recruit = ctx.rooms.createRecruit({ roomId: room.id, ownerId: "owner", targetGender: "male", purpose: "雑談" });
    const first = ctx.rooms.matchRecruit(recruit.id, "joiner");
    expect(first.status).toBe("matched");
    const second = ctx.rooms.matchRecruit(recruit.id, "someone_else");
    expect(second.status).toBe("matched"); // 変化なし（既に成立）
    expect(second.matched_user_id).toBe("joiner");
  });

  it("蜜月募集の同時参加はclaimで一人だけに限定し、権限付与失敗時は解放できる", () => {
    const room = ctx.rooms.register({ kind: "mitsugetsu", channelId: "vc11", ownerId: "owner" });
    const recruit = ctx.rooms.createRecruit({ roomId: room.id, ownerId: "owner", targetGender: "male", purpose: "雑談" });
    expect(ctx.rooms.claimRecruitForMatch(recruit.id, "joiner").matched_user_id).toBe("joiner");
    expect(() => ctx.rooms.claimRecruitForMatch(recruit.id, "payer")).toThrowError(/ERR_RECRUIT_CLAIMED/);
    ctx.rooms.releaseRecruitClaim(recruit.id, "joiner");
    expect(ctx.rooms.claimRecruitForMatch(recruit.id, "payer").matched_user_id).toBe("payer");
  });

  it("朧月は承諾前に課金・VC登録せず、承諾時だけ一度課金して部屋を作る", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const before = ctx.ledger.balanceOf("user:owner");
    const invite = ctx.rooms.createOborozukiInvite({ requesterId: "owner", targetId: "joiner", token: "token-1" });
    expect(invite.status).toBe("pending");
    expect(ctx.ledger.balanceOf("user:owner")).toBe(before);
    expect(ctx.rooms.byChannel("oboro-vc")).toBeUndefined();

    const accepted = ctx.rooms.acceptOborozukiInvite({ token: "token-1", targetId: "joiner", channelId: "oboro-vc" });
    expect(accepted.invite.status).toBe("accepted");
    expect(accepted.room.kind).toBe("oborozuki");
    expect(ctx.ledger.balanceOf("user:owner")).toBe(before - 30_000);
    expect(() => ctx.rooms.acceptOborozukiInvite({ token: "token-1", targetId: "joiner", channelId: "oboro-vc-2" })).toThrowError(/ERR_INVITE_CLOSED/);
  });

  it("朧月は招待作成時に保存した価格で承諾時課金する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    ctx.settings.set("room_oborozuki_price", 40_000, "test");
    const before = ctx.ledger.balanceOf("user:owner");
    const invite = ctx.rooms.createOborozukiInvite({ requesterId: "owner", targetId: "joiner", token: "token-price" });
    expect(invite.price).toBe(40_000);

    ctx.settings.set("room_oborozuki_price", 10_000, "test");
    ctx.rooms.acceptOborozukiInvite({ token: "token-price", targetId: "joiner", channelId: "oboro-price-vc" });
    expect(ctx.ledger.balanceOf("user:owner")).toBe(before - 40_000);
  });

  it("朧月招待の辞退・期限切れでは課金されない", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T12:00:00Z"));
    const before = ctx.ledger.balanceOf("user:owner");
    ctx.rooms.createOborozukiInvite({ requesterId: "owner", targetId: "joiner", token: "token-decline" });
    expect(ctx.rooms.decideOborozukiInvite("token-decline", "joiner", "declined").status).toBe("declined");
    expect(ctx.ledger.balanceOf("user:owner")).toBe(before);

    ctx.rooms.createOborozukiInvite({ requesterId: "owner", targetId: "joiner", token: "token-expire", ttlSeconds: 60 });
    vi.setSystemTime(new Date("2026-07-05T12:02:00Z"));
    expect(() => ctx.rooms.acceptOborozukiInvite({ token: "token-expire", targetId: "joiner", channelId: "never" })).toThrowError(/ERR_INVITE_EXPIRED/);
    expect(ctx.ledger.balanceOf("user:owner")).toBe(before);
  });
});
