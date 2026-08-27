import type Database from "better-sqlite3";
import {
  F5C_CANDIDATE_SWEEP_PLANS,
  type F5cCandidateSweepPlan,
  type F5cEvaluationShape,
  type F5cFixedCriterion,
  type F5cManifestCriterion,
  type F5cRowGroupCompositionMode,
  type F5cSweepAxis,
} from "./v2-calibration-sweep.js";
import {
  collectF5cCalibrationMeasurements,
  nearestRankPercentile,
  type F5aCalibrationInput,
  type PlanningCalibrationJointEvidence,
  type PlanningCalibrationMeasurementCollection,
  type PlanningCalibrationSubjectMeasurement,
} from "./v2-calibration.js";
import type { CandidateReadinessAudit } from "./v2-catalog-readiness.js";

/**
 * F5c2: shadow-calibration executor. Planning/operator-internal only — never import from
 * evaluator, pipeline, Bot, or the public v2 barrel. Consumes the merged F5c1 sweep contract
 * (`F5C_CANDIDATE_SWEEP_PLANS`) and the deterministic F5c measurement collection
 * (`collectF5cCalibrationMeasurements`) without re-encoding candidate semantics — every typed
 * F5c1 construct (fixedCriteria/manifestCriteria/axes/rowGroupCompositions/reducerKind) is
 * executed as-authored. If a case genuinely cannot be executed from the current contract, the
 * candidate is reported as `UNSUPPORTED_GAP` with a precise reason — it is never silently
 * skipped and never given an invented/easier semantic.
 *
 * No production threshold is selected here. Boundary exploration uses a fixed, finite,
 * reproducible nearest-rank percentile grid (`F5C2_BOUNDARY_PERCENTILES`) over the *observed*
 * calibration population — the same percentile method F5a-c already use
 * (`CALIBRATION_PERCENTILE_METHOD`). No subject identity or raw restricted evidence is ever
 * included in the returned report — only aggregate counts/rates.
 */
export const F5C2_SHADOW_CONTRACT_VERSION = 1 as const;

/** Finite, bounded, reproducible, auditable — not a production threshold grid. */
export const F5C2_BOUNDARY_PERCENTILES = [10, 25, 50, 75, 90] as const;
export type F5cBoundaryPercentile = (typeof F5C2_BOUNDARY_PERCENTILES)[number];
/** The single illustrative combination used for the plan-level MATCHED/NOT_MATCHED call. */
const F5C2_REPRESENTATIVE_PERCENTILE: F5cBoundaryPercentile = 50;

/**
 * UNKNOWN is never collapsed into false/zero. A criterion/axis is UNKNOWN for a subject when
 * the underlying metric is `null` (this codebase's existing convention for "structurally not
 * computable for this subject", e.g. no positive days exist so a day-offset stat is undefined)
 * or when a joint-evidence row group has zero raw rows for that subject (no evidence to
 * evaluate at all, as opposed to evidence that was evaluated and did not qualify).
 */
export type F5cShadowOutcome = "MATCHED" | "NOT_MATCHED" | "UNKNOWN";

function combineOutcomes(outcomes: readonly F5cShadowOutcome[]): F5cShadowOutcome {
  if (outcomes.length === 0) return "UNKNOWN";
  if (outcomes.some((o) => o === "UNKNOWN")) return "UNKNOWN";
  return outcomes.every((o) => o === "MATCHED") ? "MATCHED" : "NOT_MATCHED";
}

export interface F5cBoundarySweepPoint {
  readonly percentile: F5cBoundaryPercentile;
  readonly boundaryValue: number;
  readonly knownCount: number;
  readonly passingCount: number;
  readonly passRate: number | null;
}

export interface F5cAxisSweepResult {
  readonly axisKey: string;
  readonly reducerKind: F5cSweepAxis["reducerKind"];
  /** Underlying observed sample count the percentile grid was derived from (rows or subjects). */
  readonly observedSampleCount: number;
  readonly boundaryPoints: readonly F5cBoundarySweepPoint[];
  /** Only for CIRCULAR_HOUR_WINDOW axes: qualifying-row count per JST hour bin (0-23), no window chosen. */
  readonly hourHistogram: readonly number[] | null;
}

export type F5cExecutionStrategy =
  | "FIXED_CRITERIA"
  | "MANIFEST_CRITERIA"
  | "METRIC_AXIS_SWEEP"
  | "JOINT_EVIDENCE_SWEEP"
  | "STRUCTURAL_PLUS_DISTRIBUTION"
  | "UNSUPPORTED_GAP";

export interface F5cCandidateShadowResult {
  readonly candidateNo: number;
  readonly provisionalKey: string;
  readonly evaluationShape: F5cEvaluationShape;
  readonly thresholdCategory: CandidateReadinessAudit["thresholdCategory"];
  readonly executionStrategy: F5cExecutionStrategy;
  readonly populationCount: number;
  readonly knownCount: number;
  readonly unknownCount: number;
  readonly matchedCount: number;
  readonly notMatchedCount: number;
  /** matchedCount / knownCount at the representative (median) boundary combination; null if knownCount===0. */
  readonly prevalence: number | null;
  readonly axisSweeps: readonly F5cAxisSweepResult[];
  readonly unsupportedReason: string | null;
}

