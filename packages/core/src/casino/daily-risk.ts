import type Database from "better-sqlite3";
import type { Ledger } from "../ledger/service.js";
import { canonicalStringify } from "./opening-canonical.js";
import type { CasinoChipAssets } from "./chip-assets.js";
import type { OpeningPhase } from "./chip-tx.js";

export type DailyRiskSourceKind =
  | "solo_result"
  | "solo_extra_loss"
  | "solo_bonus"
  | "table_fee"
  | "table_result"
  | "table_fee_refund";

export type DailyRiskErrorCode =
  | "ERR_DAILY_RISK_UNAVAILABLE"
  | "ERR_DAILY_RISK_BAD_SETTING"
  | "ERR_DAILY_RISK_LIMIT"
  | "ERR_DAILY_RISK_OPERATION_CONFLICT"
  | "ERR_DAILY_RISK_EVENT_CONFLICT";

export class DailyRiskError extends Error {
  constructor(
    readonly code: DailyRiskErrorCode,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DailyRiskError";
  }
}

export interface DailyRiskOptions {
  now?: () => number;
  openingPhase?: () => OpeningPhase;
  dailyLossLimitBps?: () => number;
  boundaryOffsetMinutes?: () => number;
}

export interface DailyRiskDay {
  userId: string;
  dayKey: string;
  dayStartAt: number;
  openingHoldings: number;
  limitBps: number;
  lossCap: number;
  netSigned: number;
  remainingLossBudget: number;
}

export interface DailyRiskSoloStart {
  userId: string;
  operationId: string;
  dayKey: string;
  maxPlayerLoss: number;
}

export interface DailyRiskTableExposure {
  userId: string;
  dayKey: string;
  maxPlayerLoss: number;
}

const DEFAULT_DAILY_LOSS_LIMIT_BPS = 3_000;
const DEFAULT_BOUNDARY_OFFSET_MINUTES = 540;
const MIN_BOUNDARY_OFFSET_MINUTES = -720;
const MAX_BOUNDARY_OFFSET_MINUTES = 840;
const DAY_SEC = 24 * 60 * 60;

export class DailyRisk {
  private readonly now: () => number;
  private readonly openingPhase: () => OpeningPhase;
  private readonly dailyLossLimitBps: () => number;
  private readonly boundaryOffsetMinutes: () => number;

  constructor(
    private readonly db: Database.Database,
    private readonly land: Ledger,
    private readonly chipAssets: CasinoChipAssets,
    options: DailyRiskOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.openingPhase = options.openingPhase ?? (() => "formal");
    this.dailyLossLimitBps = options.dailyLossLimitBps ?? (() => DEFAULT_DAILY_LOSS_LIMIT_BPS);
    this.boundaryOffsetMinutes = options.boundaryOffsetMinutes ?? (() => DEFAULT_BOUNDARY_OFFSET_MINUTES);
  }

  ensureSchemaForTesting(): void {
    this.ensureSchema();
  }

  holdings(userId: string): number {
    const accountId = `user:${requiredString(userId, "userId")}`;
    return checkedAdd(this.land.balanceOf(accountId), this.chipAssets.freeChips(userId), "holdings");
  }

  dayFor(userId: string, at = this.now()): DailyRiskDay {
    this.assertFormal();
    this.ensureSchema();
    const safeUserId = requiredString(userId, "userId");
    const day = this.dayKey(at);
    this.ensureDay(safeUserId, day.dayKey, day.startAt);
    return this.readDay(safeUserId, day.dayKey);
  }

  remainingLossBudget(userId: string, at = this.now()): number {
    return this.dayFor(userId, at).remainingLossBudget;
  }

