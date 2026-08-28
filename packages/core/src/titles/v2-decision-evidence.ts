import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  F5C_CANDIDATE_SWEEP_PLANS,
  F5C_SWEEP_CONTRACT_VERSION,
  type F5cCandidateSweepPlan,
  type F5cSweepAxis,
} from "./v2-calibration-sweep.js";
import {
  CALIBRATION_PERCENTILE_METHOD,
  CALIBRATION_SCHEMA_VERSION,
  canonicalReadinessHash,
  collectF5cCalibrationMeasurements,
  type F5aCalibrationInput,
  type PlanningCalibrationMeasurementCollection,
  type PlanningCalibrationSubjectMeasurement,
} from "./v2-calibration.js";
import { canonicalCatalogHash, TITLE_V2_CATALOG_CANDIDATES } from "./v2-catalog-candidates.js";
import { TITLE_V2_CATALOG_READINESS } from "./v2-catalog-readiness.js";
import {
  executeCandidateAtSelection,
  manifestDimensionKey,
  F5C2_BOUNDARY_PERCENTILES,
  F5C2_REPRESENTATIVE_PERCENTILE,
  F5C2_SENSITIVITY_MODEL,
  F5C2_SHADOW_CONTRACT_VERSION,
  type F5cBoundaryPercentile,
  type F5cBoundaryReliability,
  type F5cCandidateExecution,
  type F5cCandidateShadowResult,
  type F5cDecisionBoundarySelection,
  type F5cShadowOutcome,
} from "./v2-shadow-evaluation.js";

/**
 * F5c3: decision-evidence layer (task #192). Planning/operator-internal only — never import from
 * evaluator, pipeline, Bot, or the public v2 barrel.
 *
 * F5c3 selects **no** production threshold and creates **no** production rule. It exists to give a
 * human reviewer, before F6, the aggregate evidence needed to answer:
 *   - what boundary regions are plausible for each candidate?
 *   - how does FINAL candidate prevalence move when ONE decision boundary moves?
 *   - which candidate concepts substantially overlap / contain one another?
 *   - where is the evidence reliable vs coverage-sensitive?
 *   - which candidates still lack enough evidence for a production rule?
 *
 * It owns none of the candidate semantics: every number here comes from F5c2's single shared
 * evaluator (`executeCandidateAtSelection`), so a candidate cannot mean one thing in F5c2's
 * representative execution and another in F5c3's sensitivity or overlap analysis.
 */
export const F5C3_EVIDENCE_CONTRACT_VERSION = 2 as const;

/**
 * F5c2's `boundaryPoints` are **marginal axis pass rates** (that one axis's own distribution).
 * F5c3's OAT points are **final candidate prevalence** — the whole conjunction / manifest /
 * structural semantic re-evaluated with one dimension moved. The two are not comparable, so they
 * carry different type names, different field names, and an explicit model marker on each side.
 */
export const F5C3_SENSITIVITY_MODEL = "CANDIDATE_LEVEL_ONE_AXIS_AT_A_TIME" as const;

/** The marginal model F5c2 reports, echoed so a reader sees both models named side by side. */
export const F5C3_MARGINAL_MODEL_REFERENCE = F5C2_SENSITIVITY_MODEL;

/**
 * What "one axis at a time" holds fixed (PR #192レビュー第1ラウンド§1). Declared on the report so
 * an F6 reviewer never has to guess which of the two possible readings a curve answers.
 *
 * `BASELINE_NUMERIC_BOUNDARY`: while one dimension is swept, every sibling dimension keeps the
 * NUMERIC decision boundary it held in the representative execution. Pinning percentile RANKS
 * instead would not be one-axis-at-a-time on this pipeline: a downstream reduction's grid is
 * derived from whatever survives its upstream filters, so `[1, 2, 3]` (p50 = 2) can become
 * `[0, 0, 3]` (p50 = 0) merely because the swept filter moved — two production boundaries moving
 * in a curve labelled as one. The real dependency is preserved: a filter change still changes each
 * subject's reduced VALUE; only the sibling's decision BOUNDARY is held still.
 */
export const F5C3_SIBLING_PINNING = "BASELINE_NUMERIC_BOUNDARY" as const;

// ─────────────────────────────────────────────────────────────
// candidate-level one-axis-at-a-time (OAT) sensitivity
// ─────────────────────────────────────────────────────────────

/**
 * One point of a candidate-level OAT curve: the FINAL candidate outcome distribution with this
 * dimension's numeric boundary substituted for its baseline value at `percentile`, and every
 * sibling dimension pinned to its BASELINE NUMERIC boundary (see `F5C3_SIBLING_PINNING`).
 */
