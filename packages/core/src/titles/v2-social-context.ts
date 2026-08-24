import type Database from "better-sqlite3";
import {
  computeTrustedCoPresenceSlices,
  splitIntervalByJstDay,
  type TitleWindow,
  type TrustedCoPresenceSlice,
} from "../vc/derived.js";
import { loadTrustedRoleFamilyIntervals } from "../role-family/domain-temporal.js";

export interface SocialClassContextSafePayload {
  readonly counterparts: ReadonlyArray<{
    readonly classTouches: ReadonlyArray<{
      readonly classIndex: number;
      readonly days: ReadonlyArray<{ readonly date: string; readonly trustedSeconds: number }>;
    }>;
  }>;
}

export interface SocialDepartmentFamilyContextSafePayload {
  readonly counterparts: ReadonlyArray<{
    readonly familyTouches: ReadonlyArray<{
      readonly familyIndex: number;
      readonly days: ReadonlyArray<{ readonly date: string; readonly trustedSeconds: number }>;
    }>;
  }>;
}

export interface SocialClassContextSafeRow {
  readonly userId: string;
  readonly payload: SocialClassContextSafePayload;
}

export interface SocialDepartmentFamilyContextSafeRow {
  readonly userId: string;
  readonly payload: SocialDepartmentFamilyContextSafePayload;
}

interface KnownInterval {
  readonly category: string;
  readonly start: number;
  readonly end: number;
}

type TouchMap = Map<string, Map<string, Map<string, Map<string, number>>>>;
const PUBLIC_CLASSES = new Set(["ghost", "majin", "kenma", "mazoku", "meirei"]);
const ALL_STATUSES = new Set(["waiting", "ghost", "majin", "kenma", "mazoku", "meirei", "departed"]);
const HISTORY_PROVENANCE = new Set(["f3a_baseline", "soul_insert", "status_transition"]);

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function effectiveEnd(window: TitleWindow): number {
  const observedAt = window.observedAt ?? Math.floor(Date.now() / 1000);
  return Math.min(window.end, observedAt);
}

function classIntervals(
  db: Database.Database,
  end: number,
  relevantUsers: ReadonlySet<string>,
): Map<string, KnownInterval[]> {
  const rows = db.prepare(
    `SELECT id, user_id, status, observed_at, provenance
       FROM soul_status_history
      WHERE observed_at < ?
      ORDER BY user_id, observed_at, id`,
  ).all(end) as Array<{
    id: number;
    user_id: unknown;
    status: unknown;
    observed_at: unknown;
    provenance: unknown;
  }>;
  const grouped = new Map<string, typeof rows>();
  const corrupt = new Set<string>();
  for (const row of rows) {
    if (!nonEmpty(row.user_id) || !relevantUsers.has(row.user_id)) continue;
    if (!safeInteger(row.id) || !safeInteger(row.observed_at)
      || typeof row.status !== "string" || !ALL_STATUSES.has(row.status)
      || typeof row.provenance !== "string" || !HISTORY_PROVENANCE.has(row.provenance)) {
      corrupt.add(row.user_id);
      continue;
    }
    const list = grouped.get(row.user_id);
    if (list) list.push(row);
    else grouped.set(row.user_id, [row]);
  }
  const result = new Map<string, KnownInterval[]>();
  for (const [userId, userRows] of grouped) {
    if (corrupt.has(userId)) continue;
    const bySecond = new Map<number, typeof rows>();
    for (const row of userRows) {
      const at = row.observed_at as number;
      const list = bySecond.get(at);
      if (list) list.push(row);
      else bySecond.set(at, [row]);
    }
    const seconds = [...bySecond.keys()].sort((a, b) => a - b);
    const intervals: KnownInterval[] = [];
    for (let index = 0; index < seconds.length; index++) {
      const at = seconds[index]!;
      const sameSecond = bySecond.get(at)!;
      // Multiple transitions in one second have no provable final order. Do not use row id to guess.
      if (sameSecond.length !== 1) continue;
      const status = sameSecond[0]!.status as string;
      if (!PUBLIC_CLASSES.has(status)) continue;
      const start = at + 1;
      const intervalEnd = seconds[index + 1] ?? end;
      if (intervalEnd > start) intervals.push({ category: status, start, end: intervalEnd });
    }
    if (intervals.length > 0) result.set(userId, intervals);
  }
  return result;
}

function roleFamilyIntervals(
  db: Database.Database,
  end: number,
  relevantUsers: ReadonlySet<string>,
): Map<string, KnownInterval[]> {
  const result = new Map<string, KnownInterval[]>();
  for (const [userId, intervals] of loadTrustedRoleFamilyIntervals(
    db,
    [...relevantUsers],
    "public_department",
    { start: 0, end },
  )) {
    if (intervals.length > 0) {
      result.set(userId, intervals.map((interval) => ({
        category: interval.familyKey,
        start: interval.start,
        end: interval.end,
      })));
    }
  }
  return result;
}

