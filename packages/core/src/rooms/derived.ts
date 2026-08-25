import type Database from "better-sqlite3";
import {
  computeLogicalVisits,
  computeLogicalVisitsForChannels,
  isTrustedVisitEnd,
  splitIntervalByJstDay,
  type TitleWindow,
} from "../vc/derived.js";

const QUERY_CHUNK_SIZE = 300;
const PUBLIC_ROOM_KINDS = ["normal", "game"] as const;

interface RoomSourceRow {
  id: number;
  kind: string;
  channel_id: string;
  owner_id: string;
  expires_at: number | null;
  activated_at: number | null;
  closed_at: number | null;
  created_at: number;
}

interface RoomInterval extends RoomSourceRow {
  start: number;
  end: number;
}

interface ActivitySlice {
  roomId: number;
  channelId: string;
  ownerId: string;
  visitorId: string;
  start: number;
  end: number;
}

export interface PublicRoomActivitySafeAggregate {
  readonly userId: string;
  readonly hosted: {
    readonly distinctGuests: number;
    readonly sessionCount: number;
    readonly maxConcurrentGuests: number;
    readonly maxRepeatGuestDepth: number;
    readonly days: ReadonlyArray<{ readonly date: string; readonly distinctGuests: number; readonly sessionsWithGuests: number }>;
  };
  readonly guest: {
    readonly distinctOwners: number;
    readonly sessionCount: number;
    readonly days: ReadonlyArray<{ readonly date: string; readonly distinctOwners: number; readonly sessionsVisited: number }>;
  };
  readonly ownUse: {
    readonly sessionCount: number;
    readonly days: ReadonlyArray<{ readonly date: string; readonly sessionsUsed: number }>;
  };
}

/**
 * Castle composition向けrestricted companion。safe aggregateと同じclassifier passから、
 * subject自身がvisitorだったexact intervalsだけを返す。channel identityはrestrictedな
 * cross-source ownership JOINだけに使い、safe aggregateへは返さない。
 */
export interface PublicRoomActivityEvidence {
  readonly userId: string;
  readonly activity: Omit<PublicRoomActivitySafeAggregate, "userId">;
  readonly visitorIntervals: ReadonlyArray<{
    readonly channelId: string;
    readonly start: number;
    readonly end: number;
  }>;
}

type MutableDay = { ids: Set<string>; sessions: Set<number> };

interface MutableAggregate {
  hostedGuests: Set<string>;
  hostedSessions: Set<number>;
  hostedDays: Map<string, MutableDay>;
  repeatGuestDaySessions: Map<string, Map<string, Set<number>>>;
  guestOwners: Set<string>;
  guestSessions: Set<number>;
  guestDays: Map<string, MutableDay>;
  ownSessions: Set<number>;
  ownDays: Map<string, Set<number>>;
}

function emptyMutable(): MutableAggregate {
  return {
    hostedGuests: new Set(),
    hostedSessions: new Set(),
    hostedDays: new Map(),
    repeatGuestDaySessions: new Map(),
    guestOwners: new Set(),
    guestSessions: new Set(),
    guestDays: new Map(),
    ownSessions: new Set(),
    ownDays: new Map(),
  };
}

function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_CHUNK_SIZE) {
    result.push(values.slice(index, index + QUERY_CHUNK_SIZE));
  }
  return result;
}

function loadCandidateRooms(
  db: Database.Database,
  windowEnd: number,
  ownerIds: readonly string[] | undefined,
  visitedChannelIds: readonly string[],
): RoomSourceRow[] {
  const rows = new Map<number, RoomSourceRow>();
  const select = (predicate: string, params: readonly unknown[]) => {
    const found = db
      .prepare(
        `SELECT id, kind, channel_id, owner_id, expires_at, activated_at, closed_at, created_at
           FROM rooms
          WHERE kind IN ('normal', 'game') AND created_at < ? AND ${predicate}`,
      )
      .all(windowEnd, ...params) as RoomSourceRow[];
    for (const row of found) rows.set(row.id, row);
  };

  if (ownerIds === undefined) {
    select("1 = 1", []);
  } else {
    for (const chunk of chunks([...new Set(ownerIds)])) {
      select(`owner_id IN (${chunk.map(() => "?").join(",")})`, chunk);
    }
    // owner lookupで見つけたchannelも再度channel lookupする。legacy/corrupt DBで同じ
    // channelへ別ownerのoverlap sessionがあれば、片方だけを見て誤帰属しないため。
    const relevantChannels = [...new Set([...visitedChannelIds, ...[...rows.values()].map((row) => row.channel_id)])];
    for (const chunk of chunks(relevantChannels)) {
      select(`channel_id IN (${chunk.map(() => "?").join(",")})`, chunk);
    }
  }
  return [...rows.values()];
}

