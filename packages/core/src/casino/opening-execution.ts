import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalHash } from "./opening-canonical.js";
import type { CasinoOpeningConfig } from "./opening-settings.js";
import type { OpeningBackupManifest } from "./opening-backup.js";

/**
 * 正式開業初期化の永続execution状態機械（CLAUDE.md §9）。
 *
 * `apply()` はオーケストレーションAPIであり、複数の工程（backup・外部adapter・破壊的DB
 * transaction・post-commit処理）を跨ぐ。**どの工程まで進んだ状態でプロセスが落ちても、
 * 再起動後にどこから再開してよいか／再開してはいけないかを判定できる**ことが目的で、
 * この行がその唯一の真実源になる。
 */
export const OPENING_EXECUTION_STATUSES = [
  "planned",
  "opening_reset_acquired",
  "backup_started",
  "backup_verified",
  "external_started",
  "external_completed",
  "applying",
  "applied",
  "post_commit_pending",
  "completed",
  "failed",
  "manual_review_required",
] as const;
export type OpeningExecutionStatus = (typeof OPENING_EXECUTION_STATUSES)[number];

/** funds が動いた可能性がある（=二度と自動リトライで資金操作をしてはいけない）状態 */
const FUNDS_COMMITTED_STATUSES: ReadonlySet<OpeningExecutionStatus> = new Set([
  "applied",
  "post_commit_pending",
  "completed",
  "manual_review_required",
]);

/** 許可された状態遷移。ここに無い遷移はコードでも拒否する（fail-closed） */
const ALLOWED_TRANSITIONS: Record<OpeningExecutionStatus, readonly OpeningExecutionStatus[]> = {
  planned: ["opening_reset_acquired", "failed"],
  opening_reset_acquired: ["backup_started", "failed"],
  backup_started: ["backup_verified", "failed"],
  backup_verified: ["external_started", "failed"],
  external_started: ["external_completed", "failed"],
  // 外部工程(R3相当)完了後にplanがstaleと判明した場合だけ manual_review_required へ倒す
  // （CLAUDE.md §8: 外部工程は既に完了しているので、DB資金を動かさず・外部工程を再実行せず、
  //   手動判断が必要な状態として報告する。単純な failed→再挑戦にすると外部工程が二重実行されうる）
  external_completed: ["applying", "failed", "manual_review_required"],
  // applying → failed はCOMMIT前の失敗（SQLiteトランザクション自体が丸ごとrollbackされている）
  // 場合だけを意味する。COMMIT後に失敗したことが分かった場合は必ず applied を経由する。
  applying: ["applied", "failed"],
  applied: ["post_commit_pending", "manual_review_required"],
  post_commit_pending: ["completed", "manual_review_required"],
  // 資金未確定(fundsApplied=false)の failed だけが再挑戦を許される。
  // fundsApplied=true の failed は存在しない設計（コードがそこへ到達させない）。
  failed: ["opening_reset_acquired"],
  manual_review_required: ["completed"],
  completed: [],
};

export interface OpeningExecutionRow {
  id: string;
  planHash: string;
  status: OpeningExecutionStatus;
  actorId: string;
  configuration: CasinoOpeningConfig;
  configurationHash: string;
  backupManifest: OpeningBackupManifest | null;
  externalOperationId: string | null;
  externalOperationResult: unknown | null;
  oldSettlementLandTxId: number | null;
  newInvestmentLandTxId: number | null;
  openingVersion: string | null;
  postflight: unknown | null;
  notifierStatus: "pending" | "sent" | "failed" | null;
  fundsApplied: boolean;
  reapplyAllowed: boolean;
  manualReopenRequired: boolean;
  failureStage: string | null;
  failureReason: string | null;
  manualReviewReason: string | null;
  startedAt: number;
  updatedAt: number;
  appliedAt: number | null;
  completedAt: number | null;
}

export class OpeningExecutionConflictError extends Error {
  constructor(
    readonly reason: "configuration_mismatch" | "manifest_mismatch" | "actor_mismatch",
    readonly executionId: string,
  ) {
    super(`opening execution conflict: ${reason} (execution=${executionId})`);
    this.name = "OpeningExecutionConflictError";
  }
}