export interface F5cShadowCalibrationReport {
  readonly contractVersion: typeof F5C2_SHADOW_CONTRACT_VERSION;
  readonly sweepContractVersion: number;
  readonly cohort: { readonly key: string; readonly subjectCount: number };
  readonly window: PlanningCalibrationMeasurementCollection["window"];
  readonly readyCandidateCount: number;
  readonly executedCandidateCount: number;
  readonly unsupportedCandidateCount: number;
  readonly results: readonly F5cCandidateShadowResult[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function boundaryValuesFor(samples: readonly number[]): ReadonlyMap<F5cBoundaryPercentile, number> {
  const result = new Map<F5cBoundaryPercentile, number>();
  for (const percentile of F5C2_BOUNDARY_PERCENTILES) {
    const value = nearestRankPercentile(samples, percentile);
    if (value !== null) result.set(percentile, value);
  }
  return result;
}

function passes(operator: "AT_LEAST" | "AT_MOST", value: number, boundary: number): boolean {
  return operator === "AT_LEAST" ? value >= boundary : value <= boundary;
}

// ─────────────────────────────────────────────────────────────
// raw row model for JOINT_EVIDENCE resolution
// ─────────────────────────────────────────────────────────────

interface RawRow {
  readonly dayOffset: number | null;
  /** numeric sample for SCALAR_SAMPLE filters / FILTER_THEN_SHARE magnitude. */
  readonly sampleValue: number | null;
  /** distinct-member identity for SET_BREADTH (e.g. "profile:3", "area:2"). */
  readonly memberKey: string | null;
  /** sub-group identity for REPEAT_PERIOD/GROUP_FILTER_THEN_MAX (e.g. "family:2"). */
  readonly groupKey: string | null;
  /** left/right identity for POST_FILTER_MATCHING_SIZE bipartite edges. */
  readonly edgeLeftKey: string | null;
  readonly edgeRightKey: string | null;
  /**
   * Position within THIS selector's own extraction, stamped by `rowGroupRawRowsFor()`. Every
   * selector within one row group maps 1:1, same order, over the same underlying joint-evidence
   * array (see `resolveJointRows()`), so `rowIndex` is the correct cross-selector correspondence
   * key for row-group composition — NOT object identity (each selector produces fresh objects)
   * and NOT dayOffset (which can repeat across distinct rows, e.g. two conversation starts on
   * the same day).
   */
  readonly rowIndex: number;
}

function row(partial: Partial<RawRow>): RawRow {
  return {
    dayOffset: partial.dayOffset ?? null,
    sampleValue: partial.sampleValue ?? null,
    memberKey: partial.memberKey ?? null,
    groupKey: partial.groupKey ?? null,
    edgeLeftKey: partial.edgeLeftKey ?? null,
    edgeRightKey: partial.edgeRightKey ?? null,
    rowIndex: -1, // stamped by rowGroupRawRowsFor(); see RawRow.rowIndex doc.
  };
}

/**
 * Maps (jointEvidenceKind, selector) to the subject's raw row set for that selector, entirely
 * unfiltered. This is the ONLY place F5c2 interprets what an F5c1 selector string means
 * structurally — every mapping here corresponds 1:1 to how `v2-calibration-sweep.ts` actually
 * authored that selector's axis (row group, reducer kind, operator). Selectors not reachable
 * by any READY-76 axis/fixedCriteria are intentionally absent.
 */
function resolveJointRows(evidence: PlanningCalibrationJointEvidence, selector: string): readonly RawRow[] {
  switch (evidence.kind) {
    case "activity-time-day-hour-v1":
      switch (selector) {
        case "rows.tc-gap":
          return evidence.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.tcBestOtherGapMs }));
        case "rows.vc-seconds":
          return evidence.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.vcTrustedSocialSeconds }));
        case "rows.day-hour-social-evidence":
          return evidence.rows.map((r) => row({ dayOffset: r.dayOffset }));
        case "rows.daypart-share":
          // share denominator/numerator both use vcTrustedSocialSeconds magnitude.
          return evidence.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.vcTrustedSocialSeconds }));
        case "rows.daypart-boundary":
        case "rows.activity-start-hour":
          return evidence.rows.map((r) => row({ dayOffset: r.dayOffset, sampleValue: r.hour }));
        default:
          return [];
      }
    case "day-occurrences-v1":
      if (selector !== "dayOffsets.calendar-periods") return [];
      // Bounded, deterministic period grouping: 7-day buckets relative to window start.
      return evidence.dayOffsets.map((offset) => row({ dayOffset: offset, memberKey: `period:${Math.floor(offset / 7)}` }));
    case "social-context-graph-v1": {
      const edges = evidence.counterparts.flatMap((counterpart) =>
        counterpart.touches.map((touch) => ({
          left: `counterpart:${counterpart.counterpartOrdinal}`,
          right: `semantic:${touch.semanticIndex}`,
          seconds: touch.days.reduce((sum, day) => sum + day.trustedSeconds, 0),
          dayOffset: touch.days.length > 0 ? touch.days[0]!.dayOffset : null,
        })),
      );
      if (selector === "counterparts.semantic-touch-days-seconds" || selector === "counterparts.maximum-matching") {
        return edges.map((edge) => row({
          dayOffset: edge.dayOffset,
          sampleValue: edge.seconds,
          edgeLeftKey: edge.left,
          edgeRightKey: edge.right,
        }));
      }
      return [];
    }
    case "tc-conversation-v1":
      switch (selector) {
        case "starts.quiet-before":
          return evidence.starts.map((s) => row({ dayOffset: s.dayOffset, sampleValue: s.quietBeforeMs }));
        case "starts.next-other-gap":
          return evidence.starts.map((s) => row({ dayOffset: s.dayOffset, sampleValue: s.nextOtherGapMs }));
        case "starts.day-offset":
          return evidence.starts.map((s) => row({ dayOffset: s.dayOffset }));
        case "revivals.dormant-before":
          return evidence.revivalConversations.flatMap((c) => c.revivals.map((r) => row({
            dayOffset: r.dayOffset, sampleValue: r.dormantBeforeMs, memberKey: `conversation:${c.conversationOrdinal}`,
          })));
        case "revivals.continuation-gap":
          return evidence.revivalConversations.flatMap((c) => c.revivals.map((r) => row({
            dayOffset: r.dayOffset, sampleValue: r.continuationGapMs, memberKey: `conversation:${c.conversationOrdinal}`,
          })));
        case "revivals.conversation-group":
          return evidence.revivalConversations.flatMap((c) => c.revivals.map((r) => row({
            dayOffset: r.dayOffset, memberKey: `conversation:${c.conversationOrdinal}`,
          })));
        case "revivals.day-offset":
          return evidence.revivalConversations.flatMap((c) => c.revivals.map((r) => row({ dayOffset: r.dayOffset })));
        case "areas.surface-local-social-days":
          return evidence.areas.flatMap((a) => a.socialDays.map((d) => row({
            dayOffset: d.dayOffset, memberKey: `area:${a.areaOrdinal}`,
          })));
        case "areas.best-other-gap":
          return evidence.areas.flatMap((a) => a.socialDays.map((d) => row({
            dayOffset: d.dayOffset, sampleValue: d.bestOtherGapMs, memberKey: `area:${a.areaOrdinal}`,
          })));
        case "third-party.prior-distinct-others":
          return evidence.thirdPartyJoins.map((j) => row({ dayOffset: j.dayOffset, sampleValue: j.priorDistinctOtherGapMs.length }));
        case "third-party.next-other-gap":
          return evidence.thirdPartyJoins.map((j) => row({ dayOffset: j.dayOffset, sampleValue: j.nextOtherGapMs }));
        case "third-party.day-offset":
          return evidence.thirdPartyJoins.map((j) => row({ dayOffset: j.dayOffset }));
        default:
          return [];
      }
    case "tc-reaction-posts-v1":
      switch (selector) {
        case "posts.post-breadth":
          return evidence.posts.map((p) => row({ memberKey: `post:${p.postOrdinal}` }));
        case "posts.day-breadth":
          return evidence.posts.flatMap((p) => p.reactionDayOffsets.map((offset) => row({ dayOffset: offset, memberKey: `post:${p.postOrdinal}` })));
        case "posts.reactor-breadth":
          // Cross-post reactor identity is not present in the safe joint evidence (only a
          // per-post count) — a genuine data-model limit, not an F5c2 shortcut. We treat each
          // post's distinctReactors as a group's member count and report the single largest
          // post as a defensible lower-bound breadth indicator (see docs §14.10).
          return evidence.posts.map((p) => row({ groupKey: `post:${p.postOrdinal}`, sampleValue: p.distinctReactors }));
        default:
          return [];
      }
    case "cross-modal-days-v1":
      switch (selector) {
        case "tc-days.gap":
          return evidence.tcDays.map((d) => row({ dayOffset: d.dayOffset, sampleValue: d.bestOtherGapMs }));
        case "tc-days.day-offset":
          return evidence.tcDays.map((d) => row({ dayOffset: d.dayOffset }));
        case "vc-days.breadth":
          return evidence.vcDays.map((d) => row({ dayOffset: d.dayOffset, sampleValue: d.distinctCoPresentUsers }));
        case "vc-days.day-offset":
          return evidence.vcDays.map((d) => row({ dayOffset: d.dayOffset }));
        default:
          return [];
      }
    case "domain-social-time-v1":
      if (selector !== "domainDays.public-room-own-use") return [];
      // semanticIndex 2 = ownUse for the public-room-social-time-v1 probe (see v2-calibration.ts).
      return evidence.domainDays.filter((d) => d.semanticIndex === 2).map((d) => row({ dayOffset: d.dayOffset, sampleValue: d.magnitude }));
    case "invite-rooted-v1":
      switch (selector) {
        case "profiles.branch-activity-days":
          return evidence.profiles.flatMap((p) => p.activityDays.map((d) => row({
            dayOffset: d.dayOffset, memberKey: `profile:${p.profileOrdinal}`,
          })));
        case "profiles.branch-social-evidence":
          return evidence.profiles.flatMap((p) => p.activityDays.map((d) => row({
            dayOffset: d.dayOffset, sampleValue: d.vcTrustedSocialSeconds, memberKey: `profile:${p.profileOrdinal}`,
          })));
        case "profiles.next-generation-same-day-gap":
          return evidence.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
            dayOffset: o.entryDayOffset, sampleValue: o.tcBestOtherGapMs, memberKey: `profile:${p.profileOrdinal}`,
          })));
        case "profiles.next-generation-same-day-seconds":
          return evidence.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
            dayOffset: o.entryDayOffset, sampleValue: o.vcTrustedSocialSeconds, memberKey: `profile:${p.profileOrdinal}`,
          })));
        case "profiles.next-generation-occurrence":
        case "profiles.root-before-child":
        case "profiles.same-day-before-entry":
          // Each entry in nextGenerationOccurrences[] is only ever populated by the probe for
          // occurrences that already satisfy root-before-child + same-day-before-entry
          // chronology — presence of a row IS the structural fact, by construction.
          return evidence.profiles.flatMap((p) => p.nextGenerationOccurrences.map((o) => row({
            dayOffset: o.entryDayOffset, memberKey: `profile:${p.profileOrdinal}`,
          })));
        case "profiles.independent-rooted-branches":
          return evidence.profiles.map((p) => row({ memberKey: `profile:${p.profileOrdinal}` }));
        case "profiles.reunion-days":
          return evidence.profiles.flatMap((p) => p.reunionDays.map((d) => row({
            dayOffset: d.dayOffset, memberKey: `profile:${p.profileOrdinal}`,
          })));
        case "profiles.reunion-pair-social-evidence":
          return evidence.profiles.flatMap((p) => p.reunionDays.map((d) => row({
            dayOffset: d.dayOffset, sampleValue: d.vcTrustedPairSeconds, memberKey: `profile:${p.profileOrdinal}`,
          })));
        default:
          return [];
      }
    case "castle-role-context-v1":
      switch (selector) {
        case "families.role-held-days":
          return evidence.families.filter((f) => f.roleHeldDays.length > 0).map((f) => row({ memberKey: `family:${f.semanticIndex}` }));
        case "families.inside-days":
          return evidence.families.filter((f) => f.insideDays.length > 0).map((f) => row({ memberKey: `family:${f.semanticIndex}` }));
        case "families.outside-days":
          return evidence.families.flatMap((f) => f.outsideDays.map((d) => row({
            dayOffset: d.dayOffset, sampleValue: d.trustedSeconds, groupKey: `family:${f.semanticIndex}`,
          })));
        case "families.outside-repeat-days":
          return evidence.families.flatMap((f) => f.outsideDays.map((d) => row({
            dayOffset: d.dayOffset, groupKey: `family:${f.semanticIndex}`,
          })));
        default:
          return [];
      }
    default:
      return [];
  }
}

