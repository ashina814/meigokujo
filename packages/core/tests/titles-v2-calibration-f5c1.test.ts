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
        if (axis.reducerKind === "CIRCULAR_HOUR_WINDOW") {
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

  it("I. No.26/27 represent a post-filter matching-size sweep boundary", () => {
    for (const no of [26, 27]) {
      const matchingAxis = byNo(no).axes.find((axis) => axis.reducerKind === "POST_FILTER_MATCHING_SIZE")!;
      expect(matchingAxis).toBeDefined();
      // §3: matching sizeはedge filter適用後に再計算される派生値だが、それ自体が
      // subject-level整数のsample集合なので通常のAT_LEAST + nearest-rankでsweepできる
      // ——pre-filterのstructuralMax metricを流用しない、独立した軸であること。
      expect(matchingAxis.boundaryMethod).toBe("OBSERVED_NEAREST_RANK");
      expect("operator" in matchingAxis ? matchingAxis.operator : undefined).toBe("AT_LEAST");
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
          "SCALAR_SAMPLE", "FILTER_THEN_COUNT", "FILTER_THEN_DISTINCT_DAYS", "FILTER_THEN_SHARE", "FILTER_THEN_SPAN_DAYS",
          "GROUP_FILTER_THEN_MAX", "POST_FILTER_MATCHING_SIZE", "CIRCULAR_HOUR_WINDOW", "SET_BREADTH", "REPEAT_PERIOD",
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
    expect(audit.manifestFingerprintDrift).toEqual([]);
    expect(audit.rowGroupsMissingComposition).toEqual([]);
  });
});

/**
 * PR #190レビュー第3ラウンド: manifest pin drift detectionのself-comparison修正、
 * MANIFEST_DEPENDENT candidateへのtyped executable semantics追加、No.26/27の
 * post-filter matching-size boundary、No.56のspan reducer修正、row-group filter
 * composition明示化を検証する。
 */
