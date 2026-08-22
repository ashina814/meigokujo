import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { CasinoParticipationHistory } from "../src/casino/participation-history.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

/**
 * PR F2b: `casino_completed_activity_days`（safe source）のtest。
 * `casino_activity_days`（PR E4、commitmentベース）とは別source——このfileは
 * 新規source（completionベース）だけを対象にする。既存E4 testは変更しない。
 */

/** JST 2026-08-20 00:00:00 を秒0とする、F2bテスト用の基準時刻。 */
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
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" });
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

const CASINO_COMPLETED_ACTIVITY_DAYS_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.casino-completed-activity-days",
    name: "test",
    description: "テスト用fixture",
    sources: ["casino_completed_activity_days"] as const,
    triggers: ["game_completed"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

let seq = 0;
/** commitmentだけ書く（completionは書かない）——B用。 */
function commitOnly(
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

/** commitment→completionの両方を書く（同一clock snapshotで）——ほとんどのtestで使う。 */
function recordCompleted(
  casino: CasinoParticipationHistory,
  opts: { activityKey: string; participantUserIds: readonly string[]; participationKey?: string },
) {
  const key = commitOnly(casino, opts);
  casino.recordCompletedParticipation({
    participationKey: key.participationKey,
    activityKey: opts.activityKey as never,
    participantUserIds: opts.participantUserIds,
  });
  return key;
}

// ─────────────────────────────────────────────────────────────

describe("source contract", () => {
  it("casino_participation_completions: persisted / restricted / titleUsable:false / orderable:true / point at completed_at / restrictedUse casino_safe_completion_classification", () => {
    expect(TITLE_SOURCES.casino_participation_completions).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      titleUsable: false,
      orderable: true,
      epochPolicy: { type: "point", at: "completed_at" },
      restrictedUse: "casino_safe_completion_classification",
    });
  });

  it("casino_completed_activity_days: derived / safe / titleUsable:true / orderable:true / derivedFrom両方 / point completedAt", () => {
    expect(TITLE_SOURCES.casino_completed_activity_days).toMatchObject({
      origin: "derived",
      privacy: "safe",
      titleUsable: true,
      orderable: true,
      epochPolicy: { type: "point", at: "completedAt" },
    });
    expect([...TITLE_SOURCES.casino_completed_activity_days.derivedFrom].sort()).toEqual(
      ["casino_participation_completions", "casino_participations"].sort(),
    );
  });

  it("casino_activity_days（E4既存）は変更されていない", () => {
    expect(TITLE_SOURCES.casino_activity_days).toMatchObject({
      origin: "derived",
      privacy: "safe",
      titleUsable: true,
      derivedFrom: ["casino_participations"],
    });
  });
});

describe("generic raw rejection", () => {
  it("readTitleSource(db, 'casino_participation_completions', ...)はtitleUsable:falseでreject", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(() => readTitleSource(db, "casino_participation_completions" as never, "alice", scope)).toThrow(
      /not usable by titles/,
    );
  });
});

describe("A. completionだけを読む", () => {
  it("aliceが1回blackjackをcompletion → payload 1件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE + 1000);
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(payload.activityDays).toEqual([{ activityKey: "blackjack", activityDate: "2026-08-20", completedAt: BASE + 1000 }]);
  });
});

describe("B. commitment-only rowはcompletion factにならない", () => {
  it("commitmentだけでcompletionを書かないとpayloadは空", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE + 1000);
    commitOnly(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(payload.activityDays).toEqual([]);
  });

  it("commitment+completion両方揃って初めて1件になる", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    const key = commitOnly(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope).activityDays).toEqual([]);

    setCasinoClock(BASE - 40_000);
    casino.recordCompletedParticipation({
      participationKey: key.participationKey,
      activityKey: "blackjack",
      participantUserIds: ["alice"],
    });
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope).activityDays).toHaveLength(1);
  });
});