function packForProbe(subject: PlanningCalibrationSubjectMeasurement, probeKey: string): PlanningCalibrationJointEvidence | null {
  const pack = subject.packs.find((p) => p.probeKey === probeKey);
  return pack?.jointEvidence ?? null;
}

function metricForProbe(subject: PlanningCalibrationSubjectMeasurement, probeKey: string, metricKey: string): number | null | undefined {
  const pack = subject.packs.find((p) => p.probeKey === probeKey);
  if (!pack) return undefined;
  return pack.metrics[metricKey];
}

// ─────────────────────────────────────────────────────────────
// fixed / manifest criteria evaluation (deterministic, no boundary grid)
// ─────────────────────────────────────────────────────────────

function evaluateFixedCriterion(
  criterion: F5cFixedCriterion,
  subject: PlanningCalibrationSubjectMeasurement,
  probeKey: string,
  jointRowsFor: (selector: string) => readonly RawRow[],
): F5cShadowOutcome {
  if (criterion.kind === "METRIC_COMPARE") {
    const value = metricForProbe(subject, probeKey, criterion.metricKey);
    if (value === undefined) return "UNKNOWN";
    if (value === null) return "UNKNOWN";
    if (criterion.operator === "GTE") return value >= criterion.fixedValue ? "MATCHED" : "NOT_MATCHED";
    if (criterion.operator === "GT") return value > criterion.fixedValue ? "MATCHED" : "NOT_MATCHED";
    return value === criterion.fixedValue ? "MATCHED" : "NOT_MATCHED";
  }
  if (criterion.kind === "METRIC_BOOLEAN_TRUE") {
    const value = metricForProbe(subject, probeKey, criterion.metricKey);
    if (value === undefined || value === null) return "UNKNOWN";
    return value !== 0 ? "MATCHED" : "NOT_MATCHED";
  }
  if (criterion.kind === "ANY_METRIC_POSITIVE") {
    const values = criterion.metricKeys.map((key) => metricForProbe(subject, probeKey, key));
    if (values.every((v) => v === undefined || v === null)) return "UNKNOWN";
    return values.some((v) => v !== undefined && v !== null && v > 0) ? "MATCHED" : "NOT_MATCHED";
  }
  // JOINT_STRUCTURAL_FACT: presence of at least one row for this selector IS the fact.
  const rows = jointRowsFor(criterion.selector);
  return rows.length > 0 ? "MATCHED" : "NOT_MATCHED";
}

