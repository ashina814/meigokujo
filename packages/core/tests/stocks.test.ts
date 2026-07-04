import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Stocks, StockError, MARKET_ESCROW } from "../src/stocks/service.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const stocks = new Stocks(db, ledger, new EventLog(db));
  const fund = (u: string, amount: number) => {
    ledger.ensureAccount(`user:${u}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount, type: "initial", actor: "t", idempotencyKey: `f:${u}:${Math.random()}`, approvedBy: amount > 1_000_000 ? "t" : undefined });
  };
  const setSoul = (u: string, status: string) =>
    db.prepare("INSERT INTO souls (user_id, status, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET status = excluded.status").run(u, status, Math.floor(Date.now() / 1000));
  for (const u of ["inv1", "inv2"]) fund(u, 1_000_000);
  return { db, ledger, stocks, fund, setSoul };
}

let k = 0;
const key = () => `st:${k++}`;

describe("魂株市場", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("買いは曲線に沿って課金、エスクロー= priceSum(0,shares) を保つ", () => {
    ctx.stocks.list("soul", { basePrice: 1_000, step: 100, createdBy: "op" });
    // 3株: (1000)+(1100)+(1200)=3,300
    const r = ctx.stocks.buy("soul", "inv1", 3, key());
    expect(r.cash).toBe(3_300);
    expect(ctx.ledger.balanceOf(MARKET_ESCROW)).toBe(3_300);
    expect(ctx.ledger.balanceOf("user:inv1")).toBe(1_000_000 - 3_300);
    expect(ctx.stocks.get("soul")!.shares).toBe(3);
    expect(r.newPrice).toBe(1_300); // 次の1株
  });

  it("売りは対称に払い戻し、エスクローは常に残高分をカバー（solvent）", () => {
    ctx.stocks.list("soul", { basePrice: 1_000, step: 100, createdBy: "op" });
    ctx.stocks.buy("soul", "inv1", 5, key()); // 1000+1100+1200+1300+1400 = 6,000
    expect(ctx.ledger.balanceOf(MARKET_ESCROW)).toBe(6_000);
    // 2株売り: shares 5→3、価格 index4,3 = 1400+1300 = 2,700
    const r = ctx.stocks.sell("soul", "inv1", 2, key());
    expect(r.cash).toBe(2_700);
    expect(ctx.ledger.balanceOf(MARKET_ESCROW)).toBe(3_300);
    expect(ctx.stocks.sharesOf("soul", "inv1")).toBe(3);
    // 残り3株売り切ってエスクロー0
    ctx.stocks.sell("soul", "inv1", 3, key());
    expect(ctx.ledger.balanceOf(MARKET_ESCROW)).toBe(0);
    expect(ctx.ledger.balanceOf("user:inv1")).toBe(1_000_000);
  });

  it("持ち株超の売りは弾く", () => {
    ctx.stocks.list("soul", { basePrice: 1_000, step: 100, createdBy: "op" });
    ctx.stocks.buy("soul", "inv1", 1, key());
    expect(() => ctx.stocks.sell("soul", "inv1", 2, key())).toThrow(StockError);
  });

  it("昇格: base が上がり、国庫が bonus*shares を配当としてエスクローへ注入（solvent維持）", () => {
    const supply0 = ctx.ledger.moneySupply();
    ctx.stocks.list("soul", { basePrice: 1_000, step: 100, promotionBonus: 5_000, createdBy: "op" });
    ctx.stocks.buy("soul", "inv1", 2, key()); // escrow=2,100（1000+1100）
    ctx.setSoul("soul", "majin");
    const changes = ctx.stocks.syncStatuses();
    expect(changes).toEqual([{ subjectId: "soul", kind: "promoted" }]);
    // base 1000→6000。配当 = 5000*2 = 10,000 が国庫からエスクローへ
    const s = ctx.stocks.get("soul")!;
    expect(s.base_price).toBe(6_000);
    expect(ctx.ledger.balanceOf(MARKET_ESCROW)).toBe(2_100 + 10_000);
    expect(ctx.ledger.moneySupply()).toBe(supply0 + 10_000); // 配当は発行
    // inv1 が2株売ると含み益込みで受取り: index1,0 = (6000+100)+(6000) = 12,100
    const r = ctx.stocks.sell("soul", "inv1", 2, key());
    expect(r.cash).toBe(12_100);
    expect(ctx.ledger.balanceOf(MARKET_ESCROW)).toBe(0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("迷霊落ち: 廃止でエスクローを国庫回収、株主は紙くず（value=0）", () => {
    const supply0 = ctx.ledger.moneySupply();
    ctx.stocks.list("soul", { basePrice: 1_000, step: 100, createdBy: "op" });
    ctx.stocks.buy("soul", "inv1", 3, key()); // escrow 3,300
    ctx.setSoul("soul", "meirei");
    const changes = ctx.stocks.syncStatuses();
    expect(changes[0]!.kind).toBe("delisted");
    expect(changes[0]!.reclaimed).toBe(3_300);
    expect(ctx.ledger.balanceOf(MARKET_ESCROW)).toBe(0);
    expect(ctx.ledger.moneySupply()).toBe(supply0 - 3_300); // 没収＝回収
    // 保有は無価値
    const pf = ctx.stocks.portfolio("inv1");
    expect(pf[0]!.value).toBe(0);
    expect(() => ctx.stocks.sell("soul", "inv1", 1, key())).toThrow(StockError);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("上場中の二重上場は拒否、廃止後は再上場で作り直し", () => {
    ctx.stocks.list("soul", { basePrice: 1_000, step: 100, createdBy: "op" });
    expect(() => ctx.stocks.list("soul", { createdBy: "op" })).toThrow(StockError);
    ctx.stocks.buy("soul", "inv1", 1, key());
    ctx.stocks.delist("soul", "op");
    const relisted = ctx.stocks.list("soul", { basePrice: 2_000, step: 50, createdBy: "op" });
    expect(relisted.status).toBe("listed");
    expect(relisted.shares).toBe(0); // 保有はクリア
    expect(ctx.stocks.sharesOf("soul", "inv1")).toBe(0);
  });
});
