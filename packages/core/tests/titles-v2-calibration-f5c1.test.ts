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
      measurementGapCount: 0,
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
        expect(axis.boundaryMethod).toBe("OBSERVED_NEAREST_RANK");
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