function effectiveRoomIntervals(rows: readonly RoomSourceRow[], window: TitleWindow, effectiveEnd: number): RoomInterval[] {
  const intervals: RoomInterval[] = [];
  for (const row of rows) {
    if (!PUBLIC_ROOM_KINDS.includes(row.kind as (typeof PUBLIC_ROOM_KINDS)[number])) continue;
    const start = Math.max(window.start, row.created_at);
    let end = effectiveEnd;
    // closed_atがsnapshotより未来なら、そのsnapshotではまだopenだったものとして無視する。
    if (row.closed_at !== null && row.closed_at <= effectiveEnd) end = Math.min(end, row.closed_at);
    // gameの購入済み利用可能時間はcleanupの遅延にかかわらずexpires_atで終わる。
    if (row.kind === "game" && row.expires_at !== null) end = Math.min(end, row.expires_at);
    if (end > start) intervals.push({ ...row, start, end });
  }
  return intervals;
}

function ambiguousRangesByChannel(rooms: readonly RoomInterval[]): Map<string, Array<{ start: number; end: number }>> {
  const byChannel = new Map<string, RoomInterval[]>();
  for (const room of rooms) {
    const list = byChannel.get(room.channel_id);
    if (list) list.push(room);
    else byChannel.set(room.channel_id, [room]);
  }
  const result = new Map<string, Array<{ start: number; end: number }>>();
  for (const [channelId, channelRooms] of byChannel) {
    const deltas = new Map<number, number>();
    for (const room of channelRooms) {
      deltas.set(room.start, (deltas.get(room.start) ?? 0) + 1);
      deltas.set(room.end, (deltas.get(room.end) ?? 0) - 1);
    }
    const times = [...deltas.keys()].sort((a, b) => a - b);
    const ranges: Array<{ start: number; end: number }> = [];
    let active = 0;
    let previous: number | null = null;
    for (const time of times) {
      if (previous !== null && previous < time && active > 1) ranges.push({ start: previous, end: time });
      active += deltas.get(time)!;
      previous = time;
    }
    if (ranges.length > 0) result.set(channelId, ranges);
  }
  return result;
}

