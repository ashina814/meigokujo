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

export interface ConfessionRow {
  id: number;
  user_id: string;
  status: ConfessionStatus;
  thread_id: string | null;
  claimed_by: string | null;
  created_at: number;
  claimed_at: number | null;
  closed_at: number | null;
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
    `);
  }

  /** 告発を受け付ける。返り値の id が受付番号（運営にはこれだけ見せる） */
  create(userId: string): ConfessionRow {
    const ts = now();
    const info = this.db
      .prepare("INSERT INTO confession_tickets (user_id, status, created_at) VALUES (?, 'open', ?)")
      .run(userId, ts);
    const id = Number(info.lastInsertRowid);
    // user_id は監査用にイベントログへ残すが、運営が直接見る導線には出さない
    this.events.log("confession_create", { actor: userId, payload: { id } });
    return this.get(id)!;
  }

  get(id: number): ConfessionRow | undefined {
    return this.db.prepare("SELECT * FROM confession_tickets WHERE id = ?").get(id) as ConfessionRow | undefined;
  }

  byThread(threadId: string): ConfessionRow | undefined {
    return this.db.prepare("SELECT * FROM confession_tickets WHERE thread_id = ?").get(threadId) as ConfessionRow | undefined;
  }

  /** 運営が対応開始。対応スレッドと紐付ける */
  claim(id: number, threadId: string, staffId: string): ConfessionRow | undefined {
    const ts = now();
    this.db
      .prepare("UPDATE confession_tickets SET status='claimed', thread_id=?, claimed_by=?, claimed_at=? WHERE id=?")
      .run(threadId, staffId, ts, id);
    this.events.log("confession_claim", { actor: staffId, payload: { id, threadId } });
    return this.get(id);
  }

  close(id: number, staffId: string): ConfessionRow | undefined {
    this.db.prepare("UPDATE confession_tickets SET status='closed', closed_at=? WHERE id=?").run(now(), id);
    this.events.log("confession_close", { actor: staffId, payload: { id } });
    return this.get(id);
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
