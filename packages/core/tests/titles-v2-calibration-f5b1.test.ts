import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { RoleFamilyTemporal, type RoleFamilyManifest } from "../src/role-family/temporal.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import {
  collectF5aCalibrationMeasurements,
  collectF5b1CalibrationMeasurements,
  runF5aCalibrationSnapshot,
  runF5b1CalibrationSnapshot,
  serializeCalibrationSnapshot,
  type CalibrationProbeKey,
  type CalibrationSnapshot,
  type PlanningCalibrationMeasurementCollection,
} from "../src/titles/v2-calibration.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const DAY = 86_400;
const OBSERVED_AT = BASE + 4 * DAY;

function setup() {
  const db = openDb(":memory:");
  const bump = new BumpCounter(db);
  const tc = new TcSocialObservations(db);
  const window = Object.freeze({ start: BASE, end: BASE + 6 * DAY, observedAt: OBSERVED_AT });
  const segment = (
    userId: string,
    channelId: string,
    startedAt: number,
    endedAt: number,
    startReason: "join" | "move" | "state_change" = "join",
  ) => db.prepare(
    `INSERT INTO vc_segments
       (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
     VALUES (?, ?, 'parent', ?, ?, 0, 0, 'observed', ?)`,
  ).run(userId, channelId, startedAt, endedAt, startReason);
  const publicVc = (userId: string, channelId: string, startedAt: number, endedAt: number) => db.prepare(
    `INSERT INTO vc_public_social_presence
       (user_id, guild_id, channel_id, started_at, ended_at, end_quality)
     VALUES (?, 'guild', ?, ?, ?, 'observed')`,
  ).run(userId, channelId, startedAt, endedAt);
  const status = (userId: string, value: string, observedAt: number) => db.prepare(
    `INSERT INTO soul_status_history (user_id, status, observed_at, provenance)
     VALUES (?, ?, ?, 'status_transition')`,
  ).run(userId, value, observedAt);
  const message = (
    id: string,
    authorId: string,
    atMs: number,
    options: { surface?: string; replyTo?: string | null } = {},
  ) => tc.recordMessage({
    messageId: id,
    authorId,
    surfaceId: options.surface ?? "surface",
    areaId: options.surface ?? "surface",
    surfaceKind: "channel",
    replyToMessageId: options.replyTo ?? null,
    createdAtMs: atMs,
    observedAtMs: atMs + 1,
  });
  const input = (subjectUserIds: readonly string[], cohortKey = "f5b1-fixture") => ({ cohortKey, subjectUserIds, window });
  return { db, bump, tc, window, segment, publicVc, status, message, input };
}

function snapshotPack(snapshot: CalibrationSnapshot, probeKey: CalibrationProbeKey) {
  return snapshot.packs.find((pack) => pack.probeKey === probeKey)!;
}

function snapshotMetric(snapshot: CalibrationSnapshot, probeKey: CalibrationProbeKey, metricKey: string) {
  return snapshotPack(snapshot, probeKey).metrics.find((metric) => metric.metricKey === metricKey)!.distribution;
}

function internalPack(collection: PlanningCalibrationMeasurementCollection, subjectUserId: string, probeKey: CalibrationProbeKey) {
  return collection.subjects.find((subject) => subject.subjectUserId === subjectUserId)!
    .packs.find((pack) => pack.probeKey === probeKey)!;
}

function internalMetric(
  collection: PlanningCalibrationMeasurementCollection,
  subjectUserId: string,
  probeKey: CalibrationProbeKey,
  metricKey: string,
) {
  return internalPack(collection, subjectUserId, probeKey).metrics[metricKey];
}

