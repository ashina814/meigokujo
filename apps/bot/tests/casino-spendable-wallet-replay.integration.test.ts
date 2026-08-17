import { describe, expect, it } from "vitest";
import {
  CasinoChipAssets,
  CasinoChipFlow,
  CHIP_ESCROW,
  ChipLedger,
  Escrow,
  EventLog,
  FORMAL_OPENING_VERSION,
  HouseReservations,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { createFundedEscrow } from "../src/casino/spendable-wallet.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new ChipLedger(db, ledger, events);
  chips.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
    poolLand: ledger.balanceOf(CHIP_ESCROW),
    fromLedgerTxId: ledger.lastTransactionId(),
  });
  new HouseReservations(db, chips, events);
  const assets = new CasinoChipAssets(db, chips);
  const flow = new CasinoChipFlow(db, chips, events, assets);
  for (const id of ["alice", "bob"]) {
    ledger.ensureAccount(`user:${id}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${id}`,
      amount: 1_000,
      type: "initial",
      actor: "test",
      idempotencyKey: `wallet-replay-seed:${id}`,
    });
  }
  const rawEscrow = new Escrow(db, chips, events);
  const escrow = createFundedEscrow(rawEscrow, chips, ledger, flow);
  return { db, ledger, chips, rawEscrow, escrow };
}

describe("funded escrow replay", () => {
  it("同じholdAll操作の再試行はLandもescrowも二重に動かさない", () => {
    const ctx = setup();

    expect(ctx.escrow.holdAll("replay", ["alice", "bob"], 500, "pvp", "same-op")).toBe(true);
    expect(ctx.escrow.holdAll("replay", ["alice", "bob"], 500, "pvp", "same-op")).toBe(true);

    expect(ctx.ledger.balanceOf("user:alice")).toBe(500);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(500);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf("bob")).toBe(0);
    expect(ctx.rawEscrow.poolOf("replay")).toBe(1_000);
    ctx.db.close();
  });

  it("同じoperation IDを別金額へ使い回したら保存済み結果を流用せず拒否する", () => {
    const ctx = setup();

    expect(ctx.escrow.holdAll("conflict", ["alice", "bob"], 500, "pvp", "same-op")).toBe(true);
    expect(() => ctx.escrow.holdAll("conflict", ["alice", "bob"], 400, "pvp", "same-op")).toThrow(
      "funded escrow operation conflict",
    );

    expect(ctx.ledger.balanceOf("user:alice")).toBe(500);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(500);
    expect(ctx.rawEscrow.poolOf("conflict")).toBe(1_000);
    ctx.db.close();
  });
});
