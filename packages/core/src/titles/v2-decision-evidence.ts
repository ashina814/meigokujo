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
  F5C2_SENSITIVITY_MODEL,
  F5C2_SHADOW_CONTRACT_VERSION,
  type F5cBoundaryPercentile,
  type F5cBoundaryReliability,
  type F5cCandidateShadowResult,
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
export const F5C3_EVIDENCE_CONTRACT_VERSION = 1 as const;

/**
 * F5c2's `boundaryPoints` are **marginal axis pass rates** (that one axis's own distribution).
 * F5c3's OAT points are **final candidate prevalence** — the whole conjunction / manifest /
 * structural semantic re-evaluated with one dimension moved. The two are not comparable, so they
 * carry different type names, different field names, and an explicit model marker on each side.
 */
export const F5C3_SENSITIVITY_MODEL = "CANDIDATE_LEVEL_ONE_AXIS_AT_A_TIME" as const;

/** The marginal model F5c2 reports, echoed so a reader sees both models named side by side. */
export const F5C3_MARGINAL_MODEL_REFERENCE = F5C2_SENSITIVITY_MODEL;

// ─────────────────────────────────────────────────────────────
// candidate-level one-axis-at-a-time (OAT) sensitivity
// ─────────────────────────────────────────────────────────────

/**
 * One point of a candidate-level OAT curve: the FINAL candidate outcome distribution with this
 * dimension held at `percentile` and every sibling dimension held at its representative boundary.
 */
