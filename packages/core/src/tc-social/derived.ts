import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";
import { TC_SURFACE_KINDS, type TcSurfaceKind } from "./service.js";

const SQL_CHUNK_SIZE = 300;

export interface TcConversationSafePayload {
  readonly starts: ReadonlyArray<{
    readonly date: string;
    readonly quietBeforeMs: number | null;
    readonly nextOtherGapMs: number | null;
    readonly explicitContinuation: boolean;
  }>;
  readonly revivalConversations: ReadonlyArray<{
    readonly revivals: ReadonlyArray<{
      readonly date: string;
      readonly dormantBeforeMs: number;
      readonly continuationGapMs: number | null;
    }>;
  }>;
  readonly areas: ReadonlyArray<{
    readonly socialDays: ReadonlyArray<{ readonly date: string; readonly bestOtherGapMs: number | null }>;
  }>;
  readonly thirdPartyJoins: ReadonlyArray<{
    readonly date: string;
    readonly priorDistinctOtherGapMs: readonly number[];
    readonly priorSelfGapMs: number | null;
    readonly nextOtherGapMs: number | null;
  }>;
  readonly startedConversations: ReadonlyArray<{
    readonly startDate: string;
    readonly distinctOtherParticipants: number;
    readonly activeDates: readonly string[];
    readonly spanMs: number;
    readonly maxInterActivityGapMs: number;
  }>;
  /** 別humanとの交換が少なくとも1つ観測された日。gap thresholdは後段で決める。 */
  readonly socialDays: ReadonlyArray<{ readonly date: string; readonly bestOtherGapMs: number }>;
}

export interface TcReactionSafePayload {
  readonly distinctReactors: number;
  readonly posts: ReadonlyArray<{
    readonly reactionDays: readonly string[];
    readonly distinctReactors: number;
  }>;
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly distinctPosts: number;
    readonly distinctReactors: number;
  }>;
}

export interface TcSafeWindow {
  readonly start: number;
  readonly end: number;
  readonly observedAt?: number;
}

interface MessageRow {
  messageId: string;
  authorId: string;
  surfaceId: string;
  areaId: string;
  surfaceKind: TcSurfaceKind;
  replyToMessageId: string | null;
  createdAtMs: number;
  observedAtMs: number;
  threadOwnerId: string | null;
  threadCreatedAtMs: number | null;
}

interface RawMessageRow {
  message_id: unknown;
  author_id: unknown;
  surface_id: unknown;
  area_id: unknown;
  surface_kind: unknown;
  reply_to_message_id: unknown;
  created_at_ms: unknown;
  observed_at_ms: unknown;
  thread_owner_id: unknown;
  thread_created_at_ms: unknown;
}

const EMPTY_CONVERSATION: TcConversationSafePayload = {
  starts: [],
  revivalConversations: [],
  areas: [],
  thirdPartyJoins: [],
  startedConversations: [],
  socialDays: [],
};
const EMPTY_REACTION: TcReactionSafePayload = { distinctReactors: 0, posts: [], days: [] };

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += SQL_CHUNK_SIZE) {
    result.push(values.slice(index, index + SQL_CHUNK_SIZE));
  }
  return result;
}

function requireWindow(window: TcSafeWindow): { startMs: number; endMs: number; observedCutoffMs: number } {
  if (!Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end) || window.start >= window.end) {
    throw new RangeError(`invalid TC title window: [${window.start}, ${window.end})`);
  }
  const observedAt = window.observedAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(observedAt)) throw new RangeError("observedAt must be a safe integer unix second");
  const effectiveEnd = Math.min(window.end, observedAt);
  return {
    startMs: safeSecondsToMs(window.start),
    endMs: safeSecondsToMs(effectiveEnd),
    observedCutoffMs: safeSecondsToMs(observedAt),
  };
}

function safeSecondsToMs(seconds: number): number {
  const value = seconds * 1000;
  if (!Number.isSafeInteger(value)) throw new RangeError(`unix second is outside safe millisecond range: ${seconds}`);
  return value;
}