interface ManifestCardinality {
  readonly kind: F5cManifestCriterion["kind"];
  /** total pinned member/family count this criterion's countMetricKey is compared against. */
  readonly pinnedTotal: number | null;
}

function evaluateManifestCriterion(
  criterion: F5cManifestCriterion,
  subject: PlanningCalibrationSubjectMeasurement,
  probeKey: string,
  pinnedTotal: number | null,
): { readonly outcome: F5cShadowOutcome; readonly sweepable: boolean } {
  const value = metricForProbe(subject, probeKey, criterion.countMetricKey);
  if (value === undefined || value === null) return { outcome: "UNKNOWN", sweepable: false };
  if (criterion.kind === "AT_LEAST_FIXED_DISTINCT_MEMBERS") {
    return { outcome: value >= criterion.fixedValue ? "MATCHED" : "NOT_MATCHED", sweepable: false };
  }
  if (criterion.kind === "MANIFEST_CARDINALITY_SWEEP") {
    // No production number selected — this criterion is illustrative-only at the
    // representative percentile; it never gates a candidate's final MATCHED/NOT_MATCHED alone.
    return { outcome: "MATCHED", sweepable: true };
  }
  // ALL_MANIFEST_MEMBERS / ALL_REQUIRED_SUPERDOMAINS: value must equal the pinned cardinality.
  if (pinnedTotal === null) return { outcome: "UNKNOWN", sweepable: false };
  return { outcome: value >= pinnedTotal ? "MATCHED" : "NOT_MATCHED", sweepable: false };
}

// ─────────────────────────────────────────────────────────────
// axis evaluation
// ─────────────────────────────────────────────────────────────

function filterRows(rows: readonly RawRow[], operator: "AT_LEAST" | "AT_MOST", boundary: number): readonly RawRow[] {
  return rows.filter((r) => r.sampleValue !== null && passes(operator, r.sampleValue, boundary));
}

/**
 * Computes the qualifying `rowIndex` set from one or more ALREADY-THRESHOLDED filter row sets,
 * combined per the row group's declared composition mode. Returns `null` when there are no
 * filters at all (caller should then treat every row of the target selector as qualifying).
 * Composition is over `rowIndex`, not object identity or dayOffset — see `RawRow.rowIndex`.
 */
function qualifyingIndices(filterSets: readonly (readonly RawRow[])[], mode: F5cRowGroupCompositionMode): ReadonlySet<number> | null {
  if (filterSets.length === 0) return null;
  const indexSets = filterSets.map((set) => new Set(set.map((r) => r.rowIndex)));
  if (mode === "ANY_FILTER") {
    const union = new Set<number>();
    for (const set of indexSets) for (const index of set) union.add(index);
    return union;
  }
  const [first, ...rest] = indexSets;
  return new Set([...first!].filter((index) => rest.every((set) => set.has(index))));
}

/** Applies a qualifying-index set (from `qualifyingIndices()`) to one selector's own raw rows. */
function applyQualifyingIndices(ownRows: readonly RawRow[], indices: ReadonlySet<number> | null): readonly RawRow[] {
  return indices === null ? ownRows : ownRows.filter((r) => indices.has(r.rowIndex));
}

function reduceRows(rows: readonly RawRow[], allRows: readonly RawRow[], reducerKind: F5cSweepAxis["reducerKind"]): number {
  switch (reducerKind) {
    case "FILTER_THEN_COUNT":
      return rows.length;
    case "FILTER_THEN_DISTINCT_DAYS": {
      const days = new Set(rows.map((r) => r.dayOffset).filter((d): d is number => d !== null));
      return days.size;
    }
    case "FILTER_THEN_SPAN_DAYS": {
      const days = [...new Set(rows.map((r) => r.dayOffset).filter((d): d is number => d !== null))];
      return days.length === 0 ? 0 : Math.max(...days) - Math.min(...days) + 1;
    }
    case "FILTER_THEN_SHARE": {
      const numerator = rows.reduce((sum, r) => sum + (r.sampleValue ?? 0), 0);
      const denominator = allRows.reduce((sum, r) => sum + (r.sampleValue ?? 0), 0);
      return denominator === 0 ? 0 : numerator / denominator;
    }
    case "SET_BREADTH": {
      const members = new Set(rows.map((r) => r.memberKey).filter((m): m is string => m !== null));
      return members.size;
    }
    case "REPEAT_PERIOD":
    case "GROUP_FILTER_THEN_MAX": {
      const byGroup = new Map<string, Set<number>>();
      for (const r of rows) {
        if (r.groupKey === null) continue;
        const days = byGroup.get(r.groupKey) ?? new Set<number>();
        if (r.dayOffset !== null) days.add(r.dayOffset);
        byGroup.set(r.groupKey, days);
      }
      let max = 0;
      for (const days of byGroup.values()) max = Math.max(max, days.size);
      return max;
    }
    default:
      return rows.length;
  }
}

