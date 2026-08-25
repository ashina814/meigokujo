import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { Takutate } from "../src/casino/takutate.js";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { PublicEvents } from "../src/public-events/service.js";
import {
  loadTrustedEligiblePublicRoleContexts,
} from "../src/role-family/domain-temporal.js";
import { RoleFamilyTemporal, type RoleFamilyManifest } from "../src/role-family/temporal.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import {
  CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST,
  castleRoleDomainManifestSemanticIdentity,
  defineCastleRoleDomainManifest,
} from "../src/titles/v2-castle-role-domain-manifest.js";
import { computeCastleRoleContextSafe } from "../src/titles/v2-castle-role-context.js";
import { computeCastleExperienceSafe } from "../src/titles/v2-castle-experience.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { VcPublicSocialPresence } from "../src/vc/public-social-presence.js";

const DAY = 86_400;
const BASE = Math.floor(new Date("2026-08-24T00:00:00+09:00").getTime() / 1_000);
const END = BASE + 10 * DAY;
let sequence = 0;

const ROLE_SHOP = "role-shop";
const ROLE_ECONOMY = "role-economy";
const ROLE_INN = "role-inn";
const ROLE_CASINO = "role-casino";
const MANIFEST: RoleFamilyManifest = {
  provenance: "explicit_manifest",
  families: [
    { familyKey: "department:shop", roleIds: [ROLE_SHOP], tags: ["public_department", "shop"] },
    { familyKey: "department:economy", roleIds: [ROLE_ECONOMY], tags: ["public_department", "economy"] },
    { familyKey: "department:inn", roleIds: [ROLE_INN], tags: ["public_department", "inn"] },
    { familyKey: "department:casino", roleIds: [ROLE_CASINO], tags: ["public_department", "casino"] },
  ],
};

beforeAll(() => registerDefaultTxTypes());
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  db.exec("DROP INDEX idx_rooms_owner_normal_open; DROP INDEX idx_rooms_owner_special_open");
  db.exec(`CREATE TABLE IF NOT EXISTS casino_market_participation_history (
    participation_key TEXT PRIMARY KEY, market_id INTEGER NOT NULL, market_creator_id TEXT NOT NULL,
    participant_id TEXT NOT NULL, market_mode TEXT NOT NULL, market_created_at INTEGER NOT NULL,
    market_deadline_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL)`);
  let now = BASE;
  const events = new EventLog(db);
  return {
    db,
    temporal: new RoleFamilyTemporal(db),
    ledger: new Ledger(db),
    casino: new CasinoParticipationHistory(db, () => now),
    taku: new Takutate(db, events, () => now),
    tc: new TcSocialObservations(db),
    vc: new VcPublicSocialPresence(db),
    publicEvents: new PublicEvents(db, () => now),
    setNow(value: number) { now = value; vi.setSystemTime(new Date(value * 1_000)); },
  };
}

type Ctx = ReturnType<typeof setup>;

function start(ctx: Ctx, at: number, roleIds: readonly string[], manifest = MANIFEST) {
  ctx.temporal.startObservationSession("main", manifest, [{ userId: "subject", roleIds, bot: false }], at);
}

function payload(ctx: Ctx, observedAt = END) {
  return computeCastleRoleContextSafe(ctx.db, { start: BASE, end: END, observedAt }, ["subject"])[0]!.payload;
}

function family(
  value: ReturnType<typeof payload>,
  side: "insideFamilies" | "outsideFamilies" | "roleHeldFamilies",
  key: string,
) {
  return value[side].find((entry) => entry.familyKey === key);
}

function purchase(ctx: Ctx, at: number, status?: "refunded") {
  const id = ++sequence;
  ctx.db.prepare(`INSERT INTO shop_items
    (id,name,price_land,kind,delivery,enabled,created_at,updated_at)
    VALUES (?, ?, 1, 'one_shot', 'manual', 1, ?, ?)`)
    .run(id, `secret-item-${id}`, BASE, BASE);
  ctx.db.prepare(`INSERT INTO shop_purchases
    (id,item_id,user_id,purchased_at,paid_land,status,auto_renew)
    VALUES (?,?,'subject',?,1,'active',0)`).run(id, id, at);
  ctx.db.prepare(`INSERT INTO shop_purchase_title_provenance
    (purchase_id,user_id,product_key,purchased_at,origin,title_eligible)
    VALUES (?,'subject',?,?,'storefront',1)`).run(id, `secret-product-${id}`, at);
  if (status) ctx.db.prepare("INSERT INTO shop_purchase_status_history VALUES (?, ?, ?)").run(id, status, at + 1);
}