describe("C. user×activity×JST day collapse", () => {
  it("同日にblackjackを100回completionしても1件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    for (let i = 0; i < 100; i++) {
      recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: `solo:blackjack:op-${i}` });
    }
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(payload.activityDays).toHaveLength(1);
  });

  it("同日にblackjackとslotsをcompletionすると2件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-1" });
    recordCompleted(casino, { activityKey: "slots", participantUserIds: ["alice"], participationKey: "op-2" });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(payload.activityDays.map((d) => d.activityKey).sort()).toEqual(["blackjack", "slots"]);
  });
});

describe("D. JST midnight boundary", () => {
  it("JST 23:59:59 と 00:00:00 は別日扱い", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE + DAY - 1); // JST 2026-08-20 23:59:59
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-1" });
    setCasinoClock(BASE + DAY); // JST 2026-08-21 00:00:00
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "op-2" });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(payload.activityDays.map((d) => d.activityDate).sort()).toEqual(["2026-08-20", "2026-08-21"]);
  });
});

describe("E. completed_at基準でdayを決める（commitmentのoccurred_atの日ではない）", () => {
  it("commitmentがJST 08-20、completionが翌日JST 08-21 → activityDateは08-21", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE + 1000); // JST 2026-08-20
    const key = commitOnly(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    setCasinoClock(BASE + DAY + 1000); // JST 2026-08-21（翌日にcompletion）
    casino.recordCompletedParticipation({
      participationKey: key.participationKey,
      activityKey: "blackjack",
      participantUserIds: ["alice"],
    });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(payload.activityDays).toEqual([
      { activityKey: "blackjack", activityDate: "2026-08-21", completedAt: BASE + DAY + 1000 },
    ]);
  });
});

describe("F. [start,end)", () => {
  it("scope開始ちょうどは含み、effectiveEndちょうどは除外する（completed_at基準）", () => {
    const { db, store, casino, setCasinoClock } = setup();
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);

    setCasinoClock(scope.start - 1);
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"], participationKey: "before-start" });
    setCasinoClock(scope.start);
    recordCompleted(casino, { activityKey: "slots", participantUserIds: ["alice"], participationKey: "at-start" });
    setCasinoClock(OBSERVED_AT - 1);
    recordCompleted(casino, { activityKey: "poker", participantUserIds: ["alice"], participationKey: "before-end" });
    setCasinoClock(OBSERVED_AT);
    recordCompleted(casino, { activityKey: "holdem", participantUserIds: ["alice"], participationKey: "at-end" });

    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    const keys = payload.activityDays.map((d) => d.activityKey).sort();
    expect(keys).toEqual(["poker", "slots"]);
  });
});

describe("G. requested users限定", () => {
  it("PVP participantの相手が別userでも、requestしたuserだけがpayloadへ入る", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    recordCompleted(casino, { activityKey: "sashi", participantUserIds: ["alice", "bob"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const cache = new TitleSourceCache();
    const result = cache.prefetch(db, "casino_completed_activity_days", ["alice"], scope);
    expect(result.loaded).toBe(1);
    const bobResult = cache.prefetch(db, "casino_completed_activity_days", ["bob"], scope);
    expect(bobResult.loaded).toBe(1);
  });
});

describe("H. unknown activity key fail-closed", () => {
  it("DBへ直接不正なactivity_key(commitment側)が入っていても、そのfactは無視される", () => {
    const { db, store } = setup();
    db.prepare(
      `INSERT INTO casino_participations (participation_key, user_id, activity_key, occurred_at) VALUES (?, ?, ?, ?)`,
    ).run("corrupt-1", "alice", "future_unknown_game", BASE - 50_000);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("corrupt-1", "alice", BASE - 40_000);
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope)).toEqual({ activityDays: [] });
  });
});

describe("I. payload最小化", () => {
  it("activityKey/activityDate/completedAtだけ", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(Object.keys(payload.activityDays[0]!).sort()).toEqual(["activityDate", "activityKey", "completedAt"]);
  });
});