describe("F5b1 shared calibration engine A-H", () => {
  it("A/E/F/G/H. F5a JSON semanticを維持し、F5b1もdeterministic/read-only/deep-frozen", () => {
    const ctx = setup();
    ctx.publicVc("subject", "hour-five", BASE + 5 * 3_600, BASE + 5 * 3_600 + 60);
    const f5a = runF5aCalibrationSnapshot(ctx.db, ctx.input(["subject", "zero"]));
    expect(f5a.packs.map(({ probeKey }) => probeKey)).toEqual(["activity-time-v1", "vc-style-v1"]);
    expect(snapshotMetric(f5a, "activity-time-v1", "vcTotalTrustedSeconds").p50).toBe(0);

    const beforeChanges = (ctx.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const a = runF5b1CalibrationSnapshot(ctx.db, ctx.input(["subject", "zero", "subject"]));
    const b = runF5b1CalibrationSnapshot(ctx.db, ctx.input(["zero", "subject"]));
    expect(serializeCalibrationSnapshot(a)).toBe(serializeCalibrationSnapshot(b));
    expect((ctx.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(beforeChanges);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.packs[0]!.metrics[0]!.distribution.nonZeroDistribution)).toBe(true);

    const beforeFuture = serializeCalibrationSnapshot(a);
    ctx.bump.addOnce("future-bump", "subject", OBSERVED_AT + 10);
    ctx.segment("subject", "future-vc", OBSERVED_AT + 10, OBSERVED_AT + 20);
    expect(serializeCalibrationSnapshot(runF5b1CalibrationSnapshot(ctx.db, ctx.input(["subject", "zero"])))).toBe(beforeFuture);
  });

  it("B/C/D. shared sourceはprobe数に関係なく601 usersでsourceごとに3 reads", () => {
    const ctx = setup();
    const ids = Array.from({ length: 601 }, (_, index) => `zero-${index}`);
    const collection = collectF5b1CalibrationMeasurements(ctx.db, ctx.input(ids, "bulk-601"));
    expect(collection.sourceReadCalls).toHaveLength(8);
    expect(collection.sourceReadCalls.every(({ readCalls }) => readCalls === 3)).toBe(true);
    expect(collection.sourceReadCalls.find(({ source }) => source === "vc_social_safe")?.readCalls).toBe(3);
    expect(collection.sourceReadCalls.find(({ source }) => source === "tc_conversation_safe")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "social-breadth-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "relationship-depth-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "cross-modal-v1")?.readCalls).toBe(6);
  });
});

