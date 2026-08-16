import type Database from "better-sqlite3";
import { isPlayerHolder, HOUSE_HOLDER } from "./chip-ledger.js";
import { FORMAL_OPENING_VERSION, type ChipTx } from "./chip-tx.js";
import { JACKPOT_HOLDER } from "./service.js";
import { canonicalStringify, tableExists } from "./opening-canonical.js";
import { classifyHousePnlTx } from "./house-pnl.js";

export const CASINO_METRIC_EVENT_TYPES = [
  "home_open",
  "primary_press",
  "game_pick",
  "amount_pick",
  "game_start",
  "game_finish",
  "game_abandon",
  "replay",
  "daily_only",
  "chip_deposit",
  "chip_redeem",
] as const;

export type CasinoMetricEventType = typeof CASINO_METRIC_EVENT_TYPES[number];

export type CasinoMetricsErrorCode =
  | "ERR_METRIC_EVENT_CONFLICT"
  | "ERR_METRIC_EVENT_TYPE"
  | "ERR_METRIC_BAD_NUMBER"
  | "ERR_METRIC_BAD_KEY"
  | "ERR_METRIC_BAD_DATE"
  | "ERR_METRIC_BAD_RESULT"
  | "ERR_METRIC_HOUSE_PNL_UNCLASSIFIED";

export class CasinoMetricsError extends Error {
  constructor(
    readonly code: CasinoMetricsErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "CasinoMetricsError";
  }
}

export interface CasinoMetricEventInput {
  eventKey: string;
  eventType: CasinoMetricEventType;
  userId?: string | null;
  game?: string | null;
  source?: string | null;
  operationId?: string | null;
  wager?: number | null;
  payout?: number | null;
  net?: number | null;
  amount?: number | null;
  payload?: unknown;
  occurredAt?: number;
}

interface CasinoMetricEventRow {
  event_key: string;
  event_type: string;
  user_id: string | null;
  game: string | null;
  source: string | null;
  operation_id: string | null;
  wager: number | null;
  payout: number | null;
  net: number | null;
  amount: number | null;
  payload_json: string | null;
  occurred_at: number;
}

export interface CasinoMetricDailyRow {
  date: string;
  play_count: number;
  unique_users: number;
  total_wager: number;
  total_payout: number;
  house_pnl: number;
  jackpot_delta: number;
  fuku_outflow: number;
  replay_rate_bps: number | null;
  revisit_rate_bps: number | null;
  updated_at: number;
}

/**
 * DB 上の保存形。
 *
 * `table_*` は**退役した対人順位卓（2026-08-16 廃止）の列**で、読み取り互換のためだけに
 * ここへ残している。列を生む経路はもう無く、新規行では常に 0 が入る。
 * 現行の集計・表示は {@link CasinoMetricDailyRow} を使い、これらを見ない。
 */
interface CasinoMetricDailyStorageRow extends CasinoMetricDailyRow {
  table_fee_income: number;
  table_open_count: number;
  table_start_count: number;
  table_dispute_count: number;
  revisit_cohort_json: string | null;
  revisit_finalized_at: number | null;
}

interface PersistedSlotSpinResult {
  payout: number;
  jpWon: number;
  chainBonus: number;
  fukuTax: number;
  pendingFreeSpin: unknown;
}

const EVENT_TYPES = new Set<string>(CASINO_METRIC_EVENT_TYPES);
const DAY_SEC = 86_400;
const JST_OFFSET_SEC = 9 * 60 * 60;
const RAW_RETENTION_DAYS = 90;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) throw new CasinoMetricsError("ERR_METRIC_BAD_NUMBER", { field, value });
}

function assertNonNegative(value: number, field: string): void {
  assertSafeInteger(value, field);
  if (value < 0) throw new CasinoMetricsError("ERR_METRIC_BAD_NUMBER", { field, value });
}

function checkedAdd(a: number, b: number, field: string): number {
  assertSafeInteger(a, `${field}.left`);
  assertSafeInteger(b, `${field}.right`);
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new CasinoMetricsError("ERR_METRIC_BAD_NUMBER", { field, a, b });
  return result;
}

function checkedAddAll(values: readonly number[], field: string): number {
  let total = 0;
  for (const value of values) total = checkedAdd(total, value, field);
  return total;
}

function canonicalPayload(payload: unknown): string | null {
  return payload === undefined ? null : canonicalStringify(payload);
}

