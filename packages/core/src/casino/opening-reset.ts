import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Ledger, TREASURY, type TxRow } from "../ledger/service.js";
import {
  CASINO_DEPARTMENT,
  CHIP_ESCROW,
  ETHER_APPROVER,
  ETHER_ESCROW,
  HOUSE_HOLDER,
  isPlayerHolder,
} from "./exchange.js";
import { ChipTx, LEGACY_OPENING_VERSION, type ChipBalanceMismatch } from "./chip-tx.js";
import { ESCROW_QUARANTINE } from "./escrow.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "./free-spins.js";
import { CasinoStatus, OPENING_RESET_SEAL } from "./status.js";

const OPENING_VERSION = "opening_v1";
const PROTECTED_TABLES = ["casino_vip", "casino_stocks", "casino_holdings", "casino_stats"] as const;
const LEGACY_DATA_TABLES = [
  "ether_balances",
  "casino_tables",
  "casino_markets",
  "casino_market_bets",
  "casino_escrow",
  "casino_tx",
  "casino_tx_groups",
  "casino_house_reservations",
  "casino_pending_free_spins",
  "casino_vip",
  "casino_stocks",
  "casino_holdings",
  "casino_stats",
  "casino_chip_opening_balances",
  "casino_chip_opening_versions",
  "casino_chinchiro_preholds",
  "casino_chip_activity",
  "casino_chip_external_confirmations",
  "casino_chip_refund_sagas",
  "casino_chip_refund_saga_targets",
] as const;
const MUST_BE_EMPTY_TABLES = [
  "casino_tables",
  "casino_markets",
  "casino_market_bets",
  "casino_escrow",
  "casino_house_reservations",
] as const;
const now = () => Math.floor(Date.now() / 1000);

export interface CasinoOpeningConfig {
  configured: true;
  casinoOpeningCapital: number;
  houseCapital: number;
  jackpotCapital: number;
  reliefCapital: number;
  minimumWorkingCapital: number;
  remittanceBps: number;
}

export interface OpeningCompensationCandidate {
  userId: string;
  chips: number;
  requiredLand: number;
}

export interface OpeningBackupManifest {
  sqliteSha256: string;
  csv: Array<{ table: string; sha256: string; rows: number }>;
  createdAt: number;
}

export interface OpeningBackupAdapter {
  backup(input: { db: Database.Database; planHash: string; legacyTables: string[] }): Promise<OpeningBackupManifest>;
}

export interface OpeningDiscordAdapter {
  disableLegacyCasino(): Promise<void>;
}

export interface OpeningDataFingerprint {
  exists: boolean;
  rows: number;
  sha256: string;
}

export interface OpeningPlayerLandFingerprint {
  accounts: number;
  total: number;
  sha256: string;
}

export interface OpeningProtectedFindings {
  activeVip: Array<{ userId: string; expiresAt: number }>;
  stockHoldings: Array<{ userId: string; stockId: string; shares: number; avgCost: number; boughtAt: number }>;
  casinoStats: Array<{
    userId: string;
    games: number;
    wins: number;
    losses: number;
    totalWagered: number;
    totalEarned: number;
    totalLost: number;
    biggestWin: number;
    bestWinStreak: number;
  }>;
  quarantineChips: number;
}

export interface OpeningReserveAuditRow {
  id: number;
  idempotencyKey: string;
  type: string;
  from: string;
  to: string;
  amount: number;
  actor: string;
  approvedBy: string | null;
  groupKey: string | null;
  valid: boolean;
  problem: string | null;
}

export interface OpeningLegacyIntegrity {
  version: string;
  chipBalancesOk: boolean;
  chipBalanceMismatches: ChipBalanceMismatch[];
  baseline: { poolLand: number; fromLedgerTxId: number } | null;
  reserveTransactions: OpeningReserveAuditRow[];
  expectedReserveLand: number | null;
  actualReserveLand: number;
  reserveLandMatches: boolean;
  ok: boolean;
}

