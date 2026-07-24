import type Database from "better-sqlite3";

/** Bump（DISBOARD・ディス速）成功回数の集計。ランキング用 */
export class BumpCounter {
  constructor(private readonly db: Database.Database) {
    // 既存本番DBにも安全に追加できる、メッセージ単位の冪等記録。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bump_events (
        message_id TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bump_events_user ON bump_events(user_id, created_at);
    `);
  }

  /**
   * 同じDiscordメッセージIDを二重加算しない形で成功実績を記録する。
   * true = 今回初めて記録、false = 既に記録済み。
   */
  addOnce(messageId: string, userId: string): boolean {
    const ts = Math.floor(Date.now() / 1000);
    const run = this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO bump_events (message_id, user_id, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(messageId, userId, ts);

      if (inserted.changes === 0) return false;

      this.db
        .prepare(
          `INSERT INTO bump_counts (user_id, count, last_at, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             count = bump_counts.count + 1,
             last_at = excluded.last_at,
             updated_at = excluded.updated_at`,
        )
        .run(userId, ts, ts);
      return true;
    });

    return run();
  }

  /** 後方互換用。新規コードは addOnce を使うこと。 */
  add(userId: string): void {
    const ts = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO bump_counts (user_id, count, last_at, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           count = bump_counts.count + 1,
           last_at = excluded.last_at,
           updated_at = excluded.updated_at`,
      )
      .run(userId, ts, ts);
  }

  get(userId: string): number {
    const row = this.db.prepare("SELECT count FROM bump_counts WHERE user_id = ?").get(userId) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  top(limit = 10): Array<{ user_id: string; count: number }> {
    return this.db
      .prepare("SELECT user_id, count FROM bump_counts ORDER BY count DESC LIMIT ?")
      .all(limit) as Array<{ user_id: string; count: number }>;
  }

  position(userId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM bump_counts WHERE count > (SELECT count FROM bump_counts WHERE user_id = ?)",
      )
      .get(userId) as { c: number } | undefined;
    return (row?.c ?? 0) + 1;
  }

  population(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM bump_counts").get() as { c: number }).c;
  }
}
