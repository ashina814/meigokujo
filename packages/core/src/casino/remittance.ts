import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { deptAccount } from "../departments/service.js";
import { Ledger, TREASURY } from "../ledger/service.js";
import { CASINO_DEPARTMENT_KEY, ChipLedger, HOUSE_HOLDER, isPlayerHolder } from "./chip-ledger.js";
import { HouseReservations } from "./reservations.js";

const now = () => Math.floor(Date.now() / 1000);
/** 会計月は冥獄城の運用基準であるJST。UTC月境界（JST 09:00）へずらさない。 */
const monthOf = (ts = now()) => new Date((ts + 9 * 60 * 60) * 1_000).toISOString().slice(0, 7);
const planHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type RemittanceStatus = "draft" | "approved" | "executed" | "rejected";
export type HousePnlCategory =
  | "wager"
  | "vip"
  | "shop"
  | "table_fee"
  | "payout"
  | "chain_bonus"
  | "fuku_distribution"
  | "jackpot_contribution"
  | "manual_adjustment";

export interface HousePnlRow {
  id: number;
  period: string;
  category: HousePnlCategory;
  amount: number;
  sourceKey: string;
  chipGroupKey: string | null;
  chipTxId: number | null;
  createdAt: number;
}

export interface RemittanceSnapshot {
  period: string;
  bps: number;
  minimumWorkingCapital: number;
  fukuReserve: number;
  periodRealizedProfit: number;
  cumulativeRealizedProfit: number;
  cumulativeUndisposedProfit: number;
  houseBalance: number;
  reservedObligations: number;
  surplus: number;
  base: number;
  amount: number;
}

export interface RemittanceRow {
  id: number;
  key: string;
  kind: "remittance" | "bailout";
  period: string;
  amount: number;
  status: RemittanceStatus;
  planHash: string;
  snapshot: Record<string, unknown>;
  reason: string | null;
  shortage: Record<string, unknown> | null;
  createdBy: string;
  createdAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  executedBy: string | null;
  executedAt: number | null;
  landTxId: number | null;
  chipGroupKey: string | null;
}

export interface RemittanceDraftOptions {
  period?: string;
  fukuReserve?: number;
}

export interface RemittanceConfiguration {
  remittanceBps: number;
  minimumWorkingCapital: number;
}

interface ChipTxForPnl {
  id: number;
  group_key: string;
  group_kind: string;
  seq: number;
  from_holder: string | null;
  to_holder: string | null;
  amount: number;
  game: string | null;
  session_id: string | null;
  created_at: number;
}

const PNL_CATEGORIES = new Set<HousePnlCategory>([
  "wager",
  "vip",
  "shop",
  "table_fee",
  "payout",
  "chain_bonus",
  "fuku_distribution",
  "jackpot_contribution",
  "manual_adjustment",
]);

function validNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
}

function isEscrowHolder(holder: string | null): boolean {
  return Boolean(holder && (holder.startsWith("escrow:") || holder === "house_escrow_legacy"));
}

/**
 * P&L分類は利用者向け理由文ではなく、settled groupの種別・資金方向・holder種別で決める。
 * 文言変更や翻訳で会計分類が変わらない。
 */
function categoryFor(
  row: ChipTxForPnl,
  housePayoutOrdinal: number,
): { category: HousePnlCategory; amount: number } | null {
  const from = row.from_holder;
  const to = row.to_holder;

  if (row.group_kind === "vip" && to === HOUSE_HOLDER && from && isPlayerHolder(from)) {
    return { category: "vip", amount: row.amount };
  }
  if (row.group_kind === "shop" && to === HOUSE_HOLDER && from && isPlayerHolder(from)) {
    return { category: "shop", amount: row.amount };
  }
  if (row.group_kind === "daily" && from === HOUSE_HOLDER && to && isPlayerHolder(to)) {
    return { category: "fuku_distribution", amount: -row.amount };
  }

  if (row.group_kind === "solo_game") {
    if (to === HOUSE_HOLDER && from && (isPlayerHolder(from) || isEscrowHolder(from))) {
      return { category: "wager", amount: row.amount };
    }
    if (from === HOUSE_HOLDER && to === "jackpot") {
      return { category: "jackpot_contribution", amount: -row.amount };
    }
    if (from === HOUSE_HOLDER && to && isPlayerHolder(to)) {
      return {
        category: housePayoutOrdinal === 0 ? "payout" : "chain_bonus",
        amount: -row.amount,
      };
    }
  }

  if (row.group_kind === "table_settle" && to === HOUSE_HOLDER && isEscrowHolder(from)) {
    return { category: "table_fee", amount: row.amount };
  }
  return null;
}