export interface OpeningResetPlan {
  mode: "dry-run";
  planHash: string;
  blockers: string[];
  freeSpinClaims: { pendingIds: number[]; expected: number; actual: number; matches: boolean };
  activeEscrowRows: number;
  oldReserveLand: number;
  departmentLandBefore: number;
  openingSourceLand: number;
  legacyIntegrity: OpeningLegacyIntegrity;
  playerLand: OpeningPlayerLandFingerprint;
  protectedRows: Record<string, number>;
  protectedData: Record<string, OpeningDataFingerprint>;
  protectedFindings: OpeningProtectedFindings;
  compensation: { candidates: OpeningCompensationCandidate[]; requiredLand: number };
  legacyTables: Record<string, number>;
  archiveTables: string[];
  configuration: CasinoOpeningConfig;
}

export interface OpeningApplyResult {
  planHash: string;
  manifest: OpeningBackupManifest;
  oldSettlementLandTxId: number | null;
  newInvestmentLandTxId: number;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Local-only adapter. Production callers must explicitly construct it with an approved archive directory. */
export class FilesystemOpeningBackupAdapter implements OpeningBackupAdapter {
  constructor(private readonly directory: string) {}

  async backup(input: {
    db: Database.Database;
    planHash: string;
    legacyTables: string[];
  }): Promise<OpeningBackupManifest> {
    mkdirSync(this.directory, { recursive: true });
    const prefix = `casino-opening-${input.planHash}`;
    const sqlitePath = join(this.directory, `${prefix}.sqlite`);
    await (input.db as unknown as { backup(path: string): Promise<unknown> }).backup(sqlitePath);
    const csv = input.legacyTables.map((table) => {
      const rows = input.db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Array<Record<string, unknown>>;
      const columns = rows.length === 0
        ? (input.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((column) => column.name)
        : Object.keys(rows[0]!);
      const csvText = [
        columns.join(","),
        ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
      ].join("\n") + "\n";
      const file = join(this.directory, `${prefix}-${table}.csv`);
      writeFileSync(file, csvText, "utf8");
      return { table, sha256: sha256(csvText), rows: rows.length };
    });
    const manifest = { sqliteSha256: sha256(readFileSync(sqlitePath)), csv, createdAt: now() };
    writeFileSync(
      join(this.directory, `${prefix}-manifest.json`),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    return manifest;
  }
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("unsafe table name");
  return `"${value}"`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Formal-opening reset. `dryRun` performs SELECTs only. The caller must pass the exact shared
 * Ledger and ChipTx instances used by the running casino; no private fallback instance exists.
 */
export class CasinoOpeningReset {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly chipTx: ChipTx,
  ) {}

  configuration(): CasinoOpeningConfig | null {
    const row = this.db.prepare("SELECT * FROM casino_opening_configuration WHERE id=1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row || row.casino_opening_configured !== 1) return null;
    return {
      configured: true,
      casinoOpeningCapital: Number(row.casino_opening_capital),
      houseCapital: Number(row.casino_opening_house),
      jackpotCapital: Number(row.casino_opening_jackpot),
      reliefCapital: Number(row.casino_opening_relief),
      minimumWorkingCapital: Number(row.casino_min_working_capital),
      remittanceBps: Number(row.casino_remit_rate_bps),
    };
  }

  dryRun(configuration: CasinoOpeningConfig): OpeningResetPlan {
    this.assertConfig(configuration);
    const count = (name: string) => this.hasTable(name)
      ? (this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number }).n
      : 0;
    const pending = this.hasTable("casino_pending_free_spins")
      ? this.db.prepare(
          "SELECT id, jackpot_claim FROM casino_pending_free_spins WHERE status != 'settled' ORDER BY id",
        ).all() as Array<{ id: number; jackpot_claim: number }>
      : [];
    const expected = pending.reduce((sum, row) => sum + row.jackpot_claim, 0);
    const actual = this.holderBalance(FREE_SPIN_JACKPOT_CLAIMS_HOLDER);
    const balances = this.hasTable("ether_balances")
      ? this.db.prepare(
          "SELECT user_id, amount FROM ether_balances WHERE amount > 0 ORDER BY user_id",
        ).all() as Array<{ user_id: string; amount: number }>
      : [];
    const candidates = balances
      .filter((row) => isPlayerHolder(row.user_id))
      .map((row) => ({ userId: row.user_id, chips: row.amount, requiredLand: row.amount }));
    const legacyTables = Object.fromEntries(
      LEGACY_DATA_TABLES.filter((name) => this.hasTable(name)).map((name) => [name, count(name)]),
    );
    const archiveTables = this.archiveTableNames();
    const protectedData = this.protectedDataFingerprint();
    const protectedRows = Object.fromEntries(
      Object.entries(protectedData).map(([name, value]) => [name, value.rows]),
    );
    const protectedFindings = this.protectedFindings();
    const activeEscrowRows = count("casino_escrow");
    const oldReserveLand = this.ledger.balanceOf(ETHER_ESCROW);
    const departmentLandBefore = this.ledger.balanceOf(CASINO_DEPARTMENT);
    const openingSourceLand = oldReserveLand + departmentLandBefore;
    const legacyIntegrity = this.legacyIntegrity();
    const playerLand = this.playerLandFingerprint();
    const compensationRequired = candidates.reduce((sum, candidate) => sum + candidate.requiredLand, 0);
    const blockers: string[] = [];

    if (pending.length) blockers.push(`未精算無料スピン: ${pending.length}`);
    if (expected !== actual) {
      blockers.push(`無料スピンJP請求不一致: expected ${expected}, actual ${actual}`);
    }
    if (!legacyIntegrity.ok) blockers.push("旧制度のチップ検算または準備口座経路監査が不一致");
    if (activeEscrowRows) blockers.push(`active escrow rows: ${activeEscrowRows}`);
    if (candidates.length) {
      blockers.push(`chip compensation candidates: ${candidates.length}, required Land ${compensationRequired}`);
    }
    if (protectedFindings.activeVip.length) {
      blockers.push(`active VIP compensation candidates: ${protectedFindings.activeVip.length}`);
    }
    if (protectedFindings.stockHoldings.length) {
      blockers.push(`stock holding compensation candidates: ${protectedFindings.stockHoldings.length}`);
    }
    if (protectedFindings.casinoStats.length) {
      blockers.push(`casino stats preservation candidates: ${protectedFindings.casinoStats.length}`);
    }
    if (protectedFindings.quarantineChips > 0) {
      blockers.push(`quarantine assets require manual attribution: ${protectedFindings.quarantineChips}`);
    }
    for (const name of MUST_BE_EMPTY_TABLES) {
      const rows = legacyTables[name] ?? 0;
      if (rows > 0) blockers.push(`legacy ${name}: ${rows}`);
    }
    if (openingSourceLand < configuration.casinoOpeningCapital) {
      blockers.push(
        `casino department source insufficient: ${openingSourceLand}/${configuration.casinoOpeningCapital}`,
      );
    }

    const unsigned = {
      mode: "dry-run" as const,
      blockers,
      freeSpinClaims: {
        pendingIds: pending.map((row) => row.id),
        expected,
        actual,
        matches: expected === actual,
      },
      activeEscrowRows,
      oldReserveLand,
      departmentLandBefore,
      openingSourceLand,
      legacyIntegrity,
      playerLand,
      protectedRows,
      protectedData,
      protectedFindings,
      compensation: { candidates, requiredLand: compensationRequired },
      legacyTables,
      archiveTables,
      configuration,
    };
    return { ...unsigned, planHash: hash(unsigned) };
  }

  async apply(input: {
    configuration: CasinoOpeningConfig;
    planHash: string;
    actorId: string;
    backup: OpeningBackupAdapter;
    discord: OpeningDiscordAdapter;
    status: CasinoStatus;
  }): Promise<OpeningApplyResult> {
    if (!input.status) throw new Error("opening reset status is required");
    if (this.db.prepare("SELECT 1 FROM casino_opening_reset_plans WHERE plan_hash=?").get(input.planHash)) {
      throw new Error("opening reset plan already applied");
    }
    const plan = this.dryRun(input.configuration);
    if (plan.planHash !== input.planHash) throw new Error("opening reset plan hash is stale");
    if (plan.blockers.length) throw new Error(`opening reset blocked: ${plan.blockers.join("; ")}`);

    input.status.beginOpeningReset(`opening reset: ${plan.planHash}`, input.actorId);
    const statusRow = this.db.prepare("SELECT status FROM casino_status WHERE id=1").get() as
      | { status: string }
      | undefined;
    if (statusRow?.status !== "opening_reset" || input.status.current().status !== "opening_reset") {
      throw new Error("opening reset status must be bound to the same database");
    }

    const archiveCounts = this.tableCounts(plan.archiveTables);
    const manifest = await input.backup.backup({
      db: this.db,
      planHash: plan.planHash,
      legacyTables: plan.archiveTables,
    });
    this.assertManifest(manifest, archiveCounts);
    await input.discord.disableLegacyCasino();
    if (this.dryRun(input.configuration).planHash !== plan.planHash) {
      throw new Error("opening reset plan hash is stale after adapters");
    }

    let oldSettlementLandTxId: number | null = null;
    let newInvestmentLandTxId = 0;
    this.db.transaction(() => {
      if (this.dryRun(input.configuration).planHash !== plan.planHash) {
        throw new Error("opening reset plan hash is stale before apply");
      }
      for (const name of MUST_BE_EMPTY_TABLES) {
        if (this.hasTable(name)) this.db.prepare(`DELETE FROM ${quoteIdent(name)}`).run();
      }
      for (const name of ["casino_tx", "casino_tx_groups"]) {
        if (this.hasTable(name)) this.db.prepare(`DELETE FROM ${quoteIdent(name)}`).run();
      }

      this.ledger.ensureAccount(CASINO_DEPARTMENT, "system");
      this.ledger.ensureAccount(CHIP_ESCROW, "system");
      if (plan.oldReserveLand > 0) {
        const old = this.ledger.transfer({
          from: ETHER_ESCROW,
          to: CASINO_DEPARTMENT,
          amount: plan.oldReserveLand,
          type: "ether_house_fund",
          actor: input.actorId,
          approvedBy: input.actorId,
          reason: "casino opening old settlement",
          refType: "casino_opening",
          refId: plan.planHash,
          idempotencyKey: `casino-opening:${plan.planHash}:old-settlement`,
        });
        oldSettlementLandTxId = old.tx.id;
      }
      const fresh = this.ledger.transfer({
        from: CASINO_DEPARTMENT,
        to: CHIP_ESCROW,
        amount: input.configuration.casinoOpeningCapital,
        type: "ether_house_fund",
        actor: input.actorId,
        approvedBy: input.actorId,
        reason: "casino opening new investment",
        refType: "casino_opening",
        refId: plan.planHash,
        idempotencyKey: `casino-opening:${plan.planHash}:new-investment`,
      });
      newInvestmentLandTxId = fresh.tx.id;

      this.db.prepare("DELETE FROM ether_balances").run();
      const put = this.db.prepare("INSERT INTO ether_balances (user_id,amount,updated_at) VALUES (?,?,?)");
      put.run(HOUSE_HOLDER, input.configuration.houseCapital, now());
      put.run("jackpot", input.configuration.jackpotCapital, now());
      put.run("relief", input.configuration.reliefCapital, now());
      if (!this.chipTx.captureOpening(
        OPENING_VERSION,
        [
          [HOUSE_HOLDER, input.configuration.houseCapital],
          ["jackpot", input.configuration.jackpotCapital],
          ["relief", input.configuration.reliefCapital],
        ],
        { poolLand: input.configuration.casinoOpeningCapital, fromLedgerTxId: newInvestmentLandTxId },
      )) {
        throw new Error("opening_v1 already exists");
      }
      this.saveConfiguration(input.configuration, input.actorId);
      this.verifyApplied(input.configuration, plan);
      this.db.prepare(
        `INSERT INTO casino_opening_reset_plans
         (plan_hash,status,manifest_json,applied_by,applied_at)
         VALUES (?, 'applied', ?, ?, ?)`,
      ).run(plan.planHash, JSON.stringify(manifest), input.actorId, now());
    }).immediate();

    if (!input.status.finishOpeningReset(
      `opening reset completed: ${plan.planHash}`,
      input.actorId,
      OPENING_RESET_SEAL,
    ).ok) {
      throw new Error("opening reset completed but could not reopen casino");
    }
    return { planHash: plan.planHash, manifest, oldSettlementLandTxId, newInvestmentLandTxId };
  }

  private archiveTableNames(): string[] {
    const names = this.db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND (name LIKE 'casino_%' OR name IN ('ether_balances','settings'))
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    return names.map((row) => row.name);
  }

  private tableCounts(names: readonly string[]): Record<string, number> {
    return Object.fromEntries(names.map((name) => [
      name,
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number }).n,
    ]));
  }

