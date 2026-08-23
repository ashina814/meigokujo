import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule, evaluateTitle } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const OBSERVED_AT = BASE + 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((BASE + 500_000) * 1000));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.vc-group-size-daily",
    catalog: "test",
    name: "test daily group size",
    emoji: "x",
    description: "source fixture",
    sources: ["vc_group_size_daily_safe"] as const,
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
    parentId: string,
    start: number,
    end: number | null,
    quality: "observed" | "recovered_estimate" | null = "observed",
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

describe("vc_group_size_daily_safe source wiring Q-X", () => {
  it("Q/S. singleとbulkはrequested usersだけへ同じpayloadを返す", () => {
    const { db, store, insert } = setup();
    insert("alice", "secret-channel", "secret-parent", BASE, BASE + 60);
    insert("counterpart-secret", "secret-channel", "secret-parent", BASE, BASE + 60);
    const scope = resolveTitleScope(store, RULE.definition, OBSERVED_AT);
    const single = readTitleSource(db, "vc_group_size_daily_safe", "alice", scope);

    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "vc_group_size_daily_safe", ["alice"], scope)).toEqual({ loaded: 1, readCalls: 1 });
    expect(cache.get(db, "vc_group_size_daily_safe", "alice", scope)).toEqual(single);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.length;
    cache.get(db, "vc_group_size_daily_safe", "counterpart-secret", scope);
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it("Q. bulk readerも既存300-user chunkを維持する", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, RULE.definition, OBSERVED_AT);
    const users = Array.from({ length: 301 }, (_, i) => `user-${i}`);
    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "vc_group_size_daily_safe", users, scope)).toEqual({ loaded: 301, readCalls: 2 });
    expect(cache.get(db, "vc_group_size_daily_safe", "user-300", scope)).toEqual({ days: [] });
  });

  it("P/T. 既存payloadは不変で、zero resultは{days:[]}へnormalizeする", () => {
    const { db, store, insert } = setup();
    insert("alice", "vc", "parent", BASE, BASE + 60);
    const scope = resolveTitleScope(store, RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "vc_group_size_seconds", "alice", scope)).toEqual({
      trustedSecondsByBucket: { solo: 60, oneToOne: 0, smallGroup: 0, largeGroup: 0 },
      untrustedSeconds: 0,
    });
    expect(readTitleSource(db, "vc_group_size_daily_safe", "nobody", scope)).toEqual({ days: [] });
  });

  it("U. payloadからbucket objectまでdeep-freezeする", () => {
    const { db, store, insert } = setup();
    insert("alice", "vc", "parent", BASE, BASE + 60);
    const scope = resolveTitleScope(store, RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "vc_group_size_daily_safe", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.days)).toBe(true);
    expect(Object.isFrozen(payload.days[0])).toBe(true);
    expect(Object.isFrozen(payload.days[0]!.trustedSecondsByBucket)).toBe(true);
    expect(() => ((payload.days[0]!.trustedSecondsByBucket as { solo: number }).solo = 999)).toThrow();
  });

  it("V. dateと4bucket aggregate以外のcounterpart/channel/raw markerを漏らさない", () => {
    const { db, store, insert } = setup();
    insert("alice", "channel-secret-marker", "parent-secret-marker", BASE, BASE + 60);
    insert("counterpart-secret-marker", "channel-secret-marker", "parent-secret-marker", BASE, BASE + 60);
    const scope = resolveTitleScope(store, RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "vc_group_size_daily_safe", "alice", scope);
    expect(payload).toEqual({
      days: [
        {
          date: "2026-08-20",
          trustedSecondsByBucket: { solo: 0, oneToOne: 60, smallGroup: 0, largeGroup: 0 },
        },
      ],
    });
    const json = JSON.stringify(payload);
    for (const secret of ["counterpart-secret-marker", "channel-secret-marker", "parent-secret-marker"]) {
      expect(json).not.toContain(secret);
    }
    for (const forbiddenKey of ["channelId", "parentId", "startedAt", "endedAt", "endQuality", "occupancy", "userId"]) {
      expect(json).not.toContain(forbiddenKey);
    }
  });

  it("W. source contractをexactに固定する", () => {
    expect(TITLE_SOURCES.vc_group_size_daily_safe).toEqual({
      origin: "derived",
      derivedBy: {
        file: "packages/core/src/vc/derived.ts",
        needle: "export function computeGroupSizeDailySeconds(",
      },
      derivedFrom: ["vc_visits"],
      kind: "history",
      privacy: "safe",
      orderable: false,
      titleUsable: true,
      epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
      rawUnit: "unique_jst_group_size_trusted_seconds_measurement",
    });
  });

  it("X. new sourceだけのruleがexact earnedAtを主張するとfail-closed", () => {
    const { db, store, insert } = setup();
    insert("alice", "vc", "parent", BASE, BASE + 60);
    const badRule = defineTitleRule(
      { ...RULE.definition, key: "v2.test.bad-vc-group-daily-earned-at" },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE + 60, awardFacts: {} }) },
    );
    expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(/non-orderable/);
  });
});
