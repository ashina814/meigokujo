import type Database from "better-sqlite3";
import { Settings } from "../settings/service.js";
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
         FROM souls WHERE user_id = ?`,
      )
      .get(targetId) as
      | {
          eval_started_at: number | null;
          eval_policy_version: string | null;
          eval_promotion_required: number | null;
          eval_demotion_threshold: number | null;
        }
      | undefined;
    const currentPromotion = this.settings.getNumber("promotion_marks_required");
    const currentDemotion = this.settings.getNumber("demotion_marks_threshold");
    const promotionRequired = positiveInt(row?.eval_promotion_required) ?? currentPromotion;
    const demotionThreshold = positiveInt(row?.eval_demotion_threshold) ?? currentDemotion;
    return {
      promotionRequired,
      demotionThreshold,
      policyVersion: row?.eval_policy_version ?? `current:${currentPromotion}:${currentDemotion}`,
      startedAt: row?.eval_started_at ?? null,
      snapshotted: row?.eval_promotion_required !== null && row?.eval_demotion_threshold !== null,
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
    const per = this.settings.getNumber("invite_mark_per_person");
    const cap = this.settings.getNumber("invite_mark_cap");
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
    // 同一評価員の再評価は上書き: 同じ評価員が同じ対象に付けた既存の印を取り消してから記帳する
    // （1評価員=最新の結論1つだけが有効。評価の履歴自体は evaluations に追記で残る）
    const superseded = this.db
      .prepare(
        "UPDATE marks SET revoked_at = ? WHERE target_id = ? AND granted_by = ? AND ref = 'evaluation' AND revoked_at IS NULL",
      )
      .run(now(), input.targetId, input.evaluatorId);
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
    const result = this.db
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
        now(),
      );

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