function peer(ctx: Ctx, at: number, type: "transfer" | "tip" = "transfer", actor = "user:subject") {
  ctx.setNow(at - 1);
  ctx.ledger.ensureAccount("user:subject", "user");
  ctx.ledger.ensureAccount("user:other", "user");
  ctx.ledger.transfer({
    from: TREASURY, to: "user:subject", amount: 100, type: "initial", actor: "system:test",
    idempotencyKey: `f4b-fund-${++sequence}`,
  });
  ctx.setNow(at);
  ctx.ledger.transfer({
    from: "user:subject", to: "user:other", amount: 1, type, actor,
    idempotencyKey: `f4b-peer-${++sequence}`,
  });
}

function message(ctx: Ctx, id: string, authorId: string, at: number, surface = "surface-a") {
  ctx.tc.recordMessage({
    messageId: id, authorId, surfaceId: surface, areaId: "area", surfaceKind: "channel",
    replyToMessageId: null, createdAtMs: at * 1_000, observedAtMs: at * 1_000 + 1,
  });
}

function room(ctx: Ctx, ownerId: string, channelId: string, kind: "normal" | "mitsugetsu" = "normal") {
  ctx.db.prepare(`INSERT INTO rooms
    (kind,channel_id,owner_id,capacity,expires_at,activated_at,status,closed_at,created_at,updated_at)
    VALUES (?,?,?,2,NULL,NULL,'closed',?,?,?)`).run(kind, channelId, ownerId, BASE + 100, BASE, BASE + 100);
}

function visit(ctx: Ctx, userId: string, channelId: string, startAt: number, endAt: number) {
  ctx.db.prepare(`INSERT INTO vc_segments
    (user_id,channel_id,parent_id,started_at,ended_at,self_muted,self_deafened,end_quality,start_reason)
    VALUES (?,?,'parent',?,?,0,0,'observed','join')`).run(userId, channelId, startAt, endAt);
}

function market(ctx: Ctx, at: number, options: { creator?: string; mode?: string; deadline?: number } = {}) {
  ctx.db.prepare("INSERT INTO casino_market_participation_history VALUES (?,?,?,?,?,?,?,?)").run(
    `market-${++sequence}`, sequence, options.creator ?? "other", "subject", options.mode ?? "standard",
    BASE, options.deadline ?? END, at,
  );
}

