import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import {
  defineTitleRule,
  evaluateBatch,
  evaluateTitle,
  evaluateUser,
  type TitleRule,
} from "../src/titles/v2-evaluator.js";
import { assertSourceReaderCoverage, readTitleSource } from "../src/titles/v2-sources.js";
import { resolveTitleScope, type TitleEventScopeProvider } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

/** JST 2026-08-20 00:00:00 を秒0とする、テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const OBSERVED_AT = BASE + 1000;

// derived.ts経由のVC sourceはobservedAt省略時にDate.now()を見る（今回は明示的に渡すため
// 直接は関係ないが、他のtitles-v2系テストとの一貫性のため固定しておく）。
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((BASE + 500_000) * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  // bump_events table は BumpCounter のconstructorで初めて用意される（bootstrap.tsの
  // 主DDLには含まれない）。BumpCounterを直接使わないテストでもsource readerがこの表を
  // 読むため、setup()の時点で必ず存在させておく。
  new BumpCounter(db);
  // clockは可変にする: catalog施行時（SYSTEM_EPOCH/catalog epochになる）はテストデータ
  // より十分前、施行後（award()のawardedAtに使われる）はテストで使うearnedAtより
  // 十分後へ進める。固定clockだと「earnedAtがawardedAtより未来」でstore.award()自体が
  // 落ちてしまう（BASEを起点にearnedAtを組み立てるfixtureが多いため）。
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  // scope:{type:"global"}はSYSTEM_EPOCHを、scope:{type:"catalog"|"month"|"event"}は
  // catalog "test"のepochを要求する。resolveTitleScope()はfail-closedなので、
  // evaluateTitle系のテストは先にcatalogを施行しておく。
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" });
  clock = BASE + 10_000_000;
  return { db, store };
}

function insertVcSegment(
  db: ReturnType<typeof openDb>,
  userId: string,
  channelId: string,
  startedAt: number,
  endedAt: number | null,
  endQuality: "observed" | "recovered_estimate" | null,
  startReason: "join" | "move" | "state_change" | null = "join",
) {
  db.prepare(
    `INSERT INTO vc_segments (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
     VALUES (?, ?, NULL, ?, ?, 0, 0, ?, ?)`,
  ).run(userId, channelId, startedAt, endedAt, endQuality, startReason);
}

// ─────────────────────────────────────────────────────────────
// テスト用fixture rule（production keyとして使わない。必ず v2.test.* 名前空間）
// ─────────────────────────────────────────────────────────────

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

/** orderable:trueなbump_eventsだけを使う。3回目のBUMPの実時刻を正確にearnedAtとして返す。 */
const THIRD_BUMP_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.third-bump",
    name: "test: 3rd bump",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    triggers: ["bump_success"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  {
    awardFactsVersion: 1,
    evaluate: (ctx) => {
      const events = ctx.sources.bump_events.events;
      if (events.length < 3) return { matched: false, earnedAt: null };
      return { matched: true, earnedAt: events[2]!, awardFacts: { bumpCount: events.length } };
    },
  },
);

/** 常にmatchedになるだけの最小fixture（award flowのテスト用）。 */
const ALWAYS_MATCH_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.always-match",
    name: "test: always match",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    triggers: ["bump_success"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
);

const DISABLED_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.disabled",
    name: "test: disabled",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    triggers: ["bump_success"],
    lifecycle: "disabled",
    ...COMMON_FIXTURE_FIELDS,
  },
  {
    awardFactsVersion: 1,
    evaluate: () => {
      throw new Error("disabled titleのevaluate()は呼ばれてはいけない");
    },
  },
);

const RETIRED_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.retired",
    name: "test: retired",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    triggers: ["bump_success"],
    lifecycle: "retired",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
);

/** orderable:falseなVC sourceからearnedAtを主張しようとする、わざと壊れたfixture。 */
const BAD_VC_EARNED_AT_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.bad-vc-earned-at",
    name: "test: bad earnedAt",
    description: "テスト用fixture",
    sources: ["vc_empty_start_then_joined"] as const,
    triggers: ["vc_activity"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  {
    awardFactsVersion: 1,
    evaluate: (ctx) => {
      const fact = ctx.sources.vc_empty_start_then_joined.facts[0];
      if (!fact) return { matched: false, earnedAt: null };
      return { matched: true, earnedAt: fact.joinedAt, awardFacts: {} };
    },
  },
);

