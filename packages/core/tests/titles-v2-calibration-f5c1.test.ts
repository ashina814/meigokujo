import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { Takutate } from "../src/casino/takutate.js";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { PublicEvents } from "../src/public-events/service.js";
import { BumpCounter } from "../src/rank/bump.js";
import { RoleFamilyTemporal } from "../src/role-family/temporal.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import {
  auditF5cCandidateSweepPlans,
  F5C_CANDIDATE_SWEEP_PLANS,
  __internal as f5cInternal,
} from "../src/titles/v2-calibration-sweep.js";
import {
  collectF5cCalibrationMeasurements,
  describeF5cCalibrationProbeContracts,
  F5C_CALIBRATION_PROBES,
} from "../src/titles/v2-calibration.js";
import { VcPublicSocialPresence } from "../src/vc/public-social-presence.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1_000);
const DAY = 86_400;
const WINDOW = Object.freeze({ start: BASE, end: BASE + 10 * DAY, observedAt: BASE + 8 * DAY });
const input = (subjectUserIds: readonly string[]) => ({ cohortKey: "f5c1-fixture", subjectUserIds, window: WINDOW });

function setupDb() {
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
  return db;
}

describe("F5c1 READY-76 sweep contract", () => {
  it("A. 31 probesのcandidate unionはREADY 76件とexact一致し、重複・非READY混入がない", () => {
    const readyNos = TITLE_V2_CATALOG_READINESS.filter(({ status }) => status === "READY").map(({ no }) => no).sort((a, b) => a - b);
    const measuredNos = F5C_CALIBRATION_PROBES.flatMap(({ candidateNos }) => candidateNos).sort((a, b) => a - b);
    const plannedNos = F5C_CANDIDATE_SWEEP_PLANS.map(({ candidateNo }) => candidateNo);
    expect(F5C_CALIBRATION_PROBES).toHaveLength(31);
    expect(readyNos).toHaveLength(76);
    expect(measuredNos).toEqual(readyNos);
    expect(plannedNos).toEqual(readyNos);
    expect(new Set(measuredNos).size).toBe(76);
    expect(new Set(plannedNos).size).toBe(76);
    expect(F5C_CANDIDATE_SWEEP_PLANS.every((entry, index, rows) => index === 0 || rows[index - 1]!.candidateNo < entry.candidateNo)).toBe(true);
  });

  it("B. planはreadiness category/risk/probe ownershipとactual metric/joint outputへ一致する", () => {
    const audit = auditF5cCandidateSweepPlans();
    expect(audit).toMatchObject({
      probeCount: 31,
      measurementCandidateCount: 76,
      readyCandidateCount: 76,
      plannedCandidateCount: 76,
      thresholdCategoryCounts: {
        STRUCTURAL_FIXED: 11,
        THRESHOLD_PENDING: 58,
        MANIFEST_DEPENDENT: 6,
        STRUCTURAL_PLUS_DISTRIBUTION: 1,
      },
      optimizationRiskCounts: { LOW: 37, MANAGED: 27, HIGH: 12 },
      declaredMeasurementGapCount: 0,
      unexecutablePlanCount: 0,
      duplicateCount: 0,
      nonReadyCandidateCount: 0,
      exactReadySet: true,
      numericThresholdValueCount: 0,
    });
    expect(audit.missingReadyCandidateNos).toEqual([]);
    expect(audit.unexpectedPlanCandidateNos).toEqual([]);
    expect(audit.candidateProbeOwnershipMismatches).toEqual([]);
    expect(audit.thresholdCategoryMismatches).toEqual([]);
    expect(audit.optimizationRiskMismatches).toEqual([]);
    expect(audit.unknownMetricSelectors).toEqual([]);
    expect(audit.unknownJointEvidenceSelectors).toEqual([]);
    expect(audit.manifestRefMismatches).toEqual([]);
    expect(audit.unexecutablePlanCandidateNos).toEqual([]);
    expect(Object.isFrozen(audit)).toBe(true);
    expect(Object.isFrozen(audit.thresholdCategoryCounts)).toBe(true);
  });

  it("C. pendingはnumeric値なしのsweep axis、fixed/manifestはsemantic requirementとして分離される", () => {
    for (const candidatePlan of F5C_CANDIDATE_SWEEP_PLANS) {
      if (candidatePlan.thresholdCategory === "THRESHOLD_PENDING") expect(candidatePlan.axes.length).toBeGreaterThan(0);
      if (candidatePlan.thresholdCategory === "STRUCTURAL_FIXED" || candidatePlan.thresholdCategory === "MANIFEST_DEPENDENT") {
        expect(candidatePlan.structuralRequirements.length).toBeGreaterThan(0);
        expect(candidatePlan.axes).toEqual([]);
      }
      if (candidatePlan.thresholdCategory === "STRUCTURAL_PLUS_DISTRIBUTION") {
        expect(candidatePlan.structuralRequirements.length).toBeGreaterThan(0);
        expect(candidatePlan.axes.length).toBeGreaterThan(0);
      }
      for (const axis of candidatePlan.axes) {
        if (axis.reducerKind === "MATCHING_AFTER_EDGE_FILTER") {
          expect(axis.boundaryMethod).toBe("RECOMPUTED_AFTER_EDGE_FILTER");
          expect("operator" in axis).toBe(false);
        } else if (axis.reducerKind === "CIRCULAR_HOUR_WINDOW") {
          expect(axis.boundaryMethod).toBe("CIRCULAR_CANDIDATE_ENUMERATION");
          expect("operator" in axis).toBe(false);
        } else {
          expect(axis.boundaryMethod).toBe("OBSERVED_NEAREST_RANK");
        }
        expect(Object.values(axis).some((value) => typeof value === "number")).toBe(false);
        expect("value" in axis).toBe(false);
      }
    }
    expect(Object.isFrozen(F5C_CANDIDATE_SWEEP_PLANS)).toBe(true);
    expect(Object.isFrozen(F5C_CANDIDATE_SWEEP_PLANS[0]!.axes)).toBe(true);
  });

  it("D. VC Style 12候補はsemantic別にvolume/day/share/stability/span/breadth axisを分ける", () => {
    const byNo = (no: number) => F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === no)!;
    expect(byNo(10).requiredMetrics).toContain("bucketPositiveDays.oneToOne");
    expect(byNo(10).requiredMetrics).not.toContain("dailyBucketShareIqr.oneToOne");
    expect(byNo(11).requiredMetrics).toContain("dailySocialOnlyShareIqr.oneToOne");
    expect(byNo(12).axes.map(({ axisKey }) => axisKey)).toContain("duo-long-span");
    expect(byNo(19).requiredMetrics).toContain("bucketPositiveDays.largeGroup");
    expect(byNo(20).requiredMetrics).toContain("positiveSocialBucketCount");
    expect(byNo(21).axes.map(({ axisKey }) => axisKey)).toContain("large-share-ceiling");
    expect(new Set(Array.from({ length: 12 }, (_, index) => JSON.stringify(byNo(index + 10).axes))).size).toBeGreaterThan(6);
  });

  it("E. joint correlation候補はactual tagged evidenceを明示し、aggregate-only候補はnoneを明示する", () => {
    const contracts = new Map(describeF5cCalibrationProbeContracts(BASE).map((entry) => [entry.probeKey, entry]));
    for (const candidatePlan of F5C_CANDIDATE_SWEEP_PLANS) {
      const required = candidatePlan.requiredJointEvidence;
      if (required.kind === "none") {
        expect(required.selectors).toEqual([]);
      } else {
        expect(contracts.get(candidatePlan.probeKey)!.jointEvidenceKind).toBe(required.kind);
        expect(required.selectors.length).toBeGreaterThan(0);
      }
    }
    expect(F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === 26)!.requiredJointEvidence.kind).toBe("social-context-graph-v1");
    expect(F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === 42)!.requiredJointEvidence.kind).toBe("tc-conversation-v1");
    expect(F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === 49)!.requiredJointEvidence.kind).toBe("cross-modal-days-v1");
    expect(F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === 77)!.requiredJointEvidence.kind).toBe("invite-rooted-v1");
    expect(F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === 90)!.requiredJointEvidence.kind).toBe("castle-role-context-v1");
  });

  it("F. all-phase collectorはdeterministic/read-only/deep-frozenで、重複subject順序に依存しない", () => {
    const db = setupDb();
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const a = collectF5cCalibrationMeasurements(db, input(["subject-b", "subject-a", "subject-b"]));
    const b = collectF5cCalibrationMeasurements(db, input(["subject-a", "subject-b"]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(before);
    expect(a.subjects.map(({ subjectUserId }) => subjectUserId)).toEqual(["subject-a", "subject-b"]);
    expect(a.subjects[0]!.packs).toHaveLength(31);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.subjects[0]!.packs[0]!.metrics)).toBe(true);
  });

  it("G. 601 subjectsでもunique sourceを全phaseで一度だけprefetchし、shared sourceを再読しない", () => {
    const db = setupDb();
    const subjects = Array.from({ length: 601 }, (_, index) => `subject-${String(index).padStart(3, "0")}`);
    const collection = collectF5cCalibrationMeasurements(db, input(subjects));
    const uniqueProbeSources = [...new Set(F5C_CALIBRATION_PROBES.flatMap(({ sources }) => sources))].sort();
    expect(collection.cohort.subjectCount).toBe(601);
    expect(collection.subjects).toHaveLength(601);
    expect(collection.sourceReadCalls.map(({ source }) => source)).toEqual(uniqueProbeSources);
    expect(new Set(collection.sourceReadCalls.map(({ source }) => source)).size).toBe(uniqueProbeSources.length);
    expect(collection.sourceReadCalls.find(({ source }) => source === "vc_social_safe")!.readCalls).toBe(3);
    expect(collection.sourceReadCalls.find(({ source }) => source === "social_activity_time_safe")!.readCalls).toBe(3);
    expect(collection.sourceReadCalls.find(({ source }) => source === "casino_table_activity_safe")!.readCalls).toBe(3);
    expect(collection.sourceReadCalls.find(({ source }) => source === "castle_experience_safe")!.readCalls).toBe(27);
  });

  it("H. planning-only moduleはproduction barrel/evaluator/pipeline/prefetch/Botから到達しない", () => {
    const sweepSource = readFileSync(new URL("../src/titles/v2-calibration-sweep.ts", import.meta.url), "utf8");
    expect(sweepSource).not.toContain("BehaviorTitleDefinition");
    expect(sweepSource).not.toContain("MetaTitleDefinition");
    expect(sweepSource).not.toContain(".prepare(");
    expect(sweepSource).not.toContain("matched:");
    for (const file of ["v2.ts", "v2-evaluator.ts", "v2-pipeline.ts", "v2-prefetch.ts", "../index.ts"]) {
      expect(readFileSync(new URL(`../src/titles/${file}`, import.meta.url), "utf8")).not.toContain("v2-calibration-sweep");
    }
    expect(readFileSync(new URL("../../../apps/bot/src/index.ts", import.meta.url), "utf8")).not.toContain("v2-calibration-sweep");
  });
});