describe("A-G eligible public role and immutable bridge", () => {
  it("A-G require public_department + assignment tag in the same historical family", () => {
    const cases: Array<{ manifest: RoleFamilyManifest; roles: string[]; eligible: boolean }> = [
      { manifest: { provenance: "explicit_manifest", families: [{ familyKey: "x", roleIds: ["r"], tags: ["public_department"] }] }, roles: ["r"], eligible: false },
      { manifest: { provenance: "explicit_manifest", families: [{ familyKey: "x", roleIds: ["r"], tags: ["shop"] }] }, roles: ["r"], eligible: false },
      { manifest: { provenance: "explicit_manifest", families: [{ familyKey: "x", roleIds: ["r"], tags: ["public_department", "shop"] }] }, roles: ["r"], eligible: true },
      { manifest: { provenance: "explicit_manifest", families: [{ familyKey: "商館という名前", roleIds: ["r"], tags: [] }] }, roles: ["r"], eligible: false },
      { manifest: { provenance: "explicit_manifest", families: [{ familyKey: "賭場department", roleIds: ["r"], tags: ["public_department"] }] }, roles: ["r"], eligible: false },
      { manifest: { provenance: "explicit_manifest", families: [{ familyKey: "casino_pvp_notify", roleIds: ["r"], tags: [] }] }, roles: ["r"], eligible: false },
      { manifest: { provenance: "explicit_manifest", families: [
        { familyKey: "public-only", roleIds: ["a"], tags: ["public_department"] },
        { familyKey: "shop-only", roleIds: ["b"], tags: ["shop"] },
      ] }, roles: ["a", "b"], eligible: false },
    ];
    for (const [index, test] of cases.entries()) {
      const ctx = setup();
      start(ctx, BASE, test.roles, test.manifest);
      ctx.temporal.checkpoint("main", BASE + 20);
      const contexts = loadTrustedEligiblePublicRoleContexts(
        ctx.db, ["subject"], CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.assignments, { start: BASE, end: BASE + 20 },
      ).get("subject")!;
      expect(contexts.length > 0, `case ${index}`).toBe(test.eligible);
      if (test.eligible) expect(contexts[0]!.assignedFamilies).toEqual(["shop"]);
    }
    expect(loadTrustedEligiblePublicRoleContexts(
      setup().db, ["subject"], CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.assignments, { start: BASE, end: BASE + 20 },
    ).get("subject")).toEqual([]);
  });

  it("bridge is frozen, validated and order-independent without public_event", () => {
    expect(CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.assignments).toEqual([
      { sourceTag: "casino", targetFamily: "casino" },
      { sourceTag: "economy", targetFamily: "economy" },
      { sourceTag: "inn", targetFamily: "public_room" },
      { sourceTag: "shop", targetFamily: "shop" },
    ]);
    expect(Object.isFrozen(CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST)).toBe(true);
    expect(() => defineCastleRoleDomainManifest({ editionKey: "x", version: 1, assignments: [
      { sourceTag: "shop", targetFamily: "shop" }, { sourceTag: "shop", targetFamily: "shop" },
    ] })).toThrow(/duplicate/);
    expect(() => defineCastleRoleDomainManifest({ editionKey: "x", version: 1, assignments: [
      { sourceTag: "unknown", targetFamily: "shop" },
    ] })).toThrow(/unknown/);
    expect(() => defineCastleRoleDomainManifest({ editionKey: "x", version: 1, assignments: [
      { sourceTag: "shop", targetFamily: "public_event" },
    ] })).toThrow(/non-normal/);
    expect(castleRoleDomainManifestSemanticIdentity({
      ...CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST,
      assignments: [...CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST.assignments].reverse(),
    })).toBe(castleRoleDomainManifestSemanticIdentity(CASTLE_ROLE_DOMAIN_EDITION_I_MANIFEST));
  });
});

describe("H-O exact role temporal truth", () => {
  it("H-L before/inside/after and both same-second boundaries fail closed", () => {
    const ctx = setup();
    purchase(ctx, BASE + 5);
    start(ctx, BASE + 10, [ROLE_SHOP]);
    purchase(ctx, BASE + 10);
    purchase(ctx, BASE + 15);
    ctx.temporal.observeMemberSnapshot("main", { userId: "subject", roleIds: [], bot: false }, BASE + 20);
    purchase(ctx, BASE + 20);
    purchase(ctx, BASE + 25);
    ctx.temporal.checkpoint("main", BASE + 30);
    expect(family(payload(ctx, BASE + 31), "insideFamilies", "shop")!.days[0]!.occurrenceCount).toBe(1);
  });

  it("M-O restart, disconnect and manifest-change gaps remain UNKNOWN", () => {
    for (const mode of ["restart", "disconnect", "manifest"] as const) {
      const ctx = setup();
      start(ctx, BASE, [ROLE_SHOP]);
      ctx.temporal.checkpoint("main", BASE + 10);
      if (mode === "restart") ctx.temporal.recoverDangling("main");
      if (mode === "disconnect") ctx.temporal.suspendGuild("main", BASE + 10, "disconnect");
      if (mode === "manifest") ctx.temporal.invalidateManifest("main", BASE + 10);
      purchase(ctx, BASE + 20);
      start(ctx, BASE + 30, [ROLE_SHOP]);
      ctx.temporal.checkpoint("main", BASE + 40);
      expect(payload(ctx, BASE + 41).roleHeldFamilies, mode).toEqual([]);
    }
  });
});