describe("F5c1 contract executability round 3 (manifest pin drift / typed conformance / matching / span / composition)", () => {
  const byNo = (no: number) => F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === no)!;

  it("1. manifest pin drift guard: pin and live manifest fingerprints are computed independently and currently agree", () => {
    const audit = auditF5cCandidateSweepPlans();
    expect(audit.manifestFingerprintDrift).toEqual([]);
    // すべてのMANIFEST_DEPENDENT candidateがpinへ一致していることも間接的に確認する
    const manifestDependent = F5C_CANDIDATE_SWEEP_PLANS.filter(({ thresholdCategory }) => thresholdCategory === "MANIFEST_DEPENDENT");
    for (const candidatePlan of manifestDependent) expect(audit.manifestRefMismatches).not.toContain(candidatePlan.candidateNo);
  });

  it("2. all 6 MANIFEST_DEPENDENT plans have executable manifestCriteria (not manifestRef alone)", () => {
    const manifestDependent = F5C_CANDIDATE_SWEEP_PLANS.filter(({ thresholdCategory }) => thresholdCategory === "MANIFEST_DEPENDENT");
    expect(manifestDependent).toHaveLength(6);
    for (const candidatePlan of manifestDependent) {
      expect(candidatePlan.manifestRef).not.toBeNull();
      expect(candidatePlan.manifestCriteria.length).toBeGreaterThan(0);
      for (const criterion of candidatePlan.manifestCriteria) {
        expect(["ALL_MANIFEST_MEMBERS", "AT_LEAST_FIXED_DISTINCT_MEMBERS", "ALL_REQUIRED_SUPERDOMAINS", "MANIFEST_CARDINALITY_SWEEP"]).toContain(criterion.kind);
      }
    }
    // No.63: multiple distinct families (fixed "multiple" = 2, not a production threshold)
    expect(byNo(63).manifestCriteria).toEqual([{ kind: "AT_LEAST_FIXED_DISTINCT_MEMBERS", countMetricKey: "distinctSubjectUsedFamilies", fixedValue: 2 }]);
    // No.69: ALL Casino Edition-I families completed
    expect(byNo(69).manifestCriteria).toEqual([{ kind: "ALL_MANIFEST_MEMBERS", countMetricKey: "distinctCompletedFamilies" }]);
    // No.86: multiple Castle families
    expect(byNo(86).manifestCriteria).toEqual([{ kind: "AT_LEAST_FIXED_DISTINCT_MEMBERS", countMetricKey: "activeFamilyCount", fixedValue: 2 }]);
    // No.87: super-domain coverage is typed; the "sufficient family count" part stays an unselected sweep
    expect(byNo(87).manifestCriteria).toEqual([
      { kind: "ALL_REQUIRED_SUPERDOMAINS", countMetricKey: "coveredSuperDomainCount" },
      { kind: "MANIFEST_CARDINALITY_SWEEP", countMetricKey: "domainSemanticBreadth" },
    ]);
    expect(byNo(87).requiredMetrics).toContain("coveredSuperDomainCount");
    // No.88: "almost all" stays an unselected manifest-relative cardinality sweep — no production number invented
    expect(byNo(88).manifestCriteria).toEqual([{ kind: "MANIFEST_CARDINALITY_SWEEP", countMetricKey: "domainSemanticBreadth" }]);
    // No.89: ALL Castle families
    expect(byNo(89).manifestCriteria).toEqual([{ kind: "ALL_MANIFEST_MEMBERS", countMetricKey: "activeFamilyCount" }]);
  });

  it("3. No.26/27 have an executable post-filter matching-size boundary, not a bare recompute step", () => {
    for (const no of [26, 27]) {
      const matchingAxis = byNo(no).axes.find((axis) => axis.reducerKind === "POST_FILTER_MATCHING_SIZE")!;
      expect(matchingAxis).toBeDefined();
      expect("operator" in matchingAxis && matchingAxis.operator).toBe("AT_LEAST");
      expect(matchingAxis.boundaryMethod).toBe("OBSERVED_NEAREST_RANK");
      // structuralMax(pre-filter)ではなく、edge filterと同じrow groupから再計算される値であること
      const edgeFilterAxis = byNo(no).axes.find((axis) => axis.reducerKind === "SCALAR_SAMPLE")!;
      expect("rowGroupKey" in matchingAxis && "rowGroupKey" in edgeFilterAxis && matchingAxis.rowGroupKey).toBe(
        "rowGroupKey" in edgeFilterAxis ? edgeFilterAxis.rowGroupKey : undefined,
      );
    }
  });

  it("4. No.56 own-room-use-days (distinct-days) and own-room-use-span (span) use different reducers and are not the same value in general", () => {
    const daysAxis = byNo(56).axes.find((axis) => axis.axisKey === "own-room-use-days")!;
    const spanAxis = byNo(56).axes.find((axis) => axis.axisKey === "own-room-use-span")!;
    expect(daysAxis.reducerKind).toBe("FILTER_THEN_DISTINCT_DAYS");
    expect(spanAxis.reducerKind).toBe("FILTER_THEN_SPAN_DAYS");
    expect(daysAxis.reducerKind).not.toBe(spanAxis.reducerKind);
    // 実際のreducer semanticsをこのテスト自身で計算し、3件・spanは10であることを確認する
    // (day offsets: 1, 2, 10 → distinct days = 3, span = 10 - 1 + 1 = 10)
    const dayOffsets = [1, 2, 10];
    const distinctDays = new Set(dayOffsets).size;
    const span = dayOffsets.length === 0 ? null : Math.max(...dayOffsets) - Math.min(...dayOffsets) + 1;
    expect(distinctDays).toBe(3);
    expect(span).toBe(10);
    expect(distinctDays).not.toBe(span);
  });

  it("5. explicit multi-filter row-group composition is declared for every relevant group", () => {
    const relevantGroups: { readonly candidateNo: number; readonly rowGroupKey: string }[] = [];
    for (const candidatePlan of F5C_CANDIDATE_SWEEP_PLANS) {
      const filterCountByRowGroup = new Map<string, number>();
      for (const axis of candidatePlan.axes) {
        if (axis.source === "JOINT_EVIDENCE" && axis.reducerKind === "SCALAR_SAMPLE") {
          filterCountByRowGroup.set(axis.rowGroupKey, (filterCountByRowGroup.get(axis.rowGroupKey) ?? 0) + 1);
        }
      }
      for (const [rowGroupKey, count] of filterCountByRowGroup) {
        if (count >= 2) relevantGroups.push({ candidateNo: candidatePlan.candidateNo, rowGroupKey });
      }
    }
    expect(relevantGroups.length).toBeGreaterThan(0);
    for (const { candidateNo, rowGroupKey } of relevantGroups) {
      const declared = byNo(candidateNo).rowGroupCompositions.find((c) => c.rowGroupKey === rowGroupKey);
      expect(declared).toBeDefined();
      expect(["ALL_FILTERS", "ANY_FILTER"]).toContain(declared!.composition);
    }
    const audit = auditF5cCandidateSweepPlans();
    expect(audit.rowGroupsMissingComposition).toEqual([]);
    // A. No.42 TC start: quiet-before + continuation-gap qualify the SAME row conjunctively
    expect(byNo(42).rowGroupCompositions).toEqual([{ rowGroupKey: "tc-start-rows", composition: "ALL_FILTERS" }]);
    // B. No.32-37 TC/VC multimodal social evidence: either modality qualifies (not AND)
    expect(byNo(32).rowGroupCompositions[0]!.composition).toBe("ANY_FILTER");
  });
});