export class OpeningExecutionTransitionError extends Error {
  constructor(
    readonly from: OpeningExecutionStatus,
    readonly to: OpeningExecutionStatus,
  ) {
    super(`invalid opening execution transition: ${from} -> ${to}`);
    this.name = "OpeningExecutionTransitionError";
  }
}

const now = () => Math.floor(Date.now() / 1000);

interface Raw {
  id: string;
  plan_hash: string;
  status: string;
  actor_id: string;
  configuration_json: string;
  configuration_hash: string;
  backup_manifest_json: string | null;
  external_operation_id: string | null;
  external_operation_result_json: string | null;
  old_settlement_land_tx_id: number | null;
  new_investment_land_tx_id: number | null;
  opening_version: string | null;
  postflight_json: string | null;
  notifier_status: string | null;
  funds_applied: number;
  reapply_allowed: number;
  manual_reopen_required: number;
  failure_stage: string | null;
  failure_reason: string | null;
  manual_review_reason: string | null;
  started_at: number;
  updated_at: number;
  applied_at: number | null;
  completed_at: number | null;
}

function fromRaw(row: Raw): OpeningExecutionRow {
  return {
    id: row.id,
    planHash: row.plan_hash,
    status: row.status as OpeningExecutionStatus,
    actorId: row.actor_id,
    configuration: JSON.parse(row.configuration_json) as CasinoOpeningConfig,
    configurationHash: row.configuration_hash,
    backupManifest: row.backup_manifest_json ? (JSON.parse(row.backup_manifest_json) as OpeningBackupManifest) : null,
    externalOperationId: row.external_operation_id,
    externalOperationResult: row.external_operation_result_json ? JSON.parse(row.external_operation_result_json) : null,
    oldSettlementLandTxId: row.old_settlement_land_tx_id,
    newInvestmentLandTxId: row.new_investment_land_tx_id,
    openingVersion: row.opening_version,
    postflight: row.postflight_json ? JSON.parse(row.postflight_json) : null,
    notifierStatus: (row.notifier_status as OpeningExecutionRow["notifierStatus"]) ?? null,
    fundsApplied: row.funds_applied === 1,
    reapplyAllowed: row.reapply_allowed === 1,
    manualReopenRequired: row.manual_reopen_required === 1,
    failureStage: row.failure_stage,
    failureReason: row.failure_reason,
    manualReviewReason: row.manual_review_reason,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    completedAt: row.completed_at,
  };
}

/** `acquire()` の結果 */
export interface AcquireResult {
  acquired: boolean;
  execution: OpeningExecutionRow;
}

export class OpeningExecutionStore {
  /**
   * このconstructorは一切書き込まない（CLAUDE.md監査ブロッカー1）。
   * `casino_opening_executions` のDDLは `packages/core/src/db/bootstrap.ts` にのみ存在し、
   * 旧DBへのmigrationはbootstrap（`openDb()`）だけが担当する。preflight用にこのクラスだけを
   * 構築しても、schema・row count・timestamp・outboxのいずれも変化してはいけない。
   */
  constructor(private readonly db: Database.Database) {}

  /**
   * execution を取得する（無ければ新規作成）。**INSERTの成否そのものを排他制御に使う**
   * （ChipTx.runGroup と同じ思想）。同じ planHash で別プロセス／別接続が同時に呼んでも、
   * 一方だけが `acquired:true` で新規作成し、他方は既存行を読むだけになる。
   *
   * 同じ planHash・別 configuration / 別 actor で呼ばれた場合は資金を一切動かさず
   * {@link OpeningExecutionConflictError} を投げる（取り違え検出）。
   */
  acquire(planHash: string, actorId: string, configuration: CasinoOpeningConfig): AcquireResult {
    const configurationHash = canonicalHash(configuration);
    const id = `opening-reset:${planHash}`;
    const ts = now();
    const insert = () => {
      this.db
        .prepare(
          `INSERT INTO casino_opening_executions
             (id, plan_hash, status, actor_id, configuration_json, configuration_hash, started_at, updated_at)
           VALUES (?, ?, 'planned', ?, ?, ?, ?, ?)`,
        )
        .run(id, planHash, actorId, JSON.stringify(configuration), configurationHash, ts, ts);
    };
    const run = this.db.transaction((): AcquireResult => {
      const existing = this.getRaw(id);
      if (!existing) {
        insert();
        return { acquired: true, execution: this.getOrThrow(id) };
      }
      if (existing.configuration_hash !== configurationHash) {
        throw new OpeningExecutionConflictError("configuration_mismatch", id);
      }
      return { acquired: false, execution: fromRaw(existing) };
    });
    try {
      return this.db.inTransaction ? run() : run.immediate();
    } catch (e) {
      // 真の同時実行: 2接続がどちらも「無い」を見てINSERTへ進んだ場合、片方がUNIQUE制約で落ちる。
      // 負けた側は素直に既存行を読みに行く（資金は動かしていないので安全に再読込できる）。
      if (isUniqueViolation(e)) {
        const existing = this.getOrThrow(id);
        if (existing.configurationHash !== configurationHash) {
          throw new OpeningExecutionConflictError("configuration_mismatch", id);
        }
        return { acquired: false, execution: existing };
      }
      throw e;
    }
  }

