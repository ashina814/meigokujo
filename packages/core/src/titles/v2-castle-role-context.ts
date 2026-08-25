import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";
import {
  loadTrustedEligiblePublicRoleContexts,
  type TrustedEligiblePublicRoleContext,
} from "../role-family/domain-temporal.js";
import { computePublicRoomActivityEvidence } from "../rooms/derived.js";
import { computeTcSocialExchangeCandidates } from "../tc-social/derived.js";
import { computePublicSocialPresenceChannelIntervals } from "../vc/public-social-derived.js";
import { splitIntervalByJstDay } from "../vc/derived.js";
import {
  CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST,
  CASTLE_ROLE_NORMAL_FAMILIES,
  type CastleRoleNormalFamilyKey,
} from "./v2-castle-role-domain-manifest.js";
import {
  computeCasinoTableParticipationEvidence,
  loadCasinoMarketParticipationEvidence,
} from "./v2-casino-edition-table-market.js";
import { loadCasinoCompletedActivityOccurrences } from "./v2-casino.js";
import { loadSafeEconomyPeerActionOccurrences } from "./v2-economy.js";
import { loadEligibleShopPurchaseFacts } from "./v2-shop-purchases.js";

export interface CastleRoleContextFamilyDay {
  readonly date: string;
  readonly trustedSeconds: number;
  readonly occurrenceCount: number;
}

export interface CastleRoleContextFamilyAggregate {
  readonly familyKey: CastleRoleNormalFamilyKey;
  readonly days: readonly CastleRoleContextFamilyDay[];
}

export interface CastleRoleContextSafePayload {
  readonly editionKey: typeof CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.editionKey;
  readonly version: typeof CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.version;
  readonly insideFamilies: readonly CastleRoleContextFamilyAggregate[];
  readonly outsideFamilies: readonly CastleRoleContextFamilyAggregate[];
  readonly roleHeldFamilies: readonly CastleRoleContextFamilyAggregate[];
  readonly outsideDays: readonly string[];
}

export interface CastleRoleContextSafeRow {
  readonly userId: string;
  readonly payload: CastleRoleContextSafePayload;
}

/** role + room + table + VC + TC + economy + shop + casino completion + casino market. */
export const CASTLE_ROLE_CONTEXT_ADAPTER_READS_PER_CHUNK = 9;

interface PointEvidence {
  readonly userId: string;
  readonly familyKey: CastleRoleNormalFamilyKey;
  readonly occurredAt: number;
}

interface IntervalEvidence {
  readonly userId: string;
  readonly familyKey: CastleRoleNormalFamilyKey;
  readonly start: number;
  readonly end: number;
}

type Classification = "inside" | "outside";

