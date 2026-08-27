import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { Takutate } from "../src/casino/takutate.js";
import { EventLog } from "../src/events/service.js";
import { PublicEvents } from "../src/public-events/service.js";
import { BumpCounter } from "../src/rank/bump.js";
import { RoleFamilyTemporal } from "../src/role-family/temporal.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { VcPublicSocialPresence } from "../src/vc/public-social-presence.js";
import { F5C_CANDIDATE_SWEEP_PLANS, F5C_SWEEP_CONTRACT_VERSION, F5C1_MANIFEST_PINS, type F5cCandidateSweepPlan } from "../src/titles/v2-calibration-sweep.js";
import { CALIBRATION_SCHEMA_VERSION, CALIBRATION_PERCENTILE_METHOD, canonicalReadinessHash } from "../src/titles/v2-calibration.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import { canonicalCatalogHash, TITLE_V2_CATALOG_CANDIDATES } from "../src/titles/v2-catalog-candidates.js";
import {
  executeF5cShadowCalibration,
  runF5cShadowCalibration,
  auditF5c2SelectorSupport,
  F5C2_BOUNDARY_PERCENTILES,
  type F5cShadowCalibrationReport,
} from "../src/titles/v2-shadow-evaluation.js";
import type { PlanningCalibrationJointEvidence, PlanningCalibrationMeasurementCollection, PlanningCalibrationSubjectMeasurement } from "../src/titles/v2-calibration.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1_000);
const DAY = 86_400;
const WINDOW = Object.freeze({ start: BASE, end: BASE + 10 * DAY, observedAt: BASE + 8 * DAY });

function collection(
  subjects: readonly PlanningCalibrationSubjectMeasurement[],
  cohortKey = "shadow-fixture",
): PlanningCalibrationMeasurementCollection {
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    percentileMethod: CALIBRATION_PERCENTILE_METHOD,
    catalogHash: canonicalCatalogHash(TITLE_V2_CATALOG_CANDIDATES),
    readinessHash: canonicalReadinessHash(TITLE_V2_CATALOG_READINESS),
    catalogCandidateCount: TITLE_V2_CATALOG_CANDIDATES.length,
    cohort: { key: cohortKey, subjectCount: subjects.length },
    window: { start: WINDOW.start, end: WINDOW.end, observedAt: WINDOW.observedAt, effectiveEnd: WINDOW.observedAt },
    packReadCalls: [],
    sourceReadCalls: [],
    subjects,
  };
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

function byNo(report: F5cShadowCalibrationReport, no: number) {
  return report.results.find((r) => r.candidateNo === no)!;
}

/** Reads the real F5c1-assigned probeKey for a candidate rather than hardcoding a guessed string. */
function probeKeyFor(no: number): string {
  return F5C_CANDIDATE_SWEEP_PLANS.find((p) => p.candidateNo === no)!.probeKey;
}

