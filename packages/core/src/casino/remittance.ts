import type Database from "better-sqlite3";
import type { Settings } from "../settings/service.js";
import { Ledger, TREASURY, type TransferResult } from "../ledger/service.js";
import { canonicalHash } from "./opening-canonical.js";
import { CASINO_DEPARTMENT_ACCOUNT } from "./opening-plan.js";
import { readCasinoOpeningConfig, type CasinoOpeningConfig } from "./opening-settings.js";
import { ChipLedger, HOUSE_HOLDER } from "./chip-ledger.js";
import { HouseReservations } from "./reservations.js";
import { FORMAL_OPENING_VERSION } from "./chip-tx.js";
const REMITTANCE_GROUP_PREFIX = "casino:remittance:";
const BAILOUT_GROUP_PREFIX = "casino:bailout:";

const OPERATING_HOUSE_GROUPS = new Set([
  "solo_game",
  "daily",
  "vip",
  "shop",
  "table_start",
  "table_settle",
]);

const EXCLUDED_HOUSE_GROUPS = new Set([
  "refund",
  "table_refund",
  "market_bet",
  "market_settle",
  "deposit",
  "redeem",
  "opening_reset",
  "remittance",
  "bailout",
]);

export type RemittanceStatus = "draft" | "approved" | "executed" | "rejected";
export type RemittanceKind = "remittance" | "bailout";

export type CasinoRemittanceErrorCode =
  | "ERR_BAD_IDENTIFIER"
  | "ERR_BAD_AMOUNT"
  | "ERR_BAD_REASON"
  | "ERR_BAD_PERIOD"
  | "ERR_CASINO_OPENING_NOT_COMPLETE"
  | "ERR_OPENING_CONFIG_REQUIRED"
  | "ERR_FUKU_RESERVE_UNCONFIGURED"
  | "ERR_FUKU_RESERVE_INVALID"
  | "ERR_REMITTANCE_PERIOD_LOCKED"
  | "ERR_UNCLASSIFIED_HOUSE_TX"
  | "ERR_CORRUPT_STATE"
  | "ERR_NOT_DRAFT"
  | "ERR_NOT_APPROVED"
  | "ERR_SECOND_APPROVER_REQUIRED"
  | "ERR_APPROVAL_RACE"
  | "ERR_EXECUTE_RACE"
  | "ERR_REJECT_RACE"
  | "ERR_PLAN_STALE"
  | "ERR_LEDGER_IDEMPOTENCY_CONFLICT";

export class CasinoRemittanceError extends Error {
  constructor(
    readonly code: CasinoRemittanceErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "CasinoRemittanceError";
  }
}

export interface HousePnlRow {
  id: number;
  period: string;
  amount: number;
  sourceTxId: number;
  chipGroupKey: string;
  groupKind: string;
  createdAt: number;
}

export interface RemittanceSnapshot {
  kind: "remittance";
  period: string;
  remitRateBps: number;
  minimumWorkingCapital: number;
  fukuReserve: number;
  cumulativeRealizedProfit: number;
  executedRemittances: number;
  cumulativeUndisposedProfit: number;
  houseBalance: number;
  reservedObligations: number;
  reservationFingerprint: string;
  latestChipTxId: number;
  surplus: number;
  base: number;
  amount: number;
}

export interface BailoutSnapshot {
  kind: "bailout";
  period: string;
  amount: number;
  minimumWorkingCapital: number;
  houseBalance: number;
  reservedObligations: number;
  reservationFingerprint: string;
  latestChipTxId: number;
  settleableHouse: number;
  gapToMinimumWorkingCapital: number;
}

export type RemittancePlanSnapshot = RemittanceSnapshot | BailoutSnapshot;

export interface RemittanceRow {
  id: number;
  key: string;
  kind: RemittanceKind;
  period: string;
  amount: number;
  status: RemittanceStatus;
  planHash: string;
  snapshot: RemittancePlanSnapshot;
  reason: string | null;
  createdBy: string;
  createdAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  rejectedBy: string | null;
  rejectedAt: number | null;
  rejectionReason: string | null;
  executedBy: string | null;
  executedAt: number | null;
  landTxId: number | null;
  chipGroupKey: string | null;
}

