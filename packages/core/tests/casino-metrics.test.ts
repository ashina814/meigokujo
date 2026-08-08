import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, FORMAL_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, HOUSE_HOLDER } from "../src/casino/chip-ledger.js";
import { CasinoMetrics, casinoMetricDateForTesting } from "../src/casino/metrics.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { tableExists } from "../src/casino/opening-canonical.js";

registerDefaultTxTypes();

const D = "2026-01-10";
const START = casinoMetricDateForTesting.jstDateStart(D);

function setup(now = START + 2 * 86_400) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const metrics = new CasinoMetrics(db, chipTx, () => now);
  return { db, ledger, events, chipTx, chips, metrics };
}

function openFormal(ctx: ReturnType<typeof setup>): void {
  ctx.chipTx.captureOpening(FORMAL_OPENING_VERSION, [
    [HOUSE_HOLDER, 100_000],
    [JACKPOT_HOLDER, 1_000],
    [RELIEF_HOLDER, 1_000],
    ["alice", 10_000],
    ["bob", 10_000],
  ]);
}

describe("CasinoMetrics lazy schema", () => {
  it("does not create metric tables before formal opening", () => {
    const ctx = setup();
    expect(ctx.chipTx.openingPhase()).toBe("pre_reset");
    ctx.metrics.record({ eventKey: "home_open:i1", eventType: "home_open", userId: "alice" });
    ctx.metrics.runDailyMaintenance();
    expect(tableExists(ctx.db, "casino_metric_events")).toBe(false);
    expect(tableExists(ctx.db, "casino_metric_daily")).toBe(false);
  });

  it("creates schema lazily on the first formal metric operation", () => {
    const ctx = setup();
    openFormal(ctx);
    expect(tableExists(ctx.db, "casino_metric_events")).toBe(false);
    ctx.metrics.record({ eventKey: "home_open:i1", eventType: "home_open", userId: "alice" });
    expect(tableExists(ctx.db, "casino_metric_events")).toBe(true);
    expect(tableExists(ctx.db, "casino_metric_daily")).toBe(true);
  });
});

describe("CasinoMetrics raw events", () => {
  it("is idempotent for the same key and canonical payload, but rejects conflicts", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.record({
      eventKey: "amount_pick:i1",
      eventType: "amount_pick",
      userId: "alice",
      game: "slots",
      amount: 100,
      payload: { b: 2, a: 1 },
      occurredAt: START,
    });
    ctx.metrics.record({
      eventKey: "amount_pick:i1",
      eventType: "amount_pick",
      userId: "alice",
      game: "slots",
      amount: 100,
      payload: { a: 1, b: 2 },
      occurredAt: START,
    });
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_events").get() as { n: number }).n).toBe(1);
    expect(() =>
      ctx.metrics.record({
        eventKey: "amount_pick:i1",
        eventType: "amount_pick",
        userId: "alice",
        game: "slots",
        amount: 200,
        payload: { a: 1, b: 2 },
        occurredAt: START,
      }),
    ).toThrow(/ERR_METRIC_EVENT_CONFLICT/);
  });

  it("rejects unsafe numbers and accepts all PR19 event types without emitting table events by itself", () => {
    const ctx = setup();
    openFormal(ctx);
    expect(() =>
      ctx.metrics.record({ eventKey: "bad", eventType: "game_finish", userId: "alice", wager: 1.5 }),
    ).toThrow(/ERR_METRIC_BAD_NUMBER/);
    ctx.metrics.record({ eventKey: "table_open:test", eventType: "table_open", occurredAt: START });
    expect((ctx.db.prepare("SELECT event_type FROM casino_metric_events").get() as { event_type: string }).event_type).toBe("table_open");
  });
});

describe("CasinoMetrics maintenance", () => {
  it("synthesizes daily_only, rolls up JST daily data, recomputes revisit, and prunes raw only", () => {
    const ctx = setup(START + 100 * 86_400);
    openFormal(ctx);
    ctx.metrics.record({ eventKey: "home_open:h1", eventType: "home_open", userId: "alice", occurredAt: START + 10 });
    ctx.metrics.record({ eventKey: "home_open:h2", eventType: "home_open", userId: "alice", occurredAt: START + 2 * 86_400 });
    ctx.metrics.record({
      eventKey: "game_start:slots:bob:g1",
      eventType: "game_start",
      userId: "bob",
      game: "slots",
      wager: 100,
      occurredAt: START + 20,
    });
    ctx.metrics.record({
      eventKey: "game_finish:slots:bob:g1",
      eventType: "game_finish",
      userId: "bob",
      game: "slots",
      wager: 100,
      payout: 150,
      net: 50,
      occurredAt: START + 30,
    });
    ctx.metrics.record({ eventKey: "replay:slots:bob:g1", eventType: "replay", userId: "bob", game: "slots", wager: 100, occurredAt: START + 31 });

    ctx.db.prepare("INSERT INTO casino_tx_groups (group_key, kind, status, actor_id, result_json, created_at, settled_at) VALUES (?, ?, 'settled', ?, ?, ?, ?)").run(
      "daily:alice:claim1",
      "daily",
      "alice",
      "{}",
      START + 40,
      START + 40,
    );
    ctx.db.prepare(`
      INSERT INTO casino_tx
        (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, game, session_id, actor_id,
         opening_version, land_amount, ledger_tx_id, created_at)
      VALUES (?, 1, 'internal_transfer', ?, ?, 100, 'daily', 'daily', NULL, ?, ?, NULL, NULL, ?)
    `).run("daily:alice:claim1", HOUSE_HOLDER, "alice", "alice", FORMAL_OPENING_VERSION, START + 40);
    ctx.metrics.synthesizeDailyOnly(D);
    const dailyOnly = ctx.db.prepare("SELECT event_type, user_id FROM casino_metric_events WHERE event_type='daily_only'").get() as
      | { event_type: string; user_id: string }
      | undefined;
    expect(dailyOnly).toEqual({ event_type: "daily_only", user_id: "alice" });

    const row = ctx.metrics.rollupDaily(D);
    expect(row?.play_count).toBe(1);
    expect(row?.unique_users).toBe(1);
    expect(row?.total_wager).toBe(100);
    expect(row?.total_payout).toBe(150);
    expect(row?.house_pnl).toBe(-100);
    expect(row?.fuku_outflow).toBe(100);
    expect(row?.replay_rate_bps).toBe(10_000);
    expect(row?.revisit_rate_bps).toBe(10_000);

    ctx.metrics.record({ eventKey: "home_open:old", eventType: "home_open", userId: "old", occurredAt: START - 91 * 86_400 });
    expect(ctx.metrics.pruneRaw()).toBeGreaterThan(0);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_daily").get() as { n: number }).n).toBe(1);
  });
});
