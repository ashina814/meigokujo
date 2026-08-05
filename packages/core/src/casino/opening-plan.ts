import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import type { Settings } from "../settings/service.js";
import { Departments, deptAccount } from "../departments/service.js";
import {
  ChipTx,
  LEGACY_OPENING_VERSION,
  FORMAL_OPENING_VERSION,
  type ChipBalanceMismatch,
} from "./chip-tx.js";
import { ChipLedger, ETHER_ESCROW, CHIP_ESCROW, isPlayerHolder } from "./chip-ledger.js";
import { CasinoChipAssets, type EscrowAssetInspection } from "./chip-assets.js";
import { CasinoIntegrity, type CasinoCheckResult } from "./integrity.js";
import { CasinoStatus, type CasinoStatusValue } from "./status.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "./free-spins.js";
import { ESCROW_QUARANTINE } from "./escrow.js";
import {
  CASINO_TABLE_CLASSIFICATION,
  KNOWN_CASINO_TABLE_NAMES,
  type CasinoTableClassification,
} from "./opening-tables.js";
import {
  canonicalHash,
  checkedAddAll,
  playerLandFingerprint,
  schemaFingerprint,
  tableExists,
  tableFingerprint,
  tableRowCount,
  UnsafeAmountArithmeticError,
  type PlayerLandFingerprint,
  type TableContentFingerprint,
} from "./opening-canonical.js";
import { readCasinoOpeningConfig, type CasinoOpeningConfig } from "./opening-settings.js";

const DEPARTMENT_KEY = "賭博場";

/**
 * preflight（dry-run）中に判明した桁あふれを、例外で落とすのではなく構造化blockerへ
 * 変換する（CLAUDE.md監査ブロッカー8）。transaction中の同種チェックとは違い、
 * dry-runは他の不備も併せて報告できることが要件なので、ここでは投げさせない。
 * 失敗時は呼び出し側が安全なplaceholder値（0）を使えるよう`null`を返す
 * （blockerが1件でもあればapply()はそもそも先へ進めないため、値そのものは意味を持たない）。
 */
function preflightCheckedAdd(blockers: OpeningBlocker[], label: string, values: number[]): number | null {
  try {
    return checkedAddAll(values, label);
  } catch (e) {
    if (e instanceof UnsafeAmountArithmeticError) {
      blockers.push({ category: "arithmetic", code: "unsafe_amount_arithmetic", message: e.message });
      return null;
    }
    throw e;
  }
}

/**
 * PR10未完了義務の判定はwhitelist方式にする（CLAUDE.md監査ブロッカー2）。
 * 「未完了とみなす値を列挙する」のではなく「安全に初期化してよい終端状態を列挙し、
 * それ以外はすべてblocker」にする。こうすると、schemaのCHECK制約に載っている値を
 * 見落とす（例: 旧実装は`casino_chip_refund_sagas.status='blocked'`を見ていなかった）
 * ことも、CHECK制約の範囲外の未知の値（DB破損・将来のschema変更）も、同じ1つの
 * ロジックでfail-closedにできる。
 */
const EXTERNAL_CONFIRMATION_STATUSES: ReadonlySet<string> = new Set([
  "pending", "executing", "completed", "cancelled", "expired",
]);
const EXTERNAL_CONFIRMATION_SAFE_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "expired"]);

const REFUND_SAGA_STATUSES: ReadonlySet<string> = new Set(["draft", "executing", "completed", "blocked", "cancelled"]);
const REFUND_SAGA_SAFE_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled"]);

const REFUND_SAGA_TARGET_STATUSES: ReadonlySet<string> = new Set(["pending", "completed", "failed", "blocked"]);
const REFUND_SAGA_TARGET_SAFE_STATUSES: ReadonlySet<string> = new Set(["completed"]);

const PENDING_FREE_SPIN_STATUSES: ReadonlySet<string> = new Set(["pending", "processing", "settled"]);
const PENDING_FREE_SPIN_SAFE_STATUSES: ReadonlySet<string> = new Set(["settled"]);

const MARKET_ALL_STATUSES: ReadonlySet<string> = new Set([
  "open", "closed", "reported", "disputed", "settled", "void", "frozen",
]);
const MARKET_SAFE_STATUSES: ReadonlySet<string> = new Set(["settled", "void"]);

