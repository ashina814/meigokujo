import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { CASINO_DEPARTMENT, CHIP_ESCROW, ETHER_ESCROW, HOUSE_HOLDER, isPlayerHolder } from "./exchange.js";
import { ChipTx } from "./chip-tx.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "./free-spins.js";
import { CasinoStatus, OPENING_RESET_SEAL } from "./status.js";

const OPENING_VERSION = "opening_v1";
const PROTECTED_TABLES = ["vip_members", "stocks", "casino_stats", "quarantine_assets"] as const;
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

export interface OpeningCompensationCandidate { userId: string; chips: number; requiredLand: number }
export interface OpeningBackupManifest {
  sqliteSha256: string;
  csv: Array<{ table: string; sha256: string; rows: number }>;
  createdAt: number;
}
export interface OpeningBackupAdapter {
  backup(input: { db: Database.Database; planHash: string; legacyTables: string[] }): Promise<OpeningBackupManifest>;
}
export interface OpeningDiscordAdapter { disableLegacyCasino(): Promise<void> }
export interface OpeningDataFingerprint { exists: boolean; rows: number; sha256: string }
export interface OpeningPlayerLandFingerprint { accounts: number; total: number; sha256: string }

export interface OpeningResetPlan {
  mode: "dry-run";
  planHash: string;
  blockers: string[];
  freeSpinClaims: { pendingIds: number[]; expected: number; actual: number; matches: boolean };
  activeEscrowRows: number;
  oldReserveLand: number;
  departmentLandBefore: number;
  playerLand: OpeningPlayerLandFingerprint;
  protectedRows: Record<string, number>;
  protectedData: Record<string, OpeningDataFingerprint>;
  compensation: { candidates: OpeningCompensationCandidate[]; requiredLand: number };
  legacyTables: Record<string, number>;
  configuration: CasinoOpeningConfig;
}

