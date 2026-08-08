import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, FORMAL_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, HOUSE_HOLDER } from "../src/casino/chip-ledger.js";
import {
  CasinoMetrics,
  casinoMetricArithmeticForTesting,
  casinoMetricDateForTesting,
} from "../src/casino/metrics.js";
import { FreeSpins } from "../src/casino/free-spins.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { tableExists } from "../src/casino/opening-canonical.js";

registerDefaultTxTypes();

const DAY = 86_400;
const D = "2026-01-10";
const START = casinoMetricDateForTesting.jstDateStart(D);

function setup(initialNow = START + 2 * DAY) {
  let now = initialNow;
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const metrics = new CasinoMetrics(db, chipTx, () => now);
  return {
    db,
    ledger,
    events,
    chipTx,
    chips,
    metrics,
    setNow(value: number) { now = value; },
  };
}

type Ctx = ReturnType<typeof setup>;

function openFormal(ctx: Ctx, openedAt = START): void {
  ctx.chipTx.captureOpening(FORMAL_OPENING_VERSION, [
    [HOUSE_HOLDER, 100_000],
    [JACKPOT_HOLDER, 1_000],
    [RELIEF_HOLDER, 1_000],
    ["alice", 10_000],
    ["bob", 10_000],
  ]);
  ctx.db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version=?")
    .run(openedAt, FORMAL_OPENING_VERSION);
}

function eventCount(ctx: Ctx, type: string): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_type=?").get(type) as { n: number }).n;
}

function insertDailyGroup(ctx: Ctx, key: string, userId: string, result: unknown, at = START + 40): void {
  ctx.db.prepare(`
    INSERT INTO casino_tx_groups (group_key, kind, status, actor_id, result_json, created_at, settled_at)
    VALUES (?, 'daily', 'settled', ?, ?, ?, ?)
  `).run(key, userId, JSON.stringify(result), at, at);
}

function insertSettledGroup(ctx: Ctx, key: string, kind: string, actorId: string, result: unknown, at = START + 50): void {
  ctx.db.prepare(`
    INSERT INTO casino_tx_groups (group_key, kind, status, actor_id, result_json, created_at, settled_at)
    VALUES (?, ?, 'settled', ?, ?, ?, ?)
  `).run(key, kind, actorId, JSON.stringify(result), at, at);
}

function insertChipTx(ctx: Ctx, input: {
  groupKey: string;
  seq: number;
  from: string;
  to: string;
  amount: number;
  at?: number;
}): void {
  ctx.db.prepare(`
    INSERT INTO casino_tx
      (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, game, session_id, actor_id,
       opening_version, land_amount, ledger_tx_id, created_at)
    VALUES (?, ?, 'internal_transfer', ?, ?, ?, 'metric-test', 'metric-test', NULL, 'tester', ?, NULL, NULL, ?)
  `).run(input.groupKey, input.seq, input.from, input.to, input.amount, FORMAL_OPENING_VERSION, input.at ?? START + 60);
}

function slotResult(input: { payout: number; jpWon?: number; pending?: unknown }) {
  return {
    reels: ["🍒", "🍒", "🍒"],
    kind: "cherry",
    matched: 3,
    freeSpin: false,
    rawPayout: input.payout,
    payout: input.payout,
    amuletNote: null,
    settled: { chainBonus: 0, fukuTax: 0 },
    jpWon: input.jpWon ?? 0,
    pendingFreeSpin: input.pending ?? null,
  };
}

function insertFreeRow(ctx: Ctx, input: { operationId: string; status: "pending" | "settled"; settledAt?: number | null }): void {
  new FreeSpins(ctx.db);
  ctx.db.prepare(`
    INSERT INTO casino_pending_free_spins
      (user_id, operation_id, spin_no, bet, source_group, status, reels_json, raw_payout,
       amulet_effect_json, amulet_note, payout, jackpot_won, jackpot_claim, total_claim, created_at, settled_at)
    VALUES ('alice', ?, 1, 100, ?, ?, '["🍒","🍒","🍒"]', 50,
            '{"kind":"none","amount":0}', NULL, 50, 0, 0, 50, ?, ?)
  `).run(input.operationId, `slots:spin:alice:${input.operationId}:paid`, input.status, START + 70, input.settledAt ?? null);
}