function normalizeMessageRow(row: RawMessageRow): MessageRow | null {
  if (
    typeof row.message_id !== "string" ||
    !row.message_id ||
    typeof row.author_id !== "string" ||
    !row.author_id ||
    typeof row.surface_id !== "string" ||
    !row.surface_id ||
    typeof row.area_id !== "string" ||
    !row.area_id ||
    typeof row.surface_kind !== "string" ||
    !TC_SURFACE_KINDS.includes(row.surface_kind as TcSurfaceKind) ||
    !Number.isSafeInteger(row.created_at_ms) ||
    (row.created_at_ms as number) < 0 ||
    !Number.isSafeInteger(row.observed_at_ms) ||
    (row.observed_at_ms as number) < 0
  ) {
    return null;
  }
  if (row.reply_to_message_id !== null && (typeof row.reply_to_message_id !== "string" || !row.reply_to_message_id)) {
    return null;
  }
  if (row.thread_owner_id !== null && (typeof row.thread_owner_id !== "string" || !row.thread_owner_id)) return null;
  if (
    row.thread_created_at_ms !== null &&
    (!Number.isSafeInteger(row.thread_created_at_ms) || (row.thread_created_at_ms as number) < 0)
  ) {
    return null;
  }
  return {
    messageId: row.message_id,
    authorId: row.author_id,
    surfaceId: row.surface_id,
    areaId: row.area_id,
    surfaceKind: row.surface_kind as TcSurfaceKind,
    replyToMessageId: row.reply_to_message_id as string | null,
    createdAtMs: row.created_at_ms as number,
    observedAtMs: row.observed_at_ms as number,
    threadOwnerId: row.thread_owner_id as string | null,
    threadCreatedAtMs: row.thread_created_at_ms as number | null,
  };
}

function rowOrder(a: MessageRow, b: MessageRow): number {
  return a.createdAtMs - b.createdAtMs || a.messageId.localeCompare(b.messageId);
}

function selectColumns(): string {
  return `message_id, author_id, surface_id, area_id, surface_kind, reply_to_message_id,
          created_at_ms, observed_at_ms, thread_owner_id, thread_created_at_ms`;
}

function loadSubjectRows(
  db: Database.Database,
  userIds: readonly string[],
  startMs: number,
  endMs: number,
  observedCutoffMs: number,
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const chunk of chunks(userIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const raw = db
      .prepare(
        `SELECT ${selectColumns()} FROM tc_message_observations
          WHERE author_id IN (${placeholders})
            AND created_at_ms >= ? AND created_at_ms < ? AND observed_at_ms < ?
          ORDER BY created_at_ms ASC, message_id ASC`,
      )
      .all(...chunk, startMs, endMs, observedCutoffMs) as RawMessageRow[];
    for (const item of raw) {
      const row = normalizeMessageRow(item);
      if (row) rows.push(row);
    }
  }
  return rows.sort(rowOrder);
}

function loadAreaContext(
  db: Database.Database,
  areaIds: readonly string[],
  startMs: number,
  endMs: number,
  observedCutoffMs: number,
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const chunk of chunks(areaIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const raw = db
      .prepare(
        `SELECT ${selectColumns()} FROM tc_message_observations
          WHERE area_id IN (${placeholders})
            AND created_at_ms >= ? AND created_at_ms < ? AND observed_at_ms < ?
          ORDER BY created_at_ms ASC, message_id ASC`,
      )
      .all(...chunk, startMs, endMs, observedCutoffMs) as RawMessageRow[];
    for (const item of raw) {
      const row = normalizeMessageRow(item);
      if (row) rows.push(row);
    }
  }
  return rows.sort(rowOrder);
}

function groupRows(rows: readonly MessageRow[], key: (row: MessageRow) => string): Map<string, MessageRow[]> {
  const result = new Map<string, MessageRow[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const list = result.get(groupKey);
    if (list) list.push(row);
    else result.set(groupKey, [row]);
  }
  return result;
}

