import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { CasinoParticipationHistory, CASINO_ACTIVITY_KEYS } from "../src/casino/participation-history.js";
import { CASINO_EDITION_I_MANIFEST, casinoEditionIFamilyFor } from "../src/casino/edition-i-manifest.js";
import { Takutate, TITLE_ELIGIBLE_CASINO_TABLE_TYPES } from "../src/casino/takutate.js";
import {
  computeCasinoEditionICompletionSafe,
  computeCasinoMarketActivitySafe,
  computeCasinoTableActivitySafe,
} from "../src/titles/v2-casino-edition-table-market.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { ChipLedger } from "../src/casino/exchange.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { Markets } from "../src/casino/market.js";
import { openFormally } from "./helpers/chip-ctx.js";

const BASE = Math.floor(Date.UTC(2026, 7, 19, 15) / 1000); // JST 2026-08-20 00:00
const DAY = 86400;
beforeAll(() => registerDefaultTxTypes());
afterEach(() => vi.useRealTimers());

function marketHistorySchema(db: ReturnType<typeof openDb>) {
  db.exec(`CREATE TABLE IF NOT EXISTS casino_market_participation_history (
    participation_key TEXT PRIMARY KEY, market_id INTEGER NOT NULL, market_creator_id TEXT NOT NULL,
    participant_id TEXT NOT NULL, market_mode TEXT NOT NULL, market_created_at INTEGER NOT NULL,
    market_deadline_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL)`);
}

function setup() {
  const db = openDb(":memory:");
  let clock = BASE;
  const events = new EventLog(db);
  const taku = new Takutate(db, events, () => clock);
  const casino = new CasinoParticipationHistory(db, () => clock);
  marketHistorySchema(db);
  return { db, taku, casino, setClock: (value: number) => { clock = value; } };
}

let completionSeq = 0;
function completion(casino: CasinoParticipationHistory, activityKey: (typeof CASINO_ACTIVITY_KEYS)[number]) {
  const participationKey = `edition:${++completionSeq}`;
  casino.recordCommittedParticipation({ participationKey, activityKey, participantUserIds: ["subject"] });
  casino.recordCompletedParticipation({ participationKey, activityKey, participantUserIds: ["subject"] });
}

function insertMarket(db: ReturnType<typeof openDb>, input: {
  key: string; market: number; user?: string; creator?: string; mode?: string; at: number;
  created?: number; deadline?: number;
}) {
  db.prepare(`INSERT INTO casino_market_participation_history VALUES (?,?,?,?,?,?,?,?)`).run(
    input.key, input.market, input.creator ?? "other", input.user ?? "subject", input.mode ?? "standard",
    input.created ?? BASE - DAY, input.deadline ?? BASE + 10 * DAY, input.at,
  );
}

describe("A–F Edition-I manifest/completion", () => {
  it("A/B: explicit versioned 8-family manifest does not auto-enumerate all activity keys", () => {
    expect(CASINO_EDITION_I_MANIFEST).toMatchObject({ editionKey: "casino-edition-i", version: 1 });
    expect(CASINO_EDITION_I_MANIFEST.families).toHaveLength(8);
    expect(CASINO_ACTIVITY_KEYS).toHaveLength(11);
    expect(casinoEditionIFamilyFor("keiba")).toBeUndefined();
    expect(casinoEditionIFamilyFor("sashi")).toBeUndefined();
    expect(casinoEditionIFamilyFor("indian")).toBeUndefined();
  });

  it("C–F: family breadth is completion-only, deduped, and exact full-set aware", () => {
    const { db, casino, setClock } = setup();
    const keys = CASINO_EDITION_I_MANIFEST.families.map((f) => f.activityKeys[0]);
    for (const [i, key] of keys.entries()) { setClock(BASE + i); completion(casino, key); }
    setClock(BASE + 100); completion(casino, "blackjack"); // another mode/completion in same normalized family
    let payload = computeCasinoEditionICompletionSafe(db, { start: BASE, end: BASE + DAY }, ["subject"]).get("subject")!;
    expect(payload.distinctCompletedFamilies).toBe(8);
    expect(payload.allFamiliesCompleted).toBe(true);
    payload = computeCasinoEditionICompletionSafe(db, { start: BASE + 1, end: BASE + DAY }, ["subject"]).get("subject")!;
    expect(payload.distinctCompletedFamilies).toBe(7);
    expect(payload.allFamiliesCompleted).toBe(false);
    setClock(BASE + 200);
    casino.recordCommittedParticipation({ participationKey: "commit-only", activityKey: "slots", participantUserIds: ["commit-only"] });
    expect(computeCasinoEditionICompletionSafe(db, { start: BASE, end: BASE + DAY }, ["commit-only"])
      .get("commit-only")!.distinctCompletedFamilies).toBe(0);
    db.close();
  });
});

