import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { Takutate } from "../src/casino/takutate.js";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { PublicEvents } from "../src/public-events/service.js";
import { Shop } from "../src/shop/service.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import {
  CASTLE_EXPERIENCE_EDITION_I_MANIFEST,
  castleExperienceManifestSemanticIdentity,
  defineCastleExperienceManifest,
} from "../src/titles/v2-castle-experience-manifest.js";
import { computeCastleExperienceSafe } from "../src/titles/v2-castle-experience.js";
import {
  computeCasinoTableParticipationDaysSafe,
  computeCasinoTableParticipationEvidence,
} from "../src/titles/v2-casino-edition-table-market.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { VcPublicSocialPresence } from "../src/vc/public-social-presence.js";

const DAY = 86_400;
const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1_000);
const END = BASE + 20 * DAY;
let sequence = 0;

beforeAll(() => registerDefaultTxTypes());
afterEach(() => vi.useRealTimers());

type Db = ReturnType<typeof openDb>;
type FamilyKey = (typeof CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families)[number]["familyKey"];

function setup() {
  const db = openDb(":memory:");
  db.exec("DROP INDEX idx_rooms_owner_normal_open; DROP INDEX idx_rooms_owner_special_open");
  let now = BASE;
  const events = new EventLog(db);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, events);
  const publicEvents = new PublicEvents(db, () => now);
  const casino = new CasinoParticipationHistory(db, () => now);
  const taku = new Takutate(db, events, () => now);
  const tc = new TcSocialObservations(db);
  const vc = new VcPublicSocialPresence(db);
  db.exec(`CREATE TABLE IF NOT EXISTS casino_market_participation_history (
    participation_key TEXT PRIMARY KEY, market_id INTEGER NOT NULL, market_creator_id TEXT NOT NULL,
    participant_id TEXT NOT NULL, market_mode TEXT NOT NULL, market_created_at INTEGER NOT NULL,
    market_deadline_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL)`);
  return {
    db, ledger, shop, publicEvents, casino, taku, tc, vc,
    setNow(value: number) { now = value; vi.setSystemTime(new Date(value * 1_000)); },
  };
}

function castle(db: Db, userId = "subject", observedAt = END) {
  return computeCastleExperienceSafe(db, { start: BASE, end: END, observedAt }, [userId])[0]!.payload;
}

function family(payload: ReturnType<typeof castle>, key: FamilyKey) {
  return payload.families.find((entry) => entry.familyKey === key);
}

function keys(payload: ReturnType<typeof castle>) {
  return payload.families.map((entry) => entry.familyKey);
}

function fund(context: ReturnType<typeof setup>, userId: string, at: number) {
  context.setNow(at);
  context.ledger.ensureAccount(`user:${userId}`, "user");
  context.ledger.transfer({
    from: TREASURY, to: `user:${userId}`, amount: 100_000, type: "initial", actor: "system:test",
    idempotencyKey: `castle:fund:${userId}:${++sequence}`,
  });
}

function peer(context: ReturnType<typeof setup>, type: "transfer" | "tip", at: number) {
  fund(context, "subject", at - 1);
  context.ledger.ensureAccount("user:other", "user");
  context.setNow(at);
  return context.ledger.transfer({
    from: "user:subject", to: "user:other", amount: 100, type, actor: "user:subject",
    idempotencyKey: `castle:peer:${++sequence}`,
  });
}

function buy(context: ReturnType<typeof setup>, at: number) {
  context.setNow(BASE);
  const item = context.shop.createItem({
    name: `normal-${++sequence}`, price_land: 1_000, price_alt_kind: null, price_alt_amount: null,
    kind: "one_shot", delivery: "manual",
  }, "staff");
  fund(context, "subject", at - 1);
  context.setNow(at);
  return context.shop.purchase({
    itemId: item.id, userId: "subject", actor: "user:subject", memberRoleIds: [], payAlt: false,
    idempotencyKey: `castle:shop:${++sequence}`,
  });
}

function message(context: ReturnType<typeof setup>, id: string, authorId: string, at: number) {
  context.tc.recordMessage({
    messageId: id, authorId, surfaceId: "secret-surface", areaId: "secret-area", surfaceKind: "channel",
    replyToMessageId: null, createdAtMs: at * 1_000, observedAtMs: at * 1_000 + 1,
  });
}

