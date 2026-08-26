import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { Takutate } from "../src/casino/takutate.js";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { PublicEvents } from "../src/public-events/service.js";
import { RoleFamilyTemporal } from "../src/role-family/temporal.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { TITLE_V2_CATALOG_READINESS } from "../src/titles/v2-catalog-readiness.js";
import {
  collectF5b2CalibrationMeasurements,
  F5B2_CALIBRATION_PROBES,
  runF5b2CalibrationSnapshot,
  serializeCalibrationSnapshot,
  type CalibrationProbeKey,
  type CalibrationSnapshot,
  type PlanningCalibrationMeasurementCollection,
} from "../src/titles/v2-calibration.js";
import { VcPublicSocialPresence } from "../src/vc/public-social-presence.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const DAY = 86_400;
const WINDOW = Object.freeze({ start: BASE, end: BASE + 10 * DAY, observedAt: BASE + 8 * DAY });
const input = (subjectUserIds: readonly string[], cohortKey = "f5b2-fixture") => ({ cohortKey, subjectUserIds, window: WINDOW });

function setupDb() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  new CasinoParticipationHistory(db, () => BASE);
  new Takutate(db, events, () => BASE);
  new PublicEvents(db, () => BASE);
  new RoleFamilyTemporal(db);
  new TcSocialObservations(db);
  new VcPublicSocialPresence(db);
  db.exec(`CREATE TABLE IF NOT EXISTS casino_market_participation_history (
    participation_key TEXT PRIMARY KEY, market_id INTEGER NOT NULL, market_creator_id TEXT NOT NULL,
    participant_id TEXT NOT NULL, market_mode TEXT NOT NULL, market_created_at INTEGER NOT NULL,
    market_deadline_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL)`);
  return db;
}

function pack(snapshot: CalibrationSnapshot, probeKey: CalibrationProbeKey) {
  return snapshot.packs.find((entry) => entry.probeKey === probeKey)!;
}

function metric(snapshot: CalibrationSnapshot, probeKey: CalibrationProbeKey, metricKey: string) {
  return pack(snapshot, probeKey).metrics.find((entry) => entry.metricKey === metricKey)!.distribution;
}

function internalPack(collection: PlanningCalibrationMeasurementCollection, userId: string, probeKey: CalibrationProbeKey) {
  return collection.subjects.find(({ subjectUserId }) => subjectUserId === userId)!.packs.find((entry) => entry.probeKey === probeKey)!;
}

const EXPECTED_MATRIX = [
  ["public-room-activity-v1", [50, 51, 52, 53, 54, 55], ["public_room_activity_safe"]],
  ["public-room-social-time-v1", [56], ["public_room_activity_safe", "social_activity_time_safe"]],
  ["economy-peer-actions-v1", [58], ["economy_safe_peer_actions"]],
  ["economy-semantic-v1", [59, 61, 63, 65], ["economy_semantic_safe", "shop_role_purchase_safe"]],
  ["shop-purchase-v1", [62], ["shop_purchase_safe"]],
  ["casino-completed-activity-v1", [66, 67], ["casino_completed_activity_days"]],
  ["casino-activity-v1", [68], ["casino_activity_days"]],
  ["casino-edition-completion-v1", [69], ["casino_edition_i_completion_safe"]],
  ["casino-table-activity-v1", [70], ["casino_table_activity_safe"]],
  ["casino-table-participation-v1", [71], ["casino_table_activity_safe"]],
  ["casino-market-activity-v1", [72], ["casino_market_activity_safe"]],
  ["confirmed-invites-v1", [74, 75], ["confirmed_invites"]],
  ["invite-rooted-v1", [76, 77, 78, 79], ["invite_rooted_safe"]],
  ["public-event-completion-v1", [80], ["public_event_completed_participations"]],
  ["public-event-calendar-v1", [81, 82, 83, 84], ["public_event_completed_participations", "public_event_calendar_involvement_safe"]],
  ["castle-experience-v1", [85, 86, 89], ["castle_experience_safe"]],
  ["castle-social-time-v1", [87, 88], ["castle_experience_safe", "social_activity_time_safe"]],
  ["castle-role-context-v1", [90, 91], ["castle_experience_safe", "castle_role_context_safe"]],
] as const;

