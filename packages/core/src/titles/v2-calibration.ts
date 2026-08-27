import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { OccupancyBucket } from "../vc/derived.js";
import { resolvePlanningCalibrationScope, resolvedScopeEffectiveEnd } from "./v2-scope.js";
import {
  getFromTitleSourceCache,
  prefetchIntoTitleSourceCache,
  TitleSourceCache,
  type BumpEventsSourcePayload,
  type CasinoActivityDaysSourcePayload,
  type CasinoCompletedActivityDaysSourcePayload,
  type CasinoEditionICompletionSafeSourcePayload,
  type CasinoMarketActivitySafeSourcePayload,
  type CasinoTableActivitySafeSourcePayload,
  type CastleExperienceSafeSourcePayload,
  type CastleRoleContextSafeSourcePayload,
  type ConfirmedInvitesSourcePayload,
  type EconomySafePeerActionsSourcePayload,
  type EconomySemanticSafeSourcePayload,
  type InviteRootedSafeSourcePayload,
  type PublicEventCalendarInvolvementSafeSourcePayload,
  type PublicEventCompletedParticipationsSourcePayload,
  type PublicRoomActivitySafeSourcePayload,
  type ShopPurchaseSafeSourcePayload,
  type ShopRolePurchaseSafeSourcePayload,
  type SocialClassContextSafeSourcePayload,
  type SocialDepartmentFamilyContextSafeSourcePayload,
  type SocialActivityTimeSafeSourcePayload,
  type TcConversationSafeSourcePayload,
  type TcReactionSafeSourcePayload,
  type TitleSourcePayloads,
  type VcEmptyStartThenJoinedSourcePayload,
  type VcGroupSizeDailySafeSourcePayload,
  type VcLastOccupantSourcePayload,
  type VcSocialSafeSourcePayload,
} from "./v2-sources.js";
import { TITLE_V2_CATALOG_CANDIDATES, canonicalCatalogHash } from "./v2-catalog-candidates.js";
import {
  TITLE_V2_CATALOG_READINESS,
  type CandidateReadinessAudit,
} from "./v2-catalog-readiness.js";
import type { TitleUsableSourceKey } from "./v2-contract.js";

/** Planning/operator analysis only. Never import this module from evaluator, pipeline, Bot, or public v2 barrel. */
export const CALIBRATION_SCHEMA_VERSION = 1 as const;
export const CALIBRATION_PERCENTILE_METHOD = "nearest-rank" as const;

const VC_BUCKETS = ["solo", "oneToOne", "smallGroup", "largeGroup"] as const satisfies readonly OccupancyBucket[];
const SOCIAL_BUCKETS = ["oneToOne", "smallGroup", "largeGroup"] as const satisfies readonly OccupancyBucket[];
const ECONOMY_FAMILY_ORDER = ["peer_transfer", "tip", "shop"] as const;
const CASINO_EDITION_I_FAMILY_ORDER = ["slots", "chohan", "crash", "chinchiro", "roulette", "blackjack", "poker", "holdem"] as const;
const CASTLE_FAMILY_ORDER = ["public_vc", "public_tc", "public_room", "economy", "shop", "casino", "public_event"] as const;
const CASTLE_ROLE_FAMILY_ORDER = CASTLE_FAMILY_ORDER.filter((family) => family !== "public_event");

export type CalibrationProbeKey =
  | "vc-style-v1"
  | "activity-time-v1"
  | "vc-ignite-v1"
  | "vc-closer-v1"
  | "social-breadth-v1"
  | "relationship-depth-v1"
  | "social-class-context-v1"
  | "social-department-context-v1"
  | "bump-contribution-v1"
  | "tc-conversation-v1"
  | "tc-reaction-v1"
  | "cross-modal-v1"
  | "public-room-activity-v1"
  | "public-room-social-time-v1"
  | "economy-peer-actions-v1"
  | "economy-semantic-v1"
  | "shop-role-purchase-v1"
  | "shop-purchase-v1"
  | "casino-completed-activity-v1"
  | "casino-activity-v1"
  | "casino-edition-completion-v1"
  | "casino-table-activity-v1"
  | "casino-table-busy-v1"
  | "casino-market-activity-v1"
  | "confirmed-invites-v1"
  | "invite-rooted-v1"
  | "public-event-completion-v1"
  | "public-event-calendar-v1"
  | "castle-experience-v1"
  | "castle-social-time-v1"
  | "castle-role-context-v1";

export interface QuantileSummary {
  readonly sampleCount: number;
  readonly min: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface NumericDistribution extends QuantileSummary {
  readonly populationCount: number;
  readonly nonZeroCount: number;
  readonly zeroCount: number;
  readonly missingCount: number;
  readonly nonZeroDistribution: QuantileSummary;
}

export interface CalibrationMetricDistribution {
  readonly metricKey: string;
  readonly distribution: NumericDistribution;
}

export interface CalibrationHourDistribution {
  readonly hour: number;
  readonly distribution: NumericDistribution;
}

export interface CalibrationCandidateDescriptor {
  readonly no: number;
  readonly provisionalKey: string;
  readonly readiness: CandidateReadinessAudit["status"];
  readonly thresholdCategory: CandidateReadinessAudit["thresholdCategory"];
}

export interface CalibrationPackSnapshot {
  readonly probeKey: CalibrationProbeKey;
  readonly calibrationMode: "DISTRIBUTION_CALIBRATION";
  readonly candidateNos: readonly number[];
  readonly candidates: readonly CalibrationCandidateDescriptor[];
  readonly sources: readonly TitleUsableSourceKey[];
  readonly readCalls: number;
  readonly metrics: readonly CalibrationMetricDistribution[];
  readonly tcGapOverall: NumericDistribution | null;
  readonly tcGapByHour: readonly CalibrationHourDistribution[];
  readonly coverageKnown: false;
  readonly coverageLimitations: readonly string[];
  readonly warnings: readonly ("NO_SUBJECTS" | "SOURCE_OMITS_UNKNOWN_COVERAGE")[];
}

export interface CalibrationSnapshot {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly percentileMethod: typeof CALIBRATION_PERCENTILE_METHOD;
  readonly catalogHash: string;
  readonly readinessHash: string;
  readonly catalogCandidateCount: number;
  readonly cohort: { readonly key: string; readonly subjectCount: number };
  readonly window: {
    readonly start: number;
    readonly end: number;
    readonly observedAt: number;
    readonly effectiveEnd: number;
  };
  readonly packs: readonly CalibrationPackSnapshot[];
}

export interface CalibrationSnapshotComparison {
  readonly compatible: boolean;
  readonly differences: readonly (
    | "SCHEMA_VERSION"
    | "CATALOG_HASH"
    | "READINESS_HASH"
    | "COHORT"
    | "WINDOW"
  )[];
}

export interface F5aCalibrationInput {
  readonly cohortKey: string;
  readonly subjectUserIds: readonly string[];
  readonly window: {
    readonly start: number;
    readonly end: number;
    readonly observedAt: number;
  };
}

export interface PlanningCalibrationPackMeasurement {
  readonly probeKey: CalibrationPackSnapshot["probeKey"];
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly tcGapsByHour: readonly {
    readonly hour: number;
    readonly values: readonly number[];
  }[];
  readonly jointEvidence: PlanningCalibrationJointEvidence;
}

export type PlanningCalibrationJointEvidence =
  | { readonly kind: "none" }
  | {
      readonly kind: "activity-time-day-hour-v1";
      readonly rows: readonly {
        readonly dayOffset: number;
        readonly hour: number;
        readonly tcBestOtherGapMs: number | null;
        readonly vcTrustedSocialSeconds: number;
      }[];
    }
  | { readonly kind: "day-occurrences-v1"; readonly dayOffsets: readonly number[] }
  | {
      readonly kind: "social-breadth-days-v1";
      readonly days: readonly { readonly dayOffset: number; readonly distinctCoPresentUsers: number }[];
    }
  | {
      readonly kind: "social-context-graph-v1";
      readonly dimension: "class" | "department-family";
      readonly counterparts: readonly {
        readonly counterpartOrdinal: number;
        readonly touches: readonly {
          readonly semanticIndex: number;
          readonly days: readonly { readonly dayOffset: number; readonly trustedSeconds: number }[];
        }[];
      }[];
    }
  | {
      readonly kind: "tc-conversation-v1";
      readonly starts: readonly {
        readonly dayOffset: number;
        readonly quietBeforeMs: number | null;
        readonly nextOtherGapMs: number | null;
        readonly explicitContinuation: boolean;
      }[];
      readonly revivalConversations: readonly {
        readonly conversationOrdinal: number;
        readonly revivals: readonly {
          readonly dayOffset: number;
          readonly dormantBeforeMs: number;
          readonly continuationGapMs: number | null;
        }[];
      }[];
      readonly areas: readonly {
        readonly areaOrdinal: number;
        readonly socialDays: readonly { readonly dayOffset: number; readonly bestOtherGapMs: number | null }[];
      }[];
      readonly thirdPartyJoins: readonly {
        readonly dayOffset: number;
        readonly priorDistinctOtherGapMs: readonly number[];
        readonly priorSelfGapMs: number | null;
        readonly nextOtherGapMs: number | null;
      }[];
    }
  | {
      readonly kind: "tc-reaction-posts-v1";
      readonly posts: readonly {
        readonly postOrdinal: number;
        readonly reactionDayOffsets: readonly number[];
        readonly distinctReactors: number;
      }[];
    }
  | {
      readonly kind: "cross-modal-days-v1";
      readonly tcDays: readonly { readonly dayOffset: number; readonly bestOtherGapMs: number }[];
      readonly vcDays: readonly { readonly dayOffset: number; readonly distinctCoPresentUsers: number }[];
    }
  | {
      readonly kind: "domain-social-time-v1";
      readonly domain: "public-room" | "castle";
      readonly domainDays: readonly {
        readonly dayOffset: number;
        readonly semanticIndex: number;
        readonly magnitude: number;
      }[];
      readonly socialHours: readonly {
        readonly dayOffset: number;
        readonly hour: number;
        readonly tcBestOtherGapMs: number | null;
        readonly vcTrustedSocialSeconds: number;
      }[];
    }
  | {
      readonly kind: "economy-actions-v1";
      readonly actions: readonly {
        readonly dayOffset: number;
        readonly kind: "transfer" | "tip";
      }[];
    }
  | {
      readonly kind: "invite-rooted-v1";
      readonly profiles: readonly {
        readonly profileOrdinal: number;
        readonly activityDays: readonly {
          readonly dayOffset: number;
          readonly tcBestOtherGapMs: number | null;
          readonly vcTrustedSocialSeconds: number;
        }[];
        readonly nextGenerationOccurrences: readonly {
          readonly occurrenceOrdinal: number;
          readonly entryDayOffset: number;
          readonly tcBestOtherGapMs: number | null;
          readonly vcTrustedSocialSeconds: number;
        }[];
        readonly unknownNextGenerationEntryAnchorCount: number;
        readonly reunionDays: readonly {
          readonly dayOffset: number;
          readonly tcBestPairGapMs: number | null;
          readonly vcTrustedPairSeconds: number;
        }[];
      }[];
      readonly unknownEntryAnchorCount: number;
    }
  | {
      readonly kind: "castle-role-context-v1";
      readonly families: readonly {
        readonly semanticIndex: number;
        readonly castleDayOffsets: readonly number[];
        readonly roleHeldDays: readonly { readonly dayOffset: number; readonly trustedSeconds: number; readonly occurrenceCount: number }[];
        readonly insideDays: readonly { readonly dayOffset: number; readonly trustedSeconds: number; readonly occurrenceCount: number }[];
        readonly outsideDays: readonly { readonly dayOffset: number; readonly trustedSeconds: number; readonly occurrenceCount: number }[];
      }[];
    };

export interface PlanningCalibrationSubjectMeasurement {
  readonly subjectUserId: string;
  readonly packs: readonly PlanningCalibrationPackMeasurement[];
}

/**
 * Planning-internal correlation boundary for F5c-style sweeps. It contains restricted subject IDs,
 * must never be serialized/logged, and is intentionally absent from the production v2 barrel.
 */
export interface PlanningCalibrationMeasurementCollection {
  readonly schemaVersion: typeof CALIBRATION_SCHEMA_VERSION;
  readonly percentileMethod: typeof CALIBRATION_PERCENTILE_METHOD;
  readonly catalogHash: string;
  readonly readinessHash: string;
  readonly catalogCandidateCount: number;
  readonly cohort: { readonly key: string; readonly subjectCount: number };
  readonly window: CalibrationSnapshot["window"];
  readonly packReadCalls: readonly {
    readonly probeKey: CalibrationPackSnapshot["probeKey"];
    readonly readCalls: number;
  }[];
  readonly sourceReadCalls: readonly {
    readonly source: TitleUsableSourceKey;
    readonly readCalls: number;
  }[];
  readonly subjects: readonly PlanningCalibrationSubjectMeasurement[];
}

interface SubjectMeasurement {
  readonly metrics: ReadonlyMap<string, number | null>;
  readonly tcGapsByHour?: ReadonlyMap<number, readonly number[]>;
  readonly jointEvidence?: PlanningCalibrationJointEvidence;
}

export type CalibrationPayloadBundle<S extends readonly TitleUsableSourceKey[]> = {
  readonly [K in S[number]]: TitleSourcePayloads[K];
};

interface CalibrationProbe<S extends readonly TitleUsableSourceKey[]> {
  readonly candidateNos: readonly number[];
  readonly probeKey: CalibrationPackSnapshot["probeKey"];
  readonly sources: S;
  readonly emptyPayloads: CalibrationPayloadBundle<S>;
  readonly coverageLimitations: readonly string[];
  measure(payloads: CalibrationPayloadBundle<S>, context: { readonly windowStart: number }): SubjectMeasurement;
}

interface CalibrationProbeRuntime {
  readonly candidateNos: readonly number[];
  readonly probeKey: CalibrationProbeKey;
  readonly sources: readonly TitleUsableSourceKey[];
  readonly coverageLimitations: readonly string[];
  measureFrom(
    readPayload: <K extends TitleUsableSourceKey>(source: K) => TitleSourcePayloads[K],
    context: { readonly windowStart: number },
  ): SubjectMeasurement;
  measureEmpty(context: { readonly windowStart: number }): SubjectMeasurement;
}

export interface CalibrationProbeMeasurementContract {
  readonly probeKey: CalibrationProbeKey;
  readonly candidateNos: readonly number[];
  readonly metricKeys: readonly string[];
  readonly jointEvidenceKind: PlanningCalibrationJointEvidence["kind"];
}

function runtimeProbe<S extends readonly TitleUsableSourceKey[]>(probe: CalibrationProbe<S>): CalibrationProbeRuntime {
  // Fail at module/probe construction, before any cohort read, if readiness/source integrity drifts.
  descriptorFor(probe.candidateNos, probe.sources);
  return {
    candidateNos: probe.candidateNos,
    probeKey: probe.probeKey,
    sources: probe.sources,
    coverageLimitations: probe.coverageLimitations,
    measureFrom: (readPayload, context) => {
      const payloads = Object.fromEntries(probe.sources.map((source) => [source, readPayload(source)])) as CalibrationPayloadBundle<S>;
      return probe.measure(payloads, context);
    },
    measureEmpty: (context) => probe.measure(probe.emptyPayloads, context),
  };
}

function requireFinite(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError("calibration metric must be finite");
  return Object.is(value, -0) ? 0 : value;
}

/** Schema v1 percentile: sorted x, rank=max(1,ceil(p*n)), x[rank-1]. */
export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) throw new RangeError("invalid percentile");
  if (values.length === 0) return null;
  const sorted = values.map(requireFinite).sort((a, b) => a - b);
  if (percentile === 0) return sorted[0]!;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function quantiles(values: readonly number[]): QuantileSummary {
  const clean = values.map(requireFinite).sort((a, b) => a - b);
  const get = (p: number) => nearestRankPercentile(clean, p);
  return {
    sampleCount: clean.length,
    min: clean[0] ?? null,
    p25: get(25), p50: get(50), p75: get(75), p90: get(90), p95: get(95), p99: get(99),
    max: clean.at(-1) ?? null,
  };
}