  get(id: string): OpeningExecutionRow | undefined {
    const row = this.getRaw(id);
    return row ? fromRaw(row) : undefined;
  }

  getByPlanHash(planHash: string): OpeningExecutionRow | undefined {
    return this.get(`opening-reset:${planHash}`);
  }

  private getOrThrow(id: string): OpeningExecutionRow {
    const row = this.get(id);
    if (!row) throw new Error(`opening execution not found: ${id}`);
    return row;
  }

  private getRaw(id: string): Raw | undefined {
    return this.db.prepare("SELECT * FROM casino_opening_executions WHERE id = ?").get(id) as Raw | undefined;
  }

  /** 許可された遷移かどうかだけを見る（副作用なし。テスト・事前チェック用） */
  canTransition(from: OpeningExecutionStatus, to: OpeningExecutionStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  /**
   * 状態を進める（compare-and-swap）。
   *
   * `fromStatus` は呼び出し側が**直前に自分で観測した現在の状態**を渡す。UPDATEの
   * WHERE句へ `id` と `status = fromStatus` の両方を含め、実際に更新できた行数
   * （`changes`）だけを成功の根拠にする。
   *
   * - `fromStatus` と実際のDB上の状態が一致し、更新できた → `{applied:true, execution:更新後}`
   * - 一致しなかった（**別プロセスが既にこの行を先へ進めていた**） →
   *   例外を投げず `{applied:false, execution:実際の最新行}` を返す。呼び出し側は
   *   「自分は競合に負けたが、資金は誰かが正しく処理した（か、処理中）」として
   *   `execution`（実際の状態）から続行判断すればよい。
   * - `fromStatus -> to` がFSM上そもそも許されない遷移（プログラムのバグ・状態設計の誤り）は
   *   `changes` を見るまでもなく即座に{@link OpeningExecutionTransitionError}で落とす
   *   （これは競合ではなく論理エラーなので握りつぶさない）。
   *
   * `changes === 0` を「実質成功」として黙って読み飛ばすことは絶対にしない
   * （`applied:false` として呼び出し側へ明示的に伝える）。
   */
  transition(
    id: string,
    fromStatus: OpeningExecutionStatus,
    to: OpeningExecutionStatus,
    patch: Partial<OpeningExecutionRow> = {},
  ): { applied: boolean; execution: OpeningExecutionRow } {
    if (!this.canTransition(fromStatus, to)) {
      throw new OpeningExecutionTransitionError(fromStatus, to);
    }
    const run = this.db.transaction((): { applied: boolean; execution: OpeningExecutionRow } => {
      // fundsApplied=trueの行からの failed -> opening_reset_acquired（再挑戦）は、
      // CASが一致してもなお拒否する（FSM表とは別の、資金確定後の絶対防御）。
      if (fromStatus === "failed" && to === "opening_reset_acquired") {
        const current = this.getRaw(id);
        if (current?.funds_applied === 1) {
          throw new OpeningExecutionTransitionError(fromStatus, to);
        }
      }

      const ts = now();
      const fundsApplied = fromStatus !== "failed" && to === "applied" ? true : undefined;
      const info = this.db
        .prepare(
          `UPDATE casino_opening_executions SET
             status = ?,
             backup_manifest_json = COALESCE(?, backup_manifest_json),
             external_operation_id = COALESCE(?, external_operation_id),
             external_operation_result_json = COALESCE(?, external_operation_result_json),
             old_settlement_land_tx_id = COALESCE(?, old_settlement_land_tx_id),
             new_investment_land_tx_id = COALESCE(?, new_investment_land_tx_id),
             opening_version = COALESCE(?, opening_version),
             postflight_json = COALESCE(?, postflight_json),
             notifier_status = COALESCE(?, notifier_status),
             funds_applied = CASE WHEN ? = 1 THEN 1 ELSE funds_applied END,
             reapply_allowed = CASE WHEN ? = 1 THEN 0 ELSE reapply_allowed END,
             manual_reopen_required = CASE WHEN ? = 1 THEN 1 ELSE manual_reopen_required END,
             failure_stage = COALESCE(?, failure_stage),
             failure_reason = COALESCE(?, failure_reason),
             manual_review_reason = COALESCE(?, manual_review_reason),
             updated_at = ?,
             applied_at = CASE WHEN ? = 1 THEN ? ELSE applied_at END,
             completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END
           WHERE id = ? AND status = ?`,
        )
        .run(
          to,
          patch.backupManifest ? JSON.stringify(patch.backupManifest) : null,
          patch.externalOperationId ?? null,
          patch.externalOperationResult !== undefined ? JSON.stringify(patch.externalOperationResult) : null,
          patch.oldSettlementLandTxId ?? null,
          patch.newInvestmentLandTxId ?? null,
          patch.openingVersion ?? null,
          patch.postflight !== undefined ? JSON.stringify(patch.postflight) : null,
          patch.notifierStatus ?? null,
          fundsApplied ? 1 : 0,
          to === "applied" ? 1 : 0,
          to === "manual_review_required" ? 1 : 0,
          patch.failureStage ?? null,
          patch.failureReason ?? null,
          patch.manualReviewReason ?? null,
          ts,
          to === "applied" ? 1 : 0,
          ts,
          to === "completed" ? 1 : 0,
          ts,
          id,
          fromStatus,
        );
      // CASの根拠はここだけ。0件更新を成功扱いにしない。
      if (info.changes === 0) {
        return { applied: false, execution: this.getOrThrow(id) };
      }
      if (info.changes !== 1) {
        // id は PRIMARY KEY なので複数行更新は原理的に起こらない。起きたらDB破損の疑い
        throw new Error(`opening execution CAS update affected ${info.changes} rows (expected 0 or 1): ${id}`);
      }
      return { applied: true, execution: this.getOrThrow(id) };
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  /**
   * `failed` の理由付きで停止する（副作用の巻き戻しはこのクラスの責務外）。
   * `fromStatus` とのCASが不一致（＝既に別プロセスが先へ進めていた）場合は
   * `applied:false` を返すだけで、勝者の状態を書き換えない。
   */
  markFailed(
    id: string,
    fromStatus: OpeningExecutionStatus,
    stage: string,
    reason: string,
  ): { applied: boolean; execution: OpeningExecutionRow } {
    return this.transition(id, fromStatus, "failed", { failureStage: stage, failureReason: reason });
  }

  /**
   * notifierの状態だけを更新する。**FSMの状態遷移ではない**（`completed` は終端のままでよい）。
   * CLAUDE.md §15「監査通知の失敗と資金applyの失敗を同じものとして扱わない」— 資金・statusは
   * 確定済みのまま、notifierだけを独立して何度でも再送・記録できるようにする。
   */
  recordNotifierStatus(id: string, status: "pending" | "sent" | "failed"): OpeningExecutionRow {
    const ts = now();
    this.db.prepare("UPDATE casino_opening_executions SET notifier_status = ?, updated_at = ? WHERE id = ?").run(
      status,
      ts,
      id,
    );
    return this.getOrThrow(id);
  }
}

function isUniqueViolation(e: unknown): boolean {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code?: unknown }).code) : "";
  return code.startsWith("SQLITE_CONSTRAINT");
}

export function newExternalOperationId(planHash: string): string {
  return `casino-opening:${planHash}:external:${randomUUID()}`;
}
