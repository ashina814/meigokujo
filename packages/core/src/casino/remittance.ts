import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { deptAccount } from "../departments/service.js";
import { Ledger, TREASURY } from "../ledger/service.js";
import { ChipLedger, HOUSE_HOLDER, isPlayerHolder } from "./chip-ledger.js";
import { HouseReservations } from "./reservations.js";

const now = () => Math.floor(Date.now() / 1000);
const monthOf = (ts = now()) => new Date(ts * 1_000).toISOString().slice(0, 7);
const planHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type RemittanceStatus = "draft" | "approved" | "executed" | "rejected";
export type HousePnlCategory =
  | "wager"
  | "vip"
  | "shop"
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
  realizedProfit: number;
  undisposedProfit: number;
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

/** 運営が確定した納付率・最低運転資金（PR12 の開業設定）。 */
export interface RemittanceConfiguration {
  remittanceBps: number;
  minimumWorkingCapital: number;
}

interface ChipTxForPnl {
  id: number;
  group_key: string;
  from_holder: string | null;
  to_holder: string | null;
  amount: number;
  reason: string;
  game: string | null;
  created_at: number;
}

const PNL_CATEGORIES = new Set<HousePnlCategory>([
  "wager", "vip", "shop", "payout", "chain_bonus", "fuku_distribution", "jackpot_contribution", "manual_adjustment",
]);

function validNonNegative(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
}

function isExcludedMovement(reason: string): boolean {
  return /返金|払い戻し|refund|void|無効|取消/i.test(reason);
}

function categoryFor(row: ChipTxForPnl): { category: HousePnlCategory; amount: number } | null {
  const from = row.from_holder;
  const to = row.to_holder;
  if (isExcludedMovement(row.reason)) return null;

  if (from === HOUSE_HOLDER && to === "jackpot") {
    return { category: "jackpot_contribution", amount: -row.amount };
  }
  if (from === HOUSE_HOLDER && to === "relief") {
    return { category: "fuku_distribution", amount: -row.amount };
  }
  if (from === HOUSE_HOLDER && to && isPlayerHolder(to)) {
    // 福分けは胴元から利用者へ直接出る（daily.ts）。仕様16.1では配当と別建ての支出なので、
    // 通算だけ合わせて payout に混ぜず、専用の分類へ落とす。
    if (/福分け|fuku/i.test(row.reason)) return { category: "fuku_distribution", amount: -row.amount };
    return { category: /連鎖|chain/i.test(row.reason) ? "chain_bonus" : "payout", amount: -row.amount };
  }
  if (to === HOUSE_HOLDER && from && isPlayerHolder(from)) {
    if (/VIP/i.test(row.reason)) return { category: "vip", amount: row.amount };
    if (/商店|shop/i.test(row.reason)) return { category: "shop", amount: row.amount };
    return { category: "wager", amount: row.amount };
  }
  return null;
}

/**
 * Durable, ledger-derived casino accounting.  P&L is reconstructed from settled
 * chip groups, therefore a retry or a crash cannot post the same group twice.
 * Capital, opening, exchange, refund, void and JP-claim movements are never P&L.
 */
