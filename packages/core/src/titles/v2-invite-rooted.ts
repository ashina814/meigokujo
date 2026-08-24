import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";
import { computeTcSocialExchangeCandidates } from "../tc-social/derived.js";
import { computePublicSocialPresenceIntervals } from "../vc/public-social-derived.js";
import { getVcPublicSocialTrustFence } from "../vc/public-social-presence.js";

const SQL_CHUNK_SIZE = 300;
const DAY_SECONDS = 86_400;
const JST_OFFSET_SECONDS = 9 * 3_600;

export interface InviteRootedSafeActivityDay {
  /** canonical entry JST dateを0とした暦日差。entry day自体は出さないため常に1以上。 */
  readonly dayOffset: number;
  /** 同一public TC surfaceのnearest other-human gap。thresholdは後段calibration。 */
  readonly tcBestOtherGapMs: number | null;
  /** trusted public-social VC wall-clock union。pair-sumではない。 */
  readonly vcTrustedSocialSeconds: number;
}

export interface InviteRootedSafeReunionDay {
  readonly dayOffset: number;
  /** inviter↔direct inviteeだけのsame-surface TC gap。他者は使わない。 */
  readonly tcBestPairGapMs: number | null;
  /** inviter↔direct inviteeが同じcanonical public VCにいたtrusted union秒。 */
  readonly vcTrustedPairSeconds: number;
}

export interface InviteRootedSafeProfile {
  readonly activityDays: readonly InviteRootedSafeActivityDay[];
  /** 同じanonymous direct branchから生まれたdistinct confirmed next-generation relation数。 */
  readonly nextGenerationConfirmedCount: number;
  readonly reunionDays: readonly InviteRootedSafeReunionDay[];
}

export interface InviteRootedSafePayload {
  /** identityもexact dateも持たないanonymous direct-branch profiles。canonical順にsort済み。 */
  readonly profiles: readonly InviteRootedSafeProfile[];
  /** confirmed relationはあるがimmutable ghosted entry eventが無く、安全にanchorできないlegacy件数。 */
  readonly unknownEntryAnchorCount: number;
}

export interface InviteRootedSafeWindow {
  readonly start: number;
  readonly end: number;
  readonly observedAt?: number;
}

interface DirectRelation {
  readonly subjectId: string;
  readonly inviteeId: string;
}

interface TcMessageRow {
  readonly author_id: string;
  readonly surface_id: string;
  readonly created_at_ms: number;
}

interface PresenceRow {
  readonly user_id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly end_quality: "observed" | "recovered_estimate" | null;
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += SQL_CHUNK_SIZE) {
    result.push(values.slice(index, index + SQL_CHUNK_SIZE));
  }
  return result;
}

function requireWindow(window: InviteRootedSafeWindow): { start: number; effectiveEnd: number; observedAt: number } {
  if (!Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end) || window.start >= window.end) {
    throw new RangeError(`invalid invite rooted window: [${window.start}, ${window.end})`);
  }
  const observedAt = window.observedAt ?? window.end;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new RangeError("observedAt must be a safe unix second");
  return { start: window.start, effectiveEnd: Math.min(window.end, observedAt), observedAt };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function dateOrdinal(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / (DAY_SECONDS * 1_000));
}

function dayOffset(entryAt: number, occurrenceAt: number): number {
  return dateOrdinal(jstDateStr(new Date(occurrenceAt * 1_000))) - dateOrdinal(jstDateStr(new Date(entryAt * 1_000)));
}

function splitSecondsByOffset(intervals: readonly Interval[], entryAt: number): Map<number, number> {
  const seconds = new Map<number, number>();
  for (const interval of unionIntervals(intervals)) {
    let cursor = Math.max(interval.start, entryAt);
    while (cursor < interval.end) {
      const shifted = cursor + JST_OFFSET_SECONDS;
      const nextMidnight = (Math.floor(shifted / DAY_SECONDS) + 1) * DAY_SECONDS - JST_OFFSET_SECONDS;
      const end = Math.min(interval.end, nextMidnight);
      const offset = dayOffset(entryAt, cursor);
      if (offset >= 1) seconds.set(offset, (seconds.get(offset) ?? 0) + end - cursor);
      cursor = end;
    }
  }
  return seconds;
}

