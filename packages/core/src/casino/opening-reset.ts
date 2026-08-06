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
import {
  checkedAddAll,
  eventProtectionFingerprint,
  playerLandFingerprint,
  schemaFingerprint,
  tableColumns,
  tableExists,
  tableRowCount,
  quoteIdent,
  type EventProtectionFingerprint,
} from "./opening-canonical.js";
import {
  OpeningExecutionConflictError,
  OpeningExecutionStore,
  type OpeningExecutionRow,
  type OpeningExecutionStatus,
} from "./opening-execution.js";
import {
  chipGroupGeneration,
  databaseIdentity,
  latestChipTransactionId,
  verifyOpeningBackupManifest,
  type ManifestVerificationExpectation,
  type OpeningBackupAdapter,
  type OpeningBackupManifest,
} from "./opening-backup.js";
import type { OpeningExternalAdapter } from "./opening-external.js";

/**
 * casino_markets / casino_market_bets / casino_market_approvals は market_mode='standard'
 * （チップ経済・PR12対象）と market_mode='event'（イベントLand板・PR#94・raw Ledger経済）が
 * 混在するテーブルなので、汎用の`DELETE FROM <table>`（全件削除）では扱えない
 * （PR12監査: イベントLand板の完全保護 2-B）。この3テーブルはR6_DELETE_ORDERから除外し、
 * `runDestructiveTransaction`内で`market_mode='standard'`の行だけを対象にしたfiltered delete
 * を個別に行う。削除順序はFKを守る: approvals → bets → markets（いずれも子→親）。
 */
const R6_MIXED_MARKET_TABLES = ["casino_market_approvals", "casino_market_bets", "casino_markets"] as const;

/** R6でDELETEする対象（分類表からresetPhase='R6'だけを抽出。mixed market tableは別扱い） */
const R6_DELETE_ORDER = [
  // 子（FK先）を先に消す
  "casino_chip_refund_saga_targets",
  // 残りは順不同で構わない（mixed market tableは除外。下のR6_MIXED_MARKET_TABLESで個別処理する）
  ...CASINO_TABLE_CLASSIFICATION.filter(
    (t) =>
      t.resetOnApply &&
      t.resetPhase === "R6" &&
      t.table !== "casino_chip_refund_saga_targets" &&
      !(R6_MIXED_MARKET_TABLES as readonly string[]).includes(t.table),
  ).map((t) => t.table),
];

/**
 * R6で実際に削除操作（全件 or market_mode='standard'限定）を行うテーブルの完全な一覧
 * （実行順）。crash injectionテスト（CLAUDE.md監査ブロッカーD）が「R6の全DELETE地点」を
 * 漏れなく列挙するために公開する。`opening-reset.js`の内部pathからのみ参照される
 * （`@meigokujo/core`の公開indexからは再エクスポートしない）。
 */
export const R6_ALL_DELETE_TABLES: readonly string[] = [...R6_DELETE_ORDER, ...R6_MIXED_MARKET_TABLES];

/** 外部工程の固定idempotencyKey。planHashへ混ぜない理由は下のapply()内コメントを参照 */
const EXTERNAL_DISABLE_LEGACY_OPERATION_ID = "casino-opening:disable-legacy-vcs";

/**
 * テスト専用のcrash injection地点（CLAUDE.md監査ブロッカー9）。production の通常経路
 * （`OpeningResetDeps`経由のconstructor、`apply()`の公開シグネチャ）からはこの型・
 * フックを一切参照できない。`@meigokujo/core`の公開index（`src/index.ts`）はこの型も
 * `__setCrashHookForTesting`も再エクスポートしない — テストは`opening-reset.js`を
 * 内部pathから直接importしてのみ使う。
 */
export type OpeningResetCrashPoint =
  | "r0_after_status_flip"
  | "r0_after_acquire"
  | "before_r6"
  | "r6_after_delete"
  | "after_r6"
  | "before_r7"
  | "after_r7_transfer"
  | "before_r8"
  | "after_r8_transfer"
  | "after_casino_tx_delete"
  | "after_casino_tx_groups_delete"
  | "after_sqlite_sequence_delete"
  | "after_ether_balances_delete"
  | "after_house_holder_created"
  | "after_jackpot_holder_created"
  | "after_relief_holder_created"
  | "after_opening_v1_captured"
  | "v1"
  | "v2"
  | "v3"
  | "v4"
  | "v5"
  | "v6"
  | "v7"
  | "before_applied_cas"
  | "after_applied_cas"
  | "before_commit"
  | "after_commit"
  | "before_post_commit_pending"
  | "after_post_commit_pending"
  | "before_reopen"
  | "after_reopen"
  | "before_completed"
  | "after_completed"
  | "before_notifier"
  | "after_notifier";