export interface CasinoRemittanceOptions {
  /**
   * 福分け準備金の正本を返すadapter。
   * 現在mainには設定キー/算出元が無いため、本番で未指定のままなら納付draftをfail-closedする。
   * PR14内で0固定・新settingsキー・暗黙の推測を作らない。
   */
  fukuReserve?: () => number | null;
  /** テスト用。productionは省略してDate.now()を使う。 */
  now?: () => number;
}

interface HouseChipTx {
  id: number;
  group_key: string;
  group_kind: string;
  from_holder: string | null;
  to_holder: string | null;
  amount: number;
  created_at: number;
  opening_version: string;
}

interface PersistedRow {
  id: unknown;
  key: unknown;
  kind: unknown;
  period: unknown;
  amount: unknown;
  status: unknown;
  plan_hash: unknown;
  snapshot_json: unknown;
  reason: unknown;
  created_by: unknown;
  created_at: unknown;
  approved_by: unknown;
  approved_at: unknown;
  rejected_by: unknown;
  rejected_at: unknown;
  rejection_reason: unknown;
  executed_by: unknown;
  executed_at: unknown;
  land_tx_id: unknown;
  chip_group_key: unknown;
}

function assertSafeNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CasinoRemittanceError("ERR_BAD_AMOUNT", { field, value });
  }
  return value;
}

function assertSafePositive(value: unknown, field: string): number {
  const n = assertSafeNonNegative(value, field);
  if (n === 0) throw new CasinoRemittanceError("ERR_BAD_AMOUNT", { field, value });
  return n;
}

function assertIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CasinoRemittanceError("ERR_BAD_IDENTIFIER", { field, value });
  }
  const trimmed = value.trim();
  if (trimmed.length > 160) {
    throw new CasinoRemittanceError("ERR_BAD_IDENTIFIER", { field, reason: "too_long" });
  }
  return trimmed;
}

function assertPlanKey(value: unknown): string {
  const key = assertIdentifier(value, "key");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) {
    throw new CasinoRemittanceError("ERR_BAD_IDENTIFIER", { field: "key", value, reason: "unsafe_group_key" });
  }
  return key;
}

function assertReason(value: unknown, field = "reason"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CasinoRemittanceError("ERR_BAD_REASON", { field });
  }
  const reason = value.trim();
  if (reason.length > 500) throw new CasinoRemittanceError("ERR_BAD_REASON", { field, reason: "too_long" });
  return reason;
}

function assertPeriod(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new CasinoRemittanceError("ERR_BAD_PERIOD", { value });
  }
  return value;
}

function monthOfJst(ts: number): string {
  assertSafeNonNegative(ts, "timestamp");
  return new Date((ts + 9 * 60 * 60) * 1_000).toISOString().slice(0, 7);
}

function checkedSum(values: readonly number[], field: string): number {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new CasinoRemittanceError("ERR_BAD_AMOUNT", { field, value });
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new CasinoRemittanceError("ERR_BAD_AMOUNT", { field, reason: "overflow" });
  }
  return Number(total);
}

function nonNegativeDifference(minuend: number, subtrahends: readonly number[], field: string): number {
  let value = BigInt(assertSafeNonNegative(minuend, `${field}.minuend`));
  for (const item of subtrahends) value -= BigInt(assertSafeNonNegative(item, `${field}.subtrahend`));
  if (value <= 0n) return 0;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CasinoRemittanceError("ERR_BAD_AMOUNT", { field, reason: "overflow" });
  }
  return Number(value);
}

function multiplyBpsFloor(base: number, bps: number): number {
  const safeBase = assertSafeNonNegative(base, "base");
  const safeBps = assertSafeNonNegative(bps, "remitRateBps");
  if (safeBps > 10_000) throw new CasinoRemittanceError("ERR_BAD_AMOUNT", { field: "remitRateBps", value: bps });
  const amount = (BigInt(safeBase) * BigInt(safeBps)) / 10_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CasinoRemittanceError("ERR_BAD_AMOUNT", { field: "remittanceAmount", reason: "overflow" });
  }
  return Number(amount);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== "string") throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { field, raw });
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { field, reason: "malformed_json" });
  }
}

function corrupt(field: string, value?: unknown): never {
  throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { field, ...(value === undefined ? {} : { value }) });
}

function snapshotSafeNonNegative(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) corrupt(`snapshot.${field}`, value);
  return value;
}

function snapshotSafeSigned(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) corrupt(`snapshot.${field}`, value);
  return value;
}