function unionIntervals(values: readonly Interval[]): Interval[] {
  const ordered = values.filter((value) => value.end > value.start).slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Array<{ start: number; end: number }> = [];
  for (const interval of ordered) {
    const previous = result[result.length - 1];
    if (!previous || interval.start > previous.end) result.push({ ...interval });
    else if (interval.end > previous.end) previous.end = interval.end;
  }
  return result;
}

function intersectIntervals(left: readonly Interval[], right: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const start = Math.max(left[a]!.start, right[b]!.start);
    const end = Math.min(left[a]!.end, right[b]!.end);
    if (end > start) result.push({ start, end });
    if (left[a]!.end <= right[b]!.end) a += 1;
    else b += 1;
  }
  return result;
}

function loadDirectRelations(
  db: Database.Database,
  subjectIds: readonly string[],
  start: number,
  effectiveEnd: number,
): DirectRelation[] {
  const relations: DirectRelation[] = [];
  for (const chunk of chunks(subjectIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT inviter_id, invitee_id FROM invites
          WHERE inviter_id IN (${placeholders})
            AND credited_at >= ? AND credited_at < ?
          ORDER BY inviter_id, invitee_id`,
      )
      .all(...chunk, start, effectiveEnd) as Array<{ inviter_id: string; invitee_id: string }>;
    for (const row of rows) {
      if (!row.inviter_id || !row.invitee_id || row.inviter_id === row.invitee_id) continue;
      relations.push({ subjectId: row.inviter_id, inviteeId: row.invitee_id });
    }
  }
  return relations;
}

function loadEntryAnchors(
  db: Database.Database,
  inviteeIds: readonly string[],
  effectiveEnd: number,
): Map<string, number> {
  const anchors = new Map<string, number>();
  for (const chunk of chunks(inviteeIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT target_id, MIN(created_at) AS entry_at
           FROM events
          WHERE type = 'ghosted' AND target_id IN (${placeholders}) AND created_at < ?
          GROUP BY target_id`,
      )
      .all(...chunk, effectiveEnd) as Array<{ target_id: string; entry_at: number }>;
    for (const row of rows) {
      if (row.target_id && Number.isSafeInteger(row.entry_at) && row.entry_at >= 0) anchors.set(row.target_id, row.entry_at);
    }
  }
  return anchors;
}

