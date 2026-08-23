import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule, evaluateTitle } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const END = BASE + 20 * 86_400;

const RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.social-activity-time-safe",
    catalog: "test",
    name: "test social activity time",
    emoji: "x",
    description: "source fixture",
    sources: ["social_activity_time_safe"] as const,
    triggers: ["text_activity", "vc_activity"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey: "test-theme",
    groupKey: "test-group",
    collectionDomainKey: "test-domain",
    scope: { type: "global" },
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

function setup() {
  const db = openDb(":memory:");
  const tc = new TcSocialObservations(db);
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "setup" });
  clock = END;
  const message = (id: string, author: string, at: number, surface = "surface-secret-marker", area = "area-secret-marker") =>
    tc.recordMessage({
      messageId: id,
      authorId: author,
      surfaceId: surface,
      areaId: area,
      surfaceKind: "channel",
      replyToMessageId: null,
      createdAtMs: at * 1000,
      observedAtMs: at * 1000 + 1,
    });
  const visit = (user: string, channel: string, start: number, end: number) =>
    db
      .prepare(
        `INSERT INTO vc_public_social_presence
           (user_id, guild_id, channel_id, started_at, ended_at, end_quality)
         VALUES (?, 'guild-secret-marker', ?, ?, ?, 'observed')`,
      )
      .run(user, channel, start, end);
  const scope = () => resolveTitleScope(store, RULE.definition, END);
  return { db, store, message, visit, scope };
}

