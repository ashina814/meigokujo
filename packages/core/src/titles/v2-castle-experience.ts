import type Database from "better-sqlite3";
import { computePublicRoomActivityEvidence } from "../rooms/derived.js";
import { computeTcConversationSafe } from "../tc-social/derived.js";
import { computePublicSocialPresenceChannelIntervals } from "../vc/public-social-derived.js";
import { splitIntervalByJstDay } from "../vc/derived.js";
import {
  CASTLE_EXPERIENCE_EDITION_I_MANIFEST,
  CASTLE_EXPERIENCE_SUPER_DOMAINS,
  defineCastleExperienceManifest,
  type CastleExperienceFamilyKey,
  type CastleExperienceSuperDomain,
} from "./v2-castle-experience-manifest.js";
import {
  computeCasinoEditionICompletionSafe,
  computeCasinoMarketActivitySafe,
  computeCasinoTableParticipationDaysSafe,
} from "./v2-casino-edition-table-market.js";
import { computeSafeEconomyPeerActions } from "./v2-economy.js";
import { computePublicEventCalendarInvolvementSafe } from "./v2-public-events.js";
import { computeShopPurchaseSafe } from "./v2-shop-purchases.js";

export interface CastleExperienceSafePayload {
  readonly editionKey: typeof CASTLE_EXPERIENCE_EDITION_I_MANIFEST.editionKey;
  readonly version: typeof CASTLE_EXPERIENCE_EDITION_I_MANIFEST.version;
  readonly families: ReadonlyArray<{
    readonly familyKey: CastleExperienceFamilyKey;
    readonly days: readonly string[];
    /** public_vcだけが持つthreshold-neutral wall-clock measure。他familyは空。 */
    readonly dailyTrustedSeconds: ReadonlyArray<{ readonly date: string; readonly trustedSeconds: number }>;
  }>;
  readonly coveredSuperDomains: readonly CastleExperienceSuperDomain[];
}

export interface CastleExperienceSafeRow {
  readonly userId: string;
  readonly payload: CastleExperienceSafePayload;
}

/** One bulk chunk invokes these nine canonical family/source adapters. */
export const CASTLE_EXPERIENCE_ADAPTER_READS_PER_CHUNK = 9;

const EDITION_I_ADAPTER_OWNERSHIP = Object.freeze({
  public_vc: "social",
  public_tc: "social",
  public_room: "social",
  economy: "economy_play",
  shop: "economy_play",
  casino: "economy_play",
  public_event: "castle_wide",
} as const satisfies Record<CastleExperienceFamilyKey, CastleExperienceSuperDomain>);

function assertEditionIManifest(): void {
  const manifest = defineCastleExperienceManifest(CASTLE_EXPERIENCE_EDITION_I_MANIFEST);
  const actual = new Map(manifest.families.map((family) => [family.familyKey, family.superDomain]));
  const expectedKeys = Object.keys(EDITION_I_ADAPTER_OWNERSHIP) as CastleExperienceFamilyKey[];
  if (actual.size !== expectedKeys.length) throw new Error("Edition-I manifest/adapter family count mismatch");
  for (const familyKey of expectedKeys) {
    if (actual.get(familyKey) !== EDITION_I_ADAPTER_OWNERSHIP[familyKey]) {
      throw new Error(`Edition-I manifest/adapter mismatch: ${familyKey}`);
    }
  }
}

