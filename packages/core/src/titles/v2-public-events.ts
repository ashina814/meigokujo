import type Database from "better-sqlite3";

export interface CompletedPublicEventParticipationFact {
  readonly userId: string;
  readonly eventKey: string;
  readonly completedAt: number;
}

/**
 * requested usersについて、明示的なstaff completion正本と同一roster revisionへ
 * 結び付く参加だけを返す。bind数はuserIds + window境界2個だけに依存する。
 */
export function computeCompletedPublicEventParticipations(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly CompletedPublicEventParticipationFact[] {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT p.user_id, p.event_key, c.completed_at
         FROM public_event_participations p
         JOIN public_event_completions c
           ON c.event_key = p.event_key
          AND c.roster_recorded_at = p.recorded_at
        WHERE p.user_id IN (${placeholders})
          AND c.completed_at >= c.roster_recorded_at
          AND c.completed_at >= ?
          AND c.completed_at < ?
        ORDER BY p.user_id ASC, c.completed_at ASC, p.event_key ASC`,
    )
    .all(...userIds, window.start, window.end) as Array<{
    user_id: string;
    event_key: string;
    completed_at: number;
  }>;
  return rows.map((row) => ({ userId: row.user_id, eventKey: row.event_key, completedAt: row.completed_at }));
}
