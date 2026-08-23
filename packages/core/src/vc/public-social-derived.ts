import type Database from "better-sqlite3";
import type { TitleWindow } from "./derived.js";

export interface PublicSocialPresenceIntervals {
  readonly userId: string;
  /** internal guild/channel identityを除いたsubject-global wall-clock union。[start,end)。 */
  readonly intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

interface PresenceRow {
  readonly user_id: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly end_quality: "observed" | "recovered_estimate" | null;
}

function unionIntervals(
  intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): Array<{ start: number; end: number }> {
  const ordered = intervals
    .filter((value) => value.end > value.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || interval.start > previous.end) merged.push({ ...interval });
    else if (interval.end > previous.end) previous.end = interval.end;
  }
  return merged;
}

/**
 * canonical `vc_public_social_presence`だけを読み、trusted public-human wall-clock
 * intervalへsanitizeする。closed rowはobserved endだけを採用する。後のrestartで
 * recovered_estimateになったrowでも、固定snapshotより終了が後ならそのsnapshot時点では
 * live-open observationだったためeffectiveEndまでclipする。現在snapshotではrecovered rowを
 * 行ごと除外し、downtimeも推定終了も数えない。
 */
export function computePublicSocialPresenceIntervals(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): PublicSocialPresenceIntervals[] {
  const requested = userIds ? [...new Set(userIds)] : undefined;
  if (requested && requested.length === 0) return [];
  const effectiveEnd = Math.min(window.end, window.observedAt ?? window.end);
  const targetIds = requested ?? [];
  if (effectiveEnd <= window.start) return targetIds.map((userId) => ({ userId, intervals: [] }));

  const userFilter = requested ? ` AND user_id IN (${requested.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(
      `SELECT user_id, started_at, ended_at, end_quality
         FROM vc_public_social_presence
        WHERE started_at < ?
          AND (ended_at IS NULL OR ended_at > ?)
          ${userFilter}
        ORDER BY user_id ASC, started_at ASC, id ASC`,
    )
    .all(effectiveEnd, window.start, ...(requested ?? [])) as PresenceRow[];

  const intervalsByUser = new Map<string, Array<{ start: number; end: number }>>();
  for (const userId of requested ?? [...new Set(rows.map((row) => row.user_id))].sort()) {
    intervalsByUser.set(userId, []);
  }
  for (const row of rows) {
    const endIsAfterSnapshot = row.ended_at === null || row.ended_at > effectiveEnd;
    if (!endIsAfterSnapshot && row.end_quality !== "observed") continue;
    const start = Math.max(row.started_at, window.start);
    const end = Math.min(row.ended_at ?? effectiveEnd, effectiveEnd);
    if (end > start) intervalsByUser.get(row.user_id)?.push({ start, end });
  }

  return [...intervalsByUser].map(([userId, intervals]) => ({
    userId,
    intervals: unionIntervals(intervals),
  }));
}
