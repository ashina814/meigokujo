import { describe, expect, it } from "vitest";
import {
  CasinoChipAssets,
  CasinoChipFlow,
  CHIP_ESCROW,
  ChipLedger,
  EventLog,
  FORMAL_OPENING_VERSION,
  Ledger,
  Markets,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { createSpendableChipLedger } from "../src/casino/spendable-wallet.js";

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
  const assets = new CasinoChipAssets(db, chips);
  const flow = new CasinoChipFlow(db, chips, events, assets);
  const wallet = createSpendableChipLedger(chips, ledger, flow);

  ledger.ensureAccount("user:alice", "user");
  ledger.transfer({
    from: TREASURY,
    to: "user:alice",
    amount: 5_000,
    type: "initial",
    actor: "test",
    idempotencyKey: "standard-market-wallet-seed",
  });

  const markets = new Markets(db, wallet, events, { landLedger: ledger });
  return { db, ledger, chips, markets };
}

describe("standard market spendable wallet", () => {
  it("通常Landだけで板の作成→賭け→賭け直しまで行える", () => {
    const ctx = setup();
    const market = ctx.markets.create({
      guildId: "guild",
      creatorId: "alice",
      title: "A or B",
      options: ["A", "B"],
      durationMin: 10,
      fee: 500,
      operationId: "create-1",
    });

    expect(ctx.ledger.balanceOf("user:alice")).toBe(4_500);
    expect(ctx.chips.balanceOf("alice")).toBe(0);

    expect(ctx.markets.bet(market.id, "alice", 0, 1_000, "bet-1")).toEqual({ previous: null, net: 1_000 });
    expect(ctx.ledger.balanceOf("user:alice")).toBe(3_500);
    expect(ctx.chips.balanceOf("alice")).toBe(0);

    expect(ctx.markets.bet(market.id, "alice", 1, 1_500, "bet-2")).toEqual({ previous: 1_000, net: 500 });
    expect(ctx.ledger.balanceOf("user:alice")).toBe(3_000);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.markets.bets(market.id)).toMatchObject([{ user_id: "alice", option_index: 1, amount: 1_500 }]);

    ctx.db.close();
  });
});
