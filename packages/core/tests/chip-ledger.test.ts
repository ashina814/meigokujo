import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, ChipLedgerError, CHIP_ESCROW, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/chip-ledger.js";
import { ChipTx } from "../src/casino/chip-tx.js";

registerDefaultTxTypes();

function setup(options: { sharedChipTx?: boolean; requireOpeningV1?: boolean } = {}) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chipTx = options.sharedChipTx ? new ChipTx(db) : undefined;
  const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx, requireOpeningV1: options.requireOpeningV1 });
  for (const userId of ["a", "b"]) {
    ledger.ensureAccount(`user:${userId}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 1_000_000, type: "initial", actor: "test", idempotencyKey: `fund:${userId}` });
  }
  return { db, ledger, chips, chipTx: chips.chipTx };
}

const count = (ctx: ReturnType<typeof setup>, table: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("ChipLedger", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it("預入・返還は常に1:1で、準備口座は発行済みチップを100%裏付ける", () => {
    expect(ctx.chips.deposit("a", 12_345, "deposit:a")).toEqual({ input: 12_345, output: 12_345, burned: 0 });
    expect(ctx.chips.balanceOf("a")).toBe(12_345);
    expect(ctx.chips.pool()).toBe(12_345);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(12_345);
    expect(ctx.chips.redeem("a", 2_345, "redeem:a")).toEqual({ input: 2_345, output: 2_345, burned: 0 });
    expect(ctx.chips.balanceOf("a")).toBe(10_000);
    expect(ctx.chips.pool()).toBe(10_000);
    expect(ctx.ledger.balanceOf("user:a")).toBe(990_000);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(0);
  });

  it("同じ預入・返還キーは一度だけ資金を動かす", () => {
    const first = ctx.chips.deposit("a", 10_000, "deposit:once");
    expect(ctx.chips.deposit("a", 10_000, "deposit:once")).toEqual(first);
    const returned = ctx.chips.redeem("a", 4_000, "redeem:once");
    expect(ctx.chips.redeem("a", 4_000, "redeem:once")).toEqual(returned);
    expect(ctx.chips.balanceOf("a")).toBe(6_000);
    expect(ctx.chips.pool()).toBe(6_000);
  });

  it("Land取引が重複した場合はチップ発行までロールバックする", () => {
    ctx.ledger.transfer({ from: "user:a", to: TREASURY, amount: 1, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "collision" });
    expect(() => ctx.chips.deposit("a", 10_000, "collision")).toThrow(/ERR_DUPLICATE/);
    expect(ctx.chips.balanceOf("a")).toBe(0);
    expect(ctx.chips.pool()).toBe(0);
  });

  it("production構築ではopening_v1前の全資金操作を拒否し、旧残高と台帳を変えない", () => {
    const locked = setup({ sharedChipTx: true });
    const department = "sys:dept:賭博場";
    locked.ledger.ensureAccount(department, "system");
    locked.ledger.transfer({ from: TREASURY, to: ETHER_ESCROW, amount: 10_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "legacy:reserve" });
    locked.ledger.transfer({ from: TREASURY, to: department, amount: 1_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "legacy:department" });
    locked.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('legacy-user', 100000, 0)").run();
    locked.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 1000, 0)").run(HOUSE_HOLDER);
    const before = {
      userLand: locked.ledger.balanceOf("user:a"), oldReserve: locked.ledger.balanceOf(ETHER_ESCROW), newReserve: locked.ledger.balanceOf(CHIP_ESCROW),
      department: locked.ledger.balanceOf(department), legacyChips: locked.chips.balanceOf("legacy-user"), houseChips: locked.chips.balanceOf(HOUSE_HOLDER),
      landTx: count(locked, "transactions"), groups: count(locked, "casino_tx_groups"), chipTx: count(locked, "casino_tx"),
    };
    const operations: Array<() => unknown> = [
      () => locked.chips.deposit("a", 100, "locked:deposit"),
      () => locked.chips.redeem("legacy-user", 100, "locked:redeem"),
      () => locked.chips.fundFromAccount(department, 100, HOUSE_HOLDER, "locked:fund"),
      () => locked.chips.redeemToAccount("legacy-user", 100, department, "test", "locked:settle"),
      () => locked.chips.redeemFairToAccount(HOUSE_HOLDER, 100, department, "locked:fair-settle"),
      () => locked.chips.runGroup({ groupKey: "locked:game", kind: "solo_game", actorId: "a" }, () => locked.chips.transfer("legacy-user", HOUSE_HOLDER, 100, { reason: "賭け金" })),
    ];
    for (const operation of operations) {
      let error: unknown;
      try { operation(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(ChipLedgerError);
      expect((error as { code: string }).code).toBe("ERR_CASINO_OPENING_NOT_COMPLETE");
    }
    expect({
      userLand: locked.ledger.balanceOf("user:a"), oldReserve: locked.ledger.balanceOf(ETHER_ESCROW), newReserve: locked.ledger.balanceOf(CHIP_ESCROW),
      department: locked.ledger.balanceOf(department), legacyChips: locked.chips.balanceOf("legacy-user"), houseChips: locked.chips.balanceOf(HOUSE_HOLDER),
      landTx: count(locked, "transactions"), groups: count(locked, "casino_tx_groups"), chipTx: count(locked, "casino_tx"),
    }).toEqual(before);
    locked.db.close();
  });

  it("opening_v1確定後だけproduction構築の1:1操作を解放する", () => {
    const opened = setup({ sharedChipTx: true });
    expect(() => opened.chips.deposit("a", 100, "before:opening")).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
    opened.chipTx.captureOpening("opening_v1", [], { poolLand: opened.ledger.balanceOf(CHIP_ESCROW), fromLedgerTxId: opened.ledger.lastTransactionId() });
    expect(opened.chips.deposit("a", 1_000, "after:deposit")).toEqual({ input: 1_000, output: 1_000, burned: 0 });
    expect(opened.chips.redeem("a", 400, "after:redeem")).toEqual({ input: 400, output: 400, burned: 0 });
    expect(opened.chips.balanceOf("a")).toBe(600);
    expect(opened.ledger.balanceOf(CHIP_ESCROW)).toBe(600);
    opened.db.close();
  });
});