describe("F5b2 domain calibration packs A-H", () => {
  it("A/B. exact 38 candidate union、blocked exclusion、single assignment、source matrix", () => {
    expect(F5B2_CALIBRATION_PROBES.map(({ probeKey, candidateNos, sources }) => [probeKey, candidateNos, sources])).toEqual(EXPECTED_MATRIX);
    const candidates = F5B2_CALIBRATION_PROBES.flatMap(({ candidateNos }) => candidateNos);
    expect(candidates).toHaveLength(38);
    expect(new Set(candidates).size).toBe(38);
    expect([...candidates].sort((a, b) => a - b)).toEqual([
      50, 51, 52, 53, 54, 55, 56, 58, 59, 61, 62, 63, 65, 66, 67, 68, 69, 70, 71, 72,
      74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91,
    ]);
    for (const blocked of [57, 60, 64, 73]) expect(candidates).not.toContain(blocked);
  });

  it("C/D/E. deterministic、dedupe、read-only、aggregate-only、deep-freeze", () => {
    const db = setupDb();
    db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, ?)")
      .run("subject-secret", "invitee-secret", BASE + DAY + 123);
    const beforeChanges = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const a = runF5b2CalibrationSnapshot(db, input(["subject-secret", "zero-secret", "subject-secret"]));
    const b = runF5b2CalibrationSnapshot(db, input(["zero-secret", "subject-secret"]));
    expect(serializeCalibrationSnapshot(a)).toBe(serializeCalibrationSnapshot(b));
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(beforeChanges);
    expect(metric(a, "confirmed-invites-v1", "confirmedInviteCount").p50).toBe(0);
    expect(metric(a, "confirmed-invites-v1", "confirmedInviteCount").max).toBe(1);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.packs[0]!.candidateNos)).toBe(true);
    expect(Object.isFrozen(a.packs[0]!.coverageLimitations)).toBe(true);
    expect(Object.isFrozen(a.packs[0]!.metrics[0]!.distribution.nonZeroDistribution)).toBe(true);
    const json = serializeCalibrationSnapshot(a);
    for (const forbidden of ["subject-secret", "zero-secret", "invitee-secret", "subjectUserId", "jointEvidence", "profileOrdinal"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("F. 601 subjectsはunique sourceごとに一度prefetchし、shared sourceをprobe数倍読まない", () => {
    const db = setupDb();
    const ids = Array.from({ length: 601 }, (_, index) => `zero-${index}`);
    const collection = collectF5b2CalibrationMeasurements(db, input(ids, "bulk-601"));
    expect(collection.sourceReadCalls).toHaveLength(17);
    for (const row of collection.sourceReadCalls) {
      expect(row.readCalls, row.source).toBe(row.source === "castle_experience_safe" || row.source === "castle_role_context_safe" ? 27 : 3);
    }
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "public-room-social-time-v1")?.readCalls).toBe(6);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "casino-table-activity-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "casino-table-participation-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "castle-social-time-v1")?.readCalls).toBe(30);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "castle-role-context-v1")?.readCalls).toBe(54);
  });

  it("G/H. zeroとmissingを分け、multi-source planning evidenceだけが匿名day/hour相関を保持", () => {
    const db = setupDb();
    db.prepare(`INSERT INTO vc_public_social_presence
      (user_id, guild_id, channel_id, started_at, ended_at, end_quality)
      VALUES (?, 'guild-secret', 'channel-secret', ?, ?, 'observed')`)
      .run("social-secret", BASE + 5 * 3_600, BASE + 5 * 3_600 + 60);
    const collection = collectF5b2CalibrationMeasurements(db, input(["social-secret", "zero-secret"]));
    for (const probeKey of ["public-room-social-time-v1", "castle-social-time-v1"] as const) {
      const evidence = internalPack(collection, "social-secret", probeKey).jointEvidence;
      expect(evidence.kind).toBe("domain-social-time-v1");
      if (evidence.kind !== "domain-social-time-v1") throw new Error("unexpected evidence");
      expect(evidence.socialHours.some(({ dayOffset, hour, vcTrustedSocialSeconds }) => dayOffset === 0 && hour === 5 && vcTrustedSocialSeconds === 60)).toBe(true);
      expect(JSON.stringify(evidence)).not.toMatch(/social-secret|guild-secret|channel-secret|2026-08-20/);
    }
    const snapshot = runF5b2CalibrationSnapshot(db, input(["zero-secret"]));
    expect(metric(snapshot, "castle-role-context-v1", "totalOccurrenceCount").p50).toBe(0);
    expect(metric(snapshot, "castle-role-context-v1", "outsideOccurrenceRatio").missingCount).toBe(1);
    expect(metric(snapshot, "castle-role-context-v1", "outsideSecondsRatio").missingCount).toBe(1);
    expect(metric(snapshot, "public-room-activity-v1", "activeFirstDayOffset").missingCount).toBe(1);
    expect(metric(snapshot, "public-room-activity-v1", "activeSpanDays").missingCount).toBe(1);
    expect(metric(snapshot, "public-room-activity-v1", "activeDays").p50).toBe(0);
  });
});

describe("F5b2 production/readiness boundary", () => {
  it("readiness 76/6/9/8、planning-only import boundary、schema v1を維持", () => {
    const counts = new Map<string, number>();
    for (const entry of TITLE_V2_CATALOG_READINESS) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ READY: 76, PARTIAL: 6, BLOCKED: 9, META: 8 });
    const source = readFileSync(new URL("../src/titles/v2-calibration.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".prepare(");
    expect(source).not.toContain("BehaviorTitleDefinition");
    expect(runF5b2CalibrationSnapshot(setupDb(), input([])).schemaVersion).toBe(1);
    for (const file of ["v2.ts", "v2-evaluator.ts", "v2-pipeline.ts", "../index.ts"]) {
      expect(readFileSync(new URL(`../src/titles/${file}`, import.meta.url), "utf8")).not.toContain("v2-calibration");
    }
    expect(readFileSync(new URL("../../../apps/bot/src/index.ts", import.meta.url), "utf8")).not.toContain("v2-calibration");
  });
});