const VC_EMPTY_START_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.empty-start",
    name: "test: empty start",
    description: "テスト用fixture",
    sources: ["vc_empty_start_then_joined"] as const,
    triggers: ["vc_activity"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  {
    awardFactsVersion: 1,
    evaluate: (ctx) => {
      if (ctx.sources.vc_empty_start_then_joined.facts.length === 0) return { matched: false, earnedAt: null };
      return { matched: true, earnedAt: null, awardFacts: {} };
    },
  },
);

const SOCIAL_SAFE_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.social-safe",
    name: "test: social safe",
    description: "テスト用fixture",
    sources: ["vc_social_safe"] as const,
    triggers: ["vc_activity"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  {
    awardFactsVersion: 1,
    evaluate: (ctx) => {
      if (ctx.sources.vc_social_safe.distinctCoPresentUsers === 0) return { matched: false, earnedAt: null };
      return { matched: true, earnedAt: null, awardFacts: { ...ctx.sources.vc_social_safe } };
    },
  },
);

const GROUP_SIZE_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.group-size",
    name: "test: group size",
    description: "テスト用fixture",
    sources: ["vc_group_size_seconds"] as const,
    triggers: ["vc_activity"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  {
    awardFactsVersion: 1,
    evaluate: (ctx) => ({ matched: true, earnedAt: null, awardFacts: { ...ctx.sources.vc_group_size_seconds } }),
  },
);

/** scope:{type:"month"}のrule。異なる月にobservedAtを渡すと別scopeKeyになることの確認用。 */
const MONTHLY_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.monthly",
    name: "test: monthly",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    triggers: ["bump_success"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
    scope: { type: "month" },
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
);

/** scope:{type:"event"}のrule。TitleEventScopeProviderが無いと解決できないことの確認用。 */
const EVENT_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.event",
    name: "test: event",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    triggers: ["event_completed"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
    scope: { type: "event", eventKey: "test-event" },
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
);

// ─────────────────────────────────────────────────────────────

