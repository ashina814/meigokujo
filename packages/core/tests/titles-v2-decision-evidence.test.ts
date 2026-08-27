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
import { F5C_CANDIDATE_SWEEP_PLANS, F5C_SWEEP_CONTRACT_VERSION } from "../src/titles/v2-calibration-sweep.js";
import { CALIBRATION_SCHEMA_VERSION, CALIBRATION_PERCENTILE_METHOD, canonicalReadinessHash } from "../src/titles/v2-calibration.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import { canonicalCatalogHash, TITLE_V2_CATALOG_CANDIDATES } from "../src/titles/v2-catalog-candidates.js";
import {
  executeF5cShadowCalibration,
  F5C2_BOUNDARY_PERCENTILES,
  F5C2_SHADOW_CONTRACT_VERSION,
} from "../src/titles/v2-shadow-evaluation.js";
import {
  buildF5cDecisionEvidence,
  runF5cDecisionEvidence,
  f5cOverlapMeasures,
  F5C3_EVIDENCE_CONTRACT_VERSION,
  F5C3_SENSITIVITY_MODEL,
  F5C3_KNOWN_RELEASE_GATES,
  type F5cDecisionEvidenceReport,
} from "../src/titles/v2-decision-evidence.js";
import { parseArgs } from "../scripts/f5c3-decision-evidence.js";
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

  it("E2. overlap pairs come from typed catalog structure (groupKey / seriesKey), not all 76×76 and not title prose", () => {
    const report = buildF5cDecisionEvidence(collection([]), true);
    const readyNos = new Set(F5C_CANDIDATE_SWEEP_PLANS.map((p) => p.candidateNo));
    expect(report.overlap.length).toBeGreaterThan(0);
    expect(report.overlap.length).toBeLessThan((readyNos.size * (readyNos.size - 1)) / 2); // NOT all-pairs
    const byNo = new Map(TITLE_V2_CATALOG_CANDIDATES.map((c) => [c.no, c] as const));
    for (const pair of report.overlap) {
      expect(readyNos.has(pair.aCandidateNo) && readyNos.has(pair.bCandidateNo)).toBe(true);
      expect(pair.aCandidateNo).toBeLessThan(pair.bCandidateNo); // deterministic ordering
      const a = byNo.get(pair.aCandidateNo)!;
      const b = byNo.get(pair.bCandidateNo)!;
      // every emitted pair is justified by a typed catalog relation, never by a name/prose guess.
      if (pair.relation === "SAME_GROUP") expect(a.groupKey).toBe(b.groupKey);
      else expect(a.seriesKey).toBe(b.seriesKey);
      expect(pair.relationKey).toBe(pair.relation === "SAME_GROUP" ? a.groupKey : a.seriesKey);
    }
    // the activity_time facets (No.32-35 dayparts) are exactly the kind of pair worth reviewing.
    expect(report.overlap.some((p) => p.aCandidateNo === 32 && p.bCandidateNo === 34)).toBe(true);
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
    expect(p.catalogHash).toBe(c.catalogHash);
    expect(p.readinessHash).toBe(c.readinessHash);
    expect(p.catalogCandidateCount).toBe(c.catalogCandidateCount);
    expect(p.cohortKey).toBe(c.cohort.key);
    expect(p.cohortSubjectCount).toBe(c.cohort.subjectCount);
    expect(p.window).toEqual(c.window);
    expect(p.coverageWindowValidated).toBe(false);
    expect(p.percentileMethod).toBe(CALIBRATION_PERCENTILE_METHOD);
    expect(p.percentileGrid).toEqual([...F5C2_BOUNDARY_PERCENTILES]);
    expect(p.candidateSensitivityModel).toBe(F5C3_SENSITIVITY_MODEL);
  });

  it("G2. catalog/readiness provenance drift fails closed rather than producing evidence for a different catalog", () => {
    const subjects = [welcoming("a", 10, 4)];
    expect(() => buildF5cDecisionEvidence(collection(subjects, { catalogHash: "stale-catalog-hash" }), true))
      .toThrow(/catalogHash/);
    expect(() => buildF5cDecisionEvidence(collection(subjects, { readinessHash: "stale-readiness-hash" }), true))
      .toThrow(/readinessHash/);
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
      "--db=/snap.sqlite", "--cohort-key=k", "--subject-ids=a,b",
      "--window-start=100", "--window-end=200", "--observed-at=200",
    ];
    const parsed = parseArgs(base);
    expect(parsed.db).toBe("/snap.sqlite");
    expect(parsed.cohortKey).toBe("k");
    expect(parsed.subjectUserIds).toEqual(["a", "b"]);
    expect(parsed.window).toEqual({ start: 100, end: 200, observedAt: 200 });
    // the attestation is opt-in: omitting the flag can never accidentally claim coverage.
    expect(parsed.coverageWindowValidated).toBe(false);
    expect(parseArgs([...base, "--coverage-window-validated"]).coverageWindowValidated).toBe(true);

    for (const missing of ["--db=", "--cohort-key=", "--subject-ids=", "--window-start=", "--window-end=", "--observed-at="]) {
      const key = missing.slice(0, -1);
      expect(() => parseArgs(base.filter((a) => !a.startsWith(`${key}=`)))).toThrow();
    }
    expect(() => parseArgs([...base.filter((a) => !a.startsWith("--window-start=")), "--window-start=not-a-number"])).toThrow(/integer/);
    expect(() => parseArgs([...base.filter((a) => !a.startsWith("--subject-ids=")), "--subject-ids=a,a"])).toThrow(/duplicate/);
    expect(() => parseArgs([...base, "--unknown-flag=1"])).toThrow(/unrecognized/);
  });

  it("operator script: opens the snapshot read-only at the driver level and refuses a missing file", () => {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const path = require("node:path") as typeof import("node:path");
    const os = require("node:os") as typeof import("node:os");
    const fs = require("node:fs") as typeof import("node:fs");
    const snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "f5c3-snap-")), "snap.sqlite");
    openDb(snapshot).close(); // create a real snapshot file

    // the exact options the script uses must physically prevent writes...
    const ro = new Database(snapshot, { readonly: true, fileMustExist: true });
    expect(() => ro.exec("CREATE TABLE leak_probe(x)")).toThrow(/readonly/i);
    ro.close();
    // ...and must refuse to conjure a database that is not there.
    expect(() => new Database(path.join(path.dirname(snapshot), "absent.sqlite"), { readonly: true, fileMustExist: true })).toThrow();
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
});
