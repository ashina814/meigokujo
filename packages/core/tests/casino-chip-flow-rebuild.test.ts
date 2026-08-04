import { describe, expect, it } from "vitest";
import {
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  Escrow,
  FreeSpins,
  ChipLedger,
  ChipLedgerError,
  ChipTx,
  EventLog,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

function setup(formal = true) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  if (formal) openFormally(chipTx, ledger);
  const assets = new CasinoChipAssets(db, chips);
  const flow = new CasinoChipFlow(db, chips, events, assets);
  const escrow = new Escrow(db, chips, events);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, assets);
  return { db, ledger, chipTx, chips, assets, flow, escrow, integrity };
}

function seed(ctx: ReturnType<typeof setup>, userId: string, land: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  if (land > 0) {
    ctx.ledger.transfer({
      from: TREASURY, to: `user:${userId}`, amount: land, type: "initial", actor: "test",
      idempotencyKey: `seed:${userId}:${land}`,
    });
  }
}

describe("PR10 rebuild automatic deposit", () => {
  it("enough free chips deposits zero; one-Ld shortage deposits exactly one", () => {
    const ctx = setup();
    seed(ctx, "alice", 101);
    ctx.chips.deposit("alice", 100, "seed-chip");
    expect(ctx.flow.ensureFreeChips("alice", 100, "enough")).toEqual({
      required: 100, freeBefore: 100, deposited: 0, freeAfter: 100,
    });
    expect(ctx.flow.ensureFreeChips("alice", 101, "one-short").deposited).toBe(1);
    expect(ctx.assets.freeChips("alice")).toBe(101);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(0);
  });

  it("Land shortage changes neither Land nor chips", () => {
    const ctx = setup();
    seed(ctx, "alice", 5);
    expect(() => ctx.flow.ensureFreeChips("alice", 6, "short")).toThrow();
    expect(ctx.ledger.balanceOf("user:alice")).toBe(5);
    expect(ctx.assets.freeChips("alice")).toBe(0);
  });

  it("same operation is idempotent and different users never mix", () => {
    const ctx = setup();
    seed(ctx, "alice", 20);
    seed(ctx, "bob", 20);
    const first = ctx.flow.ensureFreeChips("alice", 10, "same");
    const second = ctx.flow.ensureFreeChips("alice", 10, "same");
    expect(first).toEqual(second);
    expect(ctx.assets.freeChips("alice")).toBe(10);
    expect(ctx.assets.freeChips("bob")).toBe(0);
  });

  it("automatic deposit and free-chip redemption keep A/B group and Land audit consistent", () => {
    const ctx = setup();
    seed(ctx, "alice", 100);
    ctx.flow.ensureFreeChips("alice", 60, "audit-deposit");
    expect(ctx.integrity.runFull().checks.find((check) => check.id === "B")?.ok).toBe(true);
    ctx.flow.redeemFreeChips("alice", "audit-redeem", "test");
    const report = ctx.integrity.runFull();
    expect(report.checks.find((check) => check.id === "A")?.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "B")?.ok).toBe(true);
  });

  it("pending free-spin ownership blocks free-chip redemption", () => {
    const ctx = setup();
    seed(ctx, "alice", 100);
    ctx.flow.ensureFreeChips("alice", 60, "pending-seed");
    const freeSpins = new FreeSpins(ctx.db);
    freeSpins.grant({
      userId: "alice",
      operationId: "pending-op",
      spinNo: 1,
      bet: 10,
      sourceGroup: "source",
      reels: ["a", "b", "c"],
      rawPayout: 0,
      amuletEffect: { kind: "none", amount: 0 },
      payout: 0,
      jackpotWon: false,
      jackpotClaim: 0,
      totalClaim: 0,
    });
    expect(ctx.flow.redeemFreeChips("alice", "blocked", "test")).toMatchObject({ redeemed: 0, skipped: "active_ownership" });
    expect(() => ctx.flow.redeemExactFreeChips("alice", 60, "blocked-exact", "test")).toThrow(/active ownership/);
    expect(ctx.assets.freeChips("alice")).toBe(60);
  });

  it("formal opening lock remains enforced", () => {
    const ctx = setup(false);
    seed(ctx, "alice", 10);
    expect(() => ctx.flow.ensureFreeChips("alice", 1, "locked")).toThrowError(ChipLedgerError);
  });

  it("missing Land user account with orphan free chips fails closed and does not affect Alice", () => {
    const ctx = setup();
    seed(ctx, "alice", 10);
    ctx.db.prepare("INSERT INTO ether_balances(user_id,amount,updated_at) VALUES('ghost',5,0)").run();
    expect(() => ctx.flow.redeemFreeChips("ghost", "ghost", "test")).toThrowError(ChipLedgerError);
    expect(ctx.flow.ensureFreeChips("alice", 1, "alice").freeAfter).toBe(1);
  });
});