describe("J. participationKey/session/opponent/amount/result等非漏洩", () => {
  it("参加key・operationId・相手identity・機微データがpayloadへ一切現れない", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    recordCompleted(casino, {
      activityKey: "sashi",
      participantUserIds: ["alice", "bob"],
      participationKey: "pvp:LEAK_SESSION_SECRET",
    });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("LEAK_SESSION_SECRET");
    expect(serialized).not.toContain("bob");
    expect(serialized).not.toContain("wager");
    expect(serialized).not.toContain("payout");
    expect(serialized).not.toContain("winner");
    expect(serialized).not.toContain("loser");
  });
});

describe("K. single/bulk equivalence", () => {
  it("fresh single get == bulk prefetch → get（複数user）", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    recordCompleted(casino, { activityKey: "slots", participantUserIds: ["bob"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);

    const single = new TitleSourceCache();
    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "casino_completed_activity_days", ["alice", "bob"], scope);
    for (const userId of ["alice", "bob"]) {
      expect(bulk.get(db, "casino_completed_activity_days", userId, scope)).toEqual(
        single.get(db, "casino_completed_activity_days", userId, scope),
      );
    }
  });

  it("0件userはactivityDays:[]を明示的に返す", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "nobody", scope)).toEqual({ activityDays: [] });
  });
});

describe("L. deep freeze", () => {
  it("payload/activityDays array/entryまでfreezeされる", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.activityDays)).toBe(true);
    expect(Object.isFrozen(payload.activityDays[0])).toBe(true);
    expect(() => {
      (payload.activityDays as unknown[]).push({});
    }).toThrow();
  });
});

describe("M. orderable:true ruleがsafe completedAtをearnedAtへ使える", () => {
  it("casino_completed_activity_daysに依存するruleはearnedAtを主張してもrejectされない", async () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    recordCompleted(casino, { activityKey: "blackjack", participantUserIds: ["alice"] });
    const { evaluateTitle } = await import("../src/titles/v2-evaluator.js");
    const goodRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.casino-completed-orderable-ok",
        name: "test",
        description: "テスト用fixture",
        sources: ["casino_completed_activity_days"] as const,
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

describe("forged scope reject", () => {
  it("手書きscopeはfail-closed", () => {
    const { db } = setup();
    const forged = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    expect(() => readTitleSource(db, "casino_completed_activity_days", "alice", forged as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });
});

/**
 * PR #166レビューBLOCKER1: `computeCasinoCompletedActivityDays()`は
 * `recordCompletedParticipation()`のwriter-side guardと同じ7条件を、DB corruption
 * （直接SQL・マイグレーションミス等、writer APIを経由しない不整合）に対しても
 * reader側で独立に再検証しなければならない。1条件でも満たさないgroupは、その
 * participationKeyの行をまとめて（1人分だけでも）一切emitしない——ここではすべて
 * writer APIをbypassした直接SQLで不整合を再現する。
 */
describe("N. corrupt partial completion group（BLOCKER1-A / 条件4）", () => {
  it("PVP commitment 2人(alice,bob)に対しcompletion行を直接INSERTでaliceだけ挿入 → alice/bob両方とも0件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    const key = commitOnly(casino, { activityKey: "sashi", participantUserIds: ["alice", "bob"] });
    // recordCompletedParticipation()は全参加者分を同一transactionで書くため、
    // 「bobの行だけ欠落」という部分corruptionはwriter APIでは作れない——直接SQLで再現する。
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run(key.participationKey, "alice", BASE - 40_000);

    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope)).toEqual({ activityDays: [] });
    expect(readTitleSource(db, "casino_completed_activity_days", "bob", scope)).toEqual({ activityDays: [] });
  });
});

describe("O. corrupt mixed completed_at（BLOCKER1-B / 条件5）", () => {
  it("同一participation_keyのcompletion行でcompleted_atが食い違う → 全員0件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 50_000);
    const key = commitOnly(casino, { activityKey: "sashi", participantUserIds: ["alice", "bob"] });
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run(key.participationKey, "alice", BASE - 40_000);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run(key.participationKey, "bob", BASE - 30_000);

    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope)).toEqual({ activityDays: [] });
    expect(readTitleSource(db, "casino_completed_activity_days", "bob", scope)).toEqual({ activityDays: [] });
  });
});