export class CasinoRemittance {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly chips: ChipLedger,
    private readonly reservations: HouseReservations,
    private readonly departmentKey = "casino",
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
    if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }

  /** Import every settled house movement exactly once, keyed by immutable chip_tx.id. */
  syncRealized(): number {
    const rows = this.db.prepare(`
      SELECT t.id, t.group_key, t.from_holder, t.to_holder, t.amount, t.reason, t.game, t.created_at
      FROM casino_tx t JOIN casino_tx_groups g ON g.group_key=t.group_key
      WHERE g.status='settled' AND t.tx_kind='internal_transfer'
      ORDER BY t.id
    `).all() as ChipTxForPnl[];
    let inserted = 0;
    const insert = this.db.prepare(`
      INSERT INTO casino_house_pnl (period, category, amount, source_key, chip_group_key, chip_tx_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO NOTHING
    `);
    const run = this.db.transaction(() => {
      for (const row of rows) {
        const classified = categoryFor(row);
        if (!classified) continue;
        if (insert.run(monthOf(row.created_at), classified.category, classified.amount, `chip_tx:${row.id}`, row.group_key, row.id, row.created_at).changes === 1) inserted += 1;
      }
    });
    run();
    return inserted;
  }

  /** Explicit adapter for shop income that is not expressed as a chip transfer. */
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
      ? "SELECT * FROM casino_house_pnl WHERE period=? ORDER BY id"
      : "SELECT * FROM casino_house_pnl ORDER BY id";
    const rows = (period ? this.db.prepare(sql).all(period) : this.db.prepare(sql).all()) as Array<{
      id: number; period: string; category: HousePnlCategory; amount: number; source_key: string;
      chip_group_key: string | null; chip_tx_id: number | null; created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id, period: row.period, category: row.category, amount: row.amount, sourceKey: row.source_key,
      chipGroupKey: row.chip_group_key, chipTxId: row.chip_tx_id, createdAt: row.created_at,
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
    return Math.max(0, this.chips.balanceOf(HOUSE_HOLDER) - this.reservations.totalReserved() - minimumWorkingCapital - fukuReserve);
  }

  private remittanceSnapshot(bps: number, minimumWorkingCapital: number, fukuReserve: number, period: string): RemittanceSnapshot {
    validNonNegative(minimumWorkingCapital, "minimum working capital");
    validNonNegative(fukuReserve, "fuku reserve");
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new Error("invalid bps");
    const realizedProfit = this.cumulativeProfit(period);
    const undisposedProfit = Math.max(0, this.cumulativeUndisposedProfit(period));
    const reservedObligations = this.reservations.totalReserved();
    const houseBalance = this.chips.balanceOf(HOUSE_HOLDER);
    const surplus = Math.max(0, houseBalance - reservedObligations - minimumWorkingCapital - fukuReserve);
    const base = Math.min(undisposedProfit, surplus);
    return { period, bps, minimumWorkingCapital, fukuReserve, realizedProfit, undisposedProfit, houseBalance, reservedObligations, surplus, base, amount: Math.floor(base * bps / 10_000) };
  }

  draft(key: string, bps: number, minimumWorkingCapital: number, actor: string, options: RemittanceDraftOptions = {}): RemittanceRow {
    const period = options.period ?? monthOf();
    const snapshot = this.remittanceSnapshot(bps, minimumWorkingCapital, options.fukuReserve ?? 0, period);
    return this.insert(key, "remittance", period, snapshot.amount, snapshot, actor, null, null);
  }

  /** 運営が確定した開業設定。未設定なら null（＝まだ納付できる状態ではない）。 */
  configuration(): RemittanceConfiguration | null {
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='casino_opening_configuration'")
      .get();
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

  /**
   * 納付draftの唯一の運用入口。納付率と最低運転資金は運営が確定した設定だけを使い、
   * 操作者が都度入力した値では納付できない（仕様16.3「運営が設定するまで納付しない」）。
   */
  draftFromConfiguration(key: string, actor: string, options: RemittanceDraftOptions = {}): RemittanceRow {
    const config = this.configuration();
    if (!config) throw new Error("casino opening configuration required");
    return this.draft(key, config.remittanceBps, config.minimumWorkingCapital, actor, options);
  }

  bailoutDraft(
    key: string,
    amount: number,
    reason: string,
    shortage: Record<string, unknown>,
    actor: string,
    period = monthOf(),
  ): RemittanceRow {
    if (!Number.isSafeInteger(amount) || amount <= 0 || !reason.trim()) throw new Error("bailout needs amount and reason");
    const snapshot = {
      period, amount, reason, shortage,
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
    `).run(key, kind, period, amount, planHash(snapshot), JSON.stringify(snapshot), reason, shortage ? JSON.stringify(shortage) : null, actor, now());
    return this.get(key)!;
  }

  approve(key: string, actor: string): RemittanceRow {
    const row = this.get(key);
    if (!row || row.status !== "draft") throw new Error("not draft");
    if (row.createdBy === actor) throw new Error("second approver required");
    if (this.db.prepare("UPDATE casino_remittances SET status='approved', approved_by=?, approved_at=? WHERE key=? AND status='draft'").run(actor, now(), key).changes !== 1) {
      throw new Error("approval race");
    }
    return this.get(key)!;
  }

  private assertFresh(row: RemittanceRow): void {
    if (row.kind === "remittance") {
      const snapshot = row.snapshot as unknown as RemittanceSnapshot;
      if (planHash(this.remittanceSnapshot(snapshot.bps, snapshot.minimumWorkingCapital, snapshot.fukuReserve, snapshot.period)) !== row.planHash) {
        throw new Error("remittance plan stale");
      }
      return;
    }
    const snapshot = row.snapshot;
    if (
      snapshot.houseBalance !== this.chips.balanceOf(HOUSE_HOLDER)
      || snapshot.reservedObligations !== this.reservations.totalReserved()
    ) throw new Error("bailout plan stale");
  }

  execute(key: string, actor: string): RemittanceRow {
    const row = this.get(key);
    if (!row || row.status !== "approved" || !row.approvedBy) throw new Error("not approved");
    this.assertFresh(row);
    const group = `casino:${row.kind}:${key}`;
    const dept = deptAccount(this.departmentKey);

    if (row.amount === 0) {
      if (this.db.prepare("UPDATE casino_remittances SET status='executed', executed_by=?, executed_at=?, chip_group_key=? WHERE key=? AND status='approved'").run(actor, now(), group, key).changes !== 1) {
        throw new Error("execute race");
      }
      return this.get(key)!;
    }

    let landTxId: number | null = null;
    this.chips.runGroup({ groupKey: group, kind: row.kind, actorId: actor }, () => {
      if (row.kind === "remittance") {
        this.chips.redeemToAccount(HOUSE_HOLDER, row.amount, dept, actor, `${group}:redeem`);
        landTxId = this.ledger.transfer({
          from: dept, to: TREASURY, amount: row.amount, type: "casino_remittance", actor,
          approvedBy: row.approvedBy!, reason: "casino remittance", idempotencyKey: `${group}:land`,
        }).tx.id;
      } else {
        landTxId = this.ledger.transfer({
          from: TREASURY, to: dept, amount: row.amount, type: "casino_bailout", actor,
          approvedBy: row.approvedBy!, reason: row.reason ?? "casino bailout", idempotencyKey: `${group}:land`,
        }).tx.id;
        this.chips.fundFromAccount(dept, row.amount, HOUSE_HOLDER, `${group}:fund`);
      }
      if (this.db.prepare(`
        UPDATE casino_remittances
        SET status='executed', executed_by=?, executed_at=?, land_tx_id=?, chip_group_key=?
        WHERE key=? AND status='approved'
      `).run(actor, now(), landTxId, group, key).changes !== 1) throw new Error("execute race");
    });
    return this.get(key)!;
  }

  /** Compatibility guard: an approvedBy argument is never a durable approval. */
  bailout(_key: string, _amount: number, _actor: string, _approvedBy: string): never {
    throw new Error("use bailoutDraft → approve → execute");
  }

  get(key: string): RemittanceRow | undefined {
    const row = this.db.prepare("SELECT * FROM casino_remittances WHERE key=?").get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id), key: String(row.key), kind: row.kind as "remittance" | "bailout", period: String(row.period), amount: Number(row.amount),
      status: row.status as RemittanceStatus, planHash: String(row.plan_hash), snapshot: JSON.parse(String(row.snapshot_json)) as Record<string, unknown>,
      reason: row.reason == null ? null : String(row.reason), shortage: row.shortage_json == null ? null : JSON.parse(String(row.shortage_json)) as Record<string, unknown>,
      createdBy: String(row.created_by), createdAt: Number(row.created_at), approvedBy: row.approved_by == null ? null : String(row.approved_by),
      approvedAt: row.approved_at == null ? null : Number(row.approved_at), executedBy: row.executed_by == null ? null : String(row.executed_by),
      executedAt: row.executed_at == null ? null : Number(row.executed_at), landTxId: row.land_tx_id == null ? null : Number(row.land_tx_id),
      chipGroupKey: row.chip_group_key == null ? null : String(row.chip_group_key),
    };
  }
}