export interface OpeningApplyResult { planHash: string; manifest: OpeningBackupManifest; oldSettlementLandTxId: number; newInvestmentLandTxId: number }

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).sort().map((k) => `${JSON.stringify(k)}:${stable(r[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Local-only adapter. Production callers must explicitly construct it with an approved archive directory. */
export class FilesystemOpeningBackupAdapter implements OpeningBackupAdapter {
  constructor(private readonly directory: string) {}

  async backup(input: { db: Database.Database; planHash: string; legacyTables: string[] }): Promise<OpeningBackupManifest> {
    mkdirSync(this.directory, { recursive: true });
    const prefix = `casino-opening-${input.planHash}`;
    const sqlitePath = join(this.directory, `${prefix}.sqlite`);
    await (input.db as unknown as { backup(path: string): Promise<unknown> }).backup(sqlitePath);
    const csv = input.legacyTables.map((table) => {
      const rows = input.db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Array<Record<string, unknown>>;
      const columns = rows.length === 0
        ? (input.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((x) => x.name)
        : Object.keys(rows[0]!);
      const csvText = [columns.join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(","))].join("\n") + "\n";
      const file = join(this.directory, `${prefix}-${table}.csv`);
      writeFileSync(file, csvText, "utf8");
      return { table, sha256: sha256(csvText), rows: rows.length };
    });
    const manifest = { sqliteSha256: sha256(readFileSync(sqlitePath)), csv, createdAt: now() };
    writeFileSync(join(this.directory, `${prefix}-manifest.json`), JSON.stringify(manifest, null, 2), "utf8");
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
 * Formal-opening reset. `dryRun` deliberately performs SELECTs only; application requires
 * a freshly matching SHA-256 plan plus explicit backup, Discord and status adapters.
 */
export class CasinoOpeningReset {
  constructor(private readonly db: Database.Database, private readonly ledger = new Ledger(db), private readonly chipTx = new ChipTx(db)) {}

  configuration(): CasinoOpeningConfig | null {
    const row = this.db.prepare("SELECT * FROM casino_opening_configuration WHERE id=1").get() as Record<string, unknown> | undefined;
    if (!row || row.casino_opening_configured !== 1) return null;
    return {
      configured: true, casinoOpeningCapital: Number(row.casino_opening_capital), houseCapital: Number(row.casino_opening_house),
      jackpotCapital: Number(row.casino_opening_jackpot), reliefCapital: Number(row.casino_opening_relief),
      minimumWorkingCapital: Number(row.casino_min_working_capital), remittanceBps: Number(row.casino_remit_rate_bps),
    };
  }

  dryRun(configuration: CasinoOpeningConfig): OpeningResetPlan {
    this.assertConfig(configuration);
    const table = (name: string) => this.hasTable(name);
    const count = (name: string, where = "") => table(name)
      ? ((this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)} ${where}`).get() as { n: number }).n) : 0;
    const pending = table("casino_pending_free_spins")
      ? (this.db.prepare("SELECT id, jackpot_claim FROM casino_pending_free_spins WHERE status != 'settled' ORDER BY id").all() as Array<{ id: number; jackpot_claim: number }>) : [];
    const expected = pending.reduce((sum, row) => sum + row.jackpot_claim, 0);
    const actual = table("ether_balances")
      ? ((this.db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(FREE_SPIN_JACKPOT_CLAIMS_HOLDER) as { amount: number } | undefined)?.amount ?? 0) : 0;
    const balances = table("ether_balances")
      ? (this.db.prepare("SELECT user_id, amount FROM ether_balances WHERE amount > 0 ORDER BY user_id").all() as Array<{ user_id: string; amount: number }>) : [];
    const candidates = balances.filter((r) => isPlayerHolder(r.user_id)).map((r) => ({ userId: r.user_id, chips: r.amount, requiredLand: r.amount }));
    const legacyNames = ["casino_tables", "casino_markets", "casino_market_bets", "casino_escrow", "casino_tx", "casino_tx_groups", "casino_house_reservations"];
    const legacyTables = Object.fromEntries(legacyNames.map((name) => [name, count(name)]));
    const protectedData = this.protectedDataFingerprint();
    const protectedRows = Object.fromEntries(Object.entries(protectedData).map(([name, value]) => [name, value.rows]));
    const activeEscrowRows = count("casino_escrow");
    const oldReserveLand = this.ledger.balanceOf(ETHER_ESCROW);
    const departmentLandBefore = this.ledger.balanceOf(CASINO_DEPARTMENT);
    const playerLand = this.playerLandFingerprint();
    const blockers: string[] = [];
    if (pending.length) blockers.push(`未精算無料スピン: ${pending.length}`);
    if (expected !== actual) blockers.push(`無料スピンJP請求不一致: expected ${expected}, actual ${actual}`);
    if (activeEscrowRows) blockers.push(`active escrow rows: ${activeEscrowRows}`);
    if (candidates.length) blockers.push(`chip compensation candidates: ${candidates.length}, required Land ${candidates.reduce((s, x) => s + x.requiredLand, 0)}`);
    for (const [name, rows] of Object.entries(legacyTables)) if (rows && name !== "casino_tx" && name !== "casino_tx_groups") blockers.push(`legacy ${name}: ${rows}`);
    if (oldReserveLand < configuration.casinoOpeningCapital) blockers.push(`casino department source insufficient: ${oldReserveLand}/${configuration.casinoOpeningCapital}`);
    const unsigned = {
      mode: "dry-run" as const,
      blockers,
      freeSpinClaims: { pendingIds: pending.map((x) => x.id), expected, actual, matches: expected === actual },
      activeEscrowRows,
      oldReserveLand,
      departmentLandBefore,
      playerLand,
      protectedRows,
      protectedData,
      compensation: { candidates, requiredLand: candidates.reduce((s, x) => s + x.requiredLand, 0) },
      legacyTables,
      configuration,
    };
    return { ...unsigned, planHash: hash(unsigned) };
  }

  async apply(input: { configuration: CasinoOpeningConfig; planHash: string; actorId: string; backup: OpeningBackupAdapter; discord: OpeningDiscordAdapter; status: CasinoStatus }): Promise<OpeningApplyResult> {
    if (!input.status) throw new Error("opening reset status is required");
    if (this.db.prepare("SELECT 1 FROM casino_opening_reset_plans WHERE plan_hash=?").get(input.planHash)) throw new Error("opening reset plan already applied");
    const plan = this.dryRun(input.configuration);
    if (plan.planHash !== input.planHash) throw new Error("opening reset plan hash is stale");
    if (plan.blockers.length) throw new Error(`opening reset blocked: ${plan.blockers.join("; ")}`);

    // R0: 必ず同じDBの状態を opening_reset にしてから、バックアップやDiscord操作へ進む。
    input.status.beginOpeningReset(`opening reset: ${plan.planHash}`, input.actorId);
    const statusRow = this.db.prepare("SELECT status FROM casino_status WHERE id=1").get() as { status: string } | undefined;
    if (statusRow?.status !== "opening_reset" || input.status.current().status !== "opening_reset") {
      throw new Error("opening reset status must be bound to the same database");
    }

    // R1/R3 are outside the mutable reset transaction. They must be read-only with respect to protected data.
    const manifest = await input.backup.backup({ db: this.db, planHash: plan.planHash, legacyTables: Object.keys(plan.legacyTables) });
    if (!/^[a-f0-9]{64}$/.test(manifest.sqliteSha256) || manifest.csv.some((x) => !/^[a-f0-9]{64}$/.test(x.sha256))) throw new Error("invalid opening backup manifest");
    await input.discord.disableLegacyCasino();
    this.assertPreserved(plan.playerLand, plan.protectedData);

    let oldSettlementLandTxId = 0;
    let newInvestmentLandTxId = 0;
    this.db.transaction(() => {
      // R4/R5/R6: no active record survived preflight; delete only legacy casino state, never VIP/stocks/quarantine/free-spin claims.
      for (const name of ["casino_escrow", "casino_tables", "casino_markets", "casino_market_bets", "casino_house_reservations", "casino_tx", "casino_tx_groups"]) {
        if (this.hasTable(name)) this.db.prepare(`DELETE FROM ${quoteIdent(name)}`).run();
      }
      // R7: 旧準備口座は残高全額を賭博場部署へ清算する。R8: 新制度へは設定済み開業資本だけを出資する。
      this.ledger.ensureAccount(CASINO_DEPARTMENT, "system");
      const old = this.ledger.transfer({ from: ETHER_ESCROW, to: CASINO_DEPARTMENT, amount: plan.oldReserveLand, type: "ether_house_fund", actor: input.actorId, approvedBy: input.actorId, reason: "casino opening old settlement", refType: "casino_opening", refId: plan.planHash, idempotencyKey: `casino-opening:${plan.planHash}:old-settlement` });
      const fresh = this.ledger.transfer({ from: CASINO_DEPARTMENT, to: CHIP_ESCROW, amount: input.configuration.casinoOpeningCapital, type: "ether_house_fund", actor: input.actorId, approvedBy: input.actorId, reason: "casino opening new investment", refType: "casino_opening", refId: plan.planHash, idempotencyKey: `casino-opening:${plan.planHash}:new-investment` });
      oldSettlementLandTxId = old.tx.id;
      newInvestmentLandTxId = fresh.tx.id;
      // R9/R10: opening_v1 starts with classified operating capital only.
      this.db.prepare("DELETE FROM ether_balances").run();
      const put = this.db.prepare("INSERT INTO ether_balances (user_id,amount,updated_at) VALUES (?,?,?)");
      put.run(HOUSE_HOLDER, input.configuration.houseCapital, now());
      put.run("jackpot", input.configuration.jackpotCapital, now());
      put.run("relief", input.configuration.reliefCapital, now());
      if (!this.chipTx.captureOpening(OPENING_VERSION, [[HOUSE_HOLDER, input.configuration.houseCapital], ["jackpot", input.configuration.jackpotCapital], ["relief", input.configuration.reliefCapital]], { poolLand: input.configuration.casinoOpeningCapital, fromLedgerTxId: newInvestmentLandTxId })) throw new Error("opening_v1 already exists");
      this.saveConfiguration(input.configuration, input.actorId);
      this.verifyApplied(input.configuration, plan);
      this.db.prepare("INSERT INTO casino_opening_reset_plans (plan_hash,status,manifest_json,applied_by,applied_at) VALUES (?, 'applied', ?, ?, ?)").run(plan.planHash, JSON.stringify(manifest), input.actorId, now());
    })();
    // R14 is deliberately last. A status transition failure leaves the fully audited reset safely halted.
    if (!input.status.finishOpeningReset(`opening reset completed: ${plan.planHash}`, input.actorId, OPENING_RESET_SEAL).ok) {
      throw new Error("opening reset completed but could not reopen casino");
    }
    return { planHash: plan.planHash, manifest, oldSettlementLandTxId, newInvestmentLandTxId };
  }

  private hasTable(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
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

  private assertPreserved(playerLandBefore: OpeningPlayerLandFingerprint, protectedBefore: Record<string, OpeningDataFingerprint>): void {
    if (stable(this.playerLandFingerprint()) !== stable(playerLandBefore)) {
      throw new Error("opening reset must not change player Land");
    }
    if (stable(this.protectedDataFingerprint()) !== stable(protectedBefore)) {
      throw new Error("opening reset must not change protected casino data");
    }
  }

  private saveConfiguration(c: CasinoOpeningConfig, actor: string): void {
    this.db.prepare(`INSERT INTO casino_opening_configuration (id,casino_opening_capital,casino_opening_house,casino_opening_jackpot,casino_opening_relief,casino_min_working_capital,casino_remit_rate_bps,casino_opening_configured,configured_by,configured_at) VALUES (1,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET casino_opening_capital=excluded.casino_opening_capital, casino_opening_house=excluded.casino_opening_house, casino_opening_jackpot=excluded.casino_opening_jackpot, casino_opening_relief=excluded.casino_opening_relief, casino_min_working_capital=excluded.casino_min_working_capital, casino_remit_rate_bps=excluded.casino_remit_rate_bps, casino_opening_configured=1, configured_by=excluded.configured_by, configured_at=excluded.configured_at`).run(c.casinoOpeningCapital, c.houseCapital, c.jackpotCapital, c.reliefCapital, c.minimumWorkingCapital, c.remittanceBps, actor, now());
  }

  private verifyApplied(c: CasinoOpeningConfig, plan: OpeningResetPlan): void {
    const sum = (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM ether_balances WHERE user_id IN ('house','jackpot','relief')").get() as { n: number }).n;
    const reserve = this.ledger.balanceOf(CHIP_ESCROW);
    const oldReserve = this.ledger.balanceOf(ETHER_ESCROW);
    const department = this.ledger.balanceOf(CASINO_DEPARTMENT);
    const expectedDepartment = plan.departmentLandBefore + plan.oldReserveLand - c.casinoOpeningCapital;
    const version = this.chipTx.currentVersion();
    if (
      sum !== c.casinoOpeningCapital
      || reserve !== c.casinoOpeningCapital
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

  private assertConfig(c: CasinoOpeningConfig): void {
    for (const [key, value] of Object.entries(c)) if (key !== "configured" && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`invalid opening configuration: ${key}`);
    if (c.casinoOpeningCapital <= 0 || c.houseCapital <= 0 || c.houseCapital + c.jackpotCapital + c.reliefCapital !== c.casinoOpeningCapital) throw new Error("opening house + jackpot + relief must equal capital");
    if (c.remittanceBps > 10_000) throw new Error("remittanceBps must be 0..10000");
  }
}
