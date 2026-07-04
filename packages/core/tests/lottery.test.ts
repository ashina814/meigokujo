import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Settings } from "../src/settings/service.js";
import { EventLog } from "../src/events/service.js";
import { Lottery, LotteryError, LOTTERY_ESCROW } from "../src/lottery/service.js";

registerDefaultTxTypes();

function setup(rng: () => number = () => 0) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const lottery = new Lottery(db, ledger, settings, new EventLog(db), rng);
  const fund = (u: string, amount: number) =>
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount, type: "initial", actor: "test", idempotencyKey: `f:${u}:${Math.random()}`, approvedBy: amount > 1_000_000 ? "test" : undefined });
  for (const u of ["a", "b", "c"]) {
    ledger.ensureAccount(`user:${u}`, "user");
    fund(u, 100_000);
  }
  return { db, ledger, settings, lottery };
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
let n = 0;
const key = () => `buy:${n++}`;

describe("輪廻籤", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("開催は同時に1回だけ", () => {
    ctx.lottery.open({ ticketPrice: 1_000, drawsAt: future(), createdBy: "op" });
    expect(() => ctx.lottery.open({ ticketPrice: 1_000, drawsAt: future(), createdBy: "op" })).toThrow(LotteryError);
  });

  it("購入でエスクローに積まれ、pot と枚数が増える", () => {
    const l = ctx.lottery.open({ ticketPrice: 1_000, drawsAt: future(), createdBy: "op" });
    ctx.lottery.buy({ lotteryId: l.id, userId: "a", qty: 3, idempotencyKey: key() });
    ctx.lottery.buy({ lotteryId: l.id, userId: "a", qty: 2, idempotencyKey: key() });
    expect(ctx.lottery.ticketsOf(l.id, "a")).toBe(5);
    expect(ctx.ledger.balanceOf("user:a")).toBe(100_000 - 5_000);
    expect(ctx.ledger.balanceOf(LOTTERY_ESCROW)).toBe(5_000);
    expect(ctx.lottery.get(l.id)!.pot).toBe(5_000);
  });

  it("抽選: 控除20%が国庫へ、残りが当選者へ。検算も保つ", () => {
    const supply0 = ctx.ledger.moneySupply();
    // rng=0 → 常に先頭(a)が当選
    const l = ctx.lottery.open({ ticketPrice: 10_000, houseEdgeBps: 2_000, drawsAt: future(), createdBy: "op" });
    ctx.lottery.buy({ lotteryId: l.id, userId: "a", qty: 1, idempotencyKey: key() });
    ctx.lottery.buy({ lotteryId: l.id, userId: "b", qty: 1, idempotencyKey: key() });
    // pot=20,000 / rake=4,000 / prize=16,000 → a が当選
    const res = ctx.lottery.draw(l.id, "op");
    expect(res.winnerId).toBe("a");
    expect(res.rake).toBe(4_000);
    expect(res.prize).toBe(16_000);
    expect(ctx.ledger.balanceOf("user:a")).toBe(100_000 - 10_000 + 16_000);
    expect(ctx.ledger.balanceOf(LOTTERY_ESCROW)).toBe(0);
    expect(ctx.ledger.moneySupply()).toBe(supply0 - 4_000); // 控除だけ回収
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("参加者ゼロで抽選 → 当選者なし、繰越はエスクローに残る", () => {
    ctx.lottery.seed(50_000, "op"); // 繰越を積む
    expect(ctx.lottery.carryover()).toBe(50_000);
    const l = ctx.lottery.open({ ticketPrice: 1_000, drawsAt: future(), createdBy: "op" });
    const res = ctx.lottery.draw(l.id, "op");
    expect(res.winnerId).toBeNull();
    expect(ctx.lottery.carryover()).toBe(50_000); // 据え置き
    expect(ctx.ledger.balanceOf(LOTTERY_ESCROW)).toBe(50_000);
  });

  it("繰越が次回の当選額に乗る", () => {
    ctx.lottery.seed(30_000, "op");
    const l = ctx.lottery.open({ ticketPrice: 10_000, houseEdgeBps: 0, drawsAt: future(), createdBy: "op" });
    ctx.lottery.buy({ lotteryId: l.id, userId: "a", qty: 1, idempotencyKey: key() });
    const res = ctx.lottery.draw(l.id, "op");
    // pot=10,000 / rake=0 / prize=10,000+繰越30,000=40,000
    expect(res.prize).toBe(40_000);
    expect(ctx.lottery.carryover()).toBe(0); // 払い出し後リセット
    expect(ctx.ledger.balanceOf(LOTTERY_ESCROW)).toBe(0);
  });

  it("重み付き抽選: 枚数の多い方が選ばれる（rng制御）", () => {
    // a=1枚, b=9枚, rng=0.5 → index=5 → b
    const ctx2 = setup(() => 0.5);
    const l = ctx2.lottery.open({ ticketPrice: 1_000, houseEdgeBps: 0, drawsAt: future(), createdBy: "op" });
    ctx2.lottery.buy({ lotteryId: l.id, userId: "a", qty: 1, idempotencyKey: "x1" });
    ctx2.lottery.buy({ lotteryId: l.id, userId: "b", qty: 9, idempotencyKey: "x2" });
    expect(ctx2.lottery.draw(l.id, "op").winnerId).toBe("b");
  });

  it("取消は全参加者へ返金", () => {
    const l = ctx.lottery.open({ ticketPrice: 5_000, drawsAt: future(), createdBy: "op" });
    ctx.lottery.buy({ lotteryId: l.id, userId: "a", qty: 2, idempotencyKey: key() });
    ctx.lottery.buy({ lotteryId: l.id, userId: "b", qty: 1, idempotencyKey: key() });
    ctx.lottery.cancel(l.id, "op");
    expect(ctx.ledger.balanceOf("user:a")).toBe(100_000);
    expect(ctx.ledger.balanceOf("user:b")).toBe(100_000);
    expect(ctx.ledger.balanceOf(LOTTERY_ESCROW)).toBe(0);
    expect(ctx.lottery.get(l.id)!.status).toBe("cancelled");
  });
});