function room(db: Db, ownerId: string, channelId: string, kind: "normal" | "game" | "mitsugetsu" | "oborozuki") {
  db.prepare(`INSERT INTO rooms
    (kind, channel_id, owner_id, capacity, expires_at, activated_at, status, closed_at, created_at, updated_at)
    VALUES (?, ?, ?, 2, NULL, NULL, 'closed', ?, ?, ?)`)
    .run(kind, channelId, ownerId, BASE + 1000, BASE, BASE + 1000);
}

function visit(db: Db, userId: string, channelId: string, start: number, end: number) {
  db.prepare(`INSERT INTO vc_segments
    (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
    VALUES (?, ?, 'secret-parent', ?, ?, 0, 0, 'observed', 'join')`)
    .run(userId, channelId, start, end);
}

function market(db: Db, key: string, input: {
  user?: string; creator?: string; mode?: string; at?: number; createdAt?: number; deadlineAt?: number;
} = {}) {
  db.prepare("INSERT INTO casino_market_participation_history VALUES (?,?,?,?,?,?,?,?)").run(
    key, ++sequence, input.creator ?? "other", input.user ?? "subject", input.mode ?? "standard",
    input.createdAt ?? BASE, input.deadlineAt ?? BASE + DAY, input.at ?? BASE + 100,
  );
}

function event(context: ReturnType<typeof setup>, input: {
  key: string; participants?: readonly string[]; staff?: readonly string[]; complete?: boolean;
  recordedBy?: string; completedBy?: string;
}) {
  context.setNow(BASE + 100);
  context.publicEvents.recordFinalizedEvent({
    eventKey: input.key, name: "secret event", eventDate: "2026-08-20",
    participantUserIds: input.participants ?? [], organizerUserIds: [], staffUserIds: input.staff ?? [],
    primaryOrganizerUserId: "primary", recordedBy: input.recordedBy ?? "recorder",
  });
  if (input.complete !== false) {
    context.setNow(BASE + 200);
    context.publicEvents.recordCompletedEvent({ eventKey: input.key, completedBy: input.completedBy ?? "completer" });
  }
}

describe("A-J immutable Castle Experience Edition-I manifest", () => {
  it("A-G: exact seven-family taxonomy and super-domain membership never auto-expand", () => {
    expect(CASTLE_EXPERIENCE_EDITION_I_MANIFEST).toMatchObject({ editionKey: "castle-experience-edition-i", version: 1 });
    expect(CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families).toEqual([
      { familyKey: "casino", superDomain: "economy_play" },
      { familyKey: "economy", superDomain: "economy_play" },
      { familyKey: "public_event", superDomain: "castle_wide" },
      { familyKey: "public_room", superDomain: "social" },
      { familyKey: "public_tc", superDomain: "social" },
      { familyKey: "public_vc", superDomain: "social" },
      { familyKey: "shop", superDomain: "economy_play" },
    ]);
    expect(CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families.map((entry) => entry.familyKey))
      .not.toEqual(expect.arrayContaining(["invite", "role", "rank", "class", "evaluation", "future_source"]));
    expect(Object.isFrozen(CASTLE_EXPERIENCE_EDITION_I_MANIFEST)).toBe(true);
    expect(Object.isFrozen(CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families)).toBe(true);
  });

  it("H-J: duplicate/unknown/version corruption reject and order has stable semantic identity", () => {
    expect(() => defineCastleExperienceManifest({
      editionKey: "x", version: 1,
      families: [{ familyKey: "same", superDomain: "social" }, { familyKey: "same", superDomain: "economy_play" }],
    })).toThrow(/duplicate/);
    expect(() => defineCastleExperienceManifest({
      editionKey: "x", version: 1, families: [{ familyKey: "x", superDomain: "unknown" }],
    })).toThrow(/unknown/);
    expect(() => defineCastleExperienceManifest({
      editionKey: "x", version: 0, families: [{ familyKey: "x", superDomain: "social" }],
    })).toThrow(/version/);
    const reversed = defineCastleExperienceManifest({
      ...CASTLE_EXPERIENCE_EDITION_I_MANIFEST,
      families: [...CASTLE_EXPERIENCE_EDITION_I_MANIFEST.families].reverse(),
    });
    expect(castleExperienceManifestSemanticIdentity(reversed))
      .toBe(castleExperienceManifestSemanticIdentity(CASTLE_EXPERIENCE_EDITION_I_MANIFEST));
  });
});