describe("G–V official table safe source", () => {
  it("G–K: empty/owner/bot/fake VC are zero; a known human guest is evidence", () => {
    const { db, taku } = setup();
    taku.track("official", "guild", "owner", "sashi");
    taku.observeCurrentGuest("official", "owner", false, BASE + 1);
    taku.observeCurrentGuest("official", "bot", true, BASE + 1);
    taku.observeCurrentGuest("fake-卓", "guest", false, BASE + 1);
    expect(computeCasinoTableActivitySafe(db, { start: BASE, end: BASE + 100 }, ["owner"]).get("owner")!.tables).toEqual([]);
    taku.observeGuestTransition({ userId: "guest", isBot: false, oldChannelId: null, newChannelId: "official", observedAt: BASE + 10 });
    taku.observeGuestTransition({ userId: "guest", isBot: false, oldChannelId: "official", newChannelId: null, observedAt: BASE + 40 });
    expect(computeCasinoTableActivitySafe(db, { start: BASE, end: BASE + 100 }, ["owner"]).get("owner")!.tables[0]!.guestStays)
      .toEqual([{ guestProfileIndex: 0, date: "2026-08-20", trustedSeconds: 30 }]);
    db.close();
  });

  it("L–P: repeat guest, distinct guests/tables, days and cross-midnight stay remain separate axes", () => {
    const { db, taku, setClock } = setup();
    for (const [channel, at] of [["a", BASE], ["b", BASE + DAY]] as const) {
      setClock(at); taku.track(channel, "g", "owner", "mahjong");
    }
    const stay = (channel: string, guest: string, start: number, end: number) => {
      taku.observeGuestTransition({ userId: guest, isBot: false, oldChannelId: null, newChannelId: channel, observedAt: start });
      taku.observeGuestTransition({ userId: guest, isBot: false, oldChannelId: channel, newChannelId: null, observedAt: end });
    };
    stay("a", "guest-a", BASE + DAY - 10, BASE + DAY + 10); // one table, two JST days
    stay("a", "guest-a", BASE + DAY + 20, BASE + DAY + 30); // repeat, same profile
    stay("b", "guest-a", BASE + DAY + 40, BASE + DAY + 50);
    stay("b", "guest-b", BASE + DAY + 60, BASE + DAY + 70);
    const payload = computeCasinoTableActivitySafe(db, { start: BASE, end: BASE + 2 * DAY }, ["owner"]).get("owner")!;
    expect(payload.tables).toHaveLength(2);
    expect(payload.guests).toHaveLength(2);
    expect(payload.guests[0]!.stays.map((s) => s.tableProfileIndex)).toEqual(expect.arrayContaining([0, 1]));
    expect(payload.tables[0]!.guestStays.map((s) => s.date)).toEqual(expect.arrayContaining(["2026-08-20", "2026-08-21"]));
    db.close();
  });

  it("Q–U: restart gap is zero, current observation is fresh, scope clipping and deleted history persist", () => {
    const { db, taku, setClock } = setup();
    taku.track("table", "g", "owner", "duel");
    taku.observeCurrentGuest("table", "guest", false, BASE + 10);
    setClock(BASE + 1000);
    const restarted = new Takutate(db, new EventLog(db), () => BASE + 1000); // closes old at its start
    restarted.observeCurrentGuest("table", "guest", false, BASE + 1000);
    restarted.observeGuestTransition({ userId: "guest", isBot: false, oldChannelId: "table", newChannelId: null, observedAt: BASE + 1030 });
    restarted.untrack("table", BASE + 1040);
    expect(restarted.isTracked("table")).toBe(false);
    expect(computeCasinoTableActivitySafe(db, { start: BASE + 500, end: BASE + 1100 }, ["owner"])
      .get("owner")!.tables[0]!.guestStays[0]!.trustedSeconds).toBe(30);
    expect(computeCasinoTableActivitySafe(db, { start: BASE, end: BASE + 5 }, ["owner"]).get("owner")!.tables).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) c FROM casino_table_instances").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("S/V: pre-scope instance context is usable, activity is clipped, and safe JSON has no identities", () => {
    const { db, taku } = setup();
    taku.track("secret-channel", "secret-guild", "secret-owner", TITLE_ELIGIBLE_CASINO_TABLE_TYPES[0]);
    taku.observeGuestTransition({ userId: "secret-guest", isBot: false, oldChannelId: null, newChannelId: "secret-channel", observedAt: BASE + 90 });
    taku.observeGuestTransition({ userId: "secret-guest", isBot: false, oldChannelId: "secret-channel", newChannelId: null, observedAt: BASE + 120 });
    const payload = computeCasinoTableActivitySafe(db, { start: BASE + 100, end: BASE + 200 }, ["secret-owner"]).get("secret-owner")!;
    expect(payload.tables[0]!.guestStays[0]!.trustedSeconds).toBe(20);
    expect(JSON.stringify(payload)).not.toMatch(/secret-(owner|guest|channel|guild)/);
    db.close();
  });
});