/** `point`で例外を投げればcrashを模擬できる。何もしなければ通常どおり進む */
export type OpeningResetCrashHook = (point: OpeningResetCrashPoint, detail?: string) => void;

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
  private crashHookForTesting: OpeningResetCrashHook | null = null;

  constructor(private readonly deps: OpeningResetDeps) {
    this.planner = new OpeningPlanner(deps);
    this.executions = new OpeningExecutionStore(deps.db);
    this.chipTx = deps.chips.chipTx;
  }

  /** 外部から実行状態を読みたい場合用（診断・テスト） */
  get executionStore(): OpeningExecutionStore {
    return this.executions;
  }

  /**
   * テスト専用のcrash injectionフックを差し込む（CLAUDE.md監査ブロッカー9）。
   * `OpeningResetCrashHook`型・このメソッドともに`@meigokujo/core`の公開indexからは
   * 到達できない内部専用のAPIであり、production側の通常経路から呼ばれることは無い。
   */
  __setCrashHookForTesting(hook: OpeningResetCrashHook | null): void {
    this.crashHookForTesting = hook;
  }

  private fireCrash(point: OpeningResetCrashPoint, detail?: string): void {
    this.crashHookForTesting?.(point, detail);
  }

  async apply(input: OpeningApplyInput): Promise<OpeningApplyResult> {
    // ---- COMMIT後の再開（CLAUDE.md監査ブロッカー9）----
    // funds_applied=1でまだcompletedでない行が既にあれば、post-commit工程だけを再開する。
    // COMMIT後は`opening_v1`が既にDBへ存在するため、この後に続く通常経路のdryRun()は
    // 必ずalready_opening_v1 blockerを返してしまう。以前はここを素通りしていたため、
    // COMMIT〜completed の間で（crash injectionに限らず、本物の異常終了でも）中断すると、
    // planHashベースの通常経路からは二度とpost-commit工程を再開できなかった
    // （R6〜R10・opening_v1 captureが再実行される心配は無いが、post-commit工程自体が
    //  永久に完了できなくなる恐れがあった。監査中に発見）。
    const inFlight = this.executions.findAppliedNotCompleted();
    if (inFlight) {
      if (inFlight.actorId !== input.actorId) {
        throw new OpeningExecutionConflictError("actor_mismatch", inFlight.id);
      }
      if (inFlight.status === "manual_review_required") {
        throw new OpeningApplyManualReviewError(
          inFlight.id,
          inFlight.manualReviewReason ?? "要運営判断",
          inFlight.fundsApplied,
        );
      }
      if (!inFlight.backupManifest) {
        throw new Error(
          `不変条件違反: execution(${inFlight.id}) は funds_applied=true だが backupManifest が未記録（データ破損の疑い。手動調査が必要）`,
        );
      }
      return this.finishAfterCommit(
        inFlight,
        input,
        inFlight.backupManifest as OpeningBackupManifest,
        EXTERNAL_DISABLE_LEGACY_OPERATION_ID,
      );
    }

    // ---- R0: opening_reset状態の取得とexecutionの確定をapply()自身の権限で、かつ単一の
    // IMMEDIATE transactionとして原子的に行う（CLAUDE.md監査ブロッカー7・監査ブロッカーB）。
    //
    // 以前は「CasinoStatusが既にopening_resetであること」を`dryRun()`のblockerとして
    // 前提にしているだけで、execution行が名乗る'opening_reset_acquired'という状態名にも
    // かかわらず、実際にその状態へ入れたのがこのapply()呼び出し自身なのか、無関係な
    // 別処理なのかを一切確認・保証していなかった。さらに`beginOpeningReset()`（statusの
    // 遷移）と`executions.acquire()`（executionの確定）が別々のtransactionだったため、
    // 片方だけcommitしてクラッシュすると「opening_resetだが所有executionが無い」窓が
    // 生じ得た。また`casino_status`自体には実行中のexecution・actorを機械的に照合できる
    // 列が無く、2プロセスが同時に`readyExceptStatus`をtrueと読んだ場合に両方が
    // `beginOpeningReset()`を実行してしまう余地があった。
    //
    // ここでは「statusがopenで、それ以外のblockerが一切無い（＝status以外はすべて準備完了）」
    // ことを確認できた場合に**限り**、apply()自身がCasinoStatusをopening_resetへ進める。
    // 他のblockerが残っている場合や、open/opening_reset以外の状態（maintenance・
    // manual_halt・integrity_halt・recovery_halt等の人為的な停止）からは、CasinoStatusに
    // 一切触れない（blocker=0を証明できるまでは副作用ゼロという既存の不変条件を保つ）。
    // 既にopening_resetの場合（前回のapply()が進めた状態からの再試行）は、このまま素通りする。
    //
    // status遷移・execution確定・所有権bind（`CasinoStatus.opening_execution_id`/
    // `opening_actor_id`）を全部この1つのtransactionへ入れることで、SQLiteのIMMEDIATEロックが
    // 他の書き込みtransactionと直列化する。1つでも失敗（blocker発生・actor/configuration不一致・
    // bind CAS不一致）すれば、statusの遷移も含めて全部ROLLBACKされ、呼出前の状態に戻る。
    const r0 = this.deps.db
      .transaction((): { initialPlan: OpeningPreflightResult; execution: OpeningExecutionRow } => {
        const preCheck = this.planner.dryRun();
        const currentStatus = this.deps.status.current().status;
        const readyExceptStatus =
          currentStatus === "open" &&
          preCheck.blockers.length > 0 &&
          preCheck.blockers.every((b) => b.code === "status_not_opening_reset");
        let plan = preCheck;
        if (readyExceptStatus) {
          this.deps.status.beginOpeningReset(`正式開業初期化: ${input.actorId}による開始`, input.actorId);
          // テスト専用crash injection地点（CLAUDE.md監査ブロッカーB）: statusをopening_resetへ
          // 進めた直後・execution確定前。ここで例外が飛べば、R0全体が単一transactionのため
          // status遷移そのものも含めて丸ごとROLLBACKされる（旧設計では別transactionだったため
          // ここに「statusはopening_resetだが所有executionが無い」窓が生じ得た）。
          this.fireCrash("r0_after_status_flip");
          plan = this.planner.dryRun();
        }
        if (plan.blockers.length > 0) {
          throw new OpeningApplyBlockedError(plan.blockers);
        }

        const acquireResult = this.executions.acquire(plan.planHash, input.actorId, plan.snapshot.configuration);
        const acquiredExecution = acquireResult.execution;
        // テスト専用crash injection地点: execution確定直後・所有権bind前。
        this.fireCrash("r0_after_acquire");

        // 所有権をcasino_statusへ機械的に結合する（同一transaction内・CAS）。
        // 別executionが既にbind済みなら（横取り）、資金・status・executionを一切変更せずに
        // fail-closedで例外を投げ、transaction全体をROLLBACKさせる。
        const bound = this.deps.status.bindOpeningExecutionOwner(acquiredExecution.id, input.actorId);
        if (!bound) {
          throw new Error(
            `不変条件違反: casino_statusのopening_reset所有権をexecution(${acquiredExecution.id})/actor(${input.actorId})へ` +
              `結合できなかった（別の所有者が既に存在する疑い）`,
          );
        }
        return { initialPlan: plan, execution: acquiredExecution };
      })
      .immediate();
    const initialPlan = r0.initialPlan;
    let execution = r0.execution;

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

    // このapply()呼び出し自身が新規にbackupを取る（＝これから検証する）のか、
    // 既に別の呼び出しでbackup_verified以降まで進んだ行を再開するのかを記録しておく
    // （CLAUDE.md監査ブロッカーC: resume時の永続backup再検証の要否判定に使う）。
    const enteredBackupStepFresh = !reached(execution, "backup_verified");

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
        // 期待値はmanifest自身からは一切引かない（`databaseIdentity: manifest.databaseIdentity`の
        // ような自己比較はCLAUDE.md監査ブロッカー5.1で禁止された自明にtrueになる検証になる）。
        // 稼働中DBと確定済みplanから独立に再計算する。
        const expectation: ManifestVerificationExpectation = {
          archiveTables,
          planHash: execution.planHash,
          databaseIdentity: databaseIdentity(this.deps.db),
          schemaFingerprint: schemaFingerprint(this.deps.db),
          rowCounts: Object.fromEntries(initialPlan.snapshot.tables.filter((t) => t.archive && t.exists).map((t) => [t.table, t.rows])),
          columns: Object.fromEntries(archiveTables.map((t) => [t, tableColumns(this.deps.db, t)])),
          openingVersion: LEGACY_OPENING_VERSION,
          latestLandTransactionId: this.deps.ledger.lastTransactionId(),
          latestChipTransactionId: latestChipTransactionId(this.deps.db),
          latestChipGroupGeneration: chipGroupGeneration(this.deps.db),
          liveDb: this.deps.db,
        };
        const verification = verifyOpeningBackupManifest(manifest, expectation);
        if (!verification.ok) {
          const reason = `backup manifest検証失敗: ${verification.problems.join("; ")}`;
          this.safeMarkFailed(execution, "backup_started", "backup_verification", reason);
          throw new Error(reason);
        }
        // 永続証拠でなければ破壊的applyの前提にできない（CLAUDE.md監査ブロッカー5.3）。
        // インメモリbackupはこのプロセスが終われば消えるため、ここで明示的に弾く。
        if (input.backup.durability !== "persistent") {
          const reason = `backup adapterが永続証拠を提供しない(durability=${input.backup.durability})。破壊的transactionへは進めない`;
          this.safeMarkFailed(execution, "backup_started", "backup_durability", reason);
          throw new Error(reason);
        }
        // manifestオブジェクト自体の整合だけでなく、実際に保存された実体を再読込して
        // 再検証する（CLAUDE.md監査ブロッカー5.2）。保存に失敗した・保存直後に消えた、
        // といった故障は`verifyOpeningBackupManifest`だけでは検出できない。
        const persisted = await input.backup.verifyPersistedBackup(manifest, expectation);
        if (!persisted.ok) {
          const reason = `永続backup証拠の再検証に失敗: ${persisted.problems.join("; ")}`;
          this.safeMarkFailed(execution, "backup_started", "backup_persistence_verification", reason);
          throw new Error(reason);
        }
        execution = this.tryTransition(execution, "backup_started", "backup_verified", { backupManifest: manifest });
      }
    }
    // 状態のrank(reached())だけを根拠に「backupは終わっている」と信じない。
    // 永続証拠（backupManifest列）が実際に無ければ、rankとDBの記録が矛盾した
    // 未知の状態組み合わせ＝データ破損の疑いとしてfail-closedで即座に止める
    // （このexecution行のFSM上どの遷移も試みない — 状態自体が信用できないため）。
    if (!execution.backupManifest) {
      throw new Error(
        `不変条件違反: execution(${execution.id}) は status=${execution.status} だが backupManifest が未記録（データ破損の疑い。手動調査が必要）`,
      );
    }
    const manifest = execution.backupManifest as OpeningBackupManifest;

    // resume時のbackup再検証（次のブロック）はmanifestが正しい形をしている前提で動く。
    // その前提自体が壊れている（externalOperationIdが未記録なのにexternal_completed以降を
    // 名乗っている等）場合は、永続backupの再検証を試みるより先に、この既存の不変条件
    // チェック（後段の"外部工程"ブロックにもある同一チェック）で早期にfail-closedする。
    if (reached(execution, "external_completed") && !execution.externalOperationId) {
      throw new Error(
        `不変条件違反: execution(${execution.id}) は status=${execution.status} だが externalOperationId が未記録（データ破損の疑い。手動調査が必要）`,
      );
    }

    // ---- ブロッカーC: resume時の永続backup再検証 ----
    // このapply()呼び出しが新規にbackupを取ったのではなく、既にbackup_verified以降まで
    // 進んだexecutionを（別プロセス・別呼び出しから）再開する場合、backupManifest列の
    // 内容を信じるだけでなく、ディスク上の実体から改めて再検証する
    // （欠落・改竄・別DBとの取り違えは、backup_verifiedというrankの記録だけでは検出できない）。
    if (!enteredBackupStepFresh) {
      const reverify = await this.reverifyPersistedBackup(execution, manifest, archiveTables, input);
      if (!reverify.ok) {
        const reason = `resume時の永続backup再検証に失敗: ${reverify.problems.join("; ")}`;
        if (execution.status === "backup_verified") {
          // 外部工程未到達: 資金移動なし・R6開始なし。failedへ倒し、再backupから
          // 安全に再挑戦できる状態にする（外部工程がまだ実行されていないため二重実行の懸念が無い）。
          const after = this.safeMarkFailed(execution, "backup_verified", "backup_reverify_resume", reason);
          throw new Error(`${reason}（execution=${after.id}, status=${after.status}）`);
        }
        // external_started 以降（external_completed・applying を含む）: 外部工程が既に
        // 実行されたか不明、または完了済みのため、外部工程を再実行せず・R6も開始せず、
        // manual_review_requiredへ倒す（資金は未確定のまま。fundsAppliedは呼び出し側へ正確に伝える）。
        const after = this.safeMarkManualReview(execution, execution.status, reason);
        throw new OpeningApplyManualReviewError(after.id, reason, after.fundsApplied);
      }
    }

    // ---- backup後のplan再検査 ----
    execution = this.assertPlanFresh(execution, "backup_verified");

    // ---- 外部工程（backup_verified または external_started で中断していれば再試行）----
    // 固定のidempotencyKeyを使う（planHashに含めない）。この外部工程は「一度きりの移行操作」であり、
    // plan hashが（無関係な理由で）変わっても同じ現実の操作を指す。planHashを混ぜると、
    // hashが変わるたびに外部adapter側が別操作と誤認し、二重実行の危険がある。
    const externalOperationId = EXTERNAL_DISABLE_LEGACY_OPERATION_ID;
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
    if (reached(execution, "external_completed") && !execution.externalOperationId) {
      throw new Error(
        `不変条件違反: execution(${execution.id}) は status=${execution.status} だが externalOperationId が未記録（データ破損の疑い。手動調査が必要）`,
      );
    }

    // ---- 破壊的DB transaction（R5〜R13）。applying で中断していれば再試行（COMMIT前なので安全）----
    if (!reached(execution, "applied")) {
      if (execution.status === "external_completed") {
        execution = this.tryTransition(execution, "external_completed", "applying");
      }
      if (execution.status === "applying") {
        // ---- ブロッカーC: 破壊的R6 transactionへ入る直前の永続backup再検証 ----
        // このapply()呼び出しの中でbackupを新規取得した場合でも、外部工程を挟んで時間が
        // 経過している可能性があるため、R6直前でもう一度ディスク上の実体から再検証する。
        const preR6Reverify = await this.reverifyPersistedBackup(execution, manifest, archiveTables, input);
        if (!preR6Reverify.ok) {
          const reason = `R6直前の永続backup再検証に失敗: ${preR6Reverify.problems.join("; ")}`;
          const after = this.safeMarkManualReview(execution, "applying", reason);
          throw new OpeningApplyManualReviewError(after.id, reason, after.fundsApplied);
        }
        try {
          execution = this.runDestructiveTransaction(execution, initialPlan);
        } catch (e) {
          // db.transaction() が投げた時点で、SQLite自身が丸ごとROLLBACK済み
          // （casino_tx削除・R7/R8送金・opening_v1確立・executions更新、すべて元通り）。
          // COMMIT前の失敗なので安全に再挑戦できる。
          //
          // ただし chipTx.captureOpening() のバージョンキャッシュはSQLトランザクション境界の
          // 外にある生のJS状態なので、ROLLBACKされても古いまま残る（PR12監査で発見）。
          // 明示的に破棄し、次回 currentVersion() が必ずDBから読み直すようにする
          // （破棄しないと、DBはlegacy_pre_resetのままなのにopening_v1と錯覚し、
          //  ChipLedgerの正式開業ロックが誤って解除されたと見なしてしまう恐れがある）。
          this.chipTx.invalidateVersionCache();
          this.safeMarkFailed(execution, "applying", "applying", e instanceof Error ? e.message : String(e));
          throw new OpeningApplyRolledBackError(execution.id, e);
        }
      }
    }

    return this.finishAfterCommit(execution, input, manifest, externalOperationId);
  }

  /**
   * COMMIT後の工程（post_commit_pending → completed、notifier）。CLAUDE.md監査ブロッカー9で
   * 独立メソッドへ分離した: `apply()`の通常経路（destructive transaction成功直後）と、
   * `apply()`冒頭のCOMMIT後再開経路（`findAppliedNotCompleted()`で見つけた行から直接
   * 再開する場合）の**両方**がここを通ることで、post-commit工程の再試行ロジックを
   * 単一箇所に保つ。R6〜R10・opening_v1 captureは、このメソッドのどこからも呼ばれない
   * （＝COMMIT後は絶対に再実行されない）。
   */
  private finishAfterCommit(
    execution: OpeningExecutionRow,
    input: OpeningApplyInput,
    manifest: OpeningBackupManifest,
    externalOperationId: string,
  ): OpeningApplyResult {
    // ---- COMMIT後: post-commit状態更新（applied または post_commit_pending で中断していれば再試行）----
    // finishOpeningReset() は「すでにopen」なら ok:true を返す設計（CasinoStatus.reopen）なので、
    // ここを何度再試行してもcasino_statusを壊さない（post-commitはnotifier含め再試行のみ許可）。
    this.fireCrash("after_commit");
    let casinoReopened = false;
    if (!reached(execution, "completed")) {
      if (execution.status === "applied") {
        this.fireCrash("before_post_commit_pending");
        execution = this.tryTransition(execution, "applied", "post_commit_pending");
        this.fireCrash("after_post_commit_pending");
      }
      this.fireCrash("before_reopen");
      const reopen = this.deps.status.finishOpeningReset(
        `正式開業初期化完了: ${execution.planHash}`,
        input.actorId,
        OPENING_RESET_SEAL,
      );
      this.fireCrash("after_reopen");
      if (!reopen.ok) {
        const reason = `COMMIT後、賭場をopenへ戻せなかった: ${reopen.reason ?? "unknown"}`;
        this.safeMarkManualReview(execution, "post_commit_pending", reason);
        throw new OpeningApplyManualReviewError(execution.id, reason, true);
      }
      casinoReopened = true;
      this.fireCrash("before_completed");
      execution = this.tryTransition(execution, "post_commit_pending", "completed");
      this.fireCrash("after_completed");
    } else {
      casinoReopened = this.deps.status.current().status === "open";
    }

    // ---- notifier（CLAUDE.md監査ブロッカー6: 本PRでは配線しない）----
    // 実際には何も送信していないのに notifier_status='sent' を監査記録へ残すことは禁止されている
    // （未送信を「送った」ことにする虚偽記録になる）。本番Discord・監査チャンネルへの接続は
    // 本PRの範囲外であり、通知配線は別の明示的GOの後で行う。ここに来た時点で資金は既にCOMMIT
    // 済みなので、notifier未配線を失敗として扱ったり資金をrollbackしたりはしない。
    this.fireCrash("before_notifier");
    const notifierStatus: "sent" | "failed" | "pending" = "pending";
    this.executions.recordNotifierStatus(execution.id, "pending");
    this.fireCrash("after_notifier");

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

  /**
   * 保存済みbackupManifestを、**ディスク上の永続証拠自体**から再検証する
   * （CLAUDE.md監査ブロッカーC）。
   *
   * 意図的に`liveDb`・生の`rowCounts`/`columns`・`latestLandTransactionId`等の
   * 「今のライブDBとの一致」を要求する項目は渡さない。backup_verified以降、
   * casino_opening_executions（FSM自身の書き込み）やイベントLand板（別台帳・
   * 正式開業初期化とは無関係に稼働し続ける — CLAUDE.md §「イベントLand板保護」）は
   * 正当に変化し続けるため、「backup時点のライブDBスナップショットと今のライブDBが
   * 完全一致するか」を再検証条件にすると、何も壊れていなくても必ず不一致になる
   * （誤検知でmanual_reviewを乱発してしまう）。
   *
   * ここで再検証したいのはあくまで「backup直後に検証した永続証拠（SQLite snapshot・
   * CSV・manifestファイル自体）が、その後に欠損・改竄されていないか」であり、
   * `OpeningBackupAdapter.verifyPersistedBackup` → `verifyOpeningBackupFilesOnDisk`
   * （ディスク上の実ファイルとmanifest自身が記録したSHA-256を突き合わせるだけで、
   *  ライブDBは一切参照しない）が正確にその役割を持つ。加えて、`databaseIdentity`・
   * `schemaFingerprint`・`planHash`（execution自身の値。manifest.planHashとの
   * 自己比較にしない）だけは、apply()の生涯を通じて不変であるべき値として引き続き
   * ライブDBと突き合わせる。
   */
  private async reverifyPersistedBackup(
    execution: OpeningExecutionRow,
    manifest: OpeningBackupManifest,
    archiveTables: string[],
    input: OpeningApplyInput,
  ): Promise<{ ok: boolean; problems: string[] }> {
    const expectation: ManifestVerificationExpectation = {
      archiveTables,
      planHash: execution.planHash,
      databaseIdentity: databaseIdentity(this.deps.db),
      schemaFingerprint: schemaFingerprint(this.deps.db),
      rowCounts: {},
      openingVersion: LEGACY_OPENING_VERSION,
    };
    const manifestCheck = verifyOpeningBackupManifest(manifest, expectation);
    if (!manifestCheck.ok) {
      return { ok: false, problems: manifestCheck.problems };
    }
    const persisted = await input.backup.verifyPersistedBackup(manifest, expectation);
    return persisted.ok ? { ok: true, problems: [] } : { ok: false, problems: persisted.problems };
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
        this.fireCrash("before_r6");
        // イベントLand板保護fingerprint（PR12監査: イベントLand板の完全保護 2-F）。
        // R6開始直前に計算し、R6〜R13完了後（COMMIT前）に再計算して一致を要求する。
        const eventBefore = eventProtectionFingerprint(this.deps.db, this.deps.ledger);
        for (const table of R6_DELETE_ORDER) {
          if (tableExists(this.deps.db, table)) {
            this.deps.db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
          }
          this.fireCrash("r6_after_delete", table);
        }
        // mixed market table（casino_markets/casino_market_bets/casino_market_approvals）:
        // market_mode='standard' の行だけを対象にしたfiltered delete。イベントLand板
        // （market_mode='event'）の行・bet・escrowは一切変更しない（PR12監査 2-B）。
        // FK順: approvals → bets → markets（いずれも子→親）。
        if (tableExists(this.deps.db, "casino_market_approvals")) {
          this.deps.db
            .prepare(
              "DELETE FROM casino_market_approvals WHERE market_id IN (SELECT id FROM casino_markets WHERE market_mode = 'standard')",
            )
            .run();
        }
        this.fireCrash("r6_after_delete", "casino_market_approvals");
        if (tableExists(this.deps.db, "casino_market_bets")) {
          this.deps.db
            .prepare(
              "DELETE FROM casino_market_bets WHERE market_id IN (SELECT id FROM casino_markets WHERE market_mode = 'standard')",
            )
            .run();
        }
        this.fireCrash("r6_after_delete", "casino_market_bets");
        if (tableExists(this.deps.db, "casino_markets")) {
          this.deps.db.prepare("DELETE FROM casino_markets WHERE market_mode = 'standard'").run();
        }
        this.fireCrash("r6_after_delete", "casino_markets");
        this.fireCrash("after_r6");

        // R7: 旧準備口座 → 賭博場部署（旧制度清算）。0なら移動そのものをスキップする
        this.fireCrash("before_r7");
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
          this.fireCrash("after_r7_transfer");
        }

        // R8: 賭博場部署 → 新準備口座（新制度出資）。R7とは別のLand取引・別のidempotencyKey
        this.fireCrash("before_r8");
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
        this.fireCrash("after_r8_transfer");

        // R9: 旧chip storage / casino_tx / casino_tx_groups を初期化し、正式開業状態へ切り替える。
        // 削除順序は外部キー制約に従い casino_tx（子）→casino_tx_groups（親）。
        this.deps.db.prepare("DELETE FROM casino_tx").run();
        this.fireCrash("after_casino_tx_delete");
        this.deps.db.prepare("DELETE FROM casino_tx_groups").run();
        this.fireCrash("after_casino_tx_groups_delete");
        // casino_tx.id の AUTOINCREMENT カウンタをリセットする。bootstrap.tsの
        // casino_chip_opening_versionsのコメントが「開業初期化でcasino_txを初期化した場合
        // （新版のIDが旧版より小さくなる）」とid巻き戻りを明示的に前提としており、
        // version_seqはまさにこの巻き戻りに耐えるために設計された機構である。
        this.deps.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'casino_tx'").run();
        this.fireCrash("after_sqlite_sequence_delete");
        this.deps.db.prepare("DELETE FROM ether_balances").run();
        this.fireCrash("after_ether_balances_delete");
        const insertBalance = this.deps.db.prepare(
          "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, ?)",
        );
        const ts = now();
        insertBalance.run(HOUSE_HOLDER, config.openingHouse, ts);
        this.fireCrash("after_house_holder_created");
        insertBalance.run(JACKPOT_HOLDER, config.openingJackpot, ts);
        this.fireCrash("after_jackpot_holder_created");
        insertBalance.run(RELIEF_HOLDER, config.openingRelief, ts);
        this.fireCrash("after_relief_holder_created");

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
        this.fireCrash("after_opening_v1_captured");

        // R12: 同一トランザクション内でpostflight V1〜V7・V-event-1〜V-event-5
        const postflight = this.runPostflightChecks(initialPlan, config, {
          oldReserveLand,
          departmentLandBefore: freshPlan.snapshot.departmentLandBefore,
          oldSettlementLandTxId,
          newInvestmentLandTxId,
          eventBefore,
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
        this.fireCrash("before_applied_cas");
        const applied = this.executions.transition(execution.id, "applying", "applied", {
          oldSettlementLandTxId,
          newInvestmentLandTxId,
          openingVersion: FORMAL_OPENING_VERSION,
          postflight,
        });
        this.fireCrash("after_applied_cas");
        if (!applied.applied) {
          throw new Error(
            `不変条件違反: applying状態のexecution(${execution.id})への'applied'遷移がCAS不一致で失敗した`,
          );
        }
        this.fireCrash("before_commit");
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
      eventBefore: EventProtectionFingerprint;
    },
  ): PostflightReport {
    const checks: PostflightCheck[] = [];
    const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

    // V1: 全chip holder合計 = sys:escrow:casino のLand残高
    this.fireCrash("v1");
    const outstanding = this.deps.chips.outstanding();
    const reserve = this.deps.ledger.balanceOf(CHIP_ESCROW);
    push("V1", outstanding === reserve, `outstanding=${outstanding} reserve=${reserve}`);

    // V2: Land ledger integrity OK
    this.fireCrash("v2");
    const ledgerCheck = this.deps.ledger.verifyIntegrity();
    push("V2", ledgerCheck.ok, ledgerCheck.ok ? "ok" : `${ledgerCheck.mismatches.length}件不一致`);

    // V3: opening_v1開始残高 + 以降のchip取引 = 現在chip残高
    this.fireCrash("v3");
    const balanceCheck = this.chipTx.verifyBalances(FORMAL_OPENING_VERSION);
    push("V3", balanceCheck.ok, balanceCheck.ok ? "ok" : `${balanceCheck.mismatches.length}件不一致`);

    // V4: escrow台帳とescrow holder検算
    this.fireCrash("v4");
    const escrowCheck = this.deps.chipAssets.verifyEscrowed();
    push("V4", escrowCheck.ok, escrowCheck.ok ? "ok" : `${escrowCheck.mismatches.length}件不一致`);

    // V5: 系全体検算D
    this.fireCrash("v5");
    const checkD = this.deps.integrity.checkD();
    push("V5", checkD.ok, checkD.detail);

    // V6: 旧制度holder／未完了義務が0（ether_balancesがhouse/jackpot/relief以外を持たない）
    this.fireCrash("v6");
    const strayHolders = (
      this.deps.db
        .prepare("SELECT COUNT(*) AS n FROM ether_balances WHERE user_id NOT IN (?,?,?)")
        .get(HOUSE_HOLDER, JACKPOT_HOLDER, RELIEF_HOLDER) as { n: number }
    ).n;
    push("V6", strayHolders === 0, `stray holders=${strayHolders}`);

    // V7: sys:escrow:ether Land = 0
    this.fireCrash("v7");
    const etherEscrowLand = this.deps.ledger.balanceOf(ETHER_ESCROW);
    push("V7", etherEscrowLand === 0, `sys:escrow:ether=${etherEscrowLand}`);

    // V-event-1〜V-event-5: イベントLand板保護fingerprintの不変検算（PR12監査 2-F）。
    // R6〜R13の間、イベントLand板（market_mode='event'）のデータ・resultなし・
    // event_market_ops・そのescrow・fee holderが1件・1Ldも変化していないことを要求する。
    // どれか1つでも不一致ならpostflight失敗としてtransaction全体をROLLBACKさせる
    // （row countだけでなく行内容・残高そのものを比較するため、canonical hashを使う）。
    const eventAfter = eventProtectionFingerprint(this.deps.db, this.deps.ledger);
    push(
      "V-event-1",
      eventAfter.eventMarketsSha256 === ctx.eventBefore.eventMarketsSha256,
      "event markets hash（market_mode='event'のcasino_markets全行）",
    );
    push(
      "V-event-2",
      eventAfter.eventBetsSha256 === ctx.eventBefore.eventBetsSha256,
      "event bets hash（イベント板に属するcasino_market_bets全行）",
    );
    push(
      "V-event-3",
      eventAfter.eventMarketOpsSha256 === ctx.eventBefore.eventMarketOpsSha256,
      "event_market_ops hash（全行）",
    );
    push(
      "V-event-4",
      eventAfter.eventEscrowSha256 === ctx.eventBefore.eventEscrowSha256,
      "event escrow balances hash（各sys:escrow:market:<id>残高）",
    );
    push(
      "V-event-5",
      eventAfter.eventFeesHolderBalance === ctx.eventBefore.eventFeesHolderBalance,
      `event fees holder balance: before=${ctx.eventBefore.eventFeesHolderBalance} after=${eventAfter.eventFeesHolderBalance}`,
    );

    // 追加確認（CLAUDE.md §14）。ここはtransaction中(監査ブロッカー8): checkedAddAllが
    // overflowを検出すればそのまま例外を投げさせ、transaction全体をROLLBACKさせる
    // （catchしてblocker化しない。postflightはCOMMIT直前の最終防衛線であって診断ではない）。
    const openingCapitalSum = checkedAddAll(
      [config.openingHouse, config.openingJackpot, config.openingRelief],
      "postflight.opening_capital_sum",
    );
    push(
      "opening_capital_sum",
      openingCapitalSum === config.openingCapital,
      `${config.openingHouse}+${config.openingJackpot}+${config.openingRelief}=${openingCapitalSum} vs ${config.openingCapital}`,
    );
    const departmentExpected =
      checkedAddAll([ctx.departmentLandBefore, ctx.oldReserveLand], "postflight.department_balance") -
      config.openingCapital;
    push(
      "department_balance",
      this.deps.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT) === departmentExpected,
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
    // CLAUDE.md監査ブロッカー4: 口座数・合計額の一致だけでは、総額とaccount数を保ったまま
    // 利用者間でLandを付け替える改竄を検出できない。preflightと同じ実装(playerLandFingerprint)で
    // accountId別のcanonical SHA-256まで再計算し、3項目すべての一致を要求する。
    const playerLandAfter = playerLandFingerprint(this.deps.db);
    push(
      "player_land_unchanged",
      playerLandAfter.accounts === initialPlan.snapshot.playerLand.accounts &&
        playerLandAfter.total === initialPlan.snapshot.playerLand.total &&
        playerLandAfter.sha256 === initialPlan.snapshot.playerLand.sha256,
      `accounts=${playerLandAfter.accounts}/${initialPlan.snapshot.playerLand.accounts} ` +
        `total=${playerLandAfter.total}/${initialPlan.snapshot.playerLand.total} ` +
        `sha256=${playerLandAfter.sha256 === initialPlan.snapshot.playerLand.sha256 ? "match" : "MISMATCH"}`,
    );
    const schemaAfter = schemaFingerprint(this.deps.db);
    push("schema_unchanged", schemaAfter === initialPlan.snapshot.schemaFingerprint, "schema fingerprint");

    return { ok: checks.every((c) => c.ok), checks };
  }
}