export interface F5cCandidateOatPoint {
  readonly percentile: F5cBoundaryPercentile;
  /**
   * The NUMERIC decision boundary substituted for this dimension at this point — its baseline
   * grid value at `percentile`. This is the candidate production threshold the point answers for;
   * null when the baseline population had no samples for this dimension (fail-closed: every
   * consuming path then treats the dimension as having no usable boundary).
   */
  readonly boundaryValueAtPercentile: number | null;
  readonly knownCount: number;
  readonly unknownCount: number;
  readonly matchedCount: number;
  readonly notMatchedCount: number;
  /** matchedCount / knownCount — the FINAL candidate prevalence, not an axis pass rate. */
  readonly candidatePrevalence: number | null;
}

export interface F5cDimensionSensitivity {
  readonly dimensionKey: string;
  readonly reducerKind: F5cSweepAxis["reducerKind"];
  /** F5c2's own reliability label for this dimension's boundary values, carried through unchanged. */
  readonly boundaryReliability: F5cBoundaryReliability;
  readonly points: readonly F5cCandidateOatPoint[];
  /**
   * True when moving this dimension across the whole grid never changes the final candidate
   * prevalence — the curve carries no decision information (a sibling requirement dominates, or
   * the population is degenerate). Reported rather than hidden so F6 does not mistake a flat line
   * for a well-behaved threshold region.
   */
  readonly flat: boolean;
}

/**
 * Why a candidate has no OAT curve at all. Reported explicitly rather than inventing a misleading
 * curve for a dimension that cannot meaningfully be varied (task #192 §2).
 */
export type F5cNonSweepableReason =
  | "NO_SWEEPABLE_DIMENSION_STRUCTURAL_ONLY"
  | "NO_SWEEPABLE_DIMENSION_MANIFEST_PINNED"
  | "CANDIDATE_UNSUPPORTED";

export interface F5cCandidateSensitivity {
  readonly candidateNo: number;
  readonly provisionalKey: string;
  readonly executionStrategy: F5cCandidateShadowResult["executionStrategy"];
  /** The F5c2 representative execution, repeated here so a reader need not cross-reference. */
  readonly representative: {
    readonly knownCount: number;
    readonly unknownCount: number;
    readonly matchedCount: number;
    readonly notMatchedCount: number;
    readonly candidatePrevalence: number | null;
  };
  readonly dimensions: readonly F5cDimensionSensitivity[];
  readonly nonSweepableReason: F5cNonSweepableReason | null;
}

// ─────────────────────────────────────────────────────────────
// overlap / containment
// ─────────────────────────────────────────────────────────────

/**
 * Why this pair was selected for comparison. Both come from typed catalog structure
 * (`groupKey` / `seriesKey` / `stage`) — never from title names or prose (task #192 §3).
 *
 * Each unordered candidate pair is emitted EXACTLY ONCE (PR #192レビュー第1ラウンド§3). The
 * catalog's staged ladders share a `groupKey` AND a `seriesKey` (e.g. No.1-4 are both `vc_ignite`),
 * so emitting one bucket per key attached two different normative readings to the same measured
 * overlap. `SERIES_PROGRESSION` therefore takes precedence, and `GROUP_SIBLING` covers only the
 * pairs no single series already explains.
 */
export type F5cOverlapRelation = "SERIES_PROGRESSION" | "GROUP_SIBLING";

/**
 * What catalog structure predicts about this pair's overlap — the reviewer-facing normative half,
 * kept separate from the measured half so a number never carries an unstated verdict.
 *
 * - `HIGHER_STAGE_WITHIN_LOWER_STAGE`: a series is a cumulative ladder (docs/titles-v2-design.md
 *   §「Progression (`{ seriesKey, stage }`)」), so the higher-stage candidate's matched set is
 *   expected to sit INSIDE the lower-stage one. `A` is always the lower stage here, so the
 *   prediction is about `containmentBInA`, and a value well below 1 means the staging is not
 *   actually nested. Stage ordering comes from the typed `stage` field, never from candidate
 *   numbering or title prose.
 * - `NO_STRUCTURAL_EXPECTATION`: group siblings that are not stages of one series. High overlap
 *   here is worth a reviewer's attention, but the catalog does not itself say the two must be
 *   disjoint — F5c3 reports the measurement and makes no design claim.
 */
export type F5cOverlapExpectation = "HIGHER_STAGE_WITHIN_LOWER_STAGE" | "NO_STRUCTURAL_EXPECTATION";

/**
 * All counts are over the **both-known denominator**: subjects whose FINAL outcome is known
 * (MATCHED or NOT_MATCHED) for BOTH candidates. A subject UNKNOWN on either side is excluded and
 * counted in `eitherUnknownCount` — it is never silently folded into NOT_MATCHED (task #192 §3/§5).
 */