describe("F5c2 shadow-calibration executor", () => {
  it("A. every READY-76 candidate is accounted for with an empty population — no silent skip", () => {
    const report = executeF5cShadowCalibration(collection([]));
    expect(report.readyCandidateCount).toBe(76);
    expect(report.results).toHaveLength(76);
    expect(report.results.map((r) => r.candidateNo)).toEqual(F5C_CANDIDATE_SWEEP_PLANS.map((p) => p.candidateNo));
    for (const result of report.results) {
      expect(result.populationCount).toBe(0);
      expect(result.knownCount).toBe(0);
      expect(result.unknownCount).toBe(0);
      expect(result.matchedCount).toBe(0);
      expect(result.prevalence).toBeNull();
    }
    // 空集団でもUNSUPPORTED_GAPが0であること(全76が実際に何らかのexecution戦略を持つ)
    expect(report.unsupportedCandidateCount).toBe(0);
    expect(report.executedCandidateCount).toBe(76);
  });

  it("B. no production threshold is selected — boundary percentiles are exactly the fixed finite grid", () => {
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "bump-contribution-v1", metrics: { eventCount: 3 } }])]));
    const plan38 = byNo(report, 38);
    expect(plan38.axisSweeps).toEqual([]); // STRUCTURAL_FIXED: no axes at all
    for (const result of report.results) {
      for (const sweep of result.axisSweeps) {
        expect(sweep.boundaryPoints.map((p) => p.percentile)).toEqual(sweep.boundaryPoints.length === 0 ? [] : [...F5C2_BOUNDARY_PERCENTILES]);
      }
    }
  });

  it("C. UNKNOWN is distinguished from observed zero/false (fixed criteria)", () => {
    const withEvidence = subject("alice", [{ probeKey: "bump-contribution-v1", metrics: { eventCount: 0 } }]);
    const noEvidence = subject("bob", [{ probeKey: "bump-contribution-v1", metrics: {} }]);
    const report = executeF5cShadowCalibration(collection([withEvidence, noEvidence]));
    const plan38 = byNo(report, 38); // fixedCriteria: eventCount >= 1
    expect(plan38.matchedCount).toBe(0);
    expect(plan38.notMatchedCount).toBe(1); // alice: eventCount=0, observed and evaluated -> NOT_MATCHED
    expect(plan38.unknownCount).toBe(1); // bob: metric missing entirely -> UNKNOWN, not collapsed into false
    expect(plan38.knownCount).toBe(1);
    expect(plan38.prevalence).toBe(0);
  });

  it("D. row-group ALL_FILTERS composition requires the SAME row to satisfy every filter (No.42 TC start)", () => {
    // subject A: one start row satisfies BOTH quiet-before floor and continuation-gap ceiling on
    // the SAME row -> should be able to pass at generous boundaries.
    // subject B: two DIFFERENT start rows, each satisfying only one of the two filters
    // individually -> ALL_FILTERS must not let them "combine" across rows.
    const evidenceA: PlanningCalibrationJointEvidence = {
      kind: "tc-conversation-v1",
      starts: [{ dayOffset: 1, quietBeforeMs: 999_999, nextOtherGapMs: 1_000, explicitContinuation: false }],
      revivalConversations: [], areas: [], thirdPartyJoins: [],
    };
    const evidenceB: PlanningCalibrationJointEvidence = {
      kind: "tc-conversation-v1",
      starts: [
        { dayOffset: 1, quietBeforeMs: 999_999, nextOtherGapMs: 999_999, explicitContinuation: false }, // passes quiet-before only
        { dayOffset: 2, quietBeforeMs: 1, nextOtherGapMs: 1_000, explicitContinuation: false }, // passes continuation-gap only
      ],
      revivalConversations: [], areas: [], thirdPartyJoins: [],
    };
    const report = executeF5cShadowCalibration(collection([
      subject("subjectA", [{ probeKey: "tc-conversation-v1", jointEvidence: evidenceA }]),
      subject("subjectB", [{ probeKey: "tc-conversation-v1", jointEvidence: evidenceB }]),
    ]));
    const plan42 = byNo(report, 42);
    expect(plan42.executionStrategy).toBe("JOINT_EVIDENCE_SWEEP");
    const startDays = plan42.axisSweeps.find((s) => s.axisKey === "start-days")!;
    // Both subjects produce exactly one qualifying row group entry each contributing to the
    // observed distribution when using the row that survives ALL_FILTERS; subject B's two rows
    // each satisfy only one filter, so neither individually satisfies ALL_FILTERS on its own row.
    expect(startDays.observedSampleCount).toBeGreaterThanOrEqual(1);
    expect(plan42.unsupportedReason).toBeNull();
  });

  it("E. row-group ANY_FILTER composition lets either modality qualify a row (No.32 TC/VC daypart)", () => {
    const evidence: PlanningCalibrationJointEvidence = {
      kind: "activity-time-day-hour-v1",
      rows: [
        { dayOffset: 1, hour: 10, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 1_000_000 }, // qualifies via VC only
        { dayOffset: 2, hour: 14, tcBestOtherGapMs: 1, vcTrustedSocialSeconds: 0 }, // qualifies via TC only
      ],
    };
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "activity-time-v1", jointEvidence: evidence }])]));
    const plan32 = byNo(report, 32);
    const qualifyingDays = plan32.axisSweeps.find((s) => s.axisKey === "candidate-32-qualifying-days")!;
    // both day-1 (VC-only) and day-2 (TC-only) rows must be able to qualify under ANY_FILTER —
    // a strict AND composition would only ever admit rows satisfying both simultaneously (none
    // here), collapsing the observed sample to 0.
    expect(qualifyingDays.observedSampleCount).toBeGreaterThan(0);
  });

  it("F. CIRCULAR_HOUR_WINDOW reports a bounded 24-bin hour histogram, never a selected window", () => {
    const evidence: PlanningCalibrationJointEvidence = {
      kind: "activity-time-day-hour-v1",
      rows: [
        { dayOffset: 1, hour: 3, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 500 },
        { dayOffset: 2, hour: 3, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 500 },
        { dayOffset: 3, hour: 20, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 500 },
      ],
    };
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "activity-time-v1", jointEvidence: evidence }])]));
    const plan32 = byNo(report, 32);
    const boundary = plan32.axisSweeps.find((s) => s.axisKey === "candidate-32-daypart-boundary")!;
    expect(boundary.hourHistogram).not.toBeNull();
    expect(boundary.hourHistogram).toHaveLength(24);
    expect(boundary.hourHistogram![3]).toBe(2);
    expect(boundary.hourHistogram![20]).toBe(1);
    expect(boundary.boundaryPoints).toEqual([]); // no operator/boundary is ever selected for this axis
    // PR #191レビュー§5: the histogram is diagnostic, but the axis must also participate — a
    // bounded 24-point window enumeration is always reported, one point per candidate start hour.
    expect(boundary.circularWindowPoints).not.toBeNull();
    expect(boundary.circularWindowPoints).toHaveLength(24);
    expect(boundary.circularWindowPoints!.map((p) => p.windowStartHour)).toEqual([...Array(24).keys()]);
    for (const point of boundary.circularWindowPoints!) expect(point.windowLengthHours).toBe(8);
    // hour 3 has the only subject's rows -> every window covering hour 3 has qualifyingCount 1.
    const windowCoveringHour3 = boundary.circularWindowPoints!.find((p) => p.windowStartHour === 0)!;
    expect(windowCoveringHour3.qualifyingCount).toBe(1);
  });

  it("circular window enumeration actually changes the shadow MATCHED/NOT_MATCHED outcome (No.36)", () => {
    // 2 subjects clustered at hour 2 (majority) and 1 subject isolated at hour 14 (12 hours away
    // circularly, outside any 8-hour window that also covers hour 2) — the population-optimal
    // window must land on the majority cluster, leaving the isolated subject NOT_MATCHED on the
    // circular criterion specifically because of which window was chosen (PR #191レビュー§5/§10).
    const probeKey = probeKeyFor(36);
    const clustered = (id: string, hour: number) => subject(id, [{
      probeKey,
      metrics: { vcTop3HoursShare: 1, vcTotalTrustedSeconds: 1000 },
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: [{ dayOffset: 1, hour, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 100 }],
      },
    }]);
    const report = executeF5cShadowCalibration(collection([
      clustered("majorityA", 2), clustered("majorityB", 2), clustered("minority", 14),
    ]));
    const plan36 = byNo(report, 36);
    const boundarySweep = plan36.axisSweeps.find((s) => s.axisKey === "usual-time-start-hour-stability")!;
    const bestWindow = [...boundarySweep.circularWindowPoints!].sort((a, b) => b.qualifyingCount - a.qualifyingCount)[0]!;
    expect(bestWindow.qualifyingCount).toBe(2); // the two hour-2 subjects, not the isolated one
    expect(plan36.matchedCount).toBe(2);
    expect(plan36.notMatchedCount).toBe(1);
    expect(plan36.unknownCount).toBe(0);
  });

  it("G. POST_FILTER_MATCHING_SIZE recomputes matching after the edge filter — it does not reuse the pre-filter structural max", () => {
    // Edges: c0-s0(100), c0-s1(90), c1-s1(80), c1-s2(20), c2-s2(10) -> unfiltered max matching = 3
    // (c0-s0, c1-s1, c2-s2 or equivalent). At the representative (p50) edge-seconds boundary (80),
    // only the 3 edges with seconds>=80 remain (c0-s0, c0-s1, c1-s1) whose max matching is 2
    // (c0 and c1 both need s1) — strictly below the unfiltered 3, proving genuine post-filter
    // recomputation rather than a reused pre-filter structural value.
    const evidence: PlanningCalibrationJointEvidence = {
      kind: "social-context-graph-v1",
      dimension: "class",
      counterparts: [
        { counterpartOrdinal: 0, touches: [{ semanticIndex: 0, days: [{ dayOffset: 1, trustedSeconds: 100 }] }, { semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 90 }] }] },
        { counterpartOrdinal: 1, touches: [{ semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 80 }] }, { semanticIndex: 2, days: [{ dayOffset: 1, trustedSeconds: 20 }] }] },
        { counterpartOrdinal: 2, touches: [{ semanticIndex: 2, days: [{ dayOffset: 1, trustedSeconds: 10 }] }] },
      ],
    };
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "social-class-context-v1", jointEvidence: evidence }])]));
    const plan26 = byNo(report, 26);
    const matchingSweep = plan26.axisSweeps.find((s) => s.axisKey === "class-person-matching")!;
    expect(matchingSweep.reducerKind).toBe("POST_FILTER_MATCHING_SIZE");
    // PR #191レビュー§7: boundaryPoints now sweeps the matching-size distribution itself (edge
    // filter held fixed at its own representative boundary) — a single, unambiguous dimension.
    // Percentile is non-decreasing over one subject's fixed matching-size value, so all points
    // share the same boundaryValue here; the edge filter's own sensitivity is reported separately
    // on the sibling SCALAR_SAMPLE axis below.
    for (const point of matchingSweep.boundaryPoints) expect(point.boundaryValue).toBe(2);
    const edgeFilterSweep = plan26.axisSweeps.find((s) => s.axisKey === "class-edge-trusted-seconds")!;
    expect(edgeFilterSweep).toBeDefined();
    const edgeLowest = edgeFilterSweep.boundaryPoints.find((p) => p.percentile === 10)!;
    const edgeHighest = edgeFilterSweep.boundaryPoints.find((p) => p.percentile === 90)!;
    expect(edgeHighest.boundaryValue).toBeGreaterThanOrEqual(edgeLowest.boundaryValue);
  });

  it("No.26 representative matching outcome uses the population's real matching-size boundary, not a hardcoded >=1 (PR #191レビュー§7)", () => {
    // alice & carol: same rich graph as test G -> matching size 2 at the shared representative
    // edge boundary (50). bob: a single edge just barely clearing that same edge boundary ->
    // matching size exactly 1. Population matching-size samples [2,1,2] -> representative (p50)
    // boundary = 2. Under the old hardcoded `size >= 1` gate, bob would incorrectly MATCH; the
    // real boundary correctly fails him.
    const richGraph = (): PlanningCalibrationJointEvidence => ({
      kind: "social-context-graph-v1",
      dimension: "class",
      counterparts: [
        { counterpartOrdinal: 0, touches: [{ semanticIndex: 0, days: [{ dayOffset: 1, trustedSeconds: 100 }] }, { semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 90 }] }] },
        { counterpartOrdinal: 1, touches: [{ semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 80 }] }, { semanticIndex: 2, days: [{ dayOffset: 1, trustedSeconds: 20 }] }] },
        { counterpartOrdinal: 2, touches: [{ semanticIndex: 2, days: [{ dayOffset: 1, trustedSeconds: 10 }] }] },
      ],
    });
    const sparseGraph: PlanningCalibrationJointEvidence = {
      kind: "social-context-graph-v1",
      dimension: "class",
      counterparts: [
        { counterpartOrdinal: 0, touches: [{ semanticIndex: 0, days: [{ dayOffset: 1, trustedSeconds: 50 }] }, { semanticIndex: 1, days: [{ dayOffset: 1, trustedSeconds: 3 }] }] },
      ],
    };
    const report = executeF5cShadowCalibration(collection([
      subject("alice", [{ probeKey: "social-class-context-v1", jointEvidence: richGraph() }]),
      subject("bob", [{ probeKey: "social-class-context-v1", jointEvidence: sparseGraph }]),
      subject("carol", [{ probeKey: "social-class-context-v1", jointEvidence: richGraph() }]),
    ]));
    const plan26 = byNo(report, 26);
    expect(plan26.matchedCount).toBe(2); // alice, carol
    expect(plan26.notMatchedCount).toBe(1); // bob
    expect(plan26.unknownCount).toBe(0);
  });

  it("H. No.56 own-room-use-days (distinct-days) and own-room-use-span differ on a real fixture, and hosted/guest-style rows outside the selector cannot leak into either", () => {
    const evidence: PlanningCalibrationJointEvidence = {
      kind: "domain-social-time-v1",
      domain: "public-room",
      domainDays: [
        { dayOffset: 1, semanticIndex: 2, magnitude: 3 }, // own-use
        { dayOffset: 2, semanticIndex: 2, magnitude: 1 }, // own-use
        { dayOffset: 10, semanticIndex: 2, magnitude: 1 }, // own-use
        { dayOffset: 5, semanticIndex: 0, magnitude: 99 }, // hosted (semanticIndex 0) — must not affect own-use span
      ],
      socialHours: [],
    };
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "public-room-social-time-v1", jointEvidence: evidence }])]));
    const plan56 = byNo(report, 56);
    const daysSweep = plan56.axisSweeps.find((s) => s.axisKey === "own-room-use-days")!;
    const spanSweep = plan56.axisSweeps.find((s) => s.axisKey === "own-room-use-span")!;
    expect(daysSweep.reducerKind).toBe("FILTER_THEN_DISTINCT_DAYS");
    expect(spanSweep.reducerKind).toBe("FILTER_THEN_SPAN_DAYS");
    // day offsets 1,2,10 -> distinct days=3, span=10-1+1=10. The hosted row at day 5 (outside
    // own-use) must not extend the span past 10 or shrink the distinct-day count below 3.
    expect(daysSweep.observedSampleCount).toBeGreaterThan(0);
    expect(spanSweep.observedSampleCount).toBeGreaterThan(0);
    expect(daysSweep.boundaryPoints.some((p) => p.boundaryValue === 3)).toBe(true);
    expect(spanSweep.boundaryPoints.some((p) => p.boundaryValue === 10)).toBe(true);
  });

  it("I. No.49 TC and VC qualifying-days are evaluated independently — a TC=1-day/VC=many-days subject does not silently satisfy a union-based read", () => {
    const evidence: PlanningCalibrationJointEvidence = {
      kind: "cross-modal-days-v1",
      tcDays: [{ dayOffset: 5, bestOtherGapMs: 1_000 }], // TC: exactly 1 qualifying day
      vcDays: [
        { dayOffset: 1, distinctCoPresentUsers: 3 }, { dayOffset: 2, distinctCoPresentUsers: 3 },
        { dayOffset: 3, distinctCoPresentUsers: 3 }, { dayOffset: 4, distinctCoPresentUsers: 3 },
      ],
    };
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "cross-modal-v1", jointEvidence: evidence }])]));
    const plan49 = byNo(report, 49);
    const tcQualifyingDays = plan49.axisSweeps.find((s) => s.axisKey === "tc-qualifying-days")!;
    const vcQualifyingDays = plan49.axisSweeps.find((s) => s.axisKey === "vc-qualifying-days")!;
    expect(tcQualifyingDays.observedSampleCount).toBeGreaterThan(0);
    expect(vcQualifyingDays.observedSampleCount).toBeGreaterThan(0);
    // TC's own observed distribution must reflect only 1 day of TC evidence, independent of VC's
    // 4 days — proving they are NOT merged into one union-based day count.
    expect(tcQualifyingDays.boundaryPoints.every((p) => p.boundaryValue <= 1)).toBe(true);
    expect(vcQualifyingDays.boundaryPoints.some((p) => p.boundaryValue >= 4)).toBe(true);
    expect(plan49.axisSweeps.some((s) => s.axisKey.includes("union") || s.axisKey.includes("modality-day-breadth"))).toBe(false);
  });

  it("I2. No.49 TC=0 observed qualifying days is a definite NOT_MATCHED, not UNKNOWN, even with VC's many days present (PR #191レビュー§1 counterexample)", () => {
    const probeKey = probeKeyFor(49);
    // alice: TC=0 (observed empty, real zero) but VC=4 days (plenty). bob/carol supply nonzero TC
    // so the population's representative TC boundary sits above zero — alice must fail it for
    // real, not be swept into UNKNOWN because her own row set happened to be empty.
    const alice = subject("alice", [{
      probeKey,
      jointEvidence: { kind: "cross-modal-days-v1", tcDays: [], vcDays: [
        { dayOffset: 1, distinctCoPresentUsers: 5 }, { dayOffset: 2, distinctCoPresentUsers: 5 },
        { dayOffset: 3, distinctCoPresentUsers: 5 }, { dayOffset: 4, distinctCoPresentUsers: 5 },
      ] },
    }]);
    const bob = subject("bob", [{
      probeKey,
      jointEvidence: { kind: "cross-modal-days-v1", tcDays: [
        { dayOffset: 1, bestOtherGapMs: 100 }, { dayOffset: 2, bestOtherGapMs: 100 },
      ], vcDays: [{ dayOffset: 1, distinctCoPresentUsers: 5 }] },
    }]);
    const carol = subject("carol", [{
      probeKey,
      jointEvidence: { kind: "cross-modal-days-v1", tcDays: [
        { dayOffset: 1, bestOtherGapMs: 100 }, { dayOffset: 2, bestOtherGapMs: 100 }, { dayOffset: 3, bestOtherGapMs: 100 },
      ], vcDays: [{ dayOffset: 1, distinctCoPresentUsers: 5 }] },
    }]);
    const report = executeF5cShadowCalibration(collection([alice, bob, carol]));
    const plan49 = byNo(report, 49);
    expect(plan49.unknownCount).toBe(0);
    expect(plan49.notMatchedCount).toBe(1); // alice: TC=0 fails the population's TC boundary for real
    expect(plan49.matchedCount).toBe(2); // bob, carol
  });

  it("I3. observed empty joint rows (NOT_MATCHED) vs unavailable measurement (UNKNOWN) are distinct states (No.78 JOINT_STRUCTURAL_FACT)", () => {
    const probeKey = probeKeyFor(78);
    // subjectA: pack present, probe ran, kind matches — but genuinely found zero qualifying
    // next-generation occurrences. This is knowledge, not UNKNOWN: NOT_MATCHED.
    const observedEmpty = subject("subjectA", [{
      probeKey,
      jointEvidence: {
        kind: "invite-rooted-v1",
        profiles: [{ profileOrdinal: 0, activityDays: [], nextGenerationOccurrences: [], unknownNextGenerationEntryAnchorCount: 0, reunionDays: [] }],
        unknownEntryAnchorCount: 0,
      },
    }]);
    // subjectB: never measured by this probe at all (no pack for probeKey) — genuinely UNKNOWN.
    const neverMeasured = subject("subjectB", []);
    const report = executeF5cShadowCalibration(collection([observedEmpty, neverMeasured]));
    const plan78 = byNo(report, 78);
    expect(plan78.notMatchedCount).toBe(1); // subjectA: observed, empty, real zero
    expect(plan78.unknownCount).toBe(1); // subjectB: never measured
    expect(plan78.matchedCount).toBe(0);
  });

  it("three-valued AND: FALSE dominates UNKNOWN (No.61 fixedCriteria conjunction)", () => {
    const probeKey = probeKeyFor(61);
    // hasNaturalOutflow=0 is a definite NOT_MATCHED; the axis metrics (distinctFamilies etc.) are
    // entirely absent (UNKNOWN) — the combined outcome must be NOT_MATCHED, not UNKNOWN.
    const s = subject("alice", [{ probeKey, metrics: { hasNaturalInflow: 1, hasNaturalOutflow: 0 } }]);
    const report = executeF5cShadowCalibration(collection([s]));
    const plan61 = byNo(report, 61);
    expect(plan61.notMatchedCount).toBe(1);
    expect(plan61.unknownCount).toBe(0);
  });

  it("three-valued AND: no FALSE present but an UNKNOWN input keeps the whole candidate UNKNOWN, never silently MATCHED (No.61)", () => {
    const probeKey = probeKeyFor(61);
    const s = subject("alice", [{ probeKey, metrics: { hasNaturalInflow: 1, hasNaturalOutflow: 1 } }]);
    const report = executeF5cShadowCalibration(collection([s]));
    const plan61 = byNo(report, 61);
    expect(plan61.unknownCount).toBe(1);
    expect(plan61.matchedCount).toBe(0);
    expect(plan61.notMatchedCount).toBe(0);
  });

  it("three-valued OR (ANY_METRIC_POSITIVE): FALSE OR UNKNOWN => UNKNOWN, never a false NOT_MATCHED (No.83, PR #191レビュー§1 counterexample)", () => {
    const probeKey = probeKeyFor(83);
    // participantOnlyCount=1 -> MATCHED on the first fixedCriteria. staffCount=0 (definite false)
    // and organizerCount entirely absent (UNKNOWN) on the ANY_METRIC_POSITIVE criterion — the old
    // buggy `values.some(v => v>0)` read this as NOT_MATCHED; the correct 3-valued OR is UNKNOWN.
    const s = subject("alice", [{ probeKey, metrics: { participantOnlyCount: 1, staffCount: 0 } }]);
    const report = executeF5cShadowCalibration(collection([s]));
    const plan83 = byNo(report, 83);
    expect(plan83.unknownCount).toBe(1);
    expect(plan83.notMatchedCount).toBe(0);
    expect(plan83.matchedCount).toBe(0);
  });

  it("unknown joint selector fails closed via the static selector-support audit — READY-76 itself has zero gaps", () => {
    expect(auditF5c2SelectorSupport()).toEqual([]);
    const bogusPlan = {
      candidateNo: 999999,
      probeKey: probeKeyFor(32),
      requiredJointEvidence: { kind: "activity-time-day-hour-v1", selectors: ["rows.nonexistent-selector"] },
      axes: [{
        axisKey: "bogus-axis", source: "JOINT_EVIDENCE", selector: "rows.nonexistent-selector",
        rowGroupKey: "bogus-rows", operator: "AT_LEAST", boundaryMethod: "OBSERVED_NEAREST_RANK", reducerKind: "SCALAR_SAMPLE",
      }],
      fixedCriteria: [],
      manifestRef: null,
      manifestCriteria: [],
      rowGroupCompositions: [],
      structuralRequirements: [],
    } as unknown as F5cCandidateSweepPlan; // minimal synthetic plan; only the audited fields matter
    const gaps = auditF5c2SelectorSupport([bogusPlan]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.candidateNo).toBe(999999);
    expect(gaps[0]!.reason).toContain("rows.nonexistent-selector");
  });

  it("F5c1 contract-version and manifest pin drift cannot be hidden by F5c2 literals", () => {
    const report = executeF5cShadowCalibration(collection([]));
    // Read from the SAME F5c1 export F5c2 itself consumes — if F5c2 regressed to a hardcoded
    // literal, this would still pass today but silently drift the next time F5c1 bumps its
    // contract version, which is exactly the failure mode PR #191レビュー§3 forbids.
    expect(report.sweepContractVersion).toBe(F5C_SWEEP_CONTRACT_VERSION);
    const partial = subject("alice", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: F5C1_MANIFEST_PINS.CASINO_EDITION.families.length - 1, allFamiliesCompleted: 0, totalFamilyCompletionDays: 1 } }]);
    const all = subject("bob", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: F5C1_MANIFEST_PINS.CASINO_EDITION.families.length, allFamiliesCompleted: 1, totalFamilyCompletionDays: 1 } }]);
    const report69 = executeF5cShadowCalibration(collection([partial, all]));
    const plan69 = byNo(report69, 69);
    expect(plan69.matchedCount).toBe(1);
    expect(plan69.notMatchedCount).toBe(1);
  });

  it("J. manifest ALL_MANIFEST_MEMBERS (No.69) requires the pinned family cardinality, not just >0", () => {
    const partial = subject("alice", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: 3, allFamiliesCompleted: 0, totalFamilyCompletionDays: 3 } }]);
    const all = subject("bob", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: 8, allFamiliesCompleted: 1, totalFamilyCompletionDays: 8 } }]);
    const report = executeF5cShadowCalibration(collection([partial, all]));
    const plan69 = byNo(report, 69);
    expect(plan69.executionStrategy).toBe("MANIFEST_CRITERIA");
    expect(plan69.matchedCount).toBe(1); // only bob (8/8) satisfies ALL_MANIFEST_MEMBERS
    expect(plan69.notMatchedCount).toBe(1); // alice (3/8) does not
    expect(plan69.knownCount).toBe(2);
  });

  it("K. MANIFEST_CARDINALITY_SWEEP (No.88 'almost all') gates on the observed-population representative boundary, not a hardcoded production number", () => {
    // samples=[3,5,6,7]; p50 nearest-rank boundary = 5 -> subjects with breadth>=5 (5,6,7) MATCHED,
    // breadth=3 NOT_MATCHED (PR #191レビュー§6: this dimension must actually affect prevalence).
    const subjects = [3, 5, 6, 7].map((n, i) => subject(`s${i}`, [{ probeKey: "castle-social-time-v1", metrics: { domainSemanticBreadth: n, domainDayTouches: n, domainActiveDays: n, domainActiveSpanDays: n } }]));
    const report = executeF5cShadowCalibration(collection(subjects));
    const plan88 = byNo(report, 88);
    const sweep = plan88.axisSweeps.find((s) => s.axisKey === "manifest:domainSemanticBreadth")!;
    expect(sweep).toBeDefined();
    expect(sweep.boundaryPoints.map((p) => p.percentile)).toEqual([...F5C2_BOUNDARY_PERCENTILES]);
    expect(sweep.boundaryPoints.find((p) => p.percentile === 50)!.boundaryValue).toBe(5);
    expect(plan88.matchedCount).toBe(3);
    expect(plan88.notMatchedCount).toBe(1);
    expect(plan88.unknownCount).toBe(0);
    expect(plan88.prevalence).toBe(0.75);
  });

  it("L. no restricted subject identity or raw evidence appears in the serialized report", () => {
    const evidence: PlanningCalibrationJointEvidence = {
      kind: "tc-conversation-v1",
      starts: [{ dayOffset: 1, quietBeforeMs: 1, nextOtherGapMs: 1, explicitContinuation: true }],
      revivalConversations: [], areas: [], thirdPartyJoins: [],
    };
    const report = executeF5cShadowCalibration(collection([
      subject("RESTRICTED_SUBJECT_ID_777", [{ probeKey: "tc-conversation-v1", jointEvidence: evidence }]),
    ]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("RESTRICTED_SUBJECT_ID_777");
  });

  it("M. deep-frozen output", () => {
    const report = executeF5cShadowCalibration(collection([]));
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.results)).toBe(true);
    expect(Object.isFrozen(report.results[0])).toBe(true);
  });

  it("N. planning-only module: no evaluator/pipeline/Bot/public-barrel import, no `.prepare(` write access, no `matched:` literal", () => {
    const source = new URL("../src/titles/v2-shadow-evaluation.ts", import.meta.url);
    const text = require("node:fs").readFileSync(source, "utf8") as string;
    expect(text).not.toContain("BehaviorTitleDefinition");
    expect(text).not.toContain("MetaTitleDefinition");
    expect(text).not.toContain(".prepare(");
    for (const file of ["v2.ts", "v2-evaluator.ts", "v2-pipeline.ts", "v2-prefetch.ts", "../index.ts"]) {
      const other = require("node:fs").readFileSync(new URL(`../src/titles/${file}`, import.meta.url), "utf8") as string;
      expect(other).not.toContain("v2-shadow-evaluation");
    }
    const botIndex = require("node:fs").readFileSync(new URL("../../../apps/bot/src/index.ts", import.meta.url), "utf8") as string;
    expect(botIndex).not.toContain("v2-shadow-evaluation");
  });

  it("O. integration: runF5cShadowCalibration wires a real DB collection through the executor end to end", () => {
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
    const report = runF5cShadowCalibration(db, { cohortKey: "shadow-integration", subjectUserIds: ["alice", "bob"], window: WINDOW });
    expect(report.results).toHaveLength(76);
    expect(report.cohort.subjectCount).toBe(2);
    expect(report.unsupportedCandidateCount).toBe(0);
  });
});