  private assertManifest(manifest: OpeningBackupManifest, expectedRows: Record<string, number>): void {
    if (!/^[a-f0-9]{64}$/.test(manifest.sqliteSha256)) {
      throw new Error("invalid opening backup manifest sqlite hash");
    }
    const rows = new Map<string, { sha256: string; rows: number }>();
    for (const entry of manifest.csv) {
      if (rows.has(entry.table)) throw new Error(`duplicate CSV in opening manifest: ${entry.table}`);
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error(`invalid opening backup manifest CSV hash: ${entry.table}`);
      }
      rows.set(entry.table, entry);
    }
    const expectedNames = Object.keys(expectedRows).sort();
    const actualNames = [...rows.keys()].sort();
    if (stable(expectedNames) !== stable(actualNames)) {
      throw new Error("opening backup manifest table set mismatch");
    }
    for (const [table, count] of Object.entries(expectedRows)) {
      if (rows.get(table)?.rows !== count) {
        throw new Error(`opening backup manifest row count mismatch: ${table}`);
      }
    }
  }

  private legacyIntegrity(): OpeningLegacyIntegrity {
    const version = this.chipTx.currentVersion();
    const balanceCheck = this.chipTx.verifyBalances(version);
    const baseline = this.chipTx.openingLandBaseline(version);
    const actualReserveLand = this.ledger.balanceOf(ETHER_ESCROW);
    const reserveTransactions = baseline === null
      ? []
      : this.reserveTransactionsAfter(baseline.fromLedgerTxId);
    const expectedReserveLand = baseline === null
      ? null
      : baseline.poolLand + reserveTransactions.reduce((sum, row) => {
          if (!row.valid) return sum;
          return sum + (row.to === ETHER_ESCROW ? row.amount : -row.amount);
        }, 0);
    const reserveLandMatches = expectedReserveLand !== null && expectedReserveLand === actualReserveLand;
    const ok = version === LEGACY_OPENING_VERSION
      && balanceCheck.ok
      && baseline !== null
      && reserveTransactions.every((row) => row.valid)
      && reserveLandMatches;
    return {
      version,
      chipBalancesOk: balanceCheck.ok,
      chipBalanceMismatches: balanceCheck.mismatches,
      baseline,
      reserveTransactions,
      expectedReserveLand,
      actualReserveLand,
      reserveLandMatches,
      ok,
    };
  }

