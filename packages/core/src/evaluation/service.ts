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

export interface SubmitResult {
  evaluationId: number;
  promotion: PromotionScore;
  demotionCount: number;
  promotionReached: boolean;
  demotionReached: boolean;
}

export interface SoulDeadlineRow {
  user_id: string;
  eval_deadline_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

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

  addMark(targetId: string, kind: "promotion" | "demotion", grantedBy: string, ref?: string): number {
    const result = this.db
      .prepare("INSERT INTO marks (target_id, kind, granted_by, ref, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(targetId, kind, grantedBy, ref ?? null, now());
    this.events.log(kind === "promotion" ? "mark_promotion" : "mark_demotion", {
      actor: grantedBy,
      target: targetId,
      payload: { ref },
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
        .prepare("SELECT COUNT(*) AS c FROM marks WHERE target_id = ? AND kind = 'promotion' AND revoked_at IS NULL")
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
        .prepare("SELECT COUNT(*) AS c FROM marks WHERE target_id = ? AND kind = 'demotion' AND revoked_at IS NULL")
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
    threadId?: string;
  }): SubmitResult {
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
      markId = this.addMark(input.targetId, input.conclusion, input.evaluatorId, "evaluation");
    }
    const result = this.db
      .prepare(
        `INSERT INTO evaluations (target_id, evaluator_id, scores_json, texts_json, conclusion, mark_id, thread_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.targetId,
        input.evaluatorId,
        JSON.stringify(input.scores),
        JSON.stringify(input.texts),
        input.conclusion,
        markId,
        input.threadId ?? null,
        now(),
      );

    const promotion = this.promotionScore(input.targetId);
    const demotionCount = this.demotionCount(input.targetId);
    return {
      evaluationId: Number(result.lastInsertRowid),
      promotion,
      demotionCount,
      promotionReached: promotion.total >= this.settings.getNumber("promotion_marks_required"),
      demotionReached: demotionCount >= this.settings.getNumber("demotion_marks_threshold"),
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
    const required = this.settings.getNumber("promotion_marks_required");
    return (
      this.db
        .prepare(
          `SELECT user_id, eval_deadline_at FROM souls
           WHERE status = 'ghost' AND eval_deadline_at IS NOT NULL AND eval_deadline_at < ?
           ORDER BY eval_deadline_at`,
        )
        .all(atTs) as SoulDeadlineRow[]
    ).filter((r) => this.promotionScore(r.user_id).total < required);
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