export interface F5cOverlapPair {
  readonly relation: F5cOverlapRelation;
  /** the shared `seriesKey` for SERIES_PROGRESSION, the shared `groupKey` for GROUP_SIBLING. */
  readonly relationKey: string;
  /** the shared group, reported for both relations so precedence never hides the group fact. */
  readonly groupKey: string;
  /** the shared series — null exactly when the two candidates are not stages of one series. */
  readonly seriesKey: string | null;
  readonly expectation: F5cOverlapExpectation;
  /** for SERIES_PROGRESSION, A is the LOWER stage; otherwise ordered by candidate number. */
  readonly aCandidateNo: number;
  readonly bCandidateNo: number;
  readonly aProvisionalKey: string;
  readonly bProvisionalKey: string;
  readonly aStage: number | null;
  readonly bStage: number | null;
  readonly populationCount: number;
  /** the denominator every count/ratio below is computed over. */
  readonly bothKnownCount: number;
  /** excluded from the denominator because at least one side was UNKNOWN. */
  readonly eitherUnknownCount: number;
  readonly aMatchedCount: number;
  readonly bMatchedCount: number;
  readonly bothMatchedCount: number;
  readonly aOnlyCount: number;
  readonly bOnlyCount: number;
  readonly neitherCount: number;
  /** |A∩B| / |A∪B| within the both-known denominator; null when the union is empty. */
  readonly jaccard: number | null;
  /** |A∩B| / |A| — "how much of A is inside B"; null when A matched nobody. */
  readonly containmentAInB: number | null;
  readonly containmentBInA: number | null;
}

// ─────────────────────────────────────────────────────────────
// evidence readiness (NOT title readiness, NOT production activation)
// ─────────────────────────────────────────────────────────────

/**
 * Whether a human has enough aggregate calibration evidence to make the F6 threshold/adoption call
 * for this candidate. This is **evidence** readiness — it is not the catalog's source-readiness
 * classification (READY/PARTIAL/BLOCKED/META, untouched here) and it is never permission to ship.
 */
export type F5cEvidenceReadiness =
  | "EVIDENCE_READY_FOR_THRESHOLD_REVIEW"
  | "NEEDS_MORE_CALIBRATION_EVIDENCE"
  | "RELEASE_GATE_STILL_BLOCKED";

/**
 * Known non-source production release gates, which source-readiness deliberately does not encode:
 * a candidate can be source-READY with excellent calibration evidence and still be blocked from
 * shipping for an unrelated product/semantic reason.
 *
 * These live in prose today (the readiness entry's `notes` plus
 * `docs/titles-v2-catalog-readiness.md` §15), and prose is not something F5c3 should scrape. This
 * finite typed list is the smallest honest way to keep F5c3 from reporting "evidence ready" as if
 * it meant "ready to ship" (task #192 §7). Adding to it is a deliberate, reviewable diff.
 */
export const F5C3_KNOWN_RELEASE_GATES: ReadonlyMap<number, string> = new Map([
  [58, "post-award reversal semantics undecided as a production release gate (see v2-catalog-readiness.ts #58 notes / docs/titles-v2-catalog-readiness.md §15)"],
]);

export interface F5cCandidateEvidenceReadiness {
  readonly candidateNo: number;
  readonly provisionalKey: string;
  readonly readiness: F5cEvidenceReadiness;
  readonly reason: string;
}

// ─────────────────────────────────────────────────────────────
// provenance
// ─────────────────────────────────────────────────────────────

/**
 * Enough context for an F6 reviewer to pin exactly which evidence run produced a number.
 *
 * Every field is consumed from the deterministic collection or the live contracts — none is
 * re-stated as a literal here (task #192 §4) — and every collection-sourced field is reported as
 * the VALIDATED COLLECTION's own value rather than being replaced by the current constant
 * (PR #192レビュー第1ラウンド§4). Substituting a live constant for a collection field is what would
 * let a stale collection be accepted while the report claims today's percentile method;
 * `assertCompatibleCollection` refuses the mismatch first, so these two are equal by construction —
 * but they are reported from the collection so the claim is the checked one.
 */
