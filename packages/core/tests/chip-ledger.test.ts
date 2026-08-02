import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, CHIP_ESCROW, ETHER_ESCROW } from "../src/casino/chip-ledger.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  for (const userId of ["a", "b"]) {
    ledger.ensureAccount(`user:${userId}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 1_000_000, type: "initial", actor: "test", idempotencyKey: `fund:${userId}` });
  }
  return { db, ledger, chips };
}

describe("ChipLedger", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  it("預入・返還は常に1:1で、準備口座は発行済みチップを100%裏付ける", () => { const deposit = ctx.chips.deposit("a", 12_345, "deposit:a"); expect(deposit).toEqual({ input: 12_345, output: 12_345, burned: 0 }); expect(ctx.chips.balanceOf("a")).toBe(12_345); expect(ctx.chips.pool()).toBe(12_345); expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(12_345); const redeem = ctx.chips.redeem("a", 2_345, "redeem:a"); expect(redeem).toEqual({ input: 2_345, output: 2_345, burned: 0 }); expect(ctx.chips.balanceOf("a")).toBe(10_000); expect(ctx.chips.pool()).toBe(10_000); expect(ctx.ledger.balanceOf("user:a")).toBe(990_000); expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(0); });
  it("同じ預入・返還キーは一度だけ資金を動かす", () => { const first = ctx.chips.deposit("a", 10_000, "deposit:once"); expect(ctx.chips.deposit("a", 10_000, "deposit:once")).toEqual(first); expect(ctx.chips.balanceOf("a")).toBe(10_000); const returned = ctx.chips.redeem("a", 4_000, "redeem:once"); expect(ctx.chips.redeem("a", 4_000, "redeem:once")).toEqual(returned); expect(ctx.chips.balanceOf("a")).toBe(6_000); expect(ctx.chips.pool()).toBe(6_000); });
  it("Land取引が重複した場合はチップ発行までロールバックする", () => { ctx.ledger.transfer({ from: "user:a", to: TREASURY, amount: 1, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "collision" }); expect(() => ctx.chips.deposit("a", 10_000, "collision")).toThrow(/ERR_DUPLICATE/); expect(ctx.chips.balanceOf("a")).toBe(0); expect(ctx.chips.pool()).toBe(0); });
});
