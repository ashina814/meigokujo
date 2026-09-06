import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";

/**
 * トートの耳（匿名タレコミ／懺悔）。
 *
 * 告発者は完全匿名。user_id は DB にのみ保持し、運営に見せる UI には一切出さない。
 * トート（ボット）が仲介して運営↔告発者の会話を中継する（告発者は実チャンネルに入れない）。
 *
 * - create: 告発を受け付けて受付番号を発行（user_id はここだけが握る）
 * - claim:  運営が対応スレッドを開いて紐付け
 * - close:  対応終了
 * - block:  以後この告発者の投稿を受け付けない（サイレントドロップ）
 */
export type ConfessionStatus = "open" | "claimed" | "closed";

/** 投稿種類（§4）。値はコード、表示名はUI層で解決する */
export type ConfessionType = "soudan" | "zange" | "iken" | "houkoku" | "kinkyu";
/** 返信希望（§5） */
export type ReplyWish = "yes" | "no" | "either";

/**
 * 運用上の細かい状態（Phase 2）。既存の status(open/claimed/closed) と併存し、
 * status='claimed' の間の内訳を表す。open は未対応、closed は終結。
 */
export type ConfessionStage =
  | "active" // 対応中
  | "awaiting_poster" // 投稿者からの返信待ち
  | "awaiting_staff" // 担当者からの返信待ち
  | "internal_hold" // 運営側の確認・作業待ち（投稿者待ちではない＝自動終了の対象外）
  | "handoff" // 外部への引継ぎ中（通常運営/諧和廷）
  | "court_review" // 裁判所への送致確認中
  | "court_sent" // 裁判所へ送致済み
  | "emergency"; // 緊急対応中

/** 対応先（Phase 2 §1） */
export type Disposition = "church" | "normal" | "kaiwa" | "court" | "emergency" | "record";

/** クローズ理由（Phase 2 §4）。info_only は旧「対応先=記録のみ」を移行した終了理由 */
export type CloseReason =
  | "resolved"
  | "poster_ended"
  | "no_response"
  | "handoff_normal"
  | "handoff_kaiwa"
  | "sent_court"
  | "info_only"
  | "no_action"
  | "voice_received"
  | "other";

export interface ConfessionRow {
  id: number;
  user_id: string;
  status: ConfessionStatus;
  thread_id: string | null;
  claimed_by: string | null;
  created_at: number;
  claimed_at: number | null;
  closed_at: number | null;
  // Phase 1 で加算（既存行は NULL）
  type: string | null;
  reply_wish: string | null;
  body: string | null;
  // Phase 2 で加算
  stage: string | null;
  disposition: string | null;
  disposition_at: number | null;
  disposition_by: string | null;
  close_reason: string | null;
  closed_by: string | null;
  body_purge_at: number | null; // この時刻を過ぎたら本文をpurge可能
  body_purged_at: number | null; // 実際にpurgeした時刻（非NULL＝本文は削除済み）
  body_retention_reason: string | null; // 保持延長の理由
  panel_msg_id: string | null; // 対応スレッドの管理パネルのメッセージID
  // 会話の終端（Task #219）で加算
  acknowledged_at: number | null; // 受領確認（📨 届きました）を送った時刻。回答でも終了でもない
  acknowledged_by: string | null;
  reply_deadline_at: number | null; // 「返答を待つ」で明示的に置いた投稿者の返答期限。これがある案件だけ自動終了する
  closed_side: string | null; // sender | staff | timeout
  // Phase 3（冥府裁判所への送致）で加算
  court_status: string | null; // pending_consent | sent | canceled
  court_category: string | null; // civil | criminal | joined | enma
  court_consent: string | null; // 意思確認状況コード（下記 CourtConsent）
  court_thread_id: string | null; // 送致先フォーラム投稿の thread_id
  court_url: string | null; // 送致先投稿のURL
  court_case_no: string | null; // 事件番号（後から入力: 冥府刑事第003号 等）
  court_sent_at: number | null;
  court_sent_by: string | null;
  court_form: string | null; // 送致概要JSON {reason, summary, wants}
}

export interface AssigneeRow {
  confession_id: number;
  user_id: string;
  added_by: string;
  added_at: number;
  removed_at: number | null;
}

/** 緊急対応記録（Phase 4）。処分は自動実行しない、人間確認のための記録 */
export interface EmergencyRow {
  id: number;
  confession_id: number;
  created_by: string;
  created_at: number;
  reason: string;
  target: string;
  danger_ongoing: number; // 0/1
  measures: string; // カンマ区切りコード
  review_note: string | null; // 見直し予定（自由記述: 例「3日後」）
  note: string | null;
  status: string; // open | confirmed | closed
  confirmed_by: string | null;
  closed_at: number | null;
}

/**
 * 「返答を待つ」で返信したあと、投稿者からの反応が無いまま自動終了するまでの日数。
 *
 * **この値の正本はここだけ。** Bot 側の予告文・自動終了・期限計算はすべてこの定数（または
 * `senderReplyDeadlineFrom()`）を通す。literal をコピーしないこと。
 */
export const CONFESSION_SENDER_REPLY_DEADLINE_DAYS = 7;

/** 上の日数を秒で。期限計算はここから導出する（日数と秒の二重定義を作らない） */
export const CONFESSION_SENDER_REPLY_DEADLINE_SECONDS = CONFESSION_SENDER_REPLY_DEADLINE_DAYS * 86_400;

/** 「いま次に動くのは誰か」。stage の数ではなく、この一意な答えが運用UIの正本。 */
export type ConfessionBall =
  | "staff_attention" // 運営が見るべき（未対応 / 対応中 / 投稿者から反応があった）
  | "waiting_sender" // 投稿者の返答待ち（明示的な期限つき）
  | "waiting_staff" // 運営側の確認・作業待ち（自動終了しない）
  | "legacy_open" // 期限の根拠が無い既存 open。推測で投稿者待ちにしない
  | "closed";

/**
 * 次のball。`reply_deadline_at` が付いている案件だけを本当の「投稿者待ち」と見なす。
 *
 * 既存DBの `awaiting_poster` は「担当者がスレッドに書いた」だけで自動的に付いた値であって、
 * 「運営が返答を待つと決めた」証拠ではない。だから期限が無いものは `legacy_open` に落とし、
 * 自動終了の対象にしない（Task #219 §11）。
 */
export function confessionBall(row: ConfessionRow): ConfessionBall {
  if (row.status === "closed") return "closed";
  if (row.status === "open") return "staff_attention";
  if (row.stage === "internal_hold") return "waiting_staff";
  if (row.stage === "awaiting_poster") return row.reply_deadline_at !== null ? "waiting_sender" : "legacy_open";
  return "staff_attention";
}

/** 誰がこの会話を終わらせたか。運営内部の理由(close_reason)とは別の軸。 */
export type ClosedSide = "sender" | "staff" | "timeout";

/**
 * 外部送信の結果。**この3つを混同しない。**
 *
 * - `delivered`   … Discord が受理した。届いたと言ってよい
 * - `failed`      … Discord が明確に拒否した（DiscordAPIError＝サーバの確定応答）。
 *                    届いていないと言ってよく、再送しても重複しない
 * - `unknown`     … 応答が得られなかった（ネットワーク・timeout・中断）。
 *                    **届いたとも届いていないとも言えない。** 自動で再送しない
 */
export type DeliveryOutcome = "delivered" | "failed" | "unknown";

/** 受領確認の送信試行。「押した」「送り始めた」「届いた」を別々に残すための行。 */
export interface AckAttemptRow {
  id: number;
  confession_id: number;
  staff_id: string;
  started_at: number;
  finished_at: number | null;
  outcome: string | null; // NULL = 送信中
}

export type AckBeginResult =
  | { ok: true; attemptId: number; row: ConfessionRow }
  | {
      ok: false;
      code: "not_found" | "already_closed" | "already_delivered" | "attempt_in_flight";
      row?: ConfessionRow;
    };

/** 担当者から見た受領確認の現在地。UI はこれだけを見る（推測しない）。 */
export type AckState = "none" | "in_flight" | "delivered" | "failed" | "unknown";

