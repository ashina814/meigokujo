import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import type { BehaviorTitleDefinition, TitleTrigger } from "../src/titles/v2-contract.js";
import { defineTitleRule, evaluateTitle, type TitleRule } from "../src/titles/v2-evaluator.js";
import { defineMetaTitleRule, type MetaTitleRule } from "../src/titles/v2-meta.js";
import { defineTitleEvaluationPlan, evaluateBatchPipeline, type TitleEvaluationPlan } from "../src/titles/v2-pipeline.js";
import { defineRelationshipTitleRule, type RelationshipTitleRule } from "../src/titles/v2-relationship.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { prefetchBatchPipelineSources } from "../src/titles/v2-prefetch.js";

/** JST 2026-08-20 00:00:00 を秒0とする、prefetchテスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const OBSERVED_AT = BASE + 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  const db = openDb(":memory:");
  const bump = new BumpCounter(db);
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" });
  clock = BASE + 10_000_000;
  return { db, store, bump };
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

function behaviorRule(
  key: `v2.${string}`,
  opts: {
    sources?: readonly ["bump_events"] | readonly ["vc_group_size_seconds"] | readonly ["vc_last_occupant"] | readonly ["bump_events", "vc_group_size_seconds"];
    triggers?: readonly TitleTrigger[];
    lifecycle?: "active" | "retired" | "disabled";
    scope?: BehaviorTitleDefinition["scope"];
  } = {},
): TitleRule<any> {
  const sources = opts.sources ?? (["bump_events"] as const);
  return defineTitleRule(
    {
      kind: "behavior",
      key,
      name: key,
      description: "テスト用fixture",
      sources: sources as readonly ["bump_events"],
      triggers: opts.triggers ?? ["bump_success"],
      lifecycle: opts.lifecycle ?? "active",
      ...COMMON_FIXTURE_FIELDS,
      scope: opts.scope ?? COMMON_FIXTURE_FIELDS.scope,
    },
    { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
  ) as unknown as TitleRule<any>;
}

function relationshipRule(key: `v2.${string}`, lifecycle: "active" | "retired" | "disabled" = "active"): RelationshipTitleRule {
  return defineRelationshipTitleRule(
    {
      kind: "behavior",
      key,
      name: key,
      description: "テスト用relationship fixture",
      sources: ["vc_social_safe"] as const,
      triggers: ["vc_activity"],
      lifecycle,
      ...COMMON_FIXTURE_FIELDS,
    },
    { awardFactsVersion: 1, evaluateCandidate: () => ({ matched: false }) },
  );
}

function metaRule(key: `v2.${string}`): MetaTitleRule {
  return defineMetaTitleRule(
    {
      kind: "meta",
      key,
      name: key,
      description: "テスト用meta fixture",
      lifecycle: "active",
      emoji: "x",
      hidden: false,
      publicAnnounce: false,
      themeKey: "test-meta-theme",
      groupKey: "test-meta-group",
      scope: { type: "global" as const },
    },
    { awardFactsVersion: 1, evaluate: () => ({ matched: false }) },
  );
}

// ─────────────────────────────────────────────────────────────
// TitleSourceCache.prefetch() / bulk reader（v2-sources.ts）
// ─────────────────────────────────────────────────────────────

describe("TitleSourceCache.prefetch()", () => {
  it("single reader（get）とbulk reader（prefetch）はbump_eventsで同一payloadを返す", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "bob", BASE + 5);
    const scope = resolveTitleScope(store, behaviorRule("v2.test.x").definition, OBSERVED_AT);

    const single = new TitleSourceCache();
    const aliceSingle = single.get(db, "bump_events", "alice", scope);
    const bobSingle = single.get(db, "bump_events", "bob", scope);

    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "bump_events", ["alice", "bob"], scope);
    const aliceBulk = bulk.get(db, "bump_events", "alice", scope);
    const bobBulk = bulk.get(db, "bump_events", "bob", scope);

    expect(aliceBulk).toEqual(aliceSingle);
    expect(bobBulk).toEqual(bobSingle);
  });

  it("single/bulkはvc_empty_start_then_joined/vc_last_occupant/vc_group_size_seconds/vc_social_safeでも同一payload（第三者co-presence込み）", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "carol", "vc1", BASE + 50, BASE + 150, "observed");
    const scope = resolveTitleScope(store, behaviorRule("v2.test.y").definition, OBSERVED_AT + 200);

    for (const sourceKey of ["vc_empty_start_then_joined", "vc_last_occupant", "vc_group_size_seconds", "vc_social_safe"] as const) {
      const single = new TitleSourceCache();
      const bulk = new TitleSourceCache();
      bulk.prefetch(db, sourceKey, ["alice", "bob"], scope);
      for (const userId of ["alice", "bob"]) {
        expect(bulk.get(db, sourceKey, userId, scope)).toEqual(single.get(db, sourceKey, userId, scope));
      }
    }
  });

  it("bulk prefetchでcacheされるのは要求したsubject userだけ——co-presenceの相手(第三者)は自分のentryを持たない", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE, BASE + 100, "observed");
    const scope = resolveTitleScope(store, behaviorRule("v2.test.z").definition, OBSERVED_AT + 200);

    const cache = new TitleSourceCache();
    cache.prefetch(db, "vc_group_size_seconds", ["alice"], scope);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.length;
    cache.get(db, "vc_group_size_seconds", "bob", scope); // bobはalice側のprefetchで一緒にcacheされていないはず
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it("first-read-wins: 既にcache済みのuserはbulk読み込みで上書きされない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const scope = resolveTitleScope(store, behaviorRule("v2.test.a").definition, OBSERVED_AT);

    const cache = new TitleSourceCache();
    const before = cache.get(db, "bump_events", "alice", scope);

    // aliceの読み込み後にDBへ新しいBUMPを足しても、既cache済みのaliceは変わらない。
    bump.addOnce("m2", "alice", BASE + 5);
    const { loaded } = cache.prefetch(db, "bump_events", ["alice"], scope);
    expect(loaded).toBe(0);
    expect(cache.get(db, "bump_events", "alice", scope)).toEqual(before);
  });

  it("既にcache済みのuserは、bulk読み込みの発行自体からも除外される（missing setのみ読む）", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "bob", BASE);
    const scope = resolveTitleScope(store, behaviorRule("v2.test.b").definition, OBSERVED_AT);

    const cache = new TitleSourceCache();
    cache.get(db, "bump_events", "alice", scope); // aliceだけ先にcache

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM bump_events")).length;
    const { loaded } = cache.prefetch(db, "bump_events", ["alice", "bob"], scope);
    const after = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM bump_events")).length;

    expect(loaded).toBe(1); // bobだけ新規
    expect(after - before).toBe(1); // 1回のbulk queryだけ（aliceのために追加読み込みしない）
  });

  it("重複したuserIdsはdedupeされ、bulk readerへは1回分しか渡らない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const scope = resolveTitleScope(store, behaviorRule("v2.test.c").definition, OBSERVED_AT);

    const cache = new TitleSourceCache();
    const { loaded } = cache.prefetch(db, "bump_events", ["alice", "alice", "alice"], scope);
    expect(loaded).toBe(1);
  });

  it("userIds=[]でも、forgeされたscopeはfail-closedでreject（空だからvalidationを省略しない）", () => {
    const { db } = setup();
    const forgedScope = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    const cache = new TitleSourceCache();
    expect(() => cache.prefetch(db, "bump_events", [], forgedScope as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });

  it("userIds=[]でも、restricted/未titleUsable sourceはruntime rejectされる（as anyでの迂回込み）", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, behaviorRule("v2.test.d").definition, OBSERVED_AT);
    const cache = new TitleSourceCache();
    expect(() => cache.prefetch(db, "vc_co_presence" as never, [], scope)).toThrow(/not usable by titles/);
    expect(() => cache.prefetch(db, "made_up_source" as never, [], scope)).toThrow(/unknown title source/);
  });

  it("1000+userIdsでもchunkingされ、実際に発行されたreadCallsが2回以上になる", () => {
    const { db, store } = setup();
    const userIds: string[] = [];
    const insert = db.prepare(`INSERT INTO bump_events (message_id, user_id, created_at) VALUES (?, ?, ?)`);
    for (let i = 0; i < 1000; i++) {
      const userId = `user-${i}`;
      userIds.push(userId);
      insert.run(`m-${i}`, userId, BASE);
    }
    const scope = resolveTitleScope(store, behaviorRule("v2.test.chunk").definition, OBSERVED_AT);

    const cache = new TitleSourceCache();
    const { loaded, readCalls } = cache.prefetch(db, "bump_events", userIds, scope);
    expect(loaded).toBe(1000);
    expect(readCalls).toBeGreaterThan(1); // 300-user chunkingで最低4回

    // 全userが正しくcacheされている（chunk境界を跨いでも欠落しない）
    expect(cache.get(db, "bump_events", "user-0", scope).events).toEqual([BASE]);
    expect(cache.get(db, "bump_events", "user-999", scope).events).toEqual([BASE]);
  });

  it("zero-width scopeのVC sourceはpayloadをcacheしつつ、実際のderived呼び出し(readCalls)は0のまま", () => {
    const { db, store } = setup();
    const rule = behaviorRule("v2.test.zerowidth-readcalls", { sources: ["vc_group_size_seconds"] });
    const epochRow = store.systemEpoch()!;
    const scope = resolveTitleScope(store, rule.definition, epochRow);

    const cache = new TitleSourceCache();
    const { loaded, readCalls } = cache.prefetch(db, "vc_group_size_seconds", ["alice"], scope);
    expect(loaded).toBe(1);
    expect(readCalls).toBe(0);
  });

  it("group内のchunk読み込みが途中失敗したら、そのgroupは何もcacheへ反映しない（all-or-nothing per group）", () => {
    const { db, store } = setup();
    const userIds: string[] = [];
    const insert = db.prepare(`INSERT INTO bump_events (message_id, user_id, created_at) VALUES (?, ?, ?)`);
    for (let i = 0; i < 700; i++) {
      const userId = `chunkuser-${i}`;
      userIds.push(userId);
      insert.run(`cm-${i}`, userId, BASE);
    }
    const scope = resolveTitleScope(store, behaviorRule("v2.test.chunkfail").definition, OBSERVED_AT);

    let matchingCalls = 0;
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("FROM bump_events") && sql.includes(" IN (")) {
        matchingCalls += 1;
        if (matchingCalls === 2) {
          throw new Error("simulated chunk failure");
        }
      }
      return originalPrepare(sql);
    });

    const cache = new TitleSourceCache();
    expect(() => cache.prefetch(db, "bump_events", userIds, scope)).toThrow(/simulated chunk failure/);

    vi.restoreAllMocks();
    // chunk 1で読めたはずのuserも、一切cacheへ反映されていない(改めて読み直しが発生する)。
    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.length;
    cache.get(db, "bump_events", "chunkuser-0", scope);
    expect(prepareSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it("payloadはdeep-freezeされる（single readerと同じ契約）", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const scope = resolveTitleScope(store, behaviorRule("v2.test.freeze").definition, OBSERVED_AT);

    const cache = new TitleSourceCache();
    cache.prefetch(db, "bump_events", ["alice"], scope);
    const payload = cache.get(db, "bump_events", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.events)).toBe(true);
    expect(() => {
      (payload.events as number[]).push(999);
    }).toThrow();
  });

  it("公開APIに任意payloadを注入できるmethod（set/seed/primeWithPayload/bulkReadRaw）は存在しない", () => {
    const cache = new TitleSourceCache() as unknown as Record<string, unknown>;
    expect(cache.set).toBeUndefined();
    expect(cache.seed).toBeUndefined();
    expect(cache.primeWithPayload).toBeUndefined();
    expect(cache.bulkReadRaw).toBeUndefined();
  });

  it("zero-width scope(effectiveEnd<=start)はVC derived関数を呼ばず空payloadを返す", () => {
    const { db, store } = setup();
    // globalスコープでobservedAt===epoch施行直後にすると、effectiveEnd===startになり得る。
    const rule = behaviorRule("v2.test.zerowidth", { sources: ["vc_group_size_seconds"] });
    const epochRow = store.systemEpoch()!;
    const scope = resolveTitleScope(store, rule.definition, epochRow);

    const cache = new TitleSourceCache();
    const { loaded } = cache.prefetch(db, "vc_group_size_seconds", ["alice"], scope);
    expect(loaded).toBe(1);
    expect(cache.get(db, "vc_group_size_seconds", "alice", scope)).toEqual({
      trustedSecondsByBucket: { solo: 0, oneToOne: 0, smallGroup: 0, largeGroup: 0 },
      untrustedSeconds: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// prefetchBatchPipelineSources()（v2-prefetch.ts、高レベルplanner）
// ─────────────────────────────────────────────────────────────

describe("prefetchBatchPipelineSources() — grouping", () => {
  it("複数titleが同じ(source, scope)を宣言していれば1 groupへmergeする", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const ruleA = behaviorRule("v2.test.group-merge-a", { triggers: ["bump_success"] });
    const ruleB = behaviorRule("v2.test.group-merge-b", { triggers: ["bump_success"] });
    const plan = defineTitleEvaluationPlan([ruleA, ruleB], []);

    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(1);
    expect(summary.cacheEntriesLoaded).toBe(1);
  });

  it("同じsourceでもscopeKeyが違えば別groupのまま(monthとglobal)", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const globalRule = behaviorRule("v2.test.split-global", { scope: { type: "global" } });
    const monthRule = behaviorRule("v2.test.split-month", { scope: { type: "month" } });
    const plan = defineTitleEvaluationPlan([globalRule, monthRule], []);

    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(2);
  });

  it("1ruleが複数sourceを宣言していれば、source数ぶんのgroupができる", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.multi-source", { sources: ["bump_events", "vc_group_size_seconds"] });
    const plan = defineTitleEvaluationPlan([rule], []);

    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(2);
  });

  it("scope解決はuser単位ではなくrule単位で1回だけ(100人分でも1回)", () => {
    const { db, store, bump } = setup();
    const userIds = Array.from({ length: 100 }, (_, i) => `user-${i}`);
    for (const userId of userIds) bump.addOnce(`m-${userId}`, userId, BASE);
    const rule = behaviorRule("v2.test.scope-once");
    const plan = defineTitleEvaluationPlan([rule], []);

    const systemEpochSpy = vi.spyOn(store, "systemEpoch");
    prefetchBatchPipelineSources(db, store, plan, userIds, OBSERVED_AT, "bump_success");
    // globalスコープのresolveTitleScope()はstore.systemEpoch()を1回読む——rule単位で1回だけ
    // 呼ばれるはずで、userの数(100)だけ呼ばれてはいけない。
    expect(systemEpochSpy.mock.calls.length).toBe(1);
  });
});

describe("prefetchBatchPipelineSources() — trigger filtering", () => {
  function buildAbcPlan() {
    const ruleA = behaviorRule("v2.test.trigger-a", { sources: ["vc_group_size_seconds"], triggers: ["vc_activity"] });
    const ruleB = behaviorRule("v2.test.trigger-b", { sources: ["bump_events"], triggers: ["daily"] });
    const ruleC = behaviorRule("v2.test.trigger-c", { sources: ["vc_last_occupant"], triggers: ["vc_activity", "daily"] });
    return defineTitleEvaluationPlan([ruleA, ruleB, ruleC], []);
  }

  it("vc_activity triggerでは、vc_activityを宣言したruleのsourceだけがgroup化される", () => {
    const { db, store } = setup();
    const plan = buildAbcPlan();
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "vc_activity");
    expect(summary.plannedGroups).toBe(2); // ruleA(vc_group_size_seconds) + ruleC(vc_last_occupant)
  });

  it("daily triggerでは、dailyを宣言したruleのsourceだけがgroup化される", () => {
    const { db, store } = setup();
    const plan = buildAbcPlan();
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "daily");
    expect(summary.plannedGroups).toBe(2); // ruleB(bump_events) + ruleC(vc_last_occupant)
  });

  it("どのruleも宣言していないtriggerでは、daily等を魔法triggerとして全rule評価しない(0 group)", () => {
    const { db, store } = setup();
    const plan = buildAbcPlan();
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(0);
  });
});

describe("prefetchBatchPipelineSources() — lifecycle", () => {
  it("active titleはprefetch対象", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.lifecycle-active", { lifecycle: "active" });
    const plan = defineTitleEvaluationPlan([rule], []);
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(1);
  });

  it("retired titleもprefetch対象(evaluateTitle()がretiredでもsourceを読む既存契約に合わせる)", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.lifecycle-retired", { lifecycle: "retired" });
    const plan = defineTitleEvaluationPlan([rule], []);
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(1);
    expect(summary.cacheEntriesLoaded).toBe(1);
  });

  it("disabled titleはscope解決も含め完全にskip", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    // eventスコープのdisabled ruleはeventProviderが無いと本来resolveTitleScope()がthrowする
    // ——disabledならscope解決自体が起きないので、eventProvider無しでも例外にならないはず。
    const rule = behaviorRule("v2.test.lifecycle-disabled", {
      lifecycle: "disabled",
      scope: { type: "event", eventKey: "unresolvable-event" },
    });
    const plan = defineTitleEvaluationPlan([rule], []);
    expect(() =>
      prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success"),
    ).not.toThrow();
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(0);
  });
});

describe("prefetchBatchPipelineSources() — relationship / meta exclusion（privacy regression）", () => {
  it("relationship ruleだけのplanは、sourcesが[\"vc_social_safe\"]でもgroup化されない", () => {
    const { db, store } = setup();
    const plan = defineTitleEvaluationPlan([], [], [relationshipRule("v2.test.rel-excl")]);
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "vc_activity");
    expect(summary.plannedGroups).toBe(0);
    expect(summary.executedGroups).toBe(0);
    expect(summary.cacheEntriesLoaded).toBe(0);
  });

  it("meta ruleだけのplanはgroup化されない(sourceを持たない)", () => {
    const { db, store } = setup();
    const plan = defineTitleEvaluationPlan([], [metaRule("v2.test.meta-excl")], []);
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "daily");
    expect(summary.plannedGroups).toBe(0);
  });

  it("restricted-read regression: relationship/metaだけのplanでは、restricted vc_co_presence／vc_segments系のqueryが一切発行されない", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE, BASE + 100, "observed");
    const plan = defineTitleEvaluationPlan([], [metaRule("v2.test.restricted-regression-meta")], [
      relationshipRule("v2.test.restricted-regression-rel"),
    ]);

    const prepareSpy = vi.spyOn(db, "prepare");
    const before = prepareSpy.mock.calls.length;
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "vc_activity");
    const after = prepareSpy.mock.calls.length;

    expect(summary.plannedGroups).toBe(0);
    // relationship rule/meta ruleは対象外なので、plannerは一切DBを読まない
    // (vc_segments/vc_co_presence pairwiseへのqueryも含め、一切発行されない)。
    expect(after).toBe(before);
  });

  it("generic behavior ruleとrelationship ruleが混在していても、relationship側はgroup化されない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const behavior = behaviorRule("v2.test.mixed-behavior");
    const plan = defineTitleEvaluationPlan([behavior], [], [relationshipRule("v2.test.mixed-rel", "active")]);

    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(summary.plannedGroups).toBe(1); // behavior(bump_events)分だけ
  });
});

describe("prefetchBatchPipelineSources() — cache共有 / 既存cache活用", () => {
  it("既にcache済みのuserの一部だけ足りない場合、不足分だけbulk読み込みされる", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "bob", BASE);
    const rule = behaviorRule("v2.test.partial-cache");
    const plan = defineTitleEvaluationPlan([rule], []);

    const cache = new TitleSourceCache();
    const scope = resolveTitleScope(store, rule.definition, OBSERVED_AT);
    cache.get(db, "bump_events", "alice", scope); // aliceだけ先にcache

    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice", "bob"], OBSERVED_AT, "bump_success", {
      cache,
    });
    expect(summary.requestedUniqueUsers).toBe(2);
    expect(summary.cacheEntriesLoaded).toBe(1); // bobだけ新規
  });

  it("重複userIdsはdedupeされる(先出順維持、requestedUniqueUsersに反映)", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.dedup");
    const plan = defineTitleEvaluationPlan([rule], []);

    const { summary } = prefetchBatchPipelineSources(
      db,
      store,
      plan,
      ["alice", "alice", "alice"],
      OBSERVED_AT,
      "bump_success",
    );
    expect(summary.requestedUniqueUsers).toBe(1);
    expect(summary.cacheEntriesLoaded).toBe(1);
  });

  it("callerが渡したcacheをそのまま再利用する(戻り値のcacheがoptions.cacheと同一)", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.reuse-cache");
    const plan = defineTitleEvaluationPlan([rule], []);
    const cache = new TitleSourceCache();

    const { cache: returnedCache } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success", {
      cache,
    });
    expect(returnedCache).toBe(cache);
  });

  it("summaryはidentity-free（userId/titleKeyを含まない）", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.summary-identity-free");
    const plan = defineTitleEvaluationPlan([rule], []);

    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("v2.test.summary-identity-free");
    expect(Object.keys(summary).sort()).toEqual(
      ["bulkReadCalls", "cacheEntriesLoaded", "executedGroups", "plannedGroups", "requestedUniqueUsers"].sort(),
    );
  });
});

describe("prefetchBatchPipelineSources() — plan provenance", () => {
  it("defineTitleEvaluationPlan()を経由しない手書きplanはreject", () => {
    const { db, store } = setup();
    const forged = { behaviorRules: [], metaRules: [], relationshipRules: [] } as unknown as TitleEvaluationPlan;
    expect(() => prefetchBatchPipelineSources(db, store, forged, ["alice"], OBSERVED_AT, "bump_success")).toThrow(
      /not produced by defineTitleEvaluationPlan/,
    );
  });

  it("正規planをshallow copyしてもreject", () => {
    const { db, store } = setup();
    const real = defineTitleEvaluationPlan([behaviorRule("v2.test.provenance-copy")], []);
    const copied = { ...real } as TitleEvaluationPlan;
    expect(() => prefetchBatchPipelineSources(db, store, copied, ["alice"], OBSERVED_AT, "bump_success")).toThrow(
      /not produced by defineTitleEvaluationPlan/,
    );
  });

  it("plan構築後に元ruleのsources/triggers/scope/keyを書き換えても、plannerはcanonical compiled planだけを見る", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.provenance-mutate", { triggers: ["vc_activity"] });
    const plan = defineTitleEvaluationPlan([rule], []);

    // 構築後に、TypeScriptを迂回してtriggers/sources/keyを書き換える。
    (rule.definition as unknown as { triggers: string[] }).triggers = ["daily"];
    (rule.definition as unknown as { sources: string[] }).sources = ["vc_group_size_seconds"];
    (rule.definition as unknown as { key: string }).key = "v2.test.provenance-mutate-hacked";

    // 元triggerだった"vc_activity"で評価するとcompiled plan側は元のtriggers/sourcesを
    // 保持しているため、bump_events groupが1つできるはず(書き換え後のvc_group_size_seconds
    // でも、書き換え後のtrigger("daily")でもない)。
    const { summary } = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "vc_activity");
    expect(summary.plannedGroups).toBe(1);
    expect(summary.cacheEntriesLoaded).toBe(1);

    // 書き換え後のtrigger("daily")では、compiled planは元のtriggersのままなので何も評価されない。
    const dailyResult = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT + 10, "daily");
    expect(dailyResult.summary.plannedGroups).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// TitleSourceCache runtime provenance / trust boundary（PR #158レビュー）
// ─────────────────────────────────────────────────────────────

function fakeStructuralCache(): TitleSourceCache {
  return {
    get() {
      return { events: [1234567890] };
    },
    prefetch() {
      return { loaded: 1, readCalls: 0 };
    },
  } as unknown as TitleSourceCache;
}

describe("TitleSourceCache provenance / trust boundary", () => {
  it("A. structural fake cacheをevaluateTitle()へ渡すとreject——rule.evaluate()に到達しない、award/ownershipも作らない", () => {
    const { db, store } = setup();
    let evaluateCalled = false;
    const rule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.cache-forge-evaluator",
        name: "test",
        description: "cache trust boundary迂回対策のテスト用fixture",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: (ctx) => {
          evaluateCalled = true;
          return ctx.sources.bump_events.events.length >= 1
            ? { matched: true, earnedAt: null, awardFacts: {} }
            : { matched: false, earnedAt: null };
        },
      },
    );

    expect(() => evaluateTitle(db, store, rule, "alice", OBSERVED_AT, { cache: fakeStructuralCache() })).toThrow(
      /not produced by `new TitleSourceCache\(\)`/,
    );
    expect(evaluateCalled).toBe(false);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("B. 同じstructural fake cacheをprefetchBatchPipelineSources()へ渡すとreject", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.cache-forge-prefetch");
    const plan = defineTitleEvaluationPlan([rule], []);

    expect(() =>
      prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success", {
        cache: fakeStructuralCache(),
      }),
    ).toThrow(/not produced by `new TitleSourceCache\(\)`/);
  });

  it("C. 正規cacheの(cache as any).cacheからbacking stateへ到達できない", () => {
    const cache = new TitleSourceCache() as unknown as Record<string, unknown>;
    expect(cache.cache).toBeUndefined();
  });

  it("D. shallow copy({ ...realCache })はreject", () => {
    const { db, store } = setup();
    const real = new TitleSourceCache();
    const copied = { ...real } as unknown as TitleSourceCache;
    const rule = behaviorRule("v2.test.cache-copy");
    expect(() => evaluateTitle(db, store, rule, "alice", OBSERVED_AT, { cache: copied })).toThrow(
      /not produced by `new TitleSourceCache\(\)`/,
    );
  });

  it("E. Proxy(realCache, {})はreject", () => {
    const { db, store } = setup();
    const real = new TitleSourceCache();
    const proxied = new Proxy(real, {}) as TitleSourceCache;
    const rule = behaviorRule("v2.test.cache-proxy");
    expect(() => evaluateTitle(db, store, rule, "alice", OBSERVED_AT, { cache: proxied })).toThrow(
      /not produced by `new TitleSourceCache\(\)`/,
    );
  });

  it("F. Object.create(TitleSourceCache.prototype)はreject", () => {
    const { db, store } = setup();
    const fake = Object.create(TitleSourceCache.prototype) as TitleSourceCache;
    const rule = behaviorRule("v2.test.cache-object-create");
    expect(() => evaluateTitle(db, store, rule, "alice", OBSERVED_AT, { cache: fake })).toThrow(
      /not produced by `new TitleSourceCache\(\)`/,
    );
  });

  it("G. 正常経路: prefetchBatchPipelineSources()が返したcacheをevaluateBatchPipeline()へ渡すとgreen", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const matchRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.cache-happy-path",
        name: "test",
        description: "テスト用fixture",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: (ctx) =>
          ctx.sources.bump_events.events.length >= 1
            ? { matched: true, earnedAt: null, awardFacts: {} }
            : { matched: false, earnedAt: null },
      },
    );
    const plan = defineTitleEvaluationPlan([matchRule], []);

    const prepared = prefetchBatchPipelineSources(db, store, plan, ["alice"], OBSERVED_AT, "bump_success");
    expect(prepared.summary.cacheEntriesLoaded).toBe(1);

    const results = evaluateBatchPipeline(db, store, plan, ["alice"], OBSERVED_AT, "bump_success", {
      cache: prepared.cache,
    });
    expect(results[0]!.behavior[0]!.outcome).toBe("awarded");
    expect(store.hasOwnership("alice", "v2.test.cache-happy-path")).toBe(true);
  });
});

describe("Exploit regression: forged cacheはDBを一切通らずにaward payloadを注入できない", () => {
  it("bump_events 0件でも、forged cacheが返すevents:[123]はevaluation前にrejectされ、award無し", () => {
    const { db, store } = setup(); // bump_eventsは何も挿入していない = 0件

    const rule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.exploit-regression",
        name: "test",
        description: "cache trust boundary迂回のexploit regression test",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: (ctx) =>
          ctx.sources.bump_events.events.length >= 1
            ? { matched: true, earnedAt: null, awardFacts: {} }
            : { matched: false, earnedAt: null },
      },
    );

    const forgedCache = {
      get() {
        return { events: [123] };
      },
    } as unknown as TitleSourceCache;

    expect(() => evaluateTitle(db, store, rule, "alice", OBSERVED_AT, { cache: forgedCache })).toThrow(
      /not produced by `new TitleSourceCache\(\)`/,
    );
    expect(store.listAwards("alice")).toEqual([]);
    expect(store.hasOwnership("alice", "v2.test.exploit-regression")).toBe(false);
  });
});