export function summarizeNumericDistribution(values: readonly (number | null)[]): NumericDistribution {
  const present = values.flatMap((value) => value === null ? [] : [requireFinite(value)]);
  const nonZero = present.filter((value) => value !== 0);
  return {
    populationCount: values.length,
    nonZeroCount: nonZero.length,
    zeroCount: present.length - nonZero.length,
    missingCount: values.length - present.length,
    ...quantiles(present),
    nonZeroDistribution: quantiles(nonZero),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return requireFinite(numerator / denominator);
}

function dateOrdinal(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, day!) / 86_400_000);
}

function dailyShareStats(values: readonly number[]): { p25: number | null; median: number | null; p75: number | null; iqr: number | null; max: number | null } {
  const p25 = nearestRankPercentile(values, 25);
  const p75 = nearestRankPercentile(values, 75);
  return {
    p25,
    median: nearestRankPercentile(values, 50),
    p75,
    iqr: p25 === null || p75 === null ? null : requireFinite(p75 - p25),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

function measureVcStyle(
  payload: VcGroupSizeDailySafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const totals = Object.fromEntries(VC_BUCKETS.map((bucket) => [bucket, 0])) as Record<OccupancyBucket, number>;
  const positiveDays = Object.fromEntries(VC_BUCKETS.map((bucket) => [bucket, 0])) as Record<OccupancyBucket, number>;
  const dailyShares = new Map<OccupancyBucket, number[]>(VC_BUCKETS.map((bucket) => [bucket, []]));
  const dailySocialOnlyShares = new Map<OccupancyBucket, number[]>(SOCIAL_BUCKETS.map((bucket) => [bucket, []]));
  const positiveDates: string[] = [];
  for (const day of payload.days) {
    const dailyTotal = VC_BUCKETS.reduce((sum, bucket) => sum + day.trustedSecondsByBucket[bucket], 0);
    const dailySocialTotal = SOCIAL_BUCKETS.reduce((sum, bucket) => sum + day.trustedSecondsByBucket[bucket], 0);
    if (dailyTotal > 0) positiveDates.push(day.date);
    for (const bucket of VC_BUCKETS) {
      const seconds = day.trustedSecondsByBucket[bucket];
      totals[bucket] += seconds;
      if (seconds > 0) positiveDays[bucket] += 1;
      if (dailyTotal > 0) dailyShares.get(bucket)!.push(seconds / dailyTotal);
    }
    if (dailySocialTotal > 0) {
      for (const bucket of SOCIAL_BUCKETS) {
        dailySocialOnlyShares.get(bucket)!.push(day.trustedSecondsByBucket[bucket] / dailySocialTotal);
      }
    }
  }
  const totalTrustedSeconds = VC_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0);
  const totalSocialSeconds = SOCIAL_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0);
  const socialPositiveDates = payload.days.filter((day) => SOCIAL_BUCKETS.some((bucket) => day.trustedSecondsByBucket[bucket] > 0));
  const metrics = new Map<string, number | null>([
    ["totalTrustedSeconds", totalTrustedSeconds],
    ["totalSocialSeconds", totalSocialSeconds],
    ["activeDays", new Set(positiveDates).size],
    ["socialPositiveDays", socialPositiveDates.length],
    ["positiveSpanDays", positiveDates.length === 0 ? 0 : dateOrdinal(positiveDates.at(-1)!) - dateOrdinal(positiveDates[0]!) + 1],
    ["firstPositiveDayOffset", positiveDates.length === 0 ? null : dateOrdinal(positiveDates[0]!) - Math.floor((context.windowStart + 9 * 3_600) / 86_400)],
    ["lastPositiveDayOffset", positiveDates.length === 0 ? null : dateOrdinal(positiveDates.at(-1)!) - Math.floor((context.windowStart + 9 * 3_600) / 86_400)],
    ["positiveSocialBucketCount", SOCIAL_BUCKETS.filter((bucket) => totals[bucket] > 0).length],
  ]);
  for (const bucket of VC_BUCKETS) {
    metrics.set(`bucketTotalSeconds.${bucket}`, totals[bucket]);
    metrics.set(`bucketPositiveDays.${bucket}`, positiveDays[bucket]);
    metrics.set(`overallBucketShare.${bucket}`, ratio(totals[bucket], totalTrustedSeconds));
    const stats = dailyShareStats(dailyShares.get(bucket)!);
    metrics.set(`dailyBucketShareP25.${bucket}`, stats.p25);
    metrics.set(`dailyBucketShareMedian.${bucket}`, stats.median);
    metrics.set(`dailyBucketShareP75.${bucket}`, stats.p75);
    metrics.set(`dailyBucketShareIqr.${bucket}`, stats.iqr);
    metrics.set(`dailyBucketShareMax.${bucket}`, stats.max);
  }
  for (const bucket of SOCIAL_BUCKETS) {
    metrics.set(`socialOnlyShare.${bucket}`, ratio(totals[bucket], totalSocialSeconds));
    const stats = dailyShareStats(dailySocialOnlyShares.get(bucket)!);
    metrics.set(`dailySocialOnlyShareP25.${bucket}`, stats.p25);
    metrics.set(`dailySocialOnlyShareMedian.${bucket}`, stats.median);
    metrics.set(`dailySocialOnlyShareP75.${bucket}`, stats.p75);
    metrics.set(`dailySocialOnlyShareIqr.${bucket}`, stats.iqr);
    metrics.set(`dailySocialOnlyShareMax.${bucket}`, stats.max);
  }
  return { metrics };
}

function measureActivityTime(
  payload: SocialActivityTimeSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const vcSeconds = Array.from({ length: 24 }, () => 0);
  const vcPositiveDays = Array.from({ length: 24 }, () => 0);
  const tcGaps = new Map<number, number[]>(Array.from({ length: 24 }, (_, hour) => [hour, []]));
  const vcDates = new Set<string>();
  for (const day of payload.days) {
    for (const hour of day.hours) {
      vcSeconds[hour.hour]! += hour.vcTrustedSocialSeconds;
      if (hour.vcTrustedSocialSeconds > 0) {
        vcPositiveDays[hour.hour]! += 1;
        vcDates.add(day.date);
      }
      if (hour.tcBestOtherGapMs !== null) tcGaps.get(hour.hour)!.push(hour.tcBestOtherGapMs);
    }
  }
  const totalVcSeconds = vcSeconds.reduce((sum, value) => sum + value, 0);
  const sortedHours = vcSeconds.slice().sort((a, b) => b - a);
  const metrics = new Map<string, number | null>([
    ["vcTotalTrustedSeconds", totalVcSeconds],
    ["vcPositiveDays", vcDates.size],
    ["vcDominantHourSeconds", sortedHours[0]!],
    ["vcTop2HoursSeconds", sortedHours[0]! + sortedHours[1]!],
    ["vcTop3HoursSeconds", sortedHours[0]! + sortedHours[1]! + sortedHours[2]!],
    ["vcDominantHourShare", ratio(sortedHours[0]!, totalVcSeconds)],
    ["vcTop2HoursShare", ratio(sortedHours[0]! + sortedHours[1]!, totalVcSeconds)],
    ["vcTop3HoursShare", ratio(sortedHours[0]! + sortedHours[1]! + sortedHours[2]!, totalVcSeconds)],
    ["tcGapSampleCount", [...tcGaps.values()].reduce((sum, values) => sum + values.length, 0)],
  ]);
  for (let hour = 0; hour < 24; hour += 1) {
    metrics.set(`hourlyVcTrustedSeconds.${hour}`, vcSeconds[hour]!);
    metrics.set(`hourlyVcPositiveDays.${hour}`, vcPositiveDays[hour]!);
    metrics.set(`hourlyTcGapSampleCount.${hour}`, tcGaps.get(hour)!.length);
  }
  const startDay = Math.floor((context.windowStart + 9 * 3_600) / 86_400);
  return {
    metrics,
    tcGapsByHour: tcGaps,
    jointEvidence: {
      kind: "activity-time-day-hour-v1",
      rows: payload.days.flatMap((day) => day.hours.map((hour) => ({
        dayOffset: dateOrdinal(day.date) - startDay,
        hour: hour.hour,
        tcBestOtherGapMs: hour.tcBestOtherGapMs,
        vcTrustedSocialSeconds: hour.vcTrustedSocialSeconds,
      }))),
    },
  };
}

const VC_STYLE_PROBE: CalibrationProbe<readonly ["vc_group_size_daily_safe"]> = {
  candidateNos: Object.freeze(Array.from({ length: 12 }, (_, index) => index + 10)),
  probeKey: "vc-style-v1",
  sources: ["vc_group_size_daily_safe"],
  emptyPayloads: Object.freeze({ vc_group_size_daily_safe: Object.freeze({ days: [] }) }),
  coverageLimitations: Object.freeze([
    "The safe source omits unknown/untrusted VC intervals; zero cannot distinguish observed inactivity from absent coverage.",
    "Choose a window after source rollout; no historical inference or backfill is performed.",
  ]),
  measure: (payloads, context) => measureVcStyle(payloads.vc_group_size_daily_safe, context),
};