describe("source reader completeness（§4, §8）", () => {
  it("titleUsable:trueな全sourceにreaderが存在する", () => {
    expect(() => assertSourceReaderCoverage()).not.toThrow();
  });

  it("registryだけ登録されてreaderが無いsourceはfail-closedで検出する", () => {
    const broken = {
      ...TITLE_SOURCES,
      made_up_source: { ...TITLE_SOURCES.bump_events, titleUsable: true },
    };
    expect(() => assertSourceReaderCoverage(broken as never)).toThrow(/missing source reader/);
  });

  it("vc_segmentsをruleから読めない", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, THIRD_BUMP_RULE.definition, OBSERVED_AT);
    expect(() => readTitleSource(db, "vc_segments" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("vc_visitsをruleから読めない", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, THIRD_BUMP_RULE.definition, OBSERVED_AT);
    expect(() => readTitleSource(db, "vc_visits" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("vc_co_presenceをruleから読めない", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, THIRD_BUMP_RULE.definition, OBSERVED_AT);
    expect(() => readTitleSource(db, "vc_co_presence" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("bump_countsをruleから読めない", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, THIRD_BUMP_RULE.definition, OBSERVED_AT);
    expect(() => readTitleSource(db, "bump_counts" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("as anyで禁止sourceを要求してもruntimeでreject（defineTitleRuleを迂回した場合も）", () => {
    const { db, store } = setup();
    const badRule: TitleRule<never> = {
      definition: {
        kind: "behavior",
        key: "v2.test.bad-source",
        name: "bad",
        description: "raw sourceへ直接アクセスしようとする壊れたrule",
        sources: ["vc_segments"] as never,
        triggers: ["vc_activity"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      awardFactsVersion: 1,
      evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }),
    };
    expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(/not usable by titles/);
  });

  it("ruleが宣言していないsourceへアクセスできない（contextに存在しない）", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);

    let observedUndeclared: unknown = "not-checked";
    const rule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.undeclared-access",
        name: "test",
        description: "テスト用fixture",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: (ctx) => {
          // vc_social_safeは宣言していないので、contextに実体として存在しないはず
          observedUndeclared = (ctx.sources as Record<string, unknown>).vc_social_safe;
          return { matched: false, earnedAt: null };
        },
      },
    );

    evaluateTitle(db, store, rule, "alice", OBSERVED_AT);
    expect(observedUndeclared).toBeUndefined();
  });

  it("defineTitleRule()を迂回して手で組み立てたsources:[]のruleはevaluateTitle()でreject", () => {
    const { db, store } = setup();
    // defineTitleRule()を通さず直接TitleRuleを組み立てる。sources:[]はdefineBehaviorTitle()
    // なら「at least one source is required」で拒否されるが、evaluateTitleが再検証しないと
    // 「何も読まずに任意のearnedAtでaward」まで通ってしまう。
    const forgedRule: TitleRule<never> = {
      definition: {
        kind: "behavior",
        key: "v2.test.forged",
        name: "forged",
        description: "source contractを迂回しようとする壊れたrule",
        sources: [] as never,
        triggers: ["daily"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      awardFactsVersion: 1,
      evaluate: () => ({ matched: true, earnedAt: BASE, awardFacts: {} }),
    };

    expect(() => evaluateTitle(db, store, forgedRule, "alice", OBSERVED_AT)).toThrow(/at least one source/);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("defineTitleRule()後にdefinitionをas anyで書き換えても、evaluateTitle()が再検証してreject", () => {
    const { db, store } = setup();
    const rule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.tampered",
        name: "tampered",
        description: "テスト用fixture",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE, awardFacts: {} }) },
    );
    // construction後にdefinitionを直接書き換える（TypeScriptのreadonlyはruntimeを守らない）
    (rule.definition as { sources: unknown }).sources = [];

    expect(() => evaluateTitle(db, store, rule, "alice", OBSERVED_AT)).toThrow(/at least one source/);
    expect(store.listAwards("alice")).toEqual([]);
  });
});

describe("bump_events reader（§15）", () => {
  it("event scopeのendExclusive(completedAt)を守る（observedAtより先の未来ではなく、windowそのものの終端で切る）", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    // global/catalog/monthはobservedAtより先を見ない設計上、必ずeffectiveEnd===observedAt
    // になる（月の途中で評価する限りmonthのendExclusiveより先は見えない）。「window自体の
    // 終端がobservedAtより手前にある」ケースを再現できるのはeventだけ——canonical
    // completedAtは、ずっと後になってから評価してもそこで固定されたまま動かない。
    const eventStart = BASE;
    const eventEnd = BASE + 100;
    bump.addOnce("m1", "alice", eventStart - 10); // イベント開始前 → windowの外
    bump.addOnce("m2", "alice", eventStart); // inclusive start
    bump.addOnce("m3", "alice", eventStart + 50);
    bump.addOnce("m4", "alice", eventEnd); // exclusive end → 含まない

    const provider: TitleEventScopeProvider = {
      resolveEvent: () => ({ start: eventStart, completedAt: eventEnd }),
    };
    // イベント終了のずっと後に評価しても、windowはcompletedAtで打ち切られる。
    const scope = resolveTitleScope(store, EVENT_RULE.definition, eventEnd + 10_000, { eventProvider: provider });
    const payload = readTitleSource(db, "bump_events", "alice", scope);
    expect(payload.events).toEqual([eventStart, eventStart + 50]);
  });

  it("created_at ASC の順で返す", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    // 挿入順をわざと逆にする
    bump.addOnce("m3", "alice", BASE + 20);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);

    const scope = resolveTitleScope(store, THIRD_BUMP_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "bump_events", "alice", scope);
    expect(payload.events).toEqual([BASE, BASE + 10, BASE + 20]);
  });

  it("observedAtより後のBUMPは読まない（VC readerと同じ時間軸に揃える）", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE + 20);
    bump.addOnce("m2", "alice", BASE + 80); // observedAtより後

    // global scopeはopen-ended（endExclusive=null）なので、effectiveEndは常にobservedAt。
    const scope = resolveTitleScope(store, THIRD_BUMP_RULE.definition, BASE + 50);
    const payload = readTitleSource(db, "bump_events", "alice", scope);
    expect(payload.events).toEqual([BASE + 20]);
  });
});

