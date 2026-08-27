import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { Takutate } from "../src/casino/takutate.js";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { PublicEvents } from "../src/public-events/service.js";
import { RoleFamilyTemporal, type RoleFamilyManifest } from "../src/role-family/temporal.js";
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

function room(db: ReturnType<typeof setupDb>, ownerId: string, channelId: string, createdAt: number) {
  db.prepare(`INSERT INTO rooms
    (kind,channel_id,owner_id,capacity,expires_at,activated_at,status,closed_at,created_at,updated_at)
    VALUES ('normal',?,?,4,NULL,NULL,'closed',?,?,?)`)
    .run(channelId, ownerId, createdAt + 7 * DAY, createdAt, createdAt + 7 * DAY);
}

function visit(db: ReturnType<typeof setupDb>, userId: string, channelId: string, start: number, end: number) {
  db.prepare(`INSERT INTO vc_segments
    (user_id,channel_id,parent_id,started_at,ended_at,self_muted,self_deafened,end_quality,start_reason)
    VALUES (?,?,'parent-fixture',?,?,0,0,'observed','join')`)
    .run(userId, channelId, start, end);
}

let fixtureSequence = 0;
function purchase(
  db: ReturnType<typeof setupDb>,
  userId: string,
  purchasedAt: number,
  productKey: string,
) {
  const id = ++fixtureSequence;
  db.prepare(`INSERT INTO shop_items
    (id,name,price_land,kind,delivery,enabled,created_at,updated_at)
    VALUES (?, ?, 1, 'one_shot', 'manual', 1, ?, ?)`)
    .run(id, `item-${id}`, BASE, BASE);
  db.prepare(`INSERT INTO shop_purchases
    (id,item_id,user_id,purchased_at,paid_land,status,auto_renew)
    VALUES (?,?,?,?,1,'active',0)`)
    .run(id, id, userId, purchasedAt);
  db.prepare(`INSERT INTO shop_purchase_title_provenance
    (purchase_id,user_id,product_key,purchased_at,origin,title_eligible)
    VALUES (?,?,?,?,'storefront',1)`)
    .run(id, userId, productKey, purchasedAt);
}

