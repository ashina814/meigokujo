import { describe, expect, it } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  DailyRisk,
  DailyRiskError,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputes,
  RankedTableError,
  RankedTables,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

const DEFAULT_TEST_NOW = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;

function setup(options: {
  now?: number;
  dailyLossLimitBps?: number;
  boundaryOffsetMinutes?: number;
  highCooldownSec?: number | null;
  superHighEnabled?: boolean;
  extremeEnabled?: boolean;
} = {}) {
  let now = options.now ?? DEFAULT_TEST_NOW;
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(now - 31 * 24 * 60 * 60);
  const assets = new CasinoChipAssets(db, chips);
  const dailyRisk = new DailyRisk(db, ledger, assets, {
    now: () => now,
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => options.dailyLossLimitBps ?? 3_000,
    boundaryOffsetMinutes: () => options.boundaryOffsetMinutes ?? 0,
  });
  const casino = new Casino(db, chips, events, { dailyRisk });
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => now });
  const chipFlow = new CasinoChipFlow(db, chips, events, assets);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    now: () => now,
    onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
    dailyRisk,
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, new CasinoMetrics(db, chipTx, () => now), {
    now: () => now,
    chipFlow,
    reservations,
    disputes,
    dailyRisk,
    highCooldownSec: () => options.highCooldownSec ?? null,
    superHighEnabled: () => options.superHighEnabled === true,
    extremeEnabled: () => options.extremeEnabled === true,
  });
  return {
    db,
    ledger,
    events,
    chipTx,
    chips,
    assets,
    dailyRisk,
    casino,
    escrow,
    persistentTables,
    chipFlow,
    reservations,
    disputes,
    rankedTables,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function seedLand(ctx: ReturnType<typeof setup>, userId: string, amount: number, key = `seed:${userId}:${amount}`): number {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  const tx = ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: key });
  return tx.tx.id;
}

function seedChips(ctx: ReturnType<typeof setup>, userId: string, amount: number): void {
  seedLand(ctx, userId, amount);
  ctx.chips.deposit(userId, amount, `deposit:${userId}:${amount}`);
}

function createGf(ctx: ReturnType<typeof setup>, tableId = "t1", baseAmount = 5_000) {
  return ctx.rankedTables.create({ tableId, gameKey: "gf", baseAmount, creatorId: "operator", operatorId: "operator", operationId: `create:${tableId}` });
}

function eventRows(ctx: ReturnType<typeof setup>) {
  return ctx.db
    .prepare("SELECT event_key, user_id, day_key, source_kind, net_signed FROM casino_daily_risk_events ORDER BY event_key")
    .all() as Array<{ event_key: string; user_id: string; day_key: string; source_kind: string; net_signed: number }>;
}

describe("casino daily risk limits", () => {
  it("reconstructs day-start holdings from append-only Land and chip ledgers", () => {
    const ctx = setup({ now: 200_000, boundaryOffsetMinutes: 0 });
    const dayStart = Math.floor(200_000 / 86_400) * 86_400;
    const oldTx = seedLand(ctx, "alice", 10_000, "old-land");
    ctx.db.prepare("UPDATE transactions SET created_at=? WHERE id=?").run(dayStart - 10, oldTx);
    const newTx = seedLand(ctx, "alice", 2_000, "new-land");
    ctx.db.prepare("UPDATE transactions SET created_at=? WHERE id=?").run(dayStart + 10, newTx);

    const day = ctx.dailyRisk.dayFor("alice");
    expect(day.openingHoldings).toBe(10_000);
    expect(day.lossCap).toBe(3_000);
    expect(ctx.dailyRisk.holdings("alice")).toBe(12_000);
  });

  it("binds solo settlement to the start day and rolls back money when the risk event conflicts", () => {
    const ctx = setup({ boundaryOffsetMinutes: 0, dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    const start = ctx.dailyRisk.authorizeSoloStart({ userId: "alice", operationId: "op1", game: "slots", bet: 300, maxPlayerLoss: 300 });
    const startedDay = ctx.dailyRisk.dayFor("alice");
    ctx.setNow(Math.min(startedDay.dayStartAt + 86_399, DEFAULT_TEST_NOW + 100));
    ctx.casino.settleSolo("alice", "slots", 300, 0, { operationId: "op1", chain: false, fuku: false });
    expect(eventRows(ctx)).toContainEqual(expect.objectContaining({ event_key: "solo_result:op1", day_key: start.dayKey, net_signed: -300 }));

    ctx.dailyRisk.authorizeSoloStart({ userId: "alice", operationId: "op2", game: "slots", bet: 100, maxPlayerLoss: 100 });
    ctx.db.prepare("INSERT INTO casino_daily_risk_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("solo_result:op2", "alice", start.dayKey, "solo_result", "op2", "op2", -1, "different", 1);
    const before = { alice: ctx.chips.balanceOf("alice"), house: ctx.chips.balanceOf(HOUSE_HOLDER) };
    expect(() => ctx.casino.settleSolo("alice", "slots", 100, 0, { operationId: "op2", chain: false, fuku: false })).toThrow(DailyRiskError);
    expect({ alice: ctx.chips.balanceOf("alice"), house: ctx.chips.balanceOf(HOUSE_HOLDER) }).toEqual(before);
  });

  it("records chinchiro extra loss against the original solo start day", () => {
    const ctx = setup({ boundaryOffsetMinutes: 0, dailyLossLimitBps: 10_000 });
    seedChips(ctx, "alice", 10_000);
    const start = ctx.dailyRisk.authorizeSoloStart({ userId: "alice", operationId: "chinchiro:1", game: "chinchiro", bet: 1_000, maxPlayerLoss: 2_000 });

    ctx.casino.settleSolo("alice", "chinchiro", 1_000, 0, { operationId: "chinchiro:1", chain: false, fuku: false });
    ctx.dailyRisk.recordSoloExtraLoss({ userId: "alice", operationId: "chinchiro:1", netSigned: -1_000 });

    expect(eventRows(ctx)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_key: "solo_result:chinchiro:1", day_key: start.dayKey, net_signed: -1_000 }),
        expect.objectContaining({ event_key: "solo_extra_loss:chinchiro:1", day_key: start.dayKey, net_signed: -1_000 }),
      ]),
    );
    expect(ctx.dailyRisk.dayFor("alice").netSigned).toBe(-2_000);
  });
});