function loadNextGenerationCounts(
  db: Database.Database,
  relations: readonly DirectRelation[],
  anchors: ReadonlyMap<string, number>,
  start: number,
  effectiveEnd: number,
): Map<string, Map<string, number>> {
  const inviteeIds = unique(relations.map((relation) => relation.inviteeId));
  const childrenByInviter = new Map<string, Set<string>>();
  for (const chunk of chunks(inviteeIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT inviter_id, invitee_id, credited_at FROM invites
          WHERE inviter_id IN (${placeholders})
            AND credited_at >= ? AND credited_at < ?
          ORDER BY inviter_id, invitee_id`,
      )
      .all(...chunk, start, effectiveEnd) as Array<{ inviter_id: string; invitee_id: string; credited_at: number }>;
    for (const row of rows) {
      if (!row.inviter_id || !row.invitee_id || row.inviter_id === row.invitee_id) continue;
      const inviterEntryAt = anchors.get(row.inviter_id);
      if (inviterEntryAt === undefined || row.credited_at < inviterEntryAt) continue;
      const children = childrenByInviter.get(row.inviter_id) ?? new Set<string>();
      children.add(row.invitee_id);
      childrenByInviter.set(row.inviter_id, children);
    }
  }

  const result = new Map<string, Map<string, number>>();
  for (const relation of relations) {
    const children = childrenByInviter.get(relation.inviteeId) ?? new Set<string>();
    let count = 0;
    for (const childId of children) {
      // A→subjectはcycleでありnext generationではない。A→Aも上で除外済み。
      if (childId !== relation.subjectId) count += 1;
    }
    const byInvitee = result.get(relation.subjectId) ?? new Map<string, number>();
    byInvitee.set(relation.inviteeId, count);
    result.set(relation.subjectId, byInvitee);
  }
  return result;
}

function computeActivityDays(
  db: Database.Database,
  inviteeIds: readonly string[],
  anchors: ReadonlyMap<string, number>,
  window: { start: number; effectiveEnd: number; observedAt: number },
): Map<string, InviteRootedSafeActivityDay[]> {
  const tcByUserDay = new Map<string, Map<number, number>>();
  for (const chunk of chunks(inviteeIds)) {
    for (const result of computeTcSocialExchangeCandidates(
      db,
      { start: window.start, end: window.effectiveEnd, observedAt: window.observedAt },
      chunk,
    )) {
      const entryAt = anchors.get(result.userId);
      if (entryAt === undefined) continue;
      const byDay = new Map<number, number>();
      for (const candidate of result.candidates) {
        if (candidate.bestOtherGapMs === null || candidate.createdAtMs < entryAt * 1_000) continue;
        const offset = dayOffset(entryAt, Math.floor(candidate.createdAtMs / 1_000));
        if (offset < 1) continue;
        byDay.set(offset, Math.min(byDay.get(offset) ?? Number.POSITIVE_INFINITY, candidate.bestOtherGapMs));
      }
      tcByUserDay.set(result.userId, byDay);
    }
  }

  const vcByUserDay = new Map<string, Map<number, number>>();
  for (const chunk of chunks(inviteeIds)) {
    for (const result of computePublicSocialPresenceIntervals(
      db,
      { start: window.start, end: window.effectiveEnd, observedAt: window.observedAt },
      chunk,
    )) {
      const entryAt = anchors.get(result.userId);
      if (entryAt !== undefined) vcByUserDay.set(result.userId, splitSecondsByOffset(result.intervals, entryAt));
    }
  }

  const result = new Map<string, InviteRootedSafeActivityDay[]>();
  for (const inviteeId of inviteeIds) {
    const tc = tcByUserDay.get(inviteeId) ?? new Map<number, number>();
    const vc = vcByUserDay.get(inviteeId) ?? new Map<number, number>();
    const offsets = [...new Set([...tc.keys(), ...vc.keys()])].sort((a, b) => a - b);
    result.set(
      inviteeId,
      offsets.map((offset) => ({
        dayOffset: offset,
        tcBestOtherGapMs: tc.get(offset) ?? null,
        vcTrustedSocialSeconds: vc.get(offset) ?? 0,
      })),
    );
  }
  return result;
}

function loadTcMessages(
  db: Database.Database,
  userIds: readonly string[],
  window: { start: number; effectiveEnd: number; observedAt: number },
): Map<string, Map<string, number[]>> {
  const byUser = new Map<string, Map<string, number[]>>();
  for (const chunk of chunks(userIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT author_id, surface_id, created_at_ms FROM tc_message_observations
          WHERE author_id IN (${placeholders})
            AND created_at_ms >= ? AND created_at_ms < ? AND observed_at_ms < ?
          ORDER BY author_id, surface_id, created_at_ms, message_id`,
      )
      .all(...chunk, window.start * 1_000, window.effectiveEnd * 1_000, window.observedAt * 1_000) as TcMessageRow[];
    for (const row of rows) {
      const surfaces = byUser.get(row.author_id) ?? new Map<string, number[]>();
      const times = surfaces.get(row.surface_id) ?? [];
      times.push(row.created_at_ms);
      surfaces.set(row.surface_id, times);
      byUser.set(row.author_id, surfaces);
    }
  }
  return byUser;
}