/**
 * PR #190レビュー: F5c1 contract executability follow-up。BLOCKER1(structuralRequirements
 * がstring[]のみ)/BLOCKER2(joint axisにsubject-level reduction semanticsが無い)/
 * BLOCKER3(measurementStatusが暗黙にMEASUREDへdefaultしていた)を解消したことを検証する。
 */
describe("F5c1 contract executability (PR #190 review follow-up)", () => {
  const byNo = (no: number) => F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === no)!;

  it("A. all 11 READY STRUCTURAL_FIXED plans have executable fixedCriteria", () => {
    const structuralFixed = F5C_CANDIDATE_SWEEP_PLANS.filter(({ thresholdCategory }) => thresholdCategory === "STRUCTURAL_FIXED");
    expect(structuralFixed).toHaveLength(11);
    expect(structuralFixed.map(({ candidateNo }) => candidateNo)).toEqual([38, 50, 58, 65, 66, 70, 74, 80, 83, 84, 85]);
    for (const candidatePlan of structuralFixed) {
      expect(candidatePlan.fixedCriteria.length).toBeGreaterThan(0);
      expect(candidatePlan.axes).toEqual([]);
      for (const criterion of candidatePlan.fixedCriteria) {
        expect(["METRIC_COMPARE", "METRIC_BOOLEAN_TRUE", "ANY_METRIC_POSITIVE", "JOINT_STRUCTURAL_FACT"]).toContain(criterion.kind);
      }
    }
  });

  it("B. all 6 READY MANIFEST_DEPENDENT plans have canonical manifestRef", () => {
    const manifestDependent = F5C_CANDIDATE_SWEEP_PLANS.filter(({ thresholdCategory }) => thresholdCategory === "MANIFEST_DEPENDENT");
    expect(manifestDependent).toHaveLength(6);
    expect(manifestDependent.map(({ candidateNo }) => candidateNo)).toEqual([63, 69, 86, 87, 88, 89]);
    for (const candidatePlan of manifestDependent) {
      expect(candidatePlan.manifestRef).not.toBeNull();
      expect(["ECONOMY_SEMANTIC_FAMILIES", "CASINO_EDITION", "CASTLE_EDITION"]).toContain(candidatePlan.manifestRef!.kind);
    }
    expect(byNo(63).manifestRef).toEqual({ kind: "ECONOMY_SEMANTIC_FAMILIES", version: 1 });
    expect(byNo(69).manifestRef).toEqual({ kind: "CASINO_EDITION", editionKey: "casino-edition-i", version: 1 });
    for (const no of [86, 87, 88, 89]) {
      expect(byNo(no).manifestRef).toEqual({ kind: "CASTLE_EDITION", editionKey: "castle-experience-edition-i", version: 1 });
    }
  });

  it("C. No.61 has machine-readable natural inflow + outflow fixed criteria", () => {
    const plan61 = byNo(61);
    expect(plan61.fixedCriteria).toEqual([
      { kind: "METRIC_BOOLEAN_TRUE", metricKey: "hasNaturalInflow" },
      { kind: "METRIC_BOOLEAN_TRUE", metricKey: "hasNaturalOutflow" },
    ]);
    expect(plan61.axes.length).toBeGreaterThan(0);
  });

  it("D. No.77 has a machine-readable structural chronology requirement", () => {
    const plan77 = byNo(77);
    expect(plan77.thresholdCategory).toBe("STRUCTURAL_PLUS_DISTRIBUTION");
    const chronologyFacts = plan77.fixedCriteria.filter((c) => c.kind === "JOINT_STRUCTURAL_FACT");
    expect(chronologyFacts.map((c) => (c as { selector: string }).selector).sort()).toEqual([
      "profiles.root-before-child",
      "profiles.same-day-before-entry",
    ]);
    expect(plan77.fixedCriteria.some((c) => c.kind === "METRIC_COMPARE")).toBe(true);
    // chronologyはfixedCriteriaへ移動済み——axes側にはboolean chronologyのAT_LEASTが残っていない
    expect(plan77.axes.every((axis) => axis.source !== "JOINT_EVIDENCE" || (axis.selector !== "profiles.root-before-child" && axis.selector !== "profiles.same-day-before-entry"))).toBe(true);
    expect(plan77.axes.length).toBeGreaterThan(0);
  });

  it("E. No.83 encodes participant-only AND staff-or-organizer without prose parsing", () => {
    const plan83 = byNo(83);
    expect(plan83.fixedCriteria).toEqual([
      { kind: "METRIC_COMPARE", metricKey: "participantOnlyCount", operator: "GTE", fixedValue: 1 },
      { kind: "ANY_METRIC_POSITIVE", metricKeys: ["staffCount", "organizerCount"] },
    ]);
  });

  it("F. No.85 encodes exact structural family breadth", () => {
    expect(byNo(85).fixedCriteria).toEqual([{ kind: "METRIC_COMPARE", metricKey: "activeFamilyCount", operator: "GTE", fixedValue: 2 }]);
  });

  it("G. No.32-35 use circular time-window axis semantics, not scalar AT_LEAST hour boundary", () => {
    for (const no of [32, 33, 34, 35]) {
      const boundaryAxis = byNo(no).axes.find((axis) => axis.axisKey === `candidate-${no}-daypart-boundary`)!;
      expect(boundaryAxis.reducerKind).toBe("CIRCULAR_HOUR_WINDOW");
      expect(boundaryAxis.boundaryMethod).toBe("CIRCULAR_CANDIDATE_ENUMERATION");
      expect("operator" in boundaryAxis).toBe(false);
    }
  });

  it("H. No.42 proves same-row TC filtering/reduction is represented", () => {
    const axes = byNo(42).axes;
    const rowGroupKeys = new Set(axes.map((axis) => (axis.source === "JOINT_EVIDENCE" ? axis.rowGroupKey : null)));
    expect(rowGroupKeys.size).toBe(1);
    expect(axes.some((axis) => axis.reducerKind === "SCALAR_SAMPLE")).toBe(true);
    expect(axes.some((axis) => axis.reducerKind === "FILTER_THEN_DISTINCT_DAYS")).toBe(true);
  });

  it("I. No.26/27 represent matching-after-edge-filter", () => {
    for (const no of [26, 27]) {
      const matchingAxis = byNo(no).axes.find((axis) => axis.reducerKind === "MATCHING_AFTER_EDGE_FILTER")!;
      expect(matchingAxis).toBeDefined();
      expect(matchingAxis.boundaryMethod).toBe("RECOMPUTED_AFTER_EDGE_FILTER");
      expect("operator" in matchingAxis).toBe(false);
      const filterAxis = byNo(no).axes.find((axis) => axis.reducerKind === "SCALAR_SAMPLE")!;
      expect(filterAxis).toBeDefined();
      expect(filterAxis.source === "JOINT_EVIDENCE" && filterAxis.rowGroupKey).toBe(
        matchingAxis.source === "JOINT_EVIDENCE" ? matchingAxis.rowGroupKey : undefined,
      );
    }
  });

  it("J. all JOINT_CORRELATION plans have an executable reducer shape", () => {
    const jointCorrelationPlans = F5C_CANDIDATE_SWEEP_PLANS.filter(({ evaluationShape }) => evaluationShape === "JOINT_CORRELATION");
    expect(jointCorrelationPlans.length).toBeGreaterThan(0);
    for (const candidatePlan of jointCorrelationPlans) {
      expect(candidatePlan.requiredJointEvidence.kind).not.toBe("none");
      expect(candidatePlan.axes.length).toBeGreaterThan(0);
      for (const axis of candidatePlan.axes) {
        if (axis.source !== "JOINT_EVIDENCE") continue;
        expect(axis.rowGroupKey.length).toBeGreaterThan(0);
        expect([
          "SCALAR_SAMPLE", "FILTER_THEN_COUNT", "FILTER_THEN_DISTINCT_DAYS", "FILTER_THEN_SHARE",
          "GROUP_FILTER_THEN_MAX", "MATCHING_AFTER_EDGE_FILTER", "CIRCULAR_HOUR_WINDOW", "SET_BREADTH", "REPEAT_PERIOD",
        ]).toContain(axis.reducerKind);
      }
    }
  });

  it("K. THRESHOLD_PENDING numeric selected values remain zero", () => {
    const audit = auditF5cCandidateSweepPlans();
    expect(audit.numericThresholdValueCount).toBe(0);
    const thresholdPending = F5C_CANDIDATE_SWEEP_PLANS.filter(({ thresholdCategory }) => thresholdCategory === "THRESHOLD_PENDING");
    expect(thresholdPending).toHaveLength(58);
    for (const candidatePlan of thresholdPending) expect(candidatePlan.axes.length).toBeGreaterThan(0);
  });

  it("L. measurementStatus has no implicit default", () => {
    expect(() => f5cInternal.plan(2, "STRUCTURAL_PRESENCE", ["eventCount"], undefined as never, {})).not.toThrow();
    expect(() => f5cInternal.materializePlan(f5cInternal.plan(2, "STRUCTURAL_PRESENCE", ["eventCount"], undefined as never, {}))).toThrow(
      /measurementStatus must be explicit/,
    );
    // measuredPlan()は常に明示的にMEASUREDを設定する
    const measured = f5cInternal.measuredPlan(2, "STRUCTURAL_PRESENCE", ["eventCount"], {});
    expect(measured.measurementStatus).toBe("MEASURED");
    expect(f5cInternal.materializePlan(measured).measurementStatus).toBe("MEASURED");
    // gapPlan()はgapReason必須・axes禁止
    expect(() => f5cInternal.gapPlan(2, "STRUCTURAL_PRESENCE", ["eventCount"], "")).toThrow(/gapReason/);
    const gap = f5cInternal.gapPlan(2, "STRUCTURAL_PRESENCE", ["eventCount"], "source not yet wired");
    expect(gap.measurementStatus).toBe("MEASUREMENT_GAP");
    const materializedGap = f5cInternal.materializePlan(gap);
    expect(materializedGap.measurementStatus).toBe("MEASUREMENT_GAP");
    expect(materializedGap.gapReason).toBe("source not yet wired");
    expect(materializedGap.axes).toEqual([]);
    // TypeScriptレベルでもgapPlan()にaxesは渡せない（コンパイルできない）ため、
    // 実行時にも直接plan()経由でMEASUREMENT_GAP+axesを組むとfail-closedでrejectされることを確認する
    expect(() =>
      f5cInternal.materializePlan(
        f5cInternal.plan(2, "STRUCTURAL_PRESENCE", ["eventCount"], "MEASUREMENT_GAP", {
          gapReason: "source not yet wired",
          axes: [{ axisKey: "x", source: "METRIC", metricKey: "eventCount", operator: "AT_LEAST", boundaryMethod: "OBSERVED_NEAREST_RANK", reducerKind: "SCALAR_METRIC" }],
        }),
      ),
    ).toThrow(/must not declare sweep axes/);
  });

  it("M. audit returns unexecutablePlanCount = 0", () => {
    const audit = auditF5cCandidateSweepPlans();
    expect(audit.unexecutablePlanCount).toBe(0);
    expect(audit.unexecutablePlanCandidateNos).toEqual([]);
    expect(audit.declaredMeasurementGapCount).toBe(0);
    expect(audit.manifestRefMismatches).toEqual([]);
  });
});
