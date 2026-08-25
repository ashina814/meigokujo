import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { TITLE_V2_CATALOG_CANDIDATES } from "../src/titles/v2-catalog-candidates.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import {
  collectF5aCalibrationMeasurements,
  compareCalibrationSnapshots,
  nearestRankPercentile,
  runF5aCalibrationSnapshot,
  serializeCalibrationSnapshot,
  summarizeNumericDistribution,
  type CalibrationSnapshot,
} from "../src/titles/v2-calibration.js";
import { assertResolvedTitleScopeForTitle, resolvePlanningCalibrationScope } from "../src/titles/v2-scope.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const DAY = 86_400;
const OBSERVED_AT = BASE + 4 * DAY;

function setup() {
  const db = openDb(":memory:");
  const tc = new TcSocialObservations(db);
  const window = Object.freeze({
    start: BASE,
    end: Math.floor(new Date("2026-09-01T00:00:00+09:00").getTime() / 1000),
    observedAt: OBSERVED_AT,
  });
  const segment = (user: string, channel: string, start: number, end: number) =>
    db.prepare(
      `INSERT INTO vc_segments
         (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
       VALUES (?, ?, 'parent', ?, ?, 0, 0, 'observed', 'join')`,
    ).run(user, channel, start, end);
  const publicVc = (user: string, channel: string, start: number, end: number) =>
    db.prepare(
      `INSERT INTO vc_public_social_presence
         (user_id, guild_id, channel_id, started_at, ended_at, end_quality)
       VALUES (?, 'guild', ?, ?, ?, 'observed')`,
    ).run(user, channel, start, end);
  const message = (id: string, author: string, at: number, surface = "surface") => tc.recordMessage({
    messageId: id,
    authorId: author,
    surfaceId: surface,
    areaId: surface,
    surfaceKind: "channel",
    replyToMessageId: null,
    createdAtMs: at * 1000,
    observedAtMs: at * 1000 + 1,
  });
  const run = (ids: readonly string[] = ["subject", "zero"]) => runF5aCalibrationSnapshot(db, {
    cohortKey: "operator-supplied-fixture",
    subjectUserIds: ids,
    window,
  });
  return { db, window, segment, publicVc, message, run };
}

function pack(snapshot: CalibrationSnapshot, key: CalibrationSnapshot["packs"][number]["probeKey"]) {
  return snapshot.packs.find((entry) => entry.probeKey === key)!;
}

function metric(snapshot: CalibrationSnapshot, packKey: CalibrationSnapshot["packs"][number]["probeKey"], metricKey: string) {
  return pack(snapshot, packKey).metrics.find((entry) => entry.metricKey === metricKey)!.distribution;
}

function seedVcStyle(ctx: ReturnType<typeof setup>) {
  const addOccupancy = (channel: string, start: number, seconds: number, occupancy: number) => {
    ctx.segment("subject", channel, start, start + seconds);
    for (let index = 1; index < occupancy; index += 1) {
      ctx.segment(`peer-${channel}-${index}`, channel, start, start + seconds);
    }
  };
  addOccupancy("solo", BASE + 100, 60, 1);
  addOccupancy("one", BASE + 3_600, 100, 2);
  addOccupancy("small", BASE + 7_200, 120, 3);
  addOccupancy("large", BASE + 10_800, 180, 5);
  addOccupancy("one-day-three", BASE + 2 * DAY + 3_600, 50, 2);
}

function seedActivityTime(ctx: ReturnType<typeof setup>) {
  ctx.publicVc("subject", "midnight", BASE + DAY - 10, BASE + DAY + 10);
  ctx.publicVc("subject", "hour-five", BASE + DAY + 5 * 3_600, BASE + DAY + 5 * 3_600 + 100);
  ctx.message("subject-gap", "subject", BASE + DAY + 7 * 3_600, "gap-surface");
  ctx.message("other-gap", "other", BASE + DAY + 7 * 3_600 + 60, "gap-surface");
  ctx.message("standalone", "subject", BASE + DAY + 8 * 3_600, "standalone-surface");
}

