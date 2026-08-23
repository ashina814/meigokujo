import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule, evaluateTitle } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { computeSafeSocialAggregates } from "../src/vc/derived.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const OBSERVED_AT = BASE + 10_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((BASE + 10_000_000) * 1000));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.vc-social-daily-breadth",
    catalog: "test",
    name: "test vc social daily breadth",
    emoji: "x",
    description: "source fixture",
    sources: ["vc_social_safe"] as const,
    triggers: ["vc_activity"],
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
  new BumpCounter(db);
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" });
  clock = BASE + 10_000_000;
  const insert = (
    userId: string,
    channelId: string,
    start: number,
    end: number | null,
    quality: "observed" | "recovered_estimate" | null = "observed",
    parentId = "parent-secret-marker",
  ) =>
    db
      .prepare(
        `INSERT INTO vc_segments
           (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'join')`,
      )
      .run(userId, channelId, parentId, start, end, quality);
  return { db, store, insert };
}

describe("vc_social_safe dailyBreadth — privacy P-S", () => {
  it("P/Q/R. public payloadは既存3指標 + date/countだけでidentity・pair・channel・timestampを漏らさない", () => {
    const { db, store, insert } = setup();
    insert("alice", "channel-secret-marker", BASE, BASE + 60);
    insert("counterpart-secret-marker", "channel-secret-marker", BASE, BASE + 60);
    const payload = readTitleSource(db, "vc_social_safe", "alice", resolveTitleScope(store, RULE.definition, OBSERVED_AT));
    expect(payload).toEqual({
      distinctCoPresentUsers: 1,
      maxRepeatedDaysWithOneCounterpart: 1,
      trustedOverlapSeconds: 60,
      dailyBreadth: [{ date: "2026-08-20", distinctCoPresentUsers: 1 }],
    });
    expect(Object.keys(payload.dailyBreadth[0]!)).toEqual(["date", "distinctCoPresentUsers"]);
    const json = JSON.stringify(payload);
    for (const secret of ["counterpart-secret-marker", "channel-secret-marker", "parent-secret-marker"]) expect(json).not.toContain(secret);
    for (const forbidden of ["userId", "counterpart", "pair", "channel", "timestamp", "startedAt", "endedAt", "visitCount", "overlapSeconds"]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it("S. vc_co_presenceはrestricted / titleUsable:falseのまま", () => {
    expect(TITLE_SOURCES.vc_co_presence).toMatchObject({ privacy: "restricted", titleUsable: false });
  });

  it("W. payload・dailyBreadth配列・entryまでgeneric deep-freezeする", () => {
    const { db, store, insert } = setup();
    insert("alice", "secret", BASE, BASE + 60);
    insert("bob-secret", "secret", BASE, BASE + 60);
    const payload = readTitleSource(db, "vc_social_safe", "alice", resolveTitleScope(store, RULE.definition, OBSERVED_AT));
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.dailyBreadth)).toBe(true);
    expect(Object.isFrozen(payload.dailyBreadth[0])).toBe(true);
    expect(() => ((payload.dailyBreadth[0] as { distinctCoPresentUsers: number }).distinctCoPresentUsers = 999)).toThrow();
  });
});

describe("vc_social_safe dailyBreadth — bulk/runtime T-Z", () => {
  it("T. zero-result payloadへdailyBreadth: []を追加し既存zero metricsを維持する", () => {
    const { db, store } = setup();
    expect(readTitleSource(db, "vc_social_safe", "nobody", resolveTitleScope(store, RULE.definition, OBSERVED_AT))).toEqual({
      distinctCoPresentUsers: 0,
      maxRepeatedDaysWithOneCounterpart: 0,
      trustedOverlapSeconds: 0,
      dailyBreadth: [],
    });
  });

  it("U/V. single/bulkが同じpayloadを返し、requested user以外をcacheへ混入させない", () => {
    const { db, store, insert } = setup();
    insert("alice", "secret", BASE, BASE + 60);
    insert("bob-secret", "secret", BASE, BASE + 60);
    const scope = resolveTitleScope(store, RULE.definition, OBSERVED_AT);
    const single = readTitleSource(db, "vc_social_safe", "alice", scope);
    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "vc_social_safe", ["alice"], scope)).toEqual({ loaded: 1, readCalls: 1 });
    expect(cache.get(db, "vc_social_safe", "alice", scope)).toEqual(single);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.length;
    cache.get(db, "vc_social_safe", "bob-secret", scope);
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it("W. bulk source readerは既存300-user chunkを維持する", () => {
    const { db, store } = setup();
    const users = Array.from({ length: 301 }, (_, index) => `user-${index}`);
    const cache = new TitleSourceCache();
    const scope = resolveTitleScope(store, RULE.definition, OBSERVED_AT);
    expect(cache.prefetch(db, "vc_social_safe", users, scope)).toEqual({ loaded: 301, readCalls: 2 });
    expect(cache.get(db, "vc_social_safe", "user-300", scope).dailyBreadth).toEqual([]);
  });

  it("X. requested user群を1回のsubject queryで処理しN+1を作らない", () => {
    const { db, insert } = setup();
    for (let i = 0; i < 50; i++) {
      insert(`subject-${i}`, "shared", BASE, BASE + 10);
      insert(`peer-${i}`, `peer-channel-${i}`, BASE, BASE + 10);
    }
    const prepareSpy = vi.spyOn(db, "prepare");
    computeSafeSocialAggregates(db, { start: BASE, end: BASE + 20 }, Array.from({ length: 50 }, (_, i) => `subject-${i}`));
    const subjectQueries = prepareSpy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("user_id IN"));
    expect(subjectQueries).toHaveLength(1);
  });

  it("Y. source contractは同一source・derivedFrom・privacy・orderability・rawUnitのまま", () => {
    expect(TITLE_SOURCES.vc_social_safe).toEqual({
      origin: "derived",
      derivedBy: {
        file: "packages/core/src/vc/derived.ts",
        needle: "export function computeSafeSocialAggregates(",
      },
      derivedFrom: ["vc_co_presence"],
      kind: "history",
      privacy: "safe",
      orderable: false,
      titleUsable: true,
      epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
      rawUnit: "safe_social_aggregate",
    });
  });

  it("Y. vc_social_safeだけのruleがnon-null earnedAtを返すとorderable:falseによりfail-closed", () => {
    const { db, store, insert } = setup();
    insert("alice", "secret", BASE, BASE + 60);
    insert("bob-secret", "secret", BASE, BASE + 60);
    const badRule = defineTitleRule(
      { ...RULE.definition, key: "v2.test.vc-social-daily-bad-earned-at" },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE + 60, awardFacts: {} }) },
    );
    expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(/non-orderable/);
  });

  it("Z. 1200 historical channel IDsも既存300-channel chunkで読み、daily semanticsを保つ", () => {
    const { db, insert } = setup();
    db.transaction(() => {
      for (let i = 0; i < 1200; i++) {
        const channel = `historical-secret-${i}`;
        insert("alice", channel, BASE + i * 2, BASE + i * 2 + 1);
        insert("bob-secret", channel, BASE + i * 2, BASE + i * 2 + 1);
      }
    })();
    const prepareSpy = vi.spyOn(db, "prepare");
    const row = computeSafeSocialAggregates(db, { start: BASE, end: BASE + 2500 }, ["alice"])[0]!;
    expect(row.dailyBreadth).toEqual([{ date: "2026-08-20", distinctCoPresentUsers: 1 }]);
    expect(row.trustedOverlapSeconds).toBe(1200);
    const channelQueries = prepareSpy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("AND channel_id IN"));
    expect(channelQueries).toHaveLength(4);
    expect(Math.max(...channelQueries.map((sql) => sql.match(/\?/g)?.length ?? 0))).toBe(303);
  });
});