function snapshotString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string" || !value) corrupt(`snapshot.${field}`, value);
  return value;
}

function validatePersistedSnapshot(
  raw: Record<string, unknown>,
  expected: { kind: RemittanceKind; period: string; amount: number; planHash: string },
): RemittancePlanSnapshot {
  if (raw.kind !== expected.kind) corrupt("snapshot.kind", raw.kind);
  if (raw.period !== expected.period) corrupt("snapshot.period", raw.period);
  const amount = snapshotSafeNonNegative(raw, "amount");
  if (amount !== expected.amount) corrupt("snapshot.amount", amount);
  const reservationFingerprint = snapshotString(raw, "reservationFingerprint");
  if (!/^[a-f0-9]{64}$/.test(reservationFingerprint)) corrupt("snapshot.reservationFingerprint", reservationFingerprint);

  snapshotSafeNonNegative(raw, "minimumWorkingCapital");
  snapshotSafeNonNegative(raw, "houseBalance");
  snapshotSafeNonNegative(raw, "reservedObligations");
  snapshotSafeNonNegative(raw, "latestChipTxId");

  if (expected.kind === "remittance") {
    const rate = snapshotSafeNonNegative(raw, "remitRateBps");
    if (rate > 10_000) corrupt("snapshot.remitRateBps", rate);
    snapshotSafeNonNegative(raw, "fukuReserve");
    snapshotSafeSigned(raw, "cumulativeRealizedProfit");
    snapshotSafeNonNegative(raw, "executedRemittances");
    snapshotSafeNonNegative(raw, "cumulativeUndisposedProfit");
    snapshotSafeNonNegative(raw, "surplus");
    snapshotSafeNonNegative(raw, "base");
  } else {
    snapshotSafeNonNegative(raw, "settleableHouse");
    snapshotSafeNonNegative(raw, "gapToMinimumWorkingCapital");
  }

  if (canonicalHash(raw) !== expected.planHash) corrupt("snapshot_json", "hash_mismatch");
  return raw as unknown as RemittancePlanSnapshot;
}

function assertOptionalString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { field, value });
  return value;
}

function assertOptionalSafeInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { field, value });
  }
  return value;
}

export class CasinoRemittance {
  private readonly nowFn: () => number;
  private readonly fukuReserveProvider: (() => number | null) | undefined;