describe("K-U meaningful public social families", () => {
  it("K-Q: only positive trusted public human social VC counts", () => {
    const context = setup();
    context.vc.reconcileChannel({ guildId: "main", channelId: "public", eligible: true, humanUserIds: ["subject", "human"], observedAt: BASE + 10 });
    context.vc.reconcileChannel({ guildId: "main", channelId: "public", eligible: false, humanUserIds: [], observedAt: BASE + 40 });
    for (const channelId of ["private", "role-gated", "other-guild"] as const) {
      context.vc.reconcileChannel({ guildId: channelId === "other-guild" ? "other" : "main", channelId, eligible: false, humanUserIds: ["subject", "human"], observedAt: BASE + 50 });
    }
    context.vc.reconcileChannel({ guildId: "main", channelId: "bot-only", eligible: true, humanUserIds: ["subject"], observedAt: BASE + 60 });
    context.vc.reconcileChannel({ guildId: "main", channelId: "recovered", eligible: true, humanUserIds: ["subject", "human"], observedAt: BASE + 70 });
    context.vc.recoverDangling(BASE + 100);
    expect(family(castle(context.db), "public_vc")).toEqual({
      familyKey: "public_vc", days: ["2026-08-20"], dailyTrustedSeconds: [{ date: "2026-08-20", trustedSeconds: 30 }],
    });
  });

  it("R-U: same-surface human exchange counts; isolated/bot-filtered input and content do not", () => {
    const human = setup();
    message(human, "subject-message", "subject", BASE + 10);
    message(human, "human-message", "other", BASE + 20);
    expect(keys(castle(human.db))).toEqual(["public_tc"]);
    expect(JSON.stringify(castle(human.db))).not.toMatch(/secret-surface|secret-area|subject-message|raw content/);

    const isolated = setup();
    message(isolated, "isolated", "subject", BASE + 10);
    // Bot messages never enter this human-only canonical writer at the Bot trust boundary.
    expect(keys(castle(isolated.db))).toEqual([]);
  });
});

describe("V-AE room, economy and shop ownership", () => {
  it("V-Y: normal/game actual host or guest use is one public_room family; private/create-only is zero", () => {
    const context = setup();
    room(context.db, "subject", "normal", "normal"); visit(context.db, "guest", "normal", BASE + 10, BASE + 20);
    room(context.db, "owner", "game", "game"); visit(context.db, "subject", "game", BASE + 30, BASE + 40);
    room(context.db, "subject", "private-a", "mitsugetsu"); visit(context.db, "guest", "private-a", BASE + 50, BASE + 60);
    room(context.db, "subject", "private-b", "oborozuki"); visit(context.db, "guest", "private-b", BASE + 70, BASE + 80);
    room(context.db, "subject", "create-only", "normal");
    expect(keys(castle(context.db))).toEqual(["public_room"]);
  });

  it("Z-AC/AE: subject peer transfer/tip is economy; eligible storefront is shop only", () => {
    const context = setup();
    peer(context, "transfer", BASE + 10);
    peer(context, "tip", BASE + 20);
    buy(context, BASE + 30);
    expect(keys(castle(context.db))).toEqual(["economy", "shop"]);
    expect(family(castle(context.db), "economy")!.days).toEqual(["2026-08-20"]);
    expect(family(castle(context.db), "shop")!.days).toEqual(["2026-08-20"]);

    const ineligible = setup();
    ineligible.db.prepare(`INSERT INTO shop_items
      (id,name,price_land,kind,delivery,enabled,created_at,updated_at)
      VALUES (999,'special',1,'one_shot','manual',1,?,?)`).run(BASE, BASE);
    ineligible.db.prepare(`INSERT INTO shop_purchases
      (id,item_id,user_id,purchased_at,paid_land,status,auto_renew)
      VALUES (999,999,'subject',?,1,'active',0)`).run(BASE + 10);
    ineligible.db.prepare(`INSERT INTO shop_purchase_title_provenance
      (purchase_id,user_id,product_key,purchased_at,origin,title_eligible)
      VALUES (999,'subject','secret-product',?,'reevaluation',0)`).run(BASE + 10);
    expect(keys(castle(ineligible.db))).toEqual([]);
  });

  it("AD: reversal/refund obey the same fixed snapshot and unrelated system movement is zero", () => {
    const context = setup();
    const tx = peer(context, "transfer", BASE + 10);
    const purchase = buy(context, BASE + 20);
    context.setNow(BASE + 100);
    context.ledger.reverse(tx.tx.id, "staff", "test reversal");
    context.shop.refund(purchase.purchase.id, "test", "staff");
    context.ledger.ensureAccount("user:system-target", "user");
    context.ledger.transfer({
      from: "user:subject", to: "user:system-target", amount: 1, type: "tip", actor: "system:admin",
      idempotencyKey: `castle:admin-tip:${++sequence}`,
    });
    expect(keys(castle(context.db, "subject", BASE + 50))).toEqual(["economy", "shop"]);
    expect(keys(castle(context.db, "subject", BASE + 101))).toEqual([]);
    expect(keys(castle(context.db, "nobody"))).toEqual([]);
  });
});

