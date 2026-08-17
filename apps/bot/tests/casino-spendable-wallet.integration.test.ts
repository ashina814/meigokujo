import { describe, expect, it } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  CHIP_ESCROW,
  ChipLedger,
  Daily,
  Escrow,
  EventLog,
  FORMAL_OPENING_VERSION,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  Markets,
  RELIEF_HOLDER,
  TREASURY,
  Vip,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { createFundedEscrow, createSpendableChipLedger } from "../src/casino/spendable-wallet.js";

registerDefaultTxTypes();

function setup(seed: Record<string, number>) {
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

  for (const [userId, amount] of Object.entries(seed)) {
    ledger.ensureAccount(`user:${userId}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${userId}`,
      amount,
      type: "initial",
      actor: "test",
      idempotencyKey: `wallet-seed:${userId}`,
    });
  }

  const wallet = createSpendableChipLedger(chips, ledger, chipFlow);
  return { db, ledger, events, chips, chipFlow, wallet };
}

describe("spendable wallet real DB integration", () => {
  it("PvP holdAllは両者の通常Landを同一groupで自動預入してescrowへ移す", () => {
    const ctx = setup({ alice: 1_000, bob: 1_000 });
    const rawEscrow = new Escrow(ctx.db, ctx.chips, ctx.events);
    const escrow = createFundedEscrow(rawEscrow, ctx.chips, ctx.ledger, ctx.chipFlow);

    expect(escrow.holdAll("pvp-real", ["alice", "bob"], 500, "pvp", "accept-1")).toBe(true);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(500);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(500);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf("bob")).toBe(0);
    expect(rawEscrow.poolOf("pvp-real")).toBe(1_000);
    expect(ctx.chips.balanceOf(rawEscrow.holderId("pvp-real"))).toBe(1_000);

    ctx.db.close();
  });

  it("PvP holdAllは片方が不足なら1人目のLandも1Ldも動かさない", () => {
    const ctx = setup({ alice: 1_000, bob: 100 });
    const rawEscrow = new Escrow(ctx.db, ctx.chips, ctx.events);
    const escrow = createFundedEscrow(rawEscrow, ctx.chips, ctx.ledger, ctx.chipFlow);

    expect(escrow.holdAll("pvp-short", ["alice", "bob"], 500, "pvp", "accept-2")).toBe(false);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(1_000);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(100);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf("bob")).toBe(0);
    expect(rawEscrow.poolOf("pvp-short")).toBe(0);

    ctx.db.close();
  });

  it("VIP加入は自由チップ0でも通常Landから会費を原子的に払える", () => {
    const ctx = setup({ alice: 40_000 });
    const vip = new Vip(ctx.db, ctx.wallet, ctx.events, { price: 30_000, days: 30 });

    expect(vip.join("alice", "vip-real")).toMatchObject({ ok: true });
    expect(ctx.ledger.balanceOf("user:alice")).toBe(10_000);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(30_000);

    ctx.db.close();
  });

  it("通常板の作成手数料も通常Landから払え、イベントLand板の設計には触れない", () => {
    const ctx = setup({ alice: 2_000 });
    const markets = new Markets(ctx.db, ctx.wallet, ctx.events, { landLedger: ctx.ledger });

    const market = markets.create({
      guildId: "guild",
      creatorId: "alice",
      title: "test",
      options: ["A", "B"],
      durationMin: 10,
      fee: 500,
      operationId: "market-real",
    });

    expect(market.id).toBeGreaterThan(0);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(1_500);
    expect(ctx.chips.balanceOf("alice")).toBe(0);

    ctx.db.close();
  });

  it("福分けの救済判定は自由チップ0ではなく通常Land込みの総所持額を見る", () => {
    const ctx = setup({ alice: 60_000 });
    ctx.chips.fundFromAccount(TREASURY, 5_000, HOUSE_HOLDER, "seed-house");
    ctx.chips.fundFromAccount(TREASURY, 5_000, RELIEF_HOLDER, "seed-relief");
    const daily = new Daily(ctx.db, ctx.wallet, ctx.events, {
      base: 100,
      reliefThreshold: 10_000,
      reliefMax: 500,
    });

    const result = daily.claim("alice", "daily-real");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.relief, "6万Land持ちを低残高救済している").toBe(0);
      expect(result.claim.total).toBe(100);
    }
    expect(ctx.ledger.balanceOf("user:alice")).toBe(60_000);
    expect(ctx.chips.balanceOf("alice")).toBe(100);

    ctx.db.close();
  });

  it("福の重みはLandと自由チップの置き場所ではなく総所持額で同じ税率になる", () => {
    const landCtx = setup({ alice: 60_000 });
    landCtx.chips.fundFromAccount(TREASURY, 100_000, HOUSE_HOLDER, "fuku-land-house");
    const landCasino = new Casino(landCtx.db, landCtx.wallet, landCtx.events, { fukuScale: () => 1 });
    const landResult = landCasino.settleSolo("alice", "test", 1_000, 2_000, { operationId: "fuku-land" });

    const chipCtx = setup({ alice: 60_000 });
    chipCtx.chips.fundFromAccount(TREASURY, 100_000, HOUSE_HOLDER, "fuku-chip-house");
    chipCtx.chips.deposit("alice", 60_000, "fuku-chip-seed");
    const chipCasino = new Casino(chipCtx.db, chipCtx.wallet, chipCtx.events, { fukuScale: () => 1 });
    const chipResult = chipCasino.settleSolo("alice", "test", 1_000, 2_000, { operationId: "fuku-chip" });

    expect(landResult.fukuRate).toBe(0.1);
    expect(chipResult.fukuRate).toBe(0.1);
    expect(landResult.fukuTax).toBe(100);
    expect(chipResult.fukuTax).toBe(100);

    landCtx.db.close();
    chipCtx.db.close();
  });
});
