import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

/** JST 2026-08-20 00:00:00 を秒0とする、E4テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const OBSERVED_AT = BASE + 100_000;
const DAY = 86_400;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" }); // SYSTEM_EPOCH = BASE-100_000
  clock = BASE + 10_000_000;
  let casinoClock = BASE;
  const casino = new CasinoParticipationHistory(db, () => casinoClock);
  const setCasinoClock = (t: number) => {
    casinoClock = t;
  };
  return { db, store, casino, setCasinoClock };
}

const COMMON_FIXTURE_FIELDS = {
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  collectionDomainKey: "test-domain",
  scope: { type: "global" as const },
};

const CASINO_ACTIVITY_DAYS_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.casino-activity-days",
    name: "test",
    description: "テスト用fixture",
    sources: ["casino_activity_days"] as const,
    triggers: ["game_completed"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

let seq = 0;
function record(
  casino: CasinoParticipationHistory,
  opts: { activityKey: string; participantUserIds: readonly string[]; participationKey?: string },
) {
  seq += 1;
  return casino.recordCommittedParticipation({
    participationKey: opts.participationKey ?? `test:${seq}`,
    activityKey: opts.activityKey as never,
    participantUserIds: opts.participantUserIds,
  });
}

// ─────────────────────────────────────────────────────────────

describe("source contract（§12）", () => {
  it("casino_participations: persisted / restricted / titleUsable:false / orderable:true / point at occurred_at / restrictedUse casino_safe_participation_classification", () => {
    expect(TITLE_SOURCES.casino_participations).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      titleUsable: false,
      orderable: true,
      epochPolicy: { type: "point", at: "occurred_at" },
      restrictedUse: "casino_safe_participation_classification",
    });
  });

  it("casino_activity_days: derived / safe / titleUsable:true / orderable:true / derivedFrom casino_participations / point occurredAt", () => {
    expect(TITLE_SOURCES.casino_activity_days).toMatchObject({
      origin: "derived",
      privacy: "safe",
      titleUsable: true,
      orderable: true,
      epochPolicy: { type: "point", at: "occurredAt" },
      derivedFrom: ["casino_participations"],
    });
  });
});

describe("generic raw rejection（§10相当）", () => {
  it("readTitleSource(db, 'casino_participations', ...)はtitleUsable:falseでreject", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(() => readTitleSource(db, "casino_participations" as never, "alice", scope)).toThrow(/not usable by titles/);
  });
});

describe("A. 1 participation → 1 activityDay（§17A）", () => {
  it("aliceが1回blackjackへ参加 → payload 1件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE + 1000);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    expect(payload.activityDays).toEqual([{ activityKey: "blackjack", activityDate: "2026-08-20", occurredAt: BASE + 1000 }]);
  });
});

describe("B. same activity / same JST day 100 plays → 1 activityDay（§17B）", () => {
  it("同日にblackjackを100回遊んでも1件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    for (let i = 0; i < 100; i++) {
      record(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: `solo:blackjack:op-${i}` });
    }
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    expect(payload.activityDays).toHaveLength(1);
  });
});

describe("C. same activity / next JST day → 2 activityDays（§17C）", () => {
  it("翌日も遊ぶと2件になる", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-1" });
    setCasinoClock(BASE - 50_000 + DAY);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-2" });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    expect(payload.activityDays).toHaveLength(2);
  });
});

describe("D. different activity / same day → 2 activityDays（§17D）", () => {
  it("同日にblackjackとslotsを遊ぶと2件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-1" });
    record(casino, { activityKey: "slots", participantUserIds: ["alice"], participationKey: "op-2" });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    expect(payload.activityDays.map((d) => d.activityKey).sort()).toEqual(["blackjack", "slots"]);
  });
});

describe("E. JST 23:59:59 / 00:00:00 → different day（§17E）", () => {
  it("JST日境界をまたぐと別日扱い", () => {
    const { db, store, casino, setCasinoClock } = setup();
    // BASE = JST 2026-08-20 00:00:00。23:59:59はBASE + 1日 - 1秒
    setCasinoClock(BASE + DAY - 1); // JST 2026-08-20 23:59:59
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-1" });
    setCasinoClock(BASE + DAY); // JST 2026-08-21 00:00:00
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-2" });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    expect(payload.activityDays.map((d) => d.activityDate).sort()).toEqual(["2026-08-20", "2026-08-21"]);
  });
});

describe("F. payload fields exactly（§17F）", () => {
  it("activityKey/activityDate/occurredAtだけ", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    expect(Object.keys(payload.activityDays[0]!).sort()).toEqual(["activityDate", "activityKey", "occurredAt"]);
  });
});

describe("G. participationKeyはpayloadへ出ない（§17G） / H. wager等が存在しない（§17H）", () => {
  it("参加key・operationId・機微データがpayloadへ一切現れない", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, {
      activityKey: "sashi",
      participantUserIds: ["alice", "bob"],
      participationKey: "pvp:LEAK_SESSION_SECRET",
    });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("LEAK_SESSION_SECRET");
    expect(serialized).not.toContain("bob");
    expect(serialized).not.toContain("wager");
    expect(serialized).not.toContain("payout");
  });
});

describe("I. single == bulk（§17I）", () => {
  it("fresh single get == bulk prefetch → get（複数user）", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    record(casino, { activityKey: "slots", participantUserIds: ["bob"] });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);

    const single = new TitleSourceCache();
    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "casino_activity_days", ["alice", "bob"], scope);
    for (const userId of ["alice", "bob"]) {
      expect(bulk.get(db, "casino_activity_days", userId, scope)).toEqual(
        single.get(db, "casino_activity_days", userId, scope),
      );
    }
  });
});

describe("J. requested users以外を返さない（§17J）", () => {
  it("PVP participantの相手が別userでも、requestしたuserだけがpayloadへ入る", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, { activityKey: "sashi", participantUserIds: ["alice", "bob"] });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const cache = new TitleSourceCache();
    const result = cache.prefetch(db, "casino_activity_days", ["alice"], scope);
    expect(result.loaded).toBe(1);
    const bobResult = cache.prefetch(db, "casino_activity_days", ["bob"], scope);
    expect(bobResult.loaded).toBe(1); // bobは別のprefetch呼び出しで初めて読み込まれる
  });
});

describe("K. zero result normalization（§17K）", () => {
  it("0件userはactivityDays:[]を明示的に返す", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_activity_days", "nobody", scope)).toEqual({ activityDays: [] });
  });
});

describe("L. [start,end) start含む・end除外（§17L）", () => {
  it("scope開始ちょうどは含み、effectiveEndちょうどは除外する", () => {
    const { db, store, casino, setCasinoClock } = setup();
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);

    setCasinoClock(scope.start - 1);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "before-start" });
    setCasinoClock(scope.start);
    record(casino, { activityKey: "slots", participantUserIds: ["alice"], participationKey: "at-start" });
    setCasinoClock(OBSERVED_AT - 1);
    record(casino, { activityKey: "poker", participantUserIds: ["alice"], participationKey: "before-end" });
    setCasinoClock(OBSERVED_AT);
    record(casino, { activityKey: "holdem", participantUserIds: ["alice"], participationKey: "at-end" });

    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    const keys = payload.activityDays.map((d) => d.activityKey).sort();
    expect(keys).toEqual(["poker", "slots"]); // before-start / at-endは含まれない
  });
});

describe("M. deep freeze（§17M）", () => {
  it("payload/activityDays array/entryまでfreezeされる", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_activity_days", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.activityDays)).toBe(true);
    expect(Object.isFrozen(payload.activityDays[0])).toBe(true);
    expect(() => {
      (payload.activityDays as unknown[]).push({});
    }).toThrow();
  });
});

describe("N. forged scope reject（§17N）", () => {
  it("手書きscopeはfail-closed", () => {
    const { db } = setup();
    const forged = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    expect(() => readTitleSource(db, "casino_activity_days", "alice", forged as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });
});

describe("O. unknown stored activity key → fail-closed（§17O）", () => {
  it("DBへ直接不正なactivity_keyが入っていても、そのfactは無視される（例外で全体を落とさない）", () => {
    const { db, store } = setup();
    db.prepare(
      `INSERT INTO casino_participations (participation_key, user_id, activity_key, occurred_at) VALUES (?, ?, ?, ?)`,
    ).run("corrupt-1", "alice", "future_unknown_game", BASE - 50_000);
    const scope = resolveTitleScope(store, CASINO_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_activity_days", "alice", scope)).toEqual({ activityDays: [] });
  });
});

describe("P. orderable:true ruleがsafe occurredAtをearnedAtへ使える（§17P）", () => {
  it("casino_activity_daysに依存するruleはearnedAtを主張してもrejectされない", async () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    record(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const { evaluateTitle } = await import("../src/titles/v2-evaluator.js");
    const goodRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.casino-orderable-ok",
        name: "test",
        description: "テスト用fixture",
        sources: ["casino_activity_days"] as const,
        triggers: ["game_completed"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE - 50_000, awardFacts: {} }) },
    );
    const result = evaluateTitle(db, store, goodRule, "alice", OBSERVED_AT);
    expect(result.earnedAt).toBe(BASE - 50_000);
  });
});