function maximumBipartiteMatching(adjacency: ReadonlyMap<string, ReadonlySet<string>>): number {
  const leftByRight = new Map<string, string>();
  const augment = (left: string, seen: Set<string>): boolean => {
    for (const right of adjacency.get(left) ?? []) {
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
  for (const left of adjacency.keys()) if (augment(left, new Set())) size += 1;
  return size;
}

/** rowGroupKey -> its declared composition mode, defaulting to ALL_FILTERS when only one filter exists (moot). */
function compositionModeFor(plan: F5cCandidateSweepPlan, rowGroupKey: string): F5cRowGroupCompositionMode {
  return plan.rowGroupCompositions.find((c) => c.rowGroupKey === rowGroupKey)?.composition ?? "ALL_FILTERS";
}

interface AxisEvalContext {
  readonly plan: F5cCandidateSweepPlan;
  readonly probeKey: string;
  readonly subjects: readonly PlanningCalibrationSubjectMeasurement[];
}

function metricSamplesFor(ctx: AxisEvalContext, metricKey: string): { readonly bySubject: ReadonlyMap<string, number | null>; readonly samples: readonly number[] } {
  const bySubject = new Map<string, number | null>();
  const samples: number[] = [];
  for (const subject of ctx.subjects) {
    const value = metricForProbe(subject, ctx.probeKey, metricKey);
    const resolved = value === undefined ? null : value;
    bySubject.set(subject.subjectUserId, resolved);
    if (resolved !== null) samples.push(resolved);
  }
  return { bySubject, samples };
}

/** Per-subject raw (unfiltered) row set for one row group, keyed by the axis's own selector. */
function rowGroupRawRowsFor(ctx: AxisEvalContext, axis: F5cSweepAxis & { source: "JOINT_EVIDENCE" }): ReadonlyMap<string, readonly RawRow[]> {
  const bySubject = new Map<string, readonly RawRow[]>();
  for (const subject of ctx.subjects) {
    const evidence = packForProbe(subject, ctx.probeKey);
    const rows = evidence ? resolveJointRows(evidence, axis.selector) : [];
    // stamp rowIndex: the cross-selector correspondence key for row-group composition (see
    // RawRow.rowIndex doc) — every selector in one row group maps 1:1, same order, over the
    // same underlying joint-evidence array.
    bySubject.set(subject.subjectUserId, rows.map((r, index) => ({ ...r, rowIndex: index })));
  }
  return bySubject;
}

function evaluateMetricAxis(ctx: AxisEvalContext, axis: F5cSweepAxis & { source: "METRIC" }): {
  readonly sweep: F5cAxisSweepResult;
  readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome>;
} {
  const { bySubject, samples } = metricSamplesFor(ctx, axis.metricKey);
  const boundaries = boundaryValuesFor(samples);
  const knownSubjects = [...bySubject.entries()].filter(([, v]) => v !== null);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, passRate: null };
    const passingCount = knownSubjects.filter(([, v]) => passes(axis.operator, v!, boundaryValue)).length;
    return {
      percentile, boundaryValue, knownCount: knownSubjects.length, passingCount,
      passRate: knownSubjects.length === 0 ? null : passingCount / knownSubjects.length,
    };
  });
  const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);
  const outcomeBySubject = new Map<string, F5cShadowOutcome>();
  for (const [subjectId, value] of bySubject) {
    if (value === null || representativeBoundary === undefined) { outcomeBySubject.set(subjectId, "UNKNOWN"); continue; }
    outcomeBySubject.set(subjectId, passes(axis.operator, value, representativeBoundary) ? "MATCHED" : "NOT_MATCHED");
  }
  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: samples.length, boundaryPoints, hourHistogram: null },
    outcomeBySubject,
  };
}

function evaluateCircularHourAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" },
  siblingFilteredRows: ReadonlyMap<string, readonly RawRow[]>,
): F5cAxisSweepResult {
  const hourCounts = Array.from({ length: 24 }, () => 0);
  let observed = 0;
  for (const subject of ctx.subjects) {
    for (const r of siblingFilteredRows.get(subject.subjectUserId) ?? []) {
      if (r.sampleValue !== null && r.sampleValue >= 0 && r.sampleValue < 24) {
        hourCounts[Math.floor(r.sampleValue)]! += 1;
        observed += 1;
      }
    }
  }
  return { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints: [], hourHistogram: hourCounts };
}

function evaluatePostFilterMatchingAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { reducerKind: "POST_FILTER_MATCHING_SIZE" },
  edgeSampleBoundaries: ReadonlyMap<F5cBoundaryPercentile, number>,
): { readonly sweep: F5cAxisSweepResult; readonly outcomeAtRepresentative: ReadonlyMap<string, F5cShadowOutcome> } {
  const rawRowsBySubject = rowGroupRawRowsFor(ctx, axis);
  const matchingSizeAtRepresentative = new Map<string, number>();
  const boundaryPoints: F5cBoundarySweepPoint[] = [];
  for (const percentile of F5C2_BOUNDARY_PERCENTILES) {
    const boundary = edgeSampleBoundaries.get(percentile);
    if (boundary === undefined) { boundaryPoints.push({ percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, passRate: null }); continue; }
    const sizes: number[] = [];
    for (const subject of ctx.subjects) {
      const rows = rawRowsBySubject.get(subject.subjectUserId) ?? [];
      const qualifying = rows.filter((r) => r.sampleValue !== null && r.sampleValue >= boundary && r.edgeLeftKey !== null && r.edgeRightKey !== null);
      const adjacency = new Map<string, Set<string>>();
      for (const r of qualifying) {
        const set = adjacency.get(r.edgeLeftKey!) ?? new Set<string>();
        set.add(r.edgeRightKey!);
        adjacency.set(r.edgeLeftKey!, set);
      }
      const size = maximumBipartiteMatching(adjacency);
      if (rows.length > 0) sizes.push(size);
      if (percentile === F5C2_REPRESENTATIVE_PERCENTILE) matchingSizeAtRepresentative.set(subject.subjectUserId, size);
    }
    const matchingBoundary = nearestRankPercentile(sizes, 50) ?? 0;
    const passingCount = sizes.filter((s) => s >= matchingBoundary).length;
    boundaryPoints.push({
      percentile, boundaryValue: matchingBoundary, knownCount: sizes.length, passingCount,
      passRate: sizes.length === 0 ? null : passingCount / sizes.length,
    });
  }
  const observed = [...rawRowsBySubject.values()].reduce((sum, rows) => sum + rows.length, 0);
  const outcomeAtRepresentative = new Map<string, F5cShadowOutcome>();
  for (const subject of ctx.subjects) {
    const rows = rawRowsBySubject.get(subject.subjectUserId) ?? [];
    if (rows.length === 0) { outcomeAtRepresentative.set(subject.subjectUserId, "UNKNOWN"); continue; }
    const size = matchingSizeAtRepresentative.get(subject.subjectUserId) ?? 0;
    outcomeAtRepresentative.set(subject.subjectUserId, size >= 1 ? "MATCHED" : "NOT_MATCHED");
  }
  return {
    sweep: { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: observed, boundaryPoints, hourHistogram: null },
    outcomeAtRepresentative,
  };
}

