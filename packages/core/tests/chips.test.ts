import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Chips, ChipError, CHIP_ESCROW } from "../src/chips/service.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chips = new Chips(db, ledger, new EventLog(db));
  const fund = (u: string, amount: number) => {
    ledger.ensureAccount(`user:${u}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount, type: "initial", actor: "t", idempotencyKey: `f:${u}:${Math.random()}`, approvedBy: amount > 1_000_000 ? "t" : undefined });
  };
  for (const u of ["a", "b"]) fund(u, 1_000_000);
  return { db, ledger, chips };
}

let k = 0;
const key = () => `c:${k++}`;

describe("チップ為替", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("初回両替: 80%相当をチップ化、10%焼却、レートは準備で決まる", () => {
    const supply0 = ctx.ledger.moneySupply();
    const q = ctx.chips.buy("a", 10_000, key());
    // 初期レート1: minted=8,000、焼却=1,000、プール=9,000
    expect(q.output).toBe(8_000);
    expect(q.burned).toBe(1_000);
    expect(ctx.chips.balanceOf("a")).toBe(8_000);
    expect(ctx.chips.pool()).toBe(9_000);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(9_000);
    expect(ctx.ledger.balanceOf("user:a")).toBe(1_000_000 - 10_000);
    // 焼却分だけ通貨供給が減る（シンク）
    expect(ctx.ledger.moneySupply()).toBe(supply0 - 1_000);
  });

  it("Land は新規発行されない（準備＝100%、非インフレ）", () => {
    const supply0 = ctx.ledger.moneySupply();
    ctx.chips.buy("a", 50_000, key());
    ctx.chips.buy("b", 30_000, key());
    // 供給は焼却ぶんだけ減る（増えることはない）
    expect(ctx.ledger.moneySupply()).toBeLessThanOrEqual(supply0);
    // 準備プール = 発行チップの裏付け（solvent）
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(ctx.chips.pool());
    expect(ctx.chips.pool()).toBeGreaterThan(0);
  });

  it("換金は現レートの80%着地・10%焼却、往復では必ず目減りする", () => {
    ctx.chips.buy("a", 10_000, key()); // 8,000チップ / プール9,000
    const before = ctx.ledger.balanceOf("user:a");
    const q = ctx.chips.sell("a", 8_000, key());
    // gross = 8000 * 9000/8000 = 9,000。payout=7,200、焼却=900
    expect(q.output).toBe(7_200);
    expect(q.burned).toBe(900);
    expect(ctx.ledger.balanceOf("user:a")).toBe(before + 7_200);
    // 10,000入れて最終的に手元は 990,000 + 7,200 = 往復で目減り
    expect(ctx.ledger.balanceOf("user:a")).toBeLessThan(1_000_000);
  });

  it("全チップ換金で準備プールは空になる（孤児Landを残さない）", () => {
    ctx.chips.buy("a", 20_000, key());
    ctx.chips.buy("b", 20_000, key());
    ctx.chips.sell("a", ctx.chips.balanceOf("a"), key());
    ctx.chips.sell("b", ctx.chips.balanceOf("b"), key());
    expect(ctx.chips.outstanding()).toBe(0);
    expect(ctx.chips.pool()).toBe(0);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("他人の両替の残留で、持っているチップが値上がりする", () => {
    ctx.chips.buy("a", 10_000, key()); // a: 8,000チップ、レート 9000/8000=1.125
    const r1 = ctx.chips.rate();
    ctx.chips.buy("b", 100_000, key()); // b が大量両替 → プールに残留が乗る
    const r2 = ctx.chips.rate();
    expect(r2).toBeGreaterThan(r1); // a の持ち分が値上がり
  });

  it("チップ移動（カジノ内の賭け）は台帳を動かさず総量保存", () => {
    ctx.chips.buy("a", 10_000, key());
    const outstanding0 = ctx.chips.outstanding();
    const pool0 = ctx.chips.pool();
    ctx.chips.transfer("a", "house", 3_000);
    expect(ctx.chips.balanceOf("a")).toBe(5_000);
    expect(ctx.chips.balanceOf("house")).toBe(3_000);
    expect(ctx.chips.outstanding()).toBe(outstanding0); // 総量不変
    expect(ctx.chips.pool()).toBe(pool0); // 準備も不変
  });

  it("保有超の換金・移動は弾く", () => {
    ctx.chips.buy("a", 10_000, key());
    expect(() => ctx.chips.sell("a", 999_999, key())).toThrow(ChipError);
    expect(() => ctx.chips.transfer("a", "b", 999_999)).toThrow(ChipError);
  });
});