function jstDate(ts: number): string {
  assertSafeInteger(ts, "timestamp");
  return new Date((ts + JST_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

function jstDateStart(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new CasinoMetricsError("ERR_METRIC_BAD_DATE", { date });
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ts = Math.floor(Date.UTC(y, mo - 1, d, -9, 0, 0) / 1000);
  if (jstDate(ts) !== date) throw new CasinoMetricsError("ERR_METRIC_BAD_DATE", { date });
  return ts;
}

function addJstDays(date: string, days: number): string {
  assertSafeInteger(days, "days");
  const delta = days * DAY_SEC;
  if (!Number.isSafeInteger(delta)) throw new CasinoMetricsError("ERR_METRIC_BAD_NUMBER", { field: "day_delta", days });
  return jstDate(checkedAdd(jstDateStart(date), delta, "jst_date_add"));
}

function bps(numerator: number, denominator: number): number | null {
  assertNonNegative(numerator, "bps.numerator");
  assertNonNegative(denominator, "bps.denominator");
  if (denominator === 0) return null;
  const raw = (BigInt(numerator) * 10_000n) / BigInt(denominator);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CasinoMetricsError("ERR_METRIC_BAD_NUMBER", { field: "bps.result", numerator, denominator });
  }
  return Number(raw);
}

function playerIdFromHolder(holder: string | null): string | null {
  if (!holder || !isPlayerHolder(holder)) return null;
  return holder.startsWith("user:") ? holder.slice("user:".length) : holder;
}

function normalize(input: CasinoMetricEventInput, ts: number): CasinoMetricEventRow {
  if (!input.eventKey.trim()) throw new CasinoMetricsError("ERR_METRIC_BAD_KEY", { eventKey: input.eventKey });
  if (!EVENT_TYPES.has(input.eventType)) throw new CasinoMetricsError("ERR_METRIC_EVENT_TYPE", { eventType: input.eventType });
  const occurredAt = input.occurredAt ?? ts;
  assertNonNegative(occurredAt, "occurredAt");
  if (input.wager != null) assertNonNegative(input.wager, "wager");
  if (input.payout != null) assertNonNegative(input.payout, "payout");
  if (input.amount != null) assertNonNegative(input.amount, "amount");
  if (input.net != null) assertSafeInteger(input.net, "net");
  return {
    event_key: input.eventKey,
    event_type: input.eventType,
    user_id: input.userId ?? null,
    game: input.game ?? null,
    source: input.source ?? null,
    operation_id: input.operationId ?? null,
    wager: input.wager ?? null,
    payout: input.payout ?? null,
    net: input.net ?? null,
    amount: input.amount ?? null,
    payload_json: canonicalPayload(input.payload),
    occurred_at: occurredAt,
  };
}

function validateEventRowNumbers(row: CasinoMetricEventRow): void {
  assertNonNegative(row.occurred_at, "stored.occurred_at");
  if (row.wager != null) assertNonNegative(row.wager, "stored.wager");
  if (row.payout != null) assertNonNegative(row.payout, "stored.payout");
  if (row.amount != null) assertNonNegative(row.amount, "stored.amount");
  if (row.net != null) assertSafeInteger(row.net, "stored.net");
}

function parseJsonObject(json: string | null, field: string): Record<string, unknown> {
  if (json == null) throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field, reason: "missing" });
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field, reason: "not_object" });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CasinoMetricsError) throw error;
    throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field, reason: "invalid_json" });
  }
}

function parseCohort(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "revisit_cohort_json", reason: "invalid_json" });
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "revisit_cohort_json", reason: "invalid_cohort" });
  }
  const cohort = parsed as string[];
  if (new Set(cohort).size !== cohort.length) {
    throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "revisit_cohort_json", reason: "duplicate_user" });
  }
  return cohort;
}

function toPublicDaily(row: CasinoMetricDailyStorageRow): CasinoMetricDailyRow {
  return {
    date: row.date,
    play_count: row.play_count,
    unique_users: row.unique_users,
    total_wager: row.total_wager,
    total_payout: row.total_payout,
    house_pnl: row.house_pnl,
    jackpot_delta: row.jackpot_delta,
    fuku_outflow: row.fuku_outflow,
    replay_rate_bps: row.replay_rate_bps,
    revisit_rate_bps: row.revisit_rate_bps,
    updated_at: row.updated_at,
  };
}

export class CasinoMetrics {
  private schemaReady = false;

  constructor(
    private readonly db: Database.Database,
    private readonly chipTx: ChipTx,
    private readonly clock: () => number = nowSec,
  ) {}

