import type Database from "better-sqlite3";
import { SETTING_DEFAULTS, Settings } from "../settings/service.js";
import { EventLog } from "../events/service.js";
import type { SoulStatus } from "../rank/sync.js";

/**
 * 出戻り（退出 → 再参加 → 申請 → 運営判断 → 反映）。
 *
 * ## なぜ自動復帰させないか
 *
 * 再参加しただけで以前の階級へ戻すと、抜けた理由も空白期間も見ずに身分が復活する。
 * 業務上は「一度案内待ちへ戻し、本人が申請し、運営が今回の戻し先を決める」。
 * ここはその **決められた戻し先だけを実行する**装置で、任意 status を書く口ではない。
 *
 * ## 再評価面談（迷霊→亡霊）とは別物
 *
 * あちらは在籍したままの人が面談で復帰する経路で、購入した面談権を消費する。
 * こちらは一度城を出た人の受け入れ。意味論を混ぜないよう、状態も事件録も分けてある。
 */

/** 運営が選べる戻し先。`waiting` は「今回は戻さない」 */
export const RETURN_TARGETS = ["ghost", "majin", "kenma", "mazoku", "meirei", "waiting"] as const;
export type ReturnTarget = (typeof RETURN_TARGETS)[number];

export const RETURN_TARGET_LABELS: Readonly<Record<ReturnTarget, string>> = {
  ghost: "亡霊として復帰（評価を最初からやり直し）",
  majin: "魔人として復帰",
  kenma: "眷魔として復帰",
  mazoku: "魔族として復帰",
  meirei: "迷霊として復帰",
  waiting: "今回は復帰させない（案内待ちのまま）",
};

/** 運営へ見せる判断材料 */
export interface ReturnContext {
  userId: string;
  hasSoul: boolean;
  currentStatus: SoulStatus | null;
  /** 過去に在籍していたか（再参加を検知したか、退出を記録したか） */
  hasHistory: boolean;
  /** 退出の記録が無いまま出戻り対応で作った行（Bot停止中の参加などの歴史回収） */
  historyFromRecovery: boolean;
  leftAt: number | null;
  returnedAt: number | null;
  /** 退出時点の階級（再参加で waiting へ戻す前に退避したもの） */
  rankAtLeave: SoulStatus | null;
  everMeirei: boolean;
  land: number;
  /** 過去評価の概要（履歴は消さないので、いつでも参照できる） */
  pastEvaluations: number;
  pastPromotionMarks: number;
  pastDemotionMarks: number;
  inviteCount: number;
  purchases: number;
}

export interface ReinstateResult {
  to: ReturnTarget;
  /** 退出前の有効な印を無効化した件数（履歴行は残す）。どの戻し先でも整理する */
  revokedMarks?: number;
  /** 亡霊復帰のときだけ入る新しい評価サイクル */
  cycle?: {
    deadline: number;
    promotionRequired: number;
    inviteBaseline: number;
    inviteThreshold: number;
    policyVersion: string;
  };
}