describe("VC source reader はPR2 observedAt契約をそのまま使う（§16, §18）", () => {
  it("observedAtをPR2 APIへ渡し、まだ観測していない未来分を計上しない", () => {
    const { db, store } = setup();
    // aliceは開いたまま（未クローズ）。observedAt=BASE+50でしか観測していない。
    insertVcSegment(db, "alice", "vc1", BASE, null, null, "join");

    const scope = resolveTitleScope(store, GROUP_SIZE_RULE.definition, BASE + 50);
    const payload = readTitleSource(db, "vc_group_size_seconds", "alice", scope);
    const total = Object.values(payload.trustedSecondsByBucket).reduce((a, b) => a + b, 0);
    expect(total).toBe(50); // globalのendExclusive(null)ではなくobservedAt(+50)で打ち切られる
    expect(payload.untrustedSeconds).toBe(0);
  });
});

describe("source cache（§9）", () => {
  it("複数ruleが同じsourceを使っても、1 batch内でreaderは1回だけ実行される", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    const prepareSpy = vi.spyOn(db, "prepare");
    const countBefore = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM bump_events")).length;

    evaluateUser(db, store, [THIRD_BUMP_RULE, ALWAYS_MATCH_RULE], "alice", OBSERVED_AT);

    const countAfter = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM bump_events")).length;
    expect(countAfter - countBefore).toBe(1);
  });

  it("evaluateBatchでも、複数user×複数ruleにわたってuser単位でしか読み直さない", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "bob", BASE);

    const prepareSpy = vi.spyOn(db, "prepare");
    const countBefore = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM bump_events")).length;

    evaluateBatch(db, store, [THIRD_BUMP_RULE, ALWAYS_MATCH_RULE], ["alice", "bob"], OBSERVED_AT);

    const countAfter = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM bump_events")).length;
    // alice分1回 + bob分1回 = 2回（2 rule × 2 userでも4回にはならない）
    expect(countAfter - countBefore).toBe(2);
  });
});