describe("P-T/AW-AZ assigned union and point chronology", () => {
  it("P-S active role union classifies shop/economy/casino at occurrence time", () => {
    const ctx = setup();
    start(ctx, BASE, [ROLE_SHOP]);
    purchase(ctx, BASE + 10);
    peer(ctx, BASE + 20);
    ctx.temporal.observeMemberSnapshot("main", { userId: "subject", roleIds: [ROLE_SHOP, ROLE_ECONOMY], bot: false }, BASE + 30);
    peer(ctx, BASE + 40, "tip");
    market(ctx, BASE + 50);
    ctx.temporal.checkpoint("main", BASE + 60);
    const value = payload(ctx, BASE + 61);
    expect(value.insideFamilies.map((entry) => entry.familyKey)).toEqual(["economy", "shop"]);
    expect(value.outsideFamilies.map((entry) => entry.familyKey)).toEqual(["economy", "casino"]);
    expect(value.roleHeldFamilies.map((entry) => entry.familyKey)).toEqual(["economy", "shop", "casino"]);
  });

  it("T/AZ role ending changes later classification and preserves inside+outside on one day", () => {
    const ctx = setup();
    start(ctx, BASE, [ROLE_SHOP, ROLE_ECONOMY]);
    peer(ctx, BASE + 10);
    ctx.temporal.observeMemberSnapshot("main", { userId: "subject", roleIds: [ROLE_SHOP], bot: false }, BASE + 20);
    peer(ctx, BASE + 30);
    ctx.temporal.checkpoint("main", BASE + 40);
    const value = payload(ctx, BASE + 41);
    expect(family(value, "insideFamilies", "economy")!.days).toHaveLength(1);
    expect(family(value, "outsideFamilies", "economy")!.days).toHaveLength(1);
  });

  it("No.91 remains threshold-neutral for repeated days in one outside family", () => {
    const ctx = setup();
    start(ctx, BASE, [ROLE_SHOP]);
    peer(ctx, BASE + 10);
    peer(ctx, BASE + DAY + 10, "tip");
    ctx.temporal.checkpoint("main", BASE + DAY + 20);
    const value = payload(ctx, BASE + DAY + 21);
    expect(family(value, "outsideFamilies", "economy")!.days.map((day) => day.date))
      .toEqual(["2026-08-24", "2026-08-25"]);
    expect(value.outsideDays).toEqual(["2026-08-24", "2026-08-25"]);
  });
});

describe("U-Z/AW-AY interval classification and ownership", () => {
  it("U-W/AW role overlap retains only exact ordinary public VC slices", () => {
    const ctx = setup();
    ctx.vc.reconcileChannel({ guildId: "main", channelId: "ordinary", eligible: true, humanUserIds: ["subject", "other"], observedAt: BASE + 10 });
    start(ctx, BASE + 20, [ROLE_SHOP]);
    ctx.vc.reconcileChannel({ guildId: "main", channelId: "ordinary", eligible: false, humanUserIds: [], observedAt: BASE + 40 });
    ctx.temporal.checkpoint("main", BASE + 50);
    expect(family(payload(ctx, BASE + 51), "outsideFamilies", "public_vc")!.days[0]!.trustedSeconds).toBe(19);
  });

  it("X-Z room/table own same-channel VC while different-channel simultaneous evidence remains", () => {
    const roomCase = setup();
    start(roomCase, BASE, [ROLE_SHOP]); roomCase.temporal.checkpoint("main", BASE + 60);
    room(roomCase, "owner", "room-vc"); visit(roomCase, "subject", "room-vc", BASE + 10, BASE + 40);
    roomCase.vc.reconcileChannel({ guildId: "main", channelId: "room-vc", eligible: true, humanUserIds: ["subject", "other"], observedAt: BASE + 10 });
    roomCase.vc.reconcileChannel({ guildId: "main", channelId: "room-vc", eligible: false, humanUserIds: [], observedAt: BASE + 40 });
    expect(payload(roomCase, BASE + 61).outsideFamilies.map((entry) => entry.familyKey)).toEqual(["public_room"]);

    const tableCase = setup();
    start(tableCase, BASE, [ROLE_SHOP]); tableCase.temporal.checkpoint("main", BASE + 60);
    tableCase.taku.track("table", "main", "owner", "sashi");
    tableCase.taku.observeGuestTransition({ userId: "subject", isBot: false, oldChannelId: null, newChannelId: "table", observedAt: BASE + 10 });
    tableCase.taku.observeGuestTransition({ userId: "subject", isBot: false, oldChannelId: "table", newChannelId: null, observedAt: BASE + 40 });
    tableCase.vc.reconcileChannel({ guildId: "main", channelId: "table", eligible: true, humanUserIds: ["subject", "other"], observedAt: BASE + 10 });
    tableCase.vc.reconcileChannel({ guildId: "main", channelId: "table", eligible: false, humanUserIds: [], observedAt: BASE + 40 });
    expect(payload(tableCase, BASE + 61).outsideFamilies.map((entry) => entry.familyKey)).toEqual(["casino"]);
    tableCase.vc.reconcileChannel({ guildId: "main", channelId: "different", eligible: true, humanUserIds: ["subject", "other"], observedAt: BASE + 10 });
    tableCase.vc.reconcileChannel({ guildId: "main", channelId: "different", eligible: false, humanUserIds: [], observedAt: BASE + 40 });
    expect(payload(tableCase, BASE + 61).outsideFamilies.map((entry) => entry.familyKey)).toEqual(["public_vc", "casino"]);
  });

  it("AX/AY assignment union changes inside/outside during an interval", () => {
    const ctx = setup();
    start(ctx, BASE, [ROLE_SHOP]);
    room(ctx, "owner", "room"); visit(ctx, "subject", "room", BASE + 10, BASE + 50);
    ctx.temporal.observeMemberSnapshot("main", { userId: "subject", roleIds: [ROLE_SHOP, ROLE_INN], bot: false }, BASE + 30);
    ctx.temporal.checkpoint("main", BASE + 60);
    const value = payload(ctx, BASE + 61);
    expect(family(value, "outsideFamilies", "public_room")!.days[0]!.trustedSeconds).toBe(21);
    expect(family(value, "insideFamilies", "public_room")!.days[0]!.trustedSeconds).toBe(19);
  });
});