  maxBetForPlayerLoss(userId: string, lossPerBet: (bet: number) => number, cap: number, at = this.now()): number {
    const maxLoss = Math.min(cap, this.remainingLossBudget(userId, at));
    if (!Number.isSafeInteger(maxLoss) || maxLoss < 0) return 0;
    let lo = 0;
    let hi = Math.max(1, Math.floor(cap));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi + 1) / 2);
      if (lossPerBet(mid) <= maxLoss) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  authorizeSoloStart(input: {
    userId: string;
    operationId: string;
    game: string;
    bet: number;
    maxPlayerLoss: number;
  }): DailyRiskSoloStart {
    const userId = requiredString(input.userId, "userId");
    const operationId = requiredString(input.operationId, "operationId");
    const game = requiredString(input.game, "game");
    const bet = nonnegativeInt(input.bet, "bet");
    const maxPlayerLoss = nonnegativeInt(input.maxPlayerLoss, "maxPlayerLoss");
    const fingerprint = canonicalStringify({ userId, operationId, game, bet, maxPlayerLoss });
    const tx = this.db.transaction(() => {
      this.assertFormal();
      this.ensureSchema();
      const replay = this.db
        .prepare("SELECT user_id, operation_id, day_key, max_player_loss, request_fingerprint FROM casino_solo_risk_starts WHERE operation_id=?")
        .get(operationId) as
        | { user_id: string; operation_id: string; day_key: string; max_player_loss: number; request_fingerprint: string }
        | undefined;
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) {
          throw new DailyRiskError("ERR_DAILY_RISK_OPERATION_CONFLICT", "solo risk start operation replay conflict", {
            operationId,
          });
        }
        return { userId: replay.user_id, operationId: replay.operation_id, dayKey: replay.day_key, maxPlayerLoss: replay.max_player_loss };
      }
      const day = this.dayFor(userId);
      this.assertProspective(day, maxPlayerLoss);
      this.db
        .prepare(
          `INSERT INTO casino_solo_risk_starts
             (operation_id, user_id, day_key, game, bet, max_player_loss, request_fingerprint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(operationId, userId, day.dayKey, game, bet, maxPlayerLoss, fingerprint, this.now());
      return { userId, operationId, dayKey: day.dayKey, maxPlayerLoss };
    });
    return tx.immediate();
  }

  recordSoloResult(input: { userId: string; operationId: string; netSigned: number }): void {
    const userId = requiredString(input.userId, "userId");
    const operationId = requiredString(input.operationId, "operationId");
    const start = this.soloStart(operationId);
    if (!start) return;
    if (start.userId !== userId) {
      throw new DailyRiskError("ERR_DAILY_RISK_OPERATION_CONFLICT", "solo risk start user mismatch", { operationId, userId });
    }
    this.recordEvent({
      eventKey: `solo_result:${operationId}`,
      userId,
      dayKey: start.dayKey,
      sourceKind: "solo_result",
      sourceId: operationId,
      operationId,
      netSigned: input.netSigned,
    });
  }

  recordSoloExtraLoss(input: { userId: string; operationId: string; netSigned: number }): void {
    const userId = requiredString(input.userId, "userId");
    const operationId = requiredString(input.operationId, "operationId");
    const start = this.soloStart(operationId);
    if (!start) return;
    this.recordEvent({
      eventKey: `solo_extra_loss:${operationId}`,
      userId,
      dayKey: start.dayKey,
      sourceKind: "solo_extra_loss",
      sourceId: operationId,
      operationId,
      netSigned: input.netSigned,
    });
  }

  authorizeTableJoin(input: {
    userId: string;
    operationId: string;
    tableId: string;
    baseAmount: number;
    feePerUser: number;
  }): DailyRiskTableExposure {
    const userId = requiredString(input.userId, "userId");
    const operationId = requiredString(input.operationId, "operationId");
    const tableId = requiredString(input.tableId, "tableId");
    const baseAmount = positiveInt(input.baseAmount, "baseAmount");
    const feePerUser = nonnegativeInt(input.feePerUser, "feePerUser");
    const maxPlayerLoss = checkedAdd(baseAmount, feePerUser, "tableMaxLoss");
    const fingerprint = canonicalStringify({ userId, operationId, tableId, baseAmount, feePerUser, maxPlayerLoss });
    const tx = this.db.transaction(() => {
      this.assertFormal();
      this.ensureSchema();
      const day = this.dayFor(userId);
      const holdings = this.holdings(userId);
      if (maxPlayerLoss > 0 && holdings < maxPlayerLoss * 2) {
        throw new DailyRiskError("ERR_DAILY_RISK_LIMIT", "ranked join requires at least 50% holdings coverage", {
          userId,
          holdings,
          required: maxPlayerLoss * 2,
          maxPlayerLoss,
        });
      }
      this.assertProspective(day, maxPlayerLoss);
      const eventKey = `table_join_risk:${tableId}:${userId}:${operationId}`;
      const existing = this.db
        .prepare("SELECT payload_fingerprint FROM casino_daily_risk_events WHERE event_key=?")
        .get(eventKey) as { payload_fingerprint: string } | undefined;
      if (existing && existing.payload_fingerprint !== fingerprint) {
        throw new DailyRiskError("ERR_DAILY_RISK_EVENT_CONFLICT", "table join risk replay conflict", { eventKey });
      }
      return { userId, dayKey: day.dayKey, maxPlayerLoss };
    });
    return tx.immediate();
  }

  recordEvent(input: {
    eventKey: string;
    userId: string;
    dayKey: string;
    sourceKind: DailyRiskSourceKind;
    sourceId: string;
    operationId: string;
    netSigned: number;
  }): void {
    const eventKey = requiredString(input.eventKey, "eventKey");
    const userId = requiredString(input.userId, "userId");
    const dayKey = requiredString(input.dayKey, "dayKey");
    const sourceKind = input.sourceKind;
    const sourceId = requiredString(input.sourceId, "sourceId");
    const operationId = requiredString(input.operationId, "operationId");
    const netSigned = signedInt(input.netSigned, "netSigned");
    if (netSigned === 0) return;
    const fingerprint = canonicalStringify({ eventKey, userId, dayKey, sourceKind, sourceId, operationId, netSigned });
    this.assertFormal();
    this.ensureSchema();
    this.ensureDay(userId, dayKey, this.dayStartFromKey(dayKey));
    const existing = this.db
      .prepare("SELECT payload_fingerprint FROM casino_daily_risk_events WHERE event_key=?")
      .get(eventKey) as { payload_fingerprint: string } | undefined;
    if (existing) {
      if (existing.payload_fingerprint === fingerprint) return;
      throw new DailyRiskError("ERR_DAILY_RISK_EVENT_CONFLICT", "daily risk event key replayed with different payload", { eventKey });
    }
    this.db
      .prepare(
        `INSERT INTO casino_daily_risk_events
           (event_key, user_id, day_key, source_kind, source_id, operation_id, net_signed, payload_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(eventKey, userId, dayKey, sourceKind, sourceId, operationId, netSigned, fingerprint, this.now());
    this.refreshDayNet(userId, dayKey);
  }

  private assertProspective(day: DailyRiskDay, maxPlayerLoss: number): void {
    if (day.netSigned - maxPlayerLoss < -day.lossCap) {
      throw new DailyRiskError("ERR_DAILY_RISK_LIMIT", "daily casino loss limit would be exceeded", {
        userId: day.userId,
        dayKey: day.dayKey,
        netSigned: day.netSigned,
        maxPlayerLoss,
        lossCap: day.lossCap,
      });
    }
  }

  private soloStart(operationId: string): DailyRiskSoloStart | null {
    this.assertFormal();
    this.ensureSchema();
    const row = this.db
      .prepare("SELECT operation_id, user_id, day_key, max_player_loss FROM casino_solo_risk_starts WHERE operation_id=?")
      .get(operationId) as { operation_id: string; user_id: string; day_key: string; max_player_loss: number } | undefined;
    return row ? { operationId: row.operation_id, userId: row.user_id, dayKey: row.day_key, maxPlayerLoss: row.max_player_loss } : null;
  }

  private readDay(userId: string, dayKey: string): DailyRiskDay {
    const row = this.db
      .prepare("SELECT * FROM casino_daily_risk_days WHERE user_id=? AND day_key=?")
      .get(userId, dayKey) as
      | {
          user_id: string;
          day_key: string;
          day_start_at: number;
          opening_holdings: number;
          limit_bps: number;
          loss_cap: number;
          net_signed: number;
        }
      | undefined;
    if (!row) throw new DailyRiskError("ERR_DAILY_RISK_UNAVAILABLE", "daily risk day was not created", { userId, dayKey });
    const remainingLossBudget = Math.max(0, row.loss_cap + row.net_signed);
    return {
      userId: row.user_id,
      dayKey: row.day_key,
      dayStartAt: row.day_start_at,
      openingHoldings: row.opening_holdings,
      limitBps: row.limit_bps,
      lossCap: row.loss_cap,
      netSigned: row.net_signed,
      remainingLossBudget,
    };
  }

  private ensureDay(userId: string, dayKey: string, dayStartAt: number): void {
    const existing = this.db.prepare("SELECT 1 FROM casino_daily_risk_days WHERE user_id=? AND day_key=?").get(userId, dayKey);
    if (existing) return;
    const bps = this.validatedLimitBps();
    const openingHoldings = this.reconstructHoldingsAt(userId, dayStartAt);
    const lossCap = Math.floor((openingHoldings * bps) / 10_000);
    this.db
      .prepare(
        `INSERT INTO casino_daily_risk_days
           (user_id, day_key, day_start_at, opening_holdings, limit_bps, loss_cap, net_signed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(userId, dayKey, dayStartAt, openingHoldings, bps, lossCap, this.now(), this.now());
  }

  private refreshDayNet(userId: string, dayKey: string): void {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(net_signed), 0) AS s FROM casino_daily_risk_events WHERE user_id=? AND day_key=?")
      .get(userId, dayKey) as { s: number };
    this.db.prepare("UPDATE casino_daily_risk_days SET net_signed=?, updated_at=? WHERE user_id=? AND day_key=?").run(row.s, this.now(), userId, dayKey);
  }

  private reconstructHoldingsAt(userId: string, at: number): number {
    const landNow = this.land.balanceOf(`user:${userId}`);
    const landDelta = this.netLandSince(`user:${userId}`, at);
    const chipsNow = this.chipAssets.freeChips(userId);
    const chipDelta = this.netChipsSince(userId, at);
    return checkedAdd(landNow - landDelta, chipsNow - chipDelta, "openingHoldings");
  }

  private netLandSince(accountId: string, at: number): number {
    const rows = this.db
      .prepare(
        `SELECT from_account, to_account, amount
           FROM transactions
          WHERE created_at >= ? AND (from_account=? OR to_account=?)`,
      )
      .all(at, accountId, accountId) as Array<{ from_account: string; to_account: string; amount: number }>;
    return rows.reduce((sum, row) => sum + (row.to_account === accountId ? row.amount : 0) - (row.from_account === accountId ? row.amount : 0), 0);
  }

  private netChipsSince(userId: string, at: number): number {
    const rows = this.db
      .prepare(
        `SELECT from_holder, to_holder, amount
           FROM casino_tx
          WHERE created_at >= ? AND (from_holder=? OR to_holder=?)`,
      )
      .all(at, userId, userId) as Array<{ from_holder: string | null; to_holder: string | null; amount: number }>;
    return rows.reduce((sum, row) => sum + (row.to_holder === userId ? row.amount : 0) - (row.from_holder === userId ? row.amount : 0), 0);
  }

  private dayKey(at: number): { dayKey: string; startAt: number } {
    const offsetSec = this.validatedBoundaryOffsetMinutes() * 60;
    const shifted = at - offsetSec;
    const index = Math.floor(shifted / DAY_SEC);
    const startAt = index * DAY_SEC + offsetSec;
    return { dayKey: String(index), startAt };
  }

  private dayStartFromKey(dayKey: string): number {
    const index = Number(dayKey);
    if (!Number.isSafeInteger(index)) throw new DailyRiskError("ERR_DAILY_RISK_UNAVAILABLE", "daily risk day key is invalid", { dayKey });
    return index * DAY_SEC + this.validatedBoundaryOffsetMinutes() * 60;
  }

  private validatedLimitBps(): number {
    const bps = this.dailyLossLimitBps();
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
      throw new DailyRiskError("ERR_DAILY_RISK_BAD_SETTING", "casino_daily_loss_limit_bps must be 0..10000", { bps });
    }
    return bps;
  }

  private validatedBoundaryOffsetMinutes(): number {
    const value = this.boundaryOffsetMinutes();
    if (!Number.isSafeInteger(value) || value < MIN_BOUNDARY_OFFSET_MINUTES || value > MAX_BOUNDARY_OFFSET_MINUTES) {
      throw new DailyRiskError("ERR_DAILY_RISK_BAD_SETTING", "casino_daily_boundary_offset_minutes is out of range", { value });
    }
    return value;
  }

  private assertFormal(): void {
    if (this.openingPhase() !== "formal") {
      throw new DailyRiskError("ERR_DAILY_RISK_UNAVAILABLE", "daily casino risk is only available after formal opening");
    }
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_daily_risk_days (
        user_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        day_start_at INTEGER NOT NULL,
        opening_holdings INTEGER NOT NULL CHECK(opening_holdings >= 0),
        limit_bps INTEGER NOT NULL CHECK(limit_bps >= 0 AND limit_bps <= 10000),
        loss_cap INTEGER NOT NULL CHECK(loss_cap >= 0),
        net_signed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, day_key)
      );
      CREATE TABLE IF NOT EXISTS casino_daily_risk_events (
        event_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        net_signed INTEGER NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id, day_key) REFERENCES casino_daily_risk_days(user_id, day_key)
      );
      CREATE INDEX IF NOT EXISTS idx_casino_daily_risk_events_user_day ON casino_daily_risk_events(user_id, day_key);
      CREATE TABLE IF NOT EXISTS casino_solo_risk_starts (
        operation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        game TEXT NOT NULL,
        bet INTEGER NOT NULL CHECK(bet >= 0),
        max_player_loss INTEGER NOT NULL CHECK(max_player_loss >= 0),
        request_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id, day_key) REFERENCES casino_daily_risk_days(user_id, day_key)
      );
    `);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DailyRiskError("ERR_DAILY_RISK_OPERATION_CONFLICT", "daily risk string field is invalid", { field });
  }
  return value;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new DailyRiskError("ERR_DAILY_RISK_OPERATION_CONFLICT", "daily risk positive integer field is invalid", { field, value });
  }
  return value;
}

function nonnegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DailyRiskError("ERR_DAILY_RISK_OPERATION_CONFLICT", "daily risk integer field is invalid", { field, value });
  }
  return value;
}

function signedInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DailyRiskError("ERR_DAILY_RISK_OPERATION_CONFLICT", "daily risk signed integer field is invalid", { field, value });
  }
  return value;
}

function checkedAdd(a: number, b: number, field: string): number {
  const total = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(total) || total < 0) {
    throw new DailyRiskError("ERR_DAILY_RISK_UNAVAILABLE", "daily risk arithmetic overflow", { field, a, b });
  }
  return total;
}