function nearestPairGapsByOffset(
  left: readonly number[],
  right: readonly number[],
  entryAt: number,
  target: Map<number, number>,
): void {
  const scan = (own: readonly number[], other: readonly number[]): void => {
    let cursor = 0;
    for (const at of own) {
      while (cursor + 1 < other.length && other[cursor + 1]! <= at) cursor += 1;
      for (const candidate of [other[cursor], other[cursor + 1]]) {
        if (candidate === undefined) continue;
        const offset = dayOffset(entryAt, Math.floor(at / 1_000));
        if (at < entryAt * 1_000 || candidate < entryAt * 1_000 || offset < 1) continue;
        target.set(offset, Math.min(target.get(offset) ?? Number.POSITIVE_INFINITY, Math.abs(candidate - at)));
      }
    }
  };
  scan(left, right);
  scan(right, left);
}

function loadRestrictedPresence(
  db: Database.Database,
  userIds: readonly string[],
  window: { start: number; effectiveEnd: number },
): Map<string, Map<string, Interval[]>> {
  const byUser = new Map<string, Map<string, Interval[]>>();
  for (const chunk of chunks(userIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT user_id, guild_id, channel_id, started_at, ended_at, end_quality
           FROM vc_public_social_presence
          WHERE user_id IN (${placeholders}) AND started_at < ?
            AND (ended_at IS NULL OR ended_at > ?)
          ORDER BY user_id, guild_id, channel_id, started_at, id`,
      )
      .all(...chunk, window.effectiveEnd, window.start) as PresenceRow[];
    for (const row of rows) {
      const fence = getVcPublicSocialTrustFence(db, row.guild_id, row.channel_id);
      const persistedEnd = row.ended_at ?? Number.POSITIVE_INFINITY;
      const fencedEnd = Math.min(persistedEnd, fence ?? Number.POSITIVE_INFINITY);
      const endIsAfterSnapshot = fencedEnd > window.effectiveEnd;
      const hasObservedBoundary = row.end_quality === "observed" || (fence !== undefined && fence <= persistedEnd);
      if (!endIsAfterSnapshot && !hasObservedBoundary) continue;
      const interval = { start: Math.max(row.started_at, window.start), end: Math.min(fencedEnd, window.effectiveEnd) };
      if (interval.end <= interval.start) continue;
      const channels = byUser.get(row.user_id) ?? new Map<string, Interval[]>();
      const key = `${row.guild_id}\u0000${row.channel_id}`;
      const intervals = channels.get(key) ?? [];
      intervals.push(interval);
      channels.set(key, intervals);
      byUser.set(row.user_id, channels);
    }
  }
  for (const channels of byUser.values()) {
    for (const [key, intervals] of channels) channels.set(key, unionIntervals(intervals));
  }
  return byUser;
}

function computeReunionDays(
  db: Database.Database,
  relations: readonly DirectRelation[],
  anchors: ReadonlyMap<string, number>,
  window: { start: number; effectiveEnd: number; observedAt: number },
): Map<string, Map<string, InviteRootedSafeReunionDay[]>> {
  const participantIds = unique(relations.flatMap((relation) => [relation.subjectId, relation.inviteeId]));
  const tc = loadTcMessages(db, participantIds, window);
  const vc = loadRestrictedPresence(db, participantIds, window);
  const result = new Map<string, Map<string, InviteRootedSafeReunionDay[]>>();

  for (const relation of relations) {
    const entryAt = anchors.get(relation.inviteeId);
    if (entryAt === undefined) continue;
    const tcByOffset = new Map<number, number>();
    const subjectSurfaces = tc.get(relation.subjectId) ?? new Map<string, number[]>();
    const inviteeSurfaces = tc.get(relation.inviteeId) ?? new Map<string, number[]>();
    for (const [surfaceId, subjectTimes] of subjectSurfaces) {
      const inviteeTimes = inviteeSurfaces.get(surfaceId);
      if (inviteeTimes?.length) nearestPairGapsByOffset(subjectTimes, inviteeTimes, entryAt, tcByOffset);
    }

    const overlaps: Interval[] = [];
    const subjectChannels = vc.get(relation.subjectId) ?? new Map<string, Interval[]>();
    const inviteeChannels = vc.get(relation.inviteeId) ?? new Map<string, Interval[]>();
    for (const [channelKey, subjectIntervals] of subjectChannels) {
      const inviteeIntervals = inviteeChannels.get(channelKey);
      if (inviteeIntervals) overlaps.push(...intersectIntervals(subjectIntervals, inviteeIntervals));
    }
    const vcByOffset = splitSecondsByOffset(overlaps, entryAt);
    const offsets = [...new Set([...tcByOffset.keys(), ...vcByOffset.keys()])].sort((a, b) => a - b);
    const days = offsets.map((offset) => ({
      dayOffset: offset,
      tcBestPairGapMs: tcByOffset.get(offset) ?? null,
      vcTrustedPairSeconds: vcByOffset.get(offset) ?? 0,
    }));
    const byInvitee = result.get(relation.subjectId) ?? new Map<string, InviteRootedSafeReunionDay[]>();
    byInvitee.set(relation.inviteeId, days);
    result.set(relation.subjectId, byInvitee);
  }
  return result;
}

/**
 * confirmed invite graph・immutable ghosted event・canonical public TC/VCをinternal JOINし、
 * identity-freeなanonymous direct-branch profileへ畳む。membership/current soul stateは読まない。
 */
export function computeInviteRootedSafe(
  db: Database.Database,
  windowInput: InviteRootedSafeWindow,
  userIds: readonly string[],
): ReadonlyArray<{ readonly userId: string; readonly payload: InviteRootedSafePayload }> {
  const requested = unique(userIds);
  const window = requireWindow(windowInput);
  const empty = new Map(requested.map((userId) => [userId, { profiles: [], unknownEntryAnchorCount: 0 }]));
  if (requested.length === 0 || window.effectiveEnd <= window.start) {
    return requested.map((userId) => ({ userId, payload: empty.get(userId)! }));
  }

  const relations = loadDirectRelations(db, requested, window.start, window.effectiveEnd);
  const inviteeIds = unique(relations.map((relation) => relation.inviteeId));
  const anchors = loadEntryAnchors(db, inviteeIds, window.effectiveEnd);
  const activity = computeActivityDays(db, inviteeIds, anchors, window);
  const nextGeneration = loadNextGenerationCounts(db, relations, anchors, window.start, window.effectiveEnd);
  const reunions = computeReunionDays(db, relations, anchors, window);

  const profilesBySubject = new Map<string, InviteRootedSafeProfile[]>();
  const unknownBySubject = new Map<string, number>();
  for (const relation of relations) {
    if (!anchors.has(relation.inviteeId)) {
      unknownBySubject.set(relation.subjectId, (unknownBySubject.get(relation.subjectId) ?? 0) + 1);
      continue;
    }
    const profile: InviteRootedSafeProfile = {
      activityDays: activity.get(relation.inviteeId) ?? [],
      nextGenerationConfirmedCount: nextGeneration.get(relation.subjectId)?.get(relation.inviteeId) ?? 0,
      reunionDays: reunions.get(relation.subjectId)?.get(relation.inviteeId) ?? [],
    };
    const profiles = profilesBySubject.get(relation.subjectId) ?? [];
    profiles.push(profile);
    profilesBySubject.set(relation.subjectId, profiles);
  }

  return requested.map((userId) => {
    const profiles = (profilesBySubject.get(userId) ?? []).slice();
    profiles.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      userId,
      payload: { profiles, unknownEntryAnchorCount: unknownBySubject.get(userId) ?? 0 },
    };
  });
}