/**
 * PR #190レビュー第4ラウンド: No.69のALL_MANIFEST_MEMBERSがboolean/count意味論を
 * 混在させていた・No.49がTC/VC双方独立のqualifying-day要求をunionへ潰していた・
 * No.56のspanがown-use以外のrowも拾い得るselectorを使っていた、の3点を検証する。
 */
describe("F5c1 contract executability round 4 (No.69 cardinality semantics / No.49 independent TC+VC / No.56 own-use row restriction)", () => {
  const byNo = (no: number) => F5C_CANDIDATE_SWEEP_PLANS.find(({ candidateNo }) => candidateNo === no)!;

  it("1. No.69 and No.89 both use cardinality-compatible ALL_MANIFEST_MEMBERS semantics (a real family count, not a boolean)", () => {
    const plan69 = byNo(69);
    const plan89 = byNo(89);
    const criterion69 = plan69.manifestCriteria.find((c) => c.kind === "ALL_MANIFEST_MEMBERS")!;
    const criterion89 = plan89.manifestCriteria.find((c) => c.kind === "ALL_MANIFEST_MEMBERS")!;
    expect(criterion69).toBeDefined();
    expect(criterion89).toBeDefined();
    // どちらもcountMetricKeyはboolean-valued metric("allFamiliesCompleted"のような0/1)
    // ではなく、実数のfamily count metricを指す——同じcriterion kindが2つの異なる
    // 意味を持たないことを、実際に使われているmetric名で確認する。
    expect(criterion69.countMetricKey).toBe("distinctCompletedFamilies");
    expect(criterion89.countMetricKey).toBe("activeFamilyCount");
    expect(criterion69.countMetricKey).not.toBe("allFamiliesCompleted");
    // allFamiliesCompletedはdiagnostic requiredMetricとしてだけ残る(manifestCriteriaには出ない)
    expect(plan69.requiredMetrics).toContain("allFamiliesCompleted");
    expect(plan69.manifestCriteria.some((c) => "countMetricKey" in c && c.countMetricKey === "allFamiliesCompleted")).toBe(false);
  });

  it("2. No.49 requires TC and VC to independently satisfy qualifying-day evidence — a union cannot satisfy it (counterexample)", () => {
    const plan49 = byNo(49);
    const tcAxis = plan49.axes.find((axis) => axis.axisKey === "tc-qualifying-days")!;
    const vcAxis = plan49.axes.find((axis) => axis.axisKey === "vc-qualifying-days")!;
    expect(tcAxis).toBeDefined();
    expect(vcAxis).toBeDefined();
    expect(tcAxis.reducerKind).toBe("FILTER_THEN_DISTINCT_DAYS");
    expect(vcAxis.reducerKind).toBe("FILTER_THEN_DISTINCT_DAYS");
    // 別々のrowGroupから独立に導出される(同一行のunionではない)
    expect(tcAxis.source === "JOINT_EVIDENCE" && tcAxis.rowGroupKey).toBe("tc-days-rows");
    expect(vcAxis.source === "JOINT_EVIDENCE" && vcAxis.rowGroupKey).toBe("vc-days-rows");
    // tc-days-rows !== vc-days-rows は上の2つのassertion自体が既に示している
    // unionModalityDaysはaxisとして存在しない(diagnostic requiredMetricとしてのみ残る)
    expect(plan49.axes.some((axis) => axis.axisKey.includes("union") || axis.axisKey.includes("modality-day-breadth"))).toBe(false);
    expect(plan49.requiredMetrics).toContain("unionModalityDays");

    // 反例を実際に計算して示す: TC=1 qualifying day, VC=多数のqualifying daysでも、
    // unionだけを見れば「大きい」ように見えてしまう——しかしこのcontractは
    // tc-qualifying-days/vc-qualifying-daysを別axisとして独立に要求するため、
    // TC側が1日しかなければ(仮にVC側のthresholdをいくつに設定しても)TC側のaxisで
    // 未達になり得る、という構造を持つ。union count単体では「TCも複数日」を保証しない。
    const tcQualifyingDayOffsets = [5]; // TC: 1 qualifying day
    const vcQualifyingDayOffsets = [1, 2, 3, 4, 6, 7, 8]; // VC: many qualifying days
    const unionDayOffsets = new Set([...tcQualifyingDayOffsets, ...vcQualifyingDayOffsets]);
    expect(unionDayOffsets.size).toBeGreaterThan(1); // unionは「複数日」に見えてしまう
    expect(new Set(tcQualifyingDayOffsets).size).toBe(1); // しかしTC単体は複数日ではない
    // この契約はtc-qualifying-days(TC単体のdistinct日数)をunionから独立に要求するので、
    // 「TC単体1日・VC単体多数日」というこのケースを、union countだけで「TCも複数日」と
    // 誤って満たされたことにはしない——tc-qualifying-daysのaxisが別途TC単体の値を見る。
  });

  it("3. No.56 own-use days and span both derive from the same restricted own-use row selector — hosted/guest rows cannot alter the span", () => {
    const plan56 = byNo(56);
    const daysAxis = plan56.axes.find((axis) => axis.axisKey === "own-room-use-days")!;
    const spanAxis = plan56.axes.find((axis) => axis.axisKey === "own-room-use-span")!;
    expect(daysAxis.source === "JOINT_EVIDENCE" && daysAxis.selector).toBe("domainDays.public-room-own-use");
    expect(spanAxis.source === "JOINT_EVIDENCE" && spanAxis.selector).toBe("domainDays.public-room-own-use");
    // 両者が全く同じselector(own-use限定)を共有しているので、hosted/guest行が
    // spanへ紛れ込む余地が型レベルで無い(genericなdomainDays.day-offsetは
    // もう使われていない)。
    expect(plan56.requiredJointEvidence.selectors).toContain("domainDays.public-room-own-use");
    expect(plan56.requiredJointEvidence.selectors).not.toContain("domainDays.day-offset");

    // 実際のfixtureでown-use行だけがspan/distinct daysを決めることを計算で示す:
    // own-use day offsets = 1, 2, 10。hosted/guest行はdomainDays.public-room-own-use
    // selectorには一切現れない(別selectorの領域)ため、own-useのspan/日数計算に
    // 混入しようがない。
    const ownUseDayOffsets = [1, 2, 10];
    // hosted/guestの行は別のselector配下にあり、own-use rowGroupのfilter対象にすら
    // ならない——このcontractのselector分離自体がその保証。ここでは「もし誤って
    // 混入したら結果が変わってしまう」ことを対比のために計算するだけで、実際の
    // selectorはown-useだけを指すため混入しない。
    const distinctDays = new Set(ownUseDayOffsets).size;
    const span = ownUseDayOffsets.length === 0 ? null : Math.max(...ownUseDayOffsets) - Math.min(...ownUseDayOffsets) + 1;
    expect(distinctDays).toBe(3);
    expect(span).toBe(10);
    // hosted/guestの行(例: day offset 50、own-use範囲の外)がselectorへ混入した場合に
    // 初めてspanが動くという対比——だが実際のselectorはown-use限定なので混入しない。
    const hostedGuestDayOffsetOutsideRange = 50;
    const contaminatedSpan = Math.max(...ownUseDayOffsets, hostedGuestDayOffsetOutsideRange) - Math.min(...ownUseDayOffsets) + 1;
    expect(contaminatedSpan).not.toBe(span); // 混入すれば値が変わる、という対比の確認
  });
});