function subtractIntervals(
  source: readonly { readonly channelId: string; readonly start: number; readonly end: number }[],
  ownedByRoom: readonly { readonly channelId: string; readonly start: number; readonly end: number }[],
): Array<{ start: number; end: number }> {
  let remaining = source.map((interval) => ({ ...interval }));
  for (const excluded of ownedByRoom) {
    const next: Array<{ channelId: string; start: number; end: number }> = [];
    for (const interval of remaining) {
      if (excluded.channelId !== interval.channelId || excluded.end <= interval.start || excluded.start >= interval.end) {
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

function activeRoomDays(activity: Awaited<ReturnType<typeof computePublicRoomActivityEvidence>>[number]["activity"]): string[] {
  return [...new Set([
    ...activity.hosted.days.map((day) => day.date),
    ...activity.guest.days.map((day) => day.date),
    ...activity.ownUse.days.map((day) => day.date),
  ])].sort();
}

/**
 * Edition-Iの7 domain adaptersを同じfixed snapshotで読み、family/dayだけへsanitizeする。
 * public-room visitor intervalとpublic-social VCが重なる秒はpublic_roomへ単一帰属させる。
 */
export function computeCastleExperienceSafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number; readonly observedAt?: number },
  userIds: readonly string[],
): readonly CastleExperienceSafeRow[] {
  assertEditionIManifest();
  const requested = [...new Set(userIds)];
  const effectiveEnd = Math.min(window.end, window.observedAt ?? window.end);
  const empty = (): CastleExperienceSafePayload => ({
    editionKey: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.editionKey,
    version: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.version,
    families: [],
    coveredSuperDomains: [],
  });
  if (requested.length === 0) return [];
  if (!Number.isSafeInteger(window.start) || !Number.isSafeInteger(effectiveEnd) || effectiveEnd <= window.start) {
    return requested.map((userId) => ({ userId, payload: empty() }));
  }
  const fixedWindow = { start: window.start, end: effectiveEnd, observedAt: effectiveEnd };
  const daysByUser = new Map<string, Map<CastleExperienceFamilyKey, Set<string>>>();
  const vcSecondsByUser = new Map<string, Map<string, number>>();
  for (const userId of requested) {
    daysByUser.set(userId, new Map());
    vcSecondsByUser.set(userId, new Map());
  }
  const addDay = (userId: string, familyKey: CastleExperienceFamilyKey, date: string) => {
    const families = daysByUser.get(userId);
    if (!families) return;
    const days = families.get(familyKey) ?? new Set<string>();
    days.add(date);
    families.set(familyKey, days);
  };

  // social/public room adapters. Exact room visitor intervals own overlapping physical VC seconds.
  const roomRows = computePublicRoomActivityEvidence(db, fixedWindow, requested);
  const roomByUser = new Map(roomRows.map((row) => [row.userId, row]));
  for (const row of roomRows) for (const date of activeRoomDays(row.activity)) addDay(row.userId, "public_room", date);
  for (const row of computePublicSocialPresenceChannelIntervals(db, fixedWindow, requested)) {
    const remainder = subtractIntervals(row.intervals, roomByUser.get(row.userId)?.visitorIntervals ?? []);
    const seconds = vcSecondsByUser.get(row.userId)!;
    for (const interval of remainder) {
      for (const part of splitIntervalByJstDay(interval.start, interval.end)) {
        if (part.seconds <= 0) continue;
        addDay(row.userId, "public_vc", part.date);
        seconds.set(part.date, (seconds.get(part.date) ?? 0) + part.seconds);
      }
    }
  }
  for (const row of computeTcConversationSafe(db, fixedWindow, requested)) {
    for (const day of row.payload.socialDays) addDay(row.userId, "public_tc", day.date);
  }

  // Economy owns only normal subject-initiated peer transfer/tip. Shop/casino never double-credit it.
  for (const fact of computeSafeEconomyPeerActions(db, fixedWindow, requested)) {
    addDay(fact.userId, "economy", fact.date);
  }
  for (const row of computeShopPurchaseSafe(db, fixedWindow, requested)) {
    for (const day of row.payload.days) addDay(row.userId, "shop", day.date);
  }

  // Casino is one experience family with three OR adapters, never three castle families.
  for (const [userId, payload] of computeCasinoEditionICompletionSafe(db, fixedWindow, requested)) {
    for (const family of payload.completedFamilies) {
      for (const date of family.completionDays) addDay(userId, "casino", date);
    }
  }
  for (const [userId, payload] of computeCasinoTableParticipationDaysSafe(db, fixedWindow, requested)) {
    for (const day of payload.days) addDay(userId, "casino", day.date);
  }
  for (const [userId, payload] of computeCasinoMarketActivitySafe(db, fixedWindow, requested)) {
    for (const day of payload.days) addDay(userId, "casino", day.date);
  }

  // Only canonical completed general-participant profiles count; staff/organizer alone never do.
  for (const row of computePublicEventCalendarInvolvementSafe(db, fixedWindow, requested)) {
    for (const event of row.payload.events) {
      if (event.generalParticipant) addDay(row.userId, "public_event", event.eventDate);
    }
  }

  return requested.map((userId) => {
    const days = daysByUser.get(userId)!;
    const families = CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families.flatMap((definition) => {
      const familyKey = definition.familyKey as CastleExperienceFamilyKey;
      const activeDays = days.get(familyKey);
      if (!activeDays || activeDays.size === 0) return [];
      const dailyTrustedSeconds = familyKey === "public_vc"
        ? [...vcSecondsByUser.get(userId)!]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, trustedSeconds]) => ({ date, trustedSeconds }))
        : [];
      return [{ familyKey, days: [...activeDays].sort(), dailyTrustedSeconds }];
    });
    const covered = new Set(families.map((family) => EDITION_I_ADAPTER_OWNERSHIP[family.familyKey]));
    return {
      userId,
      payload: {
        editionKey: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.editionKey,
        version: CASTLE_EXPERIENCE_EDITION_I_MANIFEST.version,
        families,
        coveredSuperDomains: CASTLE_EXPERIENCE_SUPER_DOMAINS.filter((domain) => covered.has(domain)),
      },
    };
  });
}
