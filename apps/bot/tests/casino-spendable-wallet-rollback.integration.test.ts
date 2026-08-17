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
  const chipFlow = new CasinoChipFlow(db, chips, events, assets);
  ledger.ensureAccount("user:alice", "user");
  ledger.transfer({
    from: TREASURY,
    to: "user:alice",
    amount: 1_000,
    type: "initial",
    actor: "test",
    idempotencyKey: "wallet-rollback-seed",
  });
  const rawEscrow = new Escrow(db, chips, events);
  const escrow = createFundedEscrow(rawEscrow, chips, ledger, chipFlow);
  return { db, ledger, chips, rawEscrow, escrow };
}

describe("funded escrow nested transaction", () => {
  it("競馬/ルーレット型の外側group内でLand→chip→escrowをまとめて確定する", () => {
    const ctx = setup();

    ctx.chips.runGroup({ groupKey: "outer-keiba-ok", kind: "table_hold", actorId: "alice" }, () => {
      expect(ctx.escrow.hold("race-real", "alice", 500, "keiba", "bet-1")).toBe(true);
    });

    expect(ctx.ledger.balanceOf("user:alice")).toBe(500);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.rawEscrow.poolOf("race-real")).toBe(500);
    ctx.db.close();
  });

  it("外側groupが後段で失敗したらauto-depositもescrowも一緒にrollbackする", () => {
    const ctx = setup();

    expect(() =>
      ctx.chips.runGroup({ groupKey: "outer-keiba-fail", kind: "table_hold", actorId: "alice" }, () => {
        expect(ctx.escrow.hold("race-rollback", "alice", 500, "keiba", "bet-2")).toBe(true);
        throw new Error("later failure");
      }),
    ).toThrow("later failure");

    expect(ctx.ledger.balanceOf("user:alice"), "Land→chipだけ確定している").toBe(1_000);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.rawEscrow.poolOf("race-rollback"), "escrowだけ残っている").toBe(0);
    ctx.db.close();
  });
});