describe("CasinoMetrics lazy schema / opening boundary", () => {
  it("does not create metric tables before formal opening", () => {
    const ctx = setup();
    expect(ctx.chipTx.openingPhase()).toBe("pre_reset");
    ctx.metrics.record({ eventKey: "home_open:i1", eventType: "home_open", userId: "alice" });
    ctx.metrics.runDailyMaintenance();
    expect(tableExists(ctx.db, "casino_metric_events")).toBe(false);
    expect(tableExists(ctx.db, "casino_metric_daily")).toBe(false);
  });

  it("creates schema lazily on first formal metric operation and never creates a pre-opening daily row", () => {
    const ctx = setup(START + 3 * DAY);
    openFormal(ctx, START + 12 * 60 * 60);
    expect(tableExists(ctx.db, "casino_metric_events")).toBe(false);
    ctx.metrics.record({ eventKey: "home_open:i1", eventType: "home_open", userId: "alice" });
    expect(tableExists(ctx.db, "casino_metric_events")).toBe(true);
    expect(ctx.metrics.rollupDaily(casinoMetricDateForTesting.addJstDays(D, -1))).toBeNull();
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_daily").get() as { n: number }).n).toBe(0);
  });
});

describe("CasinoMetrics event idempotency", () => {
  it("same key/business content is a no-op when occurredAt was omitted even if the clock advances", () => {
    const ctx = setup(START + 10);
    openFormal(ctx);
    const input = { eventKey: "amount_pick:i1", eventType: "amount_pick" as const, userId: "alice", game: "スロット", amount: 100, payload: { a: 1 } };
    expect(ctx.metrics.record(input).recorded).toBe(true);
    const storedAt = (ctx.db.prepare("SELECT occurred_at FROM casino_metric_events WHERE event_key=?").get(input.eventKey) as { occurred_at: number }).occurred_at;
    ctx.setNow(START + 999);
    expect(ctx.metrics.record(input).recorded).toBe(false);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_key=?").get(input.eventKey) as { n: number }).n).toBe(1);
    expect((ctx.db.prepare("SELECT occurred_at FROM casino_metric_events WHERE event_key=?").get(input.eventKey) as { occurred_at: number }).occurred_at).toBe(storedAt);
  });

  it("keeps explicit different occurredAt as a conflict", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.record({ eventKey: "home_open:x", eventType: "home_open", userId: "alice", occurredAt: START + 1 });
    expect(() => ctx.metrics.record({ eventKey: "home_open:x", eventType: "home_open", userId: "alice", occurredAt: START + 2 }))
      .toThrow(/ERR_METRIC_EVENT_CONFLICT/);
  });
});

describe("CasinoMetrics daily_only", () => {
  it.each([
    [0, "successful total=0"],
    [500, "successful positive"],
  ])("includes %s Ld successful daily claim (%s)", (total) => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.ensureSchema();
    insertDailyGroup(ctx, `daily:alice:${total}`, "alice", { ok: true, claim: { total } });
    expect(ctx.metrics.synthesizeDailyOnly(D)).toBe(1);
    expect(eventCount(ctx, "daily_only")).toBe(1);
  });

  it("excludes ALREADY_CLAIMED and fails closed on malformed settled result_json", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.ensureSchema();
    insertDailyGroup(ctx, "daily:alice:already", "alice", { ok: false, reason: "ALREADY_CLAIMED" });
    expect(ctx.metrics.synthesizeDailyOnly(D)).toBe(0);
    expect(eventCount(ctx, "daily_only")).toBe(0);

    ctx.db.prepare("UPDATE casino_tx_groups SET result_json='not-json' WHERE group_key='daily:alice:already'").run();
    expect(() => ctx.metrics.synthesizeDailyOnly(D)).toThrow(/ERR_METRIC_BAD_RESULT/);
  });

  it("removes daily_only if a game_start is later observed on the same JST day", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.ensureSchema();
    insertDailyGroup(ctx, "daily:alice:ok", "alice", { ok: true, claim: { total: 0 } });
    ctx.metrics.synthesizeDailyOnly(D);
    expect(eventCount(ctx, "daily_only")).toBe(1);
    ctx.metrics.gameStart({ game: "スロット", userId: "alice", operationId: "g1", wager: 100, source: "amount", occurredAt: START + 100 });
    ctx.metrics.synthesizeDailyOnly(D);
    expect(eventCount(ctx, "daily_only")).toBe(0);
  });
});