describe("AA-AO subject-active TC/room/economy/shop", () => {
  it("AA-AD exact same-surface exchange inside role counts; outside/isolated and identity do not", () => {
    const ctx = setup();
    start(ctx, BASE + 20, [ROLE_SHOP]);
    message(ctx, "before-subject", "subject", BASE + 10); message(ctx, "before-other", "other", BASE + 11);
    message(ctx, "inside-subject", "subject", BASE + 30); message(ctx, "inside-other", "other", BASE + 31);
    message(ctx, "isolated", "subject", BASE + 40, "isolated-surface");
    ctx.temporal.checkpoint("main", BASE + 50);
    const value = payload(ctx, BASE + 51);
    expect(family(value, "outsideFamilies", "public_tc")!.days[0]!.occurrenceCount).toBe(1);
    expect(JSON.stringify(value)).not.toMatch(/inside-subject|surface|role-shop|department/);
  });

  it("AE-AI only subject visitor/own-use interval counts; passive owner/private room do not", () => {
    const ctx = setup();
    start(ctx, BASE, [ROLE_INN]); ctx.temporal.checkpoint("main", BASE + 80);
    room(ctx, "other", "guest-room"); visit(ctx, "subject", "guest-room", BASE + 10, BASE + 20);
    room(ctx, "subject", "own-room"); visit(ctx, "subject", "own-room", BASE + 30, BASE + 40);
    room(ctx, "subject", "passive"); visit(ctx, "guest", "passive", BASE + 50, BASE + 60);
    room(ctx, "other", "private", "mitsugetsu"); visit(ctx, "subject", "private", BASE + 60, BASE + 70);
    expect(family(payload(ctx, BASE + 81), "insideFamilies", "public_room")!.days[0]!.trustedSeconds).toBe(20);
  });

  it("AJ-AO peer transfer/tip and storefront purchase use exact occurrence, classifier, refund snapshot", () => {
    const ctx = setup();
    start(ctx, BASE + 20, [ROLE_SHOP]);
    peer(ctx, BASE + 10); peer(ctx, BASE + 30, "tip");
    expect(() => peer(ctx, BASE + 31, "tip", "system:admin")).not.toThrow();
    purchase(ctx, BASE + 10); purchase(ctx, BASE + 40);
    ctx.temporal.checkpoint("main", BASE + 50);
    const value = payload(ctx, BASE + 51);
    expect(family(value, "outsideFamilies", "economy")!.days[0]!.occurrenceCount).toBe(1);
    expect(family(value, "insideFamilies", "shop")!.days[0]!.occurrenceCount).toBe(1);

    const refunded = setup(); start(refunded, BASE, [ROLE_SHOP]); purchase(refunded, BASE + 10, "refunded");
    refunded.temporal.checkpoint("main", BASE + 20);
    expect(payload(refunded, BASE + 21).roleHeldFamilies).toEqual([]);
  });
});