describe("AF-AM casino OR adapter is one castle family", () => {
  it("AF-AI/AM: completed core, actual official table and valid other standard market collapse to casino once", () => {
    const context = setup();
    context.setNow(BASE + 10);
    context.casino.recordCommittedParticipation({ participationKey: "core", activityKey: "slots", participantUserIds: ["subject"] });
    context.casino.recordCompletedParticipation({ participationKey: "core", activityKey: "slots", participantUserIds: ["subject"] });
    context.taku.track("table", "guild", "owner", "sashi");
    context.taku.observeGuestTransition({ userId: "subject", isBot: false, oldChannelId: null, newChannelId: "table", observedAt: BASE + 20 });
    context.taku.observeGuestTransition({ userId: "subject", isBot: false, oldChannelId: "table", newChannelId: null, observedAt: BASE + 40 });
    market(context.db, "market");
    expect(keys(castle(context.db))).toEqual(["casino"]);
    expect(family(castle(context.db), "casino")!.days).toEqual(["2026-08-20"]);
  });

  it("AJ-AL: commitment-only, table creation, self/event/invalid market do not count", () => {
    const context = setup();
    context.setNow(BASE + 10);
    context.casino.recordCommittedParticipation({ participationKey: "failed", activityKey: "slots", participantUserIds: ["subject"] });
    context.taku.track("empty-table", "guild", "subject", "sashi");
    market(context.db, "self", { creator: "subject" });
    market(context.db, "event", { mode: "event" });
    market(context.db, "late", { at: BASE + 2 * DAY });
    expect(keys(castle(context.db, "subject", BASE + DAY))).toEqual([]);
  });
});

describe("AN-AR completed general-participant event", () => {
  it("AN-AQ: completed participant counts; uncompleted/staff/audit actors do not", () => {
    const context = setup();
    event(context, { key: "good", participants: ["subject"] });
    event(context, { key: "open", participants: ["open-user"], complete: false });
    event(context, { key: "staff", participants: ["other"], staff: ["staff-user"] });
    event(context, { key: "audit", participants: ["other"], recordedBy: "audit-user", completedBy: "audit-user" });
    expect(keys(castle(context.db, "subject"))).toEqual(["public_event"]);
    expect(keys(castle(context.db, "open-user"))).toEqual([]);
    expect(keys(castle(context.db, "staff-user"))).toEqual([]);
    expect(keys(castle(context.db, "audit-user"))).toEqual([]);

    const late = setup();
    late.setNow(BASE + 100);
    late.publicEvents.recordFinalizedEvent({
      eventKey: "late", name: "late", eventDate: "2026-08-20", participantUserIds: ["subject"],
      organizerUserIds: [], staffUserIds: [], primaryOrganizerUserId: "primary", recordedBy: "recorder",
    });
    late.setNow(BASE + 200);
    late.publicEvents.recordCompletedEvent({ eventKey: "late", completedBy: "completer" });
    expect(keys(castle(late.db, "subject", BASE + 150))).toEqual([]);
    expect(keys(castle(late.db, "subject", BASE + 201))).toEqual(["public_event"]);
  });

  it("AR: legacy canonical completed participant remains eligible", () => {
    const context = setup();
    context.db.prepare("INSERT INTO public_events VALUES (?, ?, ?, ?, ?)").run("legacy", "secret", "2026-08-20", "recorder", BASE + 10);
    context.db.prepare("INSERT INTO public_event_participations VALUES (?, ?, ?)").run("legacy", "subject", BASE + 10);
    context.db.prepare("INSERT INTO public_event_completions VALUES (?, ?, ?, ?)").run("legacy", BASE + 10, "completer", BASE + 20);
    expect(keys(castle(context.db))).toEqual(["public_event"]);
  });
});