describe("award flow（§12、PR B1: facts/ownership込みのatomic award）", () => {
  it("matched=false → award無し", () => {
    const { db, store } = setup();
    const result = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);
    expect(result.outcome).toBe("not_matched");
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("matched=true → award・facts・ownershipがまとめて作成される", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    const result = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);
    expect(result.outcome).toBe("awarded");
    expect(result.ownershipCreated).toBe(true);
    expect(store.listAwards("alice")).toHaveLength(1);

    const facts = store.awardFacts("alice", "v2.test.third-bump", result.scopeKey!);
    expect(facts?.data).toEqual({ bumpCount: 3 });

    const ownership = store.ownership("alice", "v2.test.third-bump");
    expect(ownership).toMatchObject({
      user_id: "alice",
      title_key: "v2.test.third-bump",
      first_scope_key: result.scopeKey,
      acquisition_sequence: 1,
      holder_count_at_acquisition: 1,
    });
  });

  it("同じevaluationを2回 → awardは1件だけ、factsもownershipも書き換わらない", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    const first = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);
    const factsBefore = store.awardFacts("alice", "v2.test.third-bump", first.scopeKey!);
    const ownershipBefore = store.ownership("alice", "v2.test.third-bump");

    const second = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);
    expect(second.outcome).toBe("already_awarded");
    expect(second.ownershipCreated).toBe(false);
    expect(store.listAwards("alice")).toHaveLength(1);
    expect(store.awardFacts("alice", "v2.test.third-bump", first.scopeKey!)).toEqual(factsBefore);
    expect(store.ownership("alice", "v2.test.third-bump")).toEqual(ownershipBefore);
  });

  it("既存awardは上書きしない", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);
    const before = store.listAwards("alice")[0];
    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);
    const after = store.listAwards("alice")[0];
    expect(after).toEqual(before);
  });

  it("scopeKey違い（月をまたぐ）なら別award可能だが、titleKeyのownershipは1つのまま増えない", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);

    // setup()のcatalog epochはBASE-100_000（BASE=2026-08-20T00:00 JST）——8/19夕方頃。
    // observedAtがcatalog epochより前だと「まだcatalogが施行されていない時点を評価する」
    // 無意味な状態になり、resolveTitleScope()のobservedAt<start fail-closedに引っかかる
    // ため、epoch施行後の8月内の時刻を使う。
    const augObservedAt = Math.floor(new Date("2026-08-25T00:00:00+09:00").getTime() / 1000);
    const sepObservedAt = Math.floor(new Date("2026-09-15T00:00:00+09:00").getTime() / 1000);

    const aug = evaluateTitle(db, store, MONTHLY_RULE, "alice", augObservedAt);
    const sep = evaluateTitle(db, store, MONTHLY_RULE, "alice", sepObservedAt);
    expect(aug.scopeKey).not.toBe(sep.scopeKey);
    expect(store.listAwards("alice")).toHaveLength(2);

    // awardは2行、factsもscopeごと2行——だがownershipは(user,title)で1行だけで、
    // 最初のscope(aug)をfirstとして持ち続ける。
    expect(store.awardFacts("alice", "v2.test.monthly", aug.scopeKey!)).not.toBeNull();
    expect(store.awardFacts("alice", "v2.test.monthly", sep.scopeKey!)).not.toBeNull();
    const ownership = store.ownership("alice", "v2.test.monthly");
    expect(ownership?.first_scope_key).toBe(aug.scopeKey);
    expect(ownership?.acquisition_sequence).toBe(1);
    expect(sep.ownershipCreated).toBe(false);
  });

  it("disabled titleはawardしない（evaluate()自体を呼ばない）", () => {
    const { db, store } = setup();
    const result = evaluateTitle(db, store, DISABLED_RULE, "alice", OBSERVED_AT);
    expect(result.outcome).toBe("skipped");
    expect(result.matched).toBe(false);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("retired titleは新規awardしない", () => {
    const { db, store } = setup();
    const result = evaluateTitle(db, store, RETIRED_RULE, "alice", OBSERVED_AT);
    expect(result.outcome).toBe("skipped");
    expect(result.matched).toBe(true);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("retired titleの既存awardは保持される（消えないし増えない）", () => {
    const { db, store } = setup();
    const preScope = resolveTitleScope(store, RETIRED_RULE.definition, OBSERVED_AT);
    store.award({
      userId: "alice",
      titleKey: "v2.test.retired",
      scope: preScope,
      earnedAt: null,
      awardFacts: { version: 1, data: {} },
    });

    const result = evaluateTitle(db, store, RETIRED_RULE, "alice", OBSERVED_AT);
    expect(result.outcome).toBe("already_awarded");
    expect(store.listAwards("alice")).toHaveLength(1);
  });
});

describe("earnedAt contract（§11）", () => {
  it("orderable:trueのみに依存するruleは正確なearnedAtを保存できる", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    const result = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);
    expect(result.earnedAt).toBe(BASE + 20);
    expect(store.listAwards("alice")[0]!.earned_at).toBe(BASE + 20);
  });

  it("orderable:false sourceを含むruleがnon-null earnedAtを返したらreject", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE + 50, BASE + 80, "observed");

    expect(() => evaluateTitle(db, store, BAD_VC_EARNED_AT_RULE, "alice", OBSERVED_AT)).toThrow(/non-orderable/);
  });

  it("earnedAt unknownならNULLのまま保存する", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE + 50, BASE + 80, "observed");

    const result = evaluateTitle(db, store, VC_EMPTY_START_RULE, "alice", OBSERVED_AT);
    expect(result.outcome).toBe("awarded");
    expect(result.earnedAt).toBeNull();
    expect(store.listAwards("alice")[0]!.earned_at).toBeNull();
  });

  it("reconcile時刻をearnedAtの代用にしない（後日の再評価でも確定済みearnedAtは変わらない）", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT);

    // 後日のreconcileを模す: THIRD_BUMP_RULEはglobal scopeなので、observedAtを
    // ずらしてもscopeKeyは変わらない。同じscopeへ再評価しても、
    // 一度確定したearned_atをreconcileを走らせた時刻へ書き換えない。
    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT + 100_000);

    expect(store.listAwards("alice")[0]!.earned_at).toBe(BASE + 20);
  });
});