describe("W–AM standard market safe source", () => {
  it("W–AG: other standard only; self/event/corrupt excluded; market-day collapse and board breadth", () => {
    const { db } = setup();
    insertMarket(db, { key: "w", market: 1, at: BASE + 1 });
    insertMarket(db, { key: "x", market: 2, creator: "subject", at: BASE + 2 });
    insertMarket(db, { key: "y", market: 3, mode: "event", at: BASE + 3 });
    insertMarket(db, { key: "ac1", market: 1, at: BASE + 4 });
    insertMarket(db, { key: "ac2", market: 1, at: BASE + 5 });
    insertMarket(db, { key: "ae", market: 4, at: BASE + 6 });
    insertMarket(db, { key: "ad", market: 1, at: BASE + DAY + 1 });
    insertMarket(db, { key: "ak", market: 5, at: BASE + 100, deadline: BASE + 100 });
    const payload = computeCasinoMarketActivitySafe(db, { start: BASE, end: BASE + 2 * DAY }, ["subject"]).get("subject")!;
    expect(payload.days).toEqual([
      { date: "2026-08-20", distinctOtherStandardBoards: 2 },
      { date: "2026-08-21", distinctOtherStandardBoards: 1 },
    ]);
    expect(payload.distinctOtherStandardBoards).toBe(2);
    expect(JSON.stringify(payload)).not.toMatch(/subject|other|market|option|amount|result/);
    db.close();
  });

  it("AB/AA/AH/AI: writer is atomic/idempotent; rejection writes zero; refund does not erase history", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date((BASE + 1000) * 1000));
    const db = openDb(":memory:");
    const ledger = new Ledger(db); const events = new EventLog(db);
    const chips = new ChipLedger(db, ledger, events, { chipTx: new ChipTx(db) });
    openFormally(chips.chipTx, ledger);
    ledger.ensureAccount("user:subject", "user");
    ledger.transfer({ from: TREASURY, to: "user:subject", amount: 10_000, type: "initial", actor: "t", idempotencyKey: "seed" });
    chips.deposit("subject", 10_000, "deposit");
    const markets = new Markets(db, chips, events);
    const market = markets.create({ operationId: "create", guildId: "g", creatorId: "other", title: "secret", options: ["a", "b"], durationMin: 60, fee: 0 });
    markets.bet(market.id, "subject", 0, 1000, "bet");
    markets.bet(market.id, "subject", 0, 1000, "bet");
    expect((db.prepare("SELECT COUNT(*) c FROM casino_market_participation_history").get() as { c: number }).c).toBe(1);
    expect(() => markets.bet(market.id, "poor", 0, 1000, "failed")).toThrow();
    expect((db.prepare("SELECT COUNT(*) c FROM casino_market_participation_history").get() as { c: number }).c).toBe(1);
    markets.refund(market.id, "admin");
    expect(computeCasinoMarketActivitySafe(db, { start: BASE, end: BASE + DAY }, ["subject"])
      .get("subject")!.distinctOtherStandardBoards).toBe(1);
    expect(() => db.prepare("DELETE FROM casino_market_participation_history").run()).toThrow(/append-only/);
    db.close();
  });

  it("AJ–AL: immutable snapshot survives mutable/deleted market while corrupt chronology fails closed", () => {
    const { db } = setup();
    insertMarket(db, { key: "stable", market: 10, at: BASE + 10 });
    insertMarket(db, { key: "corrupt", market: 11, at: BASE - 2 * DAY, created: BASE - DAY });
    expect(computeCasinoMarketActivitySafe(db, { start: BASE - 3 * DAY, end: BASE + DAY }, ["subject"])
      .get("subject")!.distinctOtherStandardBoards).toBe(1);
    db.close();
  });
});

