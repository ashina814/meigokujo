import type Database from "better-sqlite3";

/** Bump（DISBOARD・ディス速）成功回数の集計。ランキング用 */
export class BumpCounter {
  constructor(private readonly db: Database.Database) {}

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