function economyFact(
  db: ReturnType<typeof setupDb>,
  fromUserId: string,
  toUserId: string,
  type: "transfer" | "tip",
  createdAt: number,
) {
  db.prepare(`INSERT OR IGNORE INTO accounts (id,kind,created_at) VALUES (?, 'user', ?), (?, 'user', ?)`)
    .run(`user:${fromUserId}`, createdAt - 1, `user:${toUserId}`, createdAt - 1);
  db.prepare(`INSERT INTO transactions
    (idempotency_key,from_account,to_account,amount,type,actor_id,created_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(`calibration:${++fixtureSequence}`, `user:${fromUserId}`, `user:${toUserId}`, 1, type, `user:${fromUserId}`, createdAt);
}

function recordMessage(
  service: TcSocialObservations,
  id: string,
  authorId: string,
  at: number,
  surfaceId: string,
) {
  service.recordMessage({
    messageId: id,
    authorId,
    surfaceId,
    areaId: surfaceId,
    surfaceKind: "channel",
    replyToMessageId: null,
    createdAtMs: at * 1_000,
    observedAtMs: at * 1_000 + 1,
  });
}

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
  ["economy-semantic-v1", [59, 61, 63], ["economy_semantic_safe"]],
  ["shop-role-purchase-v1", [65], ["shop_role_purchase_safe"]],
  ["shop-purchase-v1", [62], ["shop_purchase_safe"]],
  ["casino-completed-activity-v1", [66, 67], ["casino_completed_activity_days"]],
  ["casino-activity-v1", [68], ["casino_activity_days"]],
  ["casino-edition-completion-v1", [69], ["casino_edition_i_completion_safe"]],
  ["casino-table-activity-v1", [70], ["casino_table_activity_safe"]],
  ["casino-table-busy-v1", [71], ["casino_table_activity_safe"]],
  ["casino-market-activity-v1", [72], ["casino_market_activity_safe"]],
  ["confirmed-invites-v1", [74, 75], ["confirmed_invites"]],
  ["invite-rooted-v1", [76, 77, 78, 79], ["invite_rooted_safe"]],
  ["public-event-completion-v1", [80, 81], ["public_event_completed_participations"]],
  ["public-event-calendar-v1", [82, 83, 84], ["public_event_calendar_involvement_safe"]],
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
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "economy-semantic-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "shop-role-purchase-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "casino-table-activity-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "casino-table-busy-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "public-event-completion-v1")?.readCalls).toBe(3);
    expect(collection.packReadCalls.find(({ probeKey }) => probeKey === "public-event-calendar-v1")?.readCalls).toBe(3);
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

  it("I. public-room hosted/own/guest reducersはnon-emptyで、overlap sessionを偽のtotalへ加算しない", () => {
    const db = setupDb();
    room(db, "subject", "owned-overlap", BASE);
    visit(db, "subject", "owned-overlap", BASE + DAY + 10, BASE + DAY + 70);
    visit(db, "guest-a", "owned-overlap", BASE + DAY + 20, BASE + DAY + 60);
    room(db, "other-owner", "visited-room", BASE + DAY);
    visit(db, "subject", "visited-room", BASE + 2 * DAY + 10, BASE + 2 * DAY + 50);
    db.prepare(`INSERT INTO vc_public_social_presence
      (user_id,guild_id,channel_id,started_at,ended_at,end_quality)
      VALUES ('subject','guild','ordinary-vc',?,?, 'observed')`)
      .run(BASE + 2 * DAY + 100, BASE + 2 * DAY + 160);

    const collection = collectF5b2CalibrationMeasurements(db, input(["subject"]));
    const metrics = internalPack(collection, "subject", "public-room-activity-v1").metrics;
    expect(metrics).toMatchObject({
      hostedSessionCount: 1,
      ownUseSessionCount: 1,
      guestSessionCount: 1,
      activeDays: 2,
      activeFirstDayOffset: 1,
      activeLastDayOffset: 2,
      activeSpanDays: 2,
    });
    expect(metrics).not.toHaveProperty("totalSessionCount");
    expect(internalPack(collection, "subject", "public-room-social-time-v1").metrics).toMatchObject({
      domainSemanticBreadth: 3,
      domainActiveDays: 2,
      socialActiveDays: 1,
      socialVcTrustedSeconds: 60,
      overlappingCalendarDays: 1,
    });
  });

  it("J. economy / shop-role / shop purchase reducersをsource境界ごとにnon-empty測定する", () => {
    const db = setupDb();
    economyFact(db, "sender", "subject", "transfer", BASE + DAY + 10);
    economyFact(db, "subject", "tip-recipient", "tip", BASE + 2 * DAY + 10);
    purchase(db, "subject", BASE + 2 * DAY + 20, "product-a");
    purchase(db, "subject", BASE + 2 * DAY + 30, "product-b");
    purchase(db, "non-role", BASE + 2 * DAY + 40, "product-c");

    const temporal = new RoleFamilyTemporal(db);
    temporal.startObservationSession("main", {
      provenance: "explicit_manifest",
      families: [{
        familyKey: "department:shop",
        roleIds: ["role-shop"],
        tags: ["public_department", "shop"],
      }],
    }, [{ userId: "subject", roleIds: ["role-shop"], bot: false }, { userId: "non-role", roleIds: [], bot: false }], BASE);
    temporal.checkpoint("main", BASE + 7 * DAY);

    const collection = collectF5b2CalibrationMeasurements(db, input(["subject", "non-role"]));
    const economy = internalPack(collection, "subject", "economy-semantic-v1").metrics;
    expect(economy).toMatchObject({
      distinctFamilies: 3,
      distinctSubjectUsedFamilies: 2,
      hasNaturalInflow: 1,
      hasNaturalOutflow: 1,
      outgoingTipDistinctRecipients: 1,
      "familyObserved.peer_transfer": 1,
      "familySubjectUsed.tip": 1,
    });
    expect(Object.keys(economy).some((key) => key.startsWith("shopRole"))).toBe(false);
    expect(Object.keys(economy).some((key) => key.startsWith("dailyShopRole"))).toBe(false);
    expect(internalPack(collection, "subject", "economy-peer-actions-v1").metrics).toMatchObject({
      peerActionCount: 1,
      transferCount: 0,
      tipCount: 1,
      peerActionActiveDays: 1,
    });

    expect(internalPack(collection, "subject", "shop-role-purchase-v1").metrics).toMatchObject({
      shopRoleEligiblePurchaseCount: 2,
      shopRolePurchaseActiveDays: 1,
      shopRolePurchaseActiveSpanDays: 1,
    });
    expect(internalPack(collection, "non-role", "shop-role-purchase-v1").metrics.shopRoleEligiblePurchaseCount).toBe(0);
    expect(internalPack(collection, "subject", "shop-purchase-v1").metrics).toMatchObject({
      distinctEligibleProducts: 2,
      sumDailyDistinctEligibleProducts: 2,
      purchaseActiveDays: 1,
    });
  });

  it("K. casino completion/activity/table/market reducersはfamily/day/table/guest breadthを保持する", () => {
    const db = setupDb();
    let now = BASE + DAY;
    const casino = new CasinoParticipationHistory(db, () => now);
    const complete = (key: string, activityKey: "slots" | "roulette") => {
      casino.recordCommittedParticipation({ participationKey: key, activityKey, participantUserIds: ["subject"] });
      casino.recordCompletedParticipation({ participationKey: key, activityKey, participantUserIds: ["subject"] });
    };
    complete("slots-a", "slots");
    complete("slots-repeat", "slots");
    now = BASE + 2 * DAY;
    complete("roulette", "roulette");

    const tables = new Takutate(db, new EventLog(db), () => now);
    now = BASE;
    tables.track("table-a", "guild", "subject", "mahjong");
    tables.observeGuestTransition({ userId: "guest-a", isBot: false, oldChannelId: null, newChannelId: "table-a", observedAt: BASE + DAY - 10 });
    tables.observeGuestTransition({ userId: "guest-a", isBot: false, oldChannelId: "table-a", newChannelId: null, observedAt: BASE + DAY + 10 });
    now = BASE + 2 * DAY;
    tables.track("table-b", "guild", "subject", "sashi");
    tables.observeGuestTransition({ userId: "guest-a", isBot: false, oldChannelId: null, newChannelId: "table-b", observedAt: BASE + 2 * DAY + 10 });
    tables.observeGuestTransition({ userId: "guest-a", isBot: false, oldChannelId: "table-b", newChannelId: null, observedAt: BASE + 2 * DAY + 40 });
    tables.observeGuestTransition({ userId: "guest-b", isBot: false, oldChannelId: null, newChannelId: "table-b", observedAt: BASE + 2 * DAY + 50 });
    tables.observeGuestTransition({ userId: "guest-b", isBot: false, oldChannelId: "table-b", newChannelId: null, observedAt: BASE + 2 * DAY + 90 });

    const market = db.prepare("INSERT INTO casino_market_participation_history VALUES (?,?,?,?,?,?,?,?)");
    market.run("market-a", 1, "creator-a", "subject", "standard", BASE, BASE + 7 * DAY, BASE + DAY + 100);
    market.run("market-b", 2, "creator-b", "subject", "standard", BASE, BASE + 7 * DAY, BASE + DAY + 110);
    market.run("market-c", 1, "creator-a", "subject", "standard", BASE, BASE + 7 * DAY, BASE + 2 * DAY + 100);

    const collection = collectF5b2CalibrationMeasurements(db, input(["subject", "guest-a"]));
    expect(internalPack(collection, "subject", "casino-completed-activity-v1").metrics).toMatchObject({
      completedActivityCount: 2,
      completedActivityDistinctFamilies: 2,
      completedActivityDays: 2,
    });
    expect(internalPack(collection, "subject", "casino-activity-v1").metrics).toMatchObject({
      activityCount: 2,
      activityDistinctFamilies: 2,
      activityDays: 2,
    });
    expect(internalPack(collection, "subject", "casino-edition-completion-v1").metrics).toMatchObject({
      distinctCompletedFamilies: 2,
      totalFamilyCompletionDays: 2,
    });
    const hosted = internalPack(collection, "subject", "casino-table-activity-v1").metrics;
    expect(hosted).toMatchObject({ tableCount: 2, guestProfileCount: 2, guestActiveDays: 3, totalTrustedGuestSeconds: 90 });
    const busy = internalPack(collection, "subject", "casino-table-busy-v1").metrics;
    expect(busy).toMatchObject({
      guestProfileCount: 2,
      stayRowCount: 4,
      distinctHostedTableProfilesWithGuests: 2,
      hostedGuestTrustedSeconds: 90,
      busyTableActiveDays: 3,
      busyTableActiveFirstDayOffset: 0,
      busyTableActiveLastDayOffset: 2,
      busyTableActiveSpanDays: 3,
    });
    expect(busy.dailyHostedGuestTrustedSecondsMedian).toBe(10);
    expect(busy.dailyHostedGuestTrustedSecondsMax).toBe(70);
    expect(busy.trustedSecondsPerGuestProfileMedian).toBe(40);
    expect(busy.trustedSecondsPerGuestProfileMax).toBe(50);
    expect(internalPack(collection, "guest-a", "casino-table-activity-v1").metrics.tableCount).toBe(0);
    expect(internalPack(collection, "guest-a", "casino-table-busy-v1").metrics.guestProfileCount).toBe(0);
    expect(internalPack(collection, "subject", "casino-market-activity-v1").metrics).toMatchObject({
      distinctOtherStandardBoards: 2,
      sumDailyDistinctOtherStandardBoards: 3,
      marketActiveDays: 2,
    });
  });

  it("L. invite-rooted reducerはanonymous branch/next-generation/reunion evidenceをnon-empty保持する", () => {
    const db = setupDb();
    const tc = new TcSocialObservations(db);
    db.prepare("INSERT INTO invites (inviter_id,invitee_id,credited_at) VALUES ('subject','branch',?)").run(BASE + 101);
    db.prepare("INSERT INTO events (type,target_id,created_at) VALUES ('ghosted','branch',?)").run(BASE + 100);
    recordMessage(tc, "branch-day1", "branch", BASE + DAY + 100, "branch-activity");
    recordMessage(tc, "other-day1", "other", BASE + DAY + 110, "branch-activity");
    recordMessage(tc, "branch-day2", "branch", BASE + 2 * DAY + 100, "branch-activity-2");
    recordMessage(tc, "other-day2", "other-2", BASE + 2 * DAY + 110, "branch-activity-2");
    db.prepare("INSERT INTO events (type,target_id,created_at) VALUES ('ghosted','child',?)").run(BASE + 3 * DAY + 100);
    db.prepare("INSERT INTO invites (inviter_id,invitee_id,credited_at) VALUES ('branch','child',?)").run(BASE + 3 * DAY + 101);
    recordMessage(tc, "reunion-subject", "subject", BASE + 4 * DAY + 100, "reunion");
    recordMessage(tc, "reunion-branch", "branch", BASE + 4 * DAY + 110, "reunion");

    const collection = collectF5b2CalibrationMeasurements(db, input(["subject"]));
    const rooted = internalPack(collection, "subject", "invite-rooted-v1");
    expect(rooted.metrics).toMatchObject({
      directBranchProfileCount: 1,
      branchActivityDayCount: 3,
      nextGenerationOccurrenceCount: 1,
      reunionDayCount: 1,
    });
    expect(rooted.jointEvidence.kind).toBe("invite-rooted-v1");
    const json = JSON.stringify(rooted.jointEvidence);
    for (const identity of ["subject", "branch", "child", "other-"]) expect(json).not.toContain(identity);
  });

  it("M. event completion No.80/81とcalendar role No.82-84を独立sourceから測定する", () => {
    const db = setupDb();
    let now = BASE + DAY;
    const events = new PublicEvents(db, () => now);
    const record = (input: {
      key: string;
      date: string;
      participants?: string[];
      staff?: string[];
      organizers?: string[];
      primary?: string;
    }) => {
      events.recordFinalizedEvent({
        eventKey: input.key,
        name: input.key,
        eventDate: input.date,
        participantUserIds: input.participants ?? ["other"],
        staffUserIds: input.staff ?? [],
        organizerUserIds: input.organizers ?? [],
        primaryOrganizerUserId: input.primary ?? `primary-${input.key}`,
        recordedBy: "recorder",
      });
      now += 10;
      events.recordCompletedEvent({ eventKey: input.key, completedBy: "completer" });
      now += 10;
    };
    record({ key: "participant-a", date: "2026-08-21", participants: ["subject"] });
    now = BASE + 2 * DAY;
    record({ key: "participant-b", date: "2026-08-22", participants: ["subject"] });
    now = BASE + 3 * DAY;
    record({ key: "staff", date: "2026-08-23", staff: ["subject"] });
    now = BASE + 4 * DAY;
    record({ key: "organizer", date: "2026-08-24", organizers: ["subject"] });
    now = BASE + 5 * DAY;
    record({ key: "primary", date: "2026-08-25", primary: "subject" });
    db.prepare("INSERT INTO public_events VALUES (?,?,?,?,?)")
      .run("legacy", "Legacy", "2026-08-26", "audit-only", BASE + 6 * DAY);
    db.prepare("INSERT INTO public_event_participations VALUES (?,?,?)")
      .run("legacy", "subject", BASE + 6 * DAY);
    db.prepare("INSERT INTO public_event_completions VALUES (?,?,?,?)")
      .run("legacy", BASE + 6 * DAY, "audit-only", BASE + 6 * DAY + 1);

    const snapshot = runF5b2CalibrationSnapshot(db, input(["subject"]));
    expect(metric(snapshot, "public-event-completion-v1", "completedParticipationCount").p50).toBe(3);
    expect(metric(snapshot, "public-event-completion-v1", "completionActiveDays").p50).toBe(3);
    expect(pack(snapshot, "public-event-completion-v1").coverageLimitations.join(" ")).not.toMatch(/legacy|organizer/i);
    expect(metric(snapshot, "public-event-calendar-v1", "totalEventInvolvementCount").p50).toBe(6);
    expect(metric(snapshot, "public-event-calendar-v1", "generalParticipantCount").p50).toBe(3);
    expect(metric(snapshot, "public-event-calendar-v1", "staffCount").p50).toBe(1);
    expect(metric(snapshot, "public-event-calendar-v1", "organizerCount").p50).toBe(2);
    expect(metric(snapshot, "public-event-calendar-v1", "primaryOrganizerCount").p50).toBe(1);
    expect(metric(snapshot, "public-event-calendar-v1", "participantOnlyCount").p50).toBe(3);
    expect(pack(snapshot, "public-event-calendar-v1").coverageLimitations.join(" ")).toMatch(/legacy/i);
  });

  it("N. Castle experience/social reducersはmulti-family/superdomain/day/VC secondsをnon-empty測定する", () => {
    const db = setupDb();
    room(db, "subject", "castle-room", BASE);
    visit(db, "subject", "castle-room", BASE + DAY + 10, BASE + DAY + 70);
    visit(db, "room-guest", "castle-room", BASE + DAY + 20, BASE + DAY + 60);
    economyFact(db, "subject", "economy-peer", "transfer", BASE + 2 * DAY + 10);
    purchase(db, "subject", BASE + 3 * DAY + 10, "castle-product");
    const tc = new TcSocialObservations(db);
    recordMessage(tc, "castle-self", "subject", BASE + 4 * DAY + 100, "castle-tc");
    recordMessage(tc, "castle-other", "other", BASE + 4 * DAY + 110, "castle-tc");
    db.prepare(`INSERT INTO vc_public_social_presence
      (user_id,guild_id,channel_id,started_at,ended_at,end_quality)
      VALUES ('subject','guild','ordinary-vc',?,?, 'observed')`)
      .run(BASE + 5 * DAY + 100, BASE + 5 * DAY + 220);
    let now = BASE + 6 * DAY;
    const events = new PublicEvents(db, () => now);
    events.recordFinalizedEvent({
      eventKey: "castle-event",
      name: "Castle event",
      eventDate: "2026-08-26",
      participantUserIds: ["subject"],
      organizerUserIds: [],
      staffUserIds: [],
      primaryOrganizerUserId: "primary",
      recordedBy: "recorder",
    });
    now += 10;
    events.recordCompletedEvent({ eventKey: "castle-event", completedBy: "completer" });

    const collection = collectF5b2CalibrationMeasurements(db, input(["subject"]));
    expect(internalPack(collection, "subject", "castle-experience-v1").metrics).toMatchObject({
      activeFamilyCount: 6,
      coveredSuperDomainCount: 3,
      castleActiveDays: 6,
      publicVcTrustedSeconds: 120,
    });
    expect(internalPack(collection, "subject", "castle-social-time-v1").metrics).toMatchObject({
      domainSemanticBreadth: 6,
      socialActiveDays: 2,
      socialTcGapSampleCount: 1,
      socialVcTrustedSeconds: 120,
    });
    expect(internalPack(collection, "subject", "castle-social-time-v1").jointEvidence.kind).toBe("domain-social-time-v1");
  });

  it("O. Castle role-context reducerはrole-held/inside/outsideとnull/non-zero ratioを区別する", () => {
    const db = setupDb();
    purchase(db, "subject", BASE + DAY + 10, "inside-product");
    economyFact(db, "subject", "outside-peer", "transfer", BASE + 3 * DAY + 10);
    const temporal = new RoleFamilyTemporal(db);
    const manifest: RoleFamilyManifest = {
      provenance: "explicit_manifest" as const,
      families: [{
        familyKey: "department:shop",
        roleIds: ["role-shop"],
        tags: ["public_department", "shop"],
      }],
    };
    temporal.startObservationSession("main", manifest, [
      { userId: "subject", roleIds: ["role-shop"], bot: false },
      { userId: "zero-role", roleIds: [], bot: false },
    ], BASE);
    temporal.checkpoint("main", BASE + 7 * DAY);

    const collection = collectF5b2CalibrationMeasurements(db, input(["subject", "zero-role"]));
    const classified = internalPack(collection, "subject", "castle-role-context-v1").metrics;
    expect(classified).toMatchObject({
      roleHeldFamilyCount: 2,
      insideActiveFamilyCount: 1,
      outsideActiveFamilyCount: 1,
      insideOccurrenceCount: 1,
      outsideOccurrenceCount: 1,
      totalOccurrenceCount: 2,
      outsideOccurrenceRatio: 0.5,
    });
    const empty = internalPack(collection, "zero-role", "castle-role-context-v1").metrics;
    expect(empty.totalOccurrenceCount).toBe(0);
    expect(empty.outsideOccurrenceRatio).toBeNull();
    expect(empty.outsideSecondsRatio).toBeNull();
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