interface RowGroupPlan {
  readonly rowGroupKey: string;
  readonly filterAxes: readonly (F5cSweepAxis & { source: "JOINT_EVIDENCE"; reducerKind: "SCALAR_SAMPLE" })[];
  readonly reductionAxes: readonly (F5cSweepAxis & { source: "JOINT_EVIDENCE"; operator: "AT_LEAST" | "AT_MOST" })[];
  readonly circularAxes: readonly (F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" })[];
  readonly matchingAxes: readonly (F5cSweepAxis & { reducerKind: "POST_FILTER_MATCHING_SIZE" })[];
}

function groupAxesByRowGroup(axes: readonly F5cSweepAxis[]): readonly RowGroupPlan[] {
  const groups = new Map<string, F5cSweepAxis[]>();
  for (const axis of axes) {
    if (axis.source !== "JOINT_EVIDENCE") continue;
    const list = groups.get(axis.rowGroupKey) ?? [];
    list.push(axis);
    groups.set(axis.rowGroupKey, list);
  }
  return [...groups.entries()].map(([rowGroupKey, groupAxes]) => ({
    rowGroupKey,
    filterAxes: groupAxes.filter((a): a is F5cSweepAxis & { source: "JOINT_EVIDENCE"; reducerKind: "SCALAR_SAMPLE" } =>
      a.source === "JOINT_EVIDENCE" && a.reducerKind === "SCALAR_SAMPLE"),
    reductionAxes: groupAxes.filter((a): a is F5cSweepAxis & { source: "JOINT_EVIDENCE"; operator: "AT_LEAST" | "AT_MOST" } =>
      a.source === "JOINT_EVIDENCE" && a.reducerKind !== "SCALAR_SAMPLE" && a.reducerKind !== "CIRCULAR_HOUR_WINDOW" && a.reducerKind !== "POST_FILTER_MATCHING_SIZE"),
    circularAxes: groupAxes.filter((a): a is F5cSweepAxis & { reducerKind: "CIRCULAR_HOUR_WINDOW" } => a.reducerKind === "CIRCULAR_HOUR_WINDOW"),
    matchingAxes: groupAxes.filter((a): a is F5cSweepAxis & { reducerKind: "POST_FILTER_MATCHING_SIZE" } => a.reducerKind === "POST_FILTER_MATCHING_SIZE"),
  }));
}

function evaluateRowGroup(
  ctx: AxisEvalContext,
  group: RowGroupPlan,
): { readonly sweeps: readonly F5cAxisSweepResult[]; readonly outcomeBySubject: ReadonlyMap<string, F5cShadowOutcome> } {
  const composition = compositionModeFor(ctx.plan, group.rowGroupKey);
  const sweeps: F5cAxisSweepResult[] = [];
  const outcomeBySubject = new Map<string, F5cShadowOutcome>();

  // POST_FILTER_MATCHING_SIZE consumes its sibling filter's boundary grid directly; handle first.
  for (const matchingAxis of group.matchingAxes) {
    const filterAxis = group.filterAxes[0];
    const edgeSamples = filterAxis ? rowGroupRawRowsFor(ctx, filterAxis) : new Map<string, readonly RawRow[]>();
    const allEdgeSamples = [...edgeSamples.values()].flat().map((r) => r.sampleValue).filter((v): v is number => v !== null);
    const boundaries = boundaryValuesFor(allEdgeSamples);
    const result = evaluatePostFilterMatchingAxis(ctx, matchingAxis, boundaries);
    sweeps.push(result.sweep);
    for (const [subjectId, outcome] of result.outcomeAtRepresentative) {
      outcomeBySubject.set(subjectId, combineOutcomes([outcomeBySubject.get(subjectId) ?? "MATCHED", outcome]));
    }
    if (filterAxis) {
      const filterSweep = evaluateJointFilterAxis(ctx, filterAxis, edgeSamples);
      sweeps.push(filterSweep);
    }
  }
  if (group.matchingAxes.length > 0) return { sweeps, outcomeBySubject };

  // Raw rows per subject for every axis selector in this group (filters + reductions share one
  // logical row set per selector, but filters and reductions may reference different selectors
  // within the same rowGroupKey — resolve each axis's own selector, then compose the FILTER
  // axes' qualifying-row sets per subject).
  const filterRawBySubject = group.filterAxes.map((axis) => rowGroupRawRowsFor(ctx, axis));
  const filterBoundaries = group.filterAxes.map((axis) => {
    const allSamples = [...(filterRawBySubject[group.filterAxes.indexOf(axis)] ?? new Map()).values()].flat()
      .map((r) => r.sampleValue).filter((v): v is number => v !== null);
    return boundaryValuesFor(allSamples);
  });

  // Circular-hour axes: qualifying rows after sibling filters at the representative boundary.
  for (const circularAxis of group.circularAxes) {
    const rawBySubject = rowGroupRawRowsFor(ctx, circularAxis);
    const qualifyingBySubject = new Map<string, readonly RawRow[]>();
    for (const subject of ctx.subjects) {
      const qualifyingFilterSets = group.filterAxes.map((filterAxis, i) => {
        const boundary = filterBoundaries[i]!.get(F5C2_REPRESENTATIVE_PERCENTILE);
        const raw = filterRawBySubject[i]!.get(subject.subjectUserId) ?? [];
        return boundary === undefined ? raw : filterRows(raw, filterAxis.operator, boundary);
      });
      const own = rawBySubject.get(subject.subjectUserId) ?? [];
      const indices = qualifyingIndices(qualifyingFilterSets, composition);
      qualifyingBySubject.set(subject.subjectUserId, applyQualifyingIndices(own, indices));
    }
    sweeps.push(evaluateCircularHourAxis(ctx, circularAxis, qualifyingBySubject));
  }

  // Filter axes: report each axis's own independent sensitivity (varying just that axis,
  // siblings held at their own representative boundary) and its representative-boundary outcome.
  for (let i = 0; i < group.filterAxes.length; i += 1) {
    const filterAxis = group.filterAxes[i]!;
    sweeps.push(evaluateJointFilterAxis(ctx, filterAxis, filterRawBySubject[i]!));
  }

  // Reduction axes: apply the row-group composition at each subject, at the representative
  // boundary combination, then sweep the reduction's OWN resulting distribution.
  for (const reductionAxis of group.reductionAxes) {
    const rawBySubject = rowGroupRawRowsFor(ctx, reductionAxis);
    const reducedBySubject = new Map<string, { readonly value: number; readonly hasEvidence: boolean }>();
    for (const subject of ctx.subjects) {
      const own = rawBySubject.get(subject.subjectUserId) ?? [];
      if (group.filterAxes.length === 0) {
        reducedBySubject.set(subject.subjectUserId, { value: reduceRows(own, own, reductionAxis.reducerKind), hasEvidence: own.length > 0 });
        continue;
      }
      const qualifyingFilterSets = group.filterAxes.map((filterAxis, i) => {
        const boundary = filterBoundaries[i]!.get(F5C2_REPRESENTATIVE_PERCENTILE);
        const raw = filterRawBySubject[i]!.get(subject.subjectUserId) ?? [];
        return boundary === undefined ? [] : filterRows(raw, filterAxis.operator, boundary);
      });
      const indices = qualifyingIndices(qualifyingFilterSets, composition);
      const qualifying = applyQualifyingIndices(own, indices);
      reducedBySubject.set(subject.subjectUserId, { value: reduceRows(qualifying, own, reductionAxis.reducerKind), hasEvidence: own.length > 0 });
    }
    const samples = [...reducedBySubject.values()].filter((r) => r.hasEvidence).map((r) => r.value);
    const boundaries = boundaryValuesFor(samples);
    const knownCount = [...reducedBySubject.values()].filter((r) => r.hasEvidence).length;
    const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
      const boundaryValue = boundaries.get(percentile);
      if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, passRate: null };
      const passingCount = [...reducedBySubject.values()].filter((r) => r.hasEvidence && passes(reductionAxis.operator, r.value, boundaryValue)).length;
      return { percentile, boundaryValue, knownCount, passingCount, passRate: knownCount === 0 ? null : passingCount / knownCount };
    });
    sweeps.push({ axisKey: reductionAxis.axisKey, reducerKind: reductionAxis.reducerKind, observedSampleCount: samples.length, boundaryPoints, hourHistogram: null });

    const representativeBoundary = boundaries.get(F5C2_REPRESENTATIVE_PERCENTILE);
    for (const subject of ctx.subjects) {
      const result = reducedBySubject.get(subject.subjectUserId)!;
      const prior = outcomeBySubject.get(subject.subjectUserId);
      let outcome: F5cShadowOutcome;
      if (!result.hasEvidence || representativeBoundary === undefined) outcome = "UNKNOWN";
      else outcome = passes(reductionAxis.operator, result.value, representativeBoundary) ? "MATCHED" : "NOT_MATCHED";
      outcomeBySubject.set(subject.subjectUserId, prior === undefined ? outcome : combineOutcomes([prior, outcome]));
    }
  }

  return { sweeps, outcomeBySubject };
}