describe("F5a Activity-Time joint repair I-L", () => {
  it("同一hour marginalsでもday×hour相関、arbitrary daypart distinct days、midnight wrapを保持する", () => {
    const ctx = setup();
    ctx.publicVc("matrix-a-secret", "a5", BASE + 5 * 3_600 + 10, BASE + 5 * 3_600 + 20);
    ctx.publicVc("matrix-a-secret", "a6", BASE + 6 * 3_600 + 10, BASE + 6 * 3_600 + 20);
    ctx.publicVc("matrix-b-secret", "b5", BASE + 5 * 3_600 + 10, BASE + 5 * 3_600 + 20);
    ctx.publicVc("matrix-b-secret", "b6", BASE + DAY + 6 * 3_600 + 10, BASE + DAY + 6 * 3_600 + 20);
    ctx.publicVc("matrix-c-secret", "midnight", BASE + DAY - 10, BASE + DAY + 10);
    const ids = ["matrix-a-secret", "matrix-b-secret", "matrix-c-secret"];
    const collection = collectF5aCalibrationMeasurements(ctx.db, ctx.input(ids));
    const rows = (id: string) => {
      const evidence = internalPack(collection, id, "activity-time-v1").jointEvidence;
      expect(evidence.kind).toBe("activity-time-day-hour-v1");
      return evidence.kind === "activity-time-day-hour-v1" ? evidence.rows : [];
    };
    expect(rows(ids[0]!).map(({ dayOffset, hour }) => [dayOffset, hour])).toEqual([[0, 5], [0, 6]]);
    expect(rows(ids[1]!).map(({ dayOffset, hour }) => [dayOffset, hour])).toEqual([[0, 5], [1, 6]]);
    const distinctDaypartDays = (id: string) => new Set(rows(id)
      .filter(({ hour }) => hour >= 5 && hour <= 6)
      .map(({ dayOffset }) => dayOffset)).size;
    expect(distinctDaypartDays(ids[0]!)).toBe(1);
    expect(distinctDaypartDays(ids[1]!)).toBe(2);
    expect(rows(ids[2]!).map(({ dayOffset, hour }) => [dayOffset, hour])).toEqual([[0, 23], [1, 0]]);

    const json = serializeCalibrationSnapshot(runF5aCalibrationSnapshot(ctx.db, ctx.input(ids)));
    for (const forbidden of [...ids, "jointEvidence", "matrix-c-secret", "dayOffset\":", "rows\":"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});

describe("F5b1 VC ignite/closer and social breadth M-V", () => {
  it("M/N/O/P/Q. joinedAt/becameLastAt基準の日・span・channel countとcandidate scopeが正確", () => {
    const ctx = setup();
    ctx.segment("ignite-subject-secret", "ignite-channel-secret-1", BASE + DAY - 60, BASE + DAY + 100);
    ctx.segment("ignite-peer-1", "ignite-channel-secret-1", BASE + DAY + 10, BASE + DAY + 40);
    ctx.segment("ignite-subject-secret", "ignite-channel-secret-2", BASE + DAY + 100, BASE + DAY + 300);
    ctx.segment("ignite-peer-2", "ignite-channel-secret-2", BASE + DAY + 150, BASE + DAY + 200);
    ctx.segment("closer-peer-1", "closer-channel-secret-1", BASE + 400, BASE + 500);
    ctx.segment("closer-subject-secret", "closer-channel-secret-1", BASE + 410, BASE + 600);
    ctx.segment("closer-peer-2", "closer-channel-secret-2", BASE + 2 * DAY + 400, BASE + 2 * DAY + 500);
    ctx.segment("closer-subject-secret", "closer-channel-secret-2", BASE + 2 * DAY + 410, BASE + 2 * DAY + 600);
    const ignite = runF5b1CalibrationSnapshot(ctx.db, ctx.input(["ignite-subject-secret"]));
    const closer = runF5b1CalibrationSnapshot(ctx.db, ctx.input(["closer-subject-secret"]));
    expect(snapshotMetric(ignite, "vc-ignite-v1", "occurrenceCount").p50).toBe(2);
    expect(snapshotMetric(ignite, "vc-ignite-v1", "distinctOccurrenceDays").p50).toBe(1);
    expect(snapshotMetric(ignite, "vc-ignite-v1", "firstOccurrenceDayOffset").p50).toBe(1);
    expect(snapshotMetric(closer, "vc-closer-v1", "distinctOccurrenceDays").p50).toBe(2);
    expect(snapshotMetric(closer, "vc-closer-v1", "occurrenceSpanDays").p50).toBe(3);
    expect(snapshotMetric(closer, "vc-closer-v1", "distinctChannels").p50).toBe(2);
    expect(snapshotPack(ignite, "vc-ignite-v1").candidateNos).toEqual([2]);
    expect(snapshotPack(closer, "vc-closer-v1").candidateNos).toEqual([7, 9]);
    const json = serializeCalibrationSnapshot(closer);
    for (const marker of ["ignite-channel-secret", "closer-channel-secret"]) expect(json).not.toContain(marker);
  });

  it("R/S/T/U/V. daily breadth joint profileとNo.28 repeated-daysを分離し、対象外candidateを入れない", () => {
    const ctx = setup();
    const overlap = (peer: string, channel: string, start: number) => {
      ctx.segment("social-subject", channel, start, start + 100);
      ctx.segment(peer, channel, start, start + 100);
    };
    overlap("peer-one", "breadth-a", BASE + 100);
    overlap("peer-one", "breadth-b", BASE + DAY + 100);
    overlap("peer-two", "breadth-c", BASE + DAY + 300);
    const collection = collectF5b1CalibrationMeasurements(ctx.db, ctx.input(["social-subject", "zero"]));
    expect(internalMetric(collection, "social-subject", "social-breadth-v1", "distinctCoPresentUsers")).toBe(2);
    expect(internalMetric(collection, "social-subject", "social-breadth-v1", "breadthPositiveDays")).toBe(2);
    expect(internalMetric(collection, "social-subject", "social-breadth-v1", "breadthSpanDays")).toBe(2);
    expect(internalMetric(collection, "zero", "social-breadth-v1", "distinctCoPresentUsers")).toBe(0);
    const evidence = internalPack(collection, "social-subject", "social-breadth-v1").jointEvidence;
    expect(evidence.kind === "social-breadth-days-v1" ? evidence.days.map((day) => day.distinctCoPresentUsers) : []).toEqual([1, 2]);
    expect(internalMetric(collection, "social-subject", "relationship-depth-v1", "maxRepeatedDaysWithOneCounterpart")).toBe(2);
    expect(snapshotPack(runF5b1CalibrationSnapshot(ctx.db, ctx.input(["social-subject"])), "social-breadth-v1").candidateNos).toEqual([23, 24, 25]);
    expect(snapshotPack(runF5b1CalibrationSnapshot(ctx.db, ctx.input(["social-subject"])), "relationship-depth-v1").candidateNos).toEqual([28]);
  });
});

describe("F5b1 class/department anonymous graph W-AA", () => {
  it("person×semantic graph、threshold-recomputable edge days/seconds、maximum matchingを保持する", () => {
    const ctx = setup();
    const overlap = (subject: string, peer: string, channel: string, start: number) => {
      ctx.segment(subject, channel, start, start + 50);
      ctx.segment(peer, channel, start, start + 50);
    };
    for (const [user, value] of [["one-peer", "ghost"], ["two-a", "ghost"], ["two-b", "majin"]] as const) {
      ctx.status(user, value, BASE - 100);
    }
    ctx.status("one-peer", "majin", BASE + DAY);
    overlap("class-one", "one-peer", "class-one-a", BASE + 100);
    overlap("class-one", "one-peer", "class-one-b", BASE + DAY + 100);
    overlap("class-two", "two-a", "class-two-a", BASE + 300);
    overlap("class-two", "two-b", "class-two-b", BASE + 500);

    const manifest: RoleFamilyManifest = {
      provenance: "explicit_manifest",
      families: [
        { familyKey: "family-a", roleIds: ["role-a"], tags: ["public_department"] },
        { familyKey: "family-b", roleIds: ["role-b"], tags: ["public_department"] },
      ],
    };
    const temporal = new RoleFamilyTemporal(ctx.db);
    temporal.startObservationSession("main", manifest, [{ userId: "dept-peer", roleIds: ["role-a"], bot: false }], BASE - 100);
    overlap("dept-one", "dept-peer", "dept-a", BASE + 700);
    temporal.observeMemberSnapshot("main", { userId: "dept-peer", roleIds: ["role-b"], bot: false }, BASE + DAY);
    overlap("dept-one", "dept-peer", "dept-b", BASE + DAY + 700);
    temporal.checkpoint("main", OBSERVED_AT);

    const ids = ["class-one", "class-two", "dept-one"];
    const collection = collectF5b1CalibrationMeasurements(ctx.db, ctx.input(ids));
    expect(internalMetric(collection, "class-one", "social-class-context-v1", "structuralMaxPersonClassMatching")).toBe(1);
    expect(internalMetric(collection, "class-two", "social-class-context-v1", "structuralMaxPersonClassMatching")).toBe(2);
    expect(internalMetric(collection, "dept-one", "social-department-context-v1", "structuralMaxPersonFamilyMatching")).toBe(1);
    const graph = internalPack(collection, "class-one", "social-class-context-v1").jointEvidence;
    expect(graph.kind === "social-context-graph-v1" ? graph.counterparts[0]!.touches.map((touch) => touch.days[0]!.trustedSeconds) : []).toEqual([50, 50]);
    const json = serializeCalibrationSnapshot(runF5b1CalibrationSnapshot(ctx.db, ctx.input(ids)));
    for (const forbidden of ["counterpartOrdinal", "semanticIndex", "class-one-a", "family-a"]) expect(json).not.toContain(forbidden);
  });
});

describe("F5b1 BUMP AB-AE", () => {
  it("same-day excessとdistinct daysを分離し、streak/raw timestampを出さない", () => {
    const ctx = setup();
    for (const [id, at] of [["b1", BASE + 123], ["b2", BASE + 456], ["b3", BASE + 789], ["b4", BASE + 2 * DAY + 123]] as const) {
      ctx.bump.addOnce(id, "bump-subject", at);
    }
    const snapshot = runF5b1CalibrationSnapshot(ctx.db, ctx.input(["bump-subject"]));
    expect(snapshotMetric(snapshot, "bump-contribution-v1", "eventCount").p50).toBe(4);
    expect(snapshotMetric(snapshot, "bump-contribution-v1", "distinctActiveDays").p50).toBe(2);
    expect(snapshotMetric(snapshot, "bump-contribution-v1", "sameDayExcessCount").p50).toBe(2);
    expect(snapshotMetric(snapshot, "bump-contribution-v1", "maxEventsPerDay").p50).toBe(3);
    expect(snapshotPack(snapshot, "bump-contribution-v1").metrics.some(({ metricKey }) => /streak/i.test(metricKey))).toBe(false);
    expect(serializeCalibrationSnapshot(snapshot)).not.toContain(String(BASE + 123));
  });
});

describe("F5b1 TC joint evidence AF-AS", () => {
  function seedStartPairing(ctx: ReturnType<typeof setup>) {
    const seed = (subject: string, suffix: string, at: number, quiet: number, next: number) => {
      const surface = `${subject}-${suffix}`;
      ctx.message(`${surface}-prior`, `${surface}-other-prior`, at - quiet, { surface });
      ctx.message(`${surface}-start`, subject, at, { surface });
      ctx.message(`${surface}-next`, `${surface}-other-next`, at + next, { surface });
    };
    seed("tc-a-secret", "one", BASE * 1000 + 4 * 3_600_000, 3_600_000, 1_800_000);
    seed("tc-a-secret", "two", BASE * 1000 + 10 * 3_600_000, 300_000, 60_000);
    seed("tc-b-secret", "one", BASE * 1000 + 5 * 3_600_000, 3_600_000, 60_000);
    seed("tc-b-secret", "two", BASE * 1000 + 11 * 3_600_000, 300_000, 1_800_000);
  }

  it("AF-AJ. starts pairing、revival grouping、area/third-party correlationを匿名で保持しNo.48を除外", () => {
    const ctx = setup();
    seedStartPairing(ctx);
    const baseMs = BASE * 1000;
    ctx.message("rev-root", "rev-other", baseMs + 10_000, { surface: "revival" });
    ctx.message("rev-one", "tc-a-secret", baseMs + DAY * 1000 + 10_000, { surface: "revival", replyTo: "rev-root" });
    ctx.message("rev-two", "tc-a-secret", baseMs + 2 * DAY * 1000 + 10_000, { surface: "revival", replyTo: "rev-one" });
    ctx.message("join-a", "join-other-a", baseMs + 20_000, { surface: "join" });
    ctx.message("join-b", "join-other-b", baseMs + 30_000, { surface: "join" });
    ctx.message("join-self-old", "tc-a-secret", baseMs + 35_000, { surface: "join" });
    ctx.message("join-subject", "tc-a-secret", baseMs + 40_000, { surface: "join" });
    ctx.message("join-next", "join-other-a", baseMs + 50_000, { surface: "join" });
    ctx.message("standalone", "tc-zero-social", baseMs + 60_000, { surface: "standalone" });
    const collection = collectF5b1CalibrationMeasurements(ctx.db, ctx.input(["tc-a-secret", "tc-b-secret", "tc-zero-social"]));
    const starts = (id: string) => {
      const evidence = internalPack(collection, id, "tc-conversation-v1").jointEvidence;
      return evidence.kind === "tc-conversation-v1" ? evidence.starts : [];
    };
    const selectedPairs = (id: string) => starts(id)
      .filter(({ quietBeforeMs }) => quietBeforeMs === 3_600_000 || quietBeforeMs === 300_000)
      .map(({ quietBeforeMs, nextOtherGapMs }) => [quietBeforeMs, nextOtherGapMs]);
    expect(selectedPairs("tc-a-secret")).toEqual([[3_600_000, 1_800_000], [300_000, 60_000]]);
    expect(selectedPairs("tc-b-secret")).toEqual([[3_600_000, 60_000], [300_000, 1_800_000]]);
    const evidence = internalPack(collection, "tc-a-secret", "tc-conversation-v1").jointEvidence;
    expect(evidence.kind === "tc-conversation-v1" ? evidence.revivalConversations.some(({ revivals }) => revivals.length === 2) : false).toBe(true);
    expect(evidence.kind === "tc-conversation-v1" ? evidence.areas.every(({ areaOrdinal }) => Number.isInteger(areaOrdinal)) : false).toBe(true);
    expect(evidence.kind === "tc-conversation-v1" ? evidence.thirdPartyJoins.some((join) => join.priorDistinctOtherGapMs.length >= 2) : false).toBe(true);
    expect(internalMetric(collection, "tc-zero-social", "tc-conversation-v1", "socialAreaCount")).toBe(0);
    expect(snapshotPack(runF5b1CalibrationSnapshot(ctx.db, ctx.input(["tc-a-secret"])), "tc-conversation-v1").candidateNos).toEqual([42, 43, 44, 45, 47]);
  });

  it("AK-AN. same global reactor totalsでもanonymous per-post profile差を保持しserialized snapshotへ出さない", () => {
    const ctx = setup();
    const baseMs = BASE * 1000;
    for (const [id, subject, offset] of [["a1", "react-a-secret", 10], ["a2", "react-a-secret", 20], ["b1", "react-b-secret", 30], ["b2", "react-b-secret", 40]] as const) {
      ctx.message(id, subject, baseMs + offset, { surface: `post-${id}` });
    }
    ctx.tc.recordReaction("a1", "reactor-one-secret", baseMs + 100);
    ctx.tc.recordReaction("a1", "reactor-two-secret", baseMs + 200);
    ctx.tc.recordReaction("a2", "reactor-one-secret", baseMs + DAY * 1000 + 100);
    ctx.tc.recordReaction("b1", "reactor-one-secret", baseMs + 100);
    ctx.tc.recordReaction("b2", "reactor-two-secret", baseMs + 200);
    ctx.tc.recordReaction("b2", "reactor-one-secret", baseMs + DAY * 1000 + 100);
    const ids = ["react-a-secret", "react-b-secret"];
    const collection = collectF5b1CalibrationMeasurements(ctx.db, ctx.input(ids));
    expect(ids.map((id) => internalMetric(collection, id, "tc-reaction-v1", "distinctReactors"))).toEqual([2, 2]);
    const profiles = (id: string) => {
      const evidence = internalPack(collection, id, "tc-reaction-v1").jointEvidence;
      return evidence.kind === "tc-reaction-posts-v1"
        ? evidence.posts.map((post) => [post.distinctReactors, post.reactionDayOffsets.length])
        : [];
    };
    expect(profiles(ids[0]!)).toEqual([[2, 1], [1, 1]]);
    expect(profiles(ids[1]!)).toEqual([[1, 1], [2, 2]]);
    const json = serializeCalibrationSnapshot(runF5b1CalibrationSnapshot(ctx.db, ctx.input(ids)));
    for (const forbidden of [...ids, "postOrdinal", "reactionDayOffsets", "reactor-one-secret", "emoji"]) expect(json).not.toContain(forbidden);
  });

  it("AO-AS. TC/VC day seriesとoverlap diagnosticを保持するがsame-day/gap thresholdを固定しない", () => {
    const ctx = setup();
    seedStartPairing(ctx);
    const overlap = (channel: string, start: number) => {
      ctx.segment("tc-a-secret", channel, start, start + 100);
      ctx.segment(`peer-${channel}`, channel, start, start + 100);
    };
    overlap("cross-day-zero", BASE + 100);
    overlap("cross-day-two", BASE + 2 * DAY + 100);
    const collection = collectF5b1CalibrationMeasurements(ctx.db, ctx.input(["tc-a-secret"]));
    const evidence = internalPack(collection, "tc-a-secret", "cross-modal-v1").jointEvidence;
    expect(evidence.kind).toBe("cross-modal-days-v1");
    if (evidence.kind !== "cross-modal-days-v1") throw new Error("unexpected evidence");
    expect(evidence.tcDays.length).toBeGreaterThan(0);
    expect(evidence.vcDays.map(({ dayOffset }) => dayOffset)).toEqual([0, 2]);
    const overlapCount = new Set(evidence.tcDays.map(({ dayOffset }) => dayOffset));
    expect(internalMetric(collection, "tc-a-secret", "cross-modal-v1", "overlappingCalendarDays"))
      .toBe(evidence.vcDays.filter(({ dayOffset }) => overlapCount.has(dayOffset)).length);
    const snapshot = runF5b1CalibrationSnapshot(ctx.db, ctx.input(["tc-a-secret"]));
    const cross = snapshotPack(snapshot, "cross-modal-v1");
    expect(cross.candidateNos).toEqual([49]);
    expect(cross.sources).toEqual(["tc_conversation_safe", "vc_social_safe"]);
    expect(cross.metrics.some(({ metricKey }) => /threshold|qualified|sameDayRequired/i.test(metricKey))).toBe(false);
  });
});

describe("F5b1 production/readiness boundary", () => {
  it("candidate integrity・readiness 76/6/9/8・planning-only import boundaryを維持", () => {
    const ctx = setup();
    const snapshot = runF5b1CalibrationSnapshot(ctx.db, ctx.input(["zero"]));
    expect(snapshot.packs.flatMap(({ candidateNos }) => candidateNos).sort((a, b) => a - b)).toEqual([
      2, 7, 9, 23, 24, 25, 26, 27, 28, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 49,
    ]);
    const counts = new Map<string, number>();
    for (const entry of TITLE_V2_CATALOG_READINESS) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ READY: 76, PARTIAL: 6, BLOCKED: 9, META: 8 });
    const calibration = readFileSync(new URL("../src/titles/v2-calibration.ts", import.meta.url), "utf8");
    expect(calibration).not.toContain(".prepare(");
    expect(calibration).not.toContain("BehaviorTitleDefinition");
    for (const file of ["v2.ts", "v2-evaluator.ts", "v2-pipeline.ts", "../index.ts"]) {
      const text = readFileSync(new URL(`../src/titles/${file}`, import.meta.url), "utf8");
      expect(text).not.toContain("v2-calibration");
    }
    const bot = readFileSync(new URL("../../../apps/bot/src/index.ts", import.meta.url), "utf8");
    expect(bot).not.toContain("v2-calibration");
  });
});