describe("social_activity_time_safe source runtime", () => {
  it("single/bulk equivalence、zero payload、requested-user cache isolation", () => {
    const { db, message, scope } = setup();
    message("message-secret-marker", "subject", BASE + 9 * 3600);
    message("counterpart-secret-marker", "other", BASE + 9 * 3600 + 60);
    const resolved = scope();
    const single = readTitleSource(db, "social_activity_time_safe", "subject", resolved);
    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "social_activity_time_safe", ["subject", "nobody"], resolved)).toEqual({ loaded: 2, readCalls: 1 });
    expect(cache.get(db, "social_activity_time_safe", "subject", resolved)).toEqual(single);
    expect(cache.get(db, "social_activity_time_safe", "nobody", resolved)).toEqual({ days: [] });

    const spy = vi.spyOn(db, "prepare");
    cache.get(db, "social_activity_time_safe", "other", resolved);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it("300-user chunkと1200 requested usersをbounded bulk readする", () => {
    const { db, scope } = setup();
    const users = Array.from({ length: 1200 }, (_, index) => `user-${index}`);
    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "social_activity_time_safe", users, scope())).toEqual({ loaded: 1200, readCalls: 4 });
    expect(cache.get(db, "social_activity_time_safe", "user-1199", scope())).toEqual({ days: [] });
  });

  it("1200 TC surfaces/areas + public VC presence rowsをboundedに読み、surface/message/hour N+1を作らない", () => {
    const { db, message, visit, scope } = setup();
    db.transaction(() => {
      for (let index = 0; index < 1200; index += 1) {
        const at = BASE + 100 + index;
        message(`subject-${index}`, "subject", at, `surface-${index}`, `area-${index}`);
        message(`other-${index}`, `other-${index}`, at + 1, `surface-${index}`, `area-${index}`);
        visit("subject", `channel-${index}`, at, at + 2);
        visit(`vc-other-${index}`, `channel-${index}`, at, at + 2);
      }
    })();
    const spy = vi.spyOn(db, "prepare");
    const payload = readTitleSource(db, "social_activity_time_safe", "subject", scope());
    expect(payload.days).toHaveLength(1);
    expect(payload.days[0]!.hours).toHaveLength(1);
    const sql = spy.mock.calls.map(([text]) => String(text));
    const areaQueries = sql.filter((text) => text.includes("area_id IN"));
    const presenceQueries = sql.filter((text) => text.includes("FROM vc_public_social_presence"));
    expect(areaQueries).toHaveLength(4);
    expect(presenceQueries).toHaveLength(1);
    expect(Math.max(...[...areaQueries, ...presenceQueries].map((text) => text.match(/\?/g)?.length ?? 0))).toBeLessThanOrEqual(303);
    expect(sql.filter((text) => /surface_id\s*=\s*\?/.test(text))).toHaveLength(0);
    expect(sql.filter((text) => /message_id\s*=\s*\?/.test(text))).toHaveLength(0);
    expect(sql.length).toBeLessThanOrEqual(8);
  });

  it("payload/day/hourの全階層をdeep-freezeする", () => {
    const { db, message, scope } = setup();
    message("subject", "subject", BASE + 9 * 3600);
    message("other", "other", BASE + 9 * 3600 + 1);
    const payload = readTitleSource(db, "social_activity_time_safe", "subject", scope());
    for (const value of [payload, payload.days, payload.days[0], payload.days[0]!.hours, payload.days[0]!.hours[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => ((payload.days[0]!.hours[0] as { hour: number }).hour = 99)).toThrow();
  });

  it("exact source contract、restricted/raw generic read拒否、non-orderable earnedAt fail-closed", () => {
    const { db, store, scope } = setup();
    expect(TITLE_SOURCES.social_activity_time_safe).toEqual({
      origin: "derived",
      derivedBy: {
        file: "packages/core/src/social-activity-time/derived.ts",
        needle: "export function computeSocialActivityTimeSafe(",
      },
      derivedFrom: ["tc_message_observations", "vc_public_social_presence"],
      kind: "history",
      privacy: "safe",
      orderable: false,
      titleUsable: true,
      epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
      rawUnit: "safe_public_social_activity_hour_distribution",
    });
    expect(TITLE_SOURCES.vc_public_social_presence).toEqual({
      origin: "persisted",
      writtenBy: {
        file: "packages/core/src/vc/public-social-presence.ts",
        needle: "INSERT INTO vc_public_social_presence",
      },
      calledFrom: {
        file: "apps/bot/src/vc-public-social-tracking.ts",
        needle: "services.vcPublicSocial.reconcileChannel({",
      },
      wiredFrom: {
        file: "apps/bot/src/index.ts",
        needle: "trackVcPublicSocialPresence(oldState, newState, services)",
      },
      kind: "history",
      privacy: "restricted",
      orderable: false,
      titleUsable: false,
      restrictedUse: "public_social_presence_classification",
      epochPolicy: { type: "interval", start: "started_at", end: "ended_at", clip: true },
      rawUnit: "public_human_social_presence_interval_with_internal_surface_identity",
    });
    expect(() => readTitleSource(db, "tc_message_observations" as never, "subject", scope())).toThrow(/not usable/);
    expect(() => readTitleSource(db, "vc_public_social_presence" as never, "subject", scope())).toThrow(/not usable/);
    expect(() => readTitleSource(db, "vc_visits" as never, "subject", scope())).toThrow(/not usable/);
    const badRule = defineTitleRule(
      { ...RULE.definition, key: "v2.test.bad-social-time-earned-at" },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE + 1, awardFacts: {} }) },
    );
    expect(() => evaluateTitle(db, store, badRule, "subject", END)).toThrow(/non-orderable/);
  });

  it("safe payloadにidentity/exact timestamp/count/daypart markerを出さない", () => {
    const { db, message, visit, scope } = setup();
    message("message-secret-marker", "author-secret-marker", BASE + 9 * 3600, "surface-secret-marker", "area-secret-marker");
    message("counterpart-secret-marker", "counterpart-secret-marker", BASE + 9 * 3600 + 1, "surface-secret-marker", "area-secret-marker");
    visit("author-secret-marker", "channel-secret-marker", BASE + 9 * 3600, BASE + 9 * 3600 + 10);
    visit("vc-counterpart-secret-marker", "channel-secret-marker", BASE + 9 * 3600, BASE + 9 * 3600 + 10);
    const json = JSON.stringify(readTitleSource(db, "social_activity_time_safe", "author-secret-marker", scope()));
    for (const marker of [
      "message-secret-marker",
      "author-secret-marker",
      "counterpart-secret-marker",
      "channel-secret-marker",
      "guild-secret-marker",
      "surface-secret-marker",
      "area-secret-marker",
      "parent-secret-marker",
    ]) expect(json).not.toContain(marker);
    for (const forbidden of [
      "userId", "messageId", "authorId", "counterpart", "channelId", "surfaceId", "areaId", "threadId",
      "createdAt", "startedAt", "endedAt", "timestamp", "minute", "second", "messageCount", "postCount", "pairCount", "permission", "role",
      "morning", "afternoon", "evening", "lateNight", "daypart", "Share",
    ]) expect(json).not.toContain(forbidden);
  });
});
