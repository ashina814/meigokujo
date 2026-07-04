import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Auctions, AuctionError, AUCTION_ESCROW } from "../src/auctions/service.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const auctions = new Auctions(db, ledger, new EventLog(db));
  const fund = (u: string, amount: number) =>
    ledger.transfer({
      from: TREASURY,
      to: `user:${u}`,
      amount,
      type: "initial",
      actor: "test",
      idempotencyKey: `fund:${u}:${Math.random()}`,
      approvedBy: amount > 1_000_000 ? "test" : undefined,
    });
  for (const u of ["a", "b", "c"]) {
    ledger.ensureAccount(`user:${u}`, "user");
    fund(u, 100_000);
  }
  return { db, ledger, auctions };
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
let n = 0;
const key = () => `bid:${n++}`;

describe("冥界競売", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("入札でエスクローに預けられ、開始価格未満は弾く", () => {
    const a = ctx.auctions.create({ title: "命名権", startPrice: 10_000, minIncrement: 1_000, endsAt: future(), createdBy: "op" });
    expect(() => ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 9_999, idempotencyKey: key() })).toThrow(AuctionError);

    ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 10_000, idempotencyKey: key() });
    expect(ctx.ledger.balanceOf(`user:a`)).toBe(90_000);
    expect(ctx.ledger.balanceOf(AUCTION_ESCROW)).toBe(10_000);
    expect(ctx.auctions.get(a.id)!.current_bidder).toBe("a");
  });

  it("上書き入札で前点者へ自動返金、エスクローは最高額だけ", () => {
    const a = ctx.auctions.create({ title: "色ロール", startPrice: 10_000, minIncrement: 1_000, endsAt: future(), createdBy: "op" });
    ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 10_000, idempotencyKey: key() });

    // 増分未満は弾く（次は 11,000 以上）
    expect(() => ctx.auctions.bid({ auctionId: a.id, bidderId: "b", amount: 10_500, idempotencyKey: key() })).toThrow(AuctionError);

    const r = ctx.auctions.bid({ auctionId: a.id, bidderId: "b", amount: 12_000, idempotencyKey: key() });
    expect(r.refundedBidder).toBe("a");
    expect(r.refundedAmount).toBe(10_000);
    expect(ctx.ledger.balanceOf(`user:a`)).toBe(100_000); // 返金済み
    expect(ctx.ledger.balanceOf(`user:b`)).toBe(88_000);
    expect(ctx.ledger.balanceOf(AUCTION_ESCROW)).toBe(12_000);
  });

  it("自分が最高額のときは弾く", () => {
    const a = ctx.auctions.create({ title: "x", startPrice: 1_000, endsAt: future(), createdBy: "op" });
    ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 1_000, idempotencyKey: key() });
    expect(() => ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 2_000, idempotencyKey: key() })).toThrow(AuctionError);
  });

  it("締切で最高額が国庫へ回収され、通貨供給が減る", () => {
    const supplyBefore = ctx.ledger.moneySupply();
    const a = ctx.auctions.create({ title: "晩餐", startPrice: 5_000, endsAt: future(), createdBy: "op" });
    ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 5_000, idempotencyKey: key() });
    ctx.auctions.bid({ auctionId: a.id, bidderId: "b", amount: 20_000, idempotencyKey: key() });

    const res = ctx.auctions.close(a.id, "op");
    expect(res.winnerId).toBe("b");
    expect(res.amount).toBe(20_000);
    expect(ctx.ledger.balanceOf(AUCTION_ESCROW)).toBe(0);
    expect(ctx.ledger.balanceOf(`user:b`)).toBe(80_000); // 落札分は戻らない
    expect(ctx.ledger.moneySupply()).toBe(supplyBefore - 20_000); // 回収
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("入札ゼロで締切なら回収なし", () => {
    const a = ctx.auctions.create({ title: "誰も要らない", startPrice: 5_000, endsAt: future(), createdBy: "op" });
    const res = ctx.auctions.close(a.id, "op");
    expect(res.winnerId).toBeNull();
    expect(res.amount).toBe(0);
    expect(ctx.auctions.get(a.id)!.status).toBe("closed");
  });

  it("取消は最高額者へ返金して cancelled（回収しない）", () => {
    const a = ctx.auctions.create({ title: "取消対象", startPrice: 5_000, endsAt: future(), createdBy: "op" });
    ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 8_000, idempotencyKey: key() });
    ctx.auctions.cancel(a.id, "op");
    expect(ctx.ledger.balanceOf(`user:a`)).toBe(100_000);
    expect(ctx.ledger.balanceOf(AUCTION_ESCROW)).toBe(0);
    expect(ctx.auctions.get(a.id)!.status).toBe("cancelled");
    // 締切済みは再操作不可
    expect(() => ctx.auctions.close(a.id, "op")).toThrow(AuctionError);
  });

  it("締切後の入札は弾く（listExpired で締めた後）", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const a = ctx.auctions.create({ title: "期限切れ", startPrice: 1_000, endsAt: past, createdBy: "op" });
    expect(ctx.auctions.listExpired().map((x) => x.id)).toContain(a.id);
    expect(() => ctx.auctions.bid({ auctionId: a.id, bidderId: "a", amount: 1_000, idempotencyKey: key() })).toThrow(AuctionError);
  });
});