export interface F5cEvidenceProvenance {
  readonly sweepContractVersion: number;
  readonly shadowContractVersion: number;
  readonly evidenceContractVersion: typeof F5C3_EVIDENCE_CONTRACT_VERSION;
  /** the collection's OWN schema version, after it was validated against the live contract. */
  readonly calibrationSchemaVersion: number;
  readonly catalogHash: string;
  readonly readinessHash: string;
  readonly catalogCandidateCount: number;
  readonly cohortKey: string;
  readonly cohortSubjectCount: number;
  readonly window: PlanningCalibrationMeasurementCollection["window"];
  /** the caller's unverified attestation, carried through — see F5c2's own doc on this flag. */
  readonly coverageWindowValidated: boolean;
  readonly percentileMethod: string;
  readonly percentileGrid: readonly F5cBoundaryPercentile[];
  readonly candidateSensitivityModel: typeof F5C3_SENSITIVITY_MODEL;
  readonly siblingPinning: typeof F5C3_SIBLING_PINNING;
  readonly marginalAxisModel: typeof F5C3_MARGINAL_MODEL_REFERENCE;
}

export interface F5cDecisionEvidenceReport {
  readonly provenance: F5cEvidenceProvenance;
  readonly readyCandidateCount: number;
  readonly sensitivity: readonly F5cCandidateSensitivity[];
  readonly overlap: readonly F5cOverlapPair[];
  readonly evidenceReadiness: readonly F5cCandidateEvidenceReadiness[];
  /**
   * Deterministic fingerprint of everything above (provenance included). Two runs over the same
   * collection produce the same value; any drift in contract version, catalog, cohort, window,
   * attestation, or a single computed count changes it.
   */
  readonly reportFingerprint: string;
}

// ─────────────────────────────────────────────────────────────
// implementation
// ─────────────────────────────────────────────────────────────

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * The candidate's sweepable decision dimensions, derived from the F5c1 plan (not from an executed
 * report, so it is available before evaluation). Every axis is a decision dimension — including
 * SCALAR_SAMPLE filters, whose boundary genuinely moves the reductions that depend on them, and
 * POST_FILTER_MATCHING_SIZE, whose edge threshold is its sibling filter's dimension rather than
 * its own. Fixed criteria and pinned manifest criteria are NOT dimensions: their boundary is a
 * structural constant, so there is nothing to sweep.
 */
function sweepableDimensionsOf(plan: F5cCandidateSweepPlan): readonly { readonly key: string; readonly reducerKind: F5cSweepAxis["reducerKind"] }[] {
  const dims: { key: string; reducerKind: F5cSweepAxis["reducerKind"] }[] = [];
  for (const axis of plan.axes) dims.push({ key: axis.axisKey, reducerKind: axis.reducerKind });
  for (const criterion of plan.manifestCriteria) {
    if (criterion.kind === "MANIFEST_CARDINALITY_SWEEP") {
      dims.push({ key: manifestDimensionKey(criterion.countMetricKey), reducerKind: "SCALAR_METRIC" });
    }
  }
  return dims;
}

function nonSweepableReasonFor(plan: F5cCandidateSweepPlan, result: F5cCandidateShadowResult): F5cNonSweepableReason {
  if (result.executionStrategy === "UNSUPPORTED_GAP") return "CANDIDATE_UNSUPPORTED";
  if (plan.manifestCriteria.length > 0) return "NO_SWEEPABLE_DIMENSION_MANIFEST_PINNED";
  return "NO_SWEEPABLE_DIMENSION_STRUCTURAL_ONLY";
}