describe("source contract, fixed observedAt, privacy and 601-user bulk", () => {
  it("instance/market histories are immutable and guest rows can only close once", () => {
    const { db, taku } = setup();
    taku.track("table", "g", "owner", "sashi");
    taku.observeCurrentGuest("table", "guest", false, BASE + 1);
    expect(() => db.prepare("UPDATE casino_table_instances SET owner_id='x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM casino_table_instances").run()).toThrow(/append-only/);
    taku.observeGuestTransition({ userId: "guest", isBot: false, oldChannelId: "table", newChannelId: null, observedAt: BASE + 2 });
    expect(() => db.prepare("UPDATE casino_table_guest_presence SET ended_at=?").run(BASE + 3)).toThrow(/closed once/);
    db.close();
  });

  it("registers restricted raw and safe derived boundaries without stocks", () => {
    expect(TITLE_SOURCES.casino_table_guest_presence).toMatchObject({ privacy: "restricted", titleUsable: false });
    expect(TITLE_SOURCES.casino_market_participation_records).toMatchObject({ privacy: "restricted", titleUsable: false });
    expect(TITLE_SOURCES.casino_table_activity_safe).toMatchObject({ privacy: "safe", titleUsable: true });
    expect(TITLE_SOURCES.casino_market_activity_safe).toMatchObject({ privacy: "safe", titleUsable: true });
    expect(TITLE_SOURCES.casino_market_activity_safe.derivedFrom).not.toContain("stocks");
  });

  it("300/300/1 chunks load 601 subjects and cache payload equals single reader", () => {
    const { db } = setup();
    let storeClock = BASE - 10;
    const store = new TitleV2Store(db, () => storeClock);
    store.applyCatalog({ catalogKey: "test", actor: "test" });
    storeClock = BASE + DAY;
    const rule = defineTitleRule({
      kind: "behavior", key: "v2.test.casino-table", name: "test", description: "test",
      catalog: "test", emoji: "x", hidden: false, publicAnnounce: false, themeKey: "t", groupKey: "g",
      collectionDomainKey: "d", scope: { type: "global" }, sources: ["casino_table_activity_safe"],
      triggers: ["vc_activity"], lifecycle: "active",
    }, { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) });
    const resolved = resolveTitleScope(store, rule.definition, BASE + DAY);
    const users = Array.from({ length: 601 }, (_, i) => `user-${i}`);
    for (const source of ["casino_table_activity_safe", "casino_market_activity_safe", "casino_edition_i_completion_safe"] as const) {
      const cache = new TitleSourceCache();
      expect(cache.prefetch(db, source, users, resolved)).toEqual({ loaded: 601, readCalls: 3 });
      expect(cache.get(db, source, users[0]!, resolved)).toEqual(new TitleSourceCache().get(db, source, users[0]!, resolved));
    }
    db.close();
  });
});