describe("P. corrupt mixed commitment activity_key（BLOCKER1-C / 条件2）", () => {
  it("同一participation_keyのcommitment行でactivity_keyが食い違う → 全員0件", () => {
    const { db, store } = setup();
    db.prepare(
      `INSERT INTO casino_participations (participation_key, user_id, activity_key, occurred_at) VALUES (?, ?, ?, ?)`,
    ).run("corrupt-mixed-activity", "alice", "sashi", BASE - 50_000);
    db.prepare(
      `INSERT INTO casino_participations (participation_key, user_id, activity_key, occurred_at) VALUES (?, ?, ?, ?)`,
    ).run("corrupt-mixed-activity", "bob", "blackjack", BASE - 50_000);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("corrupt-mixed-activity", "alice", BASE - 40_000);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("corrupt-mixed-activity", "bob", BASE - 40_000);

    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope)).toEqual({ activityDays: [] });
    expect(readTitleSource(db, "casino_completed_activity_days", "bob", scope)).toEqual({ activityDays: [] });
  });
});

describe("Q. corrupt mixed commitment occurred_at（BLOCKER1-D / 条件3）", () => {
  it("同一participation_keyのcommitment行でoccurred_atが食い違う → 全員0件", () => {
    const { db, store } = setup();
    db.prepare(
      `INSERT INTO casino_participations (participation_key, user_id, activity_key, occurred_at) VALUES (?, ?, ?, ?)`,
    ).run("corrupt-mixed-occurred", "alice", "sashi", BASE - 50_000);
    db.prepare(
      `INSERT INTO casino_participations (participation_key, user_id, activity_key, occurred_at) VALUES (?, ?, ?, ?)`,
    ).run("corrupt-mixed-occurred", "bob", "sashi", BASE - 45_000);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("corrupt-mixed-occurred", "alice", BASE - 40_000);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("corrupt-mixed-occurred", "bob", BASE - 40_000);

    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope)).toEqual({ activityDays: [] });
    expect(readTitleSource(db, "casino_completed_activity_days", "bob", scope)).toEqual({ activityDays: [] });
  });
});

describe("R. corrupt completed_at < occurred_at（BLOCKER1-E / 条件6）", () => {
  it("completed_atがoccurred_atより前 → 全員0件", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE - 40_000);
    const key = commitOnly(casino, { activityKey: "sashi", participantUserIds: ["alice", "bob"] });
    // writer APIはcompletedAt<occurredAtをfail-closedでrejectするため、writer APIを
    // bypassした直接SQLでcompletion行を挿入して不整合を再現する。
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run(key.participationKey, "alice", BASE - 50_000);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run(key.participationKey, "bob", BASE - 50_000);

    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "casino_completed_activity_days", "alice", scope)).toEqual({ activityDays: [] });
    expect(readTitleSource(db, "casino_completed_activity_days", "bob", scope)).toEqual({ activityDays: [] });
  });
});

describe("S. positive control（BLOCKER1-F）: 有効なPVP 2人completionは正しくemitされる", () => {
  it("alice/bobとも同一activityKey/activityDate/completedAtの正しい1 factを受け取る（他条件が壊れていないことの対照実験）", () => {
    const { db, store, casino, setCasinoClock } = setup();
    setCasinoClock(BASE + 1000);
    recordCompleted(casino, { activityKey: "sashi", participantUserIds: ["alice", "bob"] });
    const scope = resolveTitleScope(store, CASINO_COMPLETED_ACTIVITY_DAYS_RULE.definition, OBSERVED_AT);
    const alicePayload = readTitleSource(db, "casino_completed_activity_days", "alice", scope);
    const bobPayload = readTitleSource(db, "casino_completed_activity_days", "bob", scope);
    expect(alicePayload.activityDays).toEqual([
      { activityKey: "sashi", activityDate: "2026-08-20", completedAt: BASE + 1000 },
    ]);
    expect(bobPayload.activityDays).toEqual([
      { activityKey: "sashi", activityDate: "2026-08-20", completedAt: BASE + 1000 },
    ]);
  });
});