describe("evaluator所有のsnapshot（rule実行中の契約object書き換え対策）", () => {
  it("evaluate()実行中にrule.definition.sourcesを改竄しても、orderable判定は改竄前のsnapshotを使う", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE + 50, BASE + 80, "observed");

    // eslint的には`const`にしたいところだが、evaluate()から自分自身(rule.definition)を
    // 書き換えるにはrule変数を閉じ込める必要がある。
    let selfMutatingRule!: TitleRule<readonly ["vc_empty_start_then_joined"]>;
    selfMutatingRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.self-mutating-sources",
        name: "test",
        description: "評価中に自分のdefinition.sourcesをorderable:trueなsourceへ改竄する",
        sources: ["vc_empty_start_then_joined"] as const,
        triggers: ["vc_activity"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: () => {
          // orderable:falseなVC sourceのruleのはずなのに、評価中にorderable:trueな
          // bump_eventsへ差し替えて、直後のearnedAt検証をすり抜けようとする。
          (selfMutatingRule.definition as { sources: unknown }).sources = ["bump_events"];
          return { matched: true, earnedAt: BASE + 999, awardFacts: {} };
        },
      },
    );

    expect(() => evaluateTitle(db, store, selfMutatingRule, "alice", OBSERVED_AT)).toThrow(/non-orderable/);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("ruleがctx.scope.scopeKeyを改竄しても、awardは元のscopeKeyを使う", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);

    const scopeHijackRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.scope-hijack",
        name: "test",
        description: "ctx.scopeを書き換えてaward先scopeをズラそうとする",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: (ctx) => {
          (ctx.scope as { scopeKey: string }).scopeKey = "hijacked-scope";
          return { matched: true, earnedAt: null, awardFacts: {} };
        },
      },
    );

    const expectedScopeKey = resolveTitleScope(store, scopeHijackRule.definition, OBSERVED_AT).scopeKey;
    const result = evaluateTitle(db, store, scopeHijackRule, "alice", OBSERVED_AT);
    expect(result.scopeKey).toBe(expectedScopeKey);

    const awards = store.listAwards("alice");
    expect(awards).toHaveLength(1);
    expect(awards[0]!.scope_key).toBe(expectedScopeKey);
  });

  it("先行ruleがcached payloadを書き換えようとしても、後続ruleは汚染されていない値を見る", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    let mutationAttemptThrew = false;
    const tamperingRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.tamper-payload",
        name: "test",
        description: "cacheされたpayloadを直接書き換えようとする",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: (ctx) => {
          try {
            (ctx.sources.bump_events.events as number[]).push(999_999_999);
          } catch {
            mutationAttemptThrew = true;
          }
          return { matched: false, earnedAt: null };
        },
      },
    );

    // tamperingRuleとTHIRD_BUMP_RULEは同じuser/scope/bump_eventsを共有するので、
    // cacheが1回だけ読んだ同じpayload objectをどちらも受け取る。
    const [, thirdBumpResult] = evaluateUser(db, store, [tamperingRule, THIRD_BUMP_RULE], "alice", OBSERVED_AT);

    expect(mutationAttemptThrew).toBe(true); // freezeされているので書き込みは例外になる
    expect(thirdBumpResult!.earnedAt).toBe(BASE + 20); // 汚染されず3件のまま読める
  });
});

describe("awardFacts safety（§10, §12）", () => {
  it("awardFactsへrestricted counterpart IDが出ない", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE, BASE + 100, "observed");

    const result = evaluateTitle(db, store, SOCIAL_SAFE_RULE, "alice", OBSERVED_AT);
    expect(JSON.stringify(result.awardFacts)).not.toContain("bob");
    expect(result.awardFacts).toEqual({
      distinctCoPresentUsers: 1,
      maxRepeatedDaysWithOneCounterpart: expect.any(Number),
      trustedOverlapSeconds: 100,
    });
  });

  it("matchedなのにawardFactsが契約違反な壊れたruleはfail-closedする（DBへは何も書かない）", () => {
    const { db, store } = setup();
    const badFactsRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.bad-facts",
        name: "test",
        description: "awardFactsに識別子を混入させる壊れたrule",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: () => ({ matched: true, earnedAt: null, awardFacts: { userId: "alice" } }),
      },
    );

    expect(() => evaluateTitle(db, store, badFactsRule, "alice", OBSERVED_AT)).toThrow(/forbidden key/);
    expect(store.listAwards("alice")).toEqual([]);
  });
});