  private reserveTransactionsAfter(fromLedgerTxId: number): OpeningReserveAuditRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM transactions
       WHERE id > ? AND (from_account=? OR to_account=?)
       ORDER BY id`,
    ).all(fromLedgerTxId, ETHER_ESCROW, ETHER_ESCROW) as TxRow[];
    return rows.map((row) => this.auditReserveTransaction(row));
  }

  private auditReserveTransaction(row: TxRow): OpeningReserveAuditRow {
    const direction = row.to_account === ETHER_ESCROW ? "in" : "out";
    const counterparty = direction === "in" ? row.from_account : row.to_account;
    const expected = new Map<string, { direction: "in" | "out"; counterparty: "user" | "system" | "treasury" }>([
      ["ether_buy", { direction: "in", counterparty: "user" }],
      ["ether_house_fund", { direction: "in", counterparty: "system" }],
      ["ether_sell", { direction: "out", counterparty: "user" }],
      ["ether_settle", { direction: "out", counterparty: "system" }],
      ["ether_burn", { direction: "out", counterparty: "treasury" }],
      ["chip_deposit", { direction: "in", counterparty: "user" }],
      ["chip_fund", { direction: "in", counterparty: "system" }],
      ["chip_redeem", { direction: "out", counterparty: "user" }],
      ["chip_settle", { direction: "out", counterparty: "system" }],
    ]);
    const rule = expected.get(row.type);
    let problem: string | null = null;
    if (!rule) problem = `unknown_type:${row.type}`;
    else if (rule.direction !== direction) problem = `wrong_direction:${direction}`;
    else if (rule.counterparty === "treasury" && counterparty !== TREASURY) problem = "wrong_treasury";
    else if (rule.counterparty === "user" && !counterparty.startsWith("user:")) problem = "wrong_user_counterparty";
    else if (rule.counterparty === "system" && this.ledger.getAccount(counterparty)?.kind !== "system") {
      problem = "wrong_system_counterparty";
    }
    if (!problem && row.approved_by !== ETHER_APPROVER) problem = "wrong_approver";
    const groupKey = this.groupKeyForLandTransaction(row.idempotency_key);
    if (!problem && !groupKey) problem = "missing_chip_group";
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      type: row.type,
      from: row.from_account,
      to: row.to_account,
      amount: row.amount,
      actor: row.actor_id,
      approvedBy: row.approved_by,
      groupKey,
      valid: problem === null,
      problem,
    };
  }

  private groupKeyForLandTransaction(idempotencyKey: string): string | null {
    const candidates = [
      idempotencyKey,
      idempotencyKey.replace(/:(?:land|burn|sweep)$/, ""),
    ];
    for (const candidate of candidates) {
      if (this.chipTx.hasGroup(candidate)) return candidate;
    }
    return null;
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  private holderBalance(holderId: string): number {
    if (!this.hasTable("ether_balances")) return 0;
    return (this.db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(holderId) as
      | { amount: number }
      | undefined)?.amount ?? 0;
  }

  private tableFingerprint(name: string): OpeningDataFingerprint {
    if (!this.hasTable(name)) return { exists: false, rows: 0, sha256: hash([]) };
    const rows = this.db.prepare(`SELECT * FROM ${quoteIdent(name)}`).all() as Array<Record<string, unknown>>;
    const canonicalRows = rows.map((row) => stable(row)).sort();
    return { exists: true, rows: rows.length, sha256: hash(canonicalRows) };
  }

  private protectedDataFingerprint(): Record<string, OpeningDataFingerprint> {
    return Object.fromEntries(PROTECTED_TABLES.map((name) => [name, this.tableFingerprint(name)]));
  }

  private protectedFindings(): OpeningProtectedFindings {
    const activeVip = this.hasTable("casino_vip")
      ? (this.db.prepare(
          "SELECT user_id, expires_at FROM casino_vip WHERE expires_at > ? ORDER BY user_id",
        ).all(now()) as Array<{ user_id: string; expires_at: number }>).map((row) => ({
          userId: row.user_id,
          expiresAt: row.expires_at,
        }))
      : [];
    const stockHoldings = this.hasTable("casino_holdings")
      ? (this.db.prepare(
          `SELECT user_id, stock_id, shares, avg_cost, bought_at
           FROM casino_holdings WHERE shares > 0 ORDER BY user_id, stock_id`,
        ).all() as Array<{
          user_id: string;
          stock_id: string;
          shares: number;
          avg_cost: number;
          bought_at: number;
        }>).map((row) => ({
          userId: row.user_id,
          stockId: row.stock_id,
          shares: row.shares,
          avgCost: row.avg_cost,
          boughtAt: row.bought_at,
        }))
      : [];
    const casinoStats = this.hasTable("casino_stats")
      ? (this.db.prepare(
          `SELECT user_id, games, wins, losses, total_wagered, total_earned, total_lost,
                  biggest_win, best_win_streak
           FROM casino_stats
           WHERE games > 0 OR total_wagered > 0 OR total_earned > 0 OR total_lost > 0
              OR biggest_win > 0 OR best_win_streak > 0
           ORDER BY user_id`,
        ).all() as Array<{
          user_id: string;
          games: number;
          wins: number;
          losses: number;
          total_wagered: number;
          total_earned: number;
          total_lost: number;
          biggest_win: number;
          best_win_streak: number;
        }>).map((row) => ({
          userId: row.user_id,
          games: row.games,
          wins: row.wins,
          losses: row.losses,
          totalWagered: row.total_wagered,
          totalEarned: row.total_earned,
          totalLost: row.total_lost,
          biggestWin: row.biggest_win,
          bestWinStreak: row.best_win_streak,
        }))
      : [];
    return {
      activeVip,
      stockHoldings,
      casinoStats,
      quarantineChips: this.holderBalance(ESCROW_QUARANTINE),
    };
  }

  private playerLandFingerprint(): OpeningPlayerLandFingerprint {
    const rows = this.db.prepare(
      `SELECT a.id AS account_id, COALESCE(b.amount, 0) AS amount
       FROM accounts a
       LEFT JOIN balances b ON b.account_id = a.id
       WHERE a.kind = 'user'
       ORDER BY a.id`,
    ).all() as Array<{ account_id: string; amount: number }>;
    return {
      accounts: rows.length,
      total: rows.reduce((sum, row) => sum + Number(row.amount), 0),
      sha256: hash(rows.map((row) => [row.account_id, Number(row.amount)])),
    };
  }

  private assertPreserved(
    playerLandBefore: OpeningPlayerLandFingerprint,
    protectedBefore: Record<string, OpeningDataFingerprint>,
  ): void {
    if (stable(this.playerLandFingerprint()) !== stable(playerLandBefore)) {
      throw new Error("opening reset must not change player Land");
    }
    if (stable(this.protectedDataFingerprint()) !== stable(protectedBefore)) {
      throw new Error("opening reset must not change protected casino data");
    }
  }

  private saveConfiguration(configuration: CasinoOpeningConfig, actor: string): void {
    this.db.prepare(
      `INSERT INTO casino_opening_configuration
       (id,casino_opening_capital,casino_opening_house,casino_opening_jackpot,
        casino_opening_relief,casino_min_working_capital,casino_remit_rate_bps,
        casino_opening_configured,configured_by,configured_at)
       VALUES (1,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(id) DO UPDATE SET
         casino_opening_capital=excluded.casino_opening_capital,
         casino_opening_house=excluded.casino_opening_house,
         casino_opening_jackpot=excluded.casino_opening_jackpot,
         casino_opening_relief=excluded.casino_opening_relief,
         casino_min_working_capital=excluded.casino_min_working_capital,
         casino_remit_rate_bps=excluded.casino_remit_rate_bps,
         casino_opening_configured=1,
         configured_by=excluded.configured_by,
         configured_at=excluded.configured_at`,
    ).run(
      configuration.casinoOpeningCapital,
      configuration.houseCapital,
      configuration.jackpotCapital,
      configuration.reliefCapital,
      configuration.minimumWorkingCapital,
      configuration.remittanceBps,
      actor,
      now(),
    );
  }

  private verifyApplied(configuration: CasinoOpeningConfig, plan: OpeningResetPlan): void {
    const sum = (this.db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS n FROM ether_balances WHERE user_id IN ('house','jackpot','relief')",
    ).get() as { n: number }).n;
    const reserve = this.ledger.balanceOf(CHIP_ESCROW);
    const oldReserve = this.ledger.balanceOf(ETHER_ESCROW);
    const department = this.ledger.balanceOf(CASINO_DEPARTMENT);
    const expectedDepartment = plan.openingSourceLand - configuration.casinoOpeningCapital;
    const version = this.chipTx.currentVersion();
    if (
      sum !== configuration.casinoOpeningCapital
      || reserve !== configuration.casinoOpeningCapital
      || oldReserve !== 0
      || department !== expectedDepartment
      || version !== OPENING_VERSION
      || (this.hasTable("casino_escrow") && this.db.prepare("SELECT 1 FROM casino_escrow LIMIT 1").get())
      || plan.planHash.length !== 64
    ) {
      throw new Error("opening reset V1-V7 verification failed");
    }
    this.assertPreserved(plan.playerLand, plan.protectedData);
  }

  private assertConfig(configuration: CasinoOpeningConfig): void {
    for (const [key, value] of Object.entries(configuration)) {
      if (key !== "configured" && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`invalid opening configuration: ${key}`);
      }
    }
    if (
      configuration.casinoOpeningCapital <= 0
      || configuration.houseCapital <= 0
      || configuration.houseCapital + configuration.jackpotCapital + configuration.reliefCapital
        !== configuration.casinoOpeningCapital
    ) {
      throw new Error("opening house + jackpot + relief must equal capital");
    }
    if (configuration.remittanceBps > 10_000) {
      throw new Error("remittanceBps must be 0..10000");
    }
  }
}
