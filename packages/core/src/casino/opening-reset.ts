import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { ChipTx, FORMAL_OPENING_VERSION, LEGACY_OPENING_VERSION } from "./chip-tx.js";
import { ChipLedger, ETHER_ESCROW, CHIP_ESCROW, HOUSE_HOLDER } from "./chip-ledger.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "./service.js";
import { CasinoChipAssets } from "./chip-assets.js";
import { CasinoIntegrity } from "./integrity.js";
import { CasinoStatus, OPENING_RESET_SEAL } from "./status.js";
import { Departments } from "../departments/service.js";
import type { Settings } from "../settings/service.js";
import { OpeningPlanner, CASINO_DEPARTMENT_ACCOUNT, type OpeningPreflightResult } from "./opening-plan.js";
import { CASINO_TABLE_CLASSIFICATION } from "./opening-tables.js";
import { schemaFingerprint, tableExists, tableRowCount, quoteIdent } from "./opening-canonical.js";
import {
  OpeningExecutionStore,
  type OpeningExecutionRow,
  type OpeningExecutionStatus,
} from "./opening-execution.js";
import { verifyOpeningBackupManifest, type OpeningBackupAdapter, type OpeningBackupManifest } from "./opening-backup.js";
import type { OpeningExternalAdapter } from "./opening-external.js";

/** R6でDELETEする対象（分類表からresetPhase='R6'だけを抽出。casino_market系はFK順を固定） */
const R6_DELETE_ORDER = [
  // 子（FK先）を先に消す
  "casino_market_bets",
  "casino_market_approvals",
  "casino_chip_refund_saga_targets",
  // 残りは順不同で構わない
  ...CASINO_TABLE_CLASSIFICATION.filter(
    (t) =>
      t.resetOnApply &&
      t.resetPhase === "R6" &&
      !["casino_market_bets", "casino_market_approvals", "casino_chip_refund_saga_targets"].includes(t.table),
  ).map((t) => t.table),
];

export interface PostflightCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface PostflightReport {
  ok: boolean;
  checks: PostflightCheck[];
}

export class OpeningApplyBlockedError extends Error {
  constructor(readonly blockers: OpeningPreflightResult["blockers"]) {
    super(`opening apply blocked by ${blockers.length} preflight blocker(s)`);
    this.name = "OpeningApplyBlockedError";
  }
}

export class OpeningApplyStaleplanError extends Error {
  constructor(
    readonly stage: string,
    readonly executionId: string,
  ) {
    super(`opening apply plan hash became stale at stage: ${stage}`);
    this.name = "OpeningApplyStaleplanError";
  }
}

export class OpeningApplyManualReviewError extends Error {
  constructor(
    readonly executionId: string,
    readonly reason: string,
    readonly fundsApplied: boolean,
  ) {
    super(`opening apply requires manual review: ${reason} (funds applied: ${fundsApplied})`);
    this.name = "OpeningApplyManualReviewError";
  }
}

