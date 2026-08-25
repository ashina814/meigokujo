import type Database from "better-sqlite3";
import type { TitleWindow } from "./derived.js";
import { getVcPublicSocialTrustFence } from "./public-social-presence.js";

export interface PublicSocialPresenceIntervals {
  readonly userId: string;
  /** internal guild/channel identityを除いたsubject-global wall-clock union。[start,end)。 */
  readonly intervals: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

/** restricted cross-source ownership JOIN用。safe payloadへguild/channel identityを出さない。 */
export interface PublicSocialPresenceChannelIntervals {
  readonly userId: string;
  readonly intervals: ReadonlyArray<{
    readonly guildId: string;
    readonly channelId: string;
    readonly start: number;
    readonly end: number;
  }>;
}

interface PresenceRow {
  readonly user_id: string;
  readonly guild_id: string;
  readonly channel_id: string;
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
    if (!previous || interval.start > previous.end) merged.push({ start: interval.start, end: interval.end });
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
export function computePublicSocialPresenceChannelIntervals(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): PublicSocialPresenceChannelIntervals[] {
  const requested = userIds ? [...new Set(userIds)] : undefined;
  if (requested && requested.length === 0) return [];
  const effectiveEnd = Math.min(window.end, window.observedAt ?? window.end);
  const targetIds = requested ?? [];
  if (effectiveEnd <= window.start) return targetIds.map((userId) => ({ userId, intervals: [] }));

  const userFilter = requested ? ` AND user_id IN (${requested.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(
      `SELECT user_id, guild_id, channel_id, started_at, ended_at, end_quality
         FROM vc_public_social_presence
        WHERE started_at < ?
          AND (ended_at IS NULL OR ended_at > ?)
          ${userFilter}
        ORDER BY user_id ASC, started_at ASC, id ASC`,
    )
    .all(effectiveEnd, window.start, ...(requested ?? [])) as PresenceRow[];

  const intervalsByUser = new Map<string, Array<{
    guildId: string; channelId: string; start: number; end: number;
  }>>();
  for (const userId of requested ?? [...new Set(rows.map((row) => row.user_id))].sort()) {
    intervalsByUser.set(userId, []);
  }
  for (const row of rows) {
    const fence = getVcPublicSocialTrustFence(db, row.guild_id, row.channel_id);
    const persistedEnd = row.ended_at ?? Number.POSITIVE_INFINITY;
    const fencedEnd = Math.min(persistedEnd, fence ?? Number.POSITIVE_INFINITY);
    const endIsAfterSnapshot = fencedEnd > effectiveEnd;
    const hasObservedTrustBoundary = row.end_quality === "observed" || (fence !== undefined && fence <= persistedEnd);
    if (!endIsAfterSnapshot && !hasObservedTrustBoundary) continue;
    const start = Math.max(row.started_at, window.start);
    const end = Math.min(fencedEnd, effectiveEnd);
    if (end > start) intervalsByUser.get(row.user_id)?.push({
      guildId: row.guild_id,
      channelId: row.channel_id,
      start,
      end,
    });
  }

  return [...intervalsByUser].map(([userId, intervals]) => ({ userId, intervals }));
}

export function computePublicSocialPresenceIntervals(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): PublicSocialPresenceIntervals[] {
  return computePublicSocialPresenceChannelIntervals(db, window, userIds).map(({ userId, intervals }) => ({
    userId,
    intervals: unionIntervals(intervals),
  }));
}