function candidateSensitivityFor(
  plan: F5cCandidateSweepPlan,
  subjects: readonly PlanningCalibrationSubjectMeasurement[],
  coverageWindowValidated: boolean,
  baseline: F5cCandidateExecution,
): F5cCandidateSensitivity {
  const representative = baseline.result;
  const baselineGrids = baseline.boundaryGrids;
  const base = {
    candidateNo: plan.candidateNo,
    provisionalKey: plan.provisionalKey,
    executionStrategy: representative.executionStrategy,
    representative: {
      knownCount: representative.knownCount,
      unknownCount: representative.unknownCount,
      matchedCount: representative.matchedCount,
      notMatchedCount: representative.notMatchedCount,
      candidatePrevalence: representative.prevalence,
    },
  };

  const dims = representative.executionStrategy === "UNSUPPORTED_GAP" ? [] : sweepableDimensionsOf(plan);
  if (dims.length === 0) {
    return { ...base, dimensions: [], nonSweepableReason: nonSweepableReasonFor(plan, representative) };
  }

  const dimensions: F5cDimensionSensitivity[] = dims.map((dim) => {
    const baselineGrid = baselineGrids.get(dim.key);
    const points: F5cCandidateOatPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
      /**
       * ONE production decision boundary moves; every sibling keeps the NUMERIC boundary the
       * baseline execution decided against (`F5C3_SIBLING_PINNING`). The dependency itself is
       * untouched — moving an upstream filter still changes each subject's reduced value, and the
       * downstream comparison still happens — but the sibling's THRESHOLD no longer drifts with
       * the conditional distribution, which is what makes this answer the F6 question ("move one
       * boundary, hold the others") instead of silently moving two.
       *
       * Deliberately not a Cartesian product: cost is |dimensions| × |grid| candidate
       * evaluations, not |grid|^n.
       */
      const selectBoundary: F5cDecisionBoundarySelection = (key, conditionalBoundaries) => {
        // `conditionalBoundaries` is only ever reached if the baseline execution did not consume a
        // boundary for this dimension at all — structurally impossible here, since the OAT run
        // walks the same plan through the same evaluator, but falling back to F5c2's own
        // conditional behaviour keeps an unforeseen path honest rather than silently unbounded.
        const grid = baselineGrids.get(key) ?? conditionalBoundaries;
        return grid.get(key === dim.key ? percentile : F5C2_REPRESENTATIVE_PERCENTILE);
      };
      const { result } = executeCandidateAtSelection(plan, subjects, coverageWindowValidated, selectBoundary);
      return {
        percentile,
        // the boundary actually substituted — the baseline grid value, not a value re-derived
        // from the conditional distribution this point produced.
        boundaryValueAtPercentile: baselineGrid?.get(percentile) ?? null,
        knownCount: result.knownCount,
        unknownCount: result.unknownCount,
        matchedCount: result.matchedCount,
        notMatchedCount: result.notMatchedCount,
        candidatePrevalence: result.prevalence,
      };
    });
    const representativeSweep = representative.axisSweeps.find((s) => s.axisKey === dim.key);
    const distinct = new Set(points.map((p) => `${p.candidatePrevalence}|${p.knownCount}|${p.unknownCount}`));
    return {
      dimensionKey: dim.key,
      reducerKind: dim.reducerKind,
      boundaryReliability: representativeSweep?.boundaryReliability ?? "OBSERVED_DIRECTION_UNKNOWN",
      points,
      flat: distinct.size <= 1,
    };
  });

  return { ...base, dimensions, nonSweepableReason: null };
}

interface F5cPairSelection {
  readonly relation: F5cOverlapRelation;
  readonly relationKey: string;
  readonly groupKey: string;
  readonly seriesKey: string | null;
  readonly expectation: F5cOverlapExpectation;
  readonly a: F5cCandidateSweepPlan;
  readonly b: F5cCandidateSweepPlan;
  readonly aStage: number | null;
  readonly bStage: number | null;
}

/**
 * Pair selection (task #192 §3, reworked in PR #192レビュー第1ラウンド§3): typed catalog structure
 * only — `groupKey`, `seriesKey`, `stage`. Never title names or prose.
 *
 * Each unordered pair is emitted exactly once, with exactly one normative reading:
 *
 * - `SERIES_PROGRESSION` (shared `seriesKey` + both stages typed) — a cumulative ladder, so the
 *   higher stage is expected to be contained in the lower one. A is the LOWER stage, so the
 *   prediction is about `containmentBInA`.
 * - `GROUP_SIBLING` (shared `groupKey`, not explained by one series) — reported neutrally. The
 *   catalog does not claim group siblings must be disjoint, so F5c3 does not either.
 *
 * Series takes precedence because the catalog's ladders share BOTH keys (No.1-4 are `vc_ignite`
 * for group and series alike): bucketing per key would emit the same pair twice and attach two
 * different, contradictory interpretations to one measured overlap.
 *
 * Deliberately NOT all 76×76: an all-pairs dump would be thousands of mostly-meaningless numbers
 * with no review value, and choosing pairs any other way would require title-name/prose guesswork.
 */