export class OpeningApplyRolledBackError extends Error {
  constructor(
    readonly executionId: string,
    readonly cause: unknown,
  ) {
    super(`opening apply transaction rolled back: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "OpeningApplyRolledBackError";
  }
}

export class OpeningAlreadyAppliedError extends Error {
  constructor(readonly executionId: string) {
    super(`opening execution already completed: ${executionId}`);
    this.name = "OpeningAlreadyAppliedError";
  }
}

export interface OpeningApplyInput {
  actorId: string;
  backup: OpeningBackupAdapter;
  external: OpeningExternalAdapter;
}

export interface OpeningApplyResult {
  executionId: string;
  planHash: string;
  status: OpeningExecutionStatus;
  fundsApplied: boolean;
  oldSettlementLandTxId: number | null;
  newInvestmentLandTxId: number;
  openingVersion: string;
  postflight: PostflightReport;
  manifest: OpeningBackupManifest;
  externalOperationId: string;
  casinoReopened: boolean;
  notifierStatus: "sent" | "failed" | "pending";
}

export interface OpeningResetDeps {
  db: Database.Database;
  ledger: Ledger;
  chips: ChipLedger;
  chipAssets: CasinoChipAssets;
  integrity: CasinoIntegrity;
  status: CasinoStatus;
  settings: Settings;
  departments: Departments;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * 主経路上の状態の順位。「この状態に**到達済み**か」を判定するのに使う
 * （resumeは「まだこの段階を終えていないなら(再)実行する」というランクベースの判定にする —
 *  `backup_started` で落ちて再起動した場合も、`opening_reset_acquired` と同じ扱いで
 *  backupをもう一度試みる必要があるため、単純な等値比較では拾えない）。
 * `failed` / `manual_review_required` はここに含めない（呼び出し側で個別に解決してから使う）。
 */
const MAIN_PATH_RANK: Record<string, number> = {
  planned: 0,
  opening_reset_acquired: 1,
  backup_started: 2,
  backup_verified: 3,
  external_started: 4,
  external_completed: 5,
  applying: 6,
  applied: 7,
  post_commit_pending: 8,
  completed: 9,
};

/** execution が target 段階を**完了して**いるか（=target以降まで進んでいるか） */
function reached(execution: OpeningExecutionRow, target: OpeningExecutionStatus): boolean {
  return (MAIN_PATH_RANK[execution.status] ?? -1) >= (MAIN_PATH_RANK[target] ?? Number.MAX_SAFE_INTEGER);
}

/**
 * 正式開業初期化のapply core（CLAUDE.md §9〜§15）。
 *
 * `dryRun()`（=`OpeningPlanner`）と違い、このクラスは**破壊的処理を持つ**。
 * すべての前提条件（backup検証・plan一致・blocker=0）が揃うまで、破壊的なDB
 * transactionは絶対に開始しない。COMMIT後は資金操作を二度と行わない
 * （crash・再起動・再試行のいずれでも）。
 */
export class OpeningReset {
  private readonly planner: OpeningPlanner;
  private readonly executions: OpeningExecutionStore;
  private readonly chipTx: ChipTx;

  constructor(private readonly deps: OpeningResetDeps) {
    this.planner = new OpeningPlanner(deps);
    this.executions = new OpeningExecutionStore(deps.db);
    this.chipTx = deps.chips.chipTx;
  }

  /** 外部から実行状態を読みたい場合用（診断・テスト） */
  get executionStore(): OpeningExecutionStore {
    return this.executions;
  }

  async apply(input: OpeningApplyInput): Promise<OpeningApplyResult> {
    const initialPlan = this.planner.dryRun();
    if (initialPlan.blockers.length > 0) {
      throw new OpeningApplyBlockedError(initialPlan.blockers);
    }

    const acquireResult = this.executions.acquire(initialPlan.planHash, input.actorId, initialPlan.snapshot.configuration);
    let execution = acquireResult.execution;

    if (execution.status === "completed") {
      throw new OpeningAlreadyAppliedError(execution.id);
    }
    if (!execution.reapplyAllowed && execution.status !== "manual_review_required") {
      // fundsApplied=true だが completed でも manual_review でもない状態は設計上あり得ない
      // （applied → post_commit_pending → completed|manual_review_required しか無い）。
      // 万一の破損に対しては fail-closed で拒否する。
      throw new OpeningApplyManualReviewError(execution.id, "実行状態が不正（資金確定済みだが完了もレビュー待ちでもない）", true);
    }
    if (execution.status === "manual_review_required") {
      throw new OpeningApplyManualReviewError(execution.id, execution.manualReviewReason ?? "要運営判断", execution.fundsApplied);
    }

    // ---- failed（COMMIT前の失敗だけがここに来る）からの再挑戦も、新規と同じ扱いにする ----
    if (execution.status === "planned" || execution.status === "failed") {
      execution = this.tryTransition(execution, execution.status, "opening_reset_acquired");
    }

    // ---- plan再確認 #1（execution取得直後）----
    execution = this.assertPlanFresh(execution, "opening_reset_acquired");

    const archiveTables = initialPlan.snapshot.tables.filter((t) => t.archive && t.exists).map((t) => t.table);

    // ---- backup（opening_reset_acquired または backup_started で中断していれば再試行）----
    if (!reached(execution, "backup_verified")) {
      if (execution.status === "opening_reset_acquired") {
        execution = this.tryTransition(execution, "opening_reset_acquired", "backup_started");
      }
      if (!reached(execution, "backup_verified")) {
        let manifest: OpeningBackupManifest;
        try {
          manifest = await input.backup.backup({
            db: this.deps.db,
            planHash: execution.planHash,
            archiveTables,
            openingVersion: LEGACY_OPENING_VERSION,
          });
        } catch (e) {
          this.safeMarkFailed(execution, "backup_started", "backup", e instanceof Error ? e.message : String(e));
          throw e;
        }
        const verification = verifyOpeningBackupManifest(manifest, {
          archiveTables,
          planHash: execution.planHash,
          databaseIdentity: manifest.databaseIdentity,
          schemaFingerprint: schemaFingerprint(this.deps.db),
          rowCounts: Object.fromEntries(initialPlan.snapshot.tables.filter((t) => t.archive && t.exists).map((t) => [t.table, t.rows])),
          liveDb: this.deps.db,
        });
        if (!verification.ok) {
          const reason = `backup manifest検証失敗: ${verification.problems.join("; ")}`;
          this.safeMarkFailed(execution, "backup_started", "backup_verification", reason);
          throw new Error(reason);
        }
        execution = this.tryTransition(execution, "backup_started", "backup_verified", { backupManifest: manifest });
      }
    }
    const manifest = execution.backupManifest as OpeningBackupManifest;

    // ---- backup後のplan再検査 ----
    execution = this.assertPlanFresh(execution, "backup_verified");

    // ---- 外部工程（backup_verified または external_started で中断していれば再試行）----
    // 固定のidempotencyKeyを使う（planHashに含めない）。この外部工程は「一度きりの移行操作」であり、
    // plan hashが（無関係な理由で）変わっても同じ現実の操作を指す。planHashを混ぜると、
    // hashが変わるたびに外部adapter側が別操作と誤認し、二重実行の危険がある。
    const externalOperationId = "casino-opening:disable-legacy-vcs";
    if (!reached(execution, "external_completed")) {
      if (execution.status === "backup_verified") {
        execution = this.tryTransition(execution, "backup_verified", "external_started");
      }
      if (!reached(execution, "external_completed")) {
        let externalResult: unknown;
        try {
          externalResult = await input.external.disableLegacyCasino({
            planHash: execution.planHash,
            idempotencyKey: externalOperationId,
          });
        } catch (e) {
          this.safeMarkFailed(execution, "external_started", "external", e instanceof Error ? e.message : String(e));
          throw e;
        }
        execution = this.tryTransition(execution, "external_started", "external_completed", {
          externalOperationId,
          externalOperationResult: externalResult,
        });

        // ---- 外部工程後のplan再検査（stale時は manual_review。外部工程を再実行しない）----
        if (execution.status === "external_completed") {
          const postExternalPlan = this.planner.dryRun();
          if (postExternalPlan.planHash !== execution.planHash || postExternalPlan.blockers.length > 0) {
            const reason = `外部工程完了後にplanがstale化した（外部工程は再実行しない）: ${postExternalPlan.blockers.map((b) => b.code).join(",")}`;
            const after = this.safeMarkManualReview(execution, "external_completed", reason);
            throw new OpeningApplyManualReviewError(execution.id, reason, after.fundsApplied);
          }
        }
      }
    }

    // ---- 破壊的DB transaction（R5〜R13）。applying で中断していれば再試行（COMMIT前なので安全）----
    if (!reached(execution, "applied")) {
      if (execution.status === "external_completed") {
        execution = this.tryTransition(execution, "external_completed", "applying");
      }
      if (execution.status === "applying") {
        try {
          execution = this.runDestructiveTransaction(execution, initialPlan);
        } catch (e) {
          // db.transaction() が投げた時点で、SQLite自身が丸ごとROLLBACK済み
          // （casino_tx削除・R7/R8送金・opening_v1確立・executions更新、すべて元通り）。
          // COMMIT前の失敗なので安全に再挑戦できる。
          this.safeMarkFailed(execution, "applying", "applying", e instanceof Error ? e.message : String(e));
          throw new OpeningApplyRolledBackError(execution.id, e);
        }
      }
    }

    // ---- COMMIT後: post-commit状態更新（applied または post_commit_pending で中断していれば再試行）----
    // finishOpeningReset() は「すでにopen」なら ok:true を返す設計（CasinoStatus.reopen）なので、
    // ここを何度再試行してもcasino_statusを壊さない（post-commitはnotifier含め再試行のみ許可）。
    let casinoReopened = false;
    if (!reached(execution, "completed")) {
      if (execution.status === "applied") {
        execution = this.tryTransition(execution, "applied", "post_commit_pending");
      }
      const reopen = this.deps.status.finishOpeningReset(
        `正式開業初期化完了: ${execution.planHash}`,
        input.actorId,
        OPENING_RESET_SEAL,
      );
      if (!reopen.ok) {
        const reason = `COMMIT後、賭場をopenへ戻せなかった: ${reopen.reason ?? "unknown"}`;
        this.safeMarkManualReview(execution, "post_commit_pending", reason);
        throw new OpeningApplyManualReviewError(execution.id, reason, true);
      }
      casinoReopened = true;
      execution = this.tryTransition(execution, "post_commit_pending", "completed");
    } else {
      casinoReopened = this.deps.status.current().status === "open";
    }

    // ---- notifier（失敗しても資金・statusの確定は覆さない）----
    let notifierStatus: "sent" | "failed" | "pending" = "pending";
    try {
      // 本PRでは fake notifier のみ。本番監査チャンネルへは送信しない（CLAUDE.md §15）。
      notifierStatus = "sent";
      this.executions.recordNotifierStatus(execution.id, "sent");
    } catch {
      notifierStatus = "failed";
      this.executions.recordNotifierStatus(execution.id, "failed");
    }

    const finalExecution = this.executions.get(execution.id)!;
    return {
      executionId: finalExecution.id,
      planHash: finalExecution.planHash,
      status: finalExecution.status,
      fundsApplied: finalExecution.fundsApplied,
      oldSettlementLandTxId: finalExecution.oldSettlementLandTxId,
      newInvestmentLandTxId: finalExecution.newInvestmentLandTxId ?? 0,
      openingVersion: finalExecution.openingVersion ?? FORMAL_OPENING_VERSION,
      postflight: finalExecution.postflight as PostflightReport,
      manifest,
      externalOperationId,
      casinoReopened,
      notifierStatus,
    };
  }

  /**
   * CAS遷移のラッパー。`applied:false`（＝別プロセスが既に先へ進めていた）は
   * エラーにせず、実際の最新行を採用してそのまま処理を続ける（resume梯子が
   * rankベースで先の段階を自動的にスキップする）。
   */
  private tryTransition(
    execution: OpeningExecutionRow,
    fromStatus: OpeningExecutionStatus,
    to: OpeningExecutionStatus,
    patch: Partial<OpeningExecutionRow> = {},
  ): OpeningExecutionRow {
    const result = this.executions.transition(execution.id, fromStatus, to, patch);
    return result.execution;
  }

  /**
   * plan再検査。stale/blocker発生時は failed へ倒して例外を投げる（COMMIT前なので安全に再挑戦できる）。
   * 最新のexecution（他プロセスが既に先へ進めていた場合はそちらを採用）を返す。
   */
  private assertPlanFresh(execution: OpeningExecutionRow, fromStatus: OpeningExecutionStatus): OpeningExecutionRow {
    if (execution.status !== fromStatus) {
      // 既に別プロセスがこの段階より先へ進めていた（＝この場所での再検査はもう自分の仕事ではない）。
      // resume梯子は execution.status のrankだけで次の工程を判断するので、ここで打ち切ってよい。
      return execution;
    }
    const plan = this.planner.dryRun();
    if (plan.planHash !== execution.planHash || plan.blockers.length > 0) {
      const after = this.safeMarkFailed(
        execution,
        fromStatus,
        fromStatus,
        `plan hashが不一致またはblockerが発生: ${plan.blockers.map((b) => b.code).join(",")}`,
      );
      throw new OpeningApplyStaleplanError(fromStatus, after.id);
    }
    return execution;
  }

  /**
   * markFailed の競合安全版CASラッパー。呼び出し側が最後に観測した `fromStatus` を渡す。
   * CASが一致しなければ（＝別プロセスが既にこの行を先へ進めていた）、勝者の状態をそのまま
   * 採用して返す（書き換えない）。
   */
  private safeMarkFailed(
    execution: OpeningExecutionRow,
    fromStatus: OpeningExecutionStatus,
    stage: string,
    reason: string,
  ): OpeningExecutionRow {
    const result = this.executions.markFailed(execution.id, fromStatus, stage, reason);
    return result.execution;
  }

  /** manual_review_required への遷移のCASラッパー（safeMarkFailedと同じ理由） */
  private safeMarkManualReview(
    execution: OpeningExecutionRow,
    fromStatus: OpeningExecutionStatus,
    reason: string,
  ): OpeningExecutionRow {
    const result = this.executions.transition(execution.id, fromStatus, "manual_review_required", {
      manualReviewReason: reason,
    });
    return result.execution;
  }

  private runDestructiveTransaction(
    execution: OpeningExecutionRow,
    initialPlan: OpeningPreflightResult,
  ): OpeningExecutionRow {
    return this.chipTx.runMaintenance("正式開業初期化", (): OpeningExecutionRow => {
      const tx = this.deps.db.transaction((): OpeningExecutionRow => {
        // transaction取得直後のplan再検査
        const freshPlan = this.planner.dryRun();
        if (freshPlan.planHash !== execution.planHash || freshPlan.blockers.length > 0) {
          throw new Error(
            `transaction開始直後にplanがstale化した: ${freshPlan.blockers.map((b) => b.code).join(",")}`,
          );
        }

        const config = freshPlan.snapshot.configuration;

        // R5: 進行中エスクロー・板が0であることは freshPlan.blockers===0 で既に再確認済み

        // R6: 旧賭場専用データの初期化（blocker=0を証明できたテーブルだけ）
        for (const table of R6_DELETE_ORDER) {
          if (tableExists(this.deps.db, table)) {
            this.deps.db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
          }
        }

        // R7: 旧準備口座 → 賭博場部署（旧制度清算）。0なら移動そのものをスキップする
        const oldReserveLand = this.deps.ledger.balanceOf(ETHER_ESCROW);
        let oldSettlementLandTxId: number | null = null;
        if (oldReserveLand > 0) {
          const settlement = this.deps.ledger.transfer({
            from: ETHER_ESCROW,
            to: CASINO_DEPARTMENT_ACCOUNT,
            amount: oldReserveLand,
            type: "chip_settle",
            actor: "system:ether",
            approvedBy: "system:ether",
            reason: "正式開業初期化: 旧制度清算",
            refType: "casino_opening",
            refId: freshPlan.planHash,
            idempotencyKey: `casino-opening:${freshPlan.planHash}:legacy-settlement`,
          });
          oldSettlementLandTxId = settlement.tx.id;
        }

        // R8: 賭博場部署 → 新準備口座（新制度出資）。R7とは別のLand取引・別のidempotencyKey
        const investment = this.deps.ledger.transfer({
          from: CASINO_DEPARTMENT_ACCOUNT,
          to: CHIP_ESCROW,
          amount: config.openingCapital,
          type: "chip_fund",
          actor: "system:ether",
          approvedBy: "system:ether",
          reason: "正式開業初期化: 新制度出資",
          refType: "casino_opening",
          refId: freshPlan.planHash,
          idempotencyKey: `casino-opening:${freshPlan.planHash}:new-investment`,
        });
        const newInvestmentLandTxId = investment.tx.id;

        // R9: 旧chip storage / casino_tx / casino_tx_groups を初期化し、正式開業状態へ切り替える。
        // 削除順序は外部キー制約に従い casino_tx（子）→casino_tx_groups（親）。
        this.deps.db.prepare("DELETE FROM casino_tx").run();
        this.deps.db.prepare("DELETE FROM casino_tx_groups").run();
        // casino_tx.id の AUTOINCREMENT カウンタをリセットする。bootstrap.tsの
        // casino_chip_opening_versionsのコメントが「開業初期化でcasino_txを初期化した場合
        // （新版のIDが旧版より小さくなる）」とid巻き戻りを明示的に前提としており、
        // version_seqはまさにこの巻き戻りに耐えるために設計された機構である。
        this.deps.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'casino_tx'").run();
        this.deps.db.prepare("DELETE FROM ether_balances").run();
        const insertBalance = this.deps.db.prepare(
          "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, ?)",
        );
        const ts = now();
        insertBalance.run(HOUSE_HOLDER, config.openingHouse, ts);
        insertBalance.run(JACKPOT_HOLDER, config.openingJackpot, ts);
        insertBalance.run(RELIEF_HOLDER, config.openingRelief, ts);

        // R10: opening_v1 開始残高を確立する（同時にR11相当: current versionがopening_v1へ切り替わる）
        const captured = this.chipTx.captureOpening(
          FORMAL_OPENING_VERSION,
          [
            [HOUSE_HOLDER, config.openingHouse],
            [JACKPOT_HOLDER, config.openingJackpot],
            [RELIEF_HOLDER, config.openingRelief],
          ],
          { poolLand: config.openingCapital, fromLedgerTxId: newInvestmentLandTxId },
        );
        if (!captured) throw new Error("opening_v1 は既に存在する（二重開業の検出漏れ）");

        // R12: 同一トランザクション内でpostflight V1〜V7
        const postflight = this.runPostflightChecks(initialPlan, config, {
          oldReserveLand,
          departmentLandBefore: freshPlan.snapshot.departmentLandBefore,
          oldSettlementLandTxId,
          newInvestmentLandTxId,
        });
        if (!postflight.ok) {
          throw new Error(`postflight失敗: ${postflight.checks.filter((c) => !c.ok).map((c) => c.id).join(",")}`);
        }

        // R13: ここまで例外が出なければCOMMITする。executionの'applied'遷移も同じtransaction内で
        // 行い、資金変更とexecution状態を1つのCOMMITで確定させる（部分的な確定を作らない）。
        // この時点で fromStatus="applying" のCASが不一致（changes=0）になることは、正しく
        // 動作していれば起こらない — ここは自分だけがIMMEDIATEロックを保持したまま
        // R6〜R12まで進めてきた区間であり、他プロセスが同じ行のstatusを動かす余地は無い。
        // 起きた場合は資金移動込みでROLLBACKさせ、不変条件違反として扱う（fail-closed）。
        const applied = this.executions.transition(execution.id, "applying", "applied", {
          oldSettlementLandTxId,
          newInvestmentLandTxId,
          openingVersion: FORMAL_OPENING_VERSION,
          postflight,
        });
        if (!applied.applied) {
          throw new Error(
            `不変条件違反: applying状態のexecution(${execution.id})への'applied'遷移がCAS不一致で失敗した`,
          );
        }
        return applied.execution;
      });
      return tx.immediate();
    });
  }

  private runPostflightChecks(
    initialPlan: OpeningPreflightResult,
    config: OpeningPreflightResult["snapshot"]["configuration"],
    ctx: {
      oldReserveLand: number;
      departmentLandBefore: number;
      oldSettlementLandTxId: number | null;
      newInvestmentLandTxId: number;
    },
  ): PostflightReport {
    const checks: PostflightCheck[] = [];
    const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

    // V1: 全chip holder合計 = sys:escrow:casino のLand残高
    const outstanding = this.deps.chips.outstanding();
    const reserve = this.deps.ledger.balanceOf(CHIP_ESCROW);
    push("V1", outstanding === reserve, `outstanding=${outstanding} reserve=${reserve}`);

    // V2: Land ledger integrity OK
    const ledgerCheck = this.deps.ledger.verifyIntegrity();
    push("V2", ledgerCheck.ok, ledgerCheck.ok ? "ok" : `${ledgerCheck.mismatches.length}件不一致`);

    // V3: opening_v1開始残高 + 以降のchip取引 = 現在chip残高
    const balanceCheck = this.chipTx.verifyBalances(FORMAL_OPENING_VERSION);
    push("V3", balanceCheck.ok, balanceCheck.ok ? "ok" : `${balanceCheck.mismatches.length}件不一致`);

    // V4: escrow台帳とescrow holder検算
    const escrowCheck = this.deps.chipAssets.verifyEscrowed();
    push("V4", escrowCheck.ok, escrowCheck.ok ? "ok" : `${escrowCheck.mismatches.length}件不一致`);

    // V5: 系全体検算D
    const checkD = this.deps.integrity.checkD();
    push("V5", checkD.ok, checkD.detail);

    // V6: 旧制度holder／未完了義務が0（ether_balancesがhouse/jackpot/relief以外を持たない）
    const strayHolders = (
      this.deps.db
        .prepare("SELECT COUNT(*) AS n FROM ether_balances WHERE user_id NOT IN (?,?,?)")
        .get(HOUSE_HOLDER, JACKPOT_HOLDER, RELIEF_HOLDER) as { n: number }
    ).n;
    push("V6", strayHolders === 0, `stray holders=${strayHolders}`);

    // V7: sys:escrow:ether Land = 0
    const etherEscrowLand = this.deps.ledger.balanceOf(ETHER_ESCROW);
    push("V7", etherEscrowLand === 0, `sys:escrow:ether=${etherEscrowLand}`);

    // 追加確認（CLAUDE.md §14）
    push(
      "opening_capital_sum",
      config.openingHouse + config.openingJackpot + config.openingRelief === config.openingCapital,
      `${config.openingHouse}+${config.openingJackpot}+${config.openingRelief} vs ${config.openingCapital}`,
    );
    push(
      "department_balance",
      this.deps.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT) ===
        ctx.departmentLandBefore + ctx.oldReserveLand - config.openingCapital,
      `department=${this.deps.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)}`,
    );
    push(
      "r7_r8_separate_tx",
      ctx.oldReserveLand === 0 || ctx.oldSettlementLandTxId !== ctx.newInvestmentLandTxId,
      `oldSettlement=${ctx.oldSettlementLandTxId} newInvestment=${ctx.newInvestmentLandTxId}`,
    );
    push("opening_phase_formal", this.chipTx.openingPhase() === "formal", this.chipTx.openingPhase());
    const activeEscrowAfter = tableRowCount(this.deps.db, "casino_escrow");
    push("no_active_escrow", activeEscrowAfter === 0, `rows=${activeEscrowAfter}`);
    const activeReservationsAfter = tableRowCount(this.deps.db, "casino_house_reservations");
    push("no_active_reservations", activeReservationsAfter === 0, `rows=${activeReservationsAfter}`);
    const playerLandRows = this.deps.db
      .prepare(
        `SELECT a.id AS account_id, COALESCE(b.amount, 0) AS amount
         FROM accounts a LEFT JOIN balances b ON b.account_id = a.id
         WHERE a.kind = 'user' ORDER BY a.id`,
      )
      .all() as Array<{ account_id: string; amount: number }>;
    const playerLandTotal = playerLandRows.reduce((s, r) => s + Number(r.amount), 0);
    push(
      "player_land_unchanged",
      playerLandRows.length === initialPlan.snapshot.playerLand.accounts && playerLandTotal === initialPlan.snapshot.playerLand.total,
      `accounts=${playerLandRows.length}/${initialPlan.snapshot.playerLand.accounts} total=${playerLandTotal}/${initialPlan.snapshot.playerLand.total}`,
    );
    const schemaAfter = schemaFingerprint(this.deps.db);
    push("schema_unchanged", schemaAfter === initialPlan.snapshot.schemaFingerprint, "schema fingerprint");

    return { ok: checks.every((c) => c.ok), checks };
  }
}
