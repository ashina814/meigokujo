import type Database from "better-sqlite3";
import {
  computeTcSocialExchangeCandidates,
  type TcSafeWindow,
} from "../tc-social/derived.js";
import {
  computeTrustedSocialPresenceIntervals,
  splitIntervalByJstHour,
} from "../vc/derived.js";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface SocialActivityTimeSafePayload {
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly hours: ReadonlyArray<{
      readonly hour: number;
      readonly tcBestOtherGapMs: number | null;
      readonly vcTrustedSocialSeconds: number;
    }>;
  }>;
}

export interface SocialActivityTimeSafeResult {
  readonly userId: string;
  readonly payload: SocialActivityTimeSafePayload;
}

interface MutableHour {
  tcBestOtherGapMs: number | null;
  vcTrustedSocialSeconds: number;
}

function jstDateHour(createdAtMs: number): { date: string; hour: number } {
  const iso = new Date(createdAtMs + JST_OFFSET_MS).toISOString();
  return { date: iso.slice(0, 10), hour: Number(iso.slice(11, 13)) };
}

function ensureHour(
  days: Map<string, Map<number, MutableHour>>,
  date: string,
  hour: number,
): MutableHour {
  let hours = days.get(date);
  if (!hours) {
    hours = new Map();
    days.set(date, hours);
  }
  let value = hours.get(hour);
  if (!value) {
    value = { tcBestOtherGapMs: null, vcTrustedSocialSeconds: 0 };
    hours.set(hour, value);
  }
  return value;
}

function buildPayload(days: ReadonlyMap<string, ReadonlyMap<number, MutableHour>>): SocialActivityTimeSafePayload {
  return {
    days: [...days]
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .map(([date, hours]) => ({
        date,
        hours: [...hours]
          .sort(([hourA], [hourB]) => hourA - hourB)
          .map(([hour, value]) => ({
            hour,
            tcBestOtherGapMs: value.tcBestOtherGapMs,
            vcTrustedSocialSeconds: value.vcTrustedSocialSeconds,
          })),
      })),
  };
}

/**
 * canonical public TC exchange候補とtrusted VC social-presence wall-clock unionを、
 * privacy-safeなJST date×24-hour sparse distributionへ統合する。
 * daypart/gap/meaningful-seconds/share/concentration/streak thresholdは一切決めない。
 */
export function computeSocialActivityTimeSafe(
  db: Database.Database,
  window: TcSafeWindow,
  userIds?: readonly string[],
): readonly SocialActivityTimeSafeResult[] {
  const requested = userIds ? [...new Set(userIds)] : undefined;
  if (requested && requested.length === 0) return [];

  const tcRows = computeTcSocialExchangeCandidates(db, window, requested);
  const vcRows = computeTrustedSocialPresenceIntervals(db, window, requested);
  const targetIds = requested ?? [...new Set([...tcRows.map((row) => row.userId), ...vcRows.map((row) => row.userId)])].sort();
  const daysByUser = new Map<string, Map<string, Map<number, MutableHour>>>();
  for (const userId of targetIds) daysByUser.set(userId, new Map());

  for (const row of tcRows) {
    const days = daysByUser.get(row.userId);
    if (!days) continue;
    for (const candidate of row.candidates) {
      if (candidate.bestOtherGapMs === null) continue;
      const { date, hour } = jstDateHour(candidate.createdAtMs);
      const value = ensureHour(days, date, hour);
      value.tcBestOtherGapMs =
        value.tcBestOtherGapMs === null
          ? candidate.bestOtherGapMs
          : Math.min(value.tcBestOtherGapMs, candidate.bestOtherGapMs);
    }
  }

  for (const row of vcRows) {
    const days = daysByUser.get(row.userId);
    if (!days) continue;
    for (const interval of row.intervals) {
      for (const part of splitIntervalByJstHour(interval.start, interval.end)) {
        if (part.seconds <= 0) continue;
        const value = ensureHour(days, part.date, part.hour);
        value.vcTrustedSocialSeconds += part.seconds;
        if (value.vcTrustedSocialSeconds > 3600) {
          throw new Error(`trusted social presence exceeded one JST hour for ${part.date} hour ${part.hour}`);
        }
      }
    }
  }

  return targetIds.map((userId) => ({ userId, payload: buildPayload(daysByUser.get(userId) ?? new Map()) }));
}
