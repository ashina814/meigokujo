import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { OccupancyBucket } from "../vc/derived.js";
import { resolvePlanningCalibrationScope, resolvedScopeEffectiveEnd } from "./v2-scope.js";
import {
  getFromTitleSourceCache,
  prefetchIntoTitleSourceCache,
  TitleSourceCache,
  type SocialActivityTimeSafeSourcePayload,
  type TitleSourcePayloads,
  type VcGroupSizeDailySafeSourcePayload,
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
  readonly probeKey: "vc-style-v1" | "activity-time-v1";
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
}

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
  readonly subjects: readonly PlanningCalibrationSubjectMeasurement[];
}

interface SubjectMeasurement {
  readonly metrics: ReadonlyMap<string, number | null>;
  readonly tcGapsByHour?: ReadonlyMap<number, readonly number[]>;
}

interface CalibrationProbe<K extends TitleUsableSourceKey> {
  readonly candidateNos: readonly number[];
  readonly probeKey: CalibrationPackSnapshot["probeKey"];
  readonly sources: readonly [K];
  readonly emptyPayload: TitleSourcePayloads[K];
  readonly coverageLimitations: readonly string[];
  measure(payload: TitleSourcePayloads[K], context: { readonly windowStart: number }): SubjectMeasurement;
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

function measureActivityTime(payload: SocialActivityTimeSafeSourcePayload): SubjectMeasurement {
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
  return { metrics, tcGapsByHour: tcGaps };
}

const VC_STYLE_PROBE: CalibrationProbe<"vc_group_size_daily_safe"> = {
  candidateNos: Object.freeze(Array.from({ length: 12 }, (_, index) => index + 10)),
  probeKey: "vc-style-v1",
  sources: ["vc_group_size_daily_safe"],
  emptyPayload: Object.freeze({ days: [] }),
  coverageLimitations: Object.freeze([
    "The safe source omits unknown/untrusted VC intervals; zero cannot distinguish observed inactivity from absent coverage.",
    "Choose a window after source rollout; no historical inference or backfill is performed.",
  ]),
  measure: measureVcStyle,
};

const ACTIVITY_TIME_PROBE: CalibrationProbe<"social_activity_time_safe"> = {
  candidateNos: Object.freeze([32, 33, 34, 35, 36, 37]),
  probeKey: "activity-time-v1",
  sources: ["social_activity_time_safe"],
  emptyPayload: Object.freeze({ days: [] }),
  coverageLimitations: Object.freeze([
    "TC stores the best same-surface exchange gap per JST date/hour, not a thresholded meaningful-activity boolean or raw message count.",
    "VC and TC omit unknown/untrusted coverage; zero cannot distinguish observed inactivity from absent coverage.",
    "The 24 JST hour bins are measurement resolution only; no morning/afternoon/evening/night boundary is selected.",
  ]),
  measure: measureActivityTime,
};

export const F5A_CALIBRATION_PROBES = Object.freeze([VC_STYLE_PROBE, ACTIVITY_TIME_PROBE]);

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

function descriptorFor(candidateNos: readonly number[], source: TitleUsableSourceKey): CalibrationCandidateDescriptor[] {
  return candidateNos.slice().sort((a, b) => a - b).map((no) => {
    const candidate = TITLE_V2_CATALOG_CANDIDATES.find((entry) => entry.no === no);
    const readiness = TITLE_V2_CATALOG_READINESS.find((entry) => entry.no === no);
    if (!candidate || !readiness) throw new Error(`unknown calibration candidate #${no}`);
    if (readiness.status !== "READY" || !readiness.usableSources.includes(source)) {
      throw new Error(`calibration probe source/readiness mismatch for candidate #${no}`);
    }
    return { no, provisionalKey: candidate.provisionalKey, readiness: readiness.status, thresholdCategory: readiness.thresholdCategory };
  });
}

function packSnapshot<K extends TitleUsableSourceKey>(
  probe: CalibrationProbe<K>,
  measurements: readonly PlanningCalibrationPackMeasurement[],
  readCalls: number,
  windowStart: number,
): CalibrationPackSnapshot {
  // Empty cohortでもpack schemaを省略しない。全source payloadのcanonical zero shapeは{days:[]}。
  const zeroMeasurement = probe.measure(probe.emptyPayload, { windowStart });
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
    candidates: descriptorFor(probe.candidateNos, probe.sources[0]),
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
  return snapshotFromMeasurementCollection(collectF5aCalibrationMeasurements(db, input));
}

/** Restricted planning API: callers may inspect subject correlations in memory but must emit aggregates only. */
export function collectF5aCalibrationMeasurements(
  db: Database.Database,
  input: F5aCalibrationInput,
): PlanningCalibrationMeasurementCollection {
  const scope = resolvePlanningCalibrationScope(input.window);
  const cohortKey = requireCohortKey(input.cohortKey);
  const subjectUserIds = [...new Set(input.subjectUserIds)].sort();
  const cache = new TitleSourceCache();
  const packsBySubject = new Map(subjectUserIds.map((subjectUserId) => [subjectUserId, [] as PlanningCalibrationPackMeasurement[]]));
  const packReadCalls = F5A_CALIBRATION_PROBES.map((probe) => {
    const source = probe.sources[0];
    const typedProbe = probe as CalibrationProbe<typeof source>;
    const prefetched = prefetchIntoTitleSourceCache(cache, db, source, subjectUserIds, scope);
    for (const subjectUserId of subjectUserIds) {
      const payload = getFromTitleSourceCache(cache, db, source, subjectUserId, scope);
      const measurement = typedProbe.measure(payload, { windowStart: scope.start });
      const metrics = Object.fromEntries([...measurement.metrics].sort(([a], [b]) => a.localeCompare(b)));
      const tcGapsByHour = [...(measurement.tcGapsByHour ?? [])]
        .sort(([a], [b]) => a - b)
        .map(([hour, values]) => ({ hour, values: [...values] }));
      packsBySubject.get(subjectUserId)!.push({ probeKey: probe.probeKey, metrics, tcGapsByHour });
    }
    return { probeKey: probe.probeKey, readCalls: prefetched.readCalls };
  }).sort((a, b) => a.probeKey.localeCompare(b.probeKey));
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
    subjects: subjectUserIds.map((subjectUserId) => ({
      subjectUserId,
      packs: packsBySubject.get(subjectUserId)!.sort((a, b) => a.probeKey.localeCompare(b.probeKey)),
    })),
  });
}

function snapshotFromMeasurementCollection(collection: PlanningCalibrationMeasurementCollection): CalibrationSnapshot {
  const packs = F5A_CALIBRATION_PROBES.map((probe) => {
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