function explicitConversationKeys(rows: readonly MessageRow[]): {
  readonly keyByMessageId: ReadonlyMap<string, string | null>;
  readonly groups: ReadonlyMap<string, readonly MessageRow[]>;
} {
  const byId = new Map(rows.map((row) => [row.messageId, row]));
  const keyByMessageId = new Map<string, string | null>();

  const resolve = (row: MessageRow): string | null => {
    if (row.surfaceKind !== "channel") return `thread:${row.surfaceId}`;
    if (row.replyToMessageId === null) return null;
    const path: MessageRow[] = [];
    const seen = new Set<string>();
    let current = row;
    let result: string | null = null;
    while (true) {
      if (current.replyToMessageId === null) {
        // root自身はgroupへ入れず、reply descendantだけをこのrootへ結び付ける。
        result = current.messageId === row.messageId ? null : `reply:${current.messageId}`;
        break;
      }
      const cached = keyByMessageId.get(current.messageId);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      if (seen.has(current.messageId)) {
        result = null;
        break;
      }
      seen.add(current.messageId);
      path.push(current);
      const parent = byId.get(current.replyToMessageId);
      if (!parent || parent.surfaceKind !== "channel" || parent.surfaceId !== row.surfaceId) {
        result = null;
        break;
      }
      current = parent;
    }
    for (const item of path) keyByMessageId.set(item.messageId, result);
    return result;
  };

  const mutableGroups = new Map<string, MessageRow[]>();
  for (const row of rows) {
    const key = resolve(row);
    keyByMessageId.set(row.messageId, key);
    if (key === null) continue;
    const list = mutableGroups.get(key);
    if (list) list.push(row);
    else mutableGroups.set(key, [row]);
  }
  for (const [key, list] of mutableGroups) {
    if (!key.startsWith("reply:")) continue;
    const root = byId.get(key.slice("reply:".length));
    if (root && !list.some((row) => row.messageId === root.messageId)) list.push(root);
  }
  for (const list of mutableGroups.values()) list.sort(rowOrder);
  return { keyByMessageId, groups: mutableGroups };
}

function dateFor(ms: number): string {
  return jstDateStr(new Date(ms));
}

function nextOtherGaps(rows: readonly MessageRow[], authorId: string): ReadonlyMap<string, number | null> {
  const result = new Map<string, number | null>();
  let nextOtherAt: number | null = null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    result.set(row.messageId, nextOtherAt === null ? null : nextOtherAt - row.createdAtMs);
    if (row.authorId !== authorId) nextOtherAt = row.createdAtMs;
  }
  return result;
}

function nearestOtherGapByMessage(
  ownRows: readonly MessageRow[],
  allRows: readonly MessageRow[],
  subjectId: string,
): ReadonlyMap<string, number | null> {
  const result = new Map<string, number | null>();
  const others = allRows.filter((row) => row.authorId !== subjectId);
  let cursor = 0;
  for (const own of ownRows) {
    while (cursor + 1 < others.length && others[cursor + 1]!.createdAtMs <= own.createdAtMs) cursor += 1;
    let best: number | null = null;
    for (const candidate of [others[cursor], others[cursor + 1]]) {
      if (!candidate) continue;
      const gap = Math.abs(candidate.createdAtMs - own.createdAtMs);
      best = best === null ? gap : Math.min(best, gap);
    }
    result.set(own.messageId, best);
  }
  return result;
}

interface JoinFact {
  readonly priorDistinctOtherGapMs: readonly number[];
  readonly priorSelfGapMs: number | null;
  readonly nextOtherGapMs: number | null;
}

function joinFactsForPool(rows: readonly MessageRow[], subjectId: string): ReadonlyMap<string, JoinFact> {
  const result = new Map<string, JoinFact>();
  const nextGaps = nextOtherGaps(rows, subjectId);
  let latestSelf: number | null = null;
  const recentOthers: Array<{ authorId: string; at: number }> = [];
  for (const row of rows) {
    if (row.authorId === subjectId) {
      const gaps = recentOthers
        .map((value) => row.createdAtMs - value.at)
        .sort((a, b) => a - b);
      result.set(row.messageId, {
        priorDistinctOtherGapMs: gaps,
        priorSelfGapMs: latestSelf === null ? null : row.createdAtMs - latestSelf,
        nextOtherGapMs: nextGaps.get(row.messageId) ?? null,
      });
      latestSelf = row.createdAtMs;
      continue;
    }
    const existing = recentOthers.findIndex((value) => value.authorId === row.authorId);
    if (existing >= 0) recentOthers.splice(existing, 1);
    recentOthers.unshift({ authorId: row.authorId, at: row.createdAtMs });
    if (recentOthers.length > 2) recentOthers.pop();
  }
  return result;
}