/** 投稿者の追記。Discord へ渡す前に本文をここへ確定させ、送信失敗で消えないようにする。 */
export interface FollowUpRow {
  id: number;
  confession_id: number;
  sender_id: string;
  body: string | null; // 引き渡し確定後は NULL（retention を迂回しない）
  created_at: number;
  relayed_at: number | null;
  outcome: string | null; // NULL = 未引き渡し / sending | delivered | failed | unknown | resolved_manually
  attempts: number;
  body_purge_at: number | null;
  owner_instance: string | null;
  generation: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

export type FollowUpResult =
  | { ok: true; followUpId: number; row: ConfessionRow }
  | { ok: false; code: "not_found" | "not_sender" | "already_closed"; row?: ConfessionRow };

/** 終端への遷移は必ず「勝てたかどうか」を返す。既に閉じている行を上書きしない。 */
export type ConditionalCloseResult =
  | { ok: true; row: ConfessionRow }
  | { ok: false; code: "not_found" | "already_closed"; row?: ConfessionRow };

/**
 * 外部送信が済んだあとの1回の確定。**送信できた事実は、会話の遷移に負けても失わない。**
 *
 * `transition`:
 *  - `closed`  … この返信で終了できた
 *  - `waiting` … 投稿者の返答待ちにできた（`deadlineAt` あり）
 *  - `lost`    … 送っている間に会話が終わっていた。終了はそのまま維持する
 */
export interface StaffReplyFinalizeResult {
  readonly transition: "closed" | "waiting" | "lost";
  readonly deadlineAt: number | null;
  readonly row: ConfessionRow | undefined;
}

/** 「返答を待つ」の確定も同じ。閉じた会話へ期限を生やさない。 */
export type StaffWaitResult =
  | { ok: true; row: ConfessionRow }
  | { ok: false; code: "not_found" | "already_closed"; row?: ConfessionRow };

/** 明確な失敗だけを自動で再試行する。unknown は人が判断する。 */
export const CONFESSION_FOLLOW_UP_MAX_ATTEMPTS = 5;

/**
 * 実行中インスタンスの生存を認めるまでの猶予（秒）。
 *
 * 刻時盤は60秒ごとに鼓動を打つので、その2回ぶんを見てから「もういない」と判断する。
 * **これを過ぎていない所有者の行は、起動時回収でも触らない**——生きている実行を
 * 横から奪うと、あとから帰ってくる callback と新しい実行が同じ効果を二重に起こす。
 */
export const CONFESSION_INSTANCE_LEASE_SECONDS = 150;

/** 送信の所有者。誰の（どの起動の）実行かを durable に残す */
export interface ConfessionInstanceRow {
  instance_id: string;
  started_at: number;
  heartbeat_at: number;
}

/** claim の結果。既に終わっている会話を、対応開始が黙って開き直さない */
export type ClaimResult =
  | { ok: true; row: ConfessionRow }
  | { ok: false; code: "not_found" | "already_claimed" | "already_closed"; row?: ConfessionRow };

/** 終了した会話へ、未処理の内容を取り出すためだけにスレッドを結ぶ結果 */
export type RecoveryBindResult =
  | { ok: true; row: ConfessionRow }
  | { ok: false; code: "not_found" | "not_closed" | "already_bound" | "no_obligations"; row?: ConfessionRow };

/** 「まだ片付いていない」ことの内訳。会話が終わっていても消えない責務 */
export interface OperationalObligations {
  readonly openEmergency: boolean;
  readonly followUps: number;
  readonly replyDrafts: number;
  readonly pendingRenders: number;
  readonly total: number;
}

/** 投稿者へ届いた1通を、最終形へ書き換えるための durable な指示 */
export interface PendingRenderRow {
  id: number;
  confession_id: number;
  draft_id: number | null;
  channel_id: string;
  message_id: string;
  render_kind: string; // reply_waiting | reply_closed | reply_after_close
  deadline_at: number | null;
  closed_by_sender: number | null;
  state: string; // pending | settled | failed
  created_at: number;
  settled_at: number | null;
}

/**
 * 外部送信を伴う行の進み具合。**「まだ触っていない」と「触った途中」を同じ値にしない。**
 *
 * プロセスが落ちると `sending` だけが取り残される。再起動時にそれを見て
 * `unknown` へ寄せられるのは、両者が別の値だからこそ。`NULL`（pending）を
 * 送信中と兼ねると、一度も送っていない行まで「届いたかもしれない」に
 * 格下げしてしまう。
 */
export type EffectProgress = "pending" | "sending" | "delivered" | "failed" | "unknown";

/** 未解決の追記が、運営から見てどの箱に入っているか */
export type FollowUpBucket =
  | "not_ready" // 対応スレッドがまだ無い（宛先未確定）。失敗ではない
  | "pending" // 渡せる状態だが、まだ渡していない
  | "sending" // 送信中（このプロセスが生きている間だけ）
  | "failed" // 明確に渡せなかった。自動で拾い直す
  | "unknown" // 渡せたか分からない。自動では送り直さない
  | "exhausted"; // 自動再試行の上限に達した。人が決める

export interface FollowUpTriage {
  readonly notReady: number;
  readonly pending: number;
  readonly sending: number;
  readonly failed: number;
  readonly unknown: number;
  readonly exhausted: number;
  readonly total: number;
}

/** 起動時に回収した、前プロセスの置き土産 */
export interface OrphanRecovery {
  readonly ackAttempts: number;
  readonly replyDrafts: number;
  readonly followUps: number;
}

/** 担当者の自由返信の下書き。Discord へ送る前に必ずここへ置き、行の消費で二重送信を防ぐ */
export interface ReplyDraftRow {
  id: number;
  confession_id: number;
  staff_id: string;
  body: string;
  intent: string; // wait | close（下書き時点では未定なので consume 時に確定する）
  created_at: number;
  consumed_at: number | null;
  outcome: string | null; // sending | delivered | failed | unknown | resolved_manually
  body_purge_at: number | null;
  owner_instance: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
}

export type SenderCloseResult =
  | { ok: true; row: ConfessionRow }
  | { ok: false; code: "not_found" | "not_sender" | "already_closed"; row?: ConfessionRow };

export type ReplyDraftClaim =
  | { ok: true; draft: ReplyDraftRow; row: ConfessionRow }
  | { ok: false; code: "not_found" | "already_consumed" | "case_closed" | "not_owner"; row?: ConfessionRow };

/** create に渡す任意メタ（未指定でも従来通り動く） */
export interface ConfessionMeta {
  type?: ConfessionType;
  replyWish?: ReplyWish;
  body?: string;
}

export type VoiceReceivedCloseResult =
  | { ok: true; row: ConfessionRow }
  | { ok: false; code: "not_found" | "already_closed" | "reply_wish_not_no"; row?: ConfessionRow };

const now = () => Math.floor(Date.now() / 1000);

export class Confessions {
  /**
   * この起動を表す ID。送信中の行へ書き込み、起動時回収が
   * 「これは前の起動の置き土産か、まだ生きている誰かの実行か」を区別できるようにする。
   */
  private readonly instanceId: string;

  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
    instanceId?: string,
  ) {
    this.instanceId = instanceId ?? `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS confession_tickets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        thread_id   TEXT,
        claimed_by  TEXT,
        created_at  INTEGER NOT NULL,
        claimed_at  INTEGER,
        closed_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_confession_thread ON confession_tickets(thread_id);
      CREATE INDEX IF NOT EXISTS idx_confession_user ON confession_tickets(user_id, status);
      CREATE TABLE IF NOT EXISTS confession_blocks (
        user_id    TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL,
        blocked_by TEXT NOT NULL
      );
      -- Phase 2: 追加担当者（主担当=claimed_by とは別に、閲覧・対応できる人を絞って管理する）
      CREATE TABLE IF NOT EXISTS confession_assignees (
        confession_id INTEGER NOT NULL,
        user_id       TEXT NOT NULL,
        added_by      TEXT NOT NULL,
        added_at      INTEGER NOT NULL,
        removed_at    INTEGER,
        PRIMARY KEY (confession_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_confession_assignee ON confession_assignees(confession_id, removed_at);
      -- Phase 4: 緊急対応の記録（BAN等は自動実行しない。運営が確認して実行する前提の記録）
      CREATE TABLE IF NOT EXISTS confession_emergency (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        confession_id INTEGER NOT NULL,
        created_by    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        reason        TEXT NOT NULL,
        target        TEXT NOT NULL,
        danger_ongoing INTEGER NOT NULL DEFAULT 0,
        measures      TEXT,
        review_note   TEXT,
        note          TEXT,
        status        TEXT NOT NULL DEFAULT 'open',
        confirmed_by  TEXT,
        closed_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_confession_emergency ON confession_emergency(confession_id, status);
      -- Task #219: 担当者の自由返信の下書き。
      -- Discord への送信は外部effectなので、押した瞬間に行を「消費」してから送る。
      -- 二度押し・retry は消費に負けて何も送らない（changes=1 の勝者だけが送信へ進む）。
      CREATE TABLE IF NOT EXISTS confession_reply_drafts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        confession_id INTEGER NOT NULL,
        staff_id      TEXT NOT NULL,
        body          TEXT,
        intent        TEXT,
        created_at    INTEGER NOT NULL,
        consumed_at   INTEGER,
        outcome       TEXT,
        body_purge_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_confession_reply_draft ON confession_reply_drafts(confession_id, consumed_at);
      CREATE INDEX IF NOT EXISTS idx_confession_draft_purge ON confession_reply_drafts(body_purge_at)
        WHERE body IS NOT NULL;
      -- Task #219 review 1: 受領確認の「押した / 送り始めた / 届いた」を別々に残す。
      -- acknowledged_at は**届いたと確認できた時刻**なので、試行の所有権はここが持つ。
      CREATE TABLE IF NOT EXISTS confession_ack_attempts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        confession_id INTEGER NOT NULL,
        staff_id      TEXT NOT NULL,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER,
        outcome       TEXT
      );
      -- 送信中の試行は案件につき1つ。二度押しはここで負ける（時刻ではなく行で排他する）
      CREATE UNIQUE INDEX IF NOT EXISTS uq_confession_ack_inflight
        ON confession_ack_attempts(confession_id) WHERE outcome IS NULL;
      CREATE INDEX IF NOT EXISTS idx_confession_ack_attempt ON confession_ack_attempts(confession_id, started_at);
      -- Task #219 review 1: 投稿者の追記は、Discord へ渡す前に本文をここへ確定させる。
      -- 中継に失敗しても本文が消えず、「届けました」と嘘を言わずに済む。
      CREATE TABLE IF NOT EXISTS confession_follow_ups (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        confession_id INTEGER NOT NULL,
        sender_id     TEXT NOT NULL,
        body          TEXT,
        created_at    INTEGER NOT NULL,
        relayed_at    INTEGER,
        outcome       TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        body_purge_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_confession_follow_up ON confession_follow_ups(confession_id, outcome);
      CREATE INDEX IF NOT EXISTS idx_confession_follow_up_open ON confession_follow_ups(outcome)
        WHERE relayed_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_confession_follow_up_purge ON confession_follow_ups(body_purge_at)
        WHERE body IS NOT NULL;
      -- Task #219 review 3: 誰の（どの起動の）実行かを durable に持つ。
      -- 起動時回収が、まだ生きている別プロセスの実行を奪わないための正本。
      CREATE TABLE IF NOT EXISTS confession_instances (
        instance_id  TEXT PRIMARY KEY,
        started_at   INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      -- Task #219 review 3: 届いた1通を最終形へ書き換える指示を durable に残す。
      -- 編集の前に落ちても、起動時／刻時盤が**同じメッセージ**を収束させられる
      -- （新しい DM を増やさない）。
      CREATE TABLE IF NOT EXISTS confession_pending_renders (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        confession_id   INTEGER NOT NULL,
        draft_id        INTEGER,
        channel_id      TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        render_kind     TEXT NOT NULL,
        deadline_at     INTEGER,
        closed_by_sender INTEGER,
        state           TEXT NOT NULL DEFAULT 'pending',
        created_at      INTEGER NOT NULL,
        settled_at      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_confession_render_open ON confession_pending_renders(state, id);
      CREATE INDEX IF NOT EXISTS idx_confession_render_case ON confession_pending_renders(confession_id, state);
    `);
    // Phase 1 加算列（既存DBには後付け。SQLite は ADD COLUMN IF NOT EXISTS が無いので存在確認して追加）
    this.addColumn("type", "TEXT");
    this.addColumn("reply_wish", "TEXT");
    this.addColumn("body", "TEXT");
    // Phase 2 加算列
    this.addColumn("stage", "TEXT");
    this.addColumn("disposition", "TEXT");
    this.addColumn("disposition_at", "INTEGER");
    this.addColumn("disposition_by", "TEXT");
    this.addColumn("close_reason", "TEXT");
    this.addColumn("closed_by", "TEXT");
    this.addColumn("body_purge_at", "INTEGER");
    this.addColumn("body_purged_at", "INTEGER");
    this.addColumn("body_retention_reason", "TEXT");
    this.addColumn("panel_msg_id", "TEXT"); // 対応スレッドの管理パネル（現状表示）メッセージID
    // Phase 3 加算列（冥府裁判所への送致）
    this.addColumn("court_status", "TEXT");
    this.addColumn("court_category", "TEXT");
    this.addColumn("court_consent", "TEXT");
    this.addColumn("court_thread_id", "TEXT");
    this.addColumn("court_url", "TEXT");
    this.addColumn("court_case_no", "TEXT");
    this.addColumn("court_sent_at", "INTEGER");
    this.addColumn("court_sent_by", "TEXT");
    this.addColumn("court_form", "TEXT"); // 担当者が入力した送致概要のJSON {reason, summary, wants}
    // Task #219 加算列（会話の終端）
    this.addColumn("acknowledged_at", "INTEGER");
    this.addColumn("acknowledged_by", "TEXT");
    this.addColumn("reply_deadline_at", "INTEGER");
    this.addColumn("closed_side", "TEXT");
    this.addColumnTo("confession_ack_attempts", "owner_instance", "TEXT");
    this.addColumnTo("confession_reply_drafts", "owner_instance", "TEXT");
    this.addColumnTo("confession_follow_ups", "owner_instance", "TEXT");
    // 手動再送の世代。古い callback が新しい試行の結果を上書きしないための札
    this.addColumnTo("confession_follow_ups", "generation", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnTo("confession_follow_ups", "resolved_at", "INTEGER");
    this.addColumnTo("confession_follow_ups", "resolved_by", "TEXT");
    this.addColumnTo("confession_reply_drafts", "resolved_at", "INTEGER");
    this.addColumnTo("confession_reply_drafts", "resolved_by", "TEXT");
    this.heartbeatInstance(this.instanceId);
    // 期限つきの投稿者待ちだけを走査するための索引（期限なしの既存行は入らない）
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_confession_reply_deadline ON confession_tickets(reply_deadline_at) WHERE reply_deadline_at IS NOT NULL",
    );
  }

  /**
   * このプロセス（起動）を所有者として名乗り、鼓動を打つ。
   *
   * 起動時回収は**この鼓動が途切れた所有者の行だけ**を回収する。生きている実行を
   * 横から `unknown` へ落とすと、あとから帰ってくる callback と新しい実行が
   * 同じ効果を二重に起こす。
   */
  heartbeatInstance(instanceId: string, atTs: number = now()): void {
    this.db
      .prepare(
        `INSERT INTO confession_instances (instance_id, started_at, heartbeat_at) VALUES (?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at`,
      )
      .run(instanceId, atTs, atTs);
  }

  /** この起動の所有者ID */
  get instance(): string {
    return this.instanceId;
  }

  /** 鼓動がまだ生きている所有者（＝触ってはいけない相手） */
  liveInstances(atTs: number = now()): string[] {
    return (
      this.db
        .prepare("SELECT instance_id FROM confession_instances WHERE heartbeat_at > ?")
        .all(atTs - CONFESSION_INSTANCE_LEASE_SECONDS) as { instance_id: string }[]
    ).map((r) => r.instance_id);
  }

  /** 「返答を待つ」を選んだ時刻から、投稿者の返答期限を導く（日数literalをここ以外に置かない） */
  static senderReplyDeadlineFrom(atTs: number): number {
    return atTs + CONFESSION_SENDER_REPLY_DEADLINE_SECONDS;
  }

  /** confession_tickets に列が無ければ追加する（冪等な後付けマイグレーション） */
  private addColumn(name: string, decl: string): void {
    this.addColumnTo("confession_tickets", name, decl);
  }

  /** 任意のテーブルへ冪等に列を足す */
  private addColumnTo(table: string, name: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length === 0 || cols.some((c) => c.name === name)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }

  /**
   * 告発を受け付ける。返り値の id が受付番号（運営にはこれだけ見せる）。
   * meta（種別・返信希望・本文）は任意。本文は #トートの声 に既に出る内容と同じで、
   * スレッド表示や §18 の保存要件のために DB にも保持する。
   */
  create(userId: string, meta: ConfessionMeta = {}): ConfessionRow {
    const ts = now();
    const info = this.db
      .prepare(
        "INSERT INTO confession_tickets (user_id, status, created_at, type, reply_wish, body) VALUES (?, 'open', ?, ?, ?, ?)",
      )
      .run(userId, ts, meta.type ?? null, meta.replyWish ?? null, meta.body ?? null);
    const id = Number(info.lastInsertRowid);
    // user_id は監査用にイベントログへ残すが、運営が直接見る導線には出さない
    this.events.log("confession_create", { actor: userId, payload: { id, type: meta.type ?? null } });
    return this.get(id)!;
  }

  get(id: number): ConfessionRow | undefined {
    return this.db.prepare("SELECT * FROM confession_tickets WHERE id = ?").get(id) as ConfessionRow | undefined;
  }

  byThread(threadId: string): ConfessionRow | undefined {
    return this.db.prepare("SELECT * FROM confession_tickets WHERE thread_id = ?").get(threadId) as ConfessionRow | undefined;
  }

  /** 運営が対応開始。対応スレッドと紐付ける。主担当を assignees にも記録し、stage=active にする */
  claim(id: number, threadId: string, staffId: string): ClaimResult {
    const ts = now();
    // **投稿者が自分で終わらせた会話を、対応開始が黙って開き直さない。**
    // 「対応する」は未対応の案件を引き受ける操作であって、終端を覆す権限ではない。
    // 再開が必要なら 🔓 再オープン という明示の操作がある。
    const apply = this.db.transaction((): boolean => {
      const info = this.db
        .prepare(
          `UPDATE confession_tickets SET status='claimed', stage='active', thread_id=?, claimed_by=?, claimed_at=?
           WHERE id=? AND status='open' AND thread_id IS NULL`,
        )
        .run(threadId, staffId, ts, id);
      if (info.changes !== 1) return false;
      // 主担当も担当者一覧に載せておく（一覧・権限判定を assignees に一本化するため）
      this.db
        .prepare(
          "INSERT INTO confession_assignees (confession_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(confession_id, user_id) DO UPDATE SET removed_at=NULL",
        )
        .run(id, staffId, staffId, ts);
      return true;
    });
    const won = apply();
    const row = this.get(id);
    if (won) {
      this.events.log("confession_claim", { actor: staffId, payload: { id, threadId } });
      return { ok: true, row: row! };
    }
    if (!row) return { ok: false, code: "not_found" };
    if (row.status === "closed") return { ok: false, code: "already_closed", row };
    return { ok: false, code: "already_claimed", row };
  }

  /**
   * 終了済みの会話へ、**再開せずに**対応スレッドだけを結ぶ。
   *
   * 投稿者が「もう大丈夫です」を押しても、それ以前に送ってきた追記が消えるわけではない。
   * 宛先が無いままだと運営はその内容へ辿り着けないので、未処理の責務があるときに限り
   * スレッドを作って結ぶ。**status は closed のまま**——会話を開き直したわけではない。
   */
  bindRecoveryThread(id: number, threadId: string, staffId: string): RecoveryBindResult {
    const row = this.get(id);
    if (!row) return { ok: false, code: "not_found" };
    if (row.status !== "closed") return { ok: false, code: "not_closed", row };
    if (row.thread_id !== null) return { ok: false, code: "already_bound", row };
    if (this.obligations(id).total === 0) return { ok: false, code: "no_obligations", row };
    const ts = now();
    const apply = this.db.transaction((): boolean => {
      const info = this.db
        .prepare("UPDATE confession_tickets SET thread_id=? WHERE id=? AND thread_id IS NULL AND status='closed'")
        .run(threadId, id);
      if (info.changes !== 1) return false;
      this.db
        .prepare(
          "INSERT INTO confession_assignees (confession_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(confession_id, user_id) DO UPDATE SET removed_at=NULL",
        )
        .run(id, staffId, staffId, ts);
      return true;
    });
    if (!apply()) return { ok: false, code: "already_bound", row };
    this.events.log("confession_recovery_bind", { actor: staffId, payload: { id, threadId } });
    return { ok: true, row: this.get(id)! };
  }

  /**
   * クローズ。理由・担当者・本文purge予定を記録する。
   * retentionDays を渡すと closed_at + N日 を body_purge_at に設定（0/未指定なら purge予定なし）。
   */
  close(
    id: number,
    staffId: string,
    reason?: CloseReason,
    retentionDays?: number,
    closedSide: ClosedSide = "staff",
  ): ConditionalCloseResult {
    const ts = now();
    const purgeAt = retentionDays && retentionDays > 0 ? ts + retentionDays * 86_400 : null;
    // **既に終わっている会話を上書きしない。** 投稿者が先に終わらせていたなら、
    // その事実（誰が・いつ・どの理由で終えたか）が正本であって、後から届いた
    // 担当者側の確定がそれを塗り替えてよい道理はない。
    const info = this.db
      .prepare(
        `UPDATE confession_tickets
         SET status='closed', closed_at=?, close_reason=?, closed_by=?, closed_side=?,
             reply_deadline_at=NULL, body_purge_at=COALESCE(body_purge_at, ?)
         WHERE id=? AND status<>'closed'`,
      )
      .run(ts, reason ?? null, staffId, closedSide, purgeAt, id);
    const row = this.get(id);
    if (info.changes === 1) {
      this.events.log("confession_close", { actor: staffId, payload: { id, reason: reason ?? null, side: closedSide } });
      return { ok: true, row: row! };
    }
    if (!row) return { ok: false, code: "not_found" };
    return { ok: false, code: "already_closed", row };
  }

  /** 返信不要案件専用の原子的クローズ。勝者（changes=1）だけがDM等の副作用へ進む。 */
  closeVoiceReceivedAtomic(id: number, staffId: string, retentionDays?: number): VoiceReceivedCloseResult {
    const ts = now();
    const purgeAt = retentionDays && retentionDays > 0 ? ts + retentionDays * 86_400 : null;
    const info = this.db
      .prepare(
        `UPDATE confession_tickets
         SET status='closed', closed_at=?, close_reason='voice_received', closed_by=?, body_purge_at=COALESCE(body_purge_at, ?)
         WHERE id=? AND status<>'closed' AND reply_wish='no'`,
      )
      .run(ts, staffId, purgeAt, id);
    const row = this.get(id);
    if (info.changes === 1) {
      this.events.log("confession_close", { actor: staffId, payload: { id, reason: "voice_received" } });
      return { ok: true, row: row! };
    }
    if (!row) return { ok: false, code: "not_found" };
    if (row.status === "closed") return { ok: false, code: "already_closed", row };
    return { ok: false, code: "reply_wish_not_no", row };
  }

  // ══ 会話の終端（Task #219） ═════════════════════════════
  //
  // 受領確認 / 内容への回答 / 会話の終了 は**別の概念**として扱う。
  // ここにある操作はどれも、そのうち1つだけを起こす。

  /**
   * 📨 受領確認の送信を始める。**まだ「届いた」ことにはしない。**
   *
   * `acknowledged_at` は「担当者が押した時刻」ではなく「投稿者へ届いたと確認できた時刻」。
   * だから押した時点で書くものは、この試行行だけ。二度押しは送信中の試行が1つしか
   * 存在できない部分ユニーク索引に負けるので、DM が2通飛ぶことはない。
   *
   * - `reply_wish` を一切見ない。**回答不要でも回答希望でも送れる**
   * - status/stage を動かさない。回答したことにも、終了したことにもならない
   */
  beginAcknowledgement(id: number, staffId: string): AckBeginResult {
    const row = this.get(id);
    if (!row) return { ok: false, code: "not_found" };
    if (row.status === "closed") return { ok: false, code: "already_closed", row };
    if (row.acknowledged_at !== null) return { ok: false, code: "already_delivered", row };
    try {
      const info = this.db
        .prepare(
          "INSERT INTO confession_ack_attempts (confession_id, staff_id, started_at, owner_instance) VALUES (?, ?, ?, ?)",
        )
        .run(id, staffId, now(), this.instanceId);
      return { ok: true, attemptId: Number(info.lastInsertRowid), row };
    } catch (error) {
      // **「送信中だった」と言ってよいのは、部分ユニーク索引に負けたときだけ。**
      // ディスク不full・破損・型違反まで in-flight へ潰すと、本物の異常が
      // 「いま誰かが送っています」という無害な顔で隠れてしまう。
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        return { ok: false, code: "attempt_in_flight", row };
      }
      throw error;
    }
  }

  /**
   * 送信の結末を確定する。**`delivered` のときだけ** `acknowledged_at` が入る。
   *
   * `failed`（Discord が明確に拒否）も `unknown`（応答が得られなかった）も、
   * 受領確認が届いた証拠にはならないので案件側は何も動かさない。
   */
  settleAcknowledgement(attemptId: number, outcome: DeliveryOutcome, staffId: string): ConfessionRow | undefined {
    const attempt = this.db
      .prepare("SELECT * FROM confession_ack_attempts WHERE id=?")
      .get(attemptId) as AckAttemptRow | undefined;
    if (!attempt) return undefined;
    // **試行の決着と案件側の受領記録を1つのトランザクションで書く。**
    // 別々に書くと、その間で落ちたときに「試行は delivered なのに acknowledged_at は
    // NULL」という半端な状態ができる。すると ackState は none へ落ち、**届いている
    // DM をもう一通送れてしまう**。
    const settle = this.db.transaction((ts: number) => {
      const won = this.db
        .prepare("UPDATE confession_ack_attempts SET outcome=?, finished_at=? WHERE id=? AND outcome IS NULL")
        .run(outcome, ts, attemptId).changes;
      // **試行の遷移に勝った者だけが案件側を書ける。**
      // 起動時回収が先に unknown へ倒したあと、古い callback が delivered で
      // 帰ってきても、ここで負けるので受領確認は立たない。
      if (won !== 1) return;
      if (outcome === "delivered") {
        this.db
          .prepare(
            "UPDATE confession_tickets SET acknowledged_at=?, acknowledged_by=? WHERE id=? AND acknowledged_at IS NULL",
          )
          .run(ts, staffId, attempt.confession_id);
        this.events.log("confession_acknowledge", { actor: staffId, payload: { id: attempt.confession_id } });
      } else {
        this.events.log("confession_acknowledge_failed", {
          actor: staffId,
          payload: { id: attempt.confession_id, outcome },
        });
      }
    });
    settle(now());
    return this.get(attempt.confession_id);
  }

  /** 直近の受領確認の試行（UI が現在地を出すため） */
  lastAckAttempt(id: number): AckAttemptRow | undefined {
    return this.db
      .prepare("SELECT * FROM confession_ack_attempts WHERE confession_id=? ORDER BY id DESC LIMIT 1")
      .get(id) as AckAttemptRow | undefined;
  }

  /**
   * 担当者へ見せる受領確認の現在地。
   * **届いた（delivered）以外を「送信済み」と読ませない。**
   */
  ackState(id: number): AckState {
    const row = this.get(id);
    if (row?.acknowledged_at) return "delivered";
    const attempt = this.lastAckAttempt(id);
    if (!attempt) return "none";
    if (attempt.outcome === null) return "in_flight";
    if (attempt.outcome === "failed") return "failed";
    if (attempt.outcome === "unknown") return "unknown";
    return "none";
  }

  /**
   * 自由返信の下書きを置く。本文の正本はここで、EventLog へは複製しない。
   *
   * 本文には最初から保持期限を付ける——相談本文と同じ retention の外側に、
   * 秘密の文章が無期限に残る経路を作らないため。
   */
  createReplyDraft(id: number, staffId: string, body: string, retentionDays?: number): ReplyDraftRow {
    const ts = now();
    const purgeAt = retentionDays && retentionDays > 0 ? ts + retentionDays * 86_400 : null;
    const info = this.db
      .prepare(
        "INSERT INTO confession_reply_drafts (confession_id, staff_id, body, created_at, body_purge_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, staffId, body, ts, purgeAt);
    return this.getReplyDraft(Number(info.lastInsertRowid))!;
  }

  getReplyDraft(draftId: number): ReplyDraftRow | undefined {
    return this.db.prepare("SELECT * FROM confession_reply_drafts WHERE id=?").get(draftId) as ReplyDraftRow | undefined;
  }

  /**
   * 下書きを消費して送信権を得る。**勝者だけが Discord へ送る。**
   *
   * 二度押しの2発目は changes=0 で `already_consumed` になり、同じ本文を二重に届けない。
   * 送信より先に消費するのは、「送ったのに未消費」より「消費したのに未送信」の方が安全だから
   * ——未送信は下書きに `undelivered` として残り、案件の状態遷移も起こさない
   * （送れたか分からないものを「送った」ことにしない）。
   */
  claimReplyDraft(draftId: number, staffId: string, intent: "wait" | "close"): ReplyDraftClaim {
    const draft = this.getReplyDraft(draftId);
    if (!draft) return { ok: false, code: "not_found" };
    if (draft.staff_id !== staffId) return { ok: false, code: "not_owner" };
    // 既に送ったものを二度押ししたのか、書いている間に会話が終わったのか——
    // 担当者にとっては別の出来事なので、原因の近い順に見る。
    if (draft.consumed_at !== null) return { ok: false, code: "already_consumed" };
    const row = this.get(draft.confession_id);
    if (!row) return { ok: false, code: "not_found" };
    // 下書きの間に投稿者が終了していたら、返信で会話を勝手に再開させない
    if (row.status === "closed") return { ok: false, code: "case_closed", row };
    // `sending` を立てるのは、落ちたときに「外へ触った可能性がある行」を
    // 起動時に見つけられるようにするため（consumed_at だけでは、決着済みと
    // 送信中を区別できない）。
    const info = this.db
      .prepare(
        "UPDATE confession_reply_drafts SET consumed_at=?, intent=?, outcome='sending', owner_instance=? WHERE id=? AND consumed_at IS NULL",
      )
      .run(now(), intent, this.instanceId, draftId);
    if (info.changes !== 1) return { ok: false, code: "already_consumed", row };
    return { ok: true, draft: this.getReplyDraft(draftId)!, row };
  }

  /**
   * 送信の結末を下書きへ残す。delivered のときだけ案件の状態を進める。
   *
   * 届いたと確定した本文を DB に残しておく理由はもう無いので、その場で消す
   * （案件ID・担当者・意図・時刻・結末は監査のために残る）。届いていない／不明な本文は
   * 再試行のために残すが、これも案件と同じ保持期限の内側にある。
   */
  finishReplyDraft(draftId: number, outcome: DeliveryOutcome): void {
    // **送信中の行にだけ書ける。** 起動時回収が unknown へ倒したあと、
    // 古い callback が delivered で帰ってきても上書きしない。
    if (outcome === "delivered") {
      this.db
        .prepare("UPDATE confession_reply_drafts SET outcome=?, body=NULL WHERE id=? AND outcome='sending'")
        .run(outcome, draftId);
      return;
    }
    this.db.prepare("UPDATE confession_reply_drafts SET outcome=? WHERE id=? AND outcome='sending'").run(outcome, draftId);
  }

  /** 下書きの所属案件はDBだけが決める（customId を権限の根拠にしない） */
  replyDraftCase(draftId: number): number | undefined {
    return (
      this.db.prepare("SELECT confession_id FROM confession_reply_drafts WHERE id=?").pluck().get(draftId) as
        | number
        | undefined
    );
  }

  /** 追記の所属案件も同じ */
  followUpCase(followUpId: number): number | undefined {
    return (
      this.db.prepare("SELECT confession_id FROM confession_follow_ups WHERE id=?").pluck().get(followUpId) as
        | number
        | undefined
    );
  }

  /** 決着していない返信の下書き（失敗／不明）。担当者が判断する対象 */
  listReplyDraftsNeedingDecision(confessionId: number): ReplyDraftRow[] {
    return this.db
      .prepare(
        `SELECT * FROM confession_reply_drafts
         WHERE confession_id=? AND body IS NOT NULL AND outcome IN ('failed','unknown') ORDER BY id`,
      )
      .all(confessionId) as ReplyDraftRow[];
  }

  /**
   * 未確定の返信を、担当者が重複を承知で送り直すための所有権。
   * **案件との結び付きをDBで強制する**（別案件のIDを渡しても取れない）。
   */
  claimReplyDraftManualRetry(confessionId: number, draftId: number): ReplyDraftRow | undefined {
    const info = this.db
      .prepare(
        `UPDATE confession_reply_drafts SET outcome='sending', owner_instance=?
         WHERE id=? AND confession_id=? AND body IS NOT NULL AND outcome IN ('failed','unknown')`,
      )
      .run(this.instanceId, draftId, confessionId);
    return info.changes === 1 ? this.getReplyDraft(draftId) : undefined;
  }

  /**
   * これ以上送らないと決める出口。**届いたことにはしない。**
   * 配送の事実（outcome=delivered）と、人が畳んだ事実（resolved_manually）は別。
   */
  resolveReplyDraftManually(confessionId: number, draftId: number, staffId: string): ReplyDraftRow | undefined {
    const info = this.db
      .prepare(
        `UPDATE confession_reply_drafts SET outcome='resolved_manually', body=NULL, resolved_at=?, resolved_by=?
         WHERE id=? AND confession_id=? AND outcome IN ('failed','unknown')`,
      )
      .run(now(), staffId, draftId, confessionId);
    if (info.changes === 1) {
      this.events.log("confession_reply_resolved", { actor: staffId, payload: { id: confessionId, draftId } });
    }
    return this.getReplyDraft(draftId);
  }

  /**
   * 外部送信が済んだあとの確定を**1つのトランザクション**でやりきる。
   *
   * ここを分けて書くと「DM は届いたのに、下書きは送信中のまま」「本文だけ消えて
   * 会話は動いていない」といった隙間ができる。送信できた事実（delivered / 本文の消去）は
   * 常に確定し、会話の遷移だけが条件付きで、負ければ `lost` を返して終了を維持する。
   */
  finalizeStaffReply(input: {
    draftId: number;
    intent: "wait" | "close";
    staffId: string;
    retentionDays?: number;
    atTs?: number;
    /** 中立な1通の宛先。あとで**同じメッセージ**を最終形へ書き換えるために持つ */
    renderTarget?: { channelId: string; messageId: string } | null;
  }): StaffReplyFinalizeResult {
    const ts = input.atTs ?? now();
    const draft = this.getReplyDraft(input.draftId);
    if (!draft) return { transition: "lost", deadlineAt: null, row: undefined };
    // **いま送っている本人の確定だけを通す。**
    // 起動時回収で unknown になった下書きや、別の担当者・別の意図の確定は通さない
    // ——古い callback が、あとから会話を勝手に終わらせたり待たせたりしないため。
    if (draft.outcome !== "sending" || draft.staff_id !== input.staffId || draft.intent !== input.intent) {
      return { transition: "lost", deadlineAt: null, row: this.get(draft.confession_id) };
    }
    const id = draft.confession_id;
    const purgeAt = input.retentionDays && input.retentionDays > 0 ? ts + input.retentionDays * 86_400 : null;
    const deadline = input.intent === "wait" ? Confessions.senderReplyDeadlineFrom(ts) : null;

    const apply = this.db.transaction((): StaffReplyFinalizeResult["transition"] => {
      // 届いた事実と本文の消去は無条件（会話の遷移に負けても失わない）
      this.db
        .prepare("UPDATE confession_reply_drafts SET outcome='delivered', body=NULL WHERE id=? AND outcome='sending'")
        .run(input.draftId);
      if (input.intent === "close") {
        const closed = this.db
          .prepare(
            `UPDATE confession_tickets
             SET status='closed', closed_at=?, close_reason='resolved', closed_by=?, closed_side='staff',
                 reply_deadline_at=NULL, body_purge_at=COALESCE(body_purge_at, ?)
             WHERE id=? AND status<>'closed'`,
          )
          .run(ts, input.staffId, purgeAt, id);
        return closed.changes === 1 ? "closed" : "lost";
      }
      const waited = this.db
        .prepare("UPDATE confession_tickets SET stage='awaiting_poster', reply_deadline_at=? WHERE id=? AND status<>'closed'")
        .run(deadline, id);
      return waited.changes === 1 ? "waiting" : "lost";
    });

    // 遷移の確定と、最終形へ書き換える指示を**同じトランザクション**で置く。
    // 編集の前に落ちても、収束すべき姿がDBに残っている。
    const applyWithRender = this.db.transaction((): StaffReplyFinalizeResult["transition"] => {
      const transition = apply();
      const closedBySender = this.get(id)?.closed_side === "sender";
      this.queueFinalRender({
        confessionId: id,
        draftId: input.draftId,
        target: input.renderTarget ?? null,
        kind: transition === "waiting" ? "reply_waiting" : transition === "closed" ? "reply_closed" : "reply_after_close",
        deadlineAt: transition === "waiting" ? deadline : null,
        closedBySender,
        atTs: ts,
      });
      return transition;
    });

    const transition = applyWithRender();
    if (transition === "closed") {
      this.events.log("confession_close", { actor: input.staffId, payload: { id, reason: "resolved", side: "staff" } });
    } else if (transition === "waiting") {
      this.events.log("confession_reply_wait", { actor: input.staffId, payload: { id, deadlineAt: deadline } });
    }
    return { transition, deadlineAt: transition === "waiting" ? deadline : null, row: this.get(id) };
  }

  /**
   * 「返答を待つ」で返信したあとの状態。投稿者待ちにして**明示的な期限**を置く。
   * 期限を持つのはこの経路だけ——ここを通っていない案件は自動終了しない。
   */
  applyStaffReplyWaiting(id: number, staffId: string, atTs: number = now()): StaffWaitResult {
    const deadline = Confessions.senderReplyDeadlineFrom(atTs);
    const info = this.db
      .prepare("UPDATE confession_tickets SET stage='awaiting_poster', reply_deadline_at=? WHERE id=? AND status<>'closed'")
      .run(deadline, id);
    const row = this.get(id);
    // 負けた（＝送信中に終わっていた）なら期限も作らないし、待機のイベントも残さない。
    // 「待っている」という記録だけが残ると、終わった会話の上に嘘の続きが生える。
    if (info.changes === 1) {
      this.events.log("confession_reply_wait", { actor: staffId, payload: { id, deadlineAt: deadline } });
      return { ok: true, row: row! };
    }
    if (!row) return { ok: false, code: "not_found" };
    return { ok: false, code: "already_closed", row };
  }

  /** ⏳ 運営側の確認待ち。投稿者待ちへ逃がさないので、自動終了の対象にならない */
  setInternalHold(id: number, staffId: string): StaffWaitResult {
    const info = this.db
      .prepare("UPDATE confession_tickets SET stage='internal_hold', reply_deadline_at=NULL WHERE id=? AND status<>'closed'")
      .run(id);
    const row = this.get(id);
    if (info.changes === 1) {
      this.events.log("confession_internal_hold", { actor: staffId, payload: { id } });
      return { ok: true, row: row! };
    }
    if (!row) return { ok: false, code: "not_found" };
    return { ok: false, code: "already_closed", row };
  }

  /**
   * ✅ 投稿者自身による終了。**本人以外は絶対に通さない**（表示の出し分けだけに頼らない）。
   * 履歴は消さない——status と終了メタだけが変わる。
   */
  senderCloseAtomic(id: number, senderId: string, retentionDays?: number): SenderCloseResult {
    const ts = now();
    const purgeAt = retentionDays && retentionDays > 0 ? ts + retentionDays * 86_400 : null;
    const info = this.db
      .prepare(
        `UPDATE confession_tickets
         SET status='closed', closed_at=?, close_reason='poster_ended', closed_by=?, closed_side='sender',
             reply_deadline_at=NULL, body_purge_at=COALESCE(body_purge_at, ?)
         WHERE id=? AND user_id=? AND status<>'closed'`,
      )
      .run(ts, senderId, purgeAt, id, senderId);
    const row = this.get(id);
    if (info.changes === 1) {
      this.events.log("confession_close", { actor: senderId, payload: { id, reason: "poster_ended", side: "sender" } });
      return { ok: true, row: row! };
    }
    if (!row) return { ok: false, code: "not_found" };
    if (row.user_id !== senderId) return { ok: false, code: "not_sender", row };
    return { ok: false, code: "already_closed", row };
  }

  /**
   * ✏️ 投稿者の追記。運営の番へ戻し、**期限を必ず消す**。
   *
   * 追記が受理されたのに、直前に読まれた古い期限で数秒後に自動終了する——という競合を
   * ここで断つ（自動終了側も期限値の一致を条件にしている）。
   */
  recordSenderFollowUp(
    id: number,
    senderId: string,
    body: string,
    retentionDays?: number,
  ): FollowUpResult {
    const ts = now();
    const purgeAt = retentionDays && retentionDays > 0 ? ts + retentionDays * 86_400 : null;
    // **本文の確定と期限の解除を1つのトランザクションで行う。**
    // Discord へ渡すのはこのあと。中継が落ちても本文は残り、期限で勝手に閉じられもしない。
    const apply = this.db.transaction((): FollowUpResult => {
      const info = this.db
        .prepare(
          `UPDATE confession_tickets SET stage='awaiting_staff', reply_deadline_at=NULL
           WHERE id=? AND user_id=? AND status<>'closed'`,
        )
        .run(id, senderId);
      const row = this.get(id);
      if (info.changes !== 1) {
        if (!row) return { ok: false, code: "not_found" };
        if (row.user_id !== senderId) return { ok: false, code: "not_sender", row };
        return { ok: false, code: "already_closed", row };
      }
      const inserted = this.db
        .prepare(
          "INSERT INTO confession_follow_ups (confession_id, sender_id, body, created_at, body_purge_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, senderId, body, ts, purgeAt);
      return { ok: true, followUpId: Number(inserted.lastInsertRowid), row: row! };
    });
    const result = apply();
    if (result.ok) this.events.log("confession_sender_followup", { actor: senderId, payload: { id } });
    return result;
  }

  getFollowUp(followUpId: number): FollowUpRow | undefined {
    return this.db.prepare("SELECT * FROM confession_follow_ups WHERE id=?").get(followUpId) as FollowUpRow | undefined;
  }

  /**
   * 追記の引き渡し結果を確定する。届いた本文だけ消す（retention を迂回しない）。
   * `attempts` は試行のたびに増え、明確な失敗だけが自動再試行の対象になる。
   */
  settleFollowUpRelay(followUpId: number, outcome: DeliveryOutcome, generation?: number): FollowUpRow | undefined {
    const ts = now();
    // **送信中の、しかも自分が取った世代にだけ書ける。**
    // 手動再送の2回目が始まったあとに1回目の callback が帰ってきても、
    // 世代が違うので新しい試行の結果を塗り替えない。
    const gate = generation === undefined ? "" : " AND generation=?";
    const args = generation === undefined ? [] : [generation];
    if (outcome === "delivered") {
      this.db
        .prepare(
          `UPDATE confession_follow_ups SET outcome='delivered', relayed_at=?, body=NULL WHERE id=? AND outcome='sending'${gate}`,
        )
        .run(ts, followUpId, ...args);
    } else {
      // 試行回数は所有権を取った時点で増えている。ここで二重に数えない。
      this.db
        .prepare(`UPDATE confession_follow_ups SET outcome=? WHERE id=? AND outcome='sending'${gate}`)
        .run(outcome, followUpId, ...args);
    }
    return this.getFollowUp(followUpId);
  }

  /**
   * 刻時盤が自動で渡してよい追記。
   *
   * - **対応スレッドがまだ無い案件は入らない。** 宛先が決まっていないのは配送の失敗ではなく、
   *   まだ順番が来ていないだけ。ここへ入れると毎分 attempts を焼いて、担当者が
   *   「対応する」を押す前に上限へ達してしまう
   * - `unknown` も入らない——届いている可能性がある本文を、勝手にもう一度送らない
   * - まだ一度も渡していない `pending` と、明確に失敗した `failed` だけが対象
   */
  listRelayableFollowUps(limit = 20): FollowUpRow[] {
    return this.db
      .prepare(
        `SELECT f.* FROM confession_follow_ups f
         JOIN confession_tickets t ON t.id = f.confession_id
         WHERE f.relayed_at IS NULL AND f.body IS NOT NULL
           AND (f.outcome IS NULL OR f.outcome='failed')
           AND f.attempts < ?
           AND t.thread_id IS NOT NULL
         ORDER BY f.id LIMIT ?`,
      )
      .all(CONFESSION_FOLLOW_UP_MAX_ATTEMPTS, limit) as FollowUpRow[];
  }

  /**
   * 送信の所有権。勝った1つだけが Discord へ渡す。
   *
   * **試行回数を増やすのはここだけ。** 宛先未確定で見送った回は消費しない。
   */
  claimFollowUpRelay(followUpId: number): FollowUpRow | undefined {
    const info = this.db
      .prepare(
        `UPDATE confession_follow_ups
         SET outcome='sending', attempts=attempts+1, generation=generation+1, owner_instance=?
         WHERE id=? AND relayed_at IS NULL AND (outcome IS NULL OR outcome='failed')`,
      )
      .run(this.instanceId, followUpId);
    return info.changes === 1 ? this.getFollowUp(followUpId) : undefined;
  }

  /**
   * 担当者が「重複しうる」と承知したうえでの手動再送。
   * `unknown` と、自動再試行の上限に達したものが対象——自動では絶対に拾わないもの。
   */
  claimFollowUpManualRetry(confessionId: number, followUpId: number): FollowUpRow | undefined {
    // **案件との結び付きはDBが決める。** 呼び出し側が持ってきた案件IDと一致しなければ、
    // その追記には触れない（別案件の本文を、権限のある案件の側へ流させない）。
    const row = this.getFollowUp(followUpId);
    if (!row || row.confession_id !== confessionId || row.relayed_at !== null || row.body === null) return undefined;
    const eligible = row.outcome === "unknown" || (row.outcome === "failed" && row.attempts >= CONFESSION_FOLLOW_UP_MAX_ATTEMPTS);
    if (!eligible) return undefined;
    const info = this.db
      .prepare(
        `UPDATE confession_follow_ups
         SET outcome='sending', attempts=attempts+1, generation=generation+1, owner_instance=?
         WHERE id=? AND confession_id=? AND outcome=?`,
      )
      .run(this.instanceId, followUpId, confessionId, row.outcome);
    return info.changes === 1 ? this.getFollowUp(followUpId) : undefined;
  }

  /** 未解決の追記を、運営が処理を選べる箱へ分ける */
  followUpTriage(confessionId: number): FollowUpTriage {
    const row = this.get(confessionId);
    const hasThread = !!row?.thread_id;
    const open = this.listUnrelayedFollowUps(confessionId);
    const t = { notReady: 0, pending: 0, sending: 0, failed: 0, unknown: 0, exhausted: 0 };
    for (const f of open) {
      if (f.outcome === "sending") t.sending += 1;
      else if (f.outcome === "unknown") t.unknown += 1;
      else if (f.outcome === "failed") {
        if (f.attempts >= CONFESSION_FOLLOW_UP_MAX_ATTEMPTS) t.exhausted += 1;
        else t.failed += 1;
      } else if (!hasThread) t.notReady += 1;
      else t.pending += 1;
    }
    return { ...t, total: open.length };
  }

  /** 手動対応が要るもの（unknown / 上限到達）を担当者へ出す */
  listFollowUpsNeedingDecision(confessionId: number): FollowUpRow[] {
    return this.listUnrelayedFollowUps(confessionId).filter(
      (f) =>
        f.body !== null &&
        (f.outcome === "unknown" || (f.outcome === "failed" && f.attempts >= CONFESSION_FOLLOW_UP_MAX_ATTEMPTS)),
    );
  }

  /**
   * 担当者が「もう渡さなくてよい」と判断して閉じる出口。
   * 本文は消し、届いたことにはしない——`resolved_manually` として残す。
   */
  resolveFollowUpManually(confessionId: number, followUpId: number, staffId: string): FollowUpRow | undefined {
    // **`relayed_at` は「運営スレッドへ実際に渡せた時刻」だけを意味する。**
    // 人が「もう追わない」と決めたことを配送の時刻で表すと、あとから
    // 「渡した記録がある」と読まれてしまう。決着は別の欄で持つ。
    const info = this.db
      .prepare(
        `UPDATE confession_follow_ups SET outcome='resolved_manually', body=NULL, resolved_at=?, resolved_by=?
         WHERE id=? AND confession_id=? AND relayed_at IS NULL AND outcome IN ('failed','unknown')`,
      )
      .run(now(), staffId, followUpId, confessionId);
    if (info.changes === 1) {
      this.events.log("confession_followup_resolved", { actor: staffId, payload: { id: confessionId, followUpId } });
    }
    return this.getFollowUp(followUpId);
  }

  /**
   * 投稿者へ届いた1通を、最終形へ書き換える指示を durable に残す。
   *
   * 会話の確定と同じトランザクションで置くので、編集の前に落ちても
   * 「DBはこう、投稿者の画面はこう」というズレが**指示として残る**。
   * これは新しい DM を送るための行ではない——**同じメッセージを直すための行**。
   */
  private queueFinalRender(input: {
    confessionId: number;
    draftId: number | null;
    target: { channelId: string; messageId: string } | null;
    kind: "reply_waiting" | "reply_closed" | "reply_after_close";
    deadlineAt: number | null;
    closedBySender: boolean;
    atTs: number;
  }): void {
    if (!input.target) return;
    this.db
      .prepare(
        `INSERT INTO confession_pending_renders
           (confession_id, draft_id, channel_id, message_id, render_kind, deadline_at, closed_by_sender, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.confessionId,
        input.draftId,
        input.target.channelId,
        input.target.messageId,
        input.kind,
        input.deadlineAt,
        input.closedBySender ? 1 : 0,
        input.atTs,
      );
  }

  /** まだ最終形へ書き換えられていない指示（起動時・刻時盤が収束させる） */
  listPendingRenders(limit = 20): PendingRenderRow[] {
    return this.db
      .prepare("SELECT * FROM confession_pending_renders WHERE state IN ('pending','failed') ORDER BY id LIMIT ?")
      .all(limit) as PendingRenderRow[];
  }

  pendingRendersFor(confessionId: number): PendingRenderRow[] {
    return this.db
      .prepare("SELECT * FROM confession_pending_renders WHERE confession_id=? AND state<>'settled' ORDER BY id")
      .all(confessionId) as PendingRenderRow[];
  }

  /** 書き換えの結末。失敗は担当者から見える形で残す（勝手に諦めない） */
  settleRender(renderId: number, state: "settled" | "failed"): PendingRenderRow | undefined {
    this.db
      .prepare("UPDATE confession_pending_renders SET state=?, settled_at=? WHERE id=? AND state<>'settled'")
      .run(state, now(), renderId);
    return this.db.prepare("SELECT * FROM confession_pending_renders WHERE id=?").get(renderId) as
      | PendingRenderRow
      | undefined;
  }

  /** 収束の所有権。勝った1つだけが Discord を触る */
  claimRender(renderId: number): PendingRenderRow | undefined {
    const info = this.db
      .prepare("UPDATE confession_pending_renders SET state='rendering' WHERE id=? AND state IN ('pending','failed')")
      .run(renderId);
    return info.changes === 1
      ? (this.db.prepare("SELECT * FROM confession_pending_renders WHERE id=?").get(renderId) as PendingRenderRow)
      : undefined;
  }

  /**
   * 「まだ片付いていない」ことの内訳。**会話が終わってもこれらは消えない。**
   *
   * 投稿者が一度送った追記や、届いたか分からない返信は、会話を閉じたからといって
   * 無かったことにはできない。運営がそこへ辿り着ける限りは「完全に片付いた」と
   * 扱わない。
   */
  obligations(confessionId: number): OperationalObligations {
    const openEmergency = !!this.openEmergencyFor(confessionId);
    const followUps = this.listUnrelayedFollowUps(confessionId).length;
    const replyDrafts = this.listReplyDraftsNeedingDecision(confessionId).length;
    const pendingRenders = this.pendingRendersFor(confessionId).length;
    return {
      openEmergency,
      followUps,
      replyDrafts,
      pendingRenders,
      total: (openEmergency ? 1 : 0) + followUps + replyDrafts + pendingRenders,
    };
  }

  /** 終了済みで、かつ未処理の責務を抱えている案件（担当者が拾えるように） */
  listClosedWithObligations(limit = 50): ConfessionRow[] {
    return (
      this.db
        .prepare("SELECT * FROM confession_tickets WHERE status='closed' ORDER BY closed_at DESC LIMIT ?")
        .all(limit) as ConfessionRow[]
    ).filter((row) => this.obligations(row.id).total > 0);
  }

  /**
   * 前のプロセスが残した「送信中」を回収する。**起動時に一度だけ。**
   *
   * 送信を始めていたかもしれないのだから、`delivered` でも `failed` でもなく
   * `unknown` へ寄せる。自動再送はしない（`unknown` は自動対象に入らない）。
   * これをやらないと、部分ユニーク索引が受領確認を永久に塞ぎ、消費済みの下書きが
   * 永久に送れないままになる。
   */
  recoverOrphanedEffects(actor = "system:startup", atTs: number = now()): OrphanRecovery {
    const ts = atTs;
    // **まだ鼓動を打っている所有者の実行は奪わない。**
    // 「起動したのだから前のプロセスは死んでいる」は、単一インスタンス運用を
    // 前提にした暗黙の仮定でしかない。一瞬でも重なれば、生きている実行を
    // unknown へ落とし、あとから帰ってくる callback と新しい実行が競合する。
    // だから死を DB 上の事実（鼓動の途絶）で確かめてから回収する。
    const live = this.liveInstances(ts).filter((i) => i !== this.instanceId);
    const placeholders = live.map(() => "?").join(",");
    const notLive = live.length > 0 ? ` AND (owner_instance IS NULL OR owner_instance NOT IN (${placeholders}))` : "";
    const run = this.db.transaction((): OrphanRecovery => {
      const ackAttempts = this.db
        .prepare(`UPDATE confession_ack_attempts SET outcome='unknown', finished_at=? WHERE outcome IS NULL${notLive}`)
        .run(ts, ...live).changes;
      const replyDrafts = this.db
        .prepare(`UPDATE confession_reply_drafts SET outcome='unknown' WHERE outcome='sending'${notLive}`)
        .run(...live).changes;
      const followUps = this.db
        .prepare(
          `UPDATE confession_follow_ups SET outcome='unknown' WHERE outcome IN ('sending','retrying') AND relayed_at IS NULL${notLive}`,
        )
        .run(...live).changes;
      return { ackAttempts, replyDrafts, followUps };
    });
    const result = run();
    if (result.ackAttempts + result.replyDrafts + result.followUps > 0) {
      this.events.log("confession_orphan_recovered", { actor, payload: { ...result } });
    }
    return result;
  }

  /** 起動時回収で `unknown` になった、まだ決着していない返信の下書き */
  listUnresolvedReplyDrafts(confessionId: number): ReplyDraftRow[] {
    return this.db
      .prepare(
        "SELECT * FROM confession_reply_drafts WHERE confession_id=? AND body IS NOT NULL AND outcome IN ('unknown','failed') ORDER BY id",
      )
      .all(confessionId) as ReplyDraftRow[];
  }

  /** まだ運営へ渡せていない追記（担当者パネルに出す） */
  listUnrelayedFollowUps(confessionId: number): FollowUpRow[] {
    // 「まだ運営へ渡していない」＝ 渡せた時刻が無く、人が畳んでもいないもの。
    // `relayed_at` だけで判定すると、手動決着した行まで永久に未処理として残る。
    return this.db
      .prepare(
        `SELECT * FROM confession_follow_ups
         WHERE confession_id=? AND relayed_at IS NULL AND COALESCE(outcome,'') <> 'resolved_manually'
         ORDER BY id`,
      )
      .all(confessionId) as FollowUpRow[];
  }

  /**
   * 保持期限を過ぎた会話本文（返信の下書き・未引き渡しの追記）を消す。
   * 相談本文の purge と同じ日次処理から呼ぶ。メタ・監査記録は残る。
   */
  purgeExpiredConversationBodies(atTs: number = now()): { drafts: number; followUps: number } {
    const drafts = this.db
      .prepare("UPDATE confession_reply_drafts SET body=NULL WHERE body IS NOT NULL AND body_purge_at IS NOT NULL AND body_purge_at <= ?")
      .run(atTs).changes;
    const followUps = this.db
      .prepare("UPDATE confession_follow_ups SET body=NULL WHERE body IS NOT NULL AND body_purge_at IS NOT NULL AND body_purge_at <= ?")
      .run(atTs).changes;
    if (drafts + followUps > 0) {
      this.events.log("confession_body_purge", {
        actor: "system:scheduler",
        payload: { drafts, followUps, auto: true },
      });
    }
    return { drafts, followUps };
  }

  /**
   * 期限が到来した「投稿者の返答待ち」案件。
   *
   * `reply_deadline_at IS NOT NULL` が条件なので、**運営側の待機・未対応・既存の
   * 根拠なき awaiting_poster は決して入らない**。
   */
  listDueSenderTimeouts(atTs: number = now(), limit = 50): ConfessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM confession_tickets
         WHERE status<>'closed' AND stage='awaiting_poster'
           AND reply_deadline_at IS NOT NULL AND reply_deadline_at <= ?
         ORDER BY reply_deadline_at LIMIT ?`,
      )
      .all(atTs, limit) as ConfessionRow[];
  }

  /**
   * 期限切れの自動終了。**読んだときの期限値と一致するときだけ**閉じる。
   *
   * 古い期限を掴んだまま眠っていた実行が、その後 staff が返信して更新された新しい会話を
   * 閉じてしまわないための条件。二重実行も changes=0 で自然に落ちる。
   */
  autoCloseExpiredAtomic(id: number, expectedDeadlineAt: number, retentionDays?: number): SenderCloseResult {
    const ts = now();
    const purgeAt = retentionDays && retentionDays > 0 ? ts + retentionDays * 86_400 : null;
    const info = this.db
      .prepare(
        `UPDATE confession_tickets
         SET status='closed', closed_at=?, close_reason='no_response', closed_by='system:scheduler', closed_side='timeout',
             reply_deadline_at=NULL, body_purge_at=COALESCE(body_purge_at, ?)
         WHERE id=? AND status<>'closed' AND stage='awaiting_poster' AND reply_deadline_at=?`,
      )
      .run(ts, purgeAt, id, expectedDeadlineAt);
    const row = this.get(id);
    if (info.changes === 1) {
      this.events.log("confession_close", {
        actor: "system:scheduler",
        payload: { id, reason: "no_response", side: "timeout" },
      });
      return { ok: true, row: row! };
    }
    if (!row) return { ok: false, code: "not_found" };
    return { ok: false, code: "already_closed", row };
  }

  /**
   * 再オープン（誤クローズ・相談再開）。status=claimed に戻し、purge予定は据え置く。
   *
   * **終了にまつわる印は全部落とす。** `closed_side` だけ残すと
   * 「status=claimed なのに closed_side=sender」という読めない行になる。
   * 期限も引き継がない——待つと決め直すのは、開いたあとの操作。
   */
  reopen(id: number, staffId: string): ConfessionRow | undefined {
    this.db
      .prepare(
        `UPDATE confession_tickets
         SET status='claimed', stage=COALESCE(stage,'active'),
             closed_at=NULL, close_reason=NULL, closed_by=NULL, closed_side=NULL, reply_deadline_at=NULL
         WHERE id=?`,
      )
      .run(id);
    this.events.log("confession_reopen", { actor: staffId, payload: { id } });
    return this.get(id);
  }

  // ── 状態（stage）と対応先（disposition） ─────────────────
  setStage(id: number, stage: ConfessionStage, staffId: string): ConfessionRow | undefined {
    this.db.prepare("UPDATE confession_tickets SET stage=? WHERE id=?").run(stage, id);
    this.events.log("confession_stage", { actor: staffId, payload: { id, stage } });
    return this.get(id);
  }

  setDisposition(id: number, disposition: Disposition, staffId: string): ConfessionRow | undefined {
    this.db
      .prepare("UPDATE confession_tickets SET disposition=?, disposition_at=?, disposition_by=? WHERE id=?")
      .run(disposition, now(), staffId, id);
    this.events.log("confession_disposition", { actor: staffId, payload: { id, disposition } });
    return this.get(id);
  }

  // ── 担当者（追加・解除・一覧） ─────────────────
  addAssignee(id: number, userId: string, byStaffId: string): void {
    this.db
      .prepare(
        "INSERT INTO confession_assignees (confession_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(confession_id, user_id) DO UPDATE SET removed_at=NULL, added_by=excluded.added_by, added_at=excluded.added_at",
      )
      .run(id, userId, byStaffId, now());
    this.events.log("confession_assignee_add", { actor: byStaffId, payload: { id, target: userId } });
  }

  removeAssignee(id: number, userId: string, byStaffId: string): void {
    this.db
      .prepare("UPDATE confession_assignees SET removed_at=? WHERE confession_id=? AND user_id=? AND removed_at IS NULL")
      .run(now(), id, userId);
    this.events.log("confession_assignee_remove", { actor: byStaffId, payload: { id, target: userId } });
  }

  /** 現在の担当者（解除されていない）一覧 */
  assignees(id: number): string[] {
    return (
      this.db
        .prepare("SELECT user_id FROM confession_assignees WHERE confession_id=? AND removed_at IS NULL ORDER BY added_at")
        .all(id) as { user_id: string }[]
    ).map((r) => r.user_id);
  }

  isAssignee(id: number, userId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM confession_assignees WHERE confession_id=? AND user_id=? AND removed_at IS NULL")
      .get(id, userId);
  }

  /** 対応スレッドの管理パネル（現状表示）のメッセージIDを覚える（in-place更新用） */
  setPanelMsg(id: number, msgId: string): void {
    this.db.prepare("UPDATE confession_tickets SET panel_msg_id=? WHERE id=?").run(msgId, id);
  }

  // ── 本文の保持・削除（Phase 2 §5） ─────────────────
  /** 本文だけをNULL化し、案件メタ・操作ログは残す。auto=定期実行によるもの */
  purgeBody(id: number, actor: string, opts: { auto?: boolean } = {}): ConfessionRow | undefined {
    this.db.prepare("UPDATE confession_tickets SET body=NULL, body_purged_at=? WHERE id=?").run(now(), id);
    this.events.log("confession_body_purge", { actor, payload: { id, auto: opts.auto ?? false } });
    return this.get(id);
  }

  /** purge予定を過ぎ、まだ本文が残っている案件（定期purge・管理者一覧の両方で使う） */
  listPurgeable(atTs: number = now()): ConfessionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM confession_tickets WHERE body IS NOT NULL AND body_purged_at IS NULL AND body_purge_at IS NOT NULL AND body_purge_at <= ? ORDER BY body_purge_at",
      )
      .all(atTs) as ConfessionRow[];
  }

  /** 保持延長。purge予定日を将来へずらし、理由を記録する */
  extendRetention(id: number, newPurgeAt: number, reason: string, actor: string): ConfessionRow | undefined {
    this.db
      .prepare("UPDATE confession_tickets SET body_purge_at=?, body_retention_reason=? WHERE id=?")
      .run(newPurgeAt, reason, id);
    this.events.log("confession_retention_extend", { actor, payload: { id, purgeAt: newPurgeAt, reason } });
    return this.get(id);
  }

  // ── 冥府裁判所への送致（Phase 3） ─────────────────
  /** 送致フォーム確定。分類・意思確認状況・概要を記録し、送致確認中(court_review)にする */
  recordCourtReferral(
    id: number,
    opts: { category: string; consent: string; staffId: string; form: { reason: string; summary: string; wants: string } },
  ): ConfessionRow | undefined {
    // 裁判所送致は会話状態(stage)を書き換えない。付帯情報として別欄で表示する。
    this.db
      .prepare(
        "UPDATE confession_tickets SET court_status='pending_consent', court_category=?, court_consent=?, court_form=? WHERE id=?",
      )
      .run(opts.category, opts.consent, JSON.stringify(opts.form), id);
    this.events.log("confession_court_referral", {
      actor: opts.staffId,
      payload: { id, category: opts.category, consent: opts.consent },
    });
    return this.get(id);
  }

  /** 意思確認状況の更新（投稿者DM応答や担当者操作から） */
  setCourtConsent(id: number, consent: string, actor: string): ConfessionRow | undefined {
    this.db.prepare("UPDATE confession_tickets SET court_consent=? WHERE id=?").run(consent, id);
    this.events.log("confession_court_consent", { actor, payload: { id, consent } });
    return this.get(id);
  }

  /** フォーラム投稿を作成できた＝送致確定。送致先を記録し stage を court_sent に */
  recordCourtPost(id: number, opts: { threadId: string; url: string; staffId: string }): ConfessionRow | undefined {
    // 送致完了も stage は書き換えない。会話状態と裁判所状況は独立して進む。
    this.db
      .prepare(
        "UPDATE confession_tickets SET court_status='sent', court_thread_id=?, court_url=?, court_sent_at=?, court_sent_by=? WHERE id=?",
      )
      .run(opts.threadId, opts.url, now(), opts.staffId, id);
    this.events.log("confession_court_sent", { actor: opts.staffId, payload: { id, threadId: opts.threadId } });
    return this.get(id);
  }

  /** 事件番号の登録（後から担当者が追記） */
  setCourtCaseNo(id: number, caseNo: string, actor: string): ConfessionRow | undefined {
    this.db.prepare("UPDATE confession_tickets SET court_case_no=? WHERE id=?").run(caseNo, id);
    this.events.log("confession_court_caseno", { actor, payload: { id, caseNo } });
    return this.get(id);
  }

  /** 送致の取消し（確認中止・誤操作）。stage を対応中に戻す */
  cancelCourtReferral(id: number, actor: string): ConfessionRow | undefined {
    // stage には触れない（裁判所状況は付帯情報。会話状態は担当のやり取りだけで更新する）
    this.db.prepare("UPDATE confession_tickets SET court_status='canceled' WHERE id=?").run(id);
    this.events.log("confession_court_cancel", { actor, payload: { id } });
    return this.get(id);
  }

  // ── 緊急対応（Phase 4） ─────────────────
  /** 緊急対応を登録（処分は自動実行しない。人間確認のための記録＋通知用データ） */
  createEmergency(opts: {
    confessionId: number;
    createdBy: string;
    reason: string;
    target: string;
    dangerOngoing: boolean;
    measures: string; // カンマ区切りのコード
    reviewNote: string | null;
    note: string | null;
  }): EmergencyRow {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO confession_emergency
         (confession_id, created_by, created_at, reason, target, danger_ongoing, measures, review_note, note, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(
        opts.confessionId,
        opts.createdBy,
        ts,
        opts.reason,
        opts.target,
        opts.dangerOngoing ? 1 : 0,
        opts.measures,
        opts.reviewNote,
        opts.note,
      );
    const emgId = Number(info.lastInsertRowid);
    // 緊急共有は付帯情報。会話状態(stage)は書き換えず、担当者は通常のやり取りを続ける。
    this.events.log("confession_emergency_create", {
      actor: opts.createdBy,
      payload: { id: opts.confessionId, emgId, dangerOngoing: opts.dangerOngoing },
    });
    return this.getEmergency(emgId)!;
  }

  getEmergency(emgId: number): EmergencyRow | undefined {
    return this.db.prepare("SELECT * FROM confession_emergency WHERE id=?").get(emgId) as EmergencyRow | undefined;
  }

  /** 案件に紐づく未終了(open/confirmed)の緊急対応（最新1件） */
  openEmergencyFor(confessionId: number): EmergencyRow | undefined {
    return this.db
      .prepare("SELECT * FROM confession_emergency WHERE confession_id=? AND status!='closed' ORDER BY created_at DESC LIMIT 1")
      .get(confessionId) as EmergencyRow | undefined;
  }

  confirmEmergency(emgId: number, staffId: string): EmergencyRow | undefined {
    this.db
      .prepare("UPDATE confession_emergency SET status='confirmed', confirmed_by=? WHERE id=? AND status='open'")
      .run(staffId, emgId);
    this.events.log("confession_emergency_confirm", { actor: staffId, payload: { emgId } });
    return this.getEmergency(emgId);
  }

  closeEmergency(emgId: number, staffId: string): EmergencyRow | undefined {
    this.db.prepare("UPDATE confession_emergency SET status='closed', closed_at=? WHERE id=?").run(now(), emgId);
    this.events.log("confession_emergency_close", { actor: staffId, payload: { emgId } });
    return this.getEmergency(emgId);
  }

  // ── 出禁（サイレントドロップ用） ─────────────────
  block(userId: string, byStaffId: string): void {
    this.db
      .prepare("INSERT INTO confession_blocks (user_id, blocked_at, blocked_by) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
      .run(userId, now(), byStaffId);
    this.events.log("confession_block", { actor: byStaffId, payload: { target: userId } });
  }

  unblock(userId: string, byStaffId: string): void {
    this.db.prepare("DELETE FROM confession_blocks WHERE user_id = ?").run(userId);
    this.events.log("confession_unblock", { actor: byStaffId, payload: { target: userId } });
  }

  isBlocked(userId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM confession_blocks WHERE user_id = ?").get(userId);
  }
}