function overlapPairsToAnalyze(plans: readonly F5cCandidateSweepPlan[]): readonly F5cPairSelection[] {
  const byNo = new Map(TITLE_V2_CATALOG_CANDIDATES.map((c) => [c.no, c] as const));
  const groupKeyOf = (plan: F5cCandidateSweepPlan): string => byNo.get(plan.candidateNo)?.groupKey ?? "";
  const stageOf = (plan: F5cCandidateSweepPlan): number | null => byNo.get(plan.candidateNo)?.stage ?? null;
  const bucket = (keyOf: (plan: F5cCandidateSweepPlan) => string | null): readonly (readonly [string, readonly F5cCandidateSweepPlan[]])[] => {
    const buckets = new Map<string, F5cCandidateSweepPlan[]>();
    for (const plan of plans) {
      const key = keyOf(plan);
      if (key === null || key === "") continue;
      const list = buckets.get(key) ?? [];
      list.push(plan);
      buckets.set(key, list);
    }
    return [...buckets.entries()].sort(([x], [y]) => x.localeCompare(y));
  };
  const unordered = (x: number, y: number): string => `${Math.min(x, y)}-${Math.max(x, y)}`;

  const pairs: F5cPairSelection[] = [];
  const claimedBySeries = new Set<string>();

  for (const [seriesKey, members] of bucket((plan) => byNo.get(plan.candidateNo)?.seriesKey ?? null)) {
    // typed stage ordering — never candidate numbering, which is editorial.
    const ordered = [...members].sort((x, y) => (stageOf(x) ?? 0) - (stageOf(y) ?? 0) || x.candidateNo - y.candidateNo);
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i]!;
        const b = ordered[j]!;
        const aStage = stageOf(a);
        const bStage = stageOf(b);
        // A series member with no typed stage cannot support a containment DIRECTION, so it does
        // not get one: it falls through to the neutral group-sibling reading below.
        if (aStage === null || bStage === null) continue;
        claimedBySeries.add(unordered(a.candidateNo, b.candidateNo));
        pairs.push({
          relation: "SERIES_PROGRESSION", relationKey: seriesKey, groupKey: groupKeyOf(a), seriesKey,
          expectation: "HIGHER_STAGE_WITHIN_LOWER_STAGE", a, b, aStage, bStage,
        });
      }
    }
  }

  for (const [groupKey, members] of bucket(groupKeyOf)) {
    const ordered = [...members].sort((x, y) => x.candidateNo - y.candidateNo);
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i]!;
        const b = ordered[j]!;
        if (claimedBySeries.has(unordered(a.candidateNo, b.candidateNo))) continue;
        pairs.push({
          relation: "GROUP_SIBLING", relationKey: groupKey, groupKey, seriesKey: null,
          expectation: "NO_STRUCTURAL_EXPECTATION", a, b, aStage: stageOf(a), bStage: stageOf(b),
        });
      }
    }
  }

  return pairs.sort((x, y) =>
    Math.min(x.a.candidateNo, x.b.candidateNo) - Math.min(y.a.candidateNo, y.b.candidateNo)
    || Math.max(x.a.candidateNo, x.b.candidateNo) - Math.max(y.a.candidateNo, y.b.candidateNo));
}

/**
 * The overlap arithmetic, as a pure function over paired FINAL outcomes — exported so the
 * denominator rule and the identical/containment/partial/disjoint shapes can be proven directly
 * instead of through fixtures that must first fight the population-adaptive percentile boundaries
 * of two different candidates (task #192 §8 D/E). `overlapFor` below is its only production caller,
 * so the tested arithmetic is the shipped arithmetic.
 */
export type F5cOverlapMeasures = Omit<
  F5cOverlapPair,
  | "relation" | "relationKey" | "groupKey" | "seriesKey" | "expectation"
  | "aCandidateNo" | "bCandidateNo" | "aProvisionalKey" | "bProvisionalKey" | "aStage" | "bStage"
>;

export function f5cOverlapMeasures(
  outcomePairs: readonly (readonly [F5cShadowOutcome, F5cShadowOutcome])[],
): F5cOverlapMeasures {
  let bothKnown = 0, eitherUnknown = 0, aMatched = 0, bMatched = 0, bothMatched = 0, aOnly = 0, bOnly = 0, neither = 0;
  for (const [av, bv] of outcomePairs) {
    // UNKNOWN on either side leaves the denominator entirely — never counted as NOT_MATCHED.
    if (av === "UNKNOWN" || bv === "UNKNOWN") { eitherUnknown += 1; continue; }
    bothKnown += 1;
    const am = av === "MATCHED";
    const bm = bv === "MATCHED";
    if (am) aMatched += 1;
    if (bm) bMatched += 1;
    if (am && bm) bothMatched += 1;
    else if (am) aOnly += 1;
    else if (bm) bOnly += 1;
    else neither += 1;
  }
  const union = bothMatched + aOnly + bOnly;
  return {
    populationCount: outcomePairs.length,
    bothKnownCount: bothKnown,
    eitherUnknownCount: eitherUnknown,
    aMatchedCount: aMatched, bMatchedCount: bMatched, bothMatchedCount: bothMatched,
    aOnlyCount: aOnly, bOnlyCount: bOnly, neitherCount: neither,
    jaccard: union === 0 ? null : bothMatched / union,
    containmentAInB: aMatched === 0 ? null : bothMatched / aMatched,
    containmentBInA: bMatched === 0 ? null : bothMatched / bMatched,
  };
}