function subtractRanges(
  start: number,
  end: number,
  excluded: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> {
  let parts = [{ start, end }];
  for (const range of excluded) {
    const next: Array<{ start: number; end: number }> = [];
    for (const part of parts) {
      if (range.end <= part.start || range.start >= part.end) {
        next.push(part);
        continue;
      }
      if (part.start < range.start) next.push({ start: part.start, end: range.start });
      if (range.end < part.end) next.push({ start: range.end, end: part.end });
    }
    parts = next;
  }
  return parts.filter((part) => part.end > part.start);
}

function activitySlices(db: Database.Database, window: TitleWindow, rooms: readonly RoomInterval[]): ActivitySlice[] {
  const byChannel = new Map<string, RoomInterval[]>();
  for (const room of rooms) {
    const list = byChannel.get(room.channel_id);
    if (list) list.push(room);
    else byChannel.set(room.channel_id, [room]);
  }
  const ambiguous = ambiguousRangesByChannel(rooms);
  const visits = computeLogicalVisitsForChannels(db, window, [...byChannel.keys()]);
  const slices: ActivitySlice[] = [];
  for (const visit of visits) {
    if (!isTrustedVisitEnd(visit.endQuality) || visit.endedAt <= visit.startedAt) continue;
    for (const room of byChannel.get(visit.channelId) ?? []) {
      const start = Math.max(visit.startedAt, room.start);
      const end = Math.min(visit.endedAt, room.end);
      if (end <= start) continue;
      for (const part of subtractRanges(start, end, ambiguous.get(visit.channelId) ?? [])) {
        slices.push({
          roomId: room.id,
          channelId: room.channel_id,
          ownerId: room.owner_id,
          visitorId: visit.userId,
          ...part,
        });
      }
    }
  }
  return slices;
}

function addSetValue<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function addDay(map: Map<string, MutableDay>, date: string, id: string, session: number): void {
  const day = map.get(date);
  if (day) {
    day.ids.add(id);
    day.sessions.add(session);
  } else {
    map.set(date, { ids: new Set([id]), sessions: new Set([session]) });
  }
}

function addGuestDaySession(
  map: Map<string, Map<string, Set<number>>>,
  guestId: string,
  date: string,
  sessionId: number,
): void {
  let daySessions = map.get(guestId);
  if (!daySessions) {
    daySessions = new Map();
    map.set(guestId, daySessions);
  }
  addSetValue(daySessions, date, sessionId);
}

/**
 * 日付とroom sessionの二部グラフに対するmaximum matching size。
 * 各未match日からalternating pathを幅優先探索し、見つけた増加路を反転する。
 */
function maximumDaySessionMatchingSize(daySessions: ReadonlyMap<string, ReadonlySet<number>>): number {
  const matchedSessionByDate = new Map<string, number>();
  const matchedDateBySession = new Map<number, string>();

  for (const startDate of [...daySessions.keys()].sort()) {
    if (matchedSessionByDate.has(startDate)) continue;

    const queue = [startDate];
    const visitedDates = new Set([startDate]);
    const precedingDateBySession = new Map<number, string>();
    let freeSession: number | undefined;

    for (let cursor = 0; cursor < queue.length && freeSession === undefined; cursor += 1) {
      const date = queue[cursor]!;
      const sessions = [...(daySessions.get(date) ?? [])].sort((a, b) => a - b);
      for (const sessionId of sessions) {
        if (precedingDateBySession.has(sessionId)) continue;
        precedingDateBySession.set(sessionId, date);
        const matchedDate = matchedDateBySession.get(sessionId);
        if (matchedDate === undefined) {
          freeSession = sessionId;
          break;
        }
        if (!visitedDates.has(matchedDate)) {
          visitedDates.add(matchedDate);
          queue.push(matchedDate);
        }
      }
    }

    if (freeSession === undefined) continue;
    let sessionToAssign: number | undefined = freeSession;
    while (sessionToAssign !== undefined) {
      const date = precedingDateBySession.get(sessionToAssign)!;
      const previouslyMatchedSession = matchedSessionByDate.get(date);
      matchedSessionByDate.set(date, sessionToAssign);
      matchedDateBySession.set(sessionToAssign, date);
      sessionToAssign = previouslyMatchedSession;
    }
  }

  return matchedSessionByDate.size;
}

function maxConcurrentGuestsByOwner(slices: readonly ActivitySlice[]): Map<string, number> {
  const bySession = new Map<number, ActivitySlice[]>();
  for (const slice of slices) {
    if (slice.visitorId === slice.ownerId) continue;
    const list = bySession.get(slice.roomId);
    if (list) list.push(slice);
    else bySession.set(slice.roomId, [slice]);
  }
  const result = new Map<string, number>();
  for (const sessionSlices of bySession.values()) {
    const events = sessionSlices.flatMap((slice) => [
      { at: slice.start, kind: 1 as const, userId: slice.visitorId },
      { at: slice.end, kind: -1 as const, userId: slice.visitorId },
    ]);
    events.sort((a, b) => a.at - b.at || a.kind - b.kind); // 同時刻はend(-1)を先に処理。
    const activeDepth = new Map<string, number>();
    let concurrent = 0;
    let maximum = 0;
    for (const event of events) {
      const before = activeDepth.get(event.userId) ?? 0;
      const after = before + event.kind;
      if (before === 0 && after > 0) concurrent += 1;
      if (before > 0 && after === 0) concurrent -= 1;
      if (after === 0) activeDepth.delete(event.userId);
      else activeDepth.set(event.userId, after);
      maximum = Math.max(maximum, concurrent);
    }
    const ownerId = sessionSlices[0]!.ownerId;
    result.set(ownerId, Math.max(result.get(ownerId) ?? 0, maximum));
  }
  return result;
}

/** safe aggregateとcastle overlap ownership用intervalを同じcanonical passから作る。 */
export function computePublicRoomActivityEvidence(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): PublicRoomActivityEvidence[] {
  if (userIds && userIds.length === 0) return [];
  if (!Number.isInteger(window.start) || !Number.isInteger(window.end) || window.start >= window.end) {
    throw new RangeError(`invalid title window: [${window.start}, ${window.end})`);
  }
  const observedAt = window.observedAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(observedAt)) throw new RangeError("invalid title window: observedAt must be an integer unix timestamp");
  const effectiveEnd = Math.min(window.end, observedAt);
  const requested = userIds ? [...new Set(userIds)] : undefined;
  const subjectVisits = requested === undefined ? [] : computeLogicalVisits(db, { ...window, observedAt }, requested);
  const roomRows = loadCandidateRooms(
    db,
    effectiveEnd,
    requested,
    subjectVisits.map((visit) => visit.channelId),
  );
  const rooms = effectiveRoomIntervals(roomRows, window, effectiveEnd);
  const slices = activitySlices(db, { ...window, observedAt }, rooms);
  const targetIds = requested ?? [...new Set(slices.flatMap((slice) => [slice.ownerId, slice.visitorId]))];
  const targetSet = new Set(targetIds);
  const mutable = new Map(targetIds.map((userId) => [userId, emptyMutable()]));

  for (const slice of slices) {
    const dates = splitIntervalByJstDay(slice.start, slice.end).map((part) => part.date);
    if (slice.visitorId === slice.ownerId) {
      if (!targetSet.has(slice.ownerId)) continue;
      const state = mutable.get(slice.ownerId)!;
      state.ownSessions.add(slice.roomId);
      for (const date of dates) {
        const sessions = state.ownDays.get(date);
        if (sessions) sessions.add(slice.roomId);
        else state.ownDays.set(date, new Set([slice.roomId]));
      }
      continue;
    }
    if (targetSet.has(slice.ownerId)) {
      const state = mutable.get(slice.ownerId)!;
      state.hostedGuests.add(slice.visitorId);
      state.hostedSessions.add(slice.roomId);
      for (const date of dates) {
        addDay(state.hostedDays, date, slice.visitorId, slice.roomId);
        addGuestDaySession(state.repeatGuestDaySessions, slice.visitorId, date, slice.roomId);
      }
    }
    if (targetSet.has(slice.visitorId)) {
      const state = mutable.get(slice.visitorId)!;
      state.guestOwners.add(slice.ownerId);
      state.guestSessions.add(slice.roomId);
      for (const date of dates) addDay(state.guestDays, date, slice.ownerId, slice.roomId);
    }
  }

  const concurrency = maxConcurrentGuestsByOwner(slices);
  return targetIds.map((userId) => {
    const state = mutable.get(userId)!;
    let maxRepeatGuestDepth = 0;
    for (const guestId of state.hostedGuests) {
      maxRepeatGuestDepth = Math.max(
        maxRepeatGuestDepth,
        maximumDaySessionMatchingSize(state.repeatGuestDaySessions.get(guestId) ?? new Map()),
      );
    }
    const rawVisitorIntervals = slices
      .filter((slice) => slice.visitorId === userId)
      .map((slice) => ({ channelId: slice.channelId, start: slice.start, end: slice.end }))
      .sort((a, b) => a.channelId.localeCompare(b.channelId) || a.start - b.start || a.end - b.end);
    const visitorIntervals: Array<{ channelId: string; start: number; end: number }> = [];
    for (const interval of rawVisitorIntervals) {
      const previous = visitorIntervals.at(-1);
      if (previous && previous.channelId === interval.channelId && interval.start <= previous.end) {
        previous.end = Math.max(previous.end, interval.end);
      }
      else visitorIntervals.push({ ...interval });
    }
    return {
      userId,
      activity: {
        hosted: {
          distinctGuests: state.hostedGuests.size,
          sessionCount: state.hostedSessions.size,
          maxConcurrentGuests: concurrency.get(userId) ?? 0,
          maxRepeatGuestDepth,
          days: [...state.hostedDays]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, day]) => ({ date, distinctGuests: day.ids.size, sessionsWithGuests: day.sessions.size })),
        },
        guest: {
          distinctOwners: state.guestOwners.size,
          sessionCount: state.guestSessions.size,
          days: [...state.guestDays]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, day]) => ({ date, distinctOwners: day.ids.size, sessionsVisited: day.sessions.size })),
        },
        ownUse: {
          sessionCount: state.ownSessions.size,
          days: [...state.ownDays]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, sessions]) => ({ date, sessionsUsed: sessions.size })),
        },
      },
      visitorIntervals,
    };
  });
}

/**
 * 公開normal/game部屋の実利用を、identityを含まない本人単位aggregateへ畳み込む。
 * ownerの在室やrooms.activated_atは前提にせず、trusted positive logical visitだけを使う。
 */
export function computePublicRoomActivitySafe(
  db: Database.Database,
  window: TitleWindow,
  userIds?: readonly string[],
): PublicRoomActivitySafeAggregate[] {
  return computePublicRoomActivityEvidence(db, window, userIds).map(({ userId, activity }) => ({
    userId,
    ...activity,
  }));
}