const now = () => Math.floor(Date.now() / 1000);
const positiveInt = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const nonNegativeInt = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export class Returns {
  constructor(
    private readonly db: Database.Database,
    private readonly settings: Settings,
    private readonly events: EventLog,
  ) {}

  /** 退出の記録。status は変えない（階級は退出で消える性質のものではない） */
  recordDeparture(userId: string, actor = "system:member-remove"): boolean {
    const soul = this.db.prepare("SELECT status FROM souls WHERE user_id = ?").get(userId) as { status: SoulStatus } | undefined;
    if (!soul) return false;
    this.db
      .prepare(
        `UPDATE souls
            SET left_at = ?,
                rank_at_leave = CASE WHEN status = 'waiting' THEN rank_at_leave ELSE status END,
                updated_at = ?
          WHERE user_id = ?`,
      )
      .run(now(), now(), userId);
    this.events.log("entry_left", { actor, target: userId, payload: { statusAtLeave: soul.status } });
    return true;
  }

  /**
   * 再参加で案内待ちへ戻す。**以前の階級は `rank_at_leave` へ退避して失わない。**
   *
   * 評価サイクルは畳む（古い期限が残ると復帰後の判断を誤らせる）。履歴側の
   * `evaluations` / `marks` / `invites` は触らないので、後から参照できる。
   * 既に `waiting` なら何もしない（冪等）。
   */
  markReturnedToWaiting(userId: string, joinedAt: number | null, actor = "system:member-add"): SoulStatus | null {
    const soul = this.db.prepare("SELECT status, joined_at, left_at, returned_at FROM souls WHERE user_id = ?").get(userId) as
      | { status: SoulStatus; joined_at: number | null; left_at: number | null; returned_at: number | null }
      | undefined;
    if (!soul) return null;
    // **本当に出直したという証拠を要求する。**
    // `GuildMemberAdd` は再接続などで在籍中の人に再送されることがある。行があるだけで
    // 案内待ちへ落とすと、その拍子に魔族が入城前へ戻る。
    //
    // 退出の記録は「まだ処理していない退出」でなければ証拠にならない。`left_at` は
    // 復帰後も残るので、**前回の復帰より後の退出か**（`returned_at` が無いなら未処理）で見る。
    // 加えて Discord 側の参加時刻が台帳より後になっていることも証拠として認める
    const unhandledDeparture = soul.left_at !== null && (soul.returned_at === null || soul.left_at > soul.returned_at);
    const rejoined = joinedAt !== null && soul.joined_at !== null && joinedAt > soul.joined_at + 60;
    if (!unhandledDeparture && !rejoined) {
      this.events.log("entry_rejoin_ignored", {
        actor,
        target: userId,
        payload: { status: soul.status, soulJoinedAt: soul.joined_at, discordJoinedAt: joinedAt },
      });
      return null;
    }
    const ts = now();
    if (soul.status === "waiting") {
      this.db.prepare("UPDATE souls SET returned_at = ?, updated_at = ? WHERE user_id = ?").run(ts, ts, userId);
      this.events.log("entry_returned_to_waiting", { actor, target: userId, payload: { previousStatus: "waiting" } });
      return "waiting";
    }
    const changed = this.db
      .prepare(
        `UPDATE souls
            SET status = 'waiting',
                rank_at_leave = ?,
                returned_at = ?,
                ever_meirei = CASE WHEN ? = 'meirei' THEN 1 ELSE ever_meirei END,
                ghost_at = NULL,
                eval_deadline_at = NULL,
                eval_extension_days = 0,
                eval_started_at = NULL,
                eval_policy_version = NULL,
                eval_promotion_required = NULL,
                eval_demotion_threshold = NULL,
                eval_invite_mark_per_person = NULL,
                eval_invite_mark_cap = NULL,
                eval_invite_baseline = NULL,
                eval_invite_threshold = NULL,
                joined_at = COALESCE(?, joined_at),
                updated_at = ?
          WHERE user_id = ? AND status = ?`,
      )
      .run(soul.status, ts, soul.status, joinedAt, ts, userId, soul.status).changes;
    if (changed !== 1) return null;
    this.events.log("entry_returned_to_waiting", { actor, target: userId, payload: { previousStatus: soul.status } });
    return soul.status;
  }

  /**
   * 出戻り対応のために案内待ちの魂を作る。
   *
   * Bot停止中の参加などで台帳の行が無い人が対象。`recordJoin()` は使わない。
   * あれは**通常の参加イベント**で、`join` の事件録と「いま参加した」という
   * `joined_at` を作ってしまう。歴史の回収で偽の参加を作らないよう、
   * Discord が持っている実際の参加時刻を使い、専用の事件録だけを残す。
   */
  createWaitingSoulForReturn(userId: string, joinedAt: number | null, actor: string, evidence: Record<string, unknown> = {}): boolean {
    const ts = now();
    // **`returned_at` を必ず立てる。** これが無いと `isReturnee()` から見て
    // ただの新規案内待ちと区別が付かず、通常の `/審判` で亡霊にできてしまう
    const changed = this.db
      .prepare(
        "INSERT INTO souls (user_id, status, joined_at, returned_at, updated_at) VALUES (?, 'waiting', ?, ?, ?) ON CONFLICT(user_id) DO NOTHING",
      )
      .run(userId, joinedAt ?? ts, ts, ts).changes;
    if (changed !== 1) return false;
    this.events.log("entry_soul_created_for_return", {
      actor,
      target: userId,
      payload: { joinedAt: joinedAt ?? ts, joinedAtSource: joinedAt === null ? "unknown_fallback_now" : "discord", ...evidence },
    });
    return true;
  }

  /**
   * 出戻り対応が要る人か。
   *
   * 一度退出して戻ってきた人は、**通常の説明会・`/審判` からは亡霊にしない**。
   * 過去の在籍を見ずに新規と同じ扱いをすると、抜けた経緯も元の階級も無視して
   * 入城処理が走ってしまう。必ず出戻り申請 → 運営判断を通す。
   */
  isReturnee(userId: string): boolean {
    const soul = this.db.prepare("SELECT status, returned_at, left_at, rank_at_leave FROM souls WHERE user_id = ?").get(userId) as
      | { status: SoulStatus; returned_at: number | null; left_at: number | null; rank_at_leave: SoulStatus | null }
      | undefined;
    if (!soul) return false;
    if (soul.status !== "waiting") return false;
    // 再参加を検知した／退出の記録がある／退出時の階級を退避した、のいずれか
    return soul.returned_at !== null || soul.left_at !== null || soul.rank_at_leave !== null;
  }

  /** 判断材料をまとめて読む（読み取りのみ） */
  context(userId: string): ReturnContext {
    const soul = this.db.prepare("SELECT * FROM souls WHERE user_id = ?").get(userId) as
      | {
          status: SoulStatus;
          left_at: number | null;
          returned_at: number | null;
          rank_at_leave: SoulStatus | null;
          ever_meirei: number;
        }
      | undefined;
    const count = (sql: string, param: string) => (this.db.prepare(sql).get(param) as { n: number }).n;
    return {
      userId,
      hasSoul: !!soul,
      currentStatus: soul?.status ?? null,
      hasHistory: !!soul && (soul.left_at !== null || soul.returned_at !== null || soul.rank_at_leave !== null),
      // 退出の記録が無いまま出戻り対応で作られた行か（歴史回収のケース）
      historyFromRecovery: !!soul && soul.left_at === null && soul.rank_at_leave === null && soul.returned_at !== null,
      leftAt: soul?.left_at ?? null,
      returnedAt: soul?.returned_at ?? null,
      rankAtLeave: soul?.rank_at_leave ?? null,
      everMeirei: !!soul?.ever_meirei,
      land: (this.db.prepare("SELECT COALESCE(amount,0) AS n FROM balances WHERE account_id = ?").get(`user:${userId}`) as { n: number } | undefined)?.n ?? 0,
      pastEvaluations: count("SELECT COUNT(*) AS n FROM evaluations WHERE target_id = ?", userId),
      pastPromotionMarks: count("SELECT COUNT(*) AS n FROM marks WHERE target_id = ? AND kind = 'promotion'", userId),
      pastDemotionMarks: count("SELECT COUNT(*) AS n FROM marks WHERE target_id = ? AND kind = 'demotion'", userId),
      inviteCount: count("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ?", userId),
      purchases: count("SELECT COUNT(*) AS n FROM shop_purchases WHERE user_id = ?", userId),
    };
  }

  /**
   * 運営が選んだ戻し先を反映する。**`waiting` からの1手だけ**を許す。
   *
   * `WHERE status='waiting'` の CAS 付きなので、二重クリックや別の運営との競合では
   * 2回目が 0行更新になり `null` を返す。
   *
   * 亡霊復帰だけが評価サイクルを作る。上位階級・迷霊は status を置くだけで、
   * 評価期間も印も触らない（上位階級に評価サイクルは無く、迷霊は懲罰状態のため）。
   * どの戻し先でも初期Landは発行しない。
   */
  reinstate(userId: string, to: ReturnTarget, actor: string, evidence: Record<string, unknown>): ReinstateResult | null {
    if (to === "waiting") {
      // 「今回は戻さない」。階級は動かさないが、**退出前の印はここで整理する**。
      // 残したままだと後で通常入城したときに古い進捗が生き返る
      const revokedMarks = this.db.prepare("UPDATE marks SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL").run(now(), userId).changes;
      if (revokedMarks > 0) {
        this.events.log("entry_return_marks_reset", {
          actor,
          target: userId,
          payload: { revoked: revokedMarks, to, reason: "復帰させない場合も退出前の評価進捗は持ち越さない" },
        });
      }
      this.events.log("entry_return_declined", { actor, target: userId, payload: { revokedMarks, ...evidence } });
      return { to, revokedMarks };
    }

    const body = (): ReinstateResult | null => {
      if (to !== "ghost") {
        const ts = now();
        const changed = this.db
          .prepare("UPDATE souls SET status = ?, ever_meirei = CASE WHEN ? = 'meirei' THEN 1 ELSE ever_meirei END, updated_at = ? WHERE user_id = ? AND status = 'waiting'")
          .run(to, to, ts, userId).changes;
        if (changed !== 1) return null;
        // **どの戻し先でも退出前の印は持ち越さない。** 上位階級には評価サイクルが無いので
        // すぐには効かないが、後で迷霊落ち→再評価となったときに古い印が生き返る。
        // 履歴は消さず revoked にする
        const revokedMarks = this.db.prepare("UPDATE marks SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL").run(ts, userId).changes;
        return { to, revokedMarks };
      }

      // ---- 亡霊復帰: 新しい評価サイクルを最初から始める ----
      const ts = now();
      const baseDays = positiveInt(this.settings.getNumber("eval_base_period_days"), SETTING_DEFAULTS.eval_base_period_days);
      const basePromotion = positiveInt(this.settings.getNumber("promotion_marks_required"), SETTING_DEFAULTS.promotion_marks_required);
      const extra = nonNegativeInt(this.settings.getNumber("returnee_promotion_extra"), SETTING_DEFAULTS.returnee_promotion_extra);
      // 出戻り亡霊は通常より必要なアリが多い。**その値をこのサイクルの snapshot へ焼く**
      const promotionRequired = basePromotion + extra;
      const demotionThreshold = positiveInt(this.settings.getNumber("demotion_marks_threshold"), SETTING_DEFAULTS.demotion_marks_threshold);
      const inviteThreshold = positiveInt(this.settings.getNumber("invite_marks_threshold"), SETTING_DEFAULTS.invite_marks_threshold);
      // 過去の招待をこのサイクルへ持ち越さない。履歴は消さず、起点だけ記録する
      const inviteBaseline = (this.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ?").get(userId) as { n: number }).n;
      const deadline = ts + baseDays * 86_400;
      const policyVersion = `return:${promotionRequired}:${demotionThreshold}:${inviteThreshold}:${ts}`;

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
                  eval_invite_baseline = ?,
                  eval_invite_threshold = ?,
                  updated_at = ?
            WHERE user_id = ? AND status = 'waiting'`,
        )
        .run(ts, ts, deadline, policyVersion, promotionRequired, demotionThreshold, inviteBaseline, inviteThreshold, ts, userId).changes;
      if (changed !== 1) return null;

      // 以前の印は履歴を残したまま無効化する（新しい評価は白紙から）
      const revokedMarks = this.db.prepare("UPDATE marks SET revoked_at = ? WHERE target_id = ? AND revoked_at IS NULL").run(ts, userId).changes;
      return {
        to,
        revokedMarks,
        cycle: { deadline, promotionRequired, inviteBaseline, inviteThreshold, policyVersion },
      };
    };

    const result = this.db.inTransaction ? body() : this.db.transaction(body).immediate();
    if (!result) {
      this.events.log("entry_return_skipped", { actor, target: userId, payload: { to, reason: "precondition_lost" } });
      return null;
    }
    if ((result.revokedMarks ?? 0) > 0) {
      this.events.log("entry_return_marks_reset", {
        actor,
        target: userId,
        payload: { revoked: result.revokedMarks, to, reason: "出戻りでは退出前の評価進捗を持ち越さないため以前の印を取り消し" },
      });
    }
    this.events.log("entry_return_reinstated", {
      actor,
      target: userId,
      payload: { to, cycle: result.cycle ?? null, revokedMarks: result.revokedMarks ?? 0, ...evidence },
    });
    return result;
  }
}
