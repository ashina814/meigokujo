import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Fiscal, FiscalError } from "../src/fiscal/service.js";

registerDefaultTxTypes();

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const fiscal = new Fiscal(db, ledger);
  const fund = (u: string, amount: number) => {
    ledger.ensureAccount(`user:${u}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount, type: "initial", actor: "t", idempotencyKey: `f:${u}:${Math.random()}`, approvedBy: amount > 1_000_000 ? "t" : undefined });
  };
  const ghost = (u: string, daysAgo: number, status = "ghost") => {
    const ts = now() - daysAgo * DAY;
    db.prepare("INSERT INTO souls (user_id, status, ghost_at, updated_at) VALUES (?, ?, ?, ?)").run(u, status, ts, now());
  };
  return { db, ledger, fiscal, fund, ghost };
}

describe("財政（冥府税・年金）", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("冥府税: 閾値超の超過分に課税、承認→実行で国庫回収", () => {
    ctx.fund("rich", 3_000_000);
    ctx.fund("poor", 500_000);
    const supply0 = ctx.ledger.moneySupply();

    const run = ctx.fiscal.generateTaxDraft("2026-07", { threshold: 1_000_000, rateBps: 500 }, "op"); // 5%
    const plan = ctx.fiscal.planOf(run);
    // rich のみ対象: (3,000,000-1,000,000)*5% = 100,000。poor は対象外
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.userId).toBe("rich");
    expect(plan.items[0]!.amount).toBe(100_000);

    ctx.fiscal.approve(run.id, "op");
    const report = ctx.fiscal.execute(run.id, "op");
    expect(report.succeeded).toBe(1);
    expect(ctx.ledger.balanceOf("user:rich")).toBe(2_900_000);
    expect(ctx.ledger.moneySupply()).toBe(supply0 - 100_000); // 回収
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("冥府税は冪等: 再実行しても二重課税されない", () => {
    ctx.fund("rich", 3_000_000);
    const run = ctx.fiscal.generateTaxDraft("2026-07", { threshold: 1_000_000, rateBps: 500 }, "op");
    ctx.fiscal.approve(run.id, "op");
    ctx.fiscal.execute(run.id, "op");
    const again = ctx.fiscal.execute(run.id, "op");
    expect(again.skippedAsDone).toBe(1);
    expect(ctx.ledger.balanceOf("user:rich")).toBe(2_900_000);
  });

  it("課税対象がいなければ ERR_EMPTY_PLAN", () => {
    ctx.fund("poor", 100_000);
    expect(() => ctx.fiscal.generateTaxDraft("2026-07", { threshold: 1_000_000, rateBps: 500 }, "op")).toThrow(FiscalError);
  });

  it("年金: 在城1年超の魂へ定額を給付", () => {
    ctx.ghost("veteran", 400); // 400日 → 対象
    ctx.ghost("newbie", 100); // 100日 → 対象外
    ctx.ghost("departed_vet", 400, "departed"); // 去りし魂 → 対象外
    const supply0 = ctx.ledger.moneySupply();

    const run = ctx.fiscal.generatePensionDraft("2026-07", { minDays: 365, amount: 50_000 }, "op");
    const plan = ctx.fiscal.planOf(run);
    expect(plan.items.map((i) => i.userId)).toEqual(["veteran"]);

    ctx.fiscal.approve(run.id, "op");
    const report = ctx.fiscal.execute(run.id, "op");
    expect(report.succeeded).toBe(1);
    expect(ctx.ledger.balanceOf("user:veteran")).toBe(50_000);
    expect(ctx.ledger.moneySupply()).toBe(supply0 + 50_000); // 発行
  });

  it("同じ kind/period の draft は作り直し、承認後は拒否", () => {
    ctx.fund("rich", 3_000_000);
    const run = ctx.fiscal.generateTaxDraft("2026-07", { threshold: 1_000_000, rateBps: 500 }, "op");
    const run2 = ctx.fiscal.generateTaxDraft("2026-07", { threshold: 1_000_000, rateBps: 1_000 }, "op");
    expect(run2.id).toBe(run.id); // 上書き
    ctx.fiscal.approve(run2.id, "op");
    expect(() => ctx.fiscal.generateTaxDraft("2026-07", { threshold: 1_000_000, rateBps: 500 }, "op")).toThrow(FiscalError);
  });
});