function buildConversationPayload(
  subjectId: string,
  subjectRows: readonly MessageRow[],
  contextRows: readonly MessageRow[],
  startMs: number,
): TcConversationSafePayload {
  if (subjectRows.length === 0) return EMPTY_CONVERSATION;
  const surfaces = groupRows(contextRows, (row) => row.surfaceId);
  const areas = groupRows(contextRows, (row) => row.areaId);
  const explicit = explicitConversationKeys(contextRows);
  const indexes = new Map<readonly MessageRow[], ReadonlyMap<string, number>>();
  const nextGapCache = new Map<readonly MessageRow[], ReadonlyMap<string, number | null>>();
  const joinCache = new Map<readonly MessageRow[], ReadonlyMap<string, JoinFact>>();
  const indexFor = (rows: readonly MessageRow[], messageId: string): number => {
    let map = indexes.get(rows);
    if (!map) {
      map = new Map(rows.map((candidate, index) => [candidate.messageId, index]));
      indexes.set(rows, map);
    }
    return map.get(messageId) ?? -1;
  };
  const nextGapFor = (rows: readonly MessageRow[], messageId: string): number | null => {
    let map = nextGapCache.get(rows);
    if (!map) {
      map = nextOtherGaps(rows, subjectId);
      nextGapCache.set(rows, map);
    }
    return map.get(messageId) ?? null;
  };
  const joinFactFor = (rows: readonly MessageRow[], messageId: string): JoinFact => {
    let map = joinCache.get(rows);
    if (!map) {
      map = joinFactsForPool(rows, subjectId);
      joinCache.set(rows, map);
    }
    return map.get(messageId) ?? {
      priorDistinctOtherGapMs: [],
      priorSelfGapMs: null,
      nextOtherGapMs: null,
    };
  };

  const starts = subjectRows
    .filter((row) => row.replyToMessageId === null)
    .map((row) => {
      const surfaceRows = surfaces.get(row.surfaceId) ?? [];
      const index = indexFor(surfaceRows, row.messageId);
      const prior = index > 0 ? surfaceRows[index - 1]! : null;
      const conversationKey =
        row.surfaceKind === "channel"
          ? explicit.groups.has(`reply:${row.messageId}`)
            ? `reply:${row.messageId}`
            : null
          : `thread:${row.surfaceId}`;
      const conversationRows = conversationKey ? explicit.groups.get(conversationKey) ?? [] : [];
      const explicitContinuation = conversationRows.some(
        (candidate) => candidate.createdAtMs > row.createdAtMs && candidate.authorId !== subjectId,
      );
      return {
        date: dateFor(row.createdAtMs),
        quietBeforeMs: prior ? row.createdAtMs - prior.createdAtMs : null,
        nextOtherGapMs: index >= 0 ? nextGapFor(surfaceRows, row.messageId) : null,
        explicitContinuation,
      };
    });

  const revivalConversations: Array<{
    sortAt: number;
    revivals: Array<{ date: string; dormantBeforeMs: number; continuationGapMs: number | null }>;
  }> = [];
  for (const rows of explicit.groups.values()) {
    const revivals: Array<{ date: string; dormantBeforeMs: number; continuationGapMs: number | null }> = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.authorId !== subjectId) continue;
      revivals.push({
        date: dateFor(row.createdAtMs),
        dormantBeforeMs: row.createdAtMs - rows[index - 1]!.createdAtMs,
        continuationGapMs: nextGapFor(rows, row.messageId),
      });
    }
    if (revivals.length > 0) revivalConversations.push({ sortAt: rows[0]!.createdAtMs, revivals });
  }
  revivalConversations.sort((a, b) => a.sortAt - b.sortAt);

  const areaPayloads: Array<{
    sortAt: number;
    socialDays: Array<{ date: string; bestOtherGapMs: number | null }>;
  }> = [];
  const subjectByArea = groupRows(subjectRows, (row) => row.areaId);
  for (const [areaId, ownRows] of subjectByArea) {
    const allRows = areas.get(areaId) ?? [];
    const nearestByMessage = nearestOtherGapByMessage(ownRows, allRows, subjectId);
    const bestByDate = new Map<string, number | null>();
    for (const own of ownRows) {
      const best = nearestByMessage.get(own.messageId) ?? null;
      const date = dateFor(own.createdAtMs);
      const existing = bestByDate.get(date);
      if (existing === undefined || (best !== null && (existing === null || best < existing))) bestByDate.set(date, best);
    }
    areaPayloads.push({
      sortAt: ownRows[0]!.createdAtMs,
      socialDays: [...bestByDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, bestOtherGapMs]) => ({ date, bestOtherGapMs })),
    });
  }
  areaPayloads.sort((a, b) => a.sortAt - b.sortAt);

  const globalSocial = new Map<string, number>();
  for (const area of areaPayloads) {
    for (const day of area.socialDays) {
      if (day.bestOtherGapMs === null) continue;
      globalSocial.set(day.date, Math.min(globalSocial.get(day.date) ?? Number.POSITIVE_INFINITY, day.bestOtherGapMs));
    }
  }

  const thirdPartyJoins = subjectRows.map((row) => {
    const key = explicit.keyByMessageId.get(row.messageId) ?? null;
    const rootKey = row.replyToMessageId === null && explicit.groups.has(`reply:${row.messageId}`) ? `reply:${row.messageId}` : null;
    const pool = (key ?? rootKey) ? explicit.groups.get((key ?? rootKey)!) ?? [] : surfaces.get(row.surfaceId) ?? [];
    const fact = joinFactFor(pool, row.messageId);
    return {
      date: dateFor(row.createdAtMs),
      ...fact,
    };
  });

  const startedConversations: Array<{
    sortAt: number;
    startDate: string;
    distinctOtherParticipants: number;
    activeDates: string[];
    spanMs: number;
    maxInterActivityGapMs: number;
  }> = [];
  for (const [key, rows] of explicit.groups) {
    let starterId: string | null = null;
    let startedAt: number | null = null;
    if (key.startsWith("reply:")) {
      const root = rows.find((row) => row.messageId === key.slice("reply:".length));
      if (root) {
        starterId = root.authorId;
        startedAt = root.createdAtMs;
      }
    } else {
      const owners = new Set(rows.map((row) => row.threadOwnerId).filter((value): value is string => value !== null));
      const created = new Set(rows.map((row) => row.threadCreatedAtMs).filter((value): value is number => value !== null));
      if (owners.size === 1 && created.size === 1) {
        starterId = [...owners][0]!;
        startedAt = [...created][0]!;
      }
    }
    if (starterId !== subjectId || startedAt === null || startedAt < startMs) continue;
    const timestamps = [...new Set([startedAt, ...rows.map((row) => row.createdAtMs)])].sort((a, b) => a - b);
    const otherParticipants = new Set(rows.filter((row) => row.authorId !== subjectId).map((row) => row.authorId));
    let maxInterActivityGapMs = 0;
    for (let index = 1; index < timestamps.length; index += 1) {
      maxInterActivityGapMs = Math.max(maxInterActivityGapMs, timestamps[index]! - timestamps[index - 1]!);
    }
    startedConversations.push({
      sortAt: startedAt,
      startDate: dateFor(startedAt),
      distinctOtherParticipants: otherParticipants.size,
      activeDates: [...new Set(timestamps.map(dateFor))].sort(),
      spanMs: timestamps[timestamps.length - 1]! - startedAt,
      maxInterActivityGapMs,
    });
  }
  startedConversations.sort((a, b) => a.sortAt - b.sortAt);

  return {
    starts,
    revivalConversations: revivalConversations.map(({ revivals }) => ({ revivals })),
    areas: areaPayloads.map(({ socialDays }) => ({ socialDays })),
    thirdPartyJoins,
    startedConversations: startedConversations.map(({ sortAt: _sortAt, ...value }) => value),
    socialDays: [...globalSocial].sort(([a], [b]) => a.localeCompare(b)).map(([date, bestOtherGapMs]) => ({ date, bestOtherGapMs })),
  };
}

