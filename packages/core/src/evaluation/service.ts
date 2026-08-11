import type Database from "better-sqlite3";
import { SETTING_DEFAULTS, Settings } from "../settings/service.js";
import { EventLog } from "../events/service.js";

export type Conclusion = "promotion" | "demotion" | "none";

export interface EvalScores {
  voice: number;
  communication: number;
  presence: number;
  understanding: number;
}

export interface EvalTexts {
  detail?: string;
  merit?: string;
  concern?: string;
  feedback?: string;
  others?: string;
}

export interface PromotionScore {
  evalMarks: number;
  inviteCount: number;
  inviteScore: number; // 0.5/人・上限1.0（設定値）
  total: number;
}

export interface EvalThresholds {
  promotionRequired: number;
  demotionThreshold: number;
  inviteMarkPerPerson: number;
  inviteMarkCap: number;
  policyVersion: string;
  startedAt: number | null;
  snapshotted: boolean;
}

export interface EvaluationHistoryRow {
  id: number;
  target_id: string;
  evaluator_id: string;
  scores_json: string;
  texts_json: string;
  conclusion: Conclusion;
  mark_id: number | null;
  mark_weight: number;
  thread_id: string | null;
  created_at: number;
}

export interface PreviousEvaluation {
  id: number;
  scores: EvalScores;
  texts: EvalTexts;
  conclusion: Conclusion;
  markWeight: number;
  createdAt: number;
}

export interface SubmitResult {
  evaluationId: number;
  promotion: PromotionScore;
  demotionCount: number;
  thresholds: EvalThresholds;
  promotionReached: boolean;
  demotionReached: boolean;
}

export interface SoulDeadlineRow {
  user_id: string;
  eval_deadline_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 印台帳 + 評価（ボット設計.md 評価・印・招待トラッキング）。
 * 昇格印5個（うち招待で最大1個）で面談待ち、低評価印4個で迷霊即落ち。閾値・換算値はすべて設定値。
 */
export class Evaluation {
  constructor(
    private readonly db: Database.Database,
    private readonly settings: Settings,
    private readonly events: EventLog,
  ) {}

  // ---- 印台帳 ----

  thresholdsFor(targetId: string): EvalThresholds {
    const row = this.db
      .prepare(
        `SELECT eval_started_at, eval_policy_version, eval_promotion_required, eval_demotion_threshold
              , eval_invite_mark_per_person, eval_invite_mark_cap
         FROM souls WHERE user_id = ?`,
      )
      .get(targetId) as
      | {
          eval_started_at: number | null;
          eval_policy_version: string | null;
          eval_promotion_required: number | null;
          eval_demotion_threshold: number | null;
          eval_invite_mark_per_person: number | null;
          eval_invite_mark_cap: number | null;
        }
      | undefined;
    const currentPromotion = positiveInt(this.settings.getNumber("promotion_marks_required")) ?? SETTING_DEFAULTS.promotion_marks_required;
    const currentDemotion = positiveInt(this.settings.getNumber("demotion_marks_threshold")) ?? SETTING_DEFAULTS.demotion_marks_threshold;
    const currentInvitePer = nonNegativeNumber(this.settings.getNumber("invite_mark_per_person")) ?? SETTING_DEFAULTS.invite_mark_per_person;
    const currentInviteCap = nonNegativeNumber(this.settings.getNumber("invite_mark_cap")) ?? SETTING_DEFAULTS.invite_mark_cap;
    const promotionRequired = positiveInt(row?.eval_promotion_required) ?? currentPromotion;
    const demotionThreshold = positiveInt(row?.eval_demotion_threshold) ?? currentDemotion;
    const inviteMarkPerPerson = nonNegativeNumber(row?.eval_invite_mark_per_person) ?? currentInvitePer;
    const inviteMarkCap = nonNegativeNumber(row?.eval_invite_mark_cap) ?? currentInviteCap;
    return {
      promotionRequired,
      demotionThreshold,
      inviteMarkPerPerson,
      inviteMarkCap,
      policyVersion: row?.eval_policy_version ?? `current:${currentPromotion}:${currentDemotion}:${currentInvitePer}:${currentInviteCap}`,
      startedAt: row?.eval_started_at ?? null,
      snapshotted:
        row?.eval_promotion_required != null &&
        row?.eval_demotion_threshold != null &&
        row?.eval_invite_mark_per_person != null &&
        row?.eval_invite_mark_cap != null,
    };
  }

