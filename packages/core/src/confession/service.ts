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
  | "handoff" // 外部への引継ぎ中（通常運営/諧和廷）
  | "court_review" // 裁判所への送致確認中
  | "court_sent" // 裁判所へ送致済み
  | "emergency"; // 緊急対応中

/** 対応先（Phase 2 §1） */
export type Disposition = "church" | "normal" | "kaiwa" | "court" | "emergency" | "record";

/** クローズ理由（Phase 2 §4） */
export type CloseReason =
  | "resolved"
  | "poster_ended"
  | "no_response"
  | "handoff_normal"
  | "handoff_kaiwa"
  | "sent_court"
  | "no_action"
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

/** create に渡す任意メタ（未指定でも従来通り動く） */
export interface ConfessionMeta {
  type?: ConfessionType;
  replyWish?: ReplyWish;
  body?: string;
}

const now = () => Math.floor(Date.now() / 1000);

export class Confessions {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
  ) {
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
  }

  /** confession_tickets に列が無ければ追加する（冪等な後付けマイグレーション） */
  private addColumn(name: string, decl: string): void {
    const cols = this.db.prepare("PRAGMA table_info(confession_tickets)").all() as { name: string }[];
    if (cols.some((c) => c.name === name)) return;
    this.db.exec(`ALTER TABLE confession_tickets ADD COLUMN ${name} ${decl}`);
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
  claim(id: number, threadId: string, staffId: string): ConfessionRow | undefined {
    const ts = now();
    this.db
      .prepare("UPDATE confession_tickets SET status='claimed', stage='active', thread_id=?, claimed_by=?, claimed_at=? WHERE id=?")
      .run(threadId, staffId, ts, id);
    // 主担当も担当者一覧に載せておく（一覧・権限判定を assignees に一本化するため）
    this.db
      .prepare(
        "INSERT INTO confession_assignees (confession_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(confession_id, user_id) DO UPDATE SET removed_at=NULL",
      )
      .run(id, staffId, staffId, ts);
    this.events.log("confession_claim", { actor: staffId, payload: { id, threadId } });
    return this.get(id);
  }

  /**
   * クローズ。理由・担当者・本文purge予定を記録する。
   * retentionDays を渡すと closed_at + N日 を body_purge_at に設定（0/未指定なら purge予定なし）。
   */
  close(id: number, staffId: string, reason?: CloseReason, retentionDays?: number): ConfessionRow | undefined {
    const ts = now();
    const purgeAt = retentionDays && retentionDays > 0 ? ts + retentionDays * 86_400 : null;
    this.db
      .prepare(
        "UPDATE confession_tickets SET status='closed', closed_at=?, close_reason=?, closed_by=?, body_purge_at=COALESCE(body_purge_at, ?) WHERE id=?",
      )
      .run(ts, reason ?? null, staffId, purgeAt, id);
    this.events.log("confession_close", { actor: staffId, payload: { id, reason: reason ?? null } });
    return this.get(id);
  }

  /** 再オープン（誤クローズ・相談再開）。status=claimed に戻し、purge予定は据え置く */
  reopen(id: number, staffId: string): ConfessionRow | undefined {
    this.db
      .prepare("UPDATE confession_tickets SET status='claimed', stage=COALESCE(stage,'active'), closed_at=NULL, close_reason=NULL, closed_by=NULL WHERE id=?")
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
    this.db
      .prepare(
        "UPDATE confession_tickets SET court_status='pending_consent', court_category=?, court_consent=?, court_form=?, stage='court_review' WHERE id=?",
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
    this.db
      .prepare(
        "UPDATE confession_tickets SET court_status='sent', court_thread_id=?, court_url=?, court_sent_at=?, court_sent_by=?, stage='court_sent' WHERE id=?",
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
    this.db
      .prepare("UPDATE confession_tickets SET court_status='canceled', stage=CASE WHEN status='claimed' THEN 'active' ELSE stage END WHERE id=?")
      .run(id);
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
    // 案件側の状態も緊急対応中に
    this.db.prepare("UPDATE confession_tickets SET stage='emergency' WHERE id=?").run(opts.confessionId);
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