describe("runtime discriminated-union guard（TypeScriptを迂回したruleへの防御）", () => {
  it("matched:falseなのにearnedAtが非nullなruleはruntimeでreject", () => {
    const { db, store } = setup();
    const badRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.false-with-earned-at",
        name: "test",
        description: "TypeScriptを迂回してmatched:false+非nullなearnedAtを返す壊れたrule",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: () => ({ matched: false, earnedAt: BASE } as never),
      },
    );

    expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(
      /matched:false with a non-null earnedAt/,
    );
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("matched:falseなのにawardFactsを持つruleはruntimeでreject（明示的に拒否する。無視はしない）", () => {
    const { db, store } = setup();
    const badRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.false-with-facts",
        name: "test",
        description: "TypeScriptを迂回してmatched:falseなのにawardFactsを返す壊れたrule",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: () => ({ matched: false, earnedAt: null, awardFacts: {} } as never),
      },
    );

    expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(
      /matched:false with awardFacts set/,
    );
    expect(store.listAwards("alice")).toEqual([]);
  });

  it.each([["false" as never], [0 as never], [1 as never], [null as never]])(
    "matchedが非boolean値（%j）ならruntimeでreject",
    (badMatched) => {
      const { db, store } = setup();
      const badRule = defineTitleRule(
        {
          kind: "behavior",
          key: `v2.test.non-boolean-matched-${String(badMatched)}`,
          name: "test",
          description: "TypeScriptを迂回してmatchedへ非boolean値を返す壊れたrule",
          sources: ["bump_events"] as const,
          triggers: ["bump_success"],
          lifecycle: "active",
          ...COMMON_FIXTURE_FIELDS,
        },
        {
          awardFactsVersion: 1,
          evaluate: () => ({ matched: badMatched, earnedAt: null } as never),
        },
      );

      expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(
        /non-boolean matched value/,
      );
      expect(store.listAwards("alice")).toEqual([]);
    },
  );
});

describe("fail-closed on scope resolution / source reader failure（§24）", () => {
  it("catalog epochが未施行なら、evaluateTitle()は「条件未達」として握り潰さずthrowする", () => {
    const db = openDb(":memory:");
    new BumpCounter(db);
    // applyCatalog()を呼んでいない、まっさらなstore。
    const store = new TitleV2Store(db, () => BASE);

    expect(() => evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", OBSERVED_AT)).toThrow(
      /SYSTEM_EPOCH is not established/,
    );
  });

  it("forgeされたscopeはreadTitleSource()でfail-closedする", () => {
    const { db } = setup();
    const forgedScope = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    expect(() => readTitleSource(db, "bump_events", "alice", forgedScope as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });

  it("event scope providerが無いとevaluateTitle()はfail-closedする", () => {
    const { db, store } = setup();
    expect(() => evaluateTitle(db, store, EVENT_RULE, "alice", OBSERVED_AT)).toThrow(
      /requires a TitleEventScopeProvider/,
    );
    expect(store.listAwards("alice")).toEqual([]);
  });
});

// GROUP_SIZE_RULEはobservedAt伝播テストで型検査用に定義してあるが、
// 上のdescribeブロックでは直接使っていない箇所があるため、未使用警告を避けるために
// 最小限のsanityテストを1件だけ足しておく。
describe("group-size ruleのawardFacts経路", () => {
  it("trustedSecondsByBucketとuntrustedSecondsをawardFactsへそのまま渡せる", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");

    const result = evaluateTitle(db, store, GROUP_SIZE_RULE, "alice", OBSERVED_AT);
    expect(result.awardFacts).toMatchObject({ untrustedSeconds: 0 });
  });
});

describe("root packages/core/src/index.ts からv2 evaluator APIを使える", () => {
  it("TitleV2Store / defineTitleRule / evaluateTitle がroot importだけで動く", async () => {
    const core = await import("../src/index.js");
    const db = openDb(":memory:");
    new BumpCounter(db);
    const store = new core.TitleV2Store(db);
    store.applyCatalog({ catalogKey: "test", actor: "test-setup" });

    const rule = core.defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.root-export",
        name: "test",
        description: "root exportの疎通テスト",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }) },
    );

    const result = core.evaluateTitle(db, store, rule, "alice", Math.floor(Date.now() / 1000));
    expect(result.outcome).toBe("awarded");
  });
});