/** restricted message identityをinternal graphだけで使い、identity-freeな会話統計へ畳む。 */
export function computeTcConversationSafe(
  db: Database.Database,
  window: TcSafeWindow,
  userIds?: readonly string[],
): ReadonlyArray<{ readonly userId: string; readonly payload: TcConversationSafePayload }> {
  const { startMs, endMs, observedCutoffMs } = requireWindow(window);
  const requested = userIds ? [...new Set(userIds)] : undefined;
  if (requested && requested.length === 0) return [];
  if (endMs <= startMs) return (requested ?? []).map((userId) => ({ userId, payload: EMPTY_CONVERSATION }));
  const targetIds =
    requested ??
    (db
      .prepare(
        `SELECT DISTINCT author_id FROM tc_message_observations
          WHERE created_at_ms >= ? AND created_at_ms < ? AND observed_at_ms < ?
          ORDER BY author_id`,
      )
      .all(startMs, endMs, observedCutoffMs) as Array<{ author_id: string }>).map((row) => row.author_id);
  const subjectRows = loadSubjectRows(db, targetIds, startMs, endMs, observedCutoffMs);
  const areaIds = [...new Set(subjectRows.map((row) => row.areaId))];
  const contextRows = loadAreaContext(db, areaIds, startMs, endMs, observedCutoffMs);
  const bySubject = groupRows(subjectRows, (row) => row.authorId);
  return targetIds.map((userId) => ({
    userId,
    payload: buildConversationPayload(userId, bySubject.get(userId) ?? [], contextRows, startMs),
  }));
}