describe("AS-AV cross-family semantics and safe source contract", () => {
  it("AS/AT/AU: same-day TC+shop is breadth 2 while all casino adapters and shop remain single-owned", () => {
    const context = setup();
    message(context, "s", "subject", BASE + 10); message(context, "o", "other", BASE + 20);
    buy(context, BASE + 30);
    expect(keys(castle(context.db))).toEqual(["public_tc", "shop"]);
    expect(castle(context.db).coveredSuperDomains).toEqual(["social", "economy_play"]);

    // A corrupt casino occurrence fails that family closed without erasing the valid shop family.
    market(context.db, "corrupt-market", { createdAt: BASE + 100, at: BASE + 50 });
    expect(keys(castle(context.db))).toEqual(["public_tc", "shop"]);
  });

  it("AV: exact public-room visitor overlap belongs to public_room; unrelated public VC remains public_vc", () => {
    const context = setup();
    room(context.db, "owner", "room-vc", "normal");
    visit(context.db, "subject", "room-vc", BASE + 10, BASE + 40);
    context.vc.reconcileChannel({ guildId: "main", channelId: "room-vc", eligible: true, humanUserIds: ["subject", "human"], observedAt: BASE + 10 });
    context.vc.reconcileChannel({ guildId: "main", channelId: "room-vc", eligible: false, humanUserIds: [], observedAt: BASE + 40 });
    expect(keys(castle(context.db))).toEqual(["public_room"]);
    context.vc.reconcileChannel({ guildId: "main", channelId: "ordinary-vc", eligible: true, humanUserIds: ["subject", "human"], observedAt: BASE + 50 });
    context.vc.reconcileChannel({ guildId: "main", channelId: "ordinary-vc", eligible: false, humanUserIds: [], observedAt: BASE + 70 });
    expect(keys(castle(context.db))).toEqual(["public_room", "public_vc"]);
    expect(family(castle(context.db), "public_vc")!.dailyTrustedSeconds[0]!.trustedSeconds).toBe(20);

    const crossChannel = setup();
    room(crossChannel.db, "owner", "room-a", "normal");
    visit(crossChannel.db, "subject", "room-a", BASE + 10, BASE + 40);
    crossChannel.vc.reconcileChannel({
      guildId: "main", channelId: "ordinary-b", eligible: true,
      humanUserIds: ["subject", "human"], observedAt: BASE + 10,
    });
    crossChannel.vc.reconcileChannel({
      guildId: "main", channelId: "ordinary-b", eligible: false,
      humanUserIds: [], observedAt: BASE + 40,
    });
    expect(keys(castle(crossChannel.db))).toEqual(["public_room", "public_vc"]);
  });

  it("official table guest overlap belongs to casino; only same-channel public VC seconds are removed", () => {
    const sameChannel = setup();
    sameChannel.taku.track("secret-official-table", "main", "owner", "sashi");
    sameChannel.taku.observeGuestTransition({
      userId: "subject", isBot: false, oldChannelId: null,
      newChannelId: "secret-official-table", observedAt: BASE + 10,
    });
    sameChannel.taku.observeGuestTransition({
      userId: "subject", isBot: false, oldChannelId: "secret-official-table",
      newChannelId: null, observedAt: BASE + 40,
    });
    sameChannel.vc.reconcileChannel({
      guildId: "main", channelId: "secret-official-table", eligible: true,
      humanUserIds: ["subject", "human"], observedAt: BASE + 10,
    });
    sameChannel.vc.reconcileChannel({
      guildId: "main", channelId: "secret-official-table", eligible: false,
      humanUserIds: [], observedAt: BASE + 40,
    });
    expect(keys(castle(sameChannel.db))).toEqual(["casino"]);

    sameChannel.vc.reconcileChannel({
      guildId: "main", channelId: "ordinary-public-vc", eligible: true,
      humanUserIds: ["subject", "human"], observedAt: BASE + 50,
    });
    sameChannel.vc.reconcileChannel({
      guildId: "main", channelId: "ordinary-public-vc", eligible: false,
      humanUserIds: [], observedAt: BASE + 70,
    });
    expect(keys(castle(sameChannel.db))).toEqual(["casino", "public_vc"]);
    expect(family(castle(sameChannel.db), "public_vc")!.dailyTrustedSeconds)
      .toEqual([{ date: "2026-08-20", trustedSeconds: 20 }]);

    const evidence = computeCasinoTableParticipationEvidence(
      sameChannel.db, { start: BASE, end: END }, ["subject"],
    ).get("subject")!;
    const safe = computeCasinoTableParticipationDaysSafe(
      sameChannel.db, { start: BASE, end: END }, ["subject"],
    ).get("subject")!;
    expect(safe).toEqual({ days: evidence.days });
    expect(JSON.stringify(safe)).not.toMatch(/secret-official-table|channelId|startedAt|endedAt/);
    expect(JSON.stringify(castle(sameChannel.db))).not.toMatch(/secret-official-table|ordinary-public-vc/);

    const differentChannel = setup();
    differentChannel.taku.track("official-a", "main", "owner", "sashi");
    differentChannel.taku.observeGuestTransition({
      userId: "subject", isBot: false, oldChannelId: null, newChannelId: "official-a", observedAt: BASE + 10,
    });
    differentChannel.taku.observeGuestTransition({
      userId: "subject", isBot: false, oldChannelId: "official-a", newChannelId: null, observedAt: BASE + 40,
    });
    differentChannel.vc.reconcileChannel({
      guildId: "main", channelId: "ordinary-b", eligible: true,
      humanUserIds: ["subject", "human"], observedAt: BASE + 10,
    });
    differentChannel.vc.reconcileChannel({
      guildId: "main", channelId: "ordinary-b", eligible: false,
      humanUserIds: [], observedAt: BASE + 40,
    });
    expect(keys(castle(differentChannel.db))).toEqual(["casino", "public_vc"]);
    expect(family(castle(differentChannel.db), "public_vc")!.dailyTrustedSeconds)
      .toEqual([{ date: "2026-08-20", trustedSeconds: 30 }]);
  });

  it("registers a privacy-safe derived contract and 300/300/1 cache chunks with explicit adapter readCalls", () => {
    const context = setup();
    expect(TITLE_SOURCES.castle_experience_safe).toMatchObject({ origin: "derived", privacy: "safe", titleUsable: true });
    expect(TITLE_SOURCES.castle_experience_safe.derivedFrom).not.toContain("stocks");
    const json = JSON.stringify(castle(context.db, "secret-user"));
    expect(json).not.toContain("secret-user");

    let now = BASE - DAY;
    const store = new TitleV2Store(context.db, () => now);
    store.applyCatalog({ catalogKey: "test", actor: "test" });
    now = END;
    const rule = defineTitleRule({
      kind: "behavior", key: "v2.test.castle", name: "test", description: "test", catalog: "test", emoji: "x",
      hidden: false, publicAnnounce: false, themeKey: "t", groupKey: "g", collectionDomainKey: "d",
      scope: { type: "global" }, sources: ["castle_experience_safe"], triggers: ["vc_activity"], lifecycle: "active",
    }, { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) });
    const scope = resolveTitleScope(store, rule.definition, END);
    const users = Array.from({ length: 601 }, (_, index) => `user-${index}`);
    const cache = new TitleSourceCache();
    expect(cache.prefetch(context.db, "castle_experience_safe", users, scope)).toEqual({ loaded: 601, readCalls: 27 });
    expect(cache.get(context.db, "castle_experience_safe", users[0]!, scope))
      .toEqual(readTitleSource(context.db, "castle_experience_safe", users[0]!, scope));
    expect(Object.isFrozen(cache.get(context.db, "castle_experience_safe", users[0]!, scope))).toBe(true);
  });
});