function subtractOwnedIntervals(
  source: readonly { readonly channelId: string; readonly start: number; readonly end: number }[],
  owned: readonly { readonly channelId: string; readonly start: number; readonly end: number }[],
): Array<{ start: number; end: number }> {
  let remaining = source.map((interval) => ({ ...interval }));
  for (const excluded of owned) {
    const next: typeof remaining = [];
    for (const interval of remaining) {
      if (interval.channelId !== excluded.channelId || excluded.end <= interval.start || excluded.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (interval.start < excluded.start) next.push({ ...interval, end: excluded.start });
      if (excluded.end < interval.end) next.push({ ...interval, start: excluded.end });
    }
    remaining = next;
  }
  const ordered = remaining.filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const union: Array<{ start: number; end: number }> = [];
  for (const interval of ordered) {
    const previous = union.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else union.push({ start: interval.start, end: interval.end });
  }
  return union;
}

function activeAssignment(
  contexts: readonly TrustedEligiblePublicRoleContext[],
  at: number,
): Set<string> | null {
  const active = contexts.filter((context) => context.start <= at && at < context.end);
  if (active.length === 0) return null;
  return new Set(active.flatMap((context) => context.assignedFamilies));
}

function classifyPoint(
  contexts: readonly TrustedEligiblePublicRoleContext[],
  familyKey: CastleRoleNormalFamilyKey,
  occurredAt: number,
): Classification | null {
  const assignment = activeAssignment(contexts, occurredAt);
  if (!assignment) return null;
  return assignment.has(familyKey) ? "inside" : "outside";
}

function classifyInterval(
  contexts: readonly TrustedEligiblePublicRoleContext[],
  evidence: IntervalEvidence,
): Array<{ classification: Classification; start: number; end: number }> {
  const boundaries = new Set([evidence.start, evidence.end]);
  for (const context of contexts) {
    if (evidence.start < context.start && context.start < evidence.end) boundaries.add(context.start);
    if (evidence.start < context.end && context.end < evidence.end) boundaries.add(context.end);
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const slices: Array<{ classification: Classification; start: number; end: number }> = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const start = ordered[index - 1]!;
    const end = ordered[index]!;
    if (end <= start) continue;
    const assignment = activeAssignment(contexts, start);
    if (!assignment) continue;
    slices.push({ classification: assignment.has(evidence.familyKey) ? "inside" : "outside", start, end });
  }
  return slices;
}

function unionIntervals(intervals: readonly { readonly start: number; readonly end: number }[]): Array<{ start: number; end: number }> {
  const ordered = intervals.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const union: Array<{ start: number; end: number }> = [];
  for (const interval of ordered) {
    if (interval.end <= interval.start) continue;
    const previous = union.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else union.push({ ...interval });
  }
  return union;
}

function emptyPayload(): CastleRoleContextSafePayload {
  return {
    editionKey: CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.editionKey,
    version: CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.version,
    insideFamilies: [], outsideFamilies: [], roleHeldFamilies: [], outsideDays: [],
  };
}

/** restricted exact activity × trusted role coverage first; identity-free JST aggregate second. */
export function computeCastleRoleContextSafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number; readonly observedAt?: number },
  userIds: readonly string[],
): readonly CastleRoleContextSafeRow[] {
  const requested = [...new Set(userIds)];
  if (requested.length === 0) return [];
  const effectiveEnd = Math.min(window.end, window.observedAt ?? window.end);
  if (!Number.isSafeInteger(window.start) || !Number.isSafeInteger(effectiveEnd) || effectiveEnd <= window.start) {
    return requested.map((userId) => ({ userId, payload: emptyPayload() }));
  }
  const fixedWindow = { start: window.start, end: effectiveEnd, observedAt: effectiveEnd };
  const contexts = loadTrustedEligiblePublicRoleContexts(
    db, requested, CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.assignments, fixedWindow,
  );

  const points: PointEvidence[] = [];
  const intervals: IntervalEvidence[] = [];
  const roomRows = computePublicRoomActivityEvidence(db, fixedWindow, requested);
  const roomByUser = new Map(roomRows.map((row) => [row.userId, row]));
  for (const row of roomRows) {
    for (const interval of row.visitorIntervals) intervals.push({ userId: row.userId, familyKey: "public_room", ...interval });
  }
  const tableByUser = computeCasinoTableParticipationEvidence(db, fixedWindow, requested);
  for (const [userId, table] of tableByUser) {
    for (const interval of table.guestIntervals) intervals.push({ userId, familyKey: "casino", ...interval });
  }
  for (const row of computePublicSocialPresenceChannelIntervals(db, fixedWindow, requested)) {
    const owned = [
      ...(roomByUser.get(row.userId)?.visitorIntervals ?? []),
      ...(tableByUser.get(row.userId)?.guestIntervals ?? []),
    ];
    for (const interval of subtractOwnedIntervals(row.intervals, owned)) {
      intervals.push({ userId: row.userId, familyKey: "public_vc", ...interval });
    }
  }
  for (const row of computeTcSocialExchangeCandidates(db, fixedWindow, requested)) {
    for (const candidate of row.candidates) {
      if (candidate.bestOtherGapMs !== null) {
        points.push({ userId: row.userId, familyKey: "public_tc", occurredAt: candidate.createdAtMs / 1_000 });
      }
    }
  }
  for (const fact of loadSafeEconomyPeerActionOccurrences(db, fixedWindow, requested)) {
    points.push({ userId: fact.userId, familyKey: "economy", occurredAt: fact.occurredAt });
  }
  for (const fact of loadEligibleShopPurchaseFacts(db, fixedWindow, requested)) {
    points.push({ userId: fact.userId, familyKey: "shop", occurredAt: fact.purchasedAt });
  }
  for (const fact of loadCasinoCompletedActivityOccurrences(db, fixedWindow, requested)) {
    points.push({ userId: fact.userId, familyKey: "casino", occurredAt: fact.completedAt });
  }
  for (const fact of loadCasinoMarketParticipationEvidence(db, fixedWindow, requested)) {
    points.push({ userId: fact.userId, familyKey: "casino", occurredAt: fact.occurredAt });
  }

  type Daily = { trustedSeconds: number; occurrenceCount: number };
  const aggregates = new Map<string, Map<Classification, Map<CastleRoleNormalFamilyKey, Map<string, Daily>>>>();
  const intervalBuckets = new Map<string, Map<Classification, Map<CastleRoleNormalFamilyKey, Array<{ start: number; end: number }>>>>();
  for (const userId of requested) {
    aggregates.set(userId, new Map());
    intervalBuckets.set(userId, new Map());
  }
  for (const point of points) {
    const classification = classifyPoint(contexts.get(point.userId) ?? [], point.familyKey, point.occurredAt);
    if (!classification) continue;
    const byClass = aggregates.get(point.userId)!;
    const byFamily = byClass.get(classification) ?? new Map();
    const byDate = byFamily.get(point.familyKey) ?? new Map();
    const date = jstDateStr(new Date(point.occurredAt * 1_000));
    const daily = byDate.get(date) ?? { trustedSeconds: 0, occurrenceCount: 0 };
    daily.occurrenceCount += 1;
    byDate.set(date, daily); byFamily.set(point.familyKey, byDate); byClass.set(classification, byFamily);
  }
  for (const interval of intervals) {
    for (const slice of classifyInterval(contexts.get(interval.userId) ?? [], interval)) {
      const byClass = intervalBuckets.get(interval.userId)!;
      const byFamily = byClass.get(slice.classification) ?? new Map();
      const list = byFamily.get(interval.familyKey) ?? [];
      list.push({ start: slice.start, end: slice.end });
      byFamily.set(interval.familyKey, list); byClass.set(slice.classification, byFamily);
    }
  }
  for (const [userId, byClass] of intervalBuckets) {
    for (const [classification, byFamily] of byClass) {
      for (const [familyKey, raw] of byFamily) {
        const targetByClass = aggregates.get(userId)!;
        const targetByFamily = targetByClass.get(classification) ?? new Map();
        const targetByDate = targetByFamily.get(familyKey) ?? new Map();
        for (const interval of unionIntervals(raw)) {
          for (const part of splitIntervalByJstDay(interval.start, interval.end)) {
            const daily = targetByDate.get(part.date) ?? { trustedSeconds: 0, occurrenceCount: 0 };
            daily.trustedSeconds += part.seconds;
            targetByDate.set(part.date, daily);
          }
        }
        targetByFamily.set(familyKey, targetByDate); targetByClass.set(classification, targetByFamily);
      }
    }
  }

  const serialize = (byFamily: Map<CastleRoleNormalFamilyKey, Map<string, Daily>> | undefined) =>
    CASTLE_ROLE_NORMAL_FAMILIES.flatMap((familyKey) => {
      const days = byFamily?.get(familyKey);
      if (!days || days.size === 0) return [];
      return [{
        familyKey,
        days: [...days].sort(([a], [b]) => a.localeCompare(b))
          .map(([date, daily]) => ({ date, ...daily })),
      }];
    });

  return requested.map((userId) => {
    const byClass = aggregates.get(userId)!;
    const insideFamilies = serialize(byClass.get("inside"));
    const outsideFamilies = serialize(byClass.get("outside"));
    const combined = new Map<CastleRoleNormalFamilyKey, Map<string, Daily>>();
    for (const family of [...insideFamilies, ...outsideFamilies]) {
      const byDate = combined.get(family.familyKey) ?? new Map();
      for (const day of family.days) {
        const daily = byDate.get(day.date) ?? { trustedSeconds: 0, occurrenceCount: 0 };
        daily.trustedSeconds += day.trustedSeconds;
        daily.occurrenceCount += day.occurrenceCount;
        byDate.set(day.date, daily);
      }
      combined.set(family.familyKey, byDate);
    }
    return {
      userId,
      payload: {
        editionKey: CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.editionKey,
        version: CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.version,
        insideFamilies,
        outsideFamilies,
        roleHeldFamilies: serialize(combined),
        outsideDays: [...new Set(outsideFamilies.flatMap((family) => family.days.map((day) => day.date)))].sort(),
      },
    };
  });
}