function evaluateJointFilterAxis(
  ctx: AxisEvalContext,
  axis: F5cSweepAxis & { source: "JOINT_EVIDENCE"; reducerKind: "SCALAR_SAMPLE" },
  rawBySubject: ReadonlyMap<string, readonly RawRow[]>,
): F5cAxisSweepResult {
  const allSamples = [...rawBySubject.values()].flat().map((r) => r.sampleValue).filter((v): v is number => v !== null);
  const boundaries = boundaryValuesFor(allSamples);
  const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
    const boundaryValue = boundaries.get(percentile);
    if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, passRate: null };
    let known = 0;
    let passing = 0;
    for (const rows of rawBySubject.values()) {
      if (rows.length === 0) continue;
      known += 1;
      if (rows.some((r) => r.sampleValue !== null && passes(axis.operator, r.sampleValue, boundaryValue))) passing += 1;
    }
    return { percentile, boundaryValue, knownCount: known, passingCount: passing, passRate: known === 0 ? null : passing / known };
  });
  return { axisKey: axis.axisKey, reducerKind: axis.reducerKind, observedSampleCount: allSamples.length, boundaryPoints, hourHistogram: null };
}

// ─────────────────────────────────────────────────────────────
// per-candidate + top-level execution
// ─────────────────────────────────────────────────────────────

function pinnedManifestTotal(plan: F5cCandidateSweepPlan): number | null {
  if (!plan.manifestRef) return null;
  if (plan.manifestRef.kind === "ECONOMY_SEMANTIC_FAMILIES") return 3; // peer_transfer, tip, shop
  if (plan.manifestRef.kind === "CASINO_EDITION") return 8; // Edition-I 8 target game families
  return 7; // CASTLE_EDITION: 7 families (or 3 super-domains for ALL_REQUIRED_SUPERDOMAINS, handled below)
}