  ensureSchema(): boolean {
    if (this.chipTx.openingPhase() !== "formal") return false;
    if (this.schemaReady && tableExists(this.db, "casino_metric_events") && tableExists(this.db, "casino_metric_daily")) {
      this.ensureDailyColumns();
      return true;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_metric_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        user_id TEXT,
        game TEXT,
        source TEXT,
        operation_id TEXT,
        wager INTEGER,
        payout INTEGER,
        net INTEGER,
        amount INTEGER,
        payload_json TEXT,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_casino_metric_events_type_time
        ON casino_metric_events(event_type, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_casino_metric_events_user_time
        ON casino_metric_events(user_id, occurred_at);
      CREATE TABLE IF NOT EXISTS casino_metric_daily (
        date TEXT PRIMARY KEY,
        play_count INTEGER NOT NULL DEFAULT 0,
        unique_users INTEGER NOT NULL DEFAULT 0,
        total_wager INTEGER NOT NULL DEFAULT 0,
        total_payout INTEGER NOT NULL DEFAULT 0,
        house_pnl INTEGER NOT NULL DEFAULT 0,
        table_fee_income INTEGER NOT NULL DEFAULT 0,
        jackpot_delta INTEGER NOT NULL DEFAULT 0,
        fuku_outflow INTEGER NOT NULL DEFAULT 0,
        table_open_count INTEGER NOT NULL DEFAULT 0,
        table_start_count INTEGER NOT NULL DEFAULT 0,
        table_dispute_count INTEGER NOT NULL DEFAULT 0,
        replay_rate_bps INTEGER,
        revisit_rate_bps INTEGER,
        revisit_cohort_json TEXT,
        revisit_finalized_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    this.ensureDailyColumns();
    this.schemaReady = true;
    return true;
  }

  private ensureDailyColumns(): void {
    if (!tableExists(this.db, "casino_metric_daily")) return;
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(casino_metric_daily)").all() as Array<{ name: string }>).map((r) => r.name),
    );
    if (!columns.has("revisit_cohort_json")) this.db.exec("ALTER TABLE casino_metric_daily ADD COLUMN revisit_cohort_json TEXT");
    if (!columns.has("revisit_finalized_at")) this.db.exec("ALTER TABLE casino_metric_daily ADD COLUMN revisit_finalized_at INTEGER");
  }

  record(input: CasinoMetricEventInput): { recorded: boolean; skipped: boolean } {
    const ts = this.clock();
    assertNonNegative(ts, "clock");
    if (!this.ensureSchema()) return { recorded: false, skipped: true };
    const occurredAtExplicit = input.occurredAt !== undefined;
    const row = normalize(input, ts);
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO casino_metric_events
        (event_key, event_type, user_id, game, source, operation_id, wager, payout, net, amount, payload_json, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.event_key,
      row.event_type,
      row.user_id,
      row.game,
      row.source,
      row.operation_id,
      row.wager,
      row.payout,
      row.net,
      row.amount,
      row.payload_json,
      row.occurred_at,
      ts,
    ).changes;
    if (inserted === 1) return { recorded: true, skipped: false };
    const existing = this.db
      .prepare(`SELECT event_key, event_type, user_id, game, source, operation_id, wager, payout, net, amount, payload_json, occurred_at
                FROM casino_metric_events WHERE event_key=?`)
      .get(row.event_key) as CasinoMetricEventRow | undefined;
    if (!existing) throw new CasinoMetricsError("ERR_METRIC_EVENT_CONFLICT", { eventKey: row.event_key });
    validateEventRowNumbers(existing);
    const expected = occurredAtExplicit ? row : { ...row, occurred_at: existing.occurred_at };
    if (canonicalStringify(existing) !== canonicalStringify(expected)) {
      throw new CasinoMetricsError("ERR_METRIC_EVENT_CONFLICT", { eventKey: row.event_key });
    }
    return { recorded: false, skipped: false };
  }

  gameStart(input: { game: string; userId: string; operationId: string; wager: number; source: string; occurredAt?: number }): void {
    this.record({
      eventKey: `game_start:${input.game}:${input.userId}:${input.operationId}`,
      eventType: "game_start",
      userId: input.userId,
      game: input.game,
      source: input.source,
      operationId: input.operationId,
      wager: input.wager,
      payload: { userId: input.userId, game: input.game, operationId: input.operationId, wager: input.wager, source: input.source },
      occurredAt: input.occurredAt,
    });
  }

  gameFinish(input: {
    game: string;
    userId: string;
    operationId: string;
    wager: number;
    payout: number;
    net: number;
    source: string;
    occurredAt?: number;
  }): void {
    this.record({
      eventKey: `game_finish:${input.game}:${input.userId}:${input.operationId}`,
      eventType: "game_finish",
      userId: input.userId,
      game: input.game,
      source: input.source,
      operationId: input.operationId,
      wager: input.wager,
      payout: input.payout,
      net: input.net,
      payload: { userId: input.userId, game: input.game, operationId: input.operationId, wager: input.wager, payout: input.payout, net: input.net, source: input.source },
      occurredAt: input.occurredAt,
    });
  }

  gameAbandon(input: { game: string; userId: string; operationId: string; wager: number; source: string; reason: string; occurredAt?: number }): void {
    this.record({
      eventKey: `game_abandon:${input.game}:${input.userId}:${input.operationId}`,
      eventType: "game_abandon",
      userId: input.userId,
      game: input.game,
      source: input.source,
      operationId: input.operationId,
      wager: input.wager,
      payload: { userId: input.userId, game: input.game, operationId: input.operationId, wager: input.wager, source: input.source, reason: input.reason },
      occurredAt: input.occurredAt,
    });
  }

  replay(input: { game: string; userId: string; operationId: string; wager: number; source: string; occurredAt?: number }): void {
    this.record({
      eventKey: `replay:${input.game}:${input.userId}:${input.operationId}`,
      eventType: "replay",
      userId: input.userId,
      game: input.game,
      source: input.source,
      operationId: input.operationId,
      wager: input.wager,
      payload: { userId: input.userId, game: input.game, operationId: input.operationId, wager: input.wager, source: input.source },
      occurredAt: input.occurredAt,
    });
  }

  syncChipExchangeEvents(retentionDays = RAW_RETENTION_DAYS): number {
    if (!this.ensureSchema()) return 0;
    assertNonNegative(retentionDays, "retentionDays");
    const retentionSec = retentionDays * DAY_SEC;
    if (!Number.isSafeInteger(retentionSec)) throw new CasinoMetricsError("ERR_METRIC_BAD_NUMBER", { field: "retentionSec" });
    const cutoff = checkedAdd(this.clock(), -retentionSec, "chip_sync_cutoff");
    const rows = this.db.prepare(`
      SELECT id, tx_kind, from_holder, to_holder, amount, created_at
      FROM casino_tx
      WHERE opening_version=?
        AND tx_kind IN ('deposit', 'redeem')
        AND amount > 0
        AND created_at >= ?
      ORDER BY id
    `).all(FORMAL_OPENING_VERSION, cutoff) as Array<{
      id: number;
      tx_kind: "deposit" | "redeem";
      from_holder: string | null;
      to_holder: string | null;
      amount: number;
      created_at: number;
    }>;
    let recorded = 0;
    for (const row of rows) {
      assertNonNegative(row.id, "casino_tx.id");
      assertNonNegative(row.amount, "casino_tx.amount");
      assertNonNegative(row.created_at, "casino_tx.created_at");
      const userId = row.tx_kind === "deposit" ? playerIdFromHolder(row.to_holder) : playerIdFromHolder(row.from_holder);
      if (!userId) continue;
      const result = this.record({
        eventKey: `chip_${row.tx_kind}:tx:${row.id}`,
        eventType: row.tx_kind === "deposit" ? "chip_deposit" : "chip_redeem",
        userId,
        amount: row.amount,
        operationId: `tx:${row.id}`,
        payload: { txId: row.id, txKind: row.tx_kind, amount: row.amount },
        occurredAt: row.created_at,
      });
      if (result.recorded) recorded++;
    }
    return recorded;
  }

  synthesizeDailyOnly(date: string): number {
    if (!this.ensureSchema()) return 0;
    const openingAt = this.formalOpeningTimestamp();
    if (date < jstDate(openingAt) || date >= jstDate(this.clock())) return 0;
    const dayStart = jstDateStart(date);
    const start = Math.max(dayStart, openingAt);
    const end = checkedAdd(dayStart, DAY_SEC, "daily_end");
    const claimRows = this.db.prepare(`
      SELECT group_key, actor_id AS user_id, result_json, COALESCE(settled_at, created_at) AS occurred_at
      FROM casino_tx_groups
      WHERE kind='daily'
        AND status='settled'
        AND COALESCE(settled_at, created_at) >= ?
        AND COALESCE(settled_at, created_at) < ?
      ORDER BY group_key
    `).all(start, end) as Array<{ group_key: string; user_id: string; result_json: string | null; occurred_at: number }>;

    const successful = new Map<string, number>();
    for (const row of claimRows) {
      if (!row.user_id || typeof row.user_id !== "string") {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "daily.actor_id", groupKey: row.group_key });
      }
      assertNonNegative(row.occurred_at, "daily.occurred_at");
      const result = parseJsonObject(row.result_json, `daily.result_json:${row.group_key}`);
      if (result.ok === false && result.reason === "ALREADY_CLAIMED") continue;
      if (result.ok !== true) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "daily.result_json", groupKey: row.group_key });
      }
      const claim = result.claim;
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "daily.claim", groupKey: row.group_key });
      }
      const total = (claim as { total?: unknown }).total;
      if (typeof total !== "number") {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "daily.claim.total", groupKey: row.group_key });
      }
      assertNonNegative(total, "daily.claim.total");
      if (!successful.has(row.user_id)) successful.set(row.user_id, row.occurred_at);
    }

    const gameUsers = new Set(
      (this.db.prepare(`
        SELECT DISTINCT user_id FROM casino_metric_events
        WHERE event_type='game_start' AND user_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ?
      `).all(start, end) as Array<{ user_id: string }>).map((r) => r.user_id),
    );

    for (const userId of gameUsers) {
      this.db.prepare("DELETE FROM casino_metric_events WHERE event_key=? AND event_type='daily_only'").run(`daily_only:${date}:${userId}`);
    }

    let recorded = 0;
    for (const [userId, occurredAt] of successful) {
      if (gameUsers.has(userId)) continue;
      const result = this.record({
        eventKey: `daily_only:${date}:${userId}`,
        eventType: "daily_only",
        userId,
        payload: { date, userId },
        occurredAt,
      });
      if (result.recorded) recorded++;
    }
    return recorded;
  }

  rollupDaily(date: string): CasinoMetricDailyRow | null {
    if (!this.ensureSchema()) return null;
    const openingAt = this.formalOpeningTimestamp();
    const openingDate = jstDate(openingAt);
    if (date < openingDate) {
      this.db.prepare("DELETE FROM casino_metric_daily WHERE date=?").run(date);
      return null;
    }

    const existing = this.readDailyStorage(date);
    if (existing?.revisit_finalized_at != null) return toPublicDaily(existing);

    const dayStart = jstDateStart(date);
    const start = Math.max(dayStart, openingAt);
    const end = checkedAdd(dayStart, DAY_SEC, "rollup_end");
    const rawCutoff = checkedAdd(this.clock(), -(RAW_RETENTION_DAYS * DAY_SEC), "raw_cutoff");
    const preserveBase = start < rawCutoff;

    let base: Omit<CasinoMetricDailyRow, "date" | "revisit_rate_bps" | "updated_at">;
    if (preserveBase) {
      if (!existing) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { date, reason: "daily_row_missing_after_raw_window" });
      }
      this.validateDailyStorage(existing);
      base = {
        play_count: existing.play_count,
        unique_users: existing.unique_users,
        total_wager: existing.total_wager,
        total_payout: existing.total_payout,
        house_pnl: existing.house_pnl,
        jackpot_delta: existing.jackpot_delta,
        fuku_outflow: existing.fuku_outflow,
        replay_rate_bps: existing.replay_rate_bps,
      };
    } else {
      const finishRows = this.db.prepare(`
        SELECT user_id, wager, payout
        FROM casino_metric_events
        WHERE event_type='game_finish' AND occurred_at >= ? AND occurred_at < ?
        ORDER BY id
      `).all(start, end) as Array<{ user_id: string | null; wager: number | null; payout: number | null }>;
      const users = new Set<string>();
      const wagers: number[] = [];
      const payouts: number[] = [];
      for (const row of finishRows) {
        if (row.wager == null || row.payout == null) {
          throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { date, reason: "game_finish_amount_missing" });
        }
        assertNonNegative(row.wager, "game_finish.wager");
        assertNonNegative(row.payout, "game_finish.payout");
        wagers.push(row.wager);
        payouts.push(row.payout);
        if (row.user_id != null) users.add(row.user_id);
      }
      assertNonNegative(finishRows.length, "play_count");
      assertNonNegative(users.size, "unique_users");
      const starts = this.countEvents("game_start", start, end);
      const replays = this.countEvents("replay", start, end);
      base = {
        play_count: finishRows.length,
        unique_users: users.size,
        total_wager: checkedAddAll(wagers, "total_wager"),
        total_payout: checkedAddAll(payouts, "total_payout"),
        house_pnl: this.housePnl(start, end),
        jackpot_delta: this.jackpotDelta(start, end),
        fuku_outflow: this.fukuOutflow(start, end),
        replay_rate_bps: bps(replays, starts),
      };
    }

    const cohort = existing?.revisit_cohort_json != null
      ? parseCohort(existing.revisit_cohort_json)
      : this.captureRevisitCohort(start, end);
    const cohortJson = canonicalStringify(cohort);
    const revisitWindowEnd = checkedAdd(end, RAW_RETENTION_DAYS * DAY_SEC, "revisit_window_end");
    let revisitRate: number | null = null;
    let finalizedAt: number | null = null;
    if (this.clock() >= revisitWindowEnd) {
      let returned = 0;
      const later = this.db.prepare(`
        SELECT 1 AS ok FROM casino_metric_events
        WHERE event_type='home_open' AND user_id=? AND occurred_at >= ? AND occurred_at < ?
        LIMIT 1
      `);
      for (const userId of cohort) {
        if (later.get(userId, end, revisitWindowEnd)) returned = checkedAdd(returned, 1, "revisit_returned_count");
      }
      revisitRate = bps(returned, cohort.length);
      finalizedAt = this.clock();
      assertNonNegative(finalizedAt, "revisit_finalized_at");
    }

    const row: CasinoMetricDailyStorageRow = {
      date,
      ...base,
      // 退役した対人順位卓の列。NOT NULL なので 0 を書くだけで、集計は一切しない
      table_fee_income: 0,
      table_open_count: 0,
      table_start_count: 0,
      table_dispute_count: 0,
      revisit_rate_bps: revisitRate,
      revisit_cohort_json: cohortJson,
      revisit_finalized_at: finalizedAt,
      updated_at: this.clock(),
    };
    this.validateDailyStorage(row);
    this.db.prepare(`
      INSERT INTO casino_metric_daily
        (date, play_count, unique_users, total_wager, total_payout, house_pnl, table_fee_income, jackpot_delta,
         fuku_outflow, table_open_count, table_start_count, table_dispute_count, replay_rate_bps, revisit_rate_bps,
         revisit_cohort_json, revisit_finalized_at, updated_at)
      VALUES
        (@date, @play_count, @unique_users, @total_wager, @total_payout, @house_pnl, @table_fee_income, @jackpot_delta,
         @fuku_outflow, @table_open_count, @table_start_count, @table_dispute_count, @replay_rate_bps, @revisit_rate_bps,
         @revisit_cohort_json, @revisit_finalized_at, @updated_at)
      ON CONFLICT(date) DO UPDATE SET
        play_count=excluded.play_count,
        unique_users=excluded.unique_users,
        total_wager=excluded.total_wager,
        total_payout=excluded.total_payout,
        house_pnl=excluded.house_pnl,
        table_fee_income=excluded.table_fee_income,
        jackpot_delta=excluded.jackpot_delta,
        fuku_outflow=excluded.fuku_outflow,
        table_open_count=excluded.table_open_count,
        table_start_count=excluded.table_start_count,
        table_dispute_count=excluded.table_dispute_count,
        replay_rate_bps=excluded.replay_rate_bps,
        revisit_rate_bps=excluded.revisit_rate_bps,
        revisit_cohort_json=excluded.revisit_cohort_json,
        revisit_finalized_at=excluded.revisit_finalized_at,
        updated_at=excluded.updated_at
    `).run(row);
    return toPublicDaily(row);
  }

  runDailyMaintenance(options: { throughDate?: string; maxDays?: number } = {}): {
    skipped: boolean;
    dates: string[];
    chipEvents: number;
    pruned: number;
    reconciledSlots: number;
  } {
    if (!this.ensureSchema()) return { skipped: true, dates: [], chipEvents: 0, pruned: 0, reconciledSlots: 0 };
    const reconciledSlots = this.reconcileSlotsFinishes();
    const chipEvents = this.syncChipExchangeEvents();
    const openingDate = jstDate(this.formalOpeningTimestamp());
    const through = options.throughDate ?? addJstDays(jstDate(this.clock()), -1);
    const maxDays = options.maxDays ?? RAW_RETENTION_DAYS;
    assertNonNegative(maxDays, "maxDays");
    const dates: string[] = [];
    for (let i = maxDays; i >= 0; i--) {
      const date = addJstDays(through, -i);
      if (date < openingDate || date > through) continue;
      this.synthesizeDailyOnly(date);
      this.rollupDaily(date);
      dates.push(date);
    }
    const pruned = this.pruneRaw();
    return { skipped: false, dates, chipEvents, pruned, reconciledSlots };
  }

  pruneRaw(retentionDays = RAW_RETENTION_DAYS): number {
    if (!this.ensureSchema()) return 0;
    assertNonNegative(retentionDays, "retentionDays");
    const retentionSec = retentionDays * DAY_SEC;
    if (!Number.isSafeInteger(retentionSec)) throw new CasinoMetricsError("ERR_METRIC_BAD_NUMBER", { field: "retentionSec" });
    const cutoff = checkedAdd(this.clock(), -retentionSec, "prune_cutoff");
    return this.db.prepare("DELETE FROM casino_metric_events WHERE occurred_at < ?").run(cutoff).changes;
  }

  /**
   * スロットの金融正本から、欠落した game_finish を閉じる。
   * game_start は決して新規作成せず、既存 start の source/wager と settled group result_json、
   * free-spin 永続行だけを使う。推測できない状態は例外で停止する。
   */
  reconcileSlotsFinish(userId: string, operationId: string): boolean {
    if (!this.ensureSchema()) return false;
    const start = this.db.prepare(`
      SELECT user_id, operation_id, wager, source
      FROM casino_metric_events
      WHERE event_type='game_start' AND game='スロット' AND user_id=? AND operation_id=?
      LIMIT 1
    `).get(userId, operationId) as { user_id: string; operation_id: string; wager: number | null; source: string | null } | undefined;
    if (!start) return false;
    if (start.wager == null || !start.source) {
      throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "slots.game_start", userId, operationId });
    }
    assertNonNegative(start.wager, "slots.start.wager");
    const finishKey = `game_finish:スロット:${userId}:${operationId}`;
    const already = this.db.prepare("SELECT 1 AS ok FROM casino_metric_events WHERE event_key=?").get(finishKey);
    if (already) return false;

    const freeRow = tableExists(this.db, "casino_pending_free_spins")
      ? this.db.prepare(`
          SELECT id, spin_no, source_group, status FROM casino_pending_free_spins
          WHERE user_id=? AND operation_id=?
          ORDER BY spin_no
          LIMIT 1
        `).get(userId, operationId) as { id: number; spin_no: number; source_group: string; status: string } | undefined
      : undefined;
    if (freeRow) {
      assertNonNegative(freeRow.id, "slots.free.id");
      assertNonNegative(freeRow.spin_no, "slots.free.spin_no");
      if (!freeRow.source_group?.trim()) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "slots.free.source_group", userId, operationId });
      }
    }
    // 無料スピンが永続化されている場合は、その sourceGroup を有料結果の正本として使う。
    // 行が無い paid-only だけ、元操作のcanonical group keyから復元する。
    const paidGroupKey = freeRow?.source_group ?? `slots:spin:${userId}:${operationId}:paid`;
    const paidGroup = this.chipTx.getGroup(paidGroupKey);
    if (!paidGroup) return false;
    if (paidGroup.status !== "settled" || paidGroup.settled_at == null) {
      throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "slots.paid_group", paidGroupKey });
    }
    assertNonNegative(paidGroup.settled_at, "slots.paid_group.settled_at");
    const paid = this.parseSlotSpin(paidGroup.result_json, "slots.paid_result");

    let payout = this.slotTotalPayout(paid, "slots.paid_total");
    let settledAt = paidGroup.settled_at;
    if (!freeRow) {
      if (paid.pendingFreeSpin != null) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "slots.pending_free_spin", reason: "missing_row", paidGroupKey });
      }
    } else {
      if (paid.pendingFreeSpin == null) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "slots.pending_free_spin", reason: "unexpected_row", paidGroupKey });
      }
      if (freeRow.status !== "settled") return false;
      const freeGroupKey = `slots:spin:${userId}:${operationId}:free:${freeRow.spin_no}`;
      const freeGroup = this.chipTx.getGroup(freeGroupKey);
      if (!freeGroup || freeGroup.status !== "settled" || freeGroup.settled_at == null) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "slots.free_group", freeGroupKey });
      }
      assertNonNegative(freeGroup.settled_at, "slots.free_group.settled_at");
      const free = this.parseSlotSpin(freeGroup.result_json, "slots.free_result");
      payout = checkedAdd(payout, this.slotTotalPayout(free, "slots.free_total"), "slots.aggregate_payout");
      settledAt = freeGroup.settled_at;
    }
    const net = checkedAdd(payout, -start.wager, "slots.aggregate_net");
    this.gameFinish({
      game: "スロット",
      userId,
      operationId,
      wager: start.wager,
      payout,
      net,
      source: start.source,
      occurredAt: settledAt,
    });
    return true;
  }

  reconcileSlotsFinishes(): number {
    if (!this.ensureSchema()) return 0;
    const starts = this.db.prepare(`
      SELECT user_id, operation_id
      FROM casino_metric_events s
      WHERE s.event_type='game_start' AND s.game='スロット'
        AND s.user_id IS NOT NULL AND s.operation_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM casino_metric_events f
          WHERE f.event_key = 'game_finish:スロット:' || s.user_id || ':' || s.operation_id
        )
      ORDER BY s.id
    `).all() as Array<{ user_id: string; operation_id: string }>;
    let reconciled = 0;
    for (const row of starts) {
      if (this.reconcileSlotsFinish(row.user_id, row.operation_id)) {
        reconciled = checkedAdd(reconciled, 1, "slots.reconciled_count");
      }
    }
    return reconciled;
  }

  private parseSlotSpin(json: string | null, field: string): PersistedSlotSpinResult {
    const parsed = parseJsonObject(json, field);
    const payout = parsed.payout;
    const jpWon = parsed.jpWon;
    if (typeof payout !== "number" || typeof jpWon !== "number") {
      throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field, reason: "missing_payout" });
    }
    assertNonNegative(payout, `${field}.payout`);
    assertNonNegative(jpWon, `${field}.jpWon`);
    let chainBonus = 0;
    let fukuTax = 0;
    if (parsed.settled != null) {
      if (typeof parsed.settled !== "object" || Array.isArray(parsed.settled)) {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field, reason: "bad_settled" });
      }
      const settled = parsed.settled as { chainBonus?: unknown; fukuTax?: unknown };
      if (typeof settled.chainBonus !== "number" || typeof settled.fukuTax !== "number") {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field, reason: "bad_settled_amounts" });
      }
      assertNonNegative(settled.chainBonus, `${field}.chainBonus`);
      assertNonNegative(settled.fukuTax, `${field}.fukuTax`);
      chainBonus = settled.chainBonus;
      fukuTax = settled.fukuTax;
    }
    return { payout, jpWon, chainBonus, fukuTax, pendingFreeSpin: parsed.pendingFreeSpin ?? null };
  }

  private slotTotalPayout(result: PersistedSlotSpinResult, field: string): number {
    return checkedAddAll([result.payout, result.jpWon, result.chainBonus, -result.fukuTax], field);
  }

  private countEvents(eventType: CasinoMetricEventType, start: number, end: number): number {
    const n = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_type=? AND occurred_at >= ? AND occurred_at < ?
    `).get(eventType, start, end) as { n: number }).n;
    assertNonNegative(n, `count:${eventType}`);
    return n;
  }

  private housePnl(start: number, end: number): number {
    const rows = this.db.prepare(`
      SELECT t.id, g.kind AS group_kind, t.from_holder, t.to_holder, t.amount
      FROM casino_tx t
      JOIN casino_tx_groups g ON g.group_key=t.group_key
      WHERE g.status='settled'
        AND t.tx_kind='internal_transfer'
        AND t.opening_version=?
        AND t.created_at >= ?
        AND t.created_at < ?
        AND (t.from_holder=? OR t.to_holder=?)
      ORDER BY t.id
    `).all(FORMAL_OPENING_VERSION, start, end, HOUSE_HOLDER, HOUSE_HOLDER) as Array<{
      id: number;
      group_kind: string;
      from_holder: string | null;
      to_holder: string | null;
      amount: number;
    }>;
    let total = 0;
    for (const row of rows) {
      assertNonNegative(row.id, "house_pnl.tx_id");
      assertNonNegative(row.amount, "house_pnl.amount");
      const classified = classifyHousePnlTx(row);
      if (classified.kind === "excluded") continue;
      if (classified.kind === "unclassified") {
        throw new CasinoMetricsError("ERR_METRIC_HOUSE_PNL_UNCLASSIFIED", { chipTxId: row.id, groupKind: row.group_kind });
      }
      assertSafeInteger(classified.amount, "house_pnl.classified_amount");
      total = checkedAdd(total, classified.amount, "house_pnl");
    }
    return total;
  }

  private jackpotDelta(start: number, end: number): number {
    const rows = this.db.prepare(`
      SELECT from_holder, to_holder, amount
      FROM casino_tx
      WHERE opening_version=? AND created_at >= ? AND created_at < ? AND (from_holder=? OR to_holder=?)
    `).all(FORMAL_OPENING_VERSION, start, end, JACKPOT_HOLDER, JACKPOT_HOLDER) as Array<{
      from_holder: string | null;
      to_holder: string | null;
      amount: number;
    }>;
    let total = 0;
    for (const row of rows) {
      assertNonNegative(row.amount, "jackpot_delta.amount");
      const delta = row.to_holder === JACKPOT_HOLDER ? row.amount : row.from_holder === JACKPOT_HOLDER ? -row.amount : 0;
      total = checkedAdd(total, delta, "jackpot_delta");
    }
    return total;
  }

  private fukuOutflow(start: number, end: number): number {
    const rows = this.db.prepare(`
      SELECT t.to_holder, t.amount
      FROM casino_tx t
      JOIN casino_tx_groups g ON g.group_key=t.group_key
      WHERE g.kind='daily'
        AND g.status='settled'
        AND t.tx_kind='internal_transfer'
        AND t.opening_version=?
        AND t.created_at >= ?
        AND t.created_at < ?
        AND t.to_holder IS NOT NULL
    `).all(FORMAL_OPENING_VERSION, start, end) as Array<{ to_holder: string | null; amount: number }>;
    let total = 0;
    for (const row of rows) {
      assertNonNegative(row.amount, "fuku_outflow.amount");
      if (row.to_holder && isPlayerHolder(row.to_holder)) total = checkedAdd(total, row.amount, "fuku_outflow");
    }
    return total;
  }

  private captureRevisitCohort(start: number, end: number): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT user_id FROM casino_metric_events
      WHERE event_type='home_open' AND user_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ?
      ORDER BY user_id
    `).all(start, end) as Array<{ user_id: string }>;
    for (const row of rows) {
      if (!row.user_id || typeof row.user_id !== "string") {
        throw new CasinoMetricsError("ERR_METRIC_BAD_RESULT", { field: "revisit.user_id" });
      }
    }
    return rows.map((r) => r.user_id);
  }

  private formalOpeningTimestamp(): number {
    const row = this.db.prepare(`
      SELECT created_at FROM casino_chip_opening_versions WHERE opening_version=?
    `).get(FORMAL_OPENING_VERSION) as { created_at: number } | undefined;
    if (!row) throw new CasinoMetricsError("ERR_METRIC_BAD_DATE", { reason: "formal_opening_missing" });
    assertNonNegative(row.created_at, "formal_opening.created_at");
    return row.created_at;
  }

  private readDailyStorage(date: string): CasinoMetricDailyStorageRow | undefined {
    return this.db.prepare(`
      SELECT date, play_count, unique_users, total_wager, total_payout, house_pnl, table_fee_income,
             jackpot_delta, fuku_outflow, table_open_count, table_start_count, table_dispute_count,
             replay_rate_bps, revisit_rate_bps, revisit_cohort_json, revisit_finalized_at, updated_at
      FROM casino_metric_daily WHERE date=?
    `).get(date) as CasinoMetricDailyStorageRow | undefined;
  }

  private validateDailyStorage(row: CasinoMetricDailyStorageRow): void {
    assertNonNegative(row.play_count, "daily.play_count");
    assertNonNegative(row.unique_users, "daily.unique_users");
    assertNonNegative(row.total_wager, "daily.total_wager");
    assertNonNegative(row.total_payout, "daily.total_payout");
    assertSafeInteger(row.house_pnl, "daily.house_pnl");
    assertSafeInteger(row.jackpot_delta, "daily.jackpot_delta");
    assertNonNegative(row.fuku_outflow, "daily.fuku_outflow");
    if (row.replay_rate_bps != null) assertNonNegative(row.replay_rate_bps, "daily.replay_rate_bps");
    if (row.revisit_rate_bps != null) assertNonNegative(row.revisit_rate_bps, "daily.revisit_rate_bps");
    if (row.revisit_finalized_at != null) assertNonNegative(row.revisit_finalized_at, "daily.revisit_finalized_at");
    assertNonNegative(row.updated_at, "daily.updated_at");
    if (row.revisit_cohort_json != null) parseCohort(row.revisit_cohort_json);
  }
}

export const casinoMetricDateForTesting = { jstDate, jstDateStart, addJstDays };
export const casinoMetricArithmeticForTesting = { checkedAddAll, bps };