  private schemaReady = false;

  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly chips: ChipLedger,
    private readonly reservations: HouseReservations,
    private readonly settings: Settings,
    options: CasinoRemittanceOptions = {},
  ) {
    this.nowFn = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.fukuReserveProvider = options.fukuReserve;
  }

  /**
   * PR14は正式開業後の機能。PR12のpreflightより先に新しいcasino_* tableを作ると
   * 現行のunknown-table blockerへ自分自身が引っ掛かるため、opening_v1確定前は
   * schemaを一切作らない。これによりPR14をmerge/deployしても正式開業resetを汚染しない。
   */
  private ensureSchema(): void {
    if (this.schemaReady) return;
    if (this.chips.chipTx.openingPhase() !== "formal") {
      throw new CasinoRemittanceError("ERR_CASINO_OPENING_NOT_COMPLETE", {
        openingPhase: this.chips.chipTx.openingPhase(),
      });
    }
    this.ledger.ensureAccount(CASINO_DEPARTMENT_ACCOUNT, "system");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_house_pnl (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL,
        amount INTEGER NOT NULL,
        source_tx_id INTEGER NOT NULL UNIQUE,
        chip_group_key TEXT NOT NULL,
        group_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_casino_house_pnl_period
        ON casino_house_pnl(period, created_at, id);

      CREATE TABLE IF NOT EXISTS casino_remittances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('remittance','bailout')),
        period TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(amount >= 0),
        status TEXT NOT NULL CHECK(status IN ('draft','approved','executed','rejected')),
        plan_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        reason TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        approved_by TEXT,
        approved_at INTEGER,
        rejected_by TEXT,
        rejected_at INTEGER,
        rejection_reason TEXT,
        executed_by TEXT,
        executed_at INTEGER,
        land_tx_id INTEGER,
        chip_group_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_casino_remittances_status
        ON casino_remittances(status, kind, period);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_casino_remittances_active_period
        ON casino_remittances(period)
        WHERE kind='remittance' AND status IN ('draft','approved','executed');
    `);
    this.schemaReady = true;
  }

  private activeRemittanceForPeriod(periodInput: string): { key: string; status: "draft" | "approved" | "executed" } | undefined {
    const period = assertPeriod(periodInput);
    const row = this.db.prepare(`
      SELECT key, status
      FROM casino_remittances
      WHERE kind='remittance'
        AND period=?
        AND status IN ('draft','approved','executed')
      ORDER BY id
      LIMIT 1
    `).get(period) as { key: unknown; status: unknown } | undefined;
    if (!row) return undefined;
    if (row.status !== "draft" && row.status !== "approved" && row.status !== "executed") {
      throw new CasinoRemittanceError("ERR_CORRUPT_STATE", {
        field: "activeRemittance.status",
        value: row.status,
      });
    }
    return { key: assertPlanKey(row.key), status: row.status };
  }

  private assertRemittancePeriodAvailable(period: string, key: string): void {
    const active = this.activeRemittanceForPeriod(period);
    if (active && active.key !== key) {
      throw new CasinoRemittanceError("ERR_REMITTANCE_PERIOD_LOCKED", {
        period,
        key,
        existingKey: active.key,
        existingStatus: active.status,
      });
    }
  }

  private now(): number {
    return assertSafeNonNegative(this.nowFn(), "now");
  }

  private openingConfig(): CasinoOpeningConfig {
    const result = readCasinoOpeningConfig(this.settings);
    if (!result.ok) {
      throw new CasinoRemittanceError("ERR_OPENING_CONFIG_REQUIRED", {
        configured: result.configured,
        reason: result.reason,
        ...("errors" in result ? { errors: result.errors } : {}),
      });
    }
    return result.config;
  }

  private fukuReserve(): number {
    if (!this.fukuReserveProvider) {
      throw new CasinoRemittanceError("ERR_FUKU_RESERVE_UNCONFIGURED");
    }
    const value = this.fukuReserveProvider();
    if (value === null) throw new CasinoRemittanceError("ERR_FUKU_RESERVE_UNCONFIGURED");
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CasinoRemittanceError("ERR_FUKU_RESERVE_INVALID", { value });
    }
    return value;
  }

  private reservationState(): { total: number; fingerprint: string } {
    const rows = this.db
      .prepare("SELECT key, amount, game, user_id, created_at FROM casino_house_reservations ORDER BY key")
      .all() as Array<{ key: string; amount: number; game: string; user_id: string; created_at: number }>;
    for (const row of rows) {
      assertIdentifier(row.key, "reservation.key");
      assertSafePositive(row.amount, "reservation.amount");
      assertIdentifier(row.game, "reservation.game");
      assertIdentifier(row.user_id, "reservation.user_id");
      assertSafeNonNegative(row.created_at, "reservation.created_at");
    }
    const total = this.reservations.totalReserved();
    return { total, fingerprint: canonicalHash(rows) };
  }

  private latestFormalChipTxId(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(id),0) AS id FROM casino_tx WHERE opening_version=?")
      .get(FORMAL_OPENING_VERSION) as { id: number };
    return assertSafeNonNegative(row.id, "latestChipTxId");
  }

  /**
   * 現在mainの構造化情報だけからhouse実現P/Lを同期する。
   * reason文言・seq順序は使わない。houseに触る未知groupは誤分類せずfail-closedする。
   */
  syncRealized(): number {
    this.ensureSchema();
    const rows = this.db.prepare(`
      SELECT t.id, t.group_key, g.kind AS group_kind, t.from_holder, t.to_holder,
             t.amount, t.created_at, t.opening_version
      FROM casino_tx t
      JOIN casino_tx_groups g ON g.group_key=t.group_key
      WHERE g.status='settled'
        AND t.tx_kind='internal_transfer'
        AND t.opening_version=?
        AND (t.from_holder=? OR t.to_holder=?)
      ORDER BY t.id
    `).all(FORMAL_OPENING_VERSION, HOUSE_HOLDER, HOUSE_HOLDER) as HouseChipTx[];

    const insert = this.db.prepare(`
      INSERT INTO casino_house_pnl
        (period, amount, source_tx_id, chip_group_key, group_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_tx_id) DO NOTHING
    `);

    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        assertSafePositive(row.id, "chipTx.id");
        assertSafePositive(row.amount, "chipTx.amount");
        assertSafeNonNegative(row.created_at, "chipTx.created_at");
        if (row.opening_version !== FORMAL_OPENING_VERSION) continue;

        if (!OPERATING_HOUSE_GROUPS.has(row.group_kind)) {
          if (EXCLUDED_HOUSE_GROUPS.has(row.group_kind)) continue;
          throw new CasinoRemittanceError("ERR_UNCLASSIFIED_HOUSE_TX", {
            chipTxId: row.id,
            groupKey: row.group_key,
            groupKind: row.group_kind,
            from: row.from_holder,
            to: row.to_holder,
          });
        }

        const amount =
          row.to_holder === HOUSE_HOLDER
            ? row.amount
            : row.from_holder === HOUSE_HOLDER
              ? -row.amount
              : 0;
        if (amount === 0) continue;

        if (
          insert.run(
            monthOfJst(row.created_at),
            amount,
            row.id,
            row.group_key,
            row.group_kind,
            row.created_at,
          ).changes === 1
        ) {
          inserted++;
        }
      }
    });
    if (this.db.inTransaction) tx();
    else tx.immediate();
    return inserted;
  }

  pnl(period?: string): HousePnlRow[] {
    this.syncRealized();
    if (period !== undefined) assertPeriod(period);
    const rows = (period === undefined
      ? this.db.prepare("SELECT * FROM casino_house_pnl ORDER BY created_at, id").all()
      : this.db.prepare("SELECT * FROM casino_house_pnl WHERE period=? ORDER BY created_at, id").all(period)
    ) as Array<{
      id: number;
      period: string;
      amount: number;
      source_tx_id: number;
      chip_group_key: string;
      group_kind: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: assertSafePositive(row.id, "pnl.id"),
      period: assertPeriod(row.period),
      amount: (() => {
        if (!Number.isSafeInteger(row.amount) || row.amount === 0) {
          throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { field: "pnl.amount", value: row.amount });
        }
        return row.amount;
      })(),
      sourceTxId: assertSafePositive(row.source_tx_id, "pnl.sourceTxId"),
      chipGroupKey: assertIdentifier(row.chip_group_key, "pnl.chipGroupKey"),
      groupKind: assertIdentifier(row.group_kind, "pnl.groupKind"),
      createdAt: assertSafeNonNegative(row.created_at, "pnl.createdAt"),
    }));
  }

  cumulativeProfit(): number {
    this.syncRealized();
    const rows = this.db.prepare("SELECT amount FROM casino_house_pnl ORDER BY id").all() as Array<{ amount: number }>;
    return checkedSum(rows.map((row) => {
      if (!Number.isSafeInteger(row.amount)) {
        throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { field: "pnl.amount", value: row.amount });
      }
      return row.amount;
    }), "cumulativeProfit");
  }

  private executedRemittances(): number {
    const rows = this.db
      .prepare("SELECT amount FROM casino_remittances WHERE kind='remittance' AND status='executed' ORDER BY id")
      .all() as Array<{ amount: number }>;
    return checkedSum(rows.map((row) => assertSafeNonNegative(row.amount, "executedRemittance.amount")), "executedRemittances");
  }

  cumulativeUndisposedProfit(): number {
    return checkedSum([this.cumulativeProfit(), -this.executedRemittances()], "cumulativeUndisposedProfit");
  }

  private remittanceSnapshot(): RemittanceSnapshot {
    const config = this.openingConfig();
    const fukuReserve = this.fukuReserve();
    const reservation = this.reservationState();
    const cumulativeRealizedProfit = this.cumulativeProfit();
    const executedRemittances = this.executedRemittances();
    const rawUndisposed = checkedSum(
      [cumulativeRealizedProfit, -executedRemittances],
      "cumulativeUndisposedProfit",
    );
    const cumulativeUndisposedProfit = Math.max(0, rawUndisposed);
    const houseBalance = assertSafeNonNegative(this.chips.balanceOf(HOUSE_HOLDER), "houseBalance");
    const surplus = nonNegativeDifference(
      houseBalance,
      [reservation.total, config.minWorkingCapital, fukuReserve],
      "surplus",
    );
    const base = Math.min(cumulativeUndisposedProfit, surplus);
    const amount = multiplyBpsFloor(base, config.remitRateBps);
    return {
      kind: "remittance",
      period: monthOfJst(this.now()),
      remitRateBps: config.remitRateBps,
      minimumWorkingCapital: config.minWorkingCapital,
      fukuReserve,
      cumulativeRealizedProfit,
      executedRemittances,
      cumulativeUndisposedProfit,
      houseBalance,
      reservedObligations: reservation.total,
      reservationFingerprint: reservation.fingerprint,
      latestChipTxId: this.latestFormalChipTxId(),
      surplus,
      base,
      amount,
    };
  }

  private bailoutSnapshot(amount: number): BailoutSnapshot {
    const config = this.openingConfig();
    const reservation = this.reservationState();
    const houseBalance = assertSafeNonNegative(this.chips.balanceOf(HOUSE_HOLDER), "houseBalance");
    const settleableHouse = nonNegativeDifference(houseBalance, [reservation.total], "settleableHouse");
    const gapToMinimumWorkingCapital = nonNegativeDifference(
      config.minWorkingCapital,
      [settleableHouse],
      "gapToMinimumWorkingCapital",
    );
    return {
      kind: "bailout",
      period: monthOfJst(this.now()),
      amount: assertSafePositive(amount, "bailout.amount"),
      minimumWorkingCapital: config.minWorkingCapital,
      houseBalance,
      reservedObligations: reservation.total,
      reservationFingerprint: reservation.fingerprint,
      latestChipTxId: this.latestFormalChipTxId(),
      settleableHouse,
      gapToMinimumWorkingCapital,
    };
  }

  private insertDraft(
    key: string,
    snapshot: RemittancePlanSnapshot,
    actor: string,
    reason: string | null,
  ): RemittanceRow {
    const amount = snapshot.amount;
    const planHash = canonicalHash(snapshot);
    const ts = this.now();
    try {
      this.db.prepare(`
        INSERT INTO casino_remittances
          (key, kind, period, amount, status, plan_hash, snapshot_json, reason, created_by, created_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(
        key,
        snapshot.kind,
        snapshot.period,
        amount,
        planHash,
        JSON.stringify(snapshot),
        reason,
        actor,
        ts,
      );
    } catch (e) {
      const existing = this.get(key);
      if (existing) {
        if (
          existing.kind === snapshot.kind
          && existing.planHash === planHash
          && existing.createdBy === actor
          && existing.reason === reason
        ) {
          return existing;
        }
      }
      if (snapshot.kind === "remittance") {
        this.assertRemittancePeriodAvailable(snapshot.period, key);
      }
      throw e;
    }
    return this.get(key)!;
  }

  draftRemittance(keyInput: string, actorInput: string): RemittanceRow {
    this.ensureSchema();
    const key = assertPlanKey(keyInput);
    const actor = assertIdentifier(actorInput, "actor");
    const run = this.db.transaction(() => {
      const snapshot = this.remittanceSnapshot();
      this.assertRemittancePeriodAvailable(snapshot.period, key);
      return this.insertDraft(key, snapshot, actor, null);
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  draftBailout(keyInput: string, amountInput: number, reasonInput: string, actorInput: string): RemittanceRow {
    this.ensureSchema();
    const key = assertPlanKey(keyInput);
    const amount = assertSafePositive(amountInput, "amount");
    const reason = assertReason(reasonInput);
    const actor = assertIdentifier(actorInput, "actor");
    const run = this.db.transaction(() => this.insertDraft(key, this.bailoutSnapshot(amount), actor, reason));
    return this.db.inTransaction ? run() : run.immediate();
  }

  approve(keyInput: string, actorInput: string): RemittanceRow {
    const key = assertPlanKey(keyInput);
    const actor = assertIdentifier(actorInput, "actor");
    const run = this.db.transaction(() => {
      const row = this.get(key);
      if (!row || row.status !== "draft") throw new CasinoRemittanceError("ERR_NOT_DRAFT", { key });
      if (row.createdBy === actor) {
        throw new CasinoRemittanceError("ERR_SECOND_APPROVER_REQUIRED", { key, actor });
      }
      const result = this.db.prepare(`
        UPDATE casino_remittances
        SET status='approved', approved_by=?, approved_at=?
        WHERE key=? AND status='draft'
      `).run(actor, this.now(), key);
      if (result.changes !== 1) throw new CasinoRemittanceError("ERR_APPROVAL_RACE", { key });
      return this.get(key)!;
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  reject(keyInput: string, actorInput: string, reasonInput: string): RemittanceRow {
    const key = assertPlanKey(keyInput);
    const actor = assertIdentifier(actorInput, "actor");
    const reason = assertReason(reasonInput, "rejectionReason");
    const run = this.db.transaction(() => {
      const row = this.get(key);
      if (!row || (row.status !== "draft" && row.status !== "approved")) {
        throw new CasinoRemittanceError("ERR_NOT_DRAFT", { key, status: row?.status });
      }
      const result = this.db.prepare(`
        UPDATE casino_remittances
        SET status='rejected', rejected_by=?, rejected_at=?, rejection_reason=?
        WHERE key=? AND status IN ('draft','approved')
      `).run(actor, this.now(), reason, key);
      if (result.changes !== 1) throw new CasinoRemittanceError("ERR_REJECT_RACE", { key });
      return this.get(key)!;
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  private assertFresh(row: RemittanceRow): void {
    const current = row.kind === "remittance"
      ? this.remittanceSnapshot()
      : this.bailoutSnapshot(row.amount);
    if (canonicalHash(current) !== row.planHash) {
      throw new CasinoRemittanceError("ERR_PLAN_STALE", {
        key: row.key,
        storedPlanHash: row.planHash,
        currentPlanHash: canonicalHash(current),
      });
    }
  }

  private assertLandTransferWasNew(
    result: TransferResult,
    expected: { from: string; to: string; amount: number; type: string },
  ): number {
    if (result.duplicate) {
      throw new CasinoRemittanceError("ERR_LEDGER_IDEMPOTENCY_CONFLICT", {
        idempotencyKey: result.tx.idempotency_key,
        existingTxId: result.tx.id,
      });
    }
    if (
      result.tx.from_account !== expected.from
      || result.tx.to_account !== expected.to
      || result.tx.amount !== expected.amount
      || result.tx.type !== expected.type
    ) {
      throw new CasinoRemittanceError("ERR_LEDGER_IDEMPOTENCY_CONFLICT", {
        txId: result.tx.id,
        expected,
        actual: {
          from: result.tx.from_account,
          to: result.tx.to_account,
          amount: result.tx.amount,
          type: result.tx.type,
        },
      });
    }
    return result.tx.id;
  }

  execute(keyInput: string, actorInput: string): RemittanceRow {
    const key = assertPlanKey(keyInput);
    const actor = assertIdentifier(actorInput, "actor");
    const existing = this.get(key);
    if (existing?.status === "executed") {
      if (existing.executedBy === actor) return existing;
      throw new CasinoRemittanceError("ERR_NOT_APPROVED", { key, status: existing.status, executedBy: existing.executedBy });
    }
    if (!existing || existing.status !== "approved" || !existing.approvedBy) {
      throw new CasinoRemittanceError("ERR_NOT_APPROVED", { key, status: existing?.status });
    }

    if (existing.amount === 0) {
      const tx = this.db.transaction(() => {
        const row = this.get(key);
        if (!row || row.status !== "approved" || !row.approvedBy) {
          throw new CasinoRemittanceError("ERR_NOT_APPROVED", { key, status: row?.status });
        }
        this.assertFresh(row);
        const result = this.db.prepare(`
          UPDATE casino_remittances
          SET status='executed', executed_by=?, executed_at=?, chip_group_key=NULL, land_tx_id=NULL
          WHERE key=? AND status='approved'
        `).run(actor, this.now(), key);
        if (result.changes !== 1) throw new CasinoRemittanceError("ERR_EXECUTE_RACE", { key });
        return this.get(key)!;
      });
      return this.db.inTransaction ? tx() : tx.immediate();
    }

    const groupKey = `${existing.kind === "remittance" ? REMITTANCE_GROUP_PREFIX : BAILOUT_GROUP_PREFIX}${key}`;
    return this.chips.runGroup(
      { groupKey, kind: existing.kind, actorId: actor },
      (): RemittanceRow => {
        const row = this.get(key);
        if (!row || row.status !== "approved" || !row.approvedBy) {
          throw new CasinoRemittanceError("ERR_NOT_APPROVED", { key, status: row?.status });
        }
        this.assertFresh(row);

        let landTxId: number;
        if (row.kind === "remittance") {
          this.chips.redeemToAccount(
            HOUSE_HOLDER,
            row.amount,
            CASINO_DEPARTMENT_ACCOUNT,
            actor,
            `${groupKey}:redeem`,
          );
          const transfer = this.ledger.transfer({
            from: CASINO_DEPARTMENT_ACCOUNT,
            to: TREASURY,
            amount: row.amount,
            type: "casino_remittance",
            actor,
            approvedBy: row.approvedBy,
            reason: "賭博場 月次納付",
            refType: "casino_remittance",
            refId: key,
            idempotencyKey: `${groupKey}:land`,
          });
          landTxId = this.assertLandTransferWasNew(transfer, {
            from: CASINO_DEPARTMENT_ACCOUNT,
            to: TREASURY,
            amount: row.amount,
            type: "casino_remittance",
          });
        } else {
          const transfer = this.ledger.transfer({
            from: TREASURY,
            to: CASINO_DEPARTMENT_ACCOUNT,
            amount: row.amount,
            type: "casino_bailout",
            actor,
            approvedBy: row.approvedBy,
            reason: row.reason ?? "賭博場 補填",
            refType: "casino_bailout",
            refId: key,
            idempotencyKey: `${groupKey}:land`,
          });
          landTxId = this.assertLandTransferWasNew(transfer, {
            from: TREASURY,
            to: CASINO_DEPARTMENT_ACCOUNT,
            amount: row.amount,
            type: "casino_bailout",
          });
          this.chips.fundFromAccount(
            CASINO_DEPARTMENT_ACCOUNT,
            row.amount,
            HOUSE_HOLDER,
            `${groupKey}:fund`,
          );
        }

        const result = this.db.prepare(`
          UPDATE casino_remittances
          SET status='executed', executed_by=?, executed_at=?, land_tx_id=?, chip_group_key=?
          WHERE key=? AND status='approved'
        `).run(actor, this.now(), landTxId, groupKey, key);
        if (result.changes !== 1) throw new CasinoRemittanceError("ERR_EXECUTE_RACE", { key });
        return this.get(key)!;
      },
    );
  }

  get(keyInput: string): RemittanceRow | undefined {
    this.ensureSchema();
    const key = assertPlanKey(keyInput);
    const raw = this.db.prepare("SELECT * FROM casino_remittances WHERE key=?").get(key) as PersistedRow | undefined;
    if (!raw) return undefined;

    const id = assertOptionalSafeInteger(raw.id, "id");
    const amount = assertOptionalSafeInteger(raw.amount, "amount");
    const createdAt = assertOptionalSafeInteger(raw.created_at, "createdAt");
    if (id === null || id <= 0 || amount === null || createdAt === null) {
      throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { key, reason: "required_integer" });
    }
    if (raw.kind !== "remittance" && raw.kind !== "bailout") {
      throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { key, field: "kind", value: raw.kind });
    }
    if (!["draft", "approved", "executed", "rejected"].includes(String(raw.status))) {
      throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { key, field: "status", value: raw.status });
    }
    if (typeof raw.plan_hash !== "string" || !/^[a-f0-9]{64}$/.test(raw.plan_hash)) {
      throw new CasinoRemittanceError("ERR_CORRUPT_STATE", { key, field: "plan_hash" });
    }
    const period = assertPeriod(raw.period);
    const snapshot = validatePersistedSnapshot(
      parseJsonObject(raw.snapshot_json, "snapshot_json"),
      { kind: raw.kind, period, amount, planHash: raw.plan_hash },
    );

    return {
      id,
      key: assertPlanKey(raw.key),
      kind: raw.kind,
      period,
      amount,
      status: raw.status as RemittanceStatus,
      planHash: raw.plan_hash,
      snapshot,
      reason: assertOptionalString(raw.reason, "reason"),
      createdBy: assertIdentifier(raw.created_by, "createdBy"),
      createdAt,
      approvedBy: assertOptionalString(raw.approved_by, "approvedBy"),
      approvedAt: assertOptionalSafeInteger(raw.approved_at, "approvedAt"),
      rejectedBy: assertOptionalString(raw.rejected_by, "rejectedBy"),
      rejectedAt: assertOptionalSafeInteger(raw.rejected_at, "rejectedAt"),
      rejectionReason: assertOptionalString(raw.rejection_reason, "rejectionReason"),
      executedBy: assertOptionalString(raw.executed_by, "executedBy"),
      executedAt: assertOptionalSafeInteger(raw.executed_at, "executedAt"),
      landTxId: assertOptionalSafeInteger(raw.land_tx_id, "landTxId"),
      chipGroupKey: assertOptionalString(raw.chip_group_key, "chipGroupKey"),
    };
  }
}
