import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { Takutate } from "../src/casino/takutate.js";
import { EventLog } from "../src/events/service.js";
import { PublicEvents } from "../src/public-events/service.js";
import { BumpCounter } from "../src/rank/bump.js";
import { RoleFamilyTemporal } from "../src/role-family/temporal.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { VcPublicSocialPresence } from "../src/vc/public-social-presence.js";
import { F5C_CANDIDATE_SWEEP_PLANS, F5C_SWEEP_CONTRACT_VERSION } from "../src/titles/v2-calibration-sweep.js";
import { CALIBRATION_SCHEMA_VERSION, CALIBRATION_PERCENTILE_METHOD, canonicalReadinessHash } from "../src/titles/v2-calibration.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import { canonicalCatalogHash, TITLE_V2_CATALOG_CANDIDATES } from "../src/titles/v2-catalog-candidates.js";
import {
  executeCandidateAtSelection,
  executeF5cShadowCalibration,
  F5C2_BOUNDARY_PERCENTILES,
  F5C2_REPRESENTATIVE_PERCENTILE,
  F5C2_SHADOW_CONTRACT_VERSION,
} from "../src/titles/v2-shadow-evaluation.js";
import {
  buildF5cDecisionEvidence,
  runF5cDecisionEvidence,
  f5cOverlapMeasures,
  F5C3_EVIDENCE_CONTRACT_VERSION,
  F5C3_SENSITIVITY_MODEL,
  F5C3_SIBLING_PINNING,
  F5C3_KNOWN_RELEASE_GATES,
  type F5cDecisionEvidenceReport,
} from "../src/titles/v2-decision-evidence.js";
import { main, openSnapshotReadOnly, parseArgs, readSubjectUserIds } from "../scripts/f5c3-decision-evidence.js";
import type { PlanningCalibrationJointEvidence, PlanningCalibrationMeasurementCollection, PlanningCalibrationSubjectMeasurement } from "../src/titles/v2-calibration.js";
import type { F5cShadowOutcome } from "../src/titles/v2-shadow-evaluation.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1_000);
const DAY = 86_400;
const WINDOW = Object.freeze({ start: BASE, end: BASE + 10 * DAY, observedAt: BASE + 8 * DAY });

function collection(
  subjects: readonly PlanningCalibrationSubjectMeasurement[],
  overrides: Partial<PlanningCalibrationMeasurementCollection> = {},
): PlanningCalibrationMeasurementCollection {
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    percentileMethod: CALIBRATION_PERCENTILE_METHOD,
    catalogHash: canonicalCatalogHash(TITLE_V2_CATALOG_CANDIDATES),
    readinessHash: canonicalReadinessHash(TITLE_V2_CATALOG_READINESS),
    catalogCandidateCount: TITLE_V2_CATALOG_CANDIDATES.length,
    cohort: { key: "evidence-fixture", subjectCount: subjects.length },
    window: { start: WINDOW.start, end: WINDOW.end, observedAt: WINDOW.observedAt, effectiveEnd: WINDOW.observedAt },
    packReadCalls: [],
    sourceReadCalls: [],
    subjects,
    ...overrides,
  } as PlanningCalibrationMeasurementCollection;
}

function subject(
  subjectUserId: string,
  packs: ReadonlyArray<{
    readonly probeKey: string;
    readonly metrics?: Readonly<Record<string, number | null>>;
    readonly jointEvidence?: PlanningCalibrationJointEvidence;
  }>,
): PlanningCalibrationSubjectMeasurement {
  return {
    subjectUserId,
    packs: packs.map((p) => ({
      probeKey: p.probeKey as never,
      metrics: p.metrics ?? {},
      tcGapsByHour: [],
      jointEvidence: p.jointEvidence ?? { kind: "none" },
    })),
  };
}

function probeKeyFor(no: number): string {
  return F5C_CANDIDATE_SWEEP_PLANS.find((p) => p.candidateNo === no)!.probeKey;
}
function sensitivityFor(report: F5cDecisionEvidenceReport, no: number) {
  return report.sensitivity.find((s) => s.candidateNo === no)!;
}
function dimensionOf(report: F5cDecisionEvidenceReport, no: number, key: string) {
  return sensitivityFor(report, no).dimensions.find((d) => d.dimensionKey === key)!;
}

/**
 * No.2's two METRIC axes over one probe. `distinctOccurrenceDays` is identical for every subject
 * (so that axis's own marginal pass rate is 1.0 at every percentile), while `occurrenceSpanDays`
 * differs — letting the sibling requirement, not the swept axis, decide the final conjunction.
 */
function welcoming(id: string, distinctOccurrenceDays: number | null, occurrenceSpanDays: number | null) {
  const metrics: Record<string, number | null> = { occurrenceCount: 5 };
  if (distinctOccurrenceDays !== null) metrics.distinctOccurrenceDays = distinctOccurrenceDays;
  if (occurrenceSpanDays !== null) metrics.occurrenceSpanDays = occurrenceSpanDays;
  return subject(id, [{ probeKey: probeKeyFor(2), metrics }]);
}

/**
 * No.76 is the smallest genuinely DEPENDENT pipeline in READY-76: one SCALAR_SAMPLE filter
 * (`rooted-branch-social-evidence`, over each activity day's trusted social seconds) feeding one
 * FILTER_THEN_DISTINCT_DAYS reduction (`rooted-branch-activity-days`) inside a single row group.
 * Moving the filter changes which rows survive, which changes the reduction's own distribution —
 * exactly the case a percentile-rank "hold" cannot keep still.
 */
function rootedBranch(id: string, days: readonly (readonly [number, number])[]) {
  return subject(id, [{
    probeKey: probeKeyFor(76),
    jointEvidence: {
      kind: "invite-rooted-v1",
      unknownEntryAnchorCount: 0,
      profiles: [{
        profileOrdinal: 1,
        activityDays: days.map(([dayOffset, vcTrustedSocialSeconds]) => ({ dayOffset, tcBestOtherGapMs: null, vcTrustedSocialSeconds })),
        nextGenerationOccurrences: [],
        unknownNextGenerationEntryAnchorCount: 0,
        reunionDays: [],
      }],
    },
  }]);
}

/**
 * Population trusted-social-seconds samples are [50, 50, 50, 100, 100, 100]: nearest-rank p50 = 50
 * (every row qualifies) and p75 = 100 (only carol's rows qualify). Baseline qualifying-day samples
 * are therefore [1, 2, 3] with p50 = 2 — and the reviewer's [0, 0, 3] / p50 = 0 case is exactly
 * what the filter at p75 produces.
 */