describe("F5a deterministic calibration framework A-S", () => {
  it("A/B/C. same input・subject order・duplicate IDsでcanonical JSONが一致する", () => {
    const ctx = setup();
    seedVcStyle(ctx);
    const a = ctx.run(["subject", "zero"]);
    const b = ctx.run(["zero", "subject", "subject"]);
    expect(serializeCalibrationSnapshot(a)).toBe(serializeCalibrationSnapshot(b));
    expect(a.cohort).toEqual({ key: "operator-supplied-fixture", subjectCount: 2 });
    expect(compareCalibrationSnapshots(a, b)).toEqual({ compatible: true, differences: [] });
  });

  it("C. 601-subject cohortはsourceごとに300/300/1のbounded bulk readsだけを行う", () => {
    const ctx = setup();
    const ids = Array.from({ length: 601 }, (_, index) => `zero-${index}`);
    const snapshot = ctx.run(ids);
    expect(snapshot.cohort.subjectCount).toBe(601);
    expect(snapshot.packs.map(({ probeKey, readCalls }) => ({ probeKey, readCalls }))).toEqual([
      { probeKey: "activity-time-v1", readCalls: 3 },
      { probeKey: "vc-style-v1", readCalls: 3 },
    ]);
    expect(metric(snapshot, "vc-style-v1", "totalTrustedSeconds").populationCount).toBe(601);
  });

  it("D/E. zero activityはdenominatorに残り、empty cohortもvalid", () => {
    const ctx = setup();
    const withZero = ctx.run(["zero"]);
    expect(metric(withZero, "vc-style-v1", "totalTrustedSeconds")).toMatchObject({
      populationCount: 1, nonZeroCount: 0, zeroCount: 1, missingCount: 0, p50: 0,
    });
    const empty = ctx.run([]);
    expect(empty.cohort.subjectCount).toBe(0);
    expect(metric(empty, "vc-style-v1", "totalTrustedSeconds")).toMatchObject({
      populationCount: 0, sampleCount: 0, min: null, max: null,
    });
    expect(pack(empty, "vc-style-v1").warnings).toEqual(["NO_SUBJECTS", "SOURCE_OMITS_UNKNOWN_COVERAGE"]);
  });

  it("F/G. future rowsは固定observedAtを変えず、month endはeffectiveEndへclipする", () => {
    const ctx = setup();
    seedVcStyle(ctx);
    const before = serializeCalibrationSnapshot(ctx.run(["subject"]));
    ctx.segment("subject", "future", OBSERVED_AT + 10, OBSERVED_AT + 20);
    ctx.publicVc("subject", "future", OBSERVED_AT + 10, OBSERVED_AT + 20);
    expect(serializeCalibrationSnapshot(ctx.run(["subject"]))).toBe(before);
    const snapshot = ctx.run(["subject"]);
    expect(snapshot.window.end).toBeGreaterThan(snapshot.window.observedAt);
    expect(snapshot.window.effectiveEnd).toBe(snapshot.window.observedAt);
  });

  it("H/I/J/K. DB write 0・aggregate-only privacy・raw payload非露出・deep freeze", () => {
    const ctx = setup();
    ctx.segment("user-secret-marker", "channel-secret-marker", BASE + 1, BASE + 2);
    const before = (ctx.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const snapshot = ctx.run(["user-secret-marker", "zero-secret-marker"]);
    const after = (ctx.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    const json = serializeCalibrationSnapshot(snapshot);
    for (const forbidden of ["user-secret-marker", "zero-secret-marker", "channel-secret-marker", "userId", "subjectUserIds", "startedAt", "endedAt"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.packs)).toBe(true);
    expect(Object.isFrozen(snapshot.packs[0]!.metrics[0]!.distribution.nonZeroDistribution)).toBe(true);
    expect(() => ((snapshot.cohort as { key: string }).key = "changed")).toThrow();
  });

  it("AR/AS. planning-internal measurementはjoint correlationを保ち、serialized snapshotはaggregate-only", () => {
    const ctx = setup();
    const ids = [
      "joint-secret-a",
      "joint-secret-b",
      "joint-secret-c",
      "joint-secret-d",
    ] as const;
    const oneToOne = (subject: string, channel: string, start: number, seconds: number) => {
      ctx.segment(subject, channel, start, start + seconds);
      ctx.segment(`peer-${channel}`, channel, start, start + seconds);
    };
    oneToOne(ids[0], "joint-a", BASE + 100, 100);
    ctx.segment(ids[1], "joint-b", BASE + 300, BASE + 500);
    ctx.segment(ids[2], "joint-c", BASE + 600, BASE + 700);
    oneToOne(ids[3], "joint-d", BASE + 800, 200);

    const collection = collectF5aCalibrationMeasurements(ctx.db, {
      cohortKey: "joint-correlation-fixture",
      subjectUserIds: ids,
      window: ctx.window,
    });
    const vcMetrics = (subjectUserId: string) => collection.subjects
      .find((subject) => subject.subjectUserId === subjectUserId)!
      .packs.find(({ probeKey }) => probeKey === "vc-style-v1")!.metrics;
    const pair = (subjectUserId: string) => [
      vcMetrics(subjectUserId)["totalTrustedSeconds"],
      vcMetrics(subjectUserId)["overallBucketShare.oneToOne"],
    ];
    const firstMarginals = [ids[0], ids[1]].map(pair);
    const secondMarginals = [ids[2], ids[3]].map(pair);
    expect(firstMarginals.map(([total]) => total).sort()).toEqual(secondMarginals.map(([total]) => total).sort());
    expect(firstMarginals.map(([, share]) => share).sort()).toEqual(secondMarginals.map(([, share]) => share).sort());
    expect(firstMarginals).toEqual([[100, 1], [200, 0]]);
    expect(secondMarginals).toEqual([[100, 0], [200, 1]]);
    expect(Object.isFrozen(collection.subjects[0]!.packs[0]!.metrics)).toBe(true);

    const json = serializeCalibrationSnapshot(ctx.run(ids));
    expect(json).not.toContain("subjects");
    for (const id of ids) expect(json).not.toContain(id);
  });

  it("L/M/R/S. full/nonzero distributionsがzero inflation・all-zero・singleを区別する", () => {
    const mixed = summarizeNumericDistribution([0, 0, 0, 10]);
    expect(mixed).toMatchObject({ populationCount: 4, nonZeroCount: 1, zeroCount: 3, missingCount: 0, p50: 0 });
    expect(mixed.nonZeroDistribution).toMatchObject({ sampleCount: 1, min: 10, p50: 10, max: 10 });
    expect(summarizeNumericDistribution([0, 0])).toMatchObject({ zeroCount: 2, nonZeroCount: 0, min: 0, max: 0 });
    expect(summarizeNumericDistribution([7])).toMatchObject({ populationCount: 1, p25: 7, p99: 7 });
  });

  it("N/O/P/Q. null ratioはmissing、nearest-rankはorder independentでnon-finiteを拒否", () => {
    expect(summarizeNumericDistribution([null, 0, 1])).toMatchObject({
      populationCount: 3, missingCount: 1, zeroCount: 1, nonZeroCount: 1,
    });
    expect(nearestRankPercentile([1, 2, 3, 4], 25)).toBe(1);
    expect(nearestRankPercentile([4, 1, 3, 2], 75)).toBe(3);
    expect(() => summarizeNumericDistribution([Number.NaN])).toThrow(/finite/);
    expect(() => nearestRankPercentile([Number.POSITIVE_INFINITY], 50)).toThrow(/finite/);
    expect(JSON.stringify(summarizeNumericDistribution([-0]))).not.toContain("-0");
  });
});

describe("F5a VC Style distribution pack T-AB", () => {
  it("T/U/V/W/X. 4bucket totals・social denominator・positive days/spanをsafe daily sourceから測る", () => {
    const ctx = setup();
    seedVcStyle(ctx);
    const snapshot = ctx.run(["subject"]);
    expect(metric(snapshot, "vc-style-v1", "bucketTotalSeconds.oneToOne").p50).toBe(150);
    expect(metric(snapshot, "vc-style-v1", "bucketTotalSeconds.smallGroup").p50).toBe(120);
    expect(metric(snapshot, "vc-style-v1", "bucketTotalSeconds.largeGroup").p50).toBe(180);
    expect(metric(snapshot, "vc-style-v1", "totalSocialSeconds").p50).toBe(450);
    expect(metric(snapshot, "vc-style-v1", "socialOnlyShare.oneToOne").p50).toBeCloseTo(150 / 450);
    expect(metric(snapshot, "vc-style-v1", "bucketPositiveDays.oneToOne").p50).toBe(2);
    expect(metric(snapshot, "vc-style-v1", "bucketPositiveDays.smallGroup").p50).toBe(1);
    expect(metric(snapshot, "vc-style-v1", "activeDays").p50).toBe(2);
    expect(metric(snapshot, "vc-style-v1", "positiveSpanDays").p50).toBe(3);
    expect(metric(snapshot, "vc-style-v1", "firstPositiveDayOffset").p50).toBe(0);
    expect(metric(snapshot, "vc-style-v1", "lastPositiveDayOffset").p50).toBe(2);
    expect(metric(snapshot, "vc-style-v1", "overallBucketShare.solo").p50).toBeCloseTo(60 / 510);
  });

  it("Y/Z. social denominator zeroはnull/missing、数秒標本もmeasurementだけを出す", () => {
    const ctx = setup();
    ctx.segment("subject", "solo-only", BASE + 10, BASE + 13);
    const snapshot = ctx.run(["subject"]);
    expect(metric(snapshot, "vc-style-v1", "totalTrustedSeconds").p50).toBe(3);
    expect(metric(snapshot, "vc-style-v1", "socialOnlyShare.oneToOne")).toMatchObject({
      populationCount: 1, missingCount: 1, sampleCount: 0, p50: null,
    });
    expect(metric(snapshot, "vc-style-v1", "dailySocialOnlyShareMedian.oneToOne")).toMatchObject({
      populationCount: 1, missingCount: 1, sampleCount: 0, p50: null,
    });
    expect(serializeCalibrationSnapshot(snapshot)).not.toContain("matched");
  });

  it("AA/AB. daily share median/IQRとpositive social bucket breadthがdeterministic", () => {
    const ctx = setup();
    seedVcStyle(ctx);
    const snapshot = ctx.run(["subject"]);
    expect(metric(snapshot, "vc-style-v1", "dailyBucketShareMedian.oneToOne").p50).toBeCloseTo(100 / 460);
    expect(metric(snapshot, "vc-style-v1", "dailyBucketShareP75.oneToOne").p50).toBe(1);
    expect(metric(snapshot, "vc-style-v1", "dailyBucketShareIqr.oneToOne").p50).toBeCloseTo(1 - 100 / 460);
    expect(metric(snapshot, "vc-style-v1", "positiveSocialBucketCount").p50).toBe(3);
    expect(pack(snapshot, "vc-style-v1").candidateNos).toEqual(Array.from({ length: 12 }, (_, i) => i + 10));
    expect(pack(snapshot, "vc-style-v1").readCalls).toBe(1);
  });

  it("AT/AU. daily social-only shareはsocial denominatorを使い、solo-only dayをmissingとして除外する", () => {
    const tenHour = setup();
    tenHour.segment("subject", "solo-nine-hours", BASE + 60, BASE + 9 * 3_600 + 60);
    tenHour.segment("subject", "social-one-hour", BASE + 9 * 3_600 + 60, BASE + 10 * 3_600 + 60);
    tenHour.segment("peer", "social-one-hour", BASE + 9 * 3_600 + 60, BASE + 10 * 3_600 + 60);
    const tenHourSnapshot = tenHour.run(["subject"]);
    expect(metric(tenHourSnapshot, "vc-style-v1", "dailyBucketShareMedian.oneToOne").p50).toBeCloseTo(0.1);
    expect(metric(tenHourSnapshot, "vc-style-v1", "dailySocialOnlyShareMedian.oneToOne").p50).toBe(1);

    const twoDays = setup();
    twoDays.segment("subject", "solo-day", BASE + 60, BASE + 3_660);
    twoDays.segment("subject", "social-day", BASE + DAY + 60, BASE + DAY + 3_660);
    twoDays.segment("peer", "social-day", BASE + DAY + 60, BASE + DAY + 3_660);
    const twoDaySnapshot = twoDays.run(["subject"]);
    expect(metric(twoDaySnapshot, "vc-style-v1", "dailyBucketShareP25.oneToOne").p50).toBe(0);
    expect(metric(twoDaySnapshot, "vc-style-v1", "dailySocialOnlyShareP25.oneToOne").p50).toBe(1);
    expect(metric(twoDaySnapshot, "vc-style-v1", "dailySocialOnlyShareMax.oneToOne").p50).toBe(1);
  });
});

describe("F5a Activity-Time distribution pack AC-AK", () => {
  it("AC/AD/AE. 24 JST hoursとmidnight splitを維持し、daypartへcollapseしない", () => {
    const ctx = setup();
    seedActivityTime(ctx);
    const snapshot = ctx.run(["subject"]);
    const activity = pack(snapshot, "activity-time-v1");
    expect(activity.tcGapByHour.map((entry) => entry.hour)).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
    expect(metric(snapshot, "activity-time-v1", "hourlyVcTrustedSeconds.23").p50).toBe(10);
    expect(metric(snapshot, "activity-time-v1", "hourlyVcTrustedSeconds.0").p50).toBe(10);
    const metricKeys = activity.metrics.map(({ metricKey }) => metricKey);
    for (const boundary of ["morning", "afternoon", "evening", "lateNight", "daypart"]) {
      expect(metricKeys.some((metricKey) => metricKey.includes(boundary))).toBe(false);
    }
  });

  it("AF/AG/AK. TC best gapをboolean化せず、hour/global gap分布を保ちstandaloneを除外する", () => {
    const ctx = setup();
    seedActivityTime(ctx);
    const snapshot = ctx.run(["subject"]);
    const activity = pack(snapshot, "activity-time-v1");
    expect(activity.tcGapOverall).toMatchObject({ sampleCount: 1, min: 60_000, p50: 60_000, max: 60_000 });
    expect(activity.tcGapByHour[7]!.distribution).toMatchObject({ sampleCount: 1, p50: 60_000 });
    expect(activity.tcGapByHour[8]!.distribution).toMatchObject({ sampleCount: 0, p50: null });
    expect(metric(snapshot, "activity-time-v1", "tcGapSampleCount").p50).toBe(1);
    expect(activity.metrics.some(({ metricKey }) => /meaningful|wouldMatch/i.test(metricKey))).toBe(false);
  });

  it("AH/AI/AJ. VC-only concentrationはnumerator basis付きで正確、TCとcombinedせずfutureを除外", () => {
    const ctx = setup();
    seedActivityTime(ctx);
    ctx.publicVc("subject", "future", OBSERVED_AT + 1, OBSERVED_AT + 1_001);
    const snapshot = ctx.run(["subject"]);
    expect(metric(snapshot, "activity-time-v1", "vcTotalTrustedSeconds").p50).toBe(120);
    expect(metric(snapshot, "activity-time-v1", "vcDominantHourSeconds").p50).toBe(100);
    expect(metric(snapshot, "activity-time-v1", "vcTop2HoursSeconds").p50).toBe(110);
    expect(metric(snapshot, "activity-time-v1", "vcTop3HoursSeconds").p50).toBe(120);
    expect(metric(snapshot, "activity-time-v1", "vcDominantHourShare").p50).toBeCloseTo(100 / 120);
    expect(metric(snapshot, "activity-time-v1", "vcTop2HoursShare").p50).toBeCloseTo(110 / 120);
    expect(metric(snapshot, "activity-time-v1", "vcTop3HoursShare").p50).toBe(1);
    expect(pack(snapshot, "activity-time-v1").metrics.some(({ metricKey }) => /combined/i.test(metricKey))).toBe(false);
    expect(pack(snapshot, "activity-time-v1").readCalls).toBe(1);
  });
});

describe("F5a candidate/readiness and planning boundary AL-AQ", () => {
  it("AL-AM/AO. No.10-21・32-37のsemanticSpec/thresholdIntentを変更しない", () => {
    const targeted = TITLE_V2_CATALOG_CANDIDATES
      .filter(({ no }) => (no >= 10 && no <= 21) || (no >= 32 && no <= 37))
      .map(({ no, semanticSpec, thresholdIntent }) => ({ no, semanticSpec, thresholdIntent }));
    const ctx = setup();
    ctx.run(["subject"]);
    expect(TITLE_V2_CATALOG_CANDIDATES
      .filter(({ no }) => (no >= 10 && no <= 21) || (no >= 32 && no <= 37))
      .map(({ no, semanticSpec, thresholdIntent }) => ({ no, semanticSpec, thresholdIntent }))).toEqual(targeted);
    expect(pack(ctx.run(["subject"]), "vc-style-v1").candidates.every(({ thresholdCategory }) => thresholdCategory === "THRESHOLD_PENDING")).toBe(true);
  });

  it("AN. readinessは76/6/9/8のまま、target candidatesはREADY source整合", () => {
    const counts = new Map<string, number>();
    for (const entry of TITLE_V2_CATALOG_READINESS) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ READY: 76, PARTIAL: 6, BLOCKED: 9, META: 8 });
    const snapshot = setup().run(["subject"]);
    expect(snapshot.catalogCandidateCount).toBe(99);
    expect(snapshot.catalogHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.readinessHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.packs.flatMap(({ candidates }) => candidates).every(({ readiness }) => readiness === "READY")).toBe(true);
  });

  it("AP/AQ. production definition/evaluator/Bot/barrel wiringを追加せずplanning-onlyを維持", () => {
    const here = fileURLToPath(new URL("../src/titles/", import.meta.url));
    const calibration = readFileSync(new URL("../src/titles/v2-calibration.ts", import.meta.url), "utf8");
    expect(calibration).not.toContain(".prepare(");
    expect(calibration).not.toContain("defineTitleRule");
    expect(calibration).not.toContain("evaluateTitle");
    for (const file of ["v2.ts", "v2-evaluator.ts", "v2-pipeline.ts"]) {
      const text = readFileSync(new URL(`../src/titles/${file}`, import.meta.url), "utf8");
      expect(text, `${here}${file}`).not.toContain("v2-calibration");
    }
    const bot = readFileSync(new URL("../../../apps/bot/src/index.ts", import.meta.url), "utf8");
    expect(bot).not.toContain("v2-calibration");
    const planningScope = resolvePlanningCalibrationScope({ start: BASE, end: OBSERVED_AT + DAY, observedAt: OBSERVED_AT });
    expect(() => assertResolvedTitleScopeForTitle(planningScope, "v2.any-production-title")).toThrow(/different title/);
    expect(() => resolvePlanningCalibrationScope({ start: BASE, end: BASE, observedAt: BASE })).toThrow(/invalid/);
  });
});
