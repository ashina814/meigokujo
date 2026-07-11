import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange, EtherError, ETHER_ESCROW } from "../src/casino/exchange.js";
import { deptAccount, Departments } from "../src/departments/service.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const ether = new EtherExchange(db, ledger, new EventLog(db)); // baseRate 既定 10
  const departments = new Departments(db, ledger);
  const fund = (u: string, amount: number) => {
    ledger.ensureAccount(`user:${u}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount, type: "initial", actor: "t", idempotencyKey: `f:${u}:${Math.random()}`, approvedBy: amount > 1_000_000 ? "t" : undefined });
  };
  for (const u of ["a", "b"]) fund(u, 1_000_000);
  return { db, ledger, ether, departments };
}

let k = 0;
const key = () => `e:${k++}`;

describe("エテル為替", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("入場はフェア: 初期レート10で満額エテル化・焼却なし", () => {
    const supply0 = ctx.ledger.moneySupply();
    const q = ctx.ether.buy("a", 10_000, key());
    expect(q.output).toBe(100_000); // 10,000 Land × 10
    expect(q.burned).toBe(0);
    expect(ctx.ether.balanceOf("a")).toBe(100_000);
    expect(ctx.ether.pool()).toBe(10_000); // Land は満額プールへ
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(10_000);
    expect(ctx.ledger.balanceOf("user:a")).toBe(1_000_000 - 10_000);
    expect(ctx.ledger.moneySupply()).toBe(supply0); // 入場では供給不変
  });

  it("2人目もフェアレートで入場（レートは動かない）", () => {
    ctx.ether.buy("a", 10_000, key());
    const r1 = ctx.ether.rate();
    ctx.ether.buy("b", 50_000, key());
    expect(ctx.ether.rate()).toBeCloseTo(r1, 9);
    expect(ctx.ether.balanceOf("b")).toBe(500_000);
  });

  it("退場は現レートの80%着地・10%焼却＝Landシンク", () => {
    ctx.ether.buy("a", 10_000, key()); // 100,000 エテル / プール 10,000
    const supply0 = ctx.ledger.moneySupply();
    const before = ctx.ledger.balanceOf("user:a");
    const q = ctx.ether.sell("a", 100_000, key());
    // gross = 100,000 × 10,000/100,000 = 10,000 Land。payout 8,000 / 焼却 1,000 / 残留 1,000
    expect(q.output).toBe(8_000);
    expect(q.burned).toBe(1_000);
    expect(ctx.ledger.balanceOf("user:a")).toBe(before + 8_000);
    // 全エテル退場 → 残留分もsweepで国庫回収 → 焼却相当は供給から消える
    expect(ctx.ether.outstanding()).toBe(0);
    expect(ctx.ether.pool()).toBe(0);
    expect(ctx.ledger.moneySupply()).toBe(supply0 - 2_000); // 焼却1,000 + sweep1,000
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("往復すると必ず目減りする（出にくい賭場）", () => {
    ctx.ether.buy("a", 10_000, key());
    ctx.ether.sell("a", ctx.ether.balanceOf("a"), key());
    expect(ctx.ledger.balanceOf("user:a")).toBeLessThan(1_000_000);
  });

  it("Land は新規発行されない（準備＝100%、非インフレ）", () => {
    const supply0 = ctx.ledger.moneySupply();
    ctx.ether.buy("a", 50_000, key());
    ctx.ether.buy("b", 30_000, key());
    expect(ctx.ledger.moneySupply()).toBeLessThanOrEqual(supply0);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(ctx.ether.pool());
    expect(ctx.ether.pool()).toBe(80_000);
  });

  it("他人の退場の残留で、持っているエテルが値上がりする", () => {
    ctx.ether.buy("a", 10_000, key());
    ctx.ether.buy("b", 10_000, key());
    const landValueBefore = ctx.ether.quoteSell(ctx.ether.balanceOf("a")).output;
    ctx.ether.sell("b", ctx.ether.balanceOf("b"), key()); // b 退場 → 10%残留
    const landValueAfter = ctx.ether.quoteSell(ctx.ether.balanceOf("a")).output;
    expect(landValueAfter).toBeGreaterThan(landValueBefore);
  });

  it("エテル移動（カジノ内の賭け）は台帳を動かさず総量保存", () => {
    ctx.ether.buy("a", 10_000, key());
    const outstanding0 = ctx.ether.outstanding();
    const pool0 = ctx.ether.pool();
    ctx.ether.transfer("a", "house", 30_000);
    expect(ctx.ether.balanceOf("a")).toBe(70_000);
    expect(ctx.ether.balanceOf("house")).toBe(30_000);
    expect(ctx.ether.outstanding()).toBe(outstanding0);
    expect(ctx.ether.pool()).toBe(pool0);
  });

  it("保有超の換金・移動は弾く", () => {
    ctx.ether.buy("a", 10_000, key());
    expect(() => ctx.ether.sell("a", 999_999_999, key())).toThrow(EtherError);
    expect(() => ctx.ether.transfer("a", "b", 999_999_999)).toThrow(EtherError);
  });

  it("胴元の元手と売上精算はフェアレートで損得ゼロ往復", () => {
    // 部署口座に元手を用意
    ctx.departments.upsert("賭博場", "賭博場", null);
    ctx.ledger.transfer({ from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: key() });
    const dept = deptAccount("賭博場");

    const f = ctx.ether.fundFromAccount(dept, 100_000, "house", key());
    expect(f.ether).toBe(1_000_000); // フェア（初期レート10）
    expect(ctx.ledger.balanceOf(dept)).toBe(0);

    // そのまま全部戻すと満額戻る（奉納なし）
    const r = ctx.ether.redeemFairToAccount("house", 1_000_000, dept, key());
    expect(r.land).toBe(100_000);
    expect(ctx.ledger.balanceOf(dept)).toBe(100_000);
    expect(ctx.ether.pool()).toBe(0);
    expect(ctx.ether.outstanding()).toBe(0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("胴元収益のスプレッド付き精算（redeemToAccount）は8割着地・1割焼却", () => {
    ctx.ether.buy("a", 10_000, key()); // プレイヤーが入場
    ctx.ether.transfer("a", "house", 50_000); // 胴元が勝った体
    ctx.departments.upsert("賭博場", "賭博場", null);
    const dept = deptAccount("賭博場");
    const q = ctx.ether.redeemToAccount("house", 50_000, dept, "system:test", key());
    // gross = 50,000 × 10,000/100,000 = 5,000 Land → 4,000着地 / 500焼却 / 500残留
    expect(q.output).toBe(4_000);
    expect(q.burned).toBe(500);
    expect(ctx.ledger.balanceOf(dept)).toBe(4_000);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("冪等キー重複は ERR_DUPLICATE で弾かれ二重両替できない", () => {
    const fixed = "e:idem:1";
    ctx.ether.buy("a", 10_000, fixed);
    expect(() => ctx.ether.buy("a", 10_000, fixed)).toThrow(EtherError);
    expect(ctx.ether.balanceOf("a")).toBe(100_000); // 1回分のみ
    // 売り側も同様
    ctx.ether.sell("a", 10_000, "e:idem:2");
    expect(() => ctx.ether.sell("a", 10_000, "e:idem:2")).toThrow(EtherError);
  });
});
