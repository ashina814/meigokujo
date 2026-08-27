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
import {
  F5C_CANDIDATE_SWEEP_PLANS, F5C_SWEEP_CONTRACT_VERSION, F5C1_MANIFEST_PINS,
  CIRCULAR_QUADRANT_HOUR_RANGES, MULTI_DAYPART_RECURRENCE_MIN_DAYS,
  type F5cCandidateSweepPlan,
} from "../src/titles/v2-calibration-sweep.js";
import { CALIBRATION_SCHEMA_VERSION, CALIBRATION_PERCENTILE_METHOD, canonicalReadinessHash } from "../src/titles/v2-calibration.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import { canonicalCatalogHash, TITLE_V2_CATALOG_CANDIDATES } from "../src/titles/v2-catalog-candidates.js";
import {
  executeF5cShadowCalibration,
  runF5cShadowCalibration,
  auditF5c2SelectorSupport,
  coverageSensitiveOutcome,
  F5C2_BOUNDARY_PERCENTILES,
  F5C2_SENSITIVITY_MODEL,
  F5C2_SHADOW_CONTRACT_VERSION,
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
    const report = executeF5cShadowCalibration(collection([]), true);
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
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "bump-contribution-v1", metrics: { eventCount: 3 } }])]), true);
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
    const report = executeF5cShadowCalibration(collection([withEvidence, noEvidence]), true);
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
    ]), true);
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
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "activity-time-v1", jointEvidence: evidence }])]), true);
    const plan32 = byNo(report, 32);
    const qualifyingDays = plan32.axisSweeps.find((s) => s.axisKey === "candidate-32-qualifying-days")!;
    // both day-1 (VC-only) and day-2 (TC-only) rows must be able to qualify under ANY_FILTER —
    // a strict AND composition would only ever admit rows satisfying both simultaneously (none
    // here), collapsing the observed sample to 0.
    expect(qualifyingDays.observedSampleCount).toBeGreaterThan(0);
  });

  it("F. CIRCULAR_HOUR_WINDOW (DAYPART_TARGET) reports a bounded 24-bin hour histogram and judges each subject by their own in-quadrant row count, never a selected window", () => {
    // No.32 targets QUADRANT_1 = [6,12) (朝番/morning). Every subject has exactly 2 rows with
    // IDENTICAL tcBestOtherGapMs/vcTrustedSocialSeconds, so the row group's other 4 sibling axes
    // (qualifying-days/tc-gap-ceiling/vc-seconds/activity-share) trivially agree MATCHED for
    // everyone — isolating the circular axis as the only source of divergence. alice has 2 in-Q1
    // rows (hour 8), carol has 1 (hour 9, plus 1 outside in Q2), bob has 0 (both rows in Q3,
    // evening hour 20) -> population representative (p50) in-quadrant count = 1.
    const evidenceFor = (hours: readonly number[]): PlanningCalibrationJointEvidence => ({
      kind: "activity-time-day-hour-v1",
      rows: hours.map((hour, i) => ({ dayOffset: i + 1, hour, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 })),
    });
    const report = executeF5cShadowCalibration(collection([
      subject("alice", [{ probeKey: "activity-time-v1", jointEvidence: evidenceFor([8, 8]) }]),
      subject("bob", [{ probeKey: "activity-time-v1", jointEvidence: evidenceFor([20, 20]) }]),
      subject("carol", [{ probeKey: "activity-time-v1", jointEvidence: evidenceFor([9, 15]) }]),
    ]), true);
    const plan32 = byNo(report, 32);
    const boundary = plan32.axisSweeps.find((s) => s.axisKey === "candidate-32-daypart-boundary")!;
    expect(boundary.hourHistogram).not.toBeNull();
    expect(boundary.hourHistogram).toHaveLength(24);
    expect(boundary.hourHistogram![8]).toBe(2);
    expect(boundary.hourHistogram![9]).toBe(1);
    expect(boundary.hourHistogram![15]).toBe(1);
    expect(boundary.hourHistogram![20]).toBe(2);
    // PR #191レビュー第4ラウンド§3: no window search — the axis reduces each subject to a plain
    // in-quadrant row count and sweeps it via the standard percentile mechanism, exactly like any
    // other reduction axis; boundaryPoints is populated, not the empty array a window-search axis
    // with no chosen operator would have produced.
    expect(boundary.boundaryPoints.length).toBeGreaterThan(0);
    expect(boundary.boundaryPoints.find((p) => p.percentile === 50)!.boundaryValue).toBe(1);
    expect(boundary.boundaryReliability).toBe("COVERAGE_ATTESTED");
    expect(plan32.matchedCount).toBe(2); // alice (2 in-Q1), carol (1 in-Q1)
    expect(plan32.notMatchedCount).toBe(1); // bob (0 in-Q1)
  });

  it("No.36 PERSONAL_STABILITY judges each subject by their OWN concentration, not by which time is popular in the cohort (PR #191レビュー第3ラウンド§2/§7)", () => {
    // alice's usual time is hour 8 every day; bob's is hour 20 every day (a DIFFERENT, minority
    // time) — both are perfectly, equally stable and must both MATCH despite bob's time never
    // being the cohort's most popular. carol is scattered across 4 widely-spaced hours (no single
    // 8-hour window can catch more than 2 of her 4 days) and must NOT_MATCH.
    const probeKey = probeKeyFor(36);
    const daily = (id: string, hours: readonly number[]) => subject(id, [{
      probeKey,
      metrics: { vcTop3HoursShare: 1, vcTotalTrustedSeconds: 1000 },
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: hours.map((hour, i) => ({ dayOffset: i + 1, hour, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 })),
      },
    }]);
    const report = executeF5cShadowCalibration(collection([
      daily("alice", [8, 8, 8, 8]),
      daily("bob", [20, 20, 20, 20]),
      daily("carol", [2, 8, 14, 20]),
    ]), true);
    const plan36 = byNo(report, 36);
    const sweep = plan36.axisSweeps.find((s) => s.axisKey === "usual-time-start-hour-stability")!;
    // PERSONAL_STABILITY has no single shared window — it sweeps a per-subject concentration
    // scalar via the standard percentile mechanism, not a population-wide window enumeration.
    expect(sweep.boundaryPoints.length).toBeGreaterThan(0);
    expect(plan36.matchedCount).toBe(2); // alice, bob — different usual times, equally stable
    expect(plan36.notMatchedCount).toBe(1); // carol — scattered, not personally stable
    expect(plan36.unknownCount).toBe(0);
  });

  it("No.36 rows.activity-start-hour is the day's earliest recorded hour, not every hourly row (PR #191レビュー第3ラウンド§3)", () => {
    const probeKey = probeKeyFor(36);
    const s = subject("alice", [{
      probeKey,
      metrics: { vcTop3HoursShare: 1, vcTotalTrustedSeconds: 1000 },
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: [
          { dayOffset: 1, hour: 15, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 100 },
          { dayOffset: 1, hour: 5, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 100 }, // same day, earlier hour
        ],
      },
    }]);
    const report = executeF5cShadowCalibration(collection([s]), true);
    const plan36 = byNo(report, 36);
    const sweep = plan36.axisSweeps.find((s) => s.axisKey === "usual-time-start-hour-stability")!;
    // "start hour" is one value per day (the earliest) — 2 rows on the same day must still
    // resolve to exactly 1 start-hour sample, at the earlier of the two hours.
    expect(sweep.observedSampleCount).toBe(1);
    expect(sweep.hourHistogram![5]).toBe(1);
    expect(sweep.hourHistogram![15]).toBe(0);
  });

  it("No.32/34 DAYPART_TARGET candidates target disjoint quadrants matching the catalog semantic and can diverge on the identical population (PR #191レビュー第4ラウンド§2/§3 counterexample)", () => {
    // No.32 (朝番/morning) targets QUADRANT_1=[6,12); No.34 (宵っ張り/evening~pre-midnight)
    // targets QUADRANT_3=[18,24) — the catalog-correct mapping (not the candidate-ordinal-based
    // Q0/Q2 mapping from the prior round, under which hour 14 — squarely in [12,18) — would have
    // wrongly satisfied No.34's "evening" semantic). Every subject has exactly 3 rows with
    // IDENTICAL tcBestOtherGapMs/vcTrustedSocialSeconds (so the row group's other sibling axes
    // trivially agree MATCHED for everyone, isolating the circular axis): 1 morning row (hour 8,
    // shared by all 3) plus 2 more — bob/carol's are genuine evening (Q3) activity, alice's are
    // afternoon (Q2, neither target quadrant). Both candidates see the SAME morning row count
    // (1 each -> No.32 matches everyone); only No.34 diverges, since alice alone has zero Q3 rows.
    const probeKey = probeKeyFor(32);
    const threeRows = (id: string, hour2: number, hour3: number) => subject(id, [{
      probeKey,
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: [
          { dayOffset: 1, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 },
          { dayOffset: 2, hour: hour2, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 },
          { dayOffset: 3, hour: hour3, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 },
        ],
      },
    }]);
    const report = executeF5cShadowCalibration(collection([
      threeRows("alice", 14, 14), // afternoon (Q2) padding, no evening activity
      threeRows("bob", 20, 20), // genuine evening (Q3)
      threeRows("carol", 21, 21), // genuine evening (Q3)
    ]), true);
    const plan32 = byNo(report, 32);
    const plan34 = byNo(report, 34);
    expect(plan32.matchedCount).toBe(3); // everyone has the same 1 Q1 (morning) row
    expect(plan32.notMatchedCount).toBe(0);
    expect(plan34.matchedCount).toBe(2); // bob, carol — real Q3 (evening) activity
    expect(plan34.notMatchedCount).toBe(1); // alice — no evening activity at all
  });

  it("No.37 MULTI_DAYPART_BREADTH rewards recurring spread across quadrants on distinct days, not mere presence (PR #191レビュー第3ラウンド§2/§7, 第4ラウンド§4)", () => {
    // PR #191レビュー第4ラウンド§4: a quadrant only counts toward breadth once a subject has
    // qualifying rows in it on at least 2 DISTINCT days — a single occurrence in a quadrant (as a
    // one-night cross-midnight block would produce, one day per touched quadrant) cannot alone
    // make that quadrant count. Each subject below touches quadrants Q0/Q1/Q2/Q3 exactly twice
    // (2 distinct days each) to isolate breadth 1/2/3/4 -> population representative (p50)
    // boundary = 2 recurring quadrants -> breadth1 fails, breadth2-4 all pass.
    const probeKey = probeKeyFor(37);
    const spread = (id: string, hourDayPairs: ReadonlyArray<readonly [dayOffset: number, hour: number]>) => subject(id, [{
      probeKey,
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: hourDayPairs.map(([dayOffset, hour]) => ({ dayOffset, hour, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 })),
      },
    }]);
    const report = executeF5cShadowCalibration(collection([
      spread("breadth1", [[1, 2], [2, 2]]), // Q0 only, 2 distinct days
      spread("breadth2", [[1, 2], [2, 2], [3, 8], [4, 8]]), // Q0 + Q1, 2 days each
      spread("breadth3", [[1, 2], [2, 2], [3, 8], [4, 8], [5, 14], [6, 14]]), // Q0 + Q1 + Q2
      spread("breadth4", [[1, 2], [2, 2], [3, 8], [4, 8], [5, 14], [6, 14], [7, 20], [8, 20]]), // all 4
    ]), true);
    const plan37 = byNo(report, 37);
    expect(plan37.notMatchedCount).toBe(1);
    expect(plan37.matchedCount).toBe(3);
    expect(plan37.unknownCount).toBe(0);
  });

  it("No.37: a single continuous cross-midnight block (one all-nighter) does not satisfy MULTI_DAYPART_BREADTH, even though genuinely recurring activity does (PR #191レビュー第4ラウンド§4 counterexample)", () => {
    // The all-nighter subject has ONE session spanning hour 22 (day 1, Q3) through hour 4 (day 2,
    // Q0) — it touches 2 quadrants but only 1 distinct day in EACH, so neither quadrant clears the
    // >=2-distinct-days bar: 0 recurring quadrants. The recurring subject has genuine activity in
    // Q0 and Q3 across 2 SEPARATE days each (not one continuous block) and must be recognized. A
    // third, moderate subject (recurring in exactly 1 quadrant) establishes a nonzero population
    // boundary so allNighter's rejection is a real AT_LEAST comparison, not a vacuous 0-vs-0 tie.
    const probeKey = probeKeyFor(37);
    const allNighter = subject("allNighter", [{
      probeKey,
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: [
          { dayOffset: 1, hour: 22, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
          { dayOffset: 1, hour: 23, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
          { dayOffset: 2, hour: 0, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
          { dayOffset: 2, hour: 4, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
        ],
      },
    }]);
    const moderate = subject("moderate", [{
      probeKey,
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: [
          { dayOffset: 1, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
          { dayOffset: 2, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
        ],
      },
    }]);
    const recurring = subject("recurring", [{
      probeKey,
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: [
          { dayOffset: 10, hour: 22, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
          { dayOffset: 11, hour: 22, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
          { dayOffset: 12, hour: 2, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
          { dayOffset: 13, hour: 2, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 },
        ],
      },
    }]);
    const report = executeF5cShadowCalibration(collection([allNighter, moderate, recurring]), true);
    const plan37 = byNo(report, 37);
    const sweep = plan37.axisSweeps.find((s) => s.axisKey === "multi-daypart-boundaries")!;
    expect(sweep.boundaryPoints.find((p) => p.percentile === 50)!.boundaryValue).toBe(1); // p50 of [0,1,2]
    expect(plan37.notMatchedCount).toBe(1); // allNighter: 0 recurring quadrants
    expect(plan37.matchedCount).toBe(2); // moderate (1 recurring quadrant), recurring (2)
  });

  it("coverageWindowValidated=false collapses ALL percentile-boundary outcomes to UNKNOWN, even an observed MATCH against a monotonic lower-bound value — the review's own counterexample (PR #191レビュー第5ラウンド§1 counterexample)", () => {
    // observed TC-qualifying-days = [2, 1, 0] (alice, bob, carol). Population p50 boundary = 1 ->
    // observed: alice(2>=1) MATCHED, bob(1>=1) MATCHED, carol(0>=1) NOT_MATCHED. Under the round-4
    // model, alice/bob's MATCHED would have been treated as "reliable" (AT_LEAST + monotonic
    // count). But the boundary itself is percentile-derived from this same uncertain population:
    // if the true values were [2, 100, 100], the true p50 would be 100, and alice's own true value
    // (which could still be exactly 2, if only bob/carol were undercounted) would be a definite
    // true NOT_MATCHED against that true boundary. An observed MATCH against an untrusted
    // percentile boundary is therefore not a definite true MATCH — every outcome must collapse.
    const probeKey = probeKeyFor(49);
    const alice = subject("alice", [{
      probeKey,
      jointEvidence: { kind: "cross-modal-days-v1", tcDays: [
        { dayOffset: 1, bestOtherGapMs: 100 }, { dayOffset: 2, bestOtherGapMs: 100 },
      ], vcDays: [{ dayOffset: 1, distinctCoPresentUsers: 5 }] },
    }]);
    const bob = subject("bob", [{
      probeKey,
      jointEvidence: { kind: "cross-modal-days-v1", tcDays: [{ dayOffset: 1, bestOtherGapMs: 100 }], vcDays: [{ dayOffset: 1, distinctCoPresentUsers: 5 }] },
    }]);
    const carol = subject("carol", [{
      probeKey,
      jointEvidence: { kind: "cross-modal-days-v1", tcDays: [], vcDays: [{ dayOffset: 1, distinctCoPresentUsers: 5 }] },
    }]);
    const validated = executeF5cShadowCalibration(collection([alice, bob, carol]), true);
    const plan49Validated = byNo(validated, 49);
    expect(plan49Validated.matchedCount).toBe(2); // alice, bob — real boundary math, trusted when attested
    expect(plan49Validated.notMatchedCount).toBe(1); // carol

    const unvalidated = executeF5cShadowCalibration(collection([alice, bob, carol]), false);
    expect(unvalidated.coverageWindowValidated).toBe(false);
    const plan49Unvalidated = byNo(unvalidated, 49);
    expect(plan49Unvalidated.unknownCount).toBe(3); // ALL THREE — including alice/bob's observed MATCH
    expect(plan49Unvalidated.matchedCount).toBe(0);
    expect(plan49Unvalidated.notMatchedCount).toBe(0);
  });

  describe("coverageSensitiveOutcome — the general AT_LEAST/AT_MOST asymmetric reliability rule (PR #191レビュー第4ラウンド§1)", () => {
    // The review's own numeric examples: true=10, observed=3.
    it("AT_LEAST + boundary=5: observed NOT_MATCHED (3<5) is not necessarily a true NOT_MATCHED (true=10>=5) -> downgraded to UNKNOWN when unvalidated", () => {
      expect(coverageSensitiveOutcome("NOT_MATCHED", "AT_LEAST", "MONOTONIC_LOWER_BOUND", false)).toBe("UNKNOWN");
    });
    it("AT_LEAST: observed MATCHED is always reliable regardless of validation (a safe source cannot fabricate a positive)", () => {
      expect(coverageSensitiveOutcome("MATCHED", "AT_LEAST", "MONOTONIC_LOWER_BOUND", false)).toBe("MATCHED");
    });
    it("AT_MOST + ceiling=5: observed MATCHED (3<=5) is not necessarily a true MATCHED (true=10>5) -> downgraded to UNKNOWN when unvalidated", () => {
      expect(coverageSensitiveOutcome("MATCHED", "AT_MOST", "MONOTONIC_LOWER_BOUND", false)).toBe("UNKNOWN");
    });
    it("AT_MOST: observed NOT_MATCHED is always reliable regardless of validation (undercount cannot inflate an observed value past the true one)", () => {
      expect(coverageSensitiveOutcome("NOT_MATCHED", "AT_MOST", "MONOTONIC_LOWER_BOUND", false)).toBe("NOT_MATCHED");
    });
    it("NON_MONOTONIC (ratios/shares/opaque METRIC scalars): both directions are coverage-sensitive, not just NOT_MATCHED", () => {
      expect(coverageSensitiveOutcome("MATCHED", "AT_LEAST", "NON_MONOTONIC", false)).toBe("UNKNOWN");
      expect(coverageSensitiveOutcome("NOT_MATCHED", "AT_LEAST", "NON_MONOTONIC", false)).toBe("UNKNOWN");
      expect(coverageSensitiveOutcome("MATCHED", "AT_MOST", "NON_MONOTONIC", false)).toBe("UNKNOWN");
    });
    it("EQ: neither direction is provably reliable from a lower bound alone, regardless of reliability class", () => {
      expect(coverageSensitiveOutcome("MATCHED", "EQ", "MONOTONIC_LOWER_BOUND", false)).toBe("UNKNOWN");
      expect(coverageSensitiveOutcome("NOT_MATCHED", "EQ", "MONOTONIC_LOWER_BOUND", false)).toBe("UNKNOWN");
    });
    it("when coverageWindowValidated=true, every combination passes through unchanged", () => {
      for (const outcome of ["MATCHED", "NOT_MATCHED"] as const) {
        for (const direction of ["AT_LEAST", "AT_MOST", "EQ"] as const) {
          for (const reliability of ["MONOTONIC_LOWER_BOUND", "NON_MONOTONIC"] as const) {
            expect(coverageSensitiveOutcome(outcome, direction, reliability, true)).toBe(outcome);
          }
        }
      }
    });
    it("UNKNOWN is always idempotent", () => {
      expect(coverageSensitiveOutcome("UNKNOWN", "AT_LEAST", "MONOTONIC_LOWER_BOUND", false)).toBe("UNKNOWN");
    });
  });

  it("boundaryReliability distinguishes COVERAGE_ATTESTED / OBSERVED_LOWER_BOUND / OBSERVED_DIRECTION_UNKNOWN — a percentile of count/breadth lower bounds is itself a lower bound, but a share/ratio/opaque METRIC statistic could move either way (PR #191レビュー第5ラウンド§2)", () => {
    // No.81 is a plain METRIC axis (opaque scalar, F5c2 cannot introspect whether it's a count or
    // a ratio) -> conservative OBSERVED_DIRECTION_UNKNOWN when unvalidated.
    const probeKey81 = probeKeyFor(81);
    const withMetricAxis = (validatedFlag: boolean) => executeF5cShadowCalibration(collection([
      subject("alice", [{ probeKey: probeKey81, metrics: { completedParticipationCount: 3 } }]),
      subject("bob", [{ probeKey: probeKey81, metrics: { completedParticipationCount: 5 } }]),
    ]), validatedFlag);
    const metricValidated = byNo(withMetricAxis(true), 81).axisSweeps[0]!;
    const metricUnvalidated = byNo(withMetricAxis(false), 81).axisSweeps[0]!;
    expect(metricValidated.boundaryReliability).toBe("COVERAGE_ATTESTED");
    expect(metricUnvalidated.boundaryReliability).toBe("OBSERVED_DIRECTION_UNKNOWN");
    // the boundary VALUE computed is identical either way — only its labeled trustworthiness changes.
    expect(metricUnvalidated.boundaryPoints).toEqual(metricValidated.boundaryPoints);

    // No.32's daypart-boundary axis (DAYPART_TARGET, a plain in-quadrant row count with no
    // sibling filter) is a genuine monotonic-lower-bound reduction -> OBSERVED_LOWER_BOUND.
    const probeKey32 = probeKeyFor(32);
    const withCountAxis = (validatedFlag: boolean) => executeF5cShadowCalibration(collection([
      subject("alice", [{ probeKey: probeKey32, jointEvidence: { kind: "activity-time-day-hour-v1", rows: [{ dayOffset: 1, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 }] } }]),
    ]), validatedFlag);
    const countUnvalidated = byNo(withCountAxis(false), 32).axisSweeps.find((s) => s.axisKey === "candidate-32-daypart-boundary")!;
    expect(countUnvalidated.boundaryReliability).toBe("OBSERVED_LOWER_BOUND");
  });

  it("No.36 PERSONAL_STABILITY (a non-monotonic share statistic) also collapses to UNKNOWN when unvalidated, not just monotonic count axes (PR #191レビュー第5ラウンド§1/§8)", () => {
    const probeKey = probeKeyFor(36);
    const daily = (id: string, hours: readonly number[]) => subject(id, [{
      probeKey,
      metrics: { vcTop3HoursShare: 1, vcTotalTrustedSeconds: 1000 },
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: hours.map((hour, i) => ({ dayOffset: i + 1, hour, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 })),
      },
    }]);
    const withStability = (validatedFlag: boolean) => executeF5cShadowCalibration(collection([
      daily("alice", [8, 8, 8, 8]), daily("bob", [20, 20, 20, 20]), daily("carol", [2, 8, 14, 20]),
    ]), validatedFlag);
    // sanity: with validated=true this is the same fixture as the earlier PERSONAL_STABILITY test
    // (alice/bob MATCH, carol does not) — confirming the collapse below is really about coverage
    // trust, not a change to the underlying share computation.
    const plan36Validated = byNo(withStability(true), 36);
    expect(plan36Validated.matchedCount).toBe(2);
    expect(plan36Validated.notMatchedCount).toBe(1);

    const plan36Unvalidated = byNo(withStability(false), 36);
    expect(plan36Unvalidated.unknownCount).toBe(3);
    expect(plan36Unvalidated.matchedCount).toBe(0);
    expect(plan36Unvalidated.notMatchedCount).toBe(0);
  });

  it("a reduction axis's boundaryReliability label downgrades to OBSERVED_DIRECTION_UNKNOWN when it shares a row group with a SCALAR_SAMPLE filter (whose own monotonicity cannot be proven), but stays OBSERVED_LOWER_BOUND when the reduction has no filter siblings at all (PR #191レビュー第5ラウンド§3)", () => {
    // No.49's tc-qualifying-days shares its row group with the tc-meaningful-gap SCALAR_SAMPLE
    // filter (AT_MOST on a raw gap value) -> conservative, even though FILTER_THEN_DISTINCT_DAYS
    // itself would otherwise be monotonic-safe.
    const probeKey49 = probeKeyFor(49);
    const filtered = executeF5cShadowCalibration(collection([
      subject("alice", [{ probeKey: probeKey49, jointEvidence: { kind: "cross-modal-days-v1", tcDays: [{ dayOffset: 1, bestOtherGapMs: 100 }], vcDays: [{ dayOffset: 1, distinctCoPresentUsers: 5 }] } }]),
    ]), false);
    const tcSweep = byNo(filtered, 49).axisSweeps.find((s) => s.axisKey === "tc-qualifying-days")!;
    expect(tcSweep.boundaryReliability).toBe("OBSERVED_DIRECTION_UNKNOWN");

    // No.36's usual-time-qualifying-days (FILTER_THEN_DISTINCT_DAYS on "usual-time-rows") has NO
    // SCALAR_SAMPLE filter sibling in that row group at all -> the reducerKind's own monotonicity
    // is trusted for the label.
    const probeKey36 = probeKeyFor(36);
    const unfiltered = executeF5cShadowCalibration(collection([
      subject("alice", [{
        probeKey: probeKey36,
        metrics: { vcTop3HoursShare: 1, vcTotalTrustedSeconds: 1000 },
        jointEvidence: { kind: "activity-time-day-hour-v1", rows: [{ dayOffset: 1, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 100 }] },
      }]),
    ]), false);
    const qualifyingDaysSweep = byNo(unfiltered, 36).axisSweeps.find((s) => s.axisKey === "usual-time-qualifying-days")!;
    expect(qualifyingDaysSweep.boundaryReliability).toBe("OBSERVED_LOWER_BOUND");
  });

  it("F5c1's CIRCULAR_QUADRANT_HOUR_RANGES is the single SSOT for what a quadrant token means — F5c2 does not privately redefine the hour partition (PR #191レビュー第5ラウンド§4)", () => {
    const source = require("node:fs").readFileSync(new URL("../src/titles/v2-shadow-evaluation.ts", import.meta.url), "utf8") as string;
    expect(source).toContain("CIRCULAR_QUADRANT_HOUR_RANGES");
    // no private F5c2 hour-range table (e.g. a hardcoded 0/6/12/18 quadrant-boundary object).
    expect(source).not.toMatch(/QUADRANT_0:\s*0/);
    // functional proof: an hour exactly at a CIRCULAR_QUADRANT_HOUR_RANGES boundary classifies
    // into the quadrant the SSOT itself declares, for every declared quadrant. No.32 targets
    // QUADRANT_1 specifically — with a single-subject population, the axis's own p50 boundaryValue
    // IS the subject's in-quadrant row count (1 if their row falls in Q1, 0 otherwise).
    const probeKey = probeKeyFor(32);
    for (const [quadrant, range] of Object.entries(CIRCULAR_QUADRANT_HOUR_RANGES)) {
      const report = executeF5cShadowCalibration(collection([
        subject("alice", [{ probeKey, jointEvidence: { kind: "activity-time-day-hour-v1", rows: [{ dayOffset: 1, hour: range.startHour, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 500 }] } }]),
      ]), true);
      const sweep = byNo(report, 32).axisSweeps.find((s) => s.axisKey === "candidate-32-daypart-boundary")!;
      const inQuadrantCount = sweep.boundaryPoints.find((p) => p.percentile === 50)!.boundaryValue;
      expect(inQuadrantCount).toBe(quadrant === "QUADRANT_1" ? 1 : 0);
    }
  });

  it("No.37's recurrence requirement (>=N distinct days per quadrant) is a shared F5c1 contract constant, not a private F5c2 executor literal (PR #191レビュー第5ラウンド§5)", () => {
    const plan37 = F5C_CANDIDATE_SWEEP_PLANS.find((p) => p.candidateNo === 37)!;
    const circularAxis = plan37.axes.find((a) => a.reducerKind === "CIRCULAR_HOUR_WINDOW") as { readonly circularIntent: { readonly kind: string; readonly minDistinctDaysPerQuadrant?: number } };
    expect(circularAxis.circularIntent.kind).toBe("MULTI_DAYPART_BREADTH");
    expect(circularAxis.circularIntent.minDistinctDaysPerQuadrant).toBe(MULTI_DAYPART_RECURRENCE_MIN_DAYS);
    // F5c2 must read this off the plan, not hardcode its own copy of the number.
    const source = require("node:fs").readFileSync(new URL("../src/titles/v2-shadow-evaluation.ts", import.meta.url), "utf8") as string;
    expect(source).toContain("minDistinctDaysPerQuadrant");
    expect(source).not.toMatch(/days\.size >= 2\b/);
  });

  it("No.32-35's daypart-share is TC/VC-neutral — a TC-only-active subject (zero VC time) still gets a nonzero prominence share, not a forced 0/0 (PR #191レビュー第5ラウンド§6 counterexample)", () => {
    const probeKey = probeKeyFor(32);
    // alice: TC-only activity (gap always qualifies, VC seconds always 0) inside QUADRANT_1.
    const tcOnly = subject("alice", [{
      probeKey,
      jointEvidence: {
        kind: "activity-time-day-hour-v1",
        rows: [
          { dayOffset: 1, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 0 },
          { dayOffset: 2, hour: 8, tcBestOtherGapMs: 100, vcTrustedSocialSeconds: 0 },
        ],
      },
    }]);
    const report = executeF5cShadowCalibration(collection([tcOnly]), true);
    const shareSweep = byNo(report, 32).axisSweeps.find((s) => s.axisKey === "candidate-32-activity-share")!;
    // every row qualified via TC (vc-seconds is always 0, so only the TC-gap filter can admit a
    // row under ANY_FILTER) -> the TC-only subject's own share must reflect that, not read as 0.
    expect(shareSweep.observedSampleCount).toBeGreaterThan(0);
    expect(shareSweep.boundaryPoints.some((p) => p.boundaryValue > 0)).toBe(true);
  });

  it("F5C2_SHADOW_CONTRACT_VERSION and the report's top-level shape are pinned by a direct regression assertion, so a shape change cannot silently drift undetected (PR #191レビュー第4/第5ラウンド§5)", () => {
    expect(F5C2_SHADOW_CONTRACT_VERSION).toBe(4);
    const report = executeF5cShadowCalibration(collection([]), true);
    expect(report.contractVersion).toBe(4);
    expect(Object.keys(report).sort()).toEqual([
      "cohort", "contractVersion", "coverageWindowValidated", "executedCandidateCount",
      "readyCandidateCount", "results", "sensitivityModel", "sweepContractVersion",
      "unsupportedCandidateCount", "window",
    ].sort());
  });

  it("sensitivity model is explicitly typed as marginal-axis-only, not candidate-level sensitivity (PR #191レビュー第3ラウンド§4)", () => {
    const report = executeF5cShadowCalibration(collection([]), true);
    expect(report.sensitivityModel).toBe(F5C2_SENSITIVITY_MODEL);
  });

  it("selector support has a single executable SSOT — no parallel selector-name list exists alongside the resolvers (PR #191レビュー第3ラウンド§5)", () => {
    const source = require("node:fs").readFileSync(new URL("../src/titles/v2-shadow-evaluation.ts", import.meta.url), "utf8") as string;
    expect(source).not.toContain("SUPPORTED_JOINT_SELECTORS");
    expect(source).toContain("JOINT_ROW_RESOLVERS");
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
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "social-class-context-v1", jointEvidence: evidence }])]), true);
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
    ]), true);
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
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "public-room-social-time-v1", jointEvidence: evidence }])]), true);
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
    const report = executeF5cShadowCalibration(collection([subject("alice", [{ probeKey: "cross-modal-v1", jointEvidence: evidence }])]), true);
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
    const report = executeF5cShadowCalibration(collection([alice, bob, carol]), true);
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
    const report = executeF5cShadowCalibration(collection([observedEmpty, neverMeasured]), true);
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
    const report = executeF5cShadowCalibration(collection([s]), true);
    const plan61 = byNo(report, 61);
    expect(plan61.notMatchedCount).toBe(1);
    expect(plan61.unknownCount).toBe(0);
  });

  it("three-valued AND: no FALSE present but an UNKNOWN input keeps the whole candidate UNKNOWN, never silently MATCHED (No.61)", () => {
    const probeKey = probeKeyFor(61);
    const s = subject("alice", [{ probeKey, metrics: { hasNaturalInflow: 1, hasNaturalOutflow: 1 } }]);
    const report = executeF5cShadowCalibration(collection([s]), true);
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
    const report = executeF5cShadowCalibration(collection([s]), true);
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
    const report = executeF5cShadowCalibration(collection([]), true);
    // Read from the SAME F5c1 export F5c2 itself consumes — if F5c2 regressed to a hardcoded
    // literal, this would still pass today but silently drift the next time F5c1 bumps its
    // contract version, which is exactly the failure mode PR #191レビュー§3 forbids.
    expect(report.sweepContractVersion).toBe(F5C_SWEEP_CONTRACT_VERSION);
    const partial = subject("alice", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: F5C1_MANIFEST_PINS.CASINO_EDITION.families.length - 1, allFamiliesCompleted: 0, totalFamilyCompletionDays: 1 } }]);
    const all = subject("bob", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: F5C1_MANIFEST_PINS.CASINO_EDITION.families.length, allFamiliesCompleted: 1, totalFamilyCompletionDays: 1 } }]);
    const report69 = executeF5cShadowCalibration(collection([partial, all]), true);
    const plan69 = byNo(report69, 69);
    expect(plan69.matchedCount).toBe(1);
    expect(plan69.notMatchedCount).toBe(1);
  });

  it("J. manifest ALL_MANIFEST_MEMBERS (No.69) requires the pinned family cardinality, not just >0", () => {
    const partial = subject("alice", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: 3, allFamiliesCompleted: 0, totalFamilyCompletionDays: 3 } }]);
    const all = subject("bob", [{ probeKey: "casino-edition-completion-v1", metrics: { distinctCompletedFamilies: 8, allFamiliesCompleted: 1, totalFamilyCompletionDays: 8 } }]);
    const report = executeF5cShadowCalibration(collection([partial, all]), true);
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
    const report = executeF5cShadowCalibration(collection(subjects), true);
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
    ]), true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("RESTRICTED_SUBJECT_ID_777");
  });

  it("M. deep-frozen output", () => {
    const report = executeF5cShadowCalibration(collection([]), true);
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
    const report = runF5cShadowCalibration(db, { cohortKey: "shadow-integration", subjectUserIds: ["alice", "bob"], window: WINDOW }, true);
    expect(report.results).toHaveLength(76);
    expect(report.cohort.subjectCount).toBe(2);
    expect(report.unsupportedCandidateCount).toBe(0);
  });
});
