import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Races, RaceError, RACE_ESCROW } from "../src/races/service.js";

registerDefaultTxTypes();

function setup(rng: () => number = () => 0) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const races = new Races(db, ledger, new EventLog(db), rng);
  const fund = (u: string, amount: number) =>
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount, type: "initial", actor: "t", idempotencyKey: `f:${u}:${Math.random()}`, approvedBy: amount > 1_000_000 ? "t" : undefined });
  for (const u of ["a", "b", "c"]) {
    ledger.ensureAccount(`user:${u}`, "user");
    fund(u, 100_000);
  }
  return { db, ledger, races };
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
let n = 0;
const key = () => `bet:${n++}`;

describe("冥馬レース", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("馬は2〜8頭、賭けでエスクローに積まれる", () => {
    expect(() => ctx.races.create({ horses: ["一頭だけ"], startsAt: future(), createdBy: "op" })).toThrow(RaceError);
    const r = ctx.races.create({ horses: ["黒炎", "白骨", "影"], startsAt: future(), createdBy: "op" });
    ctx.races.bet({ raceId: r.id, bettorId: "a", horseIndex: 0, amount: 10_000, idempotencyKey: key() });
    expect(ctx.ledger.balanceOf(RACE_ESCROW)).toBe(10_000);
    expect(ctx.races.get(r.id)!.pool).toBe(10_000);
    expect(ctx.races.poolByHorse(r.id)).toEqual([10_000, 0, 0]);
  });

  it("存在しない馬番は弾く", () => {
    const r = ctx.races.create({ horses: ["A", "B"], startsAt: future(), createdBy: "op" });
    expect(() => ctx.races.bet({ raceId: r.id, bettorId: "a", horseIndex: 5, amount: 1_000, idempotencyKey: key() })).toThrow(RaceError);
  });

  it("清算: 控除10%を引き、的中者へ賭け額按分で配当", () => {
    const supply0 = ctx.ledger.moneySupply();
    // rng=0 → 1着は馬0。a と b が馬0（20k,10k）、c が馬1（30k）
    const r = ctx.races.create({ horses: ["勝馬", "負馬"], houseEdgeBps: 1_000, startsAt: future(), createdBy: "op" });
    ctx.races.bet({ raceId: r.id, bettorId: "a", horseIndex: 0, amount: 20_000, idempotencyKey: key() });
    ctx.races.bet({ raceId: r.id, bettorId: "b", horseIndex: 0, amount: 10_000, idempotencyKey: key() });
    ctx.races.bet({ raceId: r.id, bettorId: "c", horseIndex: 1, amount: 30_000, idempotencyKey: key() });

    const res = ctx.races.settle(r.id, "op");
    expect(res.winnerIndex).toBe(0);
    // pool=60,000 / rake=6,000 / payoutPool=54,000。a:2/3→36,000, b:1/3→18,000
    const pa = res.payouts.find((p) => p.userId === "a")!.amount;
    const pb = res.payouts.find((p) => p.userId === "b")!.amount;
    expect(pa).toBe(36_000);
    expect(pb).toBe(18_000);
    expect(ctx.ledger.balanceOf("user:a")).toBe(100_000 - 20_000 + 36_000);
    expect(ctx.ledger.balanceOf("user:c")).toBe(100_000 - 30_000); // 外れ
    expect(ctx.ledger.balanceOf(RACE_ESCROW)).toBe(0);
    expect(ctx.ledger.moneySupply()).toBe(supply0 - 6_000); // 控除だけ回収
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("的中者ゼロなら全額返金（不成立）", () => {
    // rng=0.99 → 最後の馬(index2)が1着。全員 馬0,1 に賭ける
    const ctx2 = setup(() => 0.99);
    const r = ctx2.races.create({ horses: ["A", "B", "C"], startsAt: future(), createdBy: "op" });
    ctx2.races.bet({ raceId: r.id, bettorId: "a", horseIndex: 0, amount: 10_000, idempotencyKey: "r1" });
    ctx2.races.bet({ raceId: r.id, bettorId: "b", horseIndex: 1, amount: 20_000, idempotencyKey: "r2" });
    const res = ctx2.races.settle(r.id, "op");
    expect(res.winnerIndex).toBe(2);
    expect(res.refunded).toBe(true);
    expect(ctx2.ledger.balanceOf("user:a")).toBe(100_000);
    expect(ctx2.ledger.balanceOf("user:b")).toBe(100_000);
    expect(ctx2.ledger.balanceOf(RACE_ESCROW)).toBe(0);
  });

  it("取消は全賭け金を返金", () => {
    const r = ctx.races.create({ horses: ["A", "B"], startsAt: future(), createdBy: "op" });
    ctx.races.bet({ raceId: r.id, bettorId: "a", horseIndex: 0, amount: 5_000, idempotencyKey: key() });
    ctx.races.cancel(r.id, "op");
    expect(ctx.ledger.balanceOf("user:a")).toBe(100_000);
    expect(ctx.ledger.balanceOf(RACE_ESCROW)).toBe(0);
    expect(ctx.races.get(r.id)!.status).toBe("cancelled");
  });

  it("発走後（starts_at 経過）は賭けを弾く", () => {
    const past = Math.floor(Date.now() / 1000) - 5;
    const r = ctx.races.create({ horses: ["A", "B"], startsAt: past, createdBy: "op" });
    expect(ctx.races.listExpired().map((x) => x.id)).toContain(r.id);
    expect(() => ctx.races.bet({ raceId: r.id, bettorId: "a", horseIndex: 0, amount: 1_000, idempotencyKey: key() })).toThrow(RaceError);
  });
});