function executeCandidate(
  plan: F5cCandidateSweepPlan,
  subjects: readonly PlanningCalibrationSubjectMeasurement[],
): F5cCandidateShadowResult {
  const ctx: AxisEvalContext = { plan, probeKey: plan.probeKey, subjects };
  const jointRowsFor = (selector: string) => (subject: PlanningCalibrationSubjectMeasurement): readonly RawRow[] => {
    const evidence = packForProbe(subject, plan.probeKey);
    return evidence ? resolveJointRows(evidence, selector) : [];
  };

  const axisSweeps: F5cAxisSweepResult[] = [];
  const outcomeBySubject = new Map<string, F5cShadowOutcome[]>();
  const pushOutcome = (subjectId: string, outcome: F5cShadowOutcome) => {
    const list = outcomeBySubject.get(subjectId) ?? [];
    list.push(outcome);
    outcomeBySubject.set(subjectId, list);
  };

  for (const subject of subjects) {
    for (const criterion of plan.fixedCriteria) {
      pushOutcome(subject.subjectUserId, evaluateFixedCriterion(criterion, subject, plan.probeKey, (selector) => jointRowsFor(selector)(subject)));
    }
  }

  const pinnedTotal = pinnedManifestTotal(plan);
  for (const criterion of plan.manifestCriteria) {
    const pinnedForCriterion = criterion.kind === "ALL_REQUIRED_SUPERDOMAINS" ? 3 : pinnedTotal;
    for (const subject of subjects) {
      const result = evaluateManifestCriterion(criterion, subject, plan.probeKey, pinnedForCriterion);
      if (!result.sweepable) pushOutcome(subject.subjectUserId, result.outcome);
    }
    if (criterion.kind === "MANIFEST_CARDINALITY_SWEEP") {
      const { samples } = metricSamplesFor(ctx, criterion.countMetricKey);
      const boundaries = boundaryValuesFor(samples);
      const boundaryPoints: F5cBoundarySweepPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
        const boundaryValue = boundaries.get(percentile);
        if (boundaryValue === undefined) return { percentile, boundaryValue: 0, knownCount: 0, passingCount: 0, passRate: null };
        const known = samples.length;
        const passing = samples.filter((v) => v >= boundaryValue).length;
        return { percentile, boundaryValue, knownCount: known, passingCount: passing, passRate: known === 0 ? null : passing / known };
      });
      axisSweeps.push({ axisKey: `manifest:${criterion.countMetricKey}`, reducerKind: "SCALAR_METRIC", observedSampleCount: samples.length, boundaryPoints, hourHistogram: null });
    }
  }

  const metricAxes = plan.axes.filter((a): a is F5cSweepAxis & { source: "METRIC" } => a.source === "METRIC");
  for (const axis of metricAxes) {
    const { sweep, outcomeBySubject: axisOutcomes } = evaluateMetricAxis(ctx, axis);
    axisSweeps.push(sweep);
    for (const [subjectId, outcome] of axisOutcomes) pushOutcome(subjectId, outcome);
  }

  const rowGroups = groupAxesByRowGroup(plan.axes);
  let unsupportedReason: string | null = null;
  for (const group of rowGroups) {
    try {
      const { sweeps, outcomeBySubject: groupOutcomes } = evaluateRowGroup(ctx, group);
      axisSweeps.push(...sweeps);
      for (const [subjectId, outcome] of groupOutcomes) pushOutcome(subjectId, outcome);
    } catch (error) {
      unsupportedReason = `row group ${group.rowGroupKey}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const hasJointEvidence = plan.axes.some((a) => a.source === "JOINT_EVIDENCE") || plan.fixedCriteria.some((c) => c.kind === "JOINT_STRUCTURAL_FACT");
  const executionStrategy: F5cExecutionStrategy = unsupportedReason !== null
    ? "UNSUPPORTED_GAP"
    : plan.thresholdCategory === "STRUCTURAL_PLUS_DISTRIBUTION"
      ? "STRUCTURAL_PLUS_DISTRIBUTION"
      : plan.manifestCriteria.length > 0
        ? "MANIFEST_CRITERIA"
        : hasJointEvidence
          ? "JOINT_EVIDENCE_SWEEP"
          : plan.axes.length > 0
            ? "METRIC_AXIS_SWEEP"
            : "FIXED_CRITERIA";

  let matchedCount = 0;
  let notMatchedCount = 0;
  let unknownCount = 0;
  for (const subject of subjects) {
    const outcomes = outcomeBySubject.get(subject.subjectUserId) ?? [];
    const combined = combineOutcomes(outcomes);
    if (combined === "MATCHED") matchedCount += 1;
    else if (combined === "NOT_MATCHED") notMatchedCount += 1;
    else unknownCount += 1;
  }
  const knownCount = matchedCount + notMatchedCount;

  return {
    candidateNo: plan.candidateNo,
    provisionalKey: plan.provisionalKey,
    evaluationShape: plan.evaluationShape,
    thresholdCategory: plan.thresholdCategory,
    executionStrategy,
    populationCount: subjects.length,
    knownCount,
    unknownCount,
    matchedCount,
    notMatchedCount,
    prevalence: knownCount === 0 ? null : matchedCount / knownCount,
    axisSweeps,
    unsupportedReason,
  };
}

/**
 * Executes every READY-76 F5c1 plan against a deterministic F5c calibration collection.
 * Restricted subject IDs are used transiently in-memory only — the returned report is
 * aggregate-only (counts/rates/boundary values), never subject identities or raw evidence.
 */
export function executeF5cShadowCalibration(collection: PlanningCalibrationMeasurementCollection): F5cShadowCalibrationReport {
  const results = F5C_CANDIDATE_SWEEP_PLANS.map((plan) => executeCandidate(plan, collection.subjects));
  const unsupportedCandidateCount = results.filter((r) => r.executionStrategy === "UNSUPPORTED_GAP").length;
  return deepFreeze({
    contractVersion: F5C2_SHADOW_CONTRACT_VERSION,
    sweepContractVersion: F5C_CANDIDATE_SWEEP_PLANS.length > 0 ? 3 : 0,
    cohort: collection.cohort,
    window: collection.window,
    readyCandidateCount: F5C_CANDIDATE_SWEEP_PLANS.length,
    executedCandidateCount: results.length - unsupportedCandidateCount,
    unsupportedCandidateCount,
    results: results.sort((a, b) => a.candidateNo - b.candidateNo),
  });
}

/** Convenience wrapper: collect + execute in one call. Never persists/logs subject identity. */
export function runF5cShadowCalibration(db: Database.Database, input: F5aCalibrationInput): F5cShadowCalibrationReport {
  return executeF5cShadowCalibration(collectF5cCalibrationMeasurements(db, input));
}