describe("ranked table risk gates", () => {
  it("allows exact 50% holdings coverage and rejects one Land short without funds or participant rows", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    createGf(ctx);
    seedChips(ctx, "alice", 10_300);
    expect(ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" }).participants[0]?.riskMaxLoss).toBe(5_150);

    seedChips(ctx, "bob", 10_299);
    expect(() => ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" })).toThrow(DailyRiskError);
    expect(ctx.escrow.poolOf("t1")).toBe(5_150);
    expect(ctx.persistentTables.participants("t1").map((p) => p.userId)).toEqual(["alice"]);
  });

  it("records table fees and ranked result nets on the participants original risk day", () => {
    const ctx = setup({ dailyLossLimitBps: 10_000 });
    createGf(ctx);
    seedChips(ctx, "alice", 30_000);
    seedChips(ctx, "bob", 30_000);
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    for (const userId of ["alice", "bob"]) {
      ctx.rankedTables.approve({ tableId: "t1", userId, resultHash: submitted.result!.hash, operationId: `approve:${userId}` });
    }

    expect(eventRows(ctx)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_key: "table_fee:t1:alice:ready:ready:bob", net_signed: -150 }),
        expect.objectContaining({ event_key: "table_fee:t1:bob:ready:ready:bob", net_signed: -150 }),
        expect.objectContaining({ event_key: `table_result:t1:alice:${submitted.result!.hash}`, net_signed: 5_000 }),
        expect.objectContaining({ event_key: `table_result:t1:bob:${submitted.result!.hash}`, net_signed: -5_000 }),
      ]),
    );
  });
});

describe("ranked tier availability", () => {
  it("requires explicit staged settings for high-or-above tiers and preserves create replay during cooldown", () => {
    const ctx = setup({ highCooldownSec: 3_600 });
    const first = ctx.rankedTables.create({ tableId: "high1", gameKey: "gf", baseAmount: 10_000, creatorId: "operator", operatorId: "operator", operationId: "create:high1", authority: "employee" });
    expect(first.config.baseAmount).toBe(10_000);
    ctx.setNow(1_700_000_100);
    expect(ctx.rankedTables.create({ tableId: "high1", gameKey: "gf", baseAmount: 10_000, creatorId: "operator", operatorId: "operator", operationId: "create:high1", authority: "employee" }).table.tableId).toBe("high1");
    expect(() => ctx.rankedTables.create({ tableId: "high2", gameKey: "gf", baseAmount: 10_000, creatorId: "operator", operatorId: "operator", operationId: "create:high2", authority: "employee" })).toThrow(RankedTableError);
  });

  it("keeps super high and extreme closed by default and blocks them during the first 30 formal-opening days", () => {
    expect(() => setup({ highCooldownSec: 3_600 }).rankedTables.create({ tableId: "super1", gameKey: "gf", baseAmount: 30_000, creatorId: "operator", operatorId: "operator", operationId: "create:super1", authority: "manager" })).toThrow(RankedTableError);

    const youngNow = 1_700_000_000;
    const young = setup({ now: youngNow, highCooldownSec: 3_600, superHighEnabled: true });
    young.db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(youngNow - 29 * 24 * 60 * 60);
    expect(() => young.rankedTables.create({ tableId: "super2", gameKey: "gf", baseAmount: 30_000, creatorId: "operator", operatorId: "operator", operationId: "create:super2", authority: "manager" })).toThrow(RankedTableError);

    const employee = setup({ highCooldownSec: 3_600, superHighEnabled: true, extremeEnabled: true });
    expect(() => employee.rankedTables.create({ tableId: "extreme1", gameKey: "gf", baseAmount: 50_000, creatorId: "operator", operatorId: "operator", operationId: "create:extreme1", authority: "employee" })).toThrow(RankedTableError);
  });
});
