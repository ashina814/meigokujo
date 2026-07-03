import type Database from "better-sqlite3";

/**
 * 事件録 (EventLog) — 城で起きた全ての出来事の追記専用記録（システム設計.md ②）。
 * タイムズ・百年城史・称号機関は全部ここの読み出し方が違うだけ。最初から全部記録する。
 */
export interface EventRow {
  id: number;
  type: string;
  actor_id: string | null;
  target_id: string | null;
  payload_json: string | null;
  created_at: number;
}

export class EventLog {
  constructor(private readonly db: Database.Database) {}

  log(type: string, opts: { actor?: string; target?: string; payload?: unknown } = {}): number {
    const result = this.db
      .prepare("INSERT INTO events (type, actor_id, target_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        type,
        opts.actor ?? null,
        opts.target ?? null,
        opts.payload === undefined ? null : JSON.stringify(opts.payload),
        Math.floor(Date.now() / 1000),
      );
    return Number(result.lastInsertRowid);
  }

  listByTarget(targetId: string, limit = 50): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE target_id = ? ORDER BY id DESC LIMIT ?")
      .all(targetId, limit) as EventRow[];
  }

  listByType(type: string, limit = 50): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?")
      .all(type, limit) as EventRow[];
  }
}