function overlapFor(
  selection: F5cPairSelection,
  outcomes: ReadonlyMap<number, ReadonlyMap<string, F5cShadowOutcome>>,
  subjects: readonly PlanningCalibrationSubjectMeasurement[],
): F5cOverlapPair {
  const { a, b } = selection;
  const aOut = outcomes.get(a.candidateNo);
  const bOut = outcomes.get(b.candidateNo);
  const pairs = subjects.map((s) => [
    aOut?.get(s.subjectUserId) ?? "UNKNOWN",
    bOut?.get(s.subjectUserId) ?? "UNKNOWN",
  ] as const);
  return {
    relation: selection.relation,
    relationKey: selection.relationKey,
    groupKey: selection.groupKey,
    seriesKey: selection.seriesKey,
    expectation: selection.expectation,
    aCandidateNo: a.candidateNo, bCandidateNo: b.candidateNo,
    aProvisionalKey: a.provisionalKey, bProvisionalKey: b.provisionalKey,
    aStage: selection.aStage, bStage: selection.bStage,
    ...f5cOverlapMeasures(pairs),
  };
}

function evidenceReadinessFor(
  sensitivity: F5cCandidateSensitivity,
  coverageWindowValidated: boolean,
): F5cCandidateEvidenceReadiness {
  const base = { candidateNo: sensitivity.candidateNo, provisionalKey: sensitivity.provisionalKey };
  const gate = F5C3_KNOWN_RELEASE_GATES.get(sensitivity.candidateNo);
  // A release gate outranks every calibration signal: good evidence is never permission to ship.
  if (gate !== undefined) return { ...base, readiness: "RELEASE_GATE_STILL_BLOCKED", reason: gate };
  if (sensitivity.executionStrategy === "UNSUPPORTED_GAP") {
    return { ...base, readiness: "NEEDS_MORE_CALIBRATION_EVIDENCE", reason: "candidate is not executable against the current contract" };
  }
  // Checked BEFORE knownCount: an unattested window is itself what collapses percentile-boundary
  // outcomes to UNKNOWN, so reporting "no subject has a known outcome" here would name the symptom
  // instead of the cause and send a reviewer looking for a cohort problem that does not exist.
  if (!coverageWindowValidated) {
    return {
      ...base,
      readiness: "NEEDS_MORE_CALIBRATION_EVIDENCE",
      reason: "coverage window is not attested — percentile-boundary outcomes are not decision-grade (see F5c2 percentileBoundaryOutcome)",
    };
  }
  if (sensitivity.representative.knownCount === 0) {
    return { ...base, readiness: "NEEDS_MORE_CALIBRATION_EVIDENCE", reason: "no subject has a known outcome in this cohort/window" };
  }
  if (sensitivity.dimensions.length > 0 && sensitivity.dimensions.every((d) => d.flat)) {
    return {
      ...base,
      readiness: "NEEDS_MORE_CALIBRATION_EVIDENCE",
      reason: "every sweepable dimension is flat across the grid — the evidence carries no threshold-choice information",
    };
  }
  return {
    ...base,
    readiness: "EVIDENCE_READY_FOR_THRESHOLD_REVIEW",
    reason: sensitivity.dimensions.length === 0
      ? "structural/pinned candidate with known outcomes — no threshold to choose, ready for the F6 adopt-as-is call"
      : "known outcomes plus at least one discriminating candidate-level sensitivity curve",
  };
}

/**
 * Every compatibility check a collection must pass before F5c3 will compute evidence from it, and
 * before its metadata may be reported as this run's provenance (PR #192レビュー第1ラウンド§4).
 *
 * All of it fails closed. Validating only the catalog/readiness hashes was not enough: the report
 * pins a percentile method, a schema version and a cohort size, and an unchecked collection could
 * have been accepted while the report claimed the CURRENT constants for values the collection was
 * never measured under. A hash mismatch is a loud, honest stop; a silently substituted constant is
 * an F6 reviewer trusting a number that describes a different run.
 *
 * `cohort.subjectCount` vs `subjects.length` and the duplicate-ID check both protect the
 * statistical population itself: a duplicated subject silently doubles one person's weight in
 * every percentile boundary while the displayed cohort count still looks right.
 *
 * Errors deliberately never name a subject — see the privacy boundary on the module doc.
 */