const ROOTED_SUBJECTS = [
  rootedBranch("alice", [[1, 50]]),
  rootedBranch("bob", [[1, 50], [2, 50]]),
  rootedBranch("carol", [[1, 100], [2, 100], [3, 100]]),
];
const ROOTED_FILTER_DIM = "rooted-branch-social-evidence";
const ROOTED_REDUCTION_DIM = "rooted-branch-activity-days";

describe("F5c3 decision-evidence layer", () => {
  // ── A. candidate-level sensitivity is NOT the marginal axis pass rate ──────────────────────
  it("A. a candidate-level OAT curve reflects the FINAL conjunction, not the swept axis's own marginal pass rate", () => {
    // every subject has distinctOccurrenceDays = 10, so the "welcoming-days" axis passes 100% of
    // known subjects at EVERY percentile. But the sibling span requirement (p50 = 4) excludes the
    // one subject with span 1, so the FINAL candidate prevalence is 0.75 — never 1.0.
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 4), welcoming("c", 10, 4), welcoming("d", 10, 1)];
    const shadow = executeF5cShadowCalibration(collection(subjects), true);
    const evidence = buildF5cDecisionEvidence(collection(subjects), true);

    const marginal = shadow.results.find((r) => r.candidateNo === 2)!.axisSweeps.find((s) => s.axisKey === "welcoming-days")!;
    const oat = dimensionOf(evidence, 2, "welcoming-days");

    for (const point of marginal.boundaryPoints) expect(point.marginalPassRate).toBe(1); // axis alone: 100%
    for (const point of oat.points) expect(point.candidatePrevalence).toBe(0.75); // candidate: 75%
    // the two models must be impossible to confuse — different field names, both present.
    expect(marginal.boundaryPoints[0]).toHaveProperty("marginalPassRate");
    expect(oat.points[0]).toHaveProperty("candidatePrevalence");
    expect(oat.points[0]).not.toHaveProperty("marginalPassRate");
  });

  // ── B. OAT holds siblings at their representative boundary ────────────────────────────────
  it("B. sweeping one dimension does not move a sibling dimension's boundary", () => {
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 4), welcoming("c", 10, 4), welcoming("d", 10, 1)];
    const evidence = buildF5cDecisionEvidence(collection(subjects), true);

    // Sweeping "welcoming-days" must leave the span sibling pinned at its p50 boundary of 4, so
    // prevalence stays 0.75 at every point. If the selection leaked to all dimensions, span would
    // drop to its p10 boundary of 1 and every subject would match (prevalence 1.0).
    const days = dimensionOf(evidence, 2, "welcoming-days");
    expect(new Set(days.points.map((p) => p.candidatePrevalence))).toEqual(new Set([0.75]));
    expect(days.flat).toBe(true);

    // ...while sweeping the span dimension itself genuinely moves the candidate: at p10 its
    // boundary is 1 (everyone matches) and at p50 it is 4 (the span-1 subject drops out).
    const span = dimensionOf(evidence, 2, "welcoming-span");
    expect(span.points.find((p) => p.percentile === 10)!.boundaryValueAtPercentile).toBe(1);
    expect(span.points.find((p) => p.percentile === 10)!.candidatePrevalence).toBe(1);
    expect(span.points.find((p) => p.percentile === 50)!.boundaryValueAtPercentile).toBe(4);
    expect(span.points.find((p) => p.percentile === 50)!.candidatePrevalence).toBe(0.75);
    expect(span.flat).toBe(false);
  });

  // ── B2. dependent pipeline: the sibling's NUMERIC boundary is what stays still ────────────
  it("B2. sweeping an upstream filter does not move the downstream reduction's numeric boundary", () => {
    const evidence = buildF5cDecisionEvidence(collection(ROOTED_SUBJECTS), true);
    const plan = F5C_CANDIDATE_SWEEP_PLANS.find((p) => p.candidateNo === 76)!;

    // Baseline: filter p50 = 50 admits every row, so qualifying days are [1, 2, 3] and the
    // reduction's own p50 boundary is 2 — bob and carol clear it, alice does not.
    expect(sensitivityFor(evidence, 76).representative.candidatePrevalence).toBe(2 / 3);
    expect(dimensionOf(evidence, 76, ROOTED_REDUCTION_DIM).points.find((p) => p.percentile === 50)!.boundaryValueAtPercentile).toBe(2);

    // Sweeping ONLY the filter to p75 = 100 leaves alice and bob with zero qualifying days, so the
    // reduction's CONDITIONAL distribution collapses to [0, 0, 3] (conditional p50 = 0). The
    // decision boundary must stay at the baseline 2, so only carol still matches.
    const filterDim = dimensionOf(evidence, 76, ROOTED_FILTER_DIM);
    const atP75 = filterDim.points.find((p) => p.percentile === 75)!;
    expect(atP75.boundaryValueAtPercentile).toBe(100); // the one boundary that moved
    expect(atP75.candidatePrevalence).toBe(1 / 3);
    expect(atP75.matchedCount).toBe(1);
    expect(atP75.notMatchedCount).toBe(2);

    // ...and this is precisely what percentile-RANK pinning gets wrong. Held at "p50", the sibling
    // re-derives its boundary from the conditional [0, 0, 3] and lands on 0, so `>= 0` admits
    // everyone: a one-axis-at-a-time label over a run that moved two production boundaries.
    const rankPinned = executeCandidateAtSelection(plan, ROOTED_SUBJECTS, true, (key, conditional) =>
      conditional.get(key === ROOTED_FILTER_DIM ? 75 : 50));
    expect(rankPinned.result.prevalence).toBe(1);
    expect(rankPinned.result.matchedCount).toBe(3);
  });

  it("B2b. sweeping the edge filter does not move the POST_FILTER_MATCHING_SIZE threshold", () => {
    // The other genuinely dependent path: No.26's matching size is recomputed after its sibling
    // edge filter, so moving the filter moves the matching-size DISTRIBUTION. The matching-size
    // decision boundary must not follow it.
    const richGraph = (): PlanningCalibrationJointEvidence => ({
      kind: "social-context-graph-v1",
      dimension: "class",
      counterparts: [
        { counterpartOrdinal: 0, touches: [{ semanticIndex: 0, days: [{ dayOffset: 1, trustedSeconds: 100 }] }, { semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 90 }] }] },
        { counterpartOrdinal: 1, touches: [{ semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 80 }] }, { semanticIndex: 2, days: [{ dayOffset: 1, trustedSeconds: 20 }] }] },
        { counterpartOrdinal: 2, touches: [{ semanticIndex: 2, days: [{ dayOffset: 1, trustedSeconds: 10 }] }] },
      ],
    });
    const subjects = [
      subject("alice", [{ probeKey: probeKeyFor(26), jointEvidence: richGraph() }]),
      subject("bob", [{ probeKey: probeKeyFor(26), jointEvidence: {
        kind: "social-context-graph-v1", dimension: "class",
        counterparts: [{ counterpartOrdinal: 0, touches: [{ semanticIndex: 0, days: [{ dayOffset: 1, trustedSeconds: 50 }] }, { semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 3 }] }] }],
      } }]),
      subject("carol", [{ probeKey: probeKeyFor(26), jointEvidence: richGraph() }]),
    ];
    const evidence = buildF5cDecisionEvidence(collection(subjects), true);
    const plan = F5C_CANDIDATE_SWEEP_PLANS.find((p) => p.candidateNo === 26)!;

    // baseline: edge boundary 50 -> matching sizes [2, 1, 2] -> matching boundary 2 (alice, carol).
    expect(sensitivityFor(evidence, 26).representative.candidatePrevalence).toBe(2 / 3);
    expect(dimensionOf(evidence, 26, "class-person-matching").points.find((p) => p.percentile === 50)!.boundaryValueAtPercentile).toBe(2);

    // sweeping the EDGE filter to p90 = 100 shrinks every graph to matching sizes [1, 0, 1]. The
    // matching-size threshold stays at the baseline 2, so nobody clears it.
    const edge = dimensionOf(evidence, 26, "class-edge-trusted-seconds");
    const atP90 = edge.points.find((p) => p.percentile === 90)!;
    expect(atP90.boundaryValueAtPercentile).toBe(100);
    expect(atP90.candidatePrevalence).toBe(0);

    // percentile-RANK pinning instead re-derives the matching threshold from the shrunken [0, 1, 1]
    // distribution, lands on 1, and reports an unchanged 2/3 — hiding the effect entirely.
    const rankPinned = executeCandidateAtSelection(plan, subjects, true, (key, conditional) =>
      conditional.get(key === "class-edge-trusted-seconds" ? 90 : 50));
    expect(rankPinned.result.prevalence).toBe(2 / 3);
  });

  it("B3. every OAT curve reproduces the baseline exactly at the representative percentile", () => {
    // The single strongest drift regression for the F5c2/F5c3 representative SSOT (§2): F5c3 must
    // consume `F5C2_REPRESENTATIVE_PERCENTILE` rather than restating 50, so that moving F5c2's
    // representative moves both layers together. If F5c3 held siblings at a hardcoded rank while
    // F5c2's baseline used a different one, this identity would break for every dependent
    // candidate at once.
    expect(F5C2_BOUNDARY_PERCENTILES).toContain(F5C2_REPRESENTATIVE_PERCENTILE);
    const evidence = buildF5cDecisionEvidence(collection([...ROOTED_SUBJECTS, welcoming("d", 10, 4), welcoming("e", 10, 1)]), true);
    let checked = 0;
    for (const candidate of evidence.sensitivity) {
      for (const dimension of candidate.dimensions) {
        const atRepresentative = dimension.points.find((p) => p.percentile === F5C2_REPRESENTATIVE_PERCENTILE)!;
        expect(atRepresentative.knownCount).toBe(candidate.representative.knownCount);
        expect(atRepresentative.unknownCount).toBe(candidate.representative.unknownCount);
        expect(atRepresentative.matchedCount).toBe(candidate.representative.matchedCount);
        expect(atRepresentative.notMatchedCount).toBe(candidate.representative.notMatchedCount);
        expect(atRepresentative.candidatePrevalence).toBe(candidate.representative.candidatePrevalence);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100); // the invariant is checked across the whole READY set
    expect(evidence.provenance.siblingPinning).toBe(F5C3_SIBLING_PINNING);
  });

  // ── C. three-valued propagation ───────────────────────────────────────────────────────────
  it("C. an UNKNOWN sibling requirement propagates through the candidate-level curve per Kleene AND", () => {
    // "d" is missing occurrenceSpanDays entirely -> that axis is UNKNOWN. With no NOT_MATCHED
    // among its other axes, the candidate is UNKNOWN for d: excluded from knownCount, never
    // silently counted as a non-match.
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 4), welcoming("c", 10, 4), welcoming("d", 10, null)];
    const evidence = buildF5cDecisionEvidence(collection(subjects), true);
    const days = dimensionOf(evidence, 2, "welcoming-days");
    for (const point of days.points) {
      expect(point.unknownCount).toBe(1);
      expect(point.knownCount).toBe(3);
      expect(point.matchedCount + point.notMatchedCount).toBe(3);
      expect(point.candidatePrevalence).toBe(1); // the 3 known subjects all match
    }
    expect(sensitivityFor(evidence, 2).representative.unknownCount).toBe(1);
  });

  // ── D/E. overlap denominator + shapes ─────────────────────────────────────────────────────
  const M: F5cShadowOutcome = "MATCHED";
  const N: F5cShadowOutcome = "NOT_MATCHED";
  const U: F5cShadowOutcome = "UNKNOWN";

  it("D. a subject UNKNOWN on either side leaves the denominator entirely — it never becomes a non-match", () => {
    // A matches both known subjects; B matches one. The two UNKNOWN-bearing rows must not appear
    // as "neither" (which would depress Jaccard) — they must leave the denominator.
    const m = f5cOverlapMeasures([[M, M], [M, N], [M, U], [U, N]]);
    expect(m.populationCount).toBe(4);
    expect(m.bothKnownCount).toBe(2);
    expect(m.eitherUnknownCount).toBe(2);
    expect(m.aMatchedCount).toBe(2);
    expect(m.bMatchedCount).toBe(1);
    expect(m.bothMatchedCount).toBe(1);
    expect(m.aOnlyCount).toBe(1);
    expect(m.bOnlyCount).toBe(0);
    expect(m.neitherCount).toBe(0); // the UNKNOWN rows did NOT land here
    expect(m.jaccard).toBe(1 / 2);
    expect(m.containmentBInA).toBe(1); // B ⊆ A within the both-known denominator
    expect(m.containmentAInB).toBe(1 / 2);
  });

  it("E. identical / strict containment / partial overlap / disjoint produce the expected aggregate measures", () => {
    const identical = f5cOverlapMeasures([[M, M], [M, M], [N, N], [N, N]]);
    expect(identical.jaccard).toBe(1);
    expect(identical.containmentAInB).toBe(1);
    expect(identical.containmentBInA).toBe(1);

    // B ⊂ A strictly: everything B matches, A matches; A matches one more.
    const contained = f5cOverlapMeasures([[M, M], [M, N], [N, N]]);
    expect(contained.containmentBInA).toBe(1);
    expect(contained.containmentAInB).toBe(1 / 2);
    expect(contained.jaccard).toBe(1 / 2);
    expect(contained.aOnlyCount).toBe(1);
    expect(contained.bOnlyCount).toBe(0);

    const partial = f5cOverlapMeasures([[M, M], [M, N], [N, M], [N, N]]);
    expect(partial.jaccard).toBe(1 / 3);
    expect(partial.containmentAInB).toBe(1 / 2);
    expect(partial.containmentBInA).toBe(1 / 2);

    const disjoint = f5cOverlapMeasures([[M, N], [N, M], [N, N]]);
    expect(disjoint.jaccard).toBe(0);
    expect(disjoint.containmentAInB).toBe(0);
    expect(disjoint.containmentBInA).toBe(0);

    // nobody matched on either side: ratios are null, not a misleading 0 or NaN.
    const empty = f5cOverlapMeasures([[N, N], [N, U]]);
    expect(empty.jaccard).toBeNull();
    expect(empty.containmentAInB).toBeNull();
    expect(empty.containmentBInA).toBeNull();
  });

  it("E2. overlap pairs come from typed catalog structure (groupKey / seriesKey / stage), not all 76×76 and not title prose", () => {
    const report = buildF5cDecisionEvidence(collection([]), true);
    const readyNos = new Set(F5C_CANDIDATE_SWEEP_PLANS.map((p) => p.candidateNo));
    expect(report.overlap.length).toBeGreaterThan(0);
    expect(report.overlap.length).toBeLessThan((readyNos.size * (readyNos.size - 1)) / 2); // NOT all-pairs
    const byNo = new Map(TITLE_V2_CATALOG_CANDIDATES.map((c) => [c.no, c] as const));
    for (const pair of report.overlap) {
      expect(readyNos.has(pair.aCandidateNo) && readyNos.has(pair.bCandidateNo)).toBe(true);
      const a = byNo.get(pair.aCandidateNo)!;
      const b = byNo.get(pair.bCandidateNo)!;
      // every emitted pair is justified by a typed catalog relation, never by a name/prose guess.
      expect(a.groupKey).toBe(b.groupKey);
      expect(pair.groupKey).toBe(a.groupKey);
      if (pair.relation === "SERIES_PROGRESSION") {
        expect(a.seriesKey).toBe(b.seriesKey);
        expect(pair.seriesKey).toBe(a.seriesKey);
        expect(pair.relationKey).toBe(a.seriesKey);
        expect(pair.expectation).toBe("HIGHER_STAGE_WITHIN_LOWER_STAGE");
        // A is the LOWER stage — the direction the expectation is about — and it comes from the
        // typed `stage` field, not from candidate numbering.
        expect(pair.aStage).toBe(a.stage);
        expect(pair.bStage).toBe(b.stage);
        expect(pair.aStage!).toBeLessThan(pair.bStage!);
      } else {
        expect(pair.relationKey).toBe(a.groupKey);
        expect(pair.seriesKey).toBeNull();
        expect(pair.expectation).toBe("NO_STRUCTURAL_EXPECTATION");
        expect(pair.aCandidateNo).toBeLessThan(pair.bCandidateNo); // deterministic ordering
        // a group sibling pair is emitted only when no single series already explains it.
        expect(a.seriesKey === null || a.seriesKey !== b.seriesKey).toBe(true);
      }
    }
    // the activity_time facets (No.32-35 dayparts) share a group but no series: a neutral pair.
    const dayparts = report.overlap.find((p) => p.aCandidateNo === 32 && p.bCandidateNo === 34)!;
    expect(dayparts.relation).toBe("GROUP_SIBLING");
    expect(dayparts.expectation).toBe("NO_STRUCTURAL_EXPECTATION");
  });

  it("E2b. a pair sharing BOTH groupKey and seriesKey is emitted once, with one coherent reading", () => {
    // No.10-12 (`vc_duo_style`, stages 1-3) carry the same value in groupKey AND seriesKey — the
    // case that used to emit each pair twice, once as a "facets that should not overlap" smell and
    // once as a "containment is expected" progression, attaching two contradictory readings to one
    // measured number.
    const report = buildF5cDecisionEvidence(collection([]), true);
    const byNo = new Map(TITLE_V2_CATALOG_CANDIDATES.map((c) => [c.no, c] as const));
    expect(byNo.get(10)!.groupKey).toBe(byNo.get(10)!.seriesKey); // the premise really does hold
    expect(byNo.get(11)!.groupKey).toBe(byNo.get(11)!.seriesKey);

    const staged = report.overlap.filter((p) => p.aCandidateNo === 10 && p.bCandidateNo === 11);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.relation).toBe("SERIES_PROGRESSION"); // series wins; no bare group duplicate
    expect(staged[0]!.groupKey).toBe("vc_duo_style"); // ...and the group fact is still reported
    expect(staged[0]!.seriesKey).toBe("vc_duo_style");
    expect(staged[0]!.expectation).toBe("HIGHER_STAGE_WITHIN_LOWER_STAGE");

    // globally: no unordered candidate pair appears more than once, under any relation.
    const seen = new Set<string>();
    for (const pair of report.overlap) {
      const key = `${Math.min(pair.aCandidateNo, pair.bCandidateNo)}-${Math.max(pair.aCandidateNo, pair.bCandidateNo)}`;
      expect(seen.has(key), `duplicate overlap pair ${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(report.overlap.length);
  });

  it("E3. real candidate outcomes flow into overlap with the both-known denominator intact", () => {
    // Two subjects with genuinely different daypart behavior, evaluated through the SAME shared
    // evaluator that produced the shadow report — the overlap counts must reconcile with it.
    const probeKey = probeKeyFor(32);
    const rows = (hour: number) => Array.from({ length: 3 }, (_, i) => ({ dayOffset: i + 1, hour, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 }));
    const subjects = [
      subject("morning", [{ probeKey, jointEvidence: { kind: "activity-time-day-hour-v1", rows: rows(8) } }]),
      subject("evening", [{ probeKey, jointEvidence: { kind: "activity-time-day-hour-v1", rows: rows(20) } }]),
      subject("unmeasured", []),
    ];
    const evidence = buildF5cDecisionEvidence(collection(subjects), true);
    const shadow = executeF5cShadowCalibration(collection(subjects), true);
    const pair = evidence.overlap.find((p) => p.aCandidateNo === 32 && p.bCandidateNo === 34)!;

    // the never-measured subject is UNKNOWN for both candidates -> outside the denominator.
    expect(pair.populationCount).toBe(3);
    expect(pair.bothKnownCount + pair.eitherUnknownCount).toBe(3);
    expect(pair.eitherUnknownCount).toBeGreaterThanOrEqual(1);
    // per-candidate matched counts must agree with the F5c2 representative report.
    expect(pair.aMatchedCount).toBe(shadow.results.find((r) => r.candidateNo === 32)!.matchedCount);
    expect(pair.bMatchedCount).toBe(shadow.results.find((r) => r.candidateNo === 34)!.matchedCount);
    // every partition sums back to the denominator.
    expect(pair.bothMatchedCount + pair.aOnlyCount + pair.bOnlyCount + pair.neitherCount).toBe(pair.bothKnownCount);
  });

  // ── F. privacy ────────────────────────────────────────────────────────────────────────────
  it("F. no restricted subject identity or raw evidence appears in the serialized evidence artifact", () => {
    const probeKey = probeKeyFor(32);
    const subjects = [
      subject("RESTRICTED_SUBJECT_ID_777", [{
        probeKey,
        jointEvidence: { kind: "activity-time-day-hour-v1", rows: [{ dayOffset: 1, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 }] },
      }]),
      welcoming("RESTRICTED_SUBJECT_ID_888", 10, 4),
    ];
    const serialized = JSON.stringify(buildF5cDecisionEvidence(collection(subjects), true));
    expect(serialized).not.toContain("RESTRICTED_SUBJECT_ID_777");
    expect(serialized).not.toContain("RESTRICTED_SUBJECT_ID_888");
    expect(serialized).not.toContain("subjectUserId");
    expect(serialized).not.toContain("jointEvidence");
    expect(serialized).not.toContain("tcBestOtherGapMs");
  });

  it("F2. the evidence artifact is deep-frozen", () => {
    const report = buildF5cDecisionEvidence(collection([]), true);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.sensitivity)).toBe(true);
    expect(Object.isFrozen(report.sensitivity[0])).toBe(true);
    expect(Object.isFrozen(report.provenance)).toBe(true);
  });

  // ── G. provenance ─────────────────────────────────────────────────────────────────────────
  it("G. provenance pins the live contracts/cohort/window/attestation and is consumed, not restated", () => {
    const subjects = [welcoming("a", 10, 4)];
    const c = collection(subjects);
    const report = buildF5cDecisionEvidence(c, false);
    const p = report.provenance;
    expect(p.sweepContractVersion).toBe(F5C_SWEEP_CONTRACT_VERSION);
    expect(p.shadowContractVersion).toBe(F5C2_SHADOW_CONTRACT_VERSION);
    expect(p.evidenceContractVersion).toBe(F5C3_EVIDENCE_CONTRACT_VERSION);
    expect(p.calibrationSchemaVersion).toBe(c.schemaVersion);
    expect(p.catalogHash).toBe(c.catalogHash);
    expect(p.readinessHash).toBe(c.readinessHash);
    expect(p.catalogCandidateCount).toBe(c.catalogCandidateCount);
    expect(p.cohortKey).toBe(c.cohort.key);
    expect(p.cohortSubjectCount).toBe(c.cohort.subjectCount);
    expect(p.window).toEqual(c.window);
    expect(p.coverageWindowValidated).toBe(false);
    // reported from the VALIDATED collection, not by substituting today's constant for it.
    expect(p.percentileMethod).toBe(c.percentileMethod);
    expect(p.percentileMethod).toBe(CALIBRATION_PERCENTILE_METHOD);
    expect(p.percentileGrid).toEqual([...F5C2_BOUNDARY_PERCENTILES]);
    expect(p.candidateSensitivityModel).toBe(F5C3_SENSITIVITY_MODEL);
    expect(p.siblingPinning).toBe(F5C3_SIBLING_PINNING);
  });

  it("G2. every collection incompatibility fails closed rather than producing evidence the provenance misdescribes", () => {
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 1)];
    const ok = collection(subjects);
    expect(() => buildF5cDecisionEvidence(ok, true)).not.toThrow(); // the control

    expect(() => buildF5cDecisionEvidence(collection(subjects, { catalogHash: "stale-catalog-hash" }), true))
      .toThrow(/catalogHash/);
    expect(() => buildF5cDecisionEvidence(collection(subjects, { readinessHash: "stale-readiness-hash" }), true))
      .toThrow(/readinessHash/);
    // a stale schema/percentile method must not be quietly overwritten by the live constant in the
    // provenance — the whole point of pinning it is that it describes THIS collection.
    expect(() => buildF5cDecisionEvidence(collection(subjects, { schemaVersion: (CALIBRATION_SCHEMA_VERSION + 1) as never }), true))
      .toThrow(/schemaVersion/);
    expect(() => buildF5cDecisionEvidence(collection(subjects, { percentileMethod: "linear-interpolation" as never }), true))
      .toThrow(/percentileMethod/);
    expect(() => buildF5cDecisionEvidence(collection(subjects, { catalogCandidateCount: TITLE_V2_CATALOG_CANDIDATES.length - 1 }), true))
      .toThrow(/catalogCandidateCount/);
    // the displayed cohort size must match the population the numbers were computed over.
    expect(() => buildF5cDecisionEvidence(collection(subjects, { cohort: { key: "k", subjectCount: 99 } }), true))
      .toThrow(/subjectCount/);
  });

  it("G2b. a duplicated subject is refused — it reweights every percentile boundary while the cohort count still looks right", () => {
    const duplicated = [welcoming("RESTRICTED_DUP_ID", 10, 4), welcoming("RESTRICTED_DUP_ID", 10, 4), welcoming("b", 10, 1)];
    // cohort.subjectCount agrees with subjects.length here, so only the identity check catches it.
    expect(() => buildF5cDecisionEvidence(collection(duplicated), true)).toThrow(/duplicate subject/);
    // ...and the refusal never names the subject: an error message reaches logs and terminals.
    try {
      buildF5cDecisionEvidence(collection(duplicated), true);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(String(error)).not.toContain("RESTRICTED_DUP_ID");
    }
  });

  it("G3. the report fingerprint is deterministic and changes when any pinned input changes", () => {
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 1)];
    const a = buildF5cDecisionEvidence(collection(subjects), true);
    const b = buildF5cDecisionEvidence(collection(subjects), true);
    expect(a.reportFingerprint).toBe(b.reportFingerprint); // deterministic
    // the attestation is part of the pinned evidence identity.
    expect(buildF5cDecisionEvidence(collection(subjects), false).reportFingerprint).not.toBe(a.reportFingerprint);
    // so is the cohort.
    expect(buildF5cDecisionEvidence(collection(subjects, { cohort: { key: "other", subjectCount: 2 } }), true).reportFingerprint)
      .not.toBe(a.reportFingerprint);
  });

  // ── coverage semantics stay visible ───────────────────────────────────────────────────────
  it("coverage: an unattested window keeps candidate-level points non-definitive instead of forcing a prevalence", () => {
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 4), welcoming("c", 10, 1)];
    const attested = buildF5cDecisionEvidence(collection(subjects), true);
    const unattested = buildF5cDecisionEvidence(collection(subjects), false);
    // attested: real percentile-boundary outcomes.
    expect(sensitivityFor(attested, 2).representative.knownCount).toBe(3);
    // unattested: F5c2's percentileBoundaryOutcome collapses these to UNKNOWN, and F5c3 shows the
    // resulting null prevalence rather than inventing a number.
    expect(sensitivityFor(unattested, 2).representative.knownCount).toBe(0);
    expect(sensitivityFor(unattested, 2).representative.candidatePrevalence).toBeNull();
    for (const point of dimensionOf(unattested, 2, "welcoming-span").points) {
      expect(point.candidatePrevalence).toBeNull();
      expect(point.unknownCount).toBe(3);
    }
    // and the readiness classification says so explicitly.
    const readiness = unattested.evidenceReadiness.find((r) => r.candidateNo === 2)!;
    expect(readiness.readiness).toBe("NEEDS_MORE_CALIBRATION_EVIDENCE");
    expect(readiness.reason).toMatch(/not attested|decision-grade/);
  });

  it("coverage: each dimension carries F5c2's own boundaryReliability label unchanged", () => {
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 1)];
    const attested = dimensionOf(buildF5cDecisionEvidence(collection(subjects), true), 2, "welcoming-span");
    const unattested = dimensionOf(buildF5cDecisionEvidence(collection(subjects), false), 2, "welcoming-span");
    expect(attested.boundaryReliability).toBe("COVERAGE_ATTESTED");
    // an opaque METRIC scalar stays direction-unknown when the window is not attested.
    expect(unattested.boundaryReliability).toBe("OBSERVED_DIRECTION_UNKNOWN");
  });

  // ── evidence readiness (NOT title readiness, NOT permission to ship) ──────────────────────
  it("evidence readiness: a known non-source release gate outranks good calibration evidence", () => {
    expect(F5C3_KNOWN_RELEASE_GATES.has(58)).toBe(true);
    const report = buildF5cDecisionEvidence(collection([]), true);
    const gated = report.evidenceReadiness.find((r) => r.candidateNo === 58)!;
    expect(gated.readiness).toBe("RELEASE_GATE_STILL_BLOCKED");
    expect(gated.reason).toMatch(/release gate/i);
    // ...and F5c3 does NOT touch the catalog's own source-readiness classification.
    expect(TITLE_V2_CATALOG_READINESS.find((r) => r.no === 58)!.status).toBe("READY");
  });

  it("evidence readiness: an empty cohort is NEEDS_MORE_CALIBRATION_EVIDENCE, never ready", () => {
    const report = buildF5cDecisionEvidence(collection([]), true);
    for (const entry of report.evidenceReadiness) {
      expect(entry.readiness).not.toBe("EVIDENCE_READY_FOR_THRESHOLD_REVIEW");
    }
    expect(report.evidenceReadiness).toHaveLength(F5C_CANDIDATE_SWEEP_PLANS.length);
  });

  it("evidence readiness: a candidate with known outcomes and a discriminating curve is ready for the F6 threshold review", () => {
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 4), welcoming("c", 10, 1)];
    const report = buildF5cDecisionEvidence(collection(subjects), true);
    const entry = report.evidenceReadiness.find((r) => r.candidateNo === 2)!;
    expect(entry.readiness).toBe("EVIDENCE_READY_FOR_THRESHOLD_REVIEW");
    expect(dimensionOf(report, 2, "welcoming-span").flat).toBe(false);
  });

  it("non-sweepable candidates report WHY rather than inventing an OAT curve", () => {
    const report = buildF5cDecisionEvidence(collection([]), true);
    const structural = report.sensitivity.filter((s) => s.dimensions.length === 0);
    expect(structural.length).toBeGreaterThan(0);
    for (const s of structural) {
      expect(s.nonSweepableReason).not.toBeNull();
      expect(["NO_SWEEPABLE_DIMENSION_STRUCTURAL_ONLY", "NO_SWEEPABLE_DIMENSION_MANIFEST_PINNED", "CANDIDATE_UNSUPPORTED"])
        .toContain(s.nonSweepableReason);
    }
    // every candidate WITH dimensions leaves the reason null — the two states are exclusive.
    for (const s of report.sensitivity.filter((x) => x.dimensions.length > 0)) expect(s.nonSweepableReason).toBeNull();
  });

  it("F5c3 covers exactly the READY-76 plan set and its representative execution agrees with F5c2", () => {
    const subjects = [welcoming("a", 10, 4), welcoming("b", 10, 1)];
    const evidence = buildF5cDecisionEvidence(collection(subjects), true);
    const shadow = executeF5cShadowCalibration(collection(subjects), true);
    expect(evidence.readyCandidateCount).toBe(76);
    expect(evidence.sensitivity).toHaveLength(76);
    // one candidate must not mean different things in F5c2 vs F5c3 (task #192 §1).
    for (const s of evidence.sensitivity) {
      const f5c2 = shadow.results.find((r) => r.candidateNo === s.candidateNo)!;
      expect(s.representative.knownCount).toBe(f5c2.knownCount);
      expect(s.representative.unknownCount).toBe(f5c2.unknownCount);
      expect(s.representative.matchedCount).toBe(f5c2.matchedCount);
      expect(s.representative.notMatchedCount).toBe(f5c2.notMatchedCount);
      expect(s.representative.candidatePrevalence).toBe(f5c2.prevalence);
      expect(s.executionStrategy).toBe(f5c2.executionStrategy);
    }
  });

  // ── H. no production connection ───────────────────────────────────────────────────────────
  it("H. planning-only module: absent from evaluator/pipeline/award/Bot/public barrel/scheduler, no production rule types, read-only", () => {
    const read = (rel: string) => require("node:fs").readFileSync(new URL(rel, import.meta.url), "utf8") as string;
    const source = read("../src/titles/v2-decision-evidence.ts");
    expect(source).not.toContain("BehaviorTitleDefinition");
    expect(source).not.toContain("MetaTitleDefinition");
    expect(source).not.toContain(".prepare(");
    expect(source).not.toContain("INSERT");
    expect(source).not.toContain("UPDATE ");
    for (const file of ["v2.ts", "v2-evaluator.ts", "v2-pipeline.ts", "v2-prefetch.ts", "v2-award-facts.ts", "../index.ts"]) {
      expect(read(`../src/titles/${file}`)).not.toContain("v2-decision-evidence");
    }
    expect(read("../../../apps/bot/src/index.ts")).not.toContain("v2-decision-evidence");
  });

  // ── operator path ─────────────────────────────────────────────────────────────────────────
  it("operator script: arguments are explicit and validated — no defaulted cohort, window, or attestation", () => {
    const base = [
      "--db=/snap.sqlite", "--cohort-key=k", "--subject-ids-file=/cohort.txt",
      "--window-start=100", "--window-end=200", "--observed-at=200",
    ];
    const parsed = parseArgs(base);
    expect(parsed.db).toBe("/snap.sqlite");
    expect(parsed.cohortKey).toBe("k");
    expect(parsed.subjectIdsFile).toBe("/cohort.txt");
    expect(parsed.window).toEqual({ start: 100, end: 200, observedAt: 200 });
    // the attestation is opt-in: omitting the flag can never accidentally claim coverage.
    expect(parsed.coverageWindowValidated).toBe(false);
    expect(parseArgs([...base, "--coverage-window-validated"]).coverageWindowValidated).toBe(true);

    for (const missing of ["--db=", "--cohort-key=", "--subject-ids-file=", "--window-start=", "--window-end=", "--observed-at="]) {
      const key = missing.slice(0, -1);
      expect(() => parseArgs(base.filter((a) => !a.startsWith(`${key}=`)))).toThrow();
    }
    expect(() => parseArgs([...base.filter((a) => !a.startsWith("--window-start=")), "--window-start=not-a-number"])).toThrow(/integer/);
    expect(() => parseArgs([...base, "--unknown-flag=1"])).toThrow(/unrecognized/);
  });

  it("operator CLI contract: restricted subject identities never enter argv", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5c3-cohort-"));
    const cohortFile = path.join(dir, "cohort.txt");

    // The whole point: the parsed argument surface carries a PATH, never an identity. Command-line
    // arguments survive in shell history and are readable through process inspection and command
    // auditing, so a clean JSON artifact is not on its own enough to keep a cohort private.
    fs.writeFileSync(cohortFile, "RESTRICTED_ID_1\nRESTRICTED_ID_2\n", "utf8");
    const parsed = parseArgs([
      "--db=/snap.sqlite", "--cohort-key=k", `--subject-ids-file=${cohortFile}`,
      "--window-start=100", "--window-end=200", "--observed-at=200",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("RESTRICTED_ID_1");
    expect(readSubjectUserIds(cohortFile)).toEqual(["RESTRICTED_ID_1", "RESTRICTED_ID_2"]);

    // the old inline form must fail LOUDLY, explaining why — never be silently accepted.
    expect(() => parseArgs([
      "--db=/snap.sqlite", "--cohort-key=k", "--subject-ids=RESTRICTED_ID_1,RESTRICTED_ID_2",
      "--window-start=100", "--window-end=200", "--observed-at=200",
    ])).toThrow(/--subject-ids is not accepted/);

    // cohort input itself fails closed on the ways an operator can quietly change the population.
    fs.writeFileSync(cohortFile, "\n  \n", "utf8");
    expect(() => readSubjectUserIds(cohortFile)).toThrow(/empty/);
    fs.writeFileSync(cohortFile, "RESTRICTED_ID_1\nRESTRICTED_ID_1\n", "utf8");
    expect(() => readSubjectUserIds(cohortFile)).toThrow(/duplicate/);
    fs.writeFileSync(cohortFile, "RESTRICTED_ID_1,RESTRICTED_ID_2\n", "utf8");
    expect(() => readSubjectUserIds(cohortFile)).toThrow(/comma/); // pasted inline list
    // blank lines and stray whitespace are tolerated; nothing else is invented.
    fs.writeFileSync(cohortFile, "\n  RESTRICTED_ID_1  \n\nRESTRICTED_ID_2\n\n", "utf8");
    expect(readSubjectUserIds(cohortFile)).toEqual(["RESTRICTED_ID_1", "RESTRICTED_ID_2"]);

    // and the script never echoes the cohort back out: the only stdout it writes is the artifact
    // (asserted subject-id-free) or a fingerprint/count summary.
    const script = fs.readFileSync(new URL("../scripts/f5c3-decision-evidence.ts", import.meta.url), "utf8") as string;
    expect(script).not.toContain("subject-ids=");
    expect(script.includes("process.stdout.write(serialized)")).toBe(true);
    for (const line of script.split("\n").filter((l) => l.includes("stdout.write") || l.includes("console."))) {
      expect(line).not.toContain("subjectUserIds");
    }
  });

  it("operator script: opens the snapshot read-only at the driver level and refuses a missing file", () => {
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const fs = require("node:fs") as typeof import("node:fs");
    const snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "f5c3-snap-")), "snap.sqlite");
    openDb(snapshot).close(); // create a real snapshot file

    // exercised through the script's OWN connection factory, not a look-alike built here — the
    // guarantee has to belong to the thing `main()` actually runs.
    const ro = openSnapshotReadOnly(snapshot);
    expect(ro.readonly).toBe(true);
    expect(() => ro.exec("CREATE TABLE leak_probe(x)")).toThrow(/readonly/i);
    ro.close();
    // ...and it must refuse to conjure a database that is not there.
    expect(() => openSnapshotReadOnly(path.join(path.dirname(snapshot), "absent.sqlite"))).toThrow();
  });

  it("operator path: runF5cDecisionEvidence wires a real DB collection through to the artifact end to end", () => {
    const db = openDb(":memory:");
    const events = new EventLog(db);
    new CasinoParticipationHistory(db, () => BASE);
    new Takutate(db, events, () => BASE);
    new PublicEvents(db, () => BASE);
    new BumpCounter(db);
    new RoleFamilyTemporal(db);
    new TcSocialObservations(db);
    new VcPublicSocialPresence(db);
    db.exec(`CREATE TABLE IF NOT EXISTS casino_market_participation_history (
      participation_key TEXT PRIMARY KEY, market_id INTEGER NOT NULL, market_creator_id TEXT NOT NULL,
      participant_id TEXT NOT NULL, market_mode TEXT NOT NULL, market_created_at INTEGER NOT NULL,
      market_deadline_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL)`);
    const report = runF5cDecisionEvidence(db, { cohortKey: "evidence-integration", subjectUserIds: ["alice", "bob"], window: WINDOW }, false);
    expect(report.sensitivity).toHaveLength(76);
    expect(report.provenance.cohortKey).toBe("evidence-integration");
    expect(report.provenance.cohortSubjectCount).toBe(2);
    expect(report.provenance.coverageWindowValidated).toBe(false);
    expect(report.reportFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(report)).not.toContain("alice");
  });

  it("operator path (E2E): the documented command runs against a real READ-ONLY snapshot and leaves the database byte-identical", () => {
    // The invariant this test exists for: the path we tell an operator to run has actually been
    // executed, in full, under the read-only connection it claims to use. Proving "a read-only
    // handle rejects writes" and "the collector works against a writable :memory: DB" separately
    // does not prove their composition — this runs the script's real `main()`.
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const crypto = require("node:crypto") as typeof import("node:crypto");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5c3-readonly-e2e-"));
    const snapshot = path.join(dir, "snapshot.sqlite");

    // 1-2. a real on-disk database, bootstrapped through the ordinary WRITABLE setup — same
    //      schema/source prerequisites the calibration collector reads.
    const writable = openDb(snapshot);
    const events = new EventLog(writable);
    new CasinoParticipationHistory(writable, () => BASE);
    new Takutate(writable, events, () => BASE);
    new PublicEvents(writable, () => BASE);
    new BumpCounter(writable);
    new RoleFamilyTemporal(writable);
    new TcSocialObservations(writable);
    new VcPublicSocialPresence(writable);
    writable.exec(`CREATE TABLE IF NOT EXISTS casino_market_participation_history (
      participation_key TEXT PRIMARY KEY, market_id INTEGER NOT NULL, market_creator_id TEXT NOT NULL,
      participant_id TEXT NOT NULL, market_mode TEXT NOT NULL, market_created_at INTEGER NOT NULL,
      market_deadline_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL)`);
    // 3. the writable connection is gone before the operator path ever touches the file.
    writable.close();

    // the real cohort input: a file, never argv.
    const cohortFile = path.join(dir, "cohort.txt");
    fs.writeFileSync(cohortFile, "RESTRICTED_E2E_ID_1\nRESTRICTED_E2E_ID_2\n", "utf8");
    const out = path.join(dir, "f5c3-evidence.json");

    const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const databaseDigestBefore = digest(snapshot);
    const sidecarsBefore = fs.readdirSync(dir).filter((f) => f.startsWith("snapshot.sqlite-"));
    expect(sidecarsBefore).toEqual([]); // closing the writable connection checkpointed the WAL away

    // The connection the operator path builds is provably read-only — asserted through the very
    // function `main()` calls, so this cannot drift out of step with what actually runs. (An
    // OS-level read-only file is NOT a usable substitute here: on Windows SQLite still opens such
    // a file read-write, so that check would pass no matter what options the script used.)
    const probe = openSnapshotReadOnly(snapshot);
    expect(probe.readonly).toBe(true);
    expect(() => probe.exec("CREATE TABLE leak_probe(x)")).toThrow(/readonly/i);
    probe.close();

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // 4-5. the exact documented invocation — `main()` opens the snapshot through
      //      `openSnapshotReadOnly` and runs the real collection + evidence build against it.
      main([
        `--db=${snapshot}`,
        "--cohort-key=readonly-e2e",
        `--subject-ids-file=${cohortFile}`,
        `--window-start=${WINDOW.start}`, `--window-end=${WINDOW.end}`, `--observed-at=${WINDOW.observedAt}`,
        `--out=${out}`,
      ]);
      // no subject id is ever printed or logged, not even in the summary line.
      const printed = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).not.toContain("RESTRICTED_E2E_ID_1");
      expect(printed).not.toContain("RESTRICTED_E2E_ID_2");
    } finally {
      stdout.mockRestore();
    }

    // 6. a valid aggregate report really came out the far end.
    const report = JSON.parse(fs.readFileSync(out, "utf8")) as F5cDecisionEvidenceReport;
    expect(report.sensitivity).toHaveLength(F5C_CANDIDATE_SWEEP_PLANS.length);
    expect(report.overlap.length).toBeGreaterThan(0);
    expect(report.provenance.evidenceContractVersion).toBe(F5C3_EVIDENCE_CONTRACT_VERSION);
    expect(report.provenance.cohortKey).toBe("readonly-e2e");
    expect(report.provenance.cohortSubjectCount).toBe(2);
    expect(report.provenance.coverageWindowValidated).toBe(false); // attestation stays opt-in
    expect(report.reportFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const artifact = fs.readFileSync(out, "utf8");
    expect(artifact).not.toContain("RESTRICTED_E2E_ID_1");
    expect(artifact).not.toContain("RESTRICTED_E2E_ID_2");

    // 7. the database itself is untouched, byte for byte.
    expect(digest(snapshot)).toBe(databaseDigestBefore);
    // SQLite does materialise its WAL index alongside a WAL-mode database even for a READ-ONLY
    // connection, so the snapshot's DIRECTORY must be writable — but nothing is ever written to
    // the database: the journal it leaves is empty. Asserted rather than glossed over, because an
    // operator pointing this at a fully read-only directory would otherwise be surprised.
    const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    for (const sidecar of fs.readdirSync(dir).filter((f) => f.startsWith("snapshot.sqlite-"))) {
      expect(sidecar).toMatch(/^snapshot\.sqlite-(wal|shm)$/);
      if (sidecar.endsWith("-wal")) expect(digest(path.join(dir, sidecar))).toBe(EMPTY_SHA256);
    }
  });
});