describe("AP-BD casino, event exclusion, privacy and bulk", () => {
  it("AP-AV core completion/table/standard market classify; failed/self/event do not", () => {
    const ctx = setup();
    start(ctx, BASE, [ROLE_CASINO]);
    ctx.setNow(BASE + 10);
    ctx.casino.recordCommittedParticipation({ participationKey: "done", activityKey: "slots", participantUserIds: ["subject"] });
    ctx.casino.recordCompletedParticipation({ participationKey: "done", activityKey: "slots", participantUserIds: ["subject"] });
    ctx.casino.recordCommittedParticipation({ participationKey: "failed", activityKey: "slots", participantUserIds: ["subject"] });
    ctx.taku.track("table", "main", "owner", "sashi");
    ctx.taku.observeGuestTransition({ userId: "subject", isBot: false, oldChannelId: null, newChannelId: "table", observedAt: BASE + 20 });
    ctx.taku.observeGuestTransition({ userId: "subject", isBot: false, oldChannelId: "table", newChannelId: null, observedAt: BASE + 30 });
    market(ctx, BASE + 40); market(ctx, BASE + 41, { creator: "subject" }); market(ctx, BASE + 42, { mode: "event" });
    ctx.temporal.checkpoint("main", BASE + 50);
    const casino = family(payload(ctx, BASE + 51), "insideFamilies", "casino")!;
    expect(casino.days[0]!.occurrenceCount).toBe(2);
    expect(casino.days[0]!.trustedSeconds).toBe(10);
  });

  it("BA-BD public_event remains F4a-only; event date/completion never becomes role activity", () => {
    const ctx = setup();
    start(ctx, BASE, [ROLE_SHOP]); ctx.temporal.checkpoint("main", BASE + 300);
    ctx.setNow(BASE + 100);
    ctx.publicEvents.recordFinalizedEvent({
      eventKey: "event", name: "secret", eventDate: "2026-08-24", participantUserIds: ["subject"],
      organizerUserIds: [], staffUserIds: [], primaryOrganizerUserId: "primary", recordedBy: "recorder",
    });
    ctx.setNow(BASE + 200); ctx.publicEvents.recordCompletedEvent({ eventKey: "event", completedBy: "staff" });
    expect(computeCastleExperienceSafe(ctx.db, { start: BASE, end: END, observedAt: BASE + 301 }, ["subject"])[0]!
      .payload.families.map((entry) => entry.familyKey)).toContain("public_event");
    expect(payload(ctx, BASE + 301).roleHeldFamilies).toEqual([]);
  });

  it("safe source hides identities, fixes snapshot, chunks 601 as 300/300/1, and single equals prefetched", () => {
    const ctx = setup();
    expect(TITLE_SOURCES.castle_role_context_safe).toMatchObject({ origin: "derived", privacy: "safe", titleUsable: true });
    const json = JSON.stringify(payload(ctx));
    expect(json).not.toMatch(/userId|roleFamily|channelId|manifestRevision|guildId|occurredAt|purchasedAt|marketId/);
    let now = BASE - DAY;
    const store = new TitleV2Store(ctx.db, () => now);
    store.applyCatalog({ catalogKey: "test", actor: "test" }); now = END;
    const rule = defineTitleRule({
      kind: "behavior", key: "v2.test.castle-role", name: "test", description: "test", catalog: "test", emoji: "x",
      hidden: false, publicAnnounce: false, themeKey: "t", groupKey: "g", collectionDomainKey: "d",
      scope: { type: "global" }, sources: ["castle_role_context_safe"], triggers: ["vc_activity"], lifecycle: "active",
    }, { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) });
    const scope = resolveTitleScope(store, rule.definition, END);
    const users = Array.from({ length: 601 }, (_, index) => `user-${index}`);
    const cache = new TitleSourceCache();
    expect(cache.prefetch(ctx.db, "castle_role_context_safe", users, scope)).toEqual({ loaded: 601, readCalls: 27 });
    expect(cache.get(ctx.db, "castle_role_context_safe", users[0]!, scope))
      .toEqual(readTitleSource(ctx.db, "castle_role_context_safe", users[0]!, scope));
    expect(Object.isFrozen(cache.get(ctx.db, "castle_role_context_safe", users[0]!, scope))).toBe(true);
  });
});