describe("CasinoMetrics revisit / retention", () => {
  it("counts a D+90 23:59 return, finalizes on D+91, prunes raw D, and keeps finalized daily stable", () => {
    const windowEnd = START + 91 * DAY;
    const ctx = setup(windowEnd - 30);
    openFormal(ctx);
    ctx.metrics.record({ eventKey: "home_open:cohort", eventType: "home_open", userId: "alice", occurredAt: START + 10 });
    ctx.metrics.record({ eventKey: "home_open:return", eventType: "home_open", userId: "alice", occurredAt: windowEnd - 60 });

    const before = ctx.metrics.rollupDaily(D);
    expect(before?.revisit_rate_bps).toBeNull();
    const stored = ctx.db.prepare("SELECT revisit_cohort_json, revisit_finalized_at FROM casino_metric_daily WHERE date=?").get(D) as {
      revisit_cohort_json: string;
      revisit_finalized_at: number | null;
    };
    expect(JSON.parse(stored.revisit_cohort_json)).toEqual(["alice"]);
    expect(stored.revisit_finalized_at).toBeNull();

    ctx.setNow(windowEnd);
    const finalized = ctx.metrics.rollupDaily(D);
    expect(finalized?.revisit_rate_bps).toBe(10_000);
    expect(ctx.metrics.pruneRaw()).toBeGreaterThan(0);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_key='home_open:cohort'").get() as { n: number }).n).toBe(0);
    expect((ctx.db.prepare("SELECT revisit_rate_bps FROM casino_metric_daily WHERE date=?").get(D) as { revisit_rate_bps: number }).revisit_rate_bps).toBe(10_000);

    ctx.setNow(windowEnd + 30 * DAY);
    expect(ctx.metrics.rollupDaily(D)?.revisit_rate_bps).toBe(10_000);
  });

  it("does not regenerate chip deposit/redeem metric events after their >90d raw rows were pruned", () => {
    const now = START + 100 * DAY;
    const ctx = setup(now);
    openFormal(ctx);
    ctx.metrics.ensureSchema();
    ctx.db.prepare(`
      INSERT INTO casino_tx_groups (group_key, kind, status, actor_id, result_json, created_at, settled_at)
      VALUES ('deposit:old', 'deposit', 'settled', 'alice', '{}', ?, ?)
    `).run(START, START);
    ctx.db.prepare(`
      INSERT INTO casino_tx
        (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, game, session_id, actor_id,
         opening_version, land_amount, ledger_tx_id, created_at)
      VALUES ('deposit:old', 1, 'deposit', 'sys:land', 'alice', 100, 'old', NULL, NULL, 'alice', ?, 100, NULL, ?)
    `).run(FORMAL_OPENING_VERSION, START);
    ctx.metrics.record({ eventKey: "chip_deposit:tx:999999", eventType: "chip_deposit", userId: "alice", amount: 100, occurredAt: START });
    ctx.metrics.pruneRaw();
    expect(eventCount(ctx, "chip_deposit")).toBe(0);
    expect(ctx.metrics.syncChipExchangeEvents()).toBe(0);
    expect(eventCount(ctx, "chip_deposit")).toBe(0);
  });
});

describe("CasinoMetrics checked arithmetic", () => {
  const BIG = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;

  it("rejects individually-safe total_wager aggregation overflow without upserting daily", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.gameFinish({ game: "丁半", userId: "alice", operationId: "a", wager: BIG, payout: 0, net: -BIG, source: "amount", occurredAt: START + 1 });
    ctx.metrics.gameFinish({ game: "丁半", userId: "bob", operationId: "b", wager: BIG, payout: 0, net: -BIG, source: "amount", occurredAt: START + 2 });
    expect(() => ctx.metrics.rollupDaily(D)).toThrow(/ERR_METRIC_BAD_NUMBER/);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_daily WHERE date=?").get(D) as { n: number }).n).toBe(0);
  });

  it("rejects individually-safe total_payout aggregation overflow", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.gameFinish({ game: "丁半", userId: "alice", operationId: "a", wager: 0, payout: BIG, net: BIG, source: "amount", occurredAt: START + 1 });
    ctx.metrics.gameFinish({ game: "丁半", userId: "bob", operationId: "b", wager: 0, payout: BIG, net: BIG, source: "amount", occurredAt: START + 2 });
    expect(() => ctx.metrics.rollupDaily(D)).toThrow(/ERR_METRIC_BAD_NUMBER/);
  });

  it("rejects signed house P/L overflow", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.ensureSchema();
    insertSettledGroup(ctx, "solo:a", "solo_game", "alice", {});
    insertSettledGroup(ctx, "solo:b", "solo_game", "bob", {});
    insertChipTx(ctx, { groupKey: "solo:a", seq: 1, from: HOUSE_HOLDER, to: "alice", amount: BIG });
    insertChipTx(ctx, { groupKey: "solo:b", seq: 1, from: HOUSE_HOLDER, to: "bob", amount: BIG });
    expect(() => ctx.metrics.rollupDaily(D)).toThrow(/ERR_METRIC_BAD_NUMBER/);
  });

  it("rejects jackpot delta overflow", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.ensureSchema();
    insertSettledGroup(ctx, "jp:a", "solo_game", "alice", {});
    insertSettledGroup(ctx, "jp:b", "solo_game", "bob", {});
    insertChipTx(ctx, { groupKey: "jp:a", seq: 1, from: HOUSE_HOLDER, to: JACKPOT_HOLDER, amount: BIG });
    insertChipTx(ctx, { groupKey: "jp:b", seq: 1, from: HOUSE_HOLDER, to: JACKPOT_HOLDER, amount: BIG });
    expect(() => ctx.metrics.rollupDaily(D)).toThrow(/ERR_METRIC_BAD_NUMBER/);
  });

  it("rejects fuku outflow overflow", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.ensureSchema();
    insertSettledGroup(ctx, "daily:a", "daily", "alice", { ok: true, claim: { total: BIG } });
    insertSettledGroup(ctx, "daily:b", "daily", "bob", { ok: true, claim: { total: BIG } });
    insertChipTx(ctx, { groupKey: "daily:a", seq: 1, from: HOUSE_HOLDER, to: "alice", amount: BIG });
    insertChipTx(ctx, { groupKey: "daily:b", seq: 1, from: HOUSE_HOLDER, to: "bob", amount: BIG });
    expect(() => ctx.metrics.rollupDaily(D)).toThrow(/ERR_METRIC_BAD_NUMBER/);
  });

  it("uses checked/BigInt bps arithmetic and rejects an unsafe result", () => {
    expect(() => casinoMetricArithmeticForTesting.checkedAddAll([BIG, BIG], "test_sum")).toThrow(/ERR_METRIC_BAD_NUMBER/);
    expect(() => casinoMetricArithmeticForTesting.bps(Number.MAX_SAFE_INTEGER, 1)).toThrow(/ERR_METRIC_BAD_NUMBER/);
  });
});