const ACTIVITY_TIME_PROBE: CalibrationProbe<readonly ["social_activity_time_safe"]> = {
  candidateNos: Object.freeze([32, 33, 34, 35, 36, 37]),
  probeKey: "activity-time-v1",
  sources: ["social_activity_time_safe"],
  emptyPayloads: Object.freeze({ social_activity_time_safe: Object.freeze({ days: [] }) }),
  coverageLimitations: Object.freeze([
    "TC stores the best same-surface exchange gap per JST date/hour, not a thresholded meaningful-activity boolean or raw message count.",
    "VC and TC omit unknown/untrusted coverage; zero cannot distinguish observed inactivity from absent coverage.",
    "The 24 JST hour bins are measurement resolution only; no morning/afternoon/evening/night boundary is selected.",
  ]),
  measure: (payloads, context) => measureActivityTime(payloads.social_activity_time_safe, context),
};

function timestampDayOffset(timestamp: number, windowStart: number): number {
  return Math.floor((timestamp + 9 * 3_600) / 86_400) - Math.floor((windowStart + 9 * 3_600) / 86_400);
}

function dateDayOffset(date: string, windowStart: number): number {
  return dateOrdinal(date) - Math.floor((windowStart + 9 * 3_600) / 86_400);
}

function sortedDistinct(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function setSampleMetrics(
  metrics: Map<string, number | null>,
  prefix: string,
  values: readonly number[],
  options: { readonly p90?: boolean } = {},
): void {
  metrics.set(`${prefix}P25`, nearestRankPercentile(values, 25));
  metrics.set(`${prefix}Median`, nearestRankPercentile(values, 50));
  metrics.set(`${prefix}P75`, nearestRankPercentile(values, 75));
  if (options.p90) metrics.set(`${prefix}P90`, nearestRankPercentile(values, 90));
  metrics.set(`${prefix}Max`, values.length === 0 ? null : Math.max(...values));
}

function maximumBipartiteMatching(adjacency: readonly (readonly number[])[]): number {
  const leftByRight = new Map<number, number>();
  const augment = (left: number, seen: Set<number>): boolean => {
    for (const right of adjacency[left] ?? []) {
      if (seen.has(right)) continue;
      seen.add(right);
      const previousLeft = leftByRight.get(right);
      if (previousLeft === undefined || augment(previousLeft, seen)) {
        leftByRight.set(right, left);
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (let left = 0; left < adjacency.length; left += 1) {
    if (augment(left, new Set())) size += 1;
  }
  return size;
}

function measureVcIgnite(
  payload: VcEmptyStartThenJoinedSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const dayOffsets = payload.facts.map((fact) => timestampDayOffset(fact.joinedAt, context.windowStart));
  const days = sortedDistinct(dayOffsets);
  const metrics = new Map<string, number | null>([
    ["occurrenceCount", payload.facts.length],
    ["distinctOccurrenceDays", days.length],
    ["firstOccurrenceDayOffset", days[0] ?? null],
    ["lastOccurrenceDayOffset", days.at(-1) ?? null],
    ["occurrenceSpanDays", days.length === 0 ? 0 : days.at(-1)! - days[0]! + 1],
  ]);
  return { metrics, jointEvidence: { kind: "day-occurrences-v1", dayOffsets } };
}

function measureVcCloser(
  payload: VcLastOccupantSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const dayOffsets = payload.facts.map((fact) => timestampDayOffset(fact.becameLastAt, context.windowStart));
  const days = sortedDistinct(dayOffsets);
  const metrics = new Map<string, number | null>([
    ["occurrenceCount", payload.facts.length],
    ["distinctOccurrenceDays", days.length],
    ["distinctChannels", new Set(payload.facts.map((fact) => fact.channelId)).size],
    ["firstOccurrenceDayOffset", days[0] ?? null],
    ["lastOccurrenceDayOffset", days.at(-1) ?? null],
    ["occurrenceSpanDays", days.length === 0 ? 0 : days.at(-1)! - days[0]! + 1],
  ]);
  return { metrics, jointEvidence: { kind: "day-occurrences-v1", dayOffsets } };
}

function measureSocialBreadth(
  payload: VcSocialSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const days = payload.dailyBreadth.map((day) => ({
    dayOffset: dateDayOffset(day.date, context.windowStart),
    distinctCoPresentUsers: day.distinctCoPresentUsers,
  }));
  const metrics = new Map<string, number | null>([
    ["distinctCoPresentUsers", payload.distinctCoPresentUsers],
    ["trustedOverlapSeconds", payload.trustedOverlapSeconds],
  ]);
  const dayOffsets = sortedDistinct(days.map(({ dayOffset }) => dayOffset));
  metrics.set("breadthPositiveDays", dayOffsets.length);
  metrics.set("firstBreadthDayOffset", dayOffsets[0] ?? null);
  metrics.set("lastBreadthDayOffset", dayOffsets.at(-1) ?? null);
  metrics.set("breadthSpanDays", dayOffsets.length === 0 ? 0 : dayOffsets.at(-1)! - dayOffsets[0]! + 1);
  setSampleMetrics(metrics, "dailyBreadth", days.map(({ distinctCoPresentUsers }) => distinctCoPresentUsers), { p90: true });
  return { metrics, jointEvidence: { kind: "social-breadth-days-v1", days } };
}

function measureRelationshipDepth(payload: VcSocialSafeSourcePayload): SubjectMeasurement {
  return {
    metrics: new Map([
      ["maxRepeatedDaysWithOneCounterpart", payload.maxRepeatedDaysWithOneCounterpart],
      ["distinctCoPresentUsers", payload.distinctCoPresentUsers],
      ["trustedOverlapSeconds", payload.trustedOverlapSeconds],
    ]),
  };
}

interface NormalizedContextTouch {
  readonly semanticIndex: number;
  readonly days: readonly { readonly date: string; readonly trustedSeconds: number }[];
}

function measureSocialContext(
  counterparts: readonly (readonly NormalizedContextTouch[])[],
  dimension: "class" | "department-family",
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const graph = counterparts.map((touches, counterpartOrdinal) => ({
    counterpartOrdinal,
    touches: touches.map((touch) => ({
      semanticIndex: touch.semanticIndex,
      days: touch.days.map((day) => ({
        dayOffset: dateDayOffset(day.date, context.windowStart),
        trustedSeconds: day.trustedSeconds,
      })),
    })),
  }));
  const allTouches = graph.flatMap((counterpart) => counterpart.touches);
  const allDays = allTouches.flatMap((touch) => touch.days.map(({ dayOffset }) => dayOffset));
  const adjacency = graph.map((counterpart) => sortedDistinct(counterpart.touches
    .filter((touch) => touch.days.some(({ trustedSeconds }) => trustedSeconds > 0))
    .map(({ semanticIndex }) => semanticIndex)));
  const semanticLabel = dimension === "class" ? "Class" : "Family";
  return {
    metrics: new Map([
      ["counterpartProfileCount", graph.length],
      [`distinct${semanticLabel}IndexCount`, new Set(allTouches.map(({ semanticIndex }) => semanticIndex)).size],
      ["touchEdgeCount", allTouches.length],
      ["totalTrustedSeconds", allTouches.flatMap(({ days }) => days).reduce((sum, day) => sum + day.trustedSeconds, 0)],
      ["unionTouchDays", new Set(allDays).size],
      [`structuralMaxPerson${semanticLabel}Matching`, maximumBipartiteMatching(adjacency)],
    ]),
    jointEvidence: { kind: "social-context-graph-v1", dimension, counterparts: graph },
  };
}

function measureClassContext(
  payload: SocialClassContextSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  return measureSocialContext(
    payload.counterparts.map((counterpart) => counterpart.classTouches.map((touch) => ({
      semanticIndex: touch.classIndex,
      days: touch.days,
    }))),
    "class",
    context,
  );
}

function measureDepartmentContext(
  payload: SocialDepartmentFamilyContextSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  return measureSocialContext(
    payload.counterparts.map((counterpart) => counterpart.familyTouches.map((touch) => ({
      semanticIndex: touch.familyIndex,
      days: touch.days,
    }))),
    "department-family",
    context,
  );
}

function measureBump(
  payload: BumpEventsSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const dayOffsets = payload.events.map((event) => timestampDayOffset(event, context.windowStart));
  const counts = new Map<number, number>();
  for (const dayOffset of dayOffsets) counts.set(dayOffset, (counts.get(dayOffset) ?? 0) + 1);
  const metrics = new Map<string, number | null>([
    ["eventCount", payload.events.length],
    ["distinctActiveDays", counts.size],
    ["firstActiveDayOffset", sortedDistinct(dayOffsets)[0] ?? null],
    ["lastActiveDayOffset", sortedDistinct(dayOffsets).at(-1) ?? null],
    ["activeSpanDays", counts.size === 0 ? 0 : Math.max(...counts.keys()) - Math.min(...counts.keys()) + 1],
    ["sameDayExcessCount", [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)],
    ["maxEventsPerDay", counts.size === 0 ? 0 : Math.max(...counts.values())],
  ]);
  return { metrics, jointEvidence: { kind: "day-occurrences-v1", dayOffsets } };
}

function measureTcConversation(
  payload: TcConversationSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const starts = payload.starts.map((start) => ({
    dayOffset: dateDayOffset(start.date, context.windowStart),
    quietBeforeMs: start.quietBeforeMs,
    nextOtherGapMs: start.nextOtherGapMs,
    explicitContinuation: start.explicitContinuation,
  }));
  const revivalConversations = payload.revivalConversations.map((conversation, conversationOrdinal) => ({
    conversationOrdinal,
    revivals: conversation.revivals.map((revival) => ({
      dayOffset: dateDayOffset(revival.date, context.windowStart),
      dormantBeforeMs: revival.dormantBeforeMs,
      continuationGapMs: revival.continuationGapMs,
    })),
  }));
  const areas = payload.areas.map((area, areaOrdinal) => ({
    areaOrdinal,
    socialDays: area.socialDays.map((day) => ({
      dayOffset: dateDayOffset(day.date, context.windowStart),
      bestOtherGapMs: day.bestOtherGapMs,
    })),
  }));
  const thirdPartyJoins = payload.thirdPartyJoins.map((join) => ({
    dayOffset: dateDayOffset(join.date, context.windowStart),
    priorDistinctOtherGapMs: [...join.priorDistinctOtherGapMs],
    priorSelfGapMs: join.priorSelfGapMs,
    nextOtherGapMs: join.nextOtherGapMs,
  }));
  const metrics = new Map<string, number | null>([
    ["startCount", starts.length],
    ["startDistinctDays", new Set(starts.map(({ dayOffset }) => dayOffset)).size],
    ["explicitContinuationCount", starts.filter(({ explicitContinuation }) => explicitContinuation).length],
    ["explicitContinuationShare", ratio(starts.filter(({ explicitContinuation }) => explicitContinuation).length, starts.length)],
  ]);
  setSampleMetrics(metrics, "quietBeforeMs", starts.flatMap(({ quietBeforeMs }) => quietBeforeMs === null ? [] : [quietBeforeMs]));
  const nextOtherGaps = starts.flatMap(({ nextOtherGapMs }) => nextOtherGapMs === null ? [] : [nextOtherGapMs]);
  setSampleMetrics(metrics, "nextOtherGapMs", nextOtherGaps);
  metrics.set("nextOtherGapMissingCount", starts.length - nextOtherGaps.length);

  const revivals = revivalConversations.flatMap(({ revivals: rows }) => rows);
  metrics.set("revivalConversationCount", revivalConversations.length);
  metrics.set("revivalOccurrenceCount", revivals.length);
  metrics.set("revivalDistinctDays", new Set(revivals.map(({ dayOffset }) => dayOffset)).size);
  metrics.set("maxRevivalsPerConversation", revivalConversations.length === 0
    ? 0
    : Math.max(...revivalConversations.map(({ revivals: rows }) => rows.length)));
  setSampleMetrics(metrics, "dormantBeforeMs", revivals.map(({ dormantBeforeMs }) => dormantBeforeMs));
  const continuationGaps = revivals.flatMap(({ continuationGapMs }) => continuationGapMs === null ? [] : [continuationGapMs]);
  setSampleMetrics(metrics, "continuationGapMs", continuationGaps);
  metrics.set("continuationGapMissingCount", revivals.length - continuationGaps.length);

  const areaSocialDays = areas.map((area) => area.socialDays.filter(({ bestOtherGapMs }) => bestOtherGapMs !== null));
  const areaDays = areaSocialDays.flatMap((socialDays) => socialDays.map(({ dayOffset }) => dayOffset));
  metrics.set("socialAreaCount", areaSocialDays.filter((socialDays) => socialDays.length > 0).length);
  metrics.set("socialAreaUnionDays", new Set(areaDays).size);
  metrics.set("maxSocialDaysPerArea", areaSocialDays.length === 0 ? 0 : Math.max(...areaSocialDays.map((socialDays) => socialDays.length)));
  const distinctAreaDays = sortedDistinct(areaDays);
  metrics.set("socialAreaSpanDays", distinctAreaDays.length === 0 ? 0 : distinctAreaDays.at(-1)! - distinctAreaDays[0]! + 1);

  metrics.set("thirdPartyJoinCount", thirdPartyJoins.length);
  metrics.set("thirdPartyJoinDistinctDays", new Set(thirdPartyJoins.map(({ dayOffset }) => dayOffset)).size);
  setSampleMetrics(metrics, "priorDistinctOtherCount", thirdPartyJoins.map((join) => join.priorDistinctOtherGapMs.length));
  setSampleMetrics(metrics, "thirdPartyNextOtherGapMs", thirdPartyJoins.flatMap(({ nextOtherGapMs }) => nextOtherGapMs === null ? [] : [nextOtherGapMs]));
  setSampleMetrics(metrics, "priorSelfGapMs", thirdPartyJoins.flatMap(({ priorSelfGapMs }) => priorSelfGapMs === null ? [] : [priorSelfGapMs]));
  return {
    metrics,
    jointEvidence: { kind: "tc-conversation-v1", starts, revivalConversations, areas, thirdPartyJoins },
  };
}

function measureTcReaction(
  payload: TcReactionSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const posts = payload.posts.map((post, postOrdinal) => ({
    postOrdinal,
    reactionDayOffsets: post.reactionDays.map((date) => dateDayOffset(date, context.windowStart)),
    distinctReactors: post.distinctReactors,
  }));
  const metrics = new Map<string, number | null>([
    ["distinctReactors", payload.distinctReactors],
    ["postCount", posts.length],
    ["reactionPositiveDays", new Set(posts.flatMap(({ reactionDayOffsets }) => reactionDayOffsets)).size],
    ["totalPostDayTouches", posts.reduce((sum, post) => sum + post.reactionDayOffsets.length, 0)],
    ["maxReactionDaysOnOnePost", posts.length === 0 ? 0 : Math.max(...posts.map((post) => post.reactionDayOffsets.length))],
  ]);
  setSampleMetrics(metrics, "perPostDistinctReactors", posts.map(({ distinctReactors }) => distinctReactors));
  setSampleMetrics(metrics, "perPostReactionDayCount", posts.map(({ reactionDayOffsets }) => reactionDayOffsets.length));
  return { metrics, jointEvidence: { kind: "tc-reaction-posts-v1", posts } };
}

function measureCrossModal(
  tc: TcConversationSafeSourcePayload,
  vc: VcSocialSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const tcDays = tc.socialDays.map((day) => ({
    dayOffset: dateDayOffset(day.date, context.windowStart),
    bestOtherGapMs: day.bestOtherGapMs,
  }));
  const vcDays = vc.dailyBreadth
    .filter(({ distinctCoPresentUsers }) => distinctCoPresentUsers > 0)
    .map((day) => ({
      dayOffset: dateDayOffset(day.date, context.windowStart),
      distinctCoPresentUsers: day.distinctCoPresentUsers,
    }));
  const tcOffsets = sortedDistinct(tcDays.map(({ dayOffset }) => dayOffset));
  const vcOffsets = sortedDistinct(vcDays.map(({ dayOffset }) => dayOffset));
  const tcSet = new Set(tcOffsets);
  const vcSet = new Set(vcOffsets);
  const metrics = new Map<string, number | null>([
    ["tcCandidateSocialDays", tcOffsets.length],
    ["vcSocialDays", vcOffsets.length],
    ["unionModalityDays", new Set([...tcOffsets, ...vcOffsets]).size],
    ["overlappingCalendarDays", tcOffsets.filter((day) => vcSet.has(day)).length],
  ]);
  metrics.set("tcFirstDayOffset", tcOffsets[0] ?? null);
  metrics.set("tcLastDayOffset", tcOffsets.at(-1) ?? null);
  metrics.set("tcSpanDays", tcOffsets.length === 0 ? 0 : tcOffsets.at(-1)! - tcOffsets[0]! + 1);
  metrics.set("vcFirstDayOffset", vcOffsets[0] ?? null);
  metrics.set("vcLastDayOffset", vcOffsets.at(-1) ?? null);
  metrics.set("vcSpanDays", vcOffsets.length === 0 ? 0 : vcOffsets.at(-1)! - vcOffsets[0]! + 1);
  return { metrics, jointEvidence: { kind: "cross-modal-days-v1", tcDays, vcDays } };
}

function setDayRangeMetrics(
  metrics: Map<string, number | null>,
  prefix: string,
  dayOffsets: readonly number[],
): number[] {
  const days = sortedDistinct(dayOffsets);
  metrics.set(`${prefix}Days`, days.length);
  metrics.set(`${prefix}FirstDayOffset`, days[0] ?? null);
  metrics.set(`${prefix}LastDayOffset`, days.at(-1) ?? null);
  metrics.set(`${prefix}SpanDays`, days.length === 0 ? null : days.at(-1)! - days[0]! + 1);
  return days;
}

function socialHourEvidence(
  payload: SocialActivityTimeSafeSourcePayload,
  windowStart: number,
): Array<{ dayOffset: number; hour: number; tcBestOtherGapMs: number | null; vcTrustedSocialSeconds: number }> {
  return payload.days.flatMap((day) => day.hours.map((hour) => ({
    dayOffset: dateDayOffset(day.date, windowStart),
    hour: hour.hour,
    tcBestOtherGapMs: hour.tcBestOtherGapMs,
    vcTrustedSocialSeconds: hour.vcTrustedSocialSeconds,
  }))).sort((a, b) => a.dayOffset - b.dayOffset || a.hour - b.hour);
}

function measurePublicRoomActivity(
  payload: PublicRoomActivitySafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const hosted = payload.hosted.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const guest = payload.guest.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const ownUse = payload.ownUse.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const metrics = new Map<string, number | null>([
    ["hostedSessionCount", payload.hosted.sessionCount],
    ["hostedDistinctGuests", payload.hosted.distinctGuests],
    ["hostedMaxConcurrentGuests", payload.hosted.maxConcurrentGuests],
    ["hostedMaxRepeatGuestDepth", payload.hosted.maxRepeatGuestDepth],
    ["guestSessionCount", payload.guest.sessionCount],
    ["guestDistinctOwners", payload.guest.distinctOwners],
    ["ownUseSessionCount", payload.ownUse.sessionCount],
  ]);
  setDayRangeMetrics(metrics, "active", [...hosted, ...guest, ...ownUse]);
  setDayRangeMetrics(metrics, "hostedActive", hosted);
  setDayRangeMetrics(metrics, "guestActive", guest);
  setDayRangeMetrics(metrics, "ownUseActive", ownUse);
  setSampleMetrics(metrics, "hostedDailyDistinctGuests", payload.hosted.days.map(({ distinctGuests }) => distinctGuests));
  setSampleMetrics(metrics, "hostedDailySessions", payload.hosted.days.map(({ sessionsWithGuests }) => sessionsWithGuests));
  setSampleMetrics(metrics, "guestDailyDistinctOwners", payload.guest.days.map(({ distinctOwners }) => distinctOwners));
  setSampleMetrics(metrics, "guestDailySessions", payload.guest.days.map(({ sessionsVisited }) => sessionsVisited));
  setSampleMetrics(metrics, "ownUseDailySessions", payload.ownUse.days.map(({ sessionsUsed }) => sessionsUsed));
  return { metrics };
}

function measureDomainSocialTime(
  domain: "public-room" | "castle",
  domainDays: readonly { readonly dayOffset: number; readonly semanticIndex: number; readonly magnitude: number }[],
  social: SocialActivityTimeSafeSourcePayload,
  context: { readonly windowStart: number },
  /**
   * F5c1レビュー(PR #190)§2: No.87の「social/economy-play/castle-wide super-domain
   * coverage」はfamily breadth（domainSemanticBreadth）とは別概念——`castle_experience_safe`
   * payloadが既に持つ`coveredSuperDomains`をそのまま公開する。"public-room"呼び出しには
   * super-domainの概念が無いためundefinedのまま（metricを出さない）。
   */
  castleCoveredSuperDomainCount?: number,
): SubjectMeasurement {
  const socialHours = socialHourEvidence(social, context.windowStart);
  const domainOffsets = sortedDistinct(domainDays.map(({ dayOffset }) => dayOffset));
  const socialOffsets = sortedDistinct(socialHours
    .filter(({ tcBestOtherGapMs, vcTrustedSocialSeconds }) => tcBestOtherGapMs !== null || vcTrustedSocialSeconds > 0)
    .map(({ dayOffset }) => dayOffset));
  const socialSet = new Set(socialOffsets);
  const metrics = new Map<string, number | null>([
    ["domainSemanticBreadth", new Set(domainDays.map(({ semanticIndex }) => semanticIndex)).size],
    ["domainDayTouches", domainDays.length],
    ["socialTcGapSampleCount", socialHours.filter(({ tcBestOtherGapMs }) => tcBestOtherGapMs !== null).length],
    ["socialVcTrustedSeconds", socialHours.reduce((sum, row) => sum + row.vcTrustedSocialSeconds, 0)],
    ["overlappingCalendarDays", domainOffsets.filter((day) => socialSet.has(day)).length],
    ["unionCalendarDays", new Set([...domainOffsets, ...socialOffsets]).size],
  ]);
  if (castleCoveredSuperDomainCount !== undefined) metrics.set("coveredSuperDomainCount", castleCoveredSuperDomainCount);
  setDayRangeMetrics(metrics, "domainActive", domainOffsets);
  setDayRangeMetrics(metrics, "socialActive", socialOffsets);
  return {
    metrics,
    jointEvidence: {
      kind: "domain-social-time-v1",
      domain,
      domainDays: [...domainDays].sort((a, b) => a.dayOffset - b.dayOffset || a.semanticIndex - b.semanticIndex),
      socialHours,
    },
  };
}

function measureEconomyPeerActions(
  payload: EconomySafePeerActionsSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const actions = payload.facts.map(({ date, kind }) => ({ dayOffset: dateDayOffset(date, context.windowStart), kind }))
    .sort((a, b) => a.dayOffset - b.dayOffset || a.kind.localeCompare(b.kind));
  const transfers = actions.filter(({ kind }) => kind === "transfer");
  const tips = actions.filter(({ kind }) => kind === "tip");
  const metrics = new Map<string, number | null>([
    ["peerActionCount", actions.length],
    ["transferCount", transfers.length],
    ["tipCount", tips.length],
  ]);
  setDayRangeMetrics(metrics, "peerActionActive", actions.map(({ dayOffset }) => dayOffset));
  setDayRangeMetrics(metrics, "transferActive", transfers.map(({ dayOffset }) => dayOffset));
  setDayRangeMetrics(metrics, "tipActive", tips.map(({ dayOffset }) => dayOffset));
  return { metrics, jointEvidence: { kind: "economy-actions-v1", actions } };
}

function measureEconomySemantic(
  payload: EconomySemanticSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const dayOffsets = payload.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const tipOffsets = payload.outgoingTip.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const metrics = new Map<string, number | null>([
    ["distinctFamilies", payload.distinctFamilies],
    ["distinctSubjectUsedFamilies", payload.distinctSubjectUsedFamilies],
    ["distinctHumanCounterparts", payload.distinctHumanCounterparts],
    ["hasNaturalInflow", payload.hasNaturalInflow ? 1 : 0],
    ["hasNaturalOutflow", payload.hasNaturalOutflow ? 1 : 0],
    ["outgoingTipDistinctRecipients", payload.outgoingTip.distinctRecipients],
  ]);
  setDayRangeMetrics(metrics, "economyActive", dayOffsets);
  setDayRangeMetrics(metrics, "outgoingTipActive", tipOffsets);
  setSampleMetrics(metrics, "dailyDistinctHumanCounterparts", payload.days.map(({ distinctHumanCounterparts }) => distinctHumanCounterparts));
  setSampleMetrics(metrics, "dailyOutgoingTipDistinctRecipients", payload.outgoingTip.days.map(({ distinctRecipients }) => distinctRecipients));
  for (const family of ECONOMY_FAMILY_ORDER) {
    metrics.set(`familyObserved.${family}`, payload.days.some((day) => day.families.includes(family)) ? 1 : 0);
    metrics.set(`familySubjectUsed.${family}`, payload.subjectUsedFamilies.includes(family) ? 1 : 0);
  }
  return { metrics };
}

function measureShopRolePurchases(
  payload: ShopRolePurchaseSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const offsets = payload.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const metrics = new Map<string, number | null>([
    ["shopRoleEligiblePurchaseCount", payload.days.reduce((sum, day) => sum + day.eligiblePurchaseCount, 0)],
  ]);
  setDayRangeMetrics(metrics, "shopRolePurchaseActive", offsets);
  setSampleMetrics(metrics, "dailyShopRoleEligiblePurchases", payload.days.map(({ eligiblePurchaseCount }) => eligiblePurchaseCount));
  return { metrics };
}

function measureShopPurchases(
  payload: ShopPurchaseSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const offsets = payload.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const metrics = new Map<string, number | null>([
    ["distinctEligibleProducts", payload.distinctEligibleProducts],
    ["sumDailyDistinctEligibleProducts", payload.days.reduce((sum, day) => sum + day.distinctEligibleProducts, 0)],
  ]);
  setDayRangeMetrics(metrics, "purchaseActive", offsets);
  setSampleMetrics(metrics, "dailyDistinctEligibleProducts", payload.days.map(({ distinctEligibleProducts }) => distinctEligibleProducts));
  return { metrics };
}

function measureCasinoActivity(
  payload: CasinoActivityDaysSourcePayload | CasinoCompletedActivityDaysSourcePayload,
  context: { readonly windowStart: number },
  prefix: "activity" | "completedActivity",
): SubjectMeasurement {
  const offsets = payload.activityDays.map(({ activityDate }) => dateDayOffset(activityDate, context.windowStart)).sort((a, b) => a - b);
  const metrics = new Map<string, number | null>([
    [`${prefix}Count`, payload.activityDays.length],
    [`${prefix}DistinctFamilies`, new Set(payload.activityDays.map(({ activityKey }) => activityKey)).size],
  ]);
  setDayRangeMetrics(metrics, prefix, offsets);
  return { metrics, jointEvidence: { kind: "day-occurrences-v1", dayOffsets: offsets } };
}

function measureCasinoEdition(
  payload: CasinoEditionICompletionSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const offsets = payload.completedFamilies.flatMap(({ completionDays }) => completionDays.map((date) => dateDayOffset(date, context.windowStart)));
  const metrics = new Map<string, number | null>([
    ["distinctCompletedFamilies", payload.distinctCompletedFamilies],
    ["allFamiliesCompleted", payload.allFamiliesCompleted ? 1 : 0],
    ["totalFamilyCompletionDays", payload.completedFamilies.reduce((sum, family) => sum + family.completionDays.length, 0)],
  ]);
  setDayRangeMetrics(metrics, "completionActive", offsets);
  const completedByFamily = new Map(payload.completedFamilies.map((family) => [family.familyKey, family.completionDays.length]));
  for (const family of CASINO_EDITION_I_FAMILY_ORDER) metrics.set(`familyCompletionDays.${family}`, completedByFamily.get(family) ?? 0);
  return { metrics };
}

function measureCasinoTableHosted(payload: CasinoTableActivitySafeSourcePayload): SubjectMeasurement {
  const guestStays = payload.tables.flatMap(({ guestStays: stays }) => stays);
  const perTableSeconds = payload.tables.map((table) => table.guestStays.reduce((sum, stay) => sum + stay.trustedSeconds, 0));
  const perGuestSeconds = payload.guests.map((guest) => guest.stays.reduce((sum, stay) => sum + stay.trustedSeconds, 0));
  const metrics = new Map<string, number | null>([
    ["tableCount", payload.tables.length],
    ["guestProfileCount", payload.guests.length],
    ["guestStayRowCount", guestStays.length],
    ["guestActiveDays", new Set(guestStays.map(({ date }) => date)).size],
    ["totalTrustedGuestSeconds", guestStays.reduce((sum, stay) => sum + stay.trustedSeconds, 0)],
  ]);
  setSampleMetrics(metrics, "trustedSecondsPerTable", perTableSeconds);
  setSampleMetrics(metrics, "trustedSecondsPerGuest", perGuestSeconds);
  return { metrics };
}

function measureCasinoTableBusy(
  payload: CasinoTableActivitySafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const stays = payload.guests.flatMap(({ stays: rows }) => rows);
  const offsets = stays.map(({ date }) => dateDayOffset(date, context.windowStart));
  const byDay = new Map<number, number>();
  for (const stay of stays) byDay.set(dateDayOffset(stay.date, context.windowStart), (byDay.get(dateDayOffset(stay.date, context.windowStart)) ?? 0) + stay.trustedSeconds);
  const metrics = new Map<string, number | null>([
    ["guestProfileCount", payload.guests.length],
    ["stayRowCount", stays.length],
    ["distinctHostedTableProfilesWithGuests", new Set(stays.map(({ tableProfileIndex }) => tableProfileIndex)).size],
    ["hostedGuestTrustedSeconds", stays.reduce((sum, stay) => sum + stay.trustedSeconds, 0)],
  ]);
  setDayRangeMetrics(metrics, "busyTableActive", offsets);
  setSampleMetrics(metrics, "dailyHostedGuestTrustedSeconds", [...byDay.values()]);
  setSampleMetrics(metrics, "trustedSecondsPerGuestProfile", payload.guests.map((guest) => guest.stays.reduce((sum, stay) => sum + stay.trustedSeconds, 0)));
  return { metrics };
}

function measureCasinoMarket(
  payload: CasinoMarketActivitySafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const offsets = payload.days.map(({ date }) => dateDayOffset(date, context.windowStart));
  const metrics = new Map<string, number | null>([
    ["distinctOtherStandardBoards", payload.distinctOtherStandardBoards],
    ["sumDailyDistinctOtherStandardBoards", payload.days.reduce((sum, day) => sum + day.distinctOtherStandardBoards, 0)],
  ]);
  setDayRangeMetrics(metrics, "marketActive", offsets);
  setSampleMetrics(metrics, "dailyDistinctOtherStandardBoards", payload.days.map(({ distinctOtherStandardBoards }) => distinctOtherStandardBoards));
  return { metrics };
}

function measureConfirmedInvites(
  payload: ConfirmedInvitesSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const offsets = payload.creditedAt.map((at) => timestampDayOffset(at, context.windowStart)).sort((a, b) => a - b);
  const metrics = new Map<string, number | null>([["confirmedInviteCount", payload.creditedAt.length]]);
  setDayRangeMetrics(metrics, "confirmationActive", offsets);
  return { metrics, jointEvidence: { kind: "day-occurrences-v1", dayOffsets: offsets } };
}

function measureInviteRooted(payload: InviteRootedSafeSourcePayload): SubjectMeasurement {
  const profiles = payload.profiles.map((profile, profileOrdinal) => ({
    profileOrdinal,
    activityDays: profile.activityDays.map((day) => ({ ...day })),
    nextGenerationOccurrences: profile.nextGenerationOccurrences.map((occurrence, occurrenceOrdinal) => ({
      occurrenceOrdinal,
      entryDayOffset: occurrence.entryDayOffset,
      tcBestOtherGapMs: occurrence.sameDayBeforeEntry.tcBestOtherGapMs,
      vcTrustedSocialSeconds: occurrence.sameDayBeforeEntry.vcTrustedSocialSeconds,
    })),
    unknownNextGenerationEntryAnchorCount: profile.unknownNextGenerationEntryAnchorCount,
    reunionDays: profile.reunionDays.map((day) => ({ ...day })),
  }));
  const activityDays = profiles.flatMap(({ activityDays: days }) => days);
  const occurrences = profiles.flatMap(({ nextGenerationOccurrences }) => nextGenerationOccurrences);
  const reunionDays = profiles.flatMap(({ reunionDays: days }) => days);
  const metrics = new Map<string, number | null>([
    ["directBranchProfileCount", profiles.length],
    ["branchActivityDayCount", activityDays.length],
    ["branchActivityVcTrustedSocialSeconds", activityDays.reduce((sum, day) => sum + day.vcTrustedSocialSeconds, 0)],
    ["branchActivityTcGapSampleCount", activityDays.filter(({ tcBestOtherGapMs }) => tcBestOtherGapMs !== null).length],
    ["nextGenerationOccurrenceCount", occurrences.length],
    ["nextGenerationSameDayVcTrustedSocialSeconds", occurrences.reduce((sum, occurrence) => sum + occurrence.vcTrustedSocialSeconds, 0)],
    ["nextGenerationSameDayTcGapSampleCount", occurrences.filter(({ tcBestOtherGapMs }) => tcBestOtherGapMs !== null).length],
    ["unknownEntryAnchorCount", payload.unknownEntryAnchorCount],
    ["unknownNextGenerationEntryAnchorCount", profiles.reduce((sum, profile) => sum + profile.unknownNextGenerationEntryAnchorCount, 0)],
    ["reunionDayCount", reunionDays.length],
    ["reunionVcTrustedPairSeconds", reunionDays.reduce((sum, day) => sum + day.vcTrustedPairSeconds, 0)],
    ["reunionTcGapSampleCount", reunionDays.filter(({ tcBestPairGapMs }) => tcBestPairGapMs !== null).length],
  ]);
  setSampleMetrics(metrics, "activityDaysPerBranch", profiles.map(({ activityDays: days }) => days.length));
  setSampleMetrics(metrics, "nextGenerationOccurrencesPerBranch", profiles.map(({ nextGenerationOccurrences }) => nextGenerationOccurrences.length));
  setSampleMetrics(metrics, "reunionDaysPerBranch", profiles.map(({ reunionDays: days }) => days.length));
  return { metrics, jointEvidence: { kind: "invite-rooted-v1", profiles, unknownEntryAnchorCount: payload.unknownEntryAnchorCount } };
}

function measurePublicEventCompletion(
  payload: PublicEventCompletedParticipationsSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const offsets = payload.participations.map(({ completedAt }) => timestampDayOffset(completedAt, context.windowStart)).sort((a, b) => a - b);
  const metrics = new Map<string, number | null>([["completedParticipationCount", payload.participations.length]]);
  setDayRangeMetrics(metrics, "completionActive", offsets);
  return { metrics, jointEvidence: { kind: "day-occurrences-v1", dayOffsets: offsets } };
}

function measurePublicEventCalendar(
  calendar: PublicEventCalendarInvolvementSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const offsets = calendar.events.map(({ eventDate }) => dateDayOffset(eventDate, context.windowStart));
  const metrics = new Map<string, number | null>([
    ["totalEventInvolvementCount", calendar.events.length],
    ["generalParticipantCount", calendar.events.filter(({ generalParticipant }) => generalParticipant).length],
    ["staffCount", calendar.events.filter(({ staff }) => staff).length],
    ["organizerCount", calendar.events.filter(({ organizer }) => organizer).length],
    ["primaryOrganizerCount", calendar.events.filter(({ primaryOrganizer }) => primaryOrganizer).length],
    ["participantOnlyCount", calendar.events.filter((event) => event.generalParticipant && !event.staff && !event.organizer && !event.primaryOrganizer).length],
    ["multiRoleInvolvementCount", calendar.events.filter((event) => [event.generalParticipant, event.staff, event.organizer].filter(Boolean).length > 1).length],
  ]);
  setDayRangeMetrics(metrics, "event", offsets);
  return { metrics };
}

function castleFamilyDayRows(payload: CastleExperienceSafeSourcePayload, windowStart: number) {
  return payload.families.flatMap((family) => family.days.map((date) => ({
    dayOffset: dateDayOffset(date, windowStart), semanticIndex: CASTLE_FAMILY_ORDER.indexOf(family.familyKey), magnitude: 1,
  })));
}

function measureCastleExperience(
  payload: CastleExperienceSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const rows = castleFamilyDayRows(payload, context.windowStart);
  const offsets = rows.map(({ dayOffset }) => dayOffset);
  const familiesPerDay = new Map<number, Set<number>>();
  for (const row of rows) {
    const families = familiesPerDay.get(row.dayOffset) ?? new Set<number>();
    families.add(row.semanticIndex);
    familiesPerDay.set(row.dayOffset, families);
  }
  const vcDaily = payload.families.find(({ familyKey }) => familyKey === "public_vc")?.dailyTrustedSeconds ?? [];
  const metrics = new Map<string, number | null>([
    ["activeFamilyCount", payload.families.length],
    ["coveredSuperDomainCount", payload.coveredSuperDomains.length],
    ["sumFamilyActiveDays", rows.length],
    ["multiFamilyActiveDays", [...familiesPerDay.values()].filter((families) => families.size > 1).length],
    ["publicVcTrustedSeconds", vcDaily.reduce((sum, day) => sum + day.trustedSeconds, 0)],
  ]);
  setDayRangeMetrics(metrics, "castleActive", offsets);
  setSampleMetrics(metrics, "familiesPerActiveDay", [...familiesPerDay.values()].map((families) => families.size));
  setSampleMetrics(metrics, "publicVcDailyTrustedSeconds", vcDaily.map(({ trustedSeconds }) => trustedSeconds));
  const familyActiveDays = new Map(payload.families.map((family) => [family.familyKey, family.days.length]));
  for (const family of CASTLE_FAMILY_ORDER) metrics.set(`familyActiveDays.${family}`, familyActiveDays.get(family) ?? 0);
  return { metrics };
}

function measureCastleRoleContext(
  castle: CastleExperienceSafeSourcePayload,
  role: CastleRoleContextSafeSourcePayload,
  context: { readonly windowStart: number },
): SubjectMeasurement {
  const familyKeys = CASTLE_ROLE_FAMILY_ORDER;
  const byKey = <T extends { readonly familyKey: string }>(rows: readonly T[]) => new Map(rows.map((row) => [row.familyKey, row]));
  const castleByKey = byKey(castle.families);
  const heldByKey = byKey(role.roleHeldFamilies);
  const insideByKey = byKey(role.insideFamilies);
  const outsideByKey = byKey(role.outsideFamilies);
  const convertDays = (days: readonly { date: string; trustedSeconds: number; occurrenceCount: number }[]) => days.map((day) => ({
    dayOffset: dateDayOffset(day.date, context.windowStart), trustedSeconds: day.trustedSeconds, occurrenceCount: day.occurrenceCount,
  }));
  const families = familyKeys.map((familyKey, semanticIndex) => ({
    semanticIndex,
    castleDayOffsets: (castleByKey.get(familyKey)?.days ?? []).map((date) => dateDayOffset(date, context.windowStart)),
    roleHeldDays: convertDays(heldByKey.get(familyKey)?.days ?? []),
    insideDays: convertDays(insideByKey.get(familyKey)?.days ?? []),
    outsideDays: convertDays(outsideByKey.get(familyKey)?.days ?? []),
  }));
  const insideDays = role.insideFamilies.flatMap(({ days }) => days);
  const outsideDays = role.outsideFamilies.flatMap(({ days }) => days);
  const insideSeconds = insideDays.reduce((sum, day) => sum + day.trustedSeconds, 0);
  const outsideSeconds = outsideDays.reduce((sum, day) => sum + day.trustedSeconds, 0);
  const insideOccurrences = insideDays.reduce((sum, day) => sum + day.occurrenceCount, 0);
  const outsideOccurrences = outsideDays.reduce((sum, day) => sum + day.occurrenceCount, 0);
  const metrics = new Map<string, number | null>([
    ["castleActiveFamilyCount", castle.families.length],
    ["roleHeldFamilyCount", role.roleHeldFamilies.length],
    ["insideActiveFamilyCount", role.insideFamilies.length],
    ["outsideActiveFamilyCount", role.outsideFamilies.length],
    ["insideDayUnion", new Set(insideDays.map(({ date }) => date)).size],
    ["outsideDayUnion", new Set(outsideDays.map(({ date }) => date)).size],
    ["outsideDaysCount", role.outsideDays.length],
    ["insideTrustedSeconds", insideSeconds],
    ["outsideTrustedSeconds", outsideSeconds],
    ["totalClassifiedTrustedSeconds", insideSeconds + outsideSeconds],
    ["insideOccurrenceCount", insideOccurrences],
    ["outsideOccurrenceCount", outsideOccurrences],
    ["totalOccurrenceCount", insideOccurrences + outsideOccurrences],
    ["outsideSecondsRatio", ratio(outsideSeconds, insideSeconds + outsideSeconds)],
    ["outsideOccurrenceRatio", ratio(outsideOccurrences, insideOccurrences + outsideOccurrences)],
  ]);
  for (const familyKey of familyKeys) {
    const inside = insideByKey.get(familyKey)?.days ?? [];
    const outside = outsideByKey.get(familyKey)?.days ?? [];
    metrics.set(`insideDays.${familyKey}`, inside.length);
    metrics.set(`outsideDays.${familyKey}`, outside.length);
    metrics.set(`insideTrustedSeconds.${familyKey}`, inside.reduce((sum, day) => sum + day.trustedSeconds, 0));
    metrics.set(`outsideTrustedSeconds.${familyKey}`, outside.reduce((sum, day) => sum + day.trustedSeconds, 0));
    metrics.set(`insideOccurrences.${familyKey}`, inside.reduce((sum, day) => sum + day.occurrenceCount, 0));
    metrics.set(`outsideOccurrences.${familyKey}`, outside.reduce((sum, day) => sum + day.occurrenceCount, 0));
  }
  return { metrics, jointEvidence: { kind: "castle-role-context-v1", families } };
}

const VC_COVERAGE_LIMITATIONS = Object.freeze([
  "The VC source omits unknown/untrusted intervals; zero cannot distinguish observed inactivity from absent coverage.",
  "Choose a window after source rollout; no historical inference or backfill is performed.",
]);
const TC_COVERAGE_LIMITATIONS = Object.freeze([
  "The TC safe source omits unavailable/untrusted observations; zero cannot distinguish inactivity from absent coverage.",
  "Gap values remain unthresholded calibration scalars; no meaningful-conversation boundary is selected.",
]);

const VC_IGNITE_PROBE: CalibrationProbe<readonly ["vc_empty_start_then_joined"]> = {
  candidateNos: Object.freeze([2]),
  probeKey: "vc-ignite-v1",
  sources: ["vc_empty_start_then_joined"],
  emptyPayloads: Object.freeze({ vc_empty_start_then_joined: Object.freeze({ facts: [] }) }),
  coverageLimitations: VC_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureVcIgnite(payloads.vc_empty_start_then_joined, context),
};

const VC_CLOSER_PROBE: CalibrationProbe<readonly ["vc_last_occupant"]> = {
  candidateNos: Object.freeze([7, 9]),
  probeKey: "vc-closer-v1",
  sources: ["vc_last_occupant"],
  emptyPayloads: Object.freeze({ vc_last_occupant: Object.freeze({ facts: [] }) }),
  coverageLimitations: VC_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureVcCloser(payloads.vc_last_occupant, context),
};

const SOCIAL_BREADTH_PROBE: CalibrationProbe<readonly ["vc_social_safe"]> = {
  candidateNos: Object.freeze([23, 24, 25]),
  probeKey: "social-breadth-v1",
  sources: ["vc_social_safe"],
  emptyPayloads: Object.freeze({
    vc_social_safe: Object.freeze({ distinctCoPresentUsers: 0, maxRepeatedDaysWithOneCounterpart: 0, trustedOverlapSeconds: 0, dailyBreadth: [] }),
  }),
  coverageLimitations: VC_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureSocialBreadth(payloads.vc_social_safe, context),
};

const RELATIONSHIP_DEPTH_PROBE: CalibrationProbe<readonly ["vc_social_safe"]> = {
  candidateNos: Object.freeze([28]),
  probeKey: "relationship-depth-v1",
  sources: ["vc_social_safe"],
  emptyPayloads: SOCIAL_BREADTH_PROBE.emptyPayloads,
  coverageLimitations: VC_COVERAGE_LIMITATIONS,
  measure: (payloads) => measureRelationshipDepth(payloads.vc_social_safe),
};

const SOCIAL_CLASS_CONTEXT_PROBE: CalibrationProbe<readonly ["social_class_context_safe"]> = {
  candidateNos: Object.freeze([26]),
  probeKey: "social-class-context-v1",
  sources: ["social_class_context_safe"],
  emptyPayloads: Object.freeze({ social_class_context_safe: Object.freeze({ counterparts: [] }) }),
  coverageLimitations: VC_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureClassContext(payloads.social_class_context_safe, context),
};

const SOCIAL_DEPARTMENT_CONTEXT_PROBE: CalibrationProbe<readonly ["social_department_family_context_safe"]> = {
  candidateNos: Object.freeze([27]),
  probeKey: "social-department-context-v1",
  sources: ["social_department_family_context_safe"],
  emptyPayloads: Object.freeze({ social_department_family_context_safe: Object.freeze({ counterparts: [] }) }),
  coverageLimitations: VC_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureDepartmentContext(payloads.social_department_family_context_safe, context),
};

const BUMP_PROBE: CalibrationProbe<readonly ["bump_events"]> = {
  candidateNos: Object.freeze([38, 39, 40, 41]),
  probeKey: "bump-contribution-v1",
  sources: ["bump_events"],
  emptyPayloads: Object.freeze({ bump_events: Object.freeze({ events: [] }) }),
  coverageLimitations: Object.freeze([
    "BUMP occurrence time is bounded by observedAt, but a later retry may insert an older occurrence; no historical backfill is inferred.",
  ]),
  measure: (payloads, context) => measureBump(payloads.bump_events, context),
};

const EMPTY_TC_CONVERSATION = Object.freeze({
  starts: [], revivalConversations: [], areas: [], thirdPartyJoins: [], startedConversations: [], socialDays: [],
});
const TC_CONVERSATION_PROBE: CalibrationProbe<readonly ["tc_conversation_safe"]> = {
  candidateNos: Object.freeze([42, 43, 44, 45, 47]),
  probeKey: "tc-conversation-v1",
  sources: ["tc_conversation_safe"],
  emptyPayloads: Object.freeze({ tc_conversation_safe: EMPTY_TC_CONVERSATION }),
  coverageLimitations: TC_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureTcConversation(payloads.tc_conversation_safe, context),
};

const TC_REACTION_PROBE: CalibrationProbe<readonly ["tc_reaction_safe"]> = {
  candidateNos: Object.freeze([46]),
  probeKey: "tc-reaction-v1",
  sources: ["tc_reaction_safe"],
  emptyPayloads: Object.freeze({ tc_reaction_safe: Object.freeze({ distinctReactors: 0, posts: [], days: [] }) }),
  coverageLimitations: TC_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureTcReaction(payloads.tc_reaction_safe, context),
};

const CROSS_MODAL_PROBE: CalibrationProbe<readonly ["tc_conversation_safe", "vc_social_safe"]> = {
  candidateNos: Object.freeze([49]),
  probeKey: "cross-modal-v1",
  sources: ["tc_conversation_safe", "vc_social_safe"],
  emptyPayloads: Object.freeze({
    tc_conversation_safe: EMPTY_TC_CONVERSATION,
    vc_social_safe: SOCIAL_BREADTH_PROBE.emptyPayloads.vc_social_safe,
  }),
  coverageLimitations: Object.freeze([...TC_COVERAGE_LIMITATIONS, ...VC_COVERAGE_LIMITATIONS]),
  measure: (payloads, context) => measureCrossModal(payloads.tc_conversation_safe, payloads.vc_social_safe, context),
};

const DOMAIN_COVERAGE_LIMITATIONS = Object.freeze([
  "Safe sources omit unknown/untrusted intervals and pre-rollout history; zero cannot prove complete observed inactivity.",
  "No historical inference or backfill is performed; choose a window after every source used by the pack was deployed.",
]);
const ROLE_COVERAGE_LIMITATIONS = Object.freeze([
  ...DOMAIN_COVERAGE_LIMITATIONS,
  "Unknown role-history coverage is not inferred from current roles or current departments.",
]);
const EVENT_COVERAGE_LIMITATIONS = Object.freeze([
  ...DOMAIN_COVERAGE_LIMITATIONS,
  "Legacy events without canonical role provenance remain participant-only; staff or organizer roles are never inferred.",
]);

const EMPTY_PUBLIC_ROOM = Object.freeze({
  hosted: Object.freeze({ distinctGuests: 0, sessionCount: 0, maxConcurrentGuests: 0, maxRepeatGuestDepth: 0, days: [] }),
  guest: Object.freeze({ distinctOwners: 0, sessionCount: 0, days: [] }),
  ownUse: Object.freeze({ sessionCount: 0, days: [] }),
});
const EMPTY_SOCIAL_TIME = Object.freeze({ days: [] });
const PUBLIC_ROOM_ACTIVITY_PROBE: CalibrationProbe<readonly ["public_room_activity_safe"]> = {
  candidateNos: Object.freeze([50, 51, 52, 53, 54, 55]),
  probeKey: "public-room-activity-v1",
  sources: ["public_room_activity_safe"],
  emptyPayloads: Object.freeze({ public_room_activity_safe: EMPTY_PUBLIC_ROOM }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measurePublicRoomActivity(payloads.public_room_activity_safe, context),
};
const PUBLIC_ROOM_SOCIAL_TIME_PROBE: CalibrationProbe<readonly ["public_room_activity_safe", "social_activity_time_safe"]> = {
  candidateNos: Object.freeze([56]),
  probeKey: "public-room-social-time-v1",
  sources: ["public_room_activity_safe", "social_activity_time_safe"],
  emptyPayloads: Object.freeze({ public_room_activity_safe: EMPTY_PUBLIC_ROOM, social_activity_time_safe: EMPTY_SOCIAL_TIME }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureDomainSocialTime(
    "public-room",
    [
      ...payloads.public_room_activity_safe.hosted.days.map((day) => ({ dayOffset: dateDayOffset(day.date, context.windowStart), semanticIndex: 0, magnitude: day.sessionsWithGuests })),
      ...payloads.public_room_activity_safe.guest.days.map((day) => ({ dayOffset: dateDayOffset(day.date, context.windowStart), semanticIndex: 1, magnitude: day.sessionsVisited })),
      ...payloads.public_room_activity_safe.ownUse.days.map((day) => ({ dayOffset: dateDayOffset(day.date, context.windowStart), semanticIndex: 2, magnitude: day.sessionsUsed })),
    ],
    payloads.social_activity_time_safe,
    context,
  ),
};

const ECONOMY_PEER_ACTIONS_PROBE: CalibrationProbe<readonly ["economy_safe_peer_actions"]> = {
  candidateNos: Object.freeze([58]),
  probeKey: "economy-peer-actions-v1",
  sources: ["economy_safe_peer_actions"],
  emptyPayloads: Object.freeze({ economy_safe_peer_actions: Object.freeze({ facts: [] }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureEconomyPeerActions(payloads.economy_safe_peer_actions, context),
};
const EMPTY_ECONOMY_SEMANTIC = Object.freeze({
  days: [], distinctFamilies: 0, subjectUsedFamilies: [], distinctSubjectUsedFamilies: 0,
  distinctHumanCounterparts: 0, hasNaturalInflow: false, hasNaturalOutflow: false,
  outgoingTip: Object.freeze({ days: [], distinctRecipients: 0 }),
});
const ECONOMY_SEMANTIC_PROBE: CalibrationProbe<readonly ["economy_semantic_safe"]> = {
  candidateNos: Object.freeze([59, 61, 63]),
  probeKey: "economy-semantic-v1",
  sources: ["economy_semantic_safe"],
  emptyPayloads: Object.freeze({ economy_semantic_safe: EMPTY_ECONOMY_SEMANTIC }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureEconomySemantic(payloads.economy_semantic_safe, context),
};
const SHOP_ROLE_PURCHASE_PROBE: CalibrationProbe<readonly ["shop_role_purchase_safe"]> = {
  candidateNos: Object.freeze([65]),
  probeKey: "shop-role-purchase-v1",
  sources: ["shop_role_purchase_safe"],
  emptyPayloads: Object.freeze({ shop_role_purchase_safe: Object.freeze({ days: [] }) }),
  coverageLimitations: ROLE_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureShopRolePurchases(payloads.shop_role_purchase_safe, context),
};
const SHOP_PURCHASE_PROBE: CalibrationProbe<readonly ["shop_purchase_safe"]> = {
  candidateNos: Object.freeze([62]),
  probeKey: "shop-purchase-v1",
  sources: ["shop_purchase_safe"],
  emptyPayloads: Object.freeze({ shop_purchase_safe: Object.freeze({ days: [], distinctEligibleProducts: 0 }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureShopPurchases(payloads.shop_purchase_safe, context),
};

const CASINO_COMPLETED_ACTIVITY_PROBE: CalibrationProbe<readonly ["casino_completed_activity_days"]> = {
  candidateNos: Object.freeze([66, 67]),
  probeKey: "casino-completed-activity-v1",
  sources: ["casino_completed_activity_days"],
  emptyPayloads: Object.freeze({ casino_completed_activity_days: Object.freeze({ activityDays: [] }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureCasinoActivity(payloads.casino_completed_activity_days, context, "completedActivity"),
};
const CASINO_ACTIVITY_PROBE: CalibrationProbe<readonly ["casino_activity_days"]> = {
  candidateNos: Object.freeze([68]),
  probeKey: "casino-activity-v1",
  sources: ["casino_activity_days"],
  emptyPayloads: Object.freeze({ casino_activity_days: Object.freeze({ activityDays: [] }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureCasinoActivity(payloads.casino_activity_days, context, "activity"),
};
const CASINO_EDITION_COMPLETION_PROBE: CalibrationProbe<readonly ["casino_edition_i_completion_safe"]> = {
  candidateNos: Object.freeze([69]),
  probeKey: "casino-edition-completion-v1",
  sources: ["casino_edition_i_completion_safe"],
  emptyPayloads: Object.freeze({
    casino_edition_i_completion_safe: Object.freeze({ editionKey: "casino-edition-i", version: 1, completedFamilies: [], distinctCompletedFamilies: 0, allFamiliesCompleted: false }),
  }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureCasinoEdition(payloads.casino_edition_i_completion_safe, context),
};
const EMPTY_CASINO_TABLE = Object.freeze({ tables: [], guests: [] });
const CASINO_TABLE_ACTIVITY_PROBE: CalibrationProbe<readonly ["casino_table_activity_safe"]> = {
  candidateNos: Object.freeze([70]),
  probeKey: "casino-table-activity-v1",
  sources: ["casino_table_activity_safe"],
  emptyPayloads: Object.freeze({ casino_table_activity_safe: EMPTY_CASINO_TABLE }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads) => measureCasinoTableHosted(payloads.casino_table_activity_safe),
};
const CASINO_TABLE_BUSY_PROBE: CalibrationProbe<readonly ["casino_table_activity_safe"]> = {
  candidateNos: Object.freeze([71]),
  probeKey: "casino-table-busy-v1",
  sources: ["casino_table_activity_safe"],
  emptyPayloads: Object.freeze({ casino_table_activity_safe: EMPTY_CASINO_TABLE }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureCasinoTableBusy(payloads.casino_table_activity_safe, context),
};
const CASINO_MARKET_ACTIVITY_PROBE: CalibrationProbe<readonly ["casino_market_activity_safe"]> = {
  candidateNos: Object.freeze([72]),
  probeKey: "casino-market-activity-v1",
  sources: ["casino_market_activity_safe"],
  emptyPayloads: Object.freeze({ casino_market_activity_safe: Object.freeze({ days: [], distinctOtherStandardBoards: 0 }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureCasinoMarket(payloads.casino_market_activity_safe, context),
};

const CONFIRMED_INVITES_PROBE: CalibrationProbe<readonly ["confirmed_invites"]> = {
  candidateNos: Object.freeze([74, 75]),
  probeKey: "confirmed-invites-v1",
  sources: ["confirmed_invites"],
  emptyPayloads: Object.freeze({ confirmed_invites: Object.freeze({ creditedAt: [] }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureConfirmedInvites(payloads.confirmed_invites, context),
};
const INVITE_ROOTED_PROBE: CalibrationProbe<readonly ["invite_rooted_safe"]> = {
  candidateNos: Object.freeze([76, 77, 78, 79]),
  probeKey: "invite-rooted-v1",
  sources: ["invite_rooted_safe"],
  emptyPayloads: Object.freeze({ invite_rooted_safe: Object.freeze({ profiles: [], unknownEntryAnchorCount: 0 }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads) => measureInviteRooted(payloads.invite_rooted_safe),
};

const PUBLIC_EVENT_COMPLETION_PROBE: CalibrationProbe<readonly ["public_event_completed_participations"]> = {
  candidateNos: Object.freeze([80, 81]),
  probeKey: "public-event-completion-v1",
  sources: ["public_event_completed_participations"],
  emptyPayloads: Object.freeze({ public_event_completed_participations: Object.freeze({ participations: [] }) }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measurePublicEventCompletion(payloads.public_event_completed_participations, context),
};
const PUBLIC_EVENT_CALENDAR_PROBE: CalibrationProbe<readonly ["public_event_calendar_involvement_safe"]> = {
  candidateNos: Object.freeze([82, 83, 84]),
  probeKey: "public-event-calendar-v1",
  sources: ["public_event_calendar_involvement_safe"],
  emptyPayloads: Object.freeze({ public_event_calendar_involvement_safe: Object.freeze({ events: [] }) }),
  coverageLimitations: EVENT_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measurePublicEventCalendar(payloads.public_event_calendar_involvement_safe, context),
};

const EMPTY_CASTLE_EXPERIENCE = Object.freeze({ editionKey: "castle-experience-edition-i", version: 1, families: [], coveredSuperDomains: [] });
const CASTLE_EXPERIENCE_PROBE: CalibrationProbe<readonly ["castle_experience_safe"]> = {
  candidateNos: Object.freeze([85, 86, 89]),
  probeKey: "castle-experience-v1",
  sources: ["castle_experience_safe"],
  emptyPayloads: Object.freeze({ castle_experience_safe: EMPTY_CASTLE_EXPERIENCE }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureCastleExperience(payloads.castle_experience_safe, context),
};
const CASTLE_SOCIAL_TIME_PROBE: CalibrationProbe<readonly ["castle_experience_safe", "social_activity_time_safe"]> = {
  candidateNos: Object.freeze([87, 88]),
  probeKey: "castle-social-time-v1",
  sources: ["castle_experience_safe", "social_activity_time_safe"],
  emptyPayloads: Object.freeze({ castle_experience_safe: EMPTY_CASTLE_EXPERIENCE, social_activity_time_safe: EMPTY_SOCIAL_TIME }),
  coverageLimitations: DOMAIN_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureDomainSocialTime(
    "castle",
    castleFamilyDayRows(payloads.castle_experience_safe, context.windowStart),
    payloads.social_activity_time_safe,
    context,
    payloads.castle_experience_safe.coveredSuperDomains.length,
  ),
};
const EMPTY_CASTLE_ROLE_CONTEXT = Object.freeze({
  editionKey: "castle-role-domain-edition-i", version: 1,
  insideFamilies: [], outsideFamilies: [], roleHeldFamilies: [], outsideDays: [],
});
const CASTLE_ROLE_CONTEXT_PROBE: CalibrationProbe<readonly ["castle_experience_safe", "castle_role_context_safe"]> = {
  candidateNos: Object.freeze([90, 91]),
  probeKey: "castle-role-context-v1",
  sources: ["castle_experience_safe", "castle_role_context_safe"],
  emptyPayloads: Object.freeze({ castle_experience_safe: EMPTY_CASTLE_EXPERIENCE, castle_role_context_safe: EMPTY_CASTLE_ROLE_CONTEXT }),
  coverageLimitations: ROLE_COVERAGE_LIMITATIONS,
  measure: (payloads, context) => measureCastleRoleContext(payloads.castle_experience_safe, payloads.castle_role_context_safe, context),
};

export const F5A_CALIBRATION_PROBES = Object.freeze([runtimeProbe(VC_STYLE_PROBE), runtimeProbe(ACTIVITY_TIME_PROBE)]);
export const F5B1_CALIBRATION_PROBES = Object.freeze([
  runtimeProbe(VC_IGNITE_PROBE),
  runtimeProbe(VC_CLOSER_PROBE),
  runtimeProbe(SOCIAL_BREADTH_PROBE),
  runtimeProbe(RELATIONSHIP_DEPTH_PROBE),
  runtimeProbe(SOCIAL_CLASS_CONTEXT_PROBE),
  runtimeProbe(SOCIAL_DEPARTMENT_CONTEXT_PROBE),
  runtimeProbe(BUMP_PROBE),
  runtimeProbe(TC_CONVERSATION_PROBE),
  runtimeProbe(TC_REACTION_PROBE),
  runtimeProbe(CROSS_MODAL_PROBE),
]);
export const F5B2_CALIBRATION_PROBES = Object.freeze([
  runtimeProbe(PUBLIC_ROOM_ACTIVITY_PROBE),
  runtimeProbe(PUBLIC_ROOM_SOCIAL_TIME_PROBE),
  runtimeProbe(ECONOMY_PEER_ACTIONS_PROBE),
  runtimeProbe(ECONOMY_SEMANTIC_PROBE),
  runtimeProbe(SHOP_ROLE_PURCHASE_PROBE),
  runtimeProbe(SHOP_PURCHASE_PROBE),
  runtimeProbe(CASINO_COMPLETED_ACTIVITY_PROBE),
  runtimeProbe(CASINO_ACTIVITY_PROBE),
  runtimeProbe(CASINO_EDITION_COMPLETION_PROBE),
  runtimeProbe(CASINO_TABLE_ACTIVITY_PROBE),
  runtimeProbe(CASINO_TABLE_BUSY_PROBE),
  runtimeProbe(CASINO_MARKET_ACTIVITY_PROBE),
  runtimeProbe(CONFIRMED_INVITES_PROBE),
  runtimeProbe(INVITE_ROOTED_PROBE),
  runtimeProbe(PUBLIC_EVENT_COMPLETION_PROBE),
  runtimeProbe(PUBLIC_EVENT_CALENDAR_PROBE),
  runtimeProbe(CASTLE_EXPERIENCE_PROBE),
  runtimeProbe(CASTLE_SOCIAL_TIME_PROBE),
  runtimeProbe(CASTLE_ROLE_CONTEXT_PROBE),
]);

/** All SOURCE READY measurement probes, for planning-only F5c analysis. */
export const F5C_CALIBRATION_PROBES = Object.freeze([
  ...F5A_CALIBRATION_PROBES,
  ...F5B1_CALIBRATION_PROBES,
  ...F5B2_CALIBRATION_PROBES,
]);

export function canonicalReadinessHash(readiness: readonly CandidateReadinessAudit[]): string {
  const canonical = readiness.slice().sort((a, b) => a.no - b.no).map((entry) => JSON.stringify({
    no: entry.no,
    status: entry.status,
    usableSources: [...entry.usableSources].sort(),
    thresholdCategory: entry.thresholdCategory,
    optimizationRisk: entry.optimizationRisk,
  })).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function descriptorFor(
  candidateNos: readonly number[],
  sources: readonly TitleUsableSourceKey[],
): CalibrationCandidateDescriptor[] {
  return candidateNos.slice().sort((a, b) => a - b).map((no) => {
    const candidate = TITLE_V2_CATALOG_CANDIDATES.find((entry) => entry.no === no);
    const readiness = TITLE_V2_CATALOG_READINESS.find((entry) => entry.no === no);
    if (!candidate || !readiness) throw new Error(`unknown calibration candidate #${no}`);
    if (readiness.status !== "READY" || readiness.usableSources.some((source) => !sources.includes(source))) {
      throw new Error(`calibration probe source/readiness mismatch for candidate #${no}`);
    }
    return { no, provisionalKey: candidate.provisionalKey, readiness: readiness.status, thresholdCategory: readiness.thresholdCategory };
  });
}

function packSnapshot(
  probe: CalibrationProbeRuntime,
  measurements: readonly PlanningCalibrationPackMeasurement[],
  readCalls: number,
  windowStart: number,
): CalibrationPackSnapshot {
  // Empty cohortでもpack schemaを省略しない。全source payloadのcanonical zero shapeは{days:[]}。
  const zeroMeasurement = probe.measureEmpty({ windowStart });
  const metricKeys = [...new Set([
    ...zeroMeasurement.metrics.keys(),
    ...measurements.flatMap((measurement) => Object.keys(measurement.metrics)),
  ])].sort();
  const metrics = metricKeys.map((metricKey) => ({
    metricKey,
    distribution: summarizeNumericDistribution(measurements.map((measurement) => measurement.metrics[metricKey] ?? null)),
  }));
  const gapsByHour = new Map<number, number[]>(Array.from({ length: 24 }, (_, hour) => [hour, []]));
  for (const measurement of measurements) {
    for (const { hour, values } of measurement.tcGapsByHour) gapsByHour.get(hour)!.push(...values);
  }
  const allGaps = [...gapsByHour.values()].flat();
  const warnings: CalibrationPackSnapshot["warnings"] = measurements.length === 0
    ? ["NO_SUBJECTS", "SOURCE_OMITS_UNKNOWN_COVERAGE"]
    : ["SOURCE_OMITS_UNKNOWN_COVERAGE"];
  return {
    probeKey: probe.probeKey,
    calibrationMode: "DISTRIBUTION_CALIBRATION",
    candidateNos: probe.candidateNos,
    candidates: descriptorFor(probe.candidateNos, probe.sources),
    sources: probe.sources,
    readCalls,
    metrics,
    tcGapOverall: probe.probeKey === "activity-time-v1" ? summarizeNumericDistribution(allGaps) : null,
    tcGapByHour: probe.probeKey === "activity-time-v1"
      ? [...gapsByHour].map(([hour, values]) => ({ hour, distribution: summarizeNumericDistribution(values) }))
      : [],
    coverageKnown: false,
    coverageLimitations: probe.coverageLimitations,
    warnings,
  };
}

function requireCohortKey(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) throw new TypeError("cohortKey must be non-empty and trimmed");
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function runF5aCalibrationSnapshot(
  db: Database.Database,
  input: F5aCalibrationInput,
): CalibrationSnapshot {
  return snapshotFromMeasurementCollection(collectF5aCalibrationMeasurements(db, input), F5A_CALIBRATION_PROBES);
}

/** Restricted planning API: callers may inspect subject correlations in memory but must emit aggregates only. */
export function collectF5aCalibrationMeasurements(
  db: Database.Database,
  input: F5aCalibrationInput,
): PlanningCalibrationMeasurementCollection {
  return collectCalibrationMeasurements(db, input, F5A_CALIBRATION_PROBES);
}

export function runF5b1CalibrationSnapshot(
  db: Database.Database,
  input: F5aCalibrationInput,
): CalibrationSnapshot {
  return snapshotFromMeasurementCollection(collectF5b1CalibrationMeasurements(db, input), F5B1_CALIBRATION_PROBES);
}

/** Restricted planning API for F5b1. Joint evidence is identity-minimized and never serialized. */
export function collectF5b1CalibrationMeasurements(
  db: Database.Database,
  input: F5aCalibrationInput,
): PlanningCalibrationMeasurementCollection {
  return collectCalibrationMeasurements(db, input, F5B1_CALIBRATION_PROBES);
}

export function runF5b2CalibrationSnapshot(
  db: Database.Database,
  input: F5aCalibrationInput,
): CalibrationSnapshot {
  return snapshotFromMeasurementCollection(collectF5b2CalibrationMeasurements(db, input), F5B2_CALIBRATION_PROBES);
}

/** Restricted planning API for F5b2. Identity-minimized joint evidence is never serialized. */
export function collectF5b2CalibrationMeasurements(
  db: Database.Database,
  input: F5aCalibrationInput,
): PlanningCalibrationMeasurementCollection {
  return collectCalibrationMeasurements(db, input, F5B2_CALIBRATION_PROBES);
}

/**
 * Restricted planning API for F5c. All 31 probes share one source cache and one
 * deterministic cohort/window/observedAt boundary. Never serialize this result.
 */
export function collectF5cCalibrationMeasurements(
  db: Database.Database,
  input: F5aCalibrationInput,
): PlanningCalibrationMeasurementCollection {
  return collectCalibrationMeasurements(db, input, F5C_CALIBRATION_PROBES);
}

/** Actual zero-payload output contract used to audit F5c metric/joint selectors. */
export function describeF5cCalibrationProbeContracts(
  windowStart = 0,
): readonly CalibrationProbeMeasurementContract[] {
  return deepFreeze(F5C_CALIBRATION_PROBES.map((probe) => {
    const measurement = probe.measureEmpty({ windowStart });
    return {
      probeKey: probe.probeKey,
      candidateNos: [...probe.candidateNos].sort((a, b) => a - b),
      metricKeys: [...measurement.metrics.keys()].sort(),
      jointEvidenceKind: measurement.jointEvidence?.kind ?? "none",
    };
  }).sort((a, b) => a.probeKey.localeCompare(b.probeKey)));
}

function collectCalibrationMeasurements(
  db: Database.Database,
  input: F5aCalibrationInput,
  probes: readonly CalibrationProbeRuntime[],
): PlanningCalibrationMeasurementCollection {
  const scope = resolvePlanningCalibrationScope(input.window);
  const cohortKey = requireCohortKey(input.cohortKey);
  const subjectUserIds = [...new Set(input.subjectUserIds)].sort();
  const cache = new TitleSourceCache();
  const packsBySubject = new Map(subjectUserIds.map((subjectUserId) => [subjectUserId, [] as PlanningCalibrationPackMeasurement[]]));
  const uniqueSources = [...new Set(probes.flatMap(({ sources }) => sources))].sort();
  const sourceReadCalls = uniqueSources.map((source) => {
    const prefetched = prefetchIntoTitleSourceCache(cache, db, source, subjectUserIds, scope);
    return { source, readCalls: prefetched.readCalls };
  });
  const sourceReadCallMap = new Map(sourceReadCalls.map(({ source, readCalls }) => [source, readCalls]));
  for (const probe of probes) {
    for (const subjectUserId of subjectUserIds) {
      const measurement = probe.measureFrom(
        (source) => getFromTitleSourceCache(cache, db, source, subjectUserId, scope),
        { windowStart: scope.start },
      );
      const metrics = Object.fromEntries([...measurement.metrics].sort(([a], [b]) => a.localeCompare(b)));
      const tcGapsByHour = [...(measurement.tcGapsByHour ?? [])]
        .sort(([a], [b]) => a - b)
        .map(([hour, values]) => ({ hour, values: [...values] }));
      packsBySubject.get(subjectUserId)!.push({
        probeKey: probe.probeKey,
        metrics,
        tcGapsByHour,
        jointEvidence: measurement.jointEvidence ?? { kind: "none" },
      });
    }
  }
  const packReadCalls = probes.map((probe) => ({
    probeKey: probe.probeKey,
    readCalls: probe.sources.reduce((sum, source) => sum + (sourceReadCallMap.get(source) ?? 0), 0),
  })).sort((a, b) => a.probeKey.localeCompare(b.probeKey));
  return deepFreeze({
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    percentileMethod: CALIBRATION_PERCENTILE_METHOD,
    catalogHash: canonicalCatalogHash(TITLE_V2_CATALOG_CANDIDATES),
    readinessHash: canonicalReadinessHash(TITLE_V2_CATALOG_READINESS),
    catalogCandidateCount: TITLE_V2_CATALOG_CANDIDATES.length,
    cohort: { key: cohortKey, subjectCount: subjectUserIds.length },
    window: {
      start: scope.start,
      end: input.window.end,
      observedAt: scope.observedAt,
      effectiveEnd: resolvedScopeEffectiveEnd(scope),
    },
    packReadCalls,
    sourceReadCalls,
    subjects: subjectUserIds.map((subjectUserId) => ({
      subjectUserId,
      packs: packsBySubject.get(subjectUserId)!.sort((a, b) => a.probeKey.localeCompare(b.probeKey)),
    })),
  });
}

function snapshotFromMeasurementCollection(
  collection: PlanningCalibrationMeasurementCollection,
  probes: readonly CalibrationProbeRuntime[],
): CalibrationSnapshot {
  const packs = probes.map((probe) => {
    const measurements = collection.subjects.map((subject) => subject.packs.find(({ probeKey }) => probeKey === probe.probeKey)!);
    const readCalls = collection.packReadCalls.find(({ probeKey }) => probeKey === probe.probeKey)!.readCalls;
    return packSnapshot(probe, measurements, readCalls, collection.window.start);
  }).sort((a, b) => a.probeKey.localeCompare(b.probeKey));
  return deepFreeze({
    schemaVersion: collection.schemaVersion,
    percentileMethod: collection.percentileMethod,
    catalogHash: collection.catalogHash,
    readinessHash: collection.readinessHash,
    catalogCandidateCount: collection.catalogCandidateCount,
    cohort: collection.cohort,
    window: collection.window,
    packs,
  });
}

/** Construction order is canonical, so plain JSON.stringify is byte-stable for schema v1. */
export function serializeCalibrationSnapshot(snapshot: CalibrationSnapshot): string {
  return JSON.stringify(snapshot);
}

export function compareCalibrationSnapshots(a: CalibrationSnapshot, b: CalibrationSnapshot): CalibrationSnapshotComparison {
  const differences: CalibrationSnapshotComparison["differences"][number][] = [];
  if (a.schemaVersion !== b.schemaVersion) differences.push("SCHEMA_VERSION");
  if (a.catalogHash !== b.catalogHash) differences.push("CATALOG_HASH");
  if (a.readinessHash !== b.readinessHash) differences.push("READINESS_HASH");
  if (JSON.stringify(a.cohort) !== JSON.stringify(b.cohort)) differences.push("COHORT");
  if (JSON.stringify(a.window) !== JSON.stringify(b.window)) differences.push("WINDOW");
  return deepFreeze({ compatible: differences.length === 0, differences });
}