function assertCompatibleCollection(collection: PlanningCalibrationMeasurementCollection): void {
  const refuse = (what: string, got: unknown, expected: unknown): never => {
    throw new Error(`F5c3 evidence refused: collection ${what} ${String(got)} != live ${String(expected)}`);
  };
  if (collection.schemaVersion !== CALIBRATION_SCHEMA_VERSION) refuse("schemaVersion", collection.schemaVersion, CALIBRATION_SCHEMA_VERSION);
  if (collection.percentileMethod !== CALIBRATION_PERCENTILE_METHOD) refuse("percentileMethod", collection.percentileMethod, CALIBRATION_PERCENTILE_METHOD);
  const liveCatalogHash = canonicalCatalogHash(TITLE_V2_CATALOG_CANDIDATES);
  const liveReadinessHash = canonicalReadinessHash(TITLE_V2_CATALOG_READINESS);
  if (collection.catalogHash !== liveCatalogHash) refuse("catalogHash", collection.catalogHash, liveCatalogHash);
  if (collection.readinessHash !== liveReadinessHash) refuse("readinessHash", collection.readinessHash, liveReadinessHash);
  if (collection.catalogCandidateCount !== TITLE_V2_CATALOG_CANDIDATES.length) {
    refuse("catalogCandidateCount", collection.catalogCandidateCount, TITLE_V2_CATALOG_CANDIDATES.length);
  }
  if (collection.cohort.subjectCount !== collection.subjects.length) {
    throw new Error(`F5c3 evidence refused: collection cohort.subjectCount ${collection.cohort.subjectCount} != subjects.length ${collection.subjects.length}`);
  }
  const distinct = new Set(collection.subjects.map((s) => s.subjectUserId)).size;
  if (distinct !== collection.subjects.length) {
    // count only — naming the duplicated id here would put a restricted identity in an error
    // message, a log line, and an operator's terminal.
    throw new Error(`F5c3 evidence refused: collection contains ${collection.subjects.length - distinct} duplicate subject measurement(s)`);
  }
}

/**
 * Builds the aggregate F5c3 decision-evidence artifact from an already-collected planning
 * measurement collection. Restricted subject IDs are used transiently in memory only — the
 * returned report is aggregate-only and deep-frozen.
 *
 * Fails closed on ANY collection incompatibility (see `assertCompatibleCollection`): an F6
 * reviewer must never be handed evidence computed against a different catalog, schema, percentile
 * method, or population than the one the report claims.
 */
export function buildF5cDecisionEvidence(
  collection: PlanningCalibrationMeasurementCollection,
  coverageWindowValidated: boolean,
): F5cDecisionEvidenceReport {
  assertCompatibleCollection(collection);

  const subjects = collection.subjects;
  const sensitivity: F5cCandidateSensitivity[] = [];
  const outcomesByCandidate = new Map<number, ReadonlyMap<string, F5cShadowOutcome>>();

  for (const plan of F5C_CANDIDATE_SWEEP_PLANS) {
    // ONE representative execution per candidate, and it is the baseline every OAT point pins its
    // sibling boundaries to. Its per-subject outcomes feed overlap and are then dropped; the
    // expensive source data was already read once, when `collection` was built.
    const execution = executeCandidateAtSelection(plan, subjects, coverageWindowValidated);
    outcomesByCandidate.set(plan.candidateNo, execution.outcomeBySubject);
    sensitivity.push(candidateSensitivityFor(plan, subjects, coverageWindowValidated, execution));
  }

  const overlap = overlapPairsToAnalyze(F5C_CANDIDATE_SWEEP_PLANS)
    .map((selection) => overlapFor(selection, outcomesByCandidate, subjects));

  const evidenceReadiness = sensitivity.map((s) => evidenceReadinessFor(s, coverageWindowValidated));

  const provenance: F5cEvidenceProvenance = {
    sweepContractVersion: F5C_SWEEP_CONTRACT_VERSION,
    shadowContractVersion: F5C2_SHADOW_CONTRACT_VERSION,
    evidenceContractVersion: F5C3_EVIDENCE_CONTRACT_VERSION,
    calibrationSchemaVersion: collection.schemaVersion,
    catalogHash: collection.catalogHash,
    readinessHash: collection.readinessHash,
    catalogCandidateCount: collection.catalogCandidateCount,
    cohortKey: collection.cohort.key,
    cohortSubjectCount: collection.cohort.subjectCount,
    window: collection.window,
    coverageWindowValidated,
    // the VALIDATED collection's own method, not today's constant standing in for it.
    percentileMethod: collection.percentileMethod,
    percentileGrid: F5C2_BOUNDARY_PERCENTILES,
    candidateSensitivityModel: F5C3_SENSITIVITY_MODEL,
    siblingPinning: F5C3_SIBLING_PINNING,
    marginalAxisModel: F5C3_MARGINAL_MODEL_REFERENCE,
  };

  const body = { provenance, readyCandidateCount: F5C_CANDIDATE_SWEEP_PLANS.length, sensitivity, overlap, evidenceReadiness };
  const reportFingerprint = createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
  return deepFreeze({ ...body, reportFingerprint });
}

/** Convenience wrapper: collect + build in one call. Never persists/logs subject identity. */
export function runF5cDecisionEvidence(
  db: Database.Database,
  input: F5aCalibrationInput,
  coverageWindowValidated: boolean,
): F5cDecisionEvidenceReport {
  return buildF5cDecisionEvidence(collectF5cCalibrationMeasurements(db, input), coverageWindowValidated);
}
