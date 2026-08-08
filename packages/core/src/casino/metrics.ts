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
  "table_open",
  "table_join",
  "table_start",
  "table_settle",
  "table_dispute",
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
  table_fee_income: number;
  jackpot_delta: number;
  fuku_outflow: number;
  table_open_count: number;
  table_start_count: number;
  table_dispute_count: number;
  replay_rate_bps: number | null;
  revisit_rate_bps: number | null;
  updated_at: number;
}

const EVENT_TYPES = new Set<string>(CASINO_METRIC_EVENT_TYPES);
const DAY_SEC = 86_400;
const JST_OFFSET_SEC = 9 * 60 * 60;

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
  return jstDate(jstDateStart(date) + days * DAY_SEC);
}

function bps(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.floor((numerator * 10_000) / denominator);
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
        updated_at INTEGER NOT NULL
      );
    `);
    this.schemaReady = true;
    return true;
  }

  record(input: CasinoMetricEventInput): { recorded: boolean; skipped: boolean } {
    const ts = this.clock();
    if (!this.ensureSchema()) return { recorded: false, skipped: true };
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
    if (!existing || canonicalStringify(existing) !== canonicalStringify(row)) {
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

  syncChipExchangeEvents(): number {
    if (!this.ensureSchema()) return 0;
    const rows = this.db.prepare(`
      SELECT id, tx_kind, from_holder, to_holder, amount, created_at
      FROM casino_tx
      WHERE opening_version=?
        AND tx_kind IN ('deposit', 'redeem')
        AND amount > 0
      ORDER BY id
    `).all(FORMAL_OPENING_VERSION) as Array<{
      id: number;
      tx_kind: "deposit" | "redeem";
      from_holder: string | null;
      to_holder: string | null;
      amount: number;
      created_at: number;
    }>;
    let recorded = 0;
    for (const row of rows) {
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
    if (date >= jstDate(this.clock())) return 0;
    const start = jstDateStart(date);
    const end = start + DAY_SEC;
    const claimRows = this.db.prepare(`
      SELECT DISTINCT g.actor_id AS user_id, COALESCE(g.settled_at, g.created_at) AS occurred_at
      FROM casino_tx_groups g
      JOIN casino_tx t ON t.group_key=g.group_key
      WHERE g.kind='daily'
        AND g.status='settled'
        AND t.opening_version=?
        AND t.tx_kind='internal_transfer'
        AND t.to_holder IS NOT NULL
        AND t.amount > 0
        AND COALESCE(g.settled_at, g.created_at) >= ?
        AND COALESCE(g.settled_at, g.created_at) < ?
    `).all(FORMAL_OPENING_VERSION, start, end) as Array<{ user_id: string; occurred_at: number }>;
    const gameUsers = new Set(
      (this.db.prepare(`
        SELECT DISTINCT user_id FROM casino_metric_events
        WHERE event_type='game_start' AND user_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ?
      `).all(start, end) as Array<{ user_id: string }>).map((r) => r.user_id),
    );
    let recorded = 0;
    for (const row of claimRows) {
      const userId = playerIdFromHolder(row.user_id) ?? row.user_id;
      if (!userId || gameUsers.has(userId)) continue;
      const result = this.record({
        eventKey: `daily_only:${date}:${userId}`,
        eventType: "daily_only",
        userId,
        payload: { date, userId },
        occurredAt: row.occurred_at,
      });
      if (result.recorded) recorded++;
    }
    return recorded;
  }

  rollupDaily(date: string): CasinoMetricDailyRow | null {
    if (!this.ensureSchema()) return null;
    const start = jstDateStart(date);
    const end = start + DAY_SEC;
    const game = this.db.prepare(`
      SELECT COUNT(*) AS play_count,
             COUNT(DISTINCT user_id) AS unique_users,
             COALESCE(SUM(wager), 0) AS total_wager,
             COALESCE(SUM(payout), 0) AS total_payout
      FROM casino_metric_events
      WHERE event_type='game_finish' AND occurred_at >= ? AND occurred_at < ?
    `).get(start, end) as Pick<CasinoMetricDailyRow, "play_count" | "unique_users" | "total_wager" | "total_payout">;
    const starts = this.countEvents("game_start", start, end);
    const replays = this.countEvents("replay", start, end);
    const row: CasinoMetricDailyRow = {
      date,
      play_count: game.play_count,
      unique_users: game.unique_users,
      total_wager: game.total_wager,
      total_payout: game.total_payout,
      house_pnl: this.housePnl(start, end),
      table_fee_income: 0,
      jackpot_delta: this.jackpotDelta(start, end),
      fuku_outflow: this.fukuOutflow(start, end),
      table_open_count: this.countEvents("table_open", start, end),
      table_start_count: this.countEvents("table_start", start, end),
      table_dispute_count: this.countEvents("table_dispute", start, end),
      replay_rate_bps: bps(replays, starts),
      revisit_rate_bps: this.revisitRateBps(date),
      updated_at: this.clock(),
    };
    this.db.prepare(`
      INSERT INTO casino_metric_daily
        (date, play_count, unique_users, total_wager, total_payout, house_pnl, table_fee_income, jackpot_delta,
         fuku_outflow, table_open_count, table_start_count, table_dispute_count, replay_rate_bps, revisit_rate_bps, updated_at)
      VALUES
        (@date, @play_count, @unique_users, @total_wager, @total_payout, @house_pnl, @table_fee_income, @jackpot_delta,
         @fuku_outflow, @table_open_count, @table_start_count, @table_dispute_count, @replay_rate_bps, @revisit_rate_bps, @updated_at)
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
        updated_at=excluded.updated_at
    `).run(row);
    return row;
  }

  runDailyMaintenance(options: { throughDate?: string; maxDays?: number } = {}): { skipped: boolean; dates: string[]; chipEvents: number; pruned: number } {
    if (!this.ensureSchema()) return { skipped: true, dates: [], chipEvents: 0, pruned: 0 };
    const chipEvents = this.syncChipExchangeEvents();
    const through = options.throughDate ?? addJstDays(jstDate(this.clock()), -1);
    const maxDays = options.maxDays ?? 90;
    const dates: string[] = [];
    for (let i = maxDays - 1; i >= 0; i--) {
      const date = addJstDays(through, -i);
      if (date > through) continue;
      this.synthesizeDailyOnly(date);
      this.rollupDaily(date);
      dates.push(date);
    }
    const pruned = this.pruneRaw();
    return { skipped: false, dates, chipEvents, pruned };
  }

  pruneRaw(retentionDays = 90): number {
    if (!this.ensureSchema()) return 0;
    return this.db.prepare("DELETE FROM casino_metric_events WHERE occurred_at < ?").run(this.clock() - retentionDays * DAY_SEC).changes;
  }

  private countEvents(eventType: CasinoMetricEventType, start: number, end: number): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_type=? AND occurred_at >= ? AND occurred_at < ?
    `).get(eventType, start, end) as { n: number }).n;
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
      const classified = classifyHousePnlTx(row);
      if (classified.kind === "excluded") continue;
      if (classified.kind === "unclassified") {
        throw new CasinoMetricsError("ERR_METRIC_HOUSE_PNL_UNCLASSIFIED", { chipTxId: row.id, groupKind: row.group_kind });
      }
      total += classified.amount;
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
    return rows.reduce((sum, row) => sum + (row.to_holder === JACKPOT_HOLDER ? row.amount : row.from_holder === JACKPOT_HOLDER ? -row.amount : 0), 0);
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
    return rows.reduce((sum, row) => sum + (row.to_holder && isPlayerHolder(row.to_holder) ? row.amount : 0), 0);
  }

  private revisitRateBps(date: string): number | null {
    const start = jstDateStart(date);
    const end = start + DAY_SEC;
    const laterStart = end;
    const laterEnd = end + 90 * DAY_SEC;
    const users = (this.db.prepare(`
      SELECT DISTINCT user_id FROM casino_metric_events
      WHERE event_type='home_open' AND user_id IS NOT NULL AND occurred_at >= ? AND occurred_at < ?
    `).all(start, end) as Array<{ user_id: string }>).map((r) => r.user_id);
    if (users.length === 0) return null;
    const later = this.db.prepare(`
      SELECT 1 AS ok FROM casino_metric_events
      WHERE event_type='home_open' AND user_id=? AND occurred_at >= ? AND occurred_at < ?
      LIMIT 1
    `);
    let returned = 0;
    for (const userId of users) {
      if (later.get(userId, laterStart, laterEnd)) returned++;
    }
    return bps(returned, users.length);
  }
}

export const casinoMetricDateForTesting = { jstDate, jstDateStart, addJstDays };