/** JSONカラムが非nullなのに壊れている場合はtrue（"safe"を名乗らせない） */
function isMalformedJson(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

/** R7/R8が使う部署アカウント。1箇所に一本化する（現行mainでは apps/bot 側のローカル定数しか無かった） */
export const CASINO_DEPARTMENT_KEY = DEPARTMENT_KEY;
export const CASINO_DEPARTMENT_ACCOUNT = deptAccount(DEPARTMENT_KEY);

export type BlockerCategory =
  | "config"
  | "protected_asset"
  | "pr10_obligation"
  | "pr11_obligation"
  | "escrow_reservation"
  | "market"
  | "integrity"
  | "schema"
  | "opening_version"
  | "quarantine"
  | "backup_source"
  | "arithmetic";

export interface OpeningBlocker {
  category: BlockerCategory;
  code: string;
  message: string;
  /** 関連するuserIdがあれば（対象者別報告のため） */
  userId?: string;
}

export interface ProtectedAssetFinding {
  userId: string;
  assetType:
    | "vip"
    | "stock_holding"
    | "casino_stats"
    | "item"
    | "active_effect"
    | "legacy_chip_balance"
    | "quarantine";
  sourceTable: string;
  sourceRow: string;
  currentAmount: number;
  /** 数値を安全に確定できない場合は null（推測しない） */
  estimatedCompensationLand: number | null;
  compensationStatus: "unknown" | "pending_decision";
  blockerReason: string;
}

export interface TableAudit {
  table: string;
  classification: CasinoTableClassification;
  exists: boolean;
  rows: number;
  fingerprint: TableContentFingerprint | null;
}

export interface LegacyLedgerAudit {
  checkA: CasinoCheckResult;
  checkB: CasinoCheckResult;
  checkC: CasinoCheckResult;
  checkD: CasinoCheckResult;
  ok: boolean;
}

/** plan hashの入力になる、決定的にシリアライズ可能なスナップショット */
export interface OpeningPlanSnapshot {
  mode: "dry-run";
  configuration: CasinoOpeningConfig;
  currentOpeningVersion: string;
  casinoStatus: CasinoStatusValue;
  schemaFingerprint: string;
  tables: Array<{
    table: string;
    kind: string;
    archive: boolean;
    resetOnApply: boolean;
    preserve: boolean;
    exists: boolean;
    rows: number;
    contentSha256: string | null;
  }>;
  playerLand: PlayerLandFingerprint;
  oldReserveLand: number;
  departmentLandBefore: number;
  openingSourceLand: number;
  chipHolderBalances: Array<{ holder: string; amount: number }>;
  legacyLedgerOk: boolean;
  escrowInspectionOk: boolean;
  protectedFindingCount: number;
  compensationRequiredLand: number;
  departmentExists: boolean;
}

export interface OpeningPreflightResult {
  planHash: string;
  snapshot: OpeningPlanSnapshot;
  blockers: OpeningBlocker[];
  protectedFindings: ProtectedAssetFinding[];
  compensation: { candidates: ProtectedAssetFinding[]; requiredLand: number | null; unknownCount: number };
  legacyLedgerAudit: LegacyLedgerAudit;
  tableAudits: TableAudit[];
  unknownTables: string[];
}

const now = () => Math.floor(Date.now() / 1000);

export interface OpeningPlannerDeps {
  db: Database.Database;
  ledger: Ledger;
  chips: ChipLedger;
  chipAssets: CasinoChipAssets;
  integrity: CasinoIntegrity;
  status: CasinoStatus;
  settings: Settings;
  departments: Departments;
}

/**
 * 正式開業初期化の読み取り専用preflight（CLAUDE.md §4）。
 *
 * このクラスは**一切書き込まない**。コンストラクタも含め、CREATE TABLE / INSERT / UPDATE /
 * DELETE / migration をどこにも行わない。`db.transaction(...).deferred()` で全SELECTを
 * 単一スナップショットとして読む（他接続の同時書き込みからも隔離される）。
 */
export class OpeningPlanner {
  private readonly chipTx: ChipTx;

  constructor(private readonly deps: OpeningPlannerDeps) {
    this.chipTx = deps.chips.chipTx;
  }

  dryRun(): OpeningPreflightResult {
    if (this.deps.db.inTransaction) return this.compute();
    return this.deps.db.transaction(() => this.compute()).deferred();
  }

  private compute(): OpeningPreflightResult {
    const blockers: OpeningBlocker[] = [];
    const configResult = readCasinoOpeningConfig(this.deps.settings);
    if (!configResult.ok) {
      const detail =
        configResult.reason === "not_configured"
          ? "開業設定が未設定（casino_opening_configured != 'true'）"
          : `開業設定が不正: ${configResult.errors.join("; ")}`;
      blockers.push({ category: "config", code: "opening_config_invalid", message: detail });
    }
    const configuration = configResult.ok
      ? configResult.config
      : ({
          configured: true,
          openingCapital: 0,
          openingHouse: 0,
          openingJackpot: 0,
          openingRelief: 0,
          minWorkingCapital: 0,
          remitRateBps: 0,
        } satisfies CasinoOpeningConfig);

    const currentOpeningVersion = this.chipTx.currentVersion();
    const openingPhase = this.chipTx.openingPhase();
    if (openingPhase === "unknown") {
      blockers.push({
        category: "opening_version",
        code: "unknown_opening_version",
        message: `未知のopening_version「${currentOpeningVersion}」。準備口座を決定できないため中止`,
      });
    }
    if (currentOpeningVersion === FORMAL_OPENING_VERSION) {
      blockers.push({
        category: "opening_version",
        code: "already_opening_v1",
        message: "既にopening_v1が存在する（二重開業防止）",
      });
    }

    const casinoStatusRow = this.deps.status.current();
    if (casinoStatusRow.status !== "opening_reset") {
      blockers.push({
        category: "config",
        code: "status_not_opening_reset",
        message: `賭場のstatusが opening_reset ではない（現在: ${casinoStatusRow.status}）。applyはこの状態でのみ進める`,
      });
    }

    const departmentRow = this.deps.departments.get(DEPARTMENT_KEY);
    const departmentExists = departmentRow !== undefined;
    if (!departmentExists) {
      blockers.push({
        category: "config",
        code: "department_missing",
        message: `部署 '${DEPARTMENT_KEY}' がdepartmentsテーブルに存在しない（R7/R8の送金先が無い）`,
      });
    }

    // ---- テーブル分類の実地監査 ----
    const tableAudits: TableAudit[] = CASINO_TABLE_CLASSIFICATION.map((classification) => {
      const exists = tableExists(this.deps.db, classification.table);
      const rows = exists ? tableRowCount(this.deps.db, classification.table) : 0;
      const fingerprint = classification.archive ? tableFingerprint(this.deps.db, classification.table) : null;
      return { table: classification.table, classification, exists, rows, fingerprint };
    });

    const unknownTables = this.findUnknownTables();
    for (const table of unknownTables) {
      blockers.push({
        category: "schema",
        code: "unknown_table",
        message: `分類表に無いcasino関連テーブルを検出: ${table}（推測で削除しない。分類表への追加が必要）`,
      });
    }

    // ---- 検算A〜D（legacy_pre_reset。currentOpeningVersionがlegacyの間だけ意味を持つ）----
    const legacyLedgerAudit = this.runLegacyLedgerAudit();
    if (!legacyLedgerAudit.ok) {
      blockers.push({
        category: "integrity",
        code: "legacy_integrity_failed",
        message: `legacy_pre_resetの検算A〜Dが不一致: ${[
          !legacyLedgerAudit.checkA.ok && "A",
          !legacyLedgerAudit.checkB.ok && "B",
          !legacyLedgerAudit.checkC.ok && "C",
          !legacyLedgerAudit.checkD.ok && "D",
        ]
          .filter(Boolean)
          .join(",")}`,
      });
    }
    const ledgerCheck = this.deps.ledger.verifyIntegrity();
    if (!ledgerCheck.ok) {
      blockers.push({
        category: "integrity",
        code: "land_ledger_cache_mismatch",
        message: `Land台帳の残高キャッシュが${ledgerCheck.mismatches.length}件不一致`,
      });
    }

    // ---- 進行中エスクロー・予約・板（R5相当）----
    const escrowInspection = this.deps.chipAssets.inspectEscrowed();
    if (!escrowInspection.ok) {
      blockers.push({
        category: "escrow_reservation",
        code: "escrow_asset_mismatch",
        message: `共通資産監査(escrow)で${escrowInspection.mismatches.length}件の不一致`,
      });
    }
    const activeEscrowRows = tableRowCount(this.deps.db, "casino_escrow");
    if (activeEscrowRows > 0) {
      blockers.push({
        category: "escrow_reservation",
        code: "active_escrow_rows",
        message: `casino_escrowに${activeEscrowRows}件の進行中預託がある（対人卓またはPR11チンチロ事前預託）`,
      });
    }
    const activeReservations = tableRowCount(this.deps.db, "casino_house_reservations");
    if (activeReservations > 0) {
      blockers.push({
        category: "escrow_reservation",
        code: "active_house_reservations",
        message: `casino_house_reservationsに${activeReservations}件の進行中予約がある`,
      });
    }
    // 板(casino_markets)の未終局・未知status検出は pr10Blockers() 内で行単位・
    // whitelist方式(MARKET_SAFE_STATUSES)により行う（集計だけのIN句だと未知の値を見落とすため）。

    // ---- PR10未完了義務 ----
    for (const b of this.pr10Blockers()) blockers.push(b);

    // ---- 保護資産（5.1節）----
    const protectedFindings = this.collectProtectedFindings();
    for (const finding of protectedFindings) {
      blockers.push({
        category: "protected_asset",
        code: `protected_${finding.assetType}`,
        message: `${finding.userId} の ${finding.assetType}（${finding.sourceTable}）が保護対象: ${finding.blockerReason}`,
        userId: finding.userId,
      });
    }
    const quarantineBalance = this.deps.chips.balanceOf(ESCROW_QUARANTINE);
    if (quarantineBalance > 0) {
      blockers.push({
        category: "quarantine",
        code: "quarantine_nonzero",
        message: `quarantine残高が${quarantineBalance}あり、利用者帰属候補として個別判断が必要`,
      });
    }

    const compensationCandidates = protectedFindings.filter(
      (f) => f.assetType === "legacy_chip_balance" || f.assetType === "quarantine",
    );
    const hasUnknownCompensation = compensationCandidates.some((f) => f.estimatedCompensationLand === null);
    const compensationRequiredLand = hasUnknownCompensation
      ? null
      : preflightCheckedAdd(
          blockers,
          "compensationRequiredLand",
          compensationCandidates.map((f) => f.estimatedCompensationLand ?? 0),
        ) ?? 0;

    // ---- Land残高（source of opening capital）----
    const oldReserveLand = this.deps.ledger.balanceOf(ETHER_ESCROW);
    const departmentLandBefore = departmentExists ? this.deps.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT) : 0;
    const openingSourceLand =
      preflightCheckedAdd(blockers, "openingSourceLand", [oldReserveLand, departmentLandBefore]) ?? 0;
    if (configResult.ok && openingSourceLand < configuration.openingCapital) {
      blockers.push({
        category: "backup_source",
        code: "insufficient_opening_source",
        message: `旧準備口座+賭博場部署の合計Land(${openingSourceLand})が開業元本(${configuration.openingCapital})に不足`,
      });
    }
    if (configResult.ok) {
      const remainingAfterOpening = openingSourceLand - configuration.openingCapital;
      const remainingInDept =
        (preflightCheckedAdd(blockers, "remainingInDept", [departmentLandBefore, oldReserveLand]) ?? 0) -
        configuration.openingCapital;
      if (remainingAfterOpening !== remainingInDept) {
        // 恒等式のはずだが、他の資金がこの2口座に混入していないかの防御的チェック
        blockers.push({
          category: "backup_source",
          code: "opening_source_arithmetic_mismatch",
          message: "開業元本の資金源計算に矛盾がある（DB破損の可能性）",
        });
      }
    }

    let playerLand: PlayerLandFingerprint;
    try {
      playerLand = playerLandFingerprint(this.deps.db);
    } catch (e) {
      if (!(e instanceof UnsafeAmountArithmeticError)) throw e;
      blockers.push({ category: "arithmetic", code: "unsafe_amount_arithmetic", message: e.message });
      playerLand = { accounts: 0, total: 0, sha256: "" };
    }
    const chipHolderBalances = this.chipHolderBalances();
    const schemaFp = schemaFingerprint(this.deps.db);

    const snapshot: OpeningPlanSnapshot = {
      mode: "dry-run",
      configuration,
      currentOpeningVersion,
      casinoStatus: casinoStatusRow.status,
      schemaFingerprint: schemaFp,
      tables: tableAudits
        .filter((a) => a.classification.includeInPlanHash !== false)
        .map((a) => ({
          table: a.table,
          kind: a.classification.kind,
          archive: a.classification.archive,
          resetOnApply: a.classification.resetOnApply,
          preserve: a.classification.preserve,
          exists: a.exists,
          rows: a.rows,
          contentSha256: a.fingerprint?.sha256 ?? null,
        }))
        .sort((a, b) => a.table.localeCompare(b.table)),
      playerLand,
      oldReserveLand,
      departmentLandBefore,
      openingSourceLand,
      chipHolderBalances: chipHolderBalances.sort((a, b) => a.holder.localeCompare(b.holder)),
      legacyLedgerOk: legacyLedgerAudit.ok,
      escrowInspectionOk: escrowInspection.ok,
      protectedFindingCount: protectedFindings.length,
      compensationRequiredLand: compensationRequiredLand ?? -1,
      departmentExists,
    };

    return {
      planHash: canonicalHash(snapshot),
      snapshot,
      blockers,
      protectedFindings,
      compensation: {
        candidates: compensationCandidates,
        requiredLand: compensationRequiredLand,
        unknownCount: compensationCandidates.filter((f) => f.estimatedCompensationLand === null).length,
      },
      legacyLedgerAudit,
      tableAudits,
      unknownTables,
    };
  }

  private findUnknownTables(): string[] {
    const rows = this.deps.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND (name LIKE 'casino_%' OR name = 'ether_balances')
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name).filter((name) => !KNOWN_CASINO_TABLE_NAMES.has(name));
  }

  private runLegacyLedgerAudit(): LegacyLedgerAudit {
    // currentVersion() が legacy_pre_reset のときだけ、checkA/B/C/D は正しくその版を評価する
    // （CasinoIntegrityは常に現在の版を見る。applyがR10でopening_v1へ切り替えた後は評価できない
    //  ので、この監査は必ずR7より前＝このpreflight時点で完了させる）。
    const checkA = this.deps.integrity.checkA();
    const checkB = this.deps.integrity.checkB();
    const checkC = this.deps.integrity.checkC();
    const checkD = this.deps.integrity.checkD();
    return { checkA, checkB, checkC, checkD, ok: checkA.ok && checkB.ok && checkC.ok && checkD.ok };
  }

  private pr10Blockers(): OpeningBlocker[] {
    const blockers: OpeningBlocker[] = [];

    if (tableExists(this.deps.db, "casino_chip_external_confirmations")) {
      const rows = this.deps.db
        .prepare("SELECT id, user_id, status FROM casino_chip_external_confirmations ORDER BY id")
        .all() as Array<{ id: string; user_id: string; status: string }>;
      for (const row of rows) {
        if (EXTERNAL_CONFIRMATION_SAFE_STATUSES.has(row.status)) continue;
        const unknown = !EXTERNAL_CONFIRMATION_STATUSES.has(row.status);
        blockers.push({
          category: "pr10_obligation",
          code: unknown ? "unknown_status_external_confirmation" : "pending_external_confirmation",
          message: `casino_chip_external_confirmations #${row.id}: status=${row.status}${unknown ? "（schema許容集合外の未知status）" : ""}`,
          userId: row.user_id,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_chip_refund_sagas")) {
      const rows = this.deps.db
        .prepare("SELECT id, target_user_id, status, failure_json FROM casino_chip_refund_sagas ORDER BY id")
        .all() as Array<{ id: string; target_user_id: string | null; status: string; failure_json: string | null }>;
      for (const row of rows) {
        const unknown = !REFUND_SAGA_STATUSES.has(row.status);
        const malformed = isMalformedJson(row.failure_json);
        if (!unknown && !malformed && REFUND_SAGA_SAFE_STATUSES.has(row.status)) continue;
        blockers.push({
          category: "pr10_obligation",
          code: unknown ? "unknown_status_refund_saga" : malformed ? "corrupt_json_refund_saga" : "unfinished_refund_saga",
          message: `casino_chip_refund_sagas #${row.id}: status=${row.status}${unknown ? "（schema許容集合外の未知status）" : ""}${malformed ? "（failure_jsonが破損）" : ""}`,
          userId: row.target_user_id ?? undefined,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_chip_refund_saga_targets")) {
      const rows = this.deps.db
        .prepare("SELECT saga_id, user_id, status, result_json, failure FROM casino_chip_refund_saga_targets ORDER BY saga_id, user_id")
        .all() as Array<{ saga_id: string; user_id: string; status: string; result_json: string | null; failure: string | null }>;
      for (const row of rows) {
        const unknown = !REFUND_SAGA_TARGET_STATUSES.has(row.status);
        const malformed = isMalformedJson(row.result_json) || isMalformedJson(row.failure);
        if (!unknown && !malformed && REFUND_SAGA_TARGET_SAFE_STATUSES.has(row.status)) continue;
        blockers.push({
          category: "pr10_obligation",
          code: unknown ? "unknown_status_refund_saga_target" : malformed ? "corrupt_json_refund_saga_target" : "unfinished_refund_saga_target",
          message: `casino_chip_refund_saga_targets saga=${row.saga_id} user=${row.user_id}: status=${row.status}${unknown ? "（schema許容集合外の未知status）" : ""}${malformed ? "（result_json/failureが破損）" : ""}`,
          userId: row.user_id,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_pending_free_spins")) {
      const rows = this.deps.db
        .prepare("SELECT id, user_id, status, jackpot_claim FROM casino_pending_free_spins ORDER BY id")
        .all() as Array<{ id: number; user_id: string; status: string; jackpot_claim: number }>;
      for (const row of rows) {
        if (PENDING_FREE_SPIN_SAFE_STATUSES.has(row.status)) continue;
        const unknown = !PENDING_FREE_SPIN_STATUSES.has(row.status);
        blockers.push({
          category: "pr10_obligation",
          code: unknown ? "unknown_status_pending_free_spin" : "pending_free_spin",
          message: `casino_pending_free_spins #${row.id}: status=${row.status}${unknown ? "（schema許容集合外の未知status）" : ""} jackpot_claim=${row.jackpot_claim}`,
          userId: row.user_id,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_markets")) {
      const rows = this.deps.db.prepare("SELECT id, status FROM casino_markets ORDER BY id").all() as Array<{
        id: number;
        status: string;
      }>;
      for (const row of rows) {
        if (MARKET_SAFE_STATUSES.has(row.status)) continue;
        const unknown = !MARKET_ALL_STATUSES.has(row.status);
        blockers.push({
          category: "market",
          code: unknown ? "unknown_status_market" : "live_market_row",
          message: `casino_markets #${row.id}: status=${row.status}${unknown ? "（schema許容集合外の未知status）" : ""}`,
        });
      }
    }

    return blockers;
  }

  private collectProtectedFindings(): ProtectedAssetFinding[] {
    const findings: ProtectedAssetFinding[] = [];
    const t = now();

    if (tableExists(this.deps.db, "casino_vip")) {
      const rows = this.deps.db
        .prepare("SELECT user_id, expires_at FROM casino_vip WHERE expires_at > ? ORDER BY user_id")
        .all(t) as Array<{ user_id: string; expires_at: number }>;
      for (const row of rows) {
        findings.push({
          userId: row.user_id,
          assetType: "vip",
          sourceTable: "casino_vip",
          sourceRow: `user_id=${row.user_id}`,
          currentAmount: row.expires_at,
          estimatedCompensationLand: null,
          compensationStatus: "unknown",
          blockerReason: `有効VIP（expires_at=${row.expires_at}）`,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_holdings")) {
      const rows = this.deps.db
        .prepare("SELECT user_id, stock_id, shares, avg_cost FROM casino_holdings WHERE shares > 0 ORDER BY user_id, stock_id")
        .all() as Array<{ user_id: string; stock_id: string; shares: number; avg_cost: number }>;
      for (const row of rows) {
        findings.push({
          userId: row.user_id,
          assetType: "stock_holding",
          sourceTable: "casino_holdings",
          sourceRow: `user_id=${row.user_id},stock_id=${row.stock_id}`,
          currentAmount: row.shares,
          estimatedCompensationLand: null,
          compensationStatus: "unknown",
          blockerReason: `正式株保有 ${row.shares}株（${row.stock_id}, 平均取得単価${row.avg_cost}）`,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_stats")) {
      const rows = this.deps.db
        .prepare(
          `SELECT user_id, games, wins, losses, total_wagered, total_earned, total_lost, biggest_win, best_win_streak
           FROM casino_stats
           WHERE games > 0 OR total_wagered > 0 OR total_earned > 0 OR total_lost > 0
              OR biggest_win > 0 OR best_win_streak > 0
           ORDER BY user_id`,
        )
        .all() as Array<{
        user_id: string;
        games: number;
        total_wagered: number;
        total_earned: number;
        total_lost: number;
        biggest_win: number;
        best_win_streak: number;
      }>;
      for (const row of rows) {
        findings.push({
          userId: row.user_id,
          assetType: "casino_stats",
          sourceTable: "casino_stats",
          sourceRow: `user_id=${row.user_id}`,
          currentAmount: row.games,
          estimatedCompensationLand: null,
          compensationStatus: "unknown",
          blockerReason: `非ゼロ戦績（games=${row.games}, wagered=${row.total_wagered}, earned=${row.total_earned}, lost=${row.total_lost}）`,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_items")) {
      const rows = this.deps.db
        .prepare("SELECT user_id, item_key, quantity FROM casino_items WHERE quantity > 0 ORDER BY user_id, item_key")
        .all() as Array<{ user_id: string; item_key: string; quantity: number }>;
      for (const row of rows) {
        findings.push({
          userId: row.user_id,
          assetType: "item",
          sourceTable: "casino_items",
          sourceRow: `user_id=${row.user_id},item_key=${row.item_key}`,
          currentAmount: row.quantity,
          estimatedCompensationLand: null,
          compensationStatus: "unknown",
          blockerReason: `所持アイテム ${row.item_key} x${row.quantity}`,
        });
      }
    }

    if (tableExists(this.deps.db, "casino_active_effects")) {
      const rows = this.deps.db
        .prepare("SELECT user_id, effect_key FROM casino_active_effects ORDER BY user_id, effect_key")
        .all() as Array<{ user_id: string; effect_key: string }>;
      for (const row of rows) {
        findings.push({
          userId: row.user_id,
          assetType: "active_effect",
          sourceTable: "casino_active_effects",
          sourceRow: `user_id=${row.user_id},effect_key=${row.effect_key}`,
          currentAmount: 1,
          estimatedCompensationLand: null,
          compensationStatus: "unknown",
          blockerReason: `有効効果 ${row.effect_key}`,
        });
      }
    }

    // 旧チップ残高（利用者本人保有ぶん）。時価は1チップ=1Landで安全に確定できるので、
    // これだけは estimatedCompensationLand を確定値で出す（他のasset種別は時価が確定できないためnull）。
    if (tableExists(this.deps.db, "ether_balances")) {
      const rows = this.deps.db
        .prepare("SELECT user_id, amount FROM ether_balances WHERE amount > 0 ORDER BY user_id")
        .all() as Array<{ user_id: string; amount: number }>;
      for (const row of rows) {
        if (!isPlayerHolder(row.user_id)) continue;
        findings.push({
          userId: row.user_id,
          assetType: "legacy_chip_balance",
          sourceTable: "ether_balances",
          sourceRow: `user_id=${row.user_id}`,
          currentAmount: row.amount,
          estimatedCompensationLand: row.amount,
          compensationStatus: "pending_decision",
          blockerReason: `利用者本人が保有する旧チップ ${row.amount}（1:1でLand換算可能）`,
        });
      }
    }

    return findings;
  }

  private chipHolderBalances(): Array<{ holder: string; amount: number }> {
    const rows = this.deps.db.prepare("SELECT user_id AS holder, amount FROM ether_balances ORDER BY user_id").all() as Array<{
      holder: string;
      amount: number;
    }>;
    return rows;
  }
}

export { TREASURY };