export interface F5cCandidateOatPoint {
  readonly percentile: F5cBoundaryPercentile;
  /** the dimension's own boundary value at this percentile; null when the population had no samples. */
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
 * (`groupKey` / `seriesKey`) — never from title names or prose (task #192 §3).
 */
export type F5cOverlapRelation = "SAME_GROUP" | "SAME_SERIES";

/**
 * All counts are over the **both-known denominator**: subjects whose FINAL outcome is known
 * (MATCHED or NOT_MATCHED) for BOTH candidates. A subject UNKNOWN on either side is excluded and
 * counted in `eitherUnknownCount` — it is never silently folded into NOT_MATCHED (task #192 §3/§5).
 */
export interface F5cOverlapPair {
  readonly relation: F5cOverlapRelation;
  readonly relationKey: string;
  readonly aCandidateNo: number;
  readonly bCandidateNo: number;
  readonly aProvisionalKey: string;
  readonly bProvisionalKey: string;
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
 * Enough context for an F6 reviewer to pin exactly which evidence run produced a number. Every
 * field is consumed from the deterministic collection or the live contracts — none is re-stated as
 * a literal here (task #192 §4).
 */
export interface F5cEvidenceProvenance {
  readonly sweepContractVersion: number;
  readonly shadowContractVersion: number;
  readonly evidenceContractVersion: typeof F5C3_EVIDENCE_CONTRACT_VERSION;
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
  representative: F5cCandidateShadowResult,
): F5cCandidateSensitivity {
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
    const points: F5cCandidateOatPoint[] = F5C2_BOUNDARY_PERCENTILES.map((percentile) => {
      // ONE dimension moves; every sibling stays representative. This is deliberately not a
      // Cartesian product — cost is |dimensions| × |grid| candidate evaluations, not |grid|^n.
      const { result } = executeCandidateAtSelection(plan, subjects, coverageWindowValidated, (key) =>
        key === dim.key ? percentile : 50,
      );
      const sweep = result.axisSweeps.find((s) => s.axisKey === dim.key);
      const point = sweep?.boundaryPoints.find((p) => p.percentile === percentile);
      return {
        percentile,
        boundaryValueAtPercentile: sweep === undefined || point === undefined || point.knownCount === 0 ? null : point.boundaryValue,
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

/**
 * Pair selection (task #192 §3): typed catalog structure only.
 *
 * - `SAME_GROUP` — candidates sharing a `groupKey` are, by catalog design, different facets of one
 *   concept. Suspiciously high overlap there is exactly the title-design smell worth surfacing.
 * - `SAME_SERIES` — candidates sharing a `seriesKey` are a staged progression, where containment
 *   is *expected*; measuring it validates that the staging is actually nested.
 *
 * Deliberately NOT all 76×76: an all-pairs dump would be thousands of mostly-meaningless numbers
 * with no review value, and choosing pairs any other way would require title-name/prose guesswork.
 */
function overlapPairsToAnalyze(
  plans: readonly F5cCandidateSweepPlan[],
): readonly { readonly relation: F5cOverlapRelation; readonly relationKey: string; readonly a: F5cCandidateSweepPlan; readonly b: F5cCandidateSweepPlan }[] {
  const byNo = new Map(TITLE_V2_CATALOG_CANDIDATES.map((c) => [c.no, c] as const));
  const pairs: { relation: F5cOverlapRelation; relationKey: string; a: F5cCandidateSweepPlan; b: F5cCandidateSweepPlan }[] = [];
  const emit = (relation: F5cOverlapRelation, keyOf: (no: number) => string | null) => {
    const buckets = new Map<string, F5cCandidateSweepPlan[]>();
    for (const plan of plans) {
      const key = keyOf(plan.candidateNo);
      if (key === null) continue;
      const list = buckets.get(key) ?? [];
      list.push(plan);
      buckets.set(key, list);
    }
    for (const [relationKey, members] of [...buckets.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      const ordered = [...members].sort((x, y) => x.candidateNo - y.candidateNo);
      for (let i = 0; i < ordered.length; i += 1) {
        for (let j = i + 1; j < ordered.length; j += 1) pairs.push({ relation, relationKey, a: ordered[i]!, b: ordered[j]! });
      }
    }
  };
  emit("SAME_GROUP", (no) => byNo.get(no)?.groupKey ?? null);
  emit("SAME_SERIES", (no) => byNo.get(no)?.seriesKey ?? null);
  return pairs;
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
  "relation" | "relationKey" | "aCandidateNo" | "bCandidateNo" | "aProvisionalKey" | "bProvisionalKey"
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
  relation: F5cOverlapRelation,
  relationKey: string,
  a: F5cCandidateSweepPlan,
  b: F5cCandidateSweepPlan,
  outcomes: ReadonlyMap<number, ReadonlyMap<string, F5cShadowOutcome>>,
  subjects: readonly PlanningCalibrationSubjectMeasurement[],
): F5cOverlapPair {
  const aOut = outcomes.get(a.candidateNo);
  const bOut = outcomes.get(b.candidateNo);
  const pairs = subjects.map((s) => [
    aOut?.get(s.subjectUserId) ?? "UNKNOWN",
    bOut?.get(s.subjectUserId) ?? "UNKNOWN",
  ] as const);
  return {
    relation, relationKey,
    aCandidateNo: a.candidateNo, bCandidateNo: b.candidateNo,
    aProvisionalKey: a.provisionalKey, bProvisionalKey: b.provisionalKey,
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
 * Builds the aggregate F5c3 decision-evidence artifact from an already-collected planning
 * measurement collection. Restricted subject IDs are used transiently in memory only — the
 * returned report is aggregate-only and deep-frozen.
 *
 * Fails closed when the collection's catalog/readiness provenance no longer matches the live
 * contracts: an F6 reviewer must never be handed evidence computed against a different catalog
 * than the one they are reviewing.
 */
export function buildF5cDecisionEvidence(
  collection: PlanningCalibrationMeasurementCollection,
  coverageWindowValidated: boolean,
): F5cDecisionEvidenceReport {
  const liveCatalogHash = canonicalCatalogHash(TITLE_V2_CATALOG_CANDIDATES);
  const liveReadinessHash = canonicalReadinessHash(TITLE_V2_CATALOG_READINESS);
  if (collection.catalogHash !== liveCatalogHash) {
    throw new Error(`F5c3 evidence refused: collection catalogHash ${collection.catalogHash} != live ${liveCatalogHash}`);
  }
  if (collection.readinessHash !== liveReadinessHash) {
    throw new Error(`F5c3 evidence refused: collection readinessHash ${collection.readinessHash} != live ${liveReadinessHash}`);
  }

  const subjects = collection.subjects;
  const sensitivity: F5cCandidateSensitivity[] = [];
  const outcomesByCandidate = new Map<number, ReadonlyMap<string, F5cShadowOutcome>>();

  for (const plan of F5C_CANDIDATE_SWEEP_PLANS) {
    // one representative execution per candidate; its per-subject outcomes feed overlap and are
    // then dropped. The expensive source data was already read once, when `collection` was built.
    const execution = executeCandidateAtSelection(plan, subjects, coverageWindowValidated);
    outcomesByCandidate.set(plan.candidateNo, execution.outcomeBySubject);
    sensitivity.push(candidateSensitivityFor(plan, subjects, coverageWindowValidated, execution.result));
  }

  const overlap = overlapPairsToAnalyze(F5C_CANDIDATE_SWEEP_PLANS)
    .map(({ relation, relationKey, a, b }) => overlapFor(relation, relationKey, a, b, outcomesByCandidate, subjects));

  const evidenceReadiness = sensitivity.map((s) => evidenceReadinessFor(s, coverageWindowValidated));

  const provenance: F5cEvidenceProvenance = {
    sweepContractVersion: F5C_SWEEP_CONTRACT_VERSION,
    shadowContractVersion: F5C2_SHADOW_CONTRACT_VERSION,
    evidenceContractVersion: F5C3_EVIDENCE_CONTRACT_VERSION,
    catalogHash: collection.catalogHash,
    readinessHash: collection.readinessHash,
    catalogCandidateCount: collection.catalogCandidateCount,
    cohortKey: collection.cohort.key,
    cohortSubjectCount: collection.cohort.subjectCount,
    window: collection.window,
    coverageWindowValidated,
    percentileMethod: CALIBRATION_PERCENTILE_METHOD,
    percentileGrid: F5C2_BOUNDARY_PERCENTILES,
    candidateSensitivityModel: F5C3_SENSITIVITY_MODEL,
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
