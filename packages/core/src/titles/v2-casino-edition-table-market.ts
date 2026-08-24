import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";
import {
  CASINO_EDITION_I_MANIFEST,
  casinoEditionIFamilyFor,
  type CasinoEditionIFamily,
} from "../casino/edition-i-manifest.js";
import { TITLE_ELIGIBLE_CASINO_TABLE_TYPES } from "../casino/takutate.js";
import { computeCasinoCompletedActivityDays } from "./v2-casino.js";

export interface CasinoEditionICompletionPayload {
  readonly editionKey: typeof CASINO_EDITION_I_MANIFEST.editionKey;
  readonly version: typeof CASINO_EDITION_I_MANIFEST.version;
  readonly completedFamilies: ReadonlyArray<{
    readonly familyKey: CasinoEditionIFamily;
    readonly completionDays: readonly string[];
  }>;
  readonly distinctCompletedFamilies: number;
  readonly allFamiliesCompleted: boolean;
}

export function computeCasinoEditionICompletionSafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): ReadonlyMap<string, CasinoEditionICompletionPayload> {
  const byUser = new Map<string, Map<CasinoEditionIFamily, Set<string>>>();
  for (const userId of userIds) byUser.set(userId, new Map());
  for (const fact of computeCasinoCompletedActivityDays(db, window, userIds)) {
    const family = casinoEditionIFamilyFor(fact.activityKey);
    if (!family) continue;
    const families = byUser.get(fact.userId)!;
    const days = families.get(family) ?? new Set<string>();
    days.add(fact.activityDate);
    families.set(family, days);
  }
  const result = new Map<string, CasinoEditionICompletionPayload>();
  for (const userId of userIds) {
    const families = byUser.get(userId)!;
    const completedFamilies = CASINO_EDITION_I_MANIFEST.families.flatMap(({ familyKey }) => {
      const days = families.get(familyKey);
      return days ? [{ familyKey, completionDays: [...days].sort() }] : [];
    });
    result.set(userId, {
      editionKey: CASINO_EDITION_I_MANIFEST.editionKey,
      version: CASINO_EDITION_I_MANIFEST.version,
      completedFamilies,
      distinctCompletedFamilies: completedFamilies.length,
      allFamiliesCompleted: completedFamilies.length === CASINO_EDITION_I_MANIFEST.families.length,
    });
  }
  return result;
}

export interface CasinoTableActivitySafePayload {
  readonly tables: ReadonlyArray<{
    readonly createdDate: string;
    readonly guestStays: ReadonlyArray<{
      readonly guestProfileIndex: number;
      readonly date: string;
      readonly trustedSeconds: number;
    }>;
  }>;
  readonly guests: ReadonlyArray<{
    readonly stays: ReadonlyArray<{
      readonly tableProfileIndex: number;
      readonly date: string;
      readonly trustedSeconds: number;
    }>;
  }>;
}

interface TableStayRow {
  owner_id: string;
  channel_id: string;
  guest_id: string;
  table_type: string;
  created_at: number;
  started_at: number;
  ended_at: number | null;
  end_quality: string | null;
  is_human: number;
}

const JST_OFFSET_SECONDS = 9 * 60 * 60;
function splitByJstDay(start: number, end: number): Array<{ date: string; seconds: number }> {
  const parts: Array<{ date: string; seconds: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const dayOrdinal = Math.floor((cursor + JST_OFFSET_SECONDS) / 86400);
    const nextDay = (dayOrdinal + 1) * 86400 - JST_OFFSET_SECONDS;
    const partEnd = Math.min(end, nextDay);
    parts.push({ date: jstDateStr(new Date(cursor * 1000)), seconds: partEnd - cursor });
    cursor = partEnd;
  }
  return parts;
}

/**
 * owner×卓×guest identityは内部相関にだけ使用し、array indexのanonymous profileへ落とす。
 * table instanceはscope前でもよいが、guest滞在秒は必ずwindowへclipする。
 */
export function computeCasinoTableActivitySafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  ownerIds: readonly string[],
): ReadonlyMap<string, CasinoTableActivitySafePayload> {
  const result = new Map<string, CasinoTableActivitySafePayload>();
  for (const userId of ownerIds) result.set(userId, { tables: [], guests: [] });
  if (ownerIds.length === 0 || window.end <= window.start) return result;
  const placeholders = ownerIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT i.owner_id, i.channel_id, i.table_type, i.created_at,
            p.user_id AS guest_id, p.started_at, p.ended_at, p.end_quality, p.is_human
       FROM casino_table_instances i JOIN casino_table_guest_presence p ON p.channel_id = i.channel_id
      WHERE i.owner_id IN (${placeholders}) AND i.created_at < ?
        AND p.started_at < ? AND (p.ended_at IS NULL OR p.ended_at > ?)
      ORDER BY i.owner_id, i.created_at, i.channel_id, p.started_at, p.user_id`,
  ).all(...ownerIds, window.end, window.end, window.start) as TableStayRow[];
  const eligible = new Set<string>(TITLE_ELIGIBLE_CASINO_TABLE_TYPES);
  for (const ownerId of ownerIds) {
    const ownerRows = rows.filter((r) => r.owner_id === ownerId && eligible.has(r.table_type));
    const tableIds = [...new Set(ownerRows.map((r) => r.channel_id))];
    const guestIds = [...new Set(ownerRows.filter((r) => r.guest_id !== ownerId).map((r) => r.guest_id))];
    const tableIndex = new Map(tableIds.map((id, index) => [id, index]));
    const guestIndex = new Map(guestIds.map((id, index) => [id, index]));
    const intervals = new Map<string, Array<{ start: number; end: number }>>();
    for (const row of ownerRows) {
      if (row.is_human !== 1 || row.guest_id.length === 0 || row.guest_id === ownerId) continue;
      if (!Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.started_at) || row.started_at < row.created_at) continue;
      if (row.ended_at !== null && !Number.isSafeInteger(row.ended_at)) continue;
      if (row.end_quality !== null && row.end_quality !== "observed" && row.end_quality !== "observation_ended") continue;
      const end = Math.min(row.ended_at ?? window.end, window.end);
      const start = Math.max(row.started_at, window.start);
      if (end <= start) continue;
      const key = `${tableIndex.get(row.channel_id)} ${guestIndex.get(row.guest_id)}`;
      const list = intervals.get(key) ?? [];
      list.push({ start, end });
      intervals.set(key, list);
    }
    // Dedicated writer does not split mute/deafen changes, but union again here so direct DB
    // corruption/overlap can never inflate trusted duration.
    const aggregates = new Map<string, number>();
    for (const [profileKey, slices] of intervals) {
      slices.sort((a, b) => a.start - b.start || a.end - b.end);
      const merged: Array<{ start: number; end: number }> = [];
      for (const slice of slices) {
        const last = merged.at(-1);
        if (last && slice.start <= last.end) last.end = Math.max(last.end, slice.end);
        else merged.push({ ...slice });
      }
      for (const slice of merged) {
        for (const part of splitByJstDay(slice.start, slice.end)) {
          const key = `${profileKey} ${part.date}`;
          aggregates.set(key, (aggregates.get(key) ?? 0) + part.seconds);
        }
      }
    }
    // Re-index after discarding empty/unknown-only tables so empty table creation never counts.
    const activeOldIndices = new Set([...aggregates.keys()].map((key) => Number(key.split(" ")[0])));
    const retainedOldIndices = tableIds.flatMap((_, i) => activeOldIndices.has(i) ? [i] : []);
    const remap = new Map(retainedOldIndices.map((old, index) => [old, index]));
    const activeOldGuestIndices = new Set([...aggregates.keys()].map((key) => Number(key.split(" ")[1])));
    const retainedOldGuestIndices = guestIds.flatMap((_, i) => activeOldGuestIndices.has(i) ? [i] : []);
    const guestRemap = new Map(retainedOldGuestIndices.map((old, index) => [old, index]));
    const normalizedTables = retainedOldIndices.map((old) => ({
      createdDate: jstDateStr(new Date(ownerRows.find((r) => r.channel_id === tableIds[old])!.created_at * 1000)),
      guestStays: [...aggregates].flatMap(([key, trustedSeconds]) => {
        const [table, guest, date] = key.split(" ");
        const mappedGuest = guestRemap.get(Number(guest));
        return Number(table) === old && mappedGuest !== undefined
          ? [{ guestProfileIndex: mappedGuest, date: date!, trustedSeconds }]
          : [];
      }),
    }));
    const guests = retainedOldGuestIndices.map((gi) => ({
      stays: [...aggregates].flatMap(([key, trustedSeconds]) => {
        const [table, guest, date] = key.split(" ");
        const mapped = remap.get(Number(table));
        return Number(guest) === gi && mapped !== undefined
          ? [{ tableProfileIndex: mapped, date: date!, trustedSeconds }]
          : [];
      }),
    }));
    result.set(ownerId, { tables: normalizedTables, guests });
  }
  return result;
}

export interface CasinoMarketActivitySafePayload {
  readonly days: ReadonlyArray<{ readonly date: string; readonly distinctOtherStandardBoards: number }>;
  readonly distinctOtherStandardBoards: number;
}

/** successful funded standard-board commitments only; amount/result/options/identity are discarded. */
export function computeCasinoMarketActivitySafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): ReadonlyMap<string, CasinoMarketActivitySafePayload> {
  const result = new Map<string, CasinoMarketActivitySafePayload>();
  for (const id of userIds) result.set(id, { days: [], distinctOtherStandardBoards: 0 });
  if (userIds.length === 0 || window.end <= window.start) return result;
  const placeholders = userIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT participant_id, market_id, market_creator_id, market_mode,
            market_created_at, market_deadline_at, occurred_at
       FROM casino_market_participation_history
      WHERE participant_id IN (${placeholders}) AND occurred_at >= ? AND occurred_at < ?
      ORDER BY participant_id, occurred_at, market_id`,
  ).all(...userIds, window.start, window.end) as Array<{
    participant_id: string; market_id: number; market_creator_id: string; market_mode: string;
    market_created_at: number; market_deadline_at: number; occurred_at: number;
  }>;
  for (const userId of userIds) {
    const valid = rows.filter((r) => r.participant_id === userId && r.market_mode === "standard" &&
      r.participant_id.trim().length > 0 && r.market_creator_id.trim().length > 0 && r.market_creator_id !== userId &&
      Number.isSafeInteger(r.market_id) && r.market_id > 0 &&
      Number.isSafeInteger(r.market_created_at) && Number.isSafeInteger(r.market_deadline_at) &&
      Number.isSafeInteger(r.occurred_at) && r.market_created_at < r.market_deadline_at &&
      r.market_created_at <= r.occurred_at && r.occurred_at < r.market_deadline_at);
    const boards = new Set(valid.map((r) => r.market_id));
    const byDay = new Map<string, Set<number>>();
    for (const row of valid) {
      const date = jstDateStr(new Date(row.occurred_at * 1000));
      const set = byDay.get(date) ?? new Set<number>();
      set.add(row.market_id);
      byDay.set(date, set);
    }
    result.set(userId, {
      days: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, ids]) =>
        ({ date, distinctOtherStandardBoards: ids.size })),
      distinctOtherStandardBoards: boards.size,
    });
  }
  return result;
}