function addTouch(
  touches: TouchMap,
  subject: string,
  counterpart: string,
  category: string,
  startedAt: number,
  endedAt: number,
): void {
  let counterpartMap = touches.get(subject);
  if (!counterpartMap) {
    counterpartMap = new Map();
    touches.set(subject, counterpartMap);
  }
  let categoryMap = counterpartMap.get(counterpart);
  if (!categoryMap) {
    categoryMap = new Map();
    counterpartMap.set(counterpart, categoryMap);
  }
  let days = categoryMap.get(category);
  if (!days) {
    days = new Map();
    categoryMap.set(category, days);
  }
  for (const part of splitIntervalByJstDay(startedAt, endedAt)) {
    days.set(part.date, (days.get(part.date) ?? 0) + part.seconds);
  }
}

function joinSlices(
  slices: readonly TrustedCoPresenceSlice[],
  requested: ReadonlySet<string>,
  intervalsByCounterpart: ReadonlyMap<string, readonly KnownInterval[]>,
): TouchMap {
  const touches: TouchMap = new Map();
  const joinOne = (subject: string, counterpart: string, slice: TrustedCoPresenceSlice) => {
    if (!requested.has(subject)) return;
    for (const interval of intervalsByCounterpart.get(counterpart) ?? []) {
      const start = Math.max(slice.startedAt, interval.start);
      const end = Math.min(slice.endedAt, interval.end);
      if (end > start) addTouch(touches, subject, counterpart, interval.category, start, end);
    }
  };
  for (const slice of slices) {
    joinOne(slice.userA, slice.userB, slice);
    joinOne(slice.userB, slice.userA, slice);
  }
  return touches;
}

function sourceSpecificOrder(source: string, value: string): number {
  let hash = 2166136261;
  for (const char of `${source}\u0000${value}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function classPayloads(touches: TouchMap): SocialClassContextSafeRow[] {
  const rows: SocialClassContextSafeRow[] = [];
  for (const [userId, counterparts] of touches) {
    const categories = [...new Set([...counterparts.values()].flatMap((map) => [...map.keys()]))].sort();
    const categoryIndex = new Map(categories.map((category, index) => [category, index]));
    const profiles = [...counterparts]
      .sort(([a], [b]) => sourceSpecificOrder("class", a) - sourceSpecificOrder("class", b) || a.localeCompare(b))
      .map(([, categoryMap]) => ({
        classTouches: [...categoryMap]
          .sort(([a], [b]) => categoryIndex.get(a)! - categoryIndex.get(b)!)
          .map(([category, days]) => ({
            classIndex: categoryIndex.get(category)!,
            days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, trustedSeconds]) => ({ date, trustedSeconds })),
          })),
      }));
    rows.push({ userId, payload: { counterparts: profiles } });
  }
  return rows;
}

function departmentPayloads(touches: TouchMap): SocialDepartmentFamilyContextSafeRow[] {
  const rows: SocialDepartmentFamilyContextSafeRow[] = [];
  for (const [userId, counterparts] of touches) {
    const categories = [...new Set([...counterparts.values()].flatMap((map) => [...map.keys()]))].sort();
    const categoryIndex = new Map(categories.map((category, index) => [category, index]));
    const profiles = [...counterparts]
      .sort(([a], [b]) => sourceSpecificOrder("department", a) - sourceSpecificOrder("department", b) || a.localeCompare(b))
      .map(([, categoryMap]) => ({
        familyTouches: [...categoryMap]
          .sort(([a], [b]) => categoryIndex.get(a)! - categoryIndex.get(b)!)
          .map(([category, days]) => ({
            familyIndex: categoryIndex.get(category)!,
            days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, trustedSeconds]) => ({ date, trustedSeconds })),
          })),
      }));
    rows.push({ userId, payload: { counterparts: profiles } });
  }
  return rows;
}

export function computeSocialClassContextSafe(
  db: Database.Database,
  window: TitleWindow,
  userIds: readonly string[],
): readonly SocialClassContextSafeRow[] {
  if (userIds.length === 0) return [];
  const end = effectiveEnd(window);
  if (end <= window.start) return [];
  const requested = new Set(userIds);
  const slices = computeTrustedCoPresenceSlices(db, { start: window.start, end, observedAt: end }, userIds);
  const counterparts = new Set(slices.flatMap((slice) => [slice.userA, slice.userB]));
  return classPayloads(joinSlices(slices, requested, classIntervals(db, end, counterparts)));
}

export function computeSocialDepartmentFamilyContextSafe(
  db: Database.Database,
  window: TitleWindow,
  userIds: readonly string[],
): readonly SocialDepartmentFamilyContextSafeRow[] {
  if (userIds.length === 0) return [];
  const end = effectiveEnd(window);
  if (end <= window.start) return [];
  const requested = new Set(userIds);
  const slices = computeTrustedCoPresenceSlices(db, { start: window.start, end, observedAt: end }, userIds);
  const counterparts = new Set(slices.flatMap((slice) => [slice.userA, slice.userB]));
  return departmentPayloads(joinSlices(slices, requested, roleFamilyIntervals(db, end, counterparts)));
}