describe("CasinoMetrics slots finish reconciliation", () => {
  it("paid-only closes finish from settled financial truth before any display can fail", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.gameStart({ game: "スロット", userId: "alice", operationId: "paid", wager: 100, source: "amount", occurredAt: START + 1 });
    insertSettledGroup(ctx, "slots:spin:alice:paid:paid", "solo_game", "alice", slotResult({ payout: 150 }), START + 2);
    expect(ctx.metrics.reconcileSlotsFinish("alice", "paid")).toBe(true);
    expect(() => { throw new Error("Discord display failed after settlement"); }).toThrow("Discord display failed");
    expect(eventCount(ctx, "game_start")).toBe(1);
    expect(eventCount(ctx, "game_finish")).toBe(1);
  });

  it("pending free recovery creates no new start and closes the original operation only after free settlement", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.gameStart({ game: "スロット", userId: "alice", operationId: "free", wager: 100, source: "retry", occurredAt: START + 1 });
    insertSettledGroup(ctx, "slots:spin:alice:free:paid", "solo_game", "alice", slotResult({ payout: 100, pending: { spinNo: 1 } }), START + 2);
    insertFreeRow(ctx, { operationId: "free", status: "pending" });
    expect(ctx.metrics.reconcileSlotsFinish("alice", "free")).toBe(false);
    expect(eventCount(ctx, "game_start")).toBe(1);
    expect(eventCount(ctx, "game_finish")).toBe(0);

    ctx.db.prepare("UPDATE casino_pending_free_spins SET status='settled', settled_at=? WHERE user_id='alice' AND operation_id='free'").run(START + 3);
    insertSettledGroup(ctx, "slots:spin:alice:free:free:1", "free_spin", "alice", slotResult({ payout: 50 }), START + 3);
    expect(ctx.metrics.reconcileSlotsFinish("alice", "free")).toBe(true);
    expect(eventCount(ctx, "game_start")).toBe(1);
    expect(eventCount(ctx, "game_finish")).toBe(1);
    const finish = ctx.db.prepare("SELECT wager, payout, net, source, operation_id FROM casino_metric_events WHERE event_type='game_finish'").get() as {
      wager: number; payout: number; net: number; source: string; operation_id: string;
    };
    expect(finish).toEqual({ wager: 100, payout: 150, net: 50, source: "retry", operation_id: "free" });
  });

  it("reconciles free-settled/analytics-missing crash window and repeated reconcile is idempotent", () => {
    const ctx = setup();
    openFormal(ctx);
    ctx.metrics.gameStart({ game: "スロット", userId: "alice", operationId: "crash", wager: 100, source: "amount", occurredAt: START + 1 });
    insertSettledGroup(ctx, "slots:spin:alice:crash:paid", "solo_game", "alice", slotResult({ payout: 120, pending: { spinNo: 1 } }), START + 2);
    insertFreeRow(ctx, { operationId: "crash", status: "settled", settledAt: START + 3 });
    insertSettledGroup(ctx, "slots:spin:alice:crash:free:1", "free_spin", "alice", slotResult({ payout: 80 }), START + 3);

    expect(ctx.metrics.reconcileSlotsFinishes()).toBe(1);
    expect(ctx.metrics.reconcileSlotsFinishes()).toBe(0);
    expect(ctx.metrics.reconcileSlotsFinish("alice", "crash")).toBe(false);
    expect(eventCount(ctx, "game_start")).toBe(1);
    expect(eventCount(ctx, "game_finish")).toBe(1);
  });
});