  addMark(targetId: string, kind: "promotion" | "demotion", grantedBy: string, ref?: string, weight = 1): number {
    const safeWeight = positiveInt(weight);
    if (!safeWeight) throw new Error("mark weight must be a positive integer");
    const result = this.db
      .prepare("INSERT INTO marks (target_id, kind, granted_by, ref, weight, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(targetId, kind, grantedBy, ref ?? null, safeWeight, now());
    this.events.log(kind === "promotion" ? "mark_promotion" : "mark_demotion", {
      actor: grantedBy,
      target: targetId,
      payload: { ref, weight: safeWeight },
    });
    return Number(result.lastInsertRowid);
  }

  revokeMark(markId: number, actor: string): void {
    this.db.prepare("UPDATE marks SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), markId);
    this.events.log("mark_revoked", { actor, payload: { markId } });
  }

  promotionScore(targetId: string): PromotionScore {
    const evalMarks = (
      this.db
        .prepare("SELECT COALESCE(SUM(weight), 0) AS c FROM marks WHERE target_id = ? AND kind = 'promotion' AND revoked_at IS NULL")
        .get(targetId) as { c: number }
    ).c;
    const inviteCount = (
      this.db.prepare("SELECT COUNT(*) AS c FROM invites WHERE inviter_id = ?").get(targetId) as { c: number }
    ).c;
    const thresholds = this.thresholdsFor(targetId);
    const per = thresholds.inviteMarkPerPerson;
    const cap = thresholds.inviteMarkCap;
    const inviteScore = Math.min(inviteCount * per, cap);
    return { evalMarks, inviteCount, inviteScore, total: evalMarks + inviteScore };
  }

  demotionCount(targetId: string): number {
    return (
      this.db
        .prepare("SELECT COALESCE(SUM(weight), 0) AS c FROM marks WHERE target_id = ? AND kind = 'demotion' AND revoked_at IS NULL")
        .get(targetId) as { c: number }
    ).c;
  }

  // ---- 評価の投稿 ----

  submitEvaluation(input: {
    targetId: string;
    evaluatorId: string;
    scores: EvalScores;
    texts: EvalTexts;
    conclusion: Conclusion;
    markWeight?: number;
    threadId?: string;
  }): SubmitResult {
    const markWeight = input.conclusion === "none" ? 0 : (positiveInt(input.markWeight) ?? 1);
    const insertEvaluation = this.db.transaction(() => {
      const ts = now();
      // 同一評価員の再評価は上書き: 同じ評価員が同じ対象に付けた既存の印を取り消してから記帳する
      // （1評価員=最新の結論1つだけが有効。評価の履歴自体は evaluations に追記で残る）
      const superseded = this.db
        .prepare(
          "UPDATE marks SET revoked_at = ? WHERE target_id = ? AND granted_by = ? AND ref = 'evaluation' AND revoked_at IS NULL",
        )
        .run(ts, input.targetId, input.evaluatorId);
      if (superseded.changes > 0) {
        this.events.log("mark_superseded", {
          actor: input.evaluatorId,
          target: input.targetId,
          payload: { count: superseded.changes },
        });
      }

      let markId: number | null = null;
      if (input.conclusion !== "none") {
        markId = this.addMark(input.targetId, input.conclusion, input.evaluatorId, "evaluation", markWeight);
      }
      return this.db
        .prepare(
          `INSERT INTO evaluations (target_id, evaluator_id, scores_json, texts_json, conclusion, mark_id, mark_weight, thread_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.targetId,
          input.evaluatorId,
          JSON.stringify(input.scores),
          JSON.stringify(input.texts),
          input.conclusion,
          markId,
          markWeight,
          input.threadId ?? null,
          ts,
        );
    });
    const result = insertEvaluation();

    const promotion = this.promotionScore(input.targetId);
    const demotionCount = this.demotionCount(input.targetId);
    const thresholds = this.thresholdsFor(input.targetId);
    return {
      evaluationId: Number(result.lastInsertRowid),
      promotion,
      demotionCount,
      thresholds,
      promotionReached: promotion.total >= thresholds.promotionRequired,
      demotionReached: demotionCount >= thresholds.demotionThreshold,
    };
  }

  latestByEvaluator(targetId: string, evaluatorId: string): PreviousEvaluation | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM evaluations
         WHERE target_id = ? AND evaluator_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(targetId, evaluatorId) as EvaluationHistoryRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      scores: JSON.parse(row.scores_json) as EvalScores,
      texts: JSON.parse(row.texts_json) as EvalTexts,
      conclusion: row.conclusion,
      markWeight: row.mark_weight,
      createdAt: row.created_at,
    };
  }

  /** 評価件数 = 評価員の人数（同一評価員の再評価は1件と数える） */
  evaluationCount(targetId: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(DISTINCT evaluator_id) AS c FROM evaluations WHERE target_id = ?")
        .get(targetId) as { c: number }
    ).c;
  }

  // ---- 階級遷移（ロール操作はbot側。ここは魂台帳と事件録のみ）----

  demoteToMeirei(targetId: string, actor: string, reason: string): void {
    this.db
      .prepare("UPDATE souls SET status = 'meirei', updated_at = ? WHERE user_id = ?")
      .run(now(), targetId);
    this.events.log("demotion", { actor, target: targetId, payload: { reason } });
  }

  promoteToMajin(targetId: string, actor: string): void {
    this.db
      .prepare("UPDATE souls SET status = 'majin', eval_deadline_at = NULL, updated_at = ? WHERE user_id = ?")
      .run(now(), targetId);
    this.events.log("promotion", { actor, target: targetId, payload: { to: "majin" } });
  }

  /**
   * 再評価面談OK: `meirei → ghost` の復帰。
   *
   * **`ghostify()` を流用しない。** あちらは入城処理なので初期発行・招待実績の計上・
   * 招待者の期限延長まで抱えている。ここは「一度落ちた人がもう一度評価を受け直す」
   * 復帰なので、**新しい評価サイクルの開始だけ**を行う。
   *
   * - 初期Landの再発行なし・`invites` の再計上なし・招待者の期限延長なし・予約行に触れない
   * - 招待実績由来の昇格スコアは `invites` を消さないので現状どおり引き継がれる
   * - 以前の昇格印・降格印は**履歴を残したまま** revoked にする（新しい評価を白紙から始める）
   *
   * `WHERE status='meirei'` を条件に入れてあるので、面談中に別経路で階級が動いていたら
   * 0行更新で `null` を返す（前提が崩れた状態で書かない）。
   */
  reinstateFromMeirei(
    targetId: string,
    actor: string,
    evidence: Record<string, unknown>,
  ): { deadline: number; revokedMarks: number; policyVersion: string } | null {
    const ts = now();
    const baseDays = positiveInt(this.settings.getNumber("eval_base_period_days")) ?? SETTING_DEFAULTS.eval_base_period_days;
    const promotionRequired =
      positiveInt(this.settings.getNumber("promotion_marks_required")) ?? SETTING_DEFAULTS.promotion_marks_required;
    const demotionThreshold =
      positiveInt(this.settings.getNumber("demotion_marks_threshold")) ?? SETTING_DEFAULTS.demotion_marks_threshold;
    const inviteMarkPerPerson =
      nonNegativeNumber(this.settings.getNumber("invite_mark_per_person")) ?? SETTING_DEFAULTS.invite_mark_per_person;
    const inviteMarkCap = nonNegativeNumber(this.settings.getNumber("invite_mark_cap")) ?? SETTING_DEFAULTS.invite_mark_cap;
    const policyVersion =
      this.settings.getString("eval_policy_version") ??
      `reeval:${promotionRequired}:${demotionThreshold}:${inviteMarkPerPerson}:${inviteMarkCap}:${ts}`;
    const deadline = ts + baseDays * 86_400;

    const run = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE souls
              SET status = 'ghost',
                  ghost_at = ?,
                  eval_started_at = ?,
                  eval_deadline_at = ?,
                  eval_extension_days = 0,
                  eval_policy_version = ?,
                  eval_promotion_required = ?,
                  eval_demotion_threshold = ?,
                  eval_invite_mark_per_person = ?,
                  eval_invite_mark_cap = ?,
                  updated_at = ?
            WHERE user_id = ? AND status = 'meirei'`,
        )
        .run(ts, ts, deadline, policyVersion, promotionRequired, demotionThreshold, inviteMarkPerPerson, inviteMarkCap, ts, targetId)
        .changes;
      if (changed !== 1) return null;
      // 履歴は消さず、有効な印だけ取り消す（再評価は白紙から）
      const revokedMarks = this.db
        .prepare("UPDATE marks SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL")
        .run(ts, targetId).changes;
      return { revokedMarks };
    });
    const result = run.immediate();
    if (!result) {
      this.events.log("reeval_reinstate_skipped", { actor, target: targetId, payload: { reason: "precondition_lost" } });
      return null;
    }
    if (result.revokedMarks > 0) {
      this.events.log("reeval_marks_reset", {
        actor,
        target: targetId,
        payload: { revoked: result.revokedMarks, reason: "再評価サイクル開始のため以前の印を取り消し" },
      });
    }
    this.events.log("reeval_reinstated", {
      actor,
      target: targetId,
      payload: {
        from: "meirei",
        to: "ghost",
        ghostAt: ts,
        evalStartedAt: ts,
        evalDeadlineAt: deadline,
        policy: { policyVersion, promotionRequired, demotionThreshold, inviteMarkPerPerson, inviteMarkCap, baseDays },
        revokedMarks: result.revokedMarks,
        ...evidence,
      },
    });
    return { deadline, revokedMarks: result.revokedMarks, policyVersion };
  }

  /** 再評価面談NG。status・ロール・印のどれも動かさず、判断だけ残す */
  recordReevalRejection(targetId: string, actor: string, evidence: Record<string, unknown>): void {
    this.events.log("reeval_rejected", { actor, target: targetId, payload: evidence });
  }

  /**
   * 履歴追認: `waiting → majin` を台帳へ書くだけ。
   *
   * **評価期間も初期発行も作らない。** 既に運用上は魔人として扱われている人の
   * 台帳を実態へ合わせるためだけの操作なので、`ghostify()` の副作用を持ち込まない。
   * `WHERE status='waiting'` を条件に入れてあるので、同時実行や二度押しで
   * 上位階級を巻き戻すことはない（0行更新になり false が返る）。
   */
  backfillHistoricalRank(
    targetId: string,
    to: "majin",
    actor: string,
    evidence: Record<string, unknown>,
  ): boolean {
    const changed = this.db
      .prepare("UPDATE souls SET status = ?, updated_at = ? WHERE user_id = ? AND status = 'waiting'")
      .run(to, now(), targetId).changes;
    if (changed !== 1) {
      this.events.log("rank_history_backfill_skipped", { actor, target: targetId, payload: { to, reason: "precondition_lost" } });
      return false;
    }
    this.events.log("rank_history_backfill", { actor, target: targetId, payload: { from: "waiting", to, evidence } });
    return true;
  }

  /**
   * 昇格記録の追いつき: `ghost → majin`。
   *
   * `promoteToMajin()` と**同じDB意味論**（status と評価期限のクリア）と `promotion` 事件録だけを行う。
   * ロール付与も公開告知もしない（どちらも既に済んでいるのが前提）。
   */
  catchUpPromotion(targetId: string, actor: string, evidence: Record<string, unknown>): boolean {
    const changed = this.db
      .prepare("UPDATE souls SET status = 'majin', eval_deadline_at = NULL, updated_at = ? WHERE user_id = ? AND status = 'ghost'")
      .run(now(), targetId).changes;
    if (changed !== 1) {
      this.events.log("promotion_catchup_skipped", { actor, target: targetId, payload: { reason: "precondition_lost" } });
      return false;
    }
    this.events.log("promotion", { actor, target: targetId, payload: { to: "majin", catchup: true, evidence } });
    return true;
  }

  /**
   * Discord のロール構成に合わせて階級を書き直す（rank sync 専用）。
   *
   * **どの遷移を許すかはここでは判断しない。** 呼び出し側が
   * `decideRankSync()` で許可された遷移だけを渡す約束にしてある。
   * ここを汎用の「任意 status を書く口」にすると、入城処理を迂回して
   * waiting から魔族へ飛ばす、といった使い方ができてしまう。
   *
   * 期待する現在値（`expectedFrom`）を渡し、UPDATE の WHERE で照合する。
   * 判定してから書くまでの間に別経路が階級を動かしていたら 0 行更新になり、
   * 古い判断で上書きしない。
   */
  syncStatusFromRoles(
    targetId: string,
    expectedFrom: string,
    to: string,
    actor: string,
    meta: Record<string, unknown> = {},
  ): boolean {
    const changed = this.db
      .prepare("UPDATE souls SET status = ?, updated_at = ? WHERE user_id = ? AND status = ?")
      .run(to, now(), targetId, expectedFrom).changes;
    if (changed !== 1) {
      this.events.log("rank_sync_stale", { actor, target: targetId, payload: { expectedFrom, to, ...meta } });
      return false;
    }
    this.events.log("rank_sync_applied", { actor, target: targetId, payload: { from: expectedFrom, to, ...meta } });
    return true;
  }

  // ---- カロンの材料 ----

  /** 評価期間中（ghost）の期限一覧。fromTs <= 期限 < toTs */
  dueBetween(fromTs: number, toTs: number): SoulDeadlineRow[] {
    return this.db
      .prepare(
        `SELECT user_id, eval_deadline_at FROM souls
         WHERE status = 'ghost' AND eval_deadline_at IS NOT NULL AND eval_deadline_at >= ? AND eval_deadline_at < ?
         ORDER BY eval_deadline_at`,
      )
      .all(fromTs, toTs) as SoulDeadlineRow[];
  }

  /** 期限切れ（迷霊落ち承認パネルの対象）。昇格到達者は面談待ちのため除外 */
  overdue(atTs = now()): SoulDeadlineRow[] {
    return (
      this.db
        .prepare(
          `SELECT user_id, eval_deadline_at FROM souls
           WHERE status = 'ghost' AND eval_deadline_at IS NOT NULL AND eval_deadline_at < ?
           ORDER BY eval_deadline_at`,
        )
        .all(atTs) as SoulDeadlineRow[]
    ).filter((r) => {
      const thresholds = this.thresholdsFor(r.user_id);
      return this.promotionScore(r.user_id).total < thresholds.promotionRequired;
    });
  }

  // ---- 評価フォーラムのスレッド対応表 ----

  threadFor(userId: string): string | undefined {
    const row = this.db.prepare("SELECT thread_id FROM eval_threads WHERE user_id = ?").get(userId) as
      | { thread_id: string }
      | undefined;
    return row?.thread_id;
  }

  setThread(userId: string, threadId: string): void {
    this.db
      .prepare(
        "INSERT INTO eval_threads (user_id, thread_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET thread_id = excluded.thread_id",
      )
      .run(userId, threadId);
  }
}
