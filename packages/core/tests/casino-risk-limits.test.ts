import { describe, expect, it } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  ChipLedger,
  ChipTx,
  DailyRisk,
  DailyRiskError,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
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
  const chipFlow = new CasinoChipFlow(db, chips, events, assets);
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
    chipFlow,
    reservations,
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