interface ReactionRow {
  author_id: string;
  message_id: string;
  reactor_id: string;
  observed_at_ms: number;
}

/** reaction occurrenceを捏造せず、first observationのJST dayでanonymous post/day分布へ畳む。 */
export function computeTcReactionSafe(
  db: Database.Database,
  window: TcSafeWindow,
  userIds?: readonly string[],
): ReadonlyArray<{ readonly userId: string; readonly payload: TcReactionSafePayload }> {
  const { startMs, endMs, observedCutoffMs } = requireWindow(window);
  const requested = userIds ? [...new Set(userIds)] : undefined;
  if (requested && requested.length === 0) return [];
  const targetIds =
    requested ??
    (db
      .prepare(
        `SELECT DISTINCT m.author_id
           FROM tc_message_observations m
           JOIN tc_reaction_observations r ON r.message_id = m.message_id
          WHERE r.observed_at_ms >= ? AND r.observed_at_ms < ? AND r.observed_at_ms < ?
            AND m.observed_at_ms < ? AND r.reactor_id <> m.author_id
          ORDER BY m.author_id`,
      )
      .all(startMs, endMs, observedCutoffMs, observedCutoffMs) as Array<{ author_id: string }>).map((row) => row.author_id);
  const byUser = new Map<string, ReactionRow[]>();
  for (const chunk of chunks(targetIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT m.author_id, m.message_id, r.reactor_id, r.observed_at_ms
           FROM tc_message_observations m
           JOIN tc_reaction_observations r ON r.message_id = m.message_id
          WHERE m.author_id IN (${placeholders})
            AND r.observed_at_ms >= ? AND r.observed_at_ms < ? AND r.observed_at_ms < ?
            AND m.observed_at_ms < ? AND m.created_at_ms < ? AND r.reactor_id <> m.author_id
          ORDER BY m.author_id ASC, r.observed_at_ms ASC, m.message_id ASC, r.reactor_id ASC`,
      )
      .all(...chunk, startMs, endMs, observedCutoffMs, observedCutoffMs, endMs) as ReactionRow[];
    for (const row of rows) {
      if (
        !row.author_id ||
        !row.message_id ||
        !row.reactor_id ||
        !Number.isSafeInteger(row.observed_at_ms) ||
        row.observed_at_ms < 0
      ) {
        continue;
      }
      const list = byUser.get(row.author_id);
      if (list) list.push(row);
      else byUser.set(row.author_id, [row]);
    }
  }

  return targetIds.map((userId) => {
    const rows = byUser.get(userId) ?? [];
    if (rows.length === 0) return { userId, payload: EMPTY_REACTION };
    const reactors = new Set(rows.map((row) => row.reactor_id));
    const byPost = groupReactionRows(rows, (row) => row.message_id);
    const posts = [...byPost.values()].map((postRows) => ({
      reactionDays: [...new Set(postRows.map((row) => dateFor(row.observed_at_ms)))].sort(),
      distinctReactors: new Set(postRows.map((row) => row.reactor_id)).size,
    }));
    const byDay = groupReactionRows(rows, (row) => dateFor(row.observed_at_ms));
    const days = [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayRows]) => ({
        date,
        distinctPosts: new Set(dayRows.map((row) => row.message_id)).size,
        distinctReactors: new Set(dayRows.map((row) => row.reactor_id)).size,
      }));
    return { userId, payload: { distinctReactors: reactors.size, posts, days } };
  });
}

function groupReactionRows(rows: readonly ReactionRow[], key: (row: ReactionRow) => string): Map<string, ReactionRow[]> {
  const result = new Map<string, ReactionRow[]>();
  for (const row of rows) {
    const value = key(row);
    const list = result.get(value);
    if (list) list.push(row);
    else result.set(value, [row]);
  }
  return result;
}
