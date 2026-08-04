import { describe, expect, it } from "vitest";
import {
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  CasinoStatus,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HouseReservations,
  Ledger,
  RecoveryRegistry,
  TREASURY,
  openDb,
  recoverCasino,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  const escrow = new Escrow(db, chips, events);
  const assets = new CasinoChipAssets(db, chips);
  const flow = new CasinoChipFlow(db, chips, events, assets);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, assets);
  const status = new CasinoStatus(db);
  const reservations = new HouseReservations(db, chips, events);
  const registry = new RecoveryRegistry();
  registry.register({ type: "market", listLiveEscrowHolders: () => [] });
  const run = () => recoverCasino({ db, status, integrity, chipTx, escrow, reservations, registry, events, chipFlow: flow });
  return { db, ledger, chips, assets, flow, status, run };
}

function fund(ctx: ReturnType<typeof setup>, userId: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}`);
}

describe("PR10 recovery S10", () => {
  it("runs after S9 and before postflight/S12, returning only free chips", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    const result = ctx.run();
    expect(result.steps.indexOf("S9:予約解放")).toBeLessThan(result.steps.indexOf("S10:自由チップ返還"));
    expect(result.steps.indexOf("S10:自由チップ返還")).toBeLessThan(result.steps.indexOf("S12:後検"));
    expect(result.redeemedFreeChips.redeemed).toHaveLength(1);
    expect(ctx.assets.freeChips("alice")).toBe(0);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
  });

  it("successful S10 redemption is not repeated on recovery rerun", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    expect(ctx.run().redeemedFreeChips.redeemed).toHaveLength(1);
    expect(ctx.run().redeemedFreeChips.redeemed).toHaveLength(0);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
  });
});
