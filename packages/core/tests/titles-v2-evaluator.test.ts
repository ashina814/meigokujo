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
import {
  assertSourceReaderCoverage,
  readTitleSource,
  type TitleEvaluationScope,
} from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

/** JST 2026-08-20 00:00:00 を秒0とする、テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);

// derived.ts経由のVC sourceはobservedAt省略時にDate.now()を見る。BASEに近いwindowを
// 使うテストが実行タイミングでflakeにならないよう、十分先へ固定する。
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((BASE + 500_000) * 1000));
});
afterEach(() => vi.useRealTimers());

const scope: TitleEvaluationScope = { scopeKey: "test-scope", start: BASE, end: BASE + 1000, observedAt: BASE + 1000 };

function setup() {
  const db = openDb(":memory:");
  // bump_events table は BumpCounter のconstructorで初めて用意される（bootstrap.tsの
  // 主DDLには含まれない）。BumpCounterを直接使わないテストでもsource readerがこの表を
  // 読むため、setup()の時点で必ず存在させておく。
  new BumpCounter(db);
  const store = new TitleV2Store(db);
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

/** orderable:trueなbump_eventsだけを使う。3回目のBUMPの実時刻を正確にearnedAtとして返す。 */
const THIRD_BUMP_RULE = defineTitleRule(
  {
    key: "v2.test.third-bump",
    catalog: "test",
    name: "test: 3rd bump",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    trigger: "bump_success",
    lifecycle: "active",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  (ctx) => {
    const events = ctx.sources.bump_events.events;
    if (events.length < 3) return { matched: false, earnedAt: null };
    return { matched: true, earnedAt: events[2]! };
  },
);

/** 常にmatchedになるだけの最小fixture（award flowのテスト用）。 */
const ALWAYS_MATCH_RULE = defineTitleRule(
  {
    key: "v2.test.always-match",
    catalog: "test",
    name: "test: always match",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    trigger: "bump_success",
    lifecycle: "active",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  () => ({ matched: true, earnedAt: null }),
);

const DISABLED_RULE = defineTitleRule(
  {
    key: "v2.test.disabled",
    catalog: "test",
    name: "test: disabled",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    trigger: "bump_success",
    lifecycle: "disabled",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  () => {
    throw new Error("disabled titleのevaluate()は呼ばれてはいけない");
  },
);

const RETIRED_RULE = defineTitleRule(
  {
    key: "v2.test.retired",
    catalog: "test",
    name: "test: retired",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["bump_events"] as const,
    trigger: "bump_success",
    lifecycle: "retired",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  () => ({ matched: true, earnedAt: null }),
);

/** orderable:falseなVC sourceからearnedAtを主張しようとする、わざと壊れたfixture。 */
const BAD_VC_EARNED_AT_RULE = defineTitleRule(
  {
    key: "v2.test.bad-vc-earned-at",
    catalog: "test",
    name: "test: bad earnedAt",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["vc_empty_start_then_joined"] as const,
    trigger: "vc_leave",
    lifecycle: "active",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  (ctx) => {
    const fact = ctx.sources.vc_empty_start_then_joined.facts[0];
    if (!fact) return { matched: false, earnedAt: null };
    return { matched: true, earnedAt: fact.joinedAt };
  },
);

const VC_EMPTY_START_RULE = defineTitleRule(
  {
    key: "v2.test.empty-start",
    catalog: "test",
    name: "test: empty start",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["vc_empty_start_then_joined"] as const,
    trigger: "vc_leave",
    lifecycle: "active",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  (ctx) => ({
    matched: ctx.sources.vc_empty_start_then_joined.facts.length > 0,
    earnedAt: null,
  }),
);

const SOCIAL_SAFE_RULE = defineTitleRule(
  {
    key: "v2.test.social-safe",
    catalog: "test",
    name: "test: social safe",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["vc_social_safe"] as const,
    trigger: "vc_leave",
    lifecycle: "active",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  (ctx) => ({
    matched: ctx.sources.vc_social_safe.distinctCoPresentUsers > 0,
    earnedAt: null,
    publicFacts: { ...ctx.sources.vc_social_safe },
  }),
);

const GROUP_SIZE_RULE = defineTitleRule(
  {
    key: "v2.test.group-size",
    catalog: "test",
    name: "test: group size",
    emoji: "x",
    description: "テスト用fixture",
    sources: ["vc_group_size_seconds"] as const,
    trigger: "vc_leave",
    lifecycle: "active",
    hidden: false,
    countsForCompletion: false,
    publicAnnounce: false,
  },
  (ctx) => ({ matched: true, earnedAt: null, publicFacts: { ...ctx.sources.vc_group_size_seconds } }),
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
    const { db } = setup();
    expect(() => readTitleSource(db, "vc_segments" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("vc_visitsをruleから読めない", () => {
    const { db } = setup();
    expect(() => readTitleSource(db, "vc_visits" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("vc_co_presenceをruleから読めない", () => {
    const { db } = setup();
    expect(() => readTitleSource(db, "vc_co_presence" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("bump_countsをruleから読めない", () => {
    const { db } = setup();
    expect(() => readTitleSource(db, "bump_counts" as never, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("as anyで禁止sourceを要求してもruntimeでreject（defineTitleRuleを迂回した場合も）", () => {
    const { db, store } = setup();
    const badRule: TitleRule<never> = {
      definition: {
        key: "v2.test.bad-source",
        catalog: "test",
        name: "bad",
        emoji: "x",
        description: "raw sourceへ直接アクセスしようとする壊れたrule",
        sources: ["vc_segments"] as never,
        trigger: "vc_leave",
        lifecycle: "active",
        hidden: false,
        countsForCompletion: false,
        publicAnnounce: false,
      },
      evaluate: () => ({ matched: true, earnedAt: null }),
    };
    expect(() => evaluateTitle(db, store, badRule, "alice", scope)).toThrow(/not usable by titles/);
  });

  it("ruleが宣言していないsourceへアクセスできない（contextに存在しない）", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);

    let observedUndeclared: unknown = "not-checked";
    const rule = defineTitleRule(
      {
        key: "v2.test.undeclared-access",
        catalog: "test",
        name: "test",
        emoji: "x",
        description: "テスト用fixture",
        sources: ["bump_events"] as const,
        trigger: "bump_success",
        lifecycle: "active",
        hidden: false,
        countsForCompletion: false,
        publicAnnounce: false,
      },
      (ctx) => {
        // vc_social_safeは宣言していないので、contextに実体として存在しないはず
        observedUndeclared = (ctx.sources as Record<string, unknown>).vc_social_safe;
        return { matched: false, earnedAt: null };
      },
    );

    evaluateTitle(db, store, rule, "alice", scope);
    expect(observedUndeclared).toBeUndefined();
  });
});

describe("bump_events reader（§15）", () => {
  it("[start, end) を守る", () => {
    const { db } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE - 10); // windowの外
    bump.addOnce("m2", "alice", BASE); // inclusive start
    bump.addOnce("m3", "alice", BASE + 50);
    bump.addOnce("m4", "alice", BASE + 100); // exclusive end → 含まない

    const payload = readTitleSource(db, "bump_events", "alice", { ...scope, start: BASE, end: BASE + 100 });
    expect(payload.events).toEqual([BASE, BASE + 50]);
  });

  it("created_at ASC の順で返す", () => {
    const { db } = setup();
    const bump = new BumpCounter(db);
    // 挿入順をわざと逆にする
    bump.addOnce("m3", "alice", BASE + 20);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);

    const payload = readTitleSource(db, "bump_events", "alice", scope);
    expect(payload.events).toEqual([BASE, BASE + 10, BASE + 20]);
  });
});

describe("VC source reader はPR2 observedAt契約をそのまま使う（§16, §18）", () => {
  it("observedAtをPR2 APIへ渡し、まだ観測していない未来分を計上しない", () => {
    const { db } = setup();
    // aliceは開いたまま（未クローズ）。observedAt=BASE+50でしか観測していない。
    insertVcSegment(db, "alice", "vc1", BASE, null, null, "join");

    const payload = readTitleSource(db, "vc_group_size_seconds", "alice", {
      scopeKey: "s",
      start: BASE,
      end: BASE + 1000,
      observedAt: BASE + 50,
    });
    const total = Object.values(payload.trustedSecondsByBucket).reduce((a, b) => a + b, 0);
    expect(total).toBe(50); // window.end(+1000)ではなくobservedAt(+50)で打ち切られる
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

    evaluateUser(db, store, [THIRD_BUMP_RULE, ALWAYS_MATCH_RULE], "alice", scope);

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

    evaluateBatch(db, store, [THIRD_BUMP_RULE, ALWAYS_MATCH_RULE], ["alice", "bob"], scope);

    const countAfter = prepareSpy.mock.calls.filter((c) => String(c[0]).includes("FROM bump_events")).length;
    // alice分1回 + bob分1回 = 2回（2 rule × 2 userでも4回にはならない）
    expect(countAfter - countBefore).toBe(2);
  });
});

describe("award flow（§12）", () => {
  it("matched=false → award無し", () => {
    const { db, store } = setup();
    const result = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    expect(result.outcome).toBe("not_matched");
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("matched=true → award作成", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    const result = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    expect(result.outcome).toBe("awarded");
    expect(store.listAwards("alice")).toHaveLength(1);
  });

  it("同じevaluationを2回 → awardは1件だけ", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    const second = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    expect(second.outcome).toBe("already_awarded");
    expect(store.listAwards("alice")).toHaveLength(1);
  });

  it("既存awardは上書きしない", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    const before = store.listAwards("alice")[0];
    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    const after = store.listAwards("alice")[0];
    expect(after).toEqual(before);
  });

  it("scopeKey違いなら別award可能", () => {
    const { db, store } = setup();
    const bump = new BumpCounter(db);
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "alice", BASE + 10);
    bump.addOnce("m3", "alice", BASE + 20);

    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", { ...scope, scopeKey: "other-scope" });
    expect(store.listAwards("alice")).toHaveLength(2);
  });

  it("disabled titleはawardしない（evaluate()自体を呼ばない）", () => {
    const { db, store } = setup();
    const result = evaluateTitle(db, store, DISABLED_RULE, "alice", scope);
    expect(result.outcome).toBe("skipped");
    expect(result.matched).toBe(false);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("retired titleは新規awardしない", () => {
    const { db, store } = setup();
    const result = evaluateTitle(db, store, RETIRED_RULE, "alice", scope);
    expect(result.outcome).toBe("skipped");
    expect(result.matched).toBe(true);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("retired titleの既存awardは保持される（消えないし増えない）", () => {
    const { db, store } = setup();
    store.award({ userId: "alice", titleKey: "v2.test.retired", scopeKey: scope.scopeKey, earnedAt: null });

    const result = evaluateTitle(db, store, RETIRED_RULE, "alice", scope);
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

    const result = evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);
    expect(result.earnedAt).toBe(BASE + 20);
    expect(store.listAwards("alice")[0]!.earned_at).toBe(BASE + 20);
  });

  it("orderable:false sourceを含むruleがnon-null earnedAtを返したらreject", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE + 50, BASE + 80, "observed");

    expect(() => evaluateTitle(db, store, BAD_VC_EARNED_AT_RULE, "alice", scope)).toThrow(/non-orderable/);
  });

  it("earnedAt unknownならNULLのまま保存する", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE + 50, BASE + 80, "observed");

    const result = evaluateTitle(db, store, VC_EMPTY_START_RULE, "alice", scope);
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

    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", scope);

    // 後日のreconcileを模す: 別のobservedAtで同じruleを再評価しても、
    // 一度確定したearned_atをreconcileを走らせた時刻へ書き換えない。
    const laterScope = { ...scope, observedAt: scope.observedAt + 100_000 };
    evaluateTitle(db, store, THIRD_BUMP_RULE, "alice", laterScope);

    expect(store.listAwards("alice")[0]!.earned_at).toBe(BASE + 20);
  });
});

describe("publicFacts safety（§10）", () => {
  it("publicFactsへrestricted counterpart IDが出ない", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");
    insertVcSegment(db, "bob", "vc1", BASE, BASE + 100, "observed");

    const result = evaluateTitle(db, store, SOCIAL_SAFE_RULE, "alice", scope);
    expect(JSON.stringify(result.publicFacts)).not.toContain("bob");
    expect(result.publicFacts).toEqual({
      distinctCoPresentUsers: 1,
      maxRepeatedDaysWithOneCounterpart: expect.any(Number),
      trustedOverlapSeconds: 100,
    });
  });
});

describe("fail-closed on source reader failure（§24）", () => {
  it("source読み込みの失敗を「条件未達」として握り潰さず、そのままthrowする", () => {
    const { db, store } = setup();
    const badScope = { ...scope, start: scope.end, end: scope.start }; // start>=endの壊れたscope
    expect(() => evaluateTitle(db, store, VC_EMPTY_START_RULE, "alice", badScope)).toThrow();
  });
});

// GROUP_SIZE_RULEはobservedAt伝播テストで型検査用に定義してあるが、
// 上のdescribeブロックでは直接使っていない箇所があるため、未使用警告を避けるために
// 最小限のsanityテストを1件だけ足しておく。
describe("group-size ruleのpublicFacts経路", () => {
  it("trustedSecondsByBucketとuntrustedSecondsをpublicFactsへそのまま渡せる", () => {
    const { db, store } = setup();
    insertVcSegment(db, "alice", "vc1", BASE, BASE + 100, "observed");

    const result = evaluateTitle(db, store, GROUP_SIZE_RULE, "alice", scope);
    expect(result.publicFacts).toMatchObject({ untrustedSeconds: 0 });
  });
});