export class CasinoRemittance {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly chips: ChipLedger,
    private readonly reservations: HouseReservations,
    private readonly departmentKey = CASINO_DEPARTMENT_KEY,
  ) {
    ledger.ensureAccount(deptAccount(departmentKey), "system");
    db.exec(`
      CREATE TABLE IF NOT EXISTS casino_house_pnl (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL,
        category TEXT NOT NULL,
        amount INTEGER NOT NULL,
        source_key TEXT NOT NULL UNIQUE,
        chip_group_key TEXT,
        chip_tx_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_casino_house_pnl_period ON casino_house_pnl(period, created_at);
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
        shortage_json TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        approved_by TEXT,
        approved_at INTEGER,
        executed_by TEXT,
        executed_at INTEGER,
        land_tx_id INTEGER,
        chip_group_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_casino_remittances_status ON casino_remittances(status, kind, period);
    `);
    this.addColumn("casino_house_pnl", "period", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("casino_house_pnl", "chip_group_key", "TEXT");
    this.addColumn("casino_house_pnl", "chip_tx_id", "INTEGER");
    this.addColumn("casino_remittances", "period", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("casino_remittances", "created_at", "INTEGER NOT NULL DEFAULT 0");
  }

  private addColumn(table: string, name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  /** settled groupの構造から、house実現損益をimmutable chip_tx.idごとに一度だけ取り込む。 */
  syncRealized(): number {
    const rows = this.db.prepare(`
      SELECT t.id, t.group_key, g.kind AS group_kind, t.seq,
             t.from_holder, t.to_holder, t.amount, t.game, t.session_id, t.created_at
      FROM casino_tx t
      JOIN casino_tx_groups g ON g.group_key=t.group_key
      WHERE g.status='settled' AND t.tx_kind='internal_transfer'
      ORDER BY t.created_at, t.id
    `).all() as ChipTxForPnl[];
    let inserted = 0;
    const payoutOrdinal = new Map<string, number>();
    const insert = this.db.prepare(`
      INSERT INTO casino_house_pnl
        (period, category, amount, source_key, chip_group_key, chip_tx_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO NOTHING
    `);
    this.db.transaction(() => {
      for (const row of rows) {
        const ordinal = payoutOrdinal.get(row.group_key) ?? 0;
        const classified = categoryFor(row, ordinal);
        if (
          row.group_kind === "solo_game"
          && row.from_holder === HOUSE_HOLDER
          && row.to_holder
          && isPlayerHolder(row.to_holder)
        ) {
          payoutOrdinal.set(row.group_key, ordinal + 1);
        }
        if (!classified) continue;
        if (insert.run(
          monthOf(row.created_at),
          classified.category,
          classified.amount,
          `chip_tx:${row.id}`,
          row.group_key,
          row.id,
          row.created_at,
        ).changes === 1) inserted += 1;
      }
    })();
    return inserted;
  }

  /** チップ移動で表現されない将来収入用の、明示分類済みadapter。 */
  recordRealized(category: HousePnlCategory, amount: number, sourceKey: string, period = monthOf()): void {
    if (!PNL_CATEGORIES.has(category)) throw new Error("invalid P&L category");
    if (!Number.isSafeInteger(amount)) throw new Error("invalid P&L amount");
    if (!sourceKey.trim()) throw new Error("P&L source key required");
    this.db.prepare(`
      INSERT INTO casino_house_pnl (period, category, amount, source_key, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(period, category, amount, sourceKey, now());
  }

  pnl(period?: string): HousePnlRow[] {
    this.syncRealized();
    const sql = period
      ? "SELECT * FROM casino_house_pnl WHERE period=? ORDER BY created_at, id"
      : "SELECT * FROM casino_house_pnl ORDER BY created_at, id";
    const rows = (period ? this.db.prepare(sql).all(period) : this.db.prepare(sql).all()) as Array<{
      id: number;
      period: string;
      category: HousePnlCategory;
      amount: number;
      source_key: string;
      chip_group_key: string | null;
      chip_tx_id: number | null;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      period: row.period,
      category: row.category,
      amount: row.amount,
      sourceKey: row.source_key,
      chipGroupKey: row.chip_group_key,
      chipTxId: row.chip_tx_id,
      createdAt: row.created_at,
    }));
  }

  cumulativeProfit(period?: string): number {
    this.syncRealized();
    const row = (period
      ? this.db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM casino_house_pnl WHERE period=?").get(period)
      : this.db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM casino_house_pnl").get()) as { amount: number };
    return row.amount;
  }

  cumulativeUndisposedProfit(period?: string): number {
    const realized = this.cumulativeProfit(period);
    const paid = (period
      ? this.db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM casino_remittances WHERE kind='remittance' AND status='executed' AND period=?").get(period)
      : this.db.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM casino_remittances WHERE kind='remittance' AND status='executed'").get()) as { amount: number };
    return realized - paid.amount;
  }

  surplus(minimumWorkingCapital: number, fukuReserve = 0): number {
    validNonNegative(minimumWorkingCapital, "minimum working capital");
    validNonNegative(fukuReserve, "fuku reserve");
    return Math.max(
      0,
      this.chips.balanceOf(HOUSE_HOLDER)
        - this.reservations.totalReserved()
        - minimumWorkingCapital
        - fukuReserve,
    );
  }

  private remittanceSnapshot(
    bps: number,
    minimumWorkingCapital: number,
    fukuReserve: number,
    period: string,
  ): RemittanceSnapshot {
    validNonNegative(minimumWorkingCapital, "minimum working capital");
    validNonNegative(fukuReserve, "fuku reserve");
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new Error("invalid bps");
    const periodRealizedProfit = this.cumulativeProfit(period);
    const cumulativeRealizedProfit = this.cumulativeProfit();
    const cumulativeUndisposedProfit = Math.max(0, this.cumulativeUndisposedProfit());
    const reservedObligations = this.reservations.totalReserved();
    const houseBalance = this.chips.balanceOf(HOUSE_HOLDER);
    const surplus = Math.max(
      0,
      houseBalance - reservedObligations - minimumWorkingCapital - fukuReserve,
    );
    const base = Math.min(cumulativeUndisposedProfit, surplus);
    return {
      period,
      bps,
      minimumWorkingCapital,
      fukuReserve,
      periodRealizedProfit,
      cumulativeRealizedProfit,
      cumulativeUndisposedProfit,
      houseBalance,
      reservedObligations,
      surplus,
      base,
      amount: Math.floor(base * bps / 10_000),
    };
  }

  private draftConfigured(
    key: string,
    bps: number,
    minimumWorkingCapital: number,
    actor: string,
    options: RemittanceDraftOptions = {},
  ): RemittanceRow {
    const configured = this.configuration();
    if (
      !configured
      || configured.remittanceBps !== bps
      || configured.minimumWorkingCapital !== minimumWorkingCapital
    ) {
      throw new Error("remittance draft must use opening configuration");
    }
    const period = options.period ?? monthOf();
    const snapshot = this.remittanceSnapshot(
      bps,
      minimumWorkingCapital,
      options.fukuReserve ?? 0,
      period,
    );
    return this.insert(key, "remittance", period, snapshot.amount, snapshot, actor, null, null);
  }

  configuration(): RemittanceConfiguration | null {
    const exists = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='casino_opening_configuration'",
    ).get();
    if (!exists) return null;
    const row = this.db.prepare("SELECT * FROM casino_opening_configuration WHERE id=1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row || Number(row.casino_opening_configured) !== 1) return null;
    return {
      remittanceBps: Number(row.casino_remit_rate_bps),
      minimumWorkingCapital: Number(row.casino_min_working_capital),
    };
  }

  draftFromConfiguration(
    key: string,
    actor: string,
    options: RemittanceDraftOptions = {},
  ): RemittanceRow {
    const config = this.configuration();
    if (!config) throw new Error("casino opening configuration required");
    return this.draftConfigured(key, config.remittanceBps, config.minimumWorkingCapital, actor, options);
  }

  bailoutDraft(
    key: string,
    amount: number,
    reason: string,
    shortage: Record<string, unknown>,
    actor: string,
    period = monthOf(),
  ): RemittanceRow {
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason.trim()) {
      throw new Error("bailout needs amount and reason");
    }
    const snapshot = {
      period,
      amount,
      reason,
      shortage,
      houseBalance: this.chips.balanceOf(HOUSE_HOLDER),
      reservedObligations: this.reservations.totalReserved(),
    };
    return this.insert(key, "bailout", period, amount, snapshot, actor, reason, shortage);
  }

  private insert(
    key: string,
    kind: "remittance" | "bailout",
    period: string,
    amount: number,
    snapshot: object,
    actor: string,
    reason: string | null,
    shortage: Record<string, unknown> | null,
  ): RemittanceRow {
    if (!key.trim() || !actor.trim() || !period.trim()) throw new Error("draft identity required");
    this.db.prepare(`
      INSERT INTO casino_remittances
       (key, kind, period, amount, status, plan_hash, snapshot_json, reason, shortage_json, created_by, created_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      kind,
      period,
      amount,
      planHash(snapshot),
      JSON.stringify(snapshot),
      reason,
      shortage ? JSON.stringify(shortage) : null,
      actor,
      now(),
    );
    return this.get(key)!;
  }

  approve(key: string, actor: string): RemittanceRow {
    const row = this.get(key);
    if (!row || row.status !== "draft") throw new Error("not draft");
    if (row.createdBy === actor) throw new Error("second approver required");
    if (this.db.prepare(
      "UPDATE casino_remittances SET status='approved', approved_by=?, approved_at=? WHERE key=? AND status='draft'",
    ).run(actor, now(), key).changes !== 1) {
      throw new Error("approval race");
    }
    return this.get(key)!;
  }

  private assertFresh(row: RemittanceRow): void {
    if (row.kind === "remittance") {
      const snapshot = row.snapshot as unknown as RemittanceSnapshot;
      if (planHash(this.remittanceSnapshot(
        snapshot.bps,
        snapshot.minimumWorkingCapital,
        snapshot.fukuReserve,
        snapshot.period,
      )) !== row.planHash) {
        throw new Error("remittance plan stale");
      }
      return;
    }
    const snapshot = row.snapshot;
    if (
      snapshot.houseBalance !== this.chips.balanceOf(HOUSE_HOLDER)
      || snapshot.reservedObligations !== this.reservations.totalReserved()
    ) {
      throw new Error("bailout plan stale");
    }
  }

  execute(key: string, actor: string): RemittanceRow {
    const row = this.get(key);
    if (!row || row.status !== "approved" || !row.approvedBy) throw new Error("not approved");
    const group = `casino:${row.kind}:${key}`;
    const dept = deptAccount(this.departmentKey);

    if (row.amount === 0) {
      this.db.transaction(() => {
        this.assertFresh(row);
        if (this.db.prepare(
          "UPDATE casino_remittances SET status='executed', executed_by=?, executed_at=?, chip_group_key=? WHERE key=? AND status='approved'",
        ).run(actor, now(), group, key).changes !== 1) {
          throw new Error("execute race");
        }
      }).immediate();
      return this.get(key)!;
    }

    let landTxId: number | null = null;
    this.chips.runGroup({ groupKey: group, kind: row.kind, actorId: actor }, () => {
      this.assertFresh(row);
      if (row.kind === "remittance") {
        this.chips.redeemToAccount(HOUSE_HOLDER, row.amount, dept, actor, `${group}:redeem`);
        landTxId = this.ledger.transfer({
          from: dept,
          to: TREASURY,
          amount: row.amount,
          type: "casino_remittance",
          actor,
          approvedBy: row.approvedBy!,
          reason: "casino remittance",
          idempotencyKey: `${group}:land`,
        }).tx.id;
      } else {
        landTxId = this.ledger.transfer({
          from: TREASURY,
          to: dept,
          amount: row.amount,
          type: "casino_bailout",
          actor,
          approvedBy: row.approvedBy!,
          reason: row.reason ?? "casino bailout",
          idempotencyKey: `${group}:land`,
        }).tx.id;
        this.chips.fundFromAccount(dept, row.amount, HOUSE_HOLDER, `${group}:fund`);
      }
      if (this.db.prepare(`
        UPDATE casino_remittances
        SET status='executed', executed_by=?, executed_at=?, land_tx_id=?, chip_group_key=?
        WHERE key=? AND status='approved'
      `).run(actor, now(), landTxId, group, key).changes !== 1) {
        throw new Error("execute race");
      }
    });
    return this.get(key)!;
  }

  bailout(_key: string, _amount: number, _actor: string, _approvedBy: string): never {
    throw new Error("use bailoutDraft → approve → execute");
  }

  get(key: string): RemittanceRow | undefined {
    const row = this.db.prepare("SELECT * FROM casino_remittances WHERE key=?").get(key) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      key: String(row.key),
      kind: row.kind as "remittance" | "bailout",
      period: String(row.period),
      amount: Number(row.amount),
      status: row.status as RemittanceStatus,
      planHash: String(row.plan_hash),
      snapshot: JSON.parse(String(row.snapshot_json)) as Record<string, unknown>,
      reason: row.reason == null ? null : String(row.reason),
      shortage: row.shortage_json == null
        ? null
        : JSON.parse(String(row.shortage_json)) as Record<string, unknown>,
      createdBy: String(row.created_by),
      createdAt: Number(row.created_at),
      approvedBy: row.approved_by == null ? null : String(row.approved_by),
      approvedAt: row.approved_at == null ? null : Number(row.approved_at),
      executedBy: row.executed_by == null ? null : String(row.executed_by),
      executedAt: row.executed_at == null ? null : Number(row.executed_at),
      landTxId: row.land_tx_id == null ? null : Number(row.land_tx_id),
      chipGroupKey: row.chip_group_key == null ? null : String(row.chip_group_key),
    };
  }
}
