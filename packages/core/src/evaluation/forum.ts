import type Database from "better-sqlite3";

export type EvaluationCycleOrigin = "entry" | "return" | "reevaluation";

export interface EvaluationCycleContext {
  userId: string;
  startedAt: number;
  deadlineAt: number | null;
  inviteBaseline: number;
  origin: EvaluationCycleOrigin;
}

export interface EvaluationPresenceSummary {
  denDays: number;
  denSeconds: number;
  swordsmanDays: number;
  swordsmanSeconds: number;
}

interface Interval {
  start: number;
  end: number;
}

interface CycleRow {
  user_id: string;
  eval_started_at: number;
  eval_deadline_at: number | null;
  eval_invite_baseline: number | null;
}

const LEGACY_CYCLE = 0;

function mergeIntervals(input: Interval[]): Interval[] {
  const sorted = input
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end) {
      merged.push({ ...interval });
      continue;
    }
    last.end = Math.max(last.end, interval.end);
  }
  return merged;
}

function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i]!.start, right[j]!.start);
    const end = Math.min(left[i]!.end, right[j]!.end);
    if (end > start) out.push({ start, end });
    if (left[i]!.end <= right[j]!.end) i += 1;
    else j += 1;
  }
  return mergeIntervals(out);
}

function intervalSeconds(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** JST の暦日。終了時刻ちょうどは次の日へ含めない。 */
function intervalJstDays(intervals: Interval[]): number {
  const days = new Set<number>();
  for (const interval of mergeIntervals(intervals)) {
    if (interval.end <= interval.start) continue;
    const first = Math.floor((interval.start + 9 * 3600) / 86_400);
    const last = Math.floor((interval.end - 1 + 9 * 3600) / 86_400);
    for (let day = first; day <= last; day += 1) days.add(day);
  }
  return days.size;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * 新しい評価導線のデータ部分。
 *
 * ここでは「誰を昇格させるか」「何アリか」のような制度判断を一切しない。
 * 評価サイクルとフォーラムの対応、現在サイクルの招待件数、VCの客観的な重複時間だけを扱う。
 */
export class EvaluationForumStore {
  constructor(private readonly db: Database.Database) {
    this.ensureThreadSchema();
  }

  /**
   * 旧 eval_threads(user_id PRIMARY KEY, thread_id) を履歴を消さずに移行する。
   * 旧行がどの評価サイクルのものかDBだけでは断定できないため cycle_started_at=0 に隔離する。
   * これにより既存フォーラムは保持しつつ、現在サイクルを誤って過去フォーラムへ再接続しない。
   */
  private ensureThreadSchema(): void {
    const exists = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='eval_threads'")
      .get() as { ok: number } | undefined;
    if (!exists) {
      this.db.exec(`
        CREATE TABLE eval_threads (
          user_id TEXT NOT NULL,
          cycle_started_at INTEGER NOT NULL,
          thread_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, cycle_started_at)
        );
        CREATE UNIQUE INDEX idx_eval_threads_thread ON eval_threads(thread_id);
      `);
      return;
    }

    const columns = this.db.prepare("PRAGMA table_info(eval_threads)").all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === "cycle_started_at")) {
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_threads_thread ON eval_threads(thread_id)");
      return;
    }

    const migrate = this.db.transaction(() => {
      this.db.exec("ALTER TABLE eval_threads RENAME TO eval_threads_legacy");
      this.db.exec(`
        CREATE TABLE eval_threads (
          user_id TEXT NOT NULL,
          cycle_started_at INTEGER NOT NULL,
          thread_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, cycle_started_at)
        )
      `);
      this.db
        .prepare(
          `INSERT INTO eval_threads (user_id, cycle_started_at, thread_id, created_at)
           SELECT user_id, ?, thread_id, 0 FROM eval_threads_legacy`,
        )
        .run(LEGACY_CYCLE);
      this.db.exec("DROP TABLE eval_threads_legacy");
      this.db.exec("CREATE UNIQUE INDEX idx_eval_threads_thread ON eval_threads(thread_id)");
    });
    migrate.immediate();
  }

  listCurrentCycles(): EvaluationCycleContext[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, eval_started_at, eval_deadline_at, eval_invite_baseline
           FROM souls
          WHERE status = 'ghost' AND eval_started_at IS NOT NULL
          ORDER BY COALESCE(eval_deadline_at, 9223372036854775807), eval_started_at, user_id`,
      )
      .all() as CycleRow[];
    return rows.map((row) => this.toContext(row));
  }

  currentCycle(userId: string): EvaluationCycleContext | null {
    const row = this.db
      .prepare(
        `SELECT user_id, eval_started_at, eval_deadline_at, eval_invite_baseline
           FROM souls
          WHERE user_id = ? AND status = 'ghost' AND eval_started_at IS NOT NULL`,
      )
      .get(userId) as CycleRow | undefined;
    return row ? this.toContext(row) : null;
  }

  private toContext(row: CycleRow): EvaluationCycleContext {
    return {
      userId: row.user_id,
      startedAt: row.eval_started_at,
      deadlineAt: row.eval_deadline_at,
      inviteBaseline: Math.max(0, row.eval_invite_baseline ?? 0),
      origin: this.cycleOrigin(row.user_id, row.eval_started_at),
    };
  }

  /** 出戻り・再評価の既存イベントを正本にし、単なる souls 行の存在では判定しない。 */
  cycleOrigin(userId: string, startedAt: number): EvaluationCycleOrigin {
    const row = this.db
      .prepare(
        `SELECT type
           FROM events
          WHERE target_id = ?
            AND type IN ('entry_return_reinstated', 'reeval_reinstated', 'ghosted')
            AND created_at BETWEEN ? AND ?
          ORDER BY CASE type
                     WHEN 'entry_return_reinstated' THEN 1
                     WHEN 'reeval_reinstated' THEN 2
                     ELSE 3
                   END,
                   created_at DESC
          LIMIT 1`,
      )
      .get(userId, startedAt - 5, startedAt + 5) as { type: string } | undefined;
    if (row?.type === "entry_return_reinstated") return "return";
    if (row?.type === "reeval_reinstated") return "reevaluation";
    return "entry";
  }

  threadFor(userId: string, cycleStartedAt: number): string | null {
    const row = this.db
      .prepare("SELECT thread_id FROM eval_threads WHERE user_id = ? AND cycle_started_at = ?")
      .get(userId, cycleStartedAt) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }

  setThread(userId: string, cycleStartedAt: number, threadId: string, createdAt = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare(
        `INSERT INTO eval_threads (user_id, cycle_started_at, thread_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, cycle_started_at) DO UPDATE SET thread_id = excluded.thread_id`,
      )
      .run(userId, cycleStartedAt, threadId, createdAt);
  }

  /** 旧マッピングは監査用に保持するだけで、新しい評価サイクルからは参照しない。 */
  legacyThreadFor(userId: string): string | null {
    return this.threadFor(userId, LEGACY_CYCLE);
  }

  /**
   * 「今回の評価開始後」の招待実績。
   * invites.credited_at が確定時刻の正本なので、通常入城・出戻り・再評価を同じ式で扱える。
   * eval_invite_baseline は既存の制度計算用スナップショットとして保持するが、表示件数の根拠にはしない。
   */
  inviteCountSinceCycle(userId: string, startedAt: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM invites WHERE inviter_id = ? AND credited_at >= ?")
      .get(userId, startedAt) as { n: number };
    return row.n;
  }

  /**
   * 冥獣の巣カテゴリだけの滞在と、現在の魔剣士との重複時間を集計する。
   * parent_id を使うため、動的VCが削除され den_vcs から掃除された後も履歴を失わない。
   */
  presenceForCycle(args: {
    userId: string;
    swordsmanIds: string[];
    denParentId: string;
    startedAt: number;
    now?: number;
  }): EvaluationPresenceSummary {
    const nowSec = args.now ?? Math.floor(Date.now() / 1000);
    const targetRows = this.db
      .prepare(
        `SELECT started_at, COALESCE(ended_at, ?) AS ended_at
           FROM vc_segments
          WHERE user_id = ?
            AND parent_id = ?
            AND started_at < ?
            AND COALESCE(ended_at, ?) > ?`,
      )
      .all(nowSec, args.userId, args.denParentId, nowSec, nowSec, args.startedAt) as Array<{
      started_at: number;
      ended_at: number;
    }>;
    const target = mergeIntervals(
      targetRows.map((r) => ({ start: Math.max(r.started_at, args.startedAt), end: Math.min(r.ended_at, nowSec) })),
    );

    let swordsmen: Interval[] = [];
    const ids = [...new Set(args.swordsmanIds.filter((id) => id && id !== args.userId))];
    if (ids.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT started_at, COALESCE(ended_at, ?) AS ended_at
             FROM vc_segments
            WHERE user_id IN (${placeholders(ids.length)})
              AND parent_id = ?
              AND started_at < ?
              AND COALESCE(ended_at, ?) > ?`,
        )
        .all(nowSec, ...ids, args.denParentId, nowSec, nowSec, args.startedAt) as Array<{
        started_at: number;
        ended_at: number;
      }>;
      swordsmen = mergeIntervals(
        rows.map((r) => ({ start: Math.max(r.started_at, args.startedAt), end: Math.min(r.ended_at, nowSec) })),
      );
    }

    const overlap = intersectIntervals(target, swordsmen);
    return {
      denDays: intervalJstDays(target),
      denSeconds: intervalSeconds(target),
      swordsmanDays: intervalJstDays(overlap),
      swordsmanSeconds: intervalSeconds(overlap),
    };
  }
}

export const evaluationForumInternalsForTesting = {
  mergeIntervals,
  intersectIntervals,
  intervalJstDays,
  intervalSeconds,
  LEGACY_CYCLE,
};
