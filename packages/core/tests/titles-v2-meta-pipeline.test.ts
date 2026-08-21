import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import {
  type BehaviorTitleDefinition,
  type MetaTitleDefinition,
  type TitleDefinition,
  type TitleTrigger,
} from "../src/titles/v2-contract.js";
import { defineTitleRule, type TitleRule } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import {
  buildMetaSnapshot,
  defineMetaTitleRule,
  evaluateMetaTitle,
  type MetaCollectionEditionSnapshot,
  type MetaTitleRule,
  type MetaTitleRuleContext,
  type MetaTitleRuleResult,
} from "../src/titles/v2-meta.js";
import {
  defineTitleEvaluationPlan,
  evaluateBatchPipeline,
  evaluateUserPipeline,
  type TitleEvaluationPlan,
} from "../src/titles/v2-pipeline.js";
import type { TitleCollectionEdition } from "../src/titles/v2-collection.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import * as v2Public from "../src/titles/v2.js";

/** JST 2026-08-20 00:00:00 を秒0とする、meta/pipelineテスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const OBSERVED_AT = BASE + 1000;
const NO_FACTS = { version: 1, data: {} };

function setup() {
  const db = openDb(":memory:");
  const bump = new BumpCounter(db);
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" });
  clock = BASE + 10_000_000;
  const setClock = (value: number) => {
    clock = value;
  };
  return { db, store, bump, setClock };
}

/** pipeline外（historical repairの管理操作等を想定）で直接awardするテスト用ヘルパー。 */
function directAward(store: TitleV2Store, userId: string, def: BehaviorTitleDefinition, observedAt: number, earnedAt: number | null) {
  const scope = resolveTitleScope(store, def, observedAt);
  return store.award({ userId, titleKey: def.key, scope, earnedAt, awardFacts: NO_FACTS });
}

const COMMON_BEHAVIOR_FIELDS = {
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  scope: { type: "global" as const },
};

/** bump_eventsが1件以上あればmatchedになる、behavior title fixture。 */
function behaviorRule(
  key: `v2.${string}`,
  opts: {
    triggers?: readonly TitleTrigger[];
    collectionDomainKey?: string;
    progression?: { seriesKey: string; stage: number };
    lifecycle?: "active" | "retired" | "disabled";
  } = {},
): TitleRule<readonly ["bump_events"]> {
  return defineTitleRule(
    {
      kind: "behavior",
      key,
      name: key,
      description: "テスト用fixture",
      sources: ["bump_events"] as const,
      triggers: opts.triggers ?? ["bump_success"],
      lifecycle: opts.lifecycle ?? "active",
      collectionDomainKey: opts.collectionDomainKey ?? "test-domain",
      progression: opts.progression,
      ...COMMON_BEHAVIOR_FIELDS,
    },
    {
      awardFactsVersion: 1,
      evaluate: (ctx) => {
        if (ctx.sources.bump_events.events.length === 0) return { matched: false, earnedAt: null };
        return { matched: true, earnedAt: null, awardFacts: {} };
      },
    },
  );
}

const COMMON_META_FIELDS = {
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-meta-theme",
  groupKey: "test-meta-group",
  scope: { type: "global" as const },
};

function metaDef(key: `v2.${string}`, lifecycle: "active" | "retired" | "disabled" = "active"): MetaTitleDefinition {
  return {
    kind: "meta",
    key,
    name: key,
    description: "テスト用meta fixture",
    lifecycle,
    ...COMMON_META_FIELDS,
  };
}

function metaRule(
  key: `v2.${string}`,
  evaluate: (ctx: MetaTitleRuleContext) => MetaTitleRuleResult,
  lifecycle?: "active" | "retired" | "disabled",
): MetaTitleRule {
  return defineMetaTitleRule(metaDef(key, lifecycle), { awardFactsVersion: 1, evaluate });
}

/** 常にmatchedになるmeta fixture。 */
function alwaysMatchMeta(key: `v2.${string}`): MetaTitleRule {
  return metaRule(key, () => ({ matched: true, awardFacts: {} }));
}

/** 条件のboolean結果から、discriminated unionとして正しいMetaTitleRuleResultを組み立てる。 */
function matchIf(condition: boolean): MetaTitleRuleResult {
  return condition ? { matched: true, awardFacts: {} } : { matched: false };
}

// ─────────────────────────────────────────────────────────────

describe("MetaTitleRule contract / defineMetaTitleRule（§3, §47）", () => {
  it("正常なmeta definitionはdefineMetaTitleRuleを通る", () => {
    const rule = alwaysMatchMeta("v2.test.meta.ok");
    expect(rule.definition.key).toBe("v2.test.meta.ok");
    expect(rule.definition.kind).toBe("meta");
  });

  it("behavior definitionをdefineMetaTitleRuleへ渡すとreject（kind spoof）", () => {
    const behaviorLike = {
      kind: "behavior",
      key: "v2.test.meta.spoof",
      name: "spoof",
      description: "behavior definitionをmeta rule contextへ混入させようとする",
      lifecycle: "active",
      ...COMMON_META_FIELDS,
    } as unknown as MetaTitleDefinition;
    expect(() => defineMetaTitleRule(behaviorLike, { awardFactsVersion: 1, evaluate: () => ({ matched: false }) })).toThrow(
      /requires kind:"meta"/,
    );
  });

  it("global以外のscopeはreject", () => {
    const bad = { ...metaDef("v2.test.meta.bad-scope"), scope: { type: "catalog" as const } };
    expect(() => defineMetaTitleRule(bad, { awardFactsVersion: 1, evaluate: () => ({ matched: false }) })).toThrow(
      /only support scope\.type="global"/,
    );
  });

  it("不正なlifecycleはruntimeでreject（TypeScriptを迂回した入力）", () => {
    const bad = { ...metaDef("v2.test.meta.bad-lifecycle"), lifecycle: "seasonal" as never };
    expect(() => defineMetaTitleRule(bad, { awardFactsVersion: 1, evaluate: () => ({ matched: false }) })).toThrow(
      /invalid lifecycle/,
    );
  });
});

describe("MetaTitleRuleResult runtime guard（§5, §47）", () => {
  function setupWithSnapshot() {
    const { store } = setup();
    const snapshot = buildMetaSnapshot(store, "alice", new Set());
    return { store, snapshot };
  }

  it("matched:'false'（文字列）はreject", () => {
    const rule = metaRule("v2.test.meta.string-false", () => ({ matched: "false" as never }));
    const { store, snapshot } = setupWithSnapshot();
    expect(() => evaluateMetaTitle(store, rule, "alice", OBSERVED_AT, snapshot)).toThrow(/non-boolean matched value/);
  });

  it("matched:false + awardFactsはreject", () => {
    const rule = metaRule("v2.test.meta.false-with-facts", () => ({ matched: false, awardFacts: {} } as never));
    const { store, snapshot } = setupWithSnapshot();
    expect(() => evaluateMetaTitle(store, rule, "alice", OBSERVED_AT, snapshot)).toThrow(/awardFacts set/);
  });

  it("matched:true + awardFacts欠落はreject", () => {
    const rule = metaRule("v2.test.meta.true-missing-facts", () => ({ matched: true } as never));
    const { store, snapshot } = setupWithSnapshot();
    expect(() => evaluateMetaTitle(store, rule, "alice", OBSERVED_AT, snapshot)).toThrow();
  });

  it("awardFactsが契約違反（forbidden key）ならreject", () => {
    const rule = metaRule("v2.test.meta.bad-facts", () => ({ matched: true, awardFacts: { userId: "alice" } }));
    const { store, snapshot } = setupWithSnapshot();
    expect(() => evaluateMetaTitle(store, rule, "alice", OBSERVED_AT, snapshot)).toThrow(/forbidden key/);
  });
});

describe("evaluation plan（§17-18, §46）", () => {
  it("behavior rule同士のkey重複はreject", () => {
    const a = behaviorRule("v2.test.plan.dup");
    const b = behaviorRule("v2.test.plan.dup");
    expect(() => defineTitleEvaluationPlan([a, b], [])).toThrow(/duplicate title key/);
  });

  it("meta rule同士のkey重複はreject", () => {
    const a = alwaysMatchMeta("v2.test.plan.meta-dup");
    const b = alwaysMatchMeta("v2.test.plan.meta-dup");
    expect(() => defineTitleEvaluationPlan([], [a, b])).toThrow(/duplicate title key/);
  });

  it("behavior/meta横断のkey重複はreject", () => {
    const behavior = behaviorRule("v2.test.plan.cross-dup");
    const meta = alwaysMatchMeta("v2.test.plan.cross-dup");
    expect(() => defineTitleEvaluationPlan([behavior], [meta])).toThrow(/duplicate title key/);
  });

  it("behavior rule配列にkind spoofされたruleが混入していたらreject", () => {
    const forged: TitleRule<never> = {
      definition: { ...metaDef("v2.test.plan.spoofed-behavior") } as unknown as BehaviorTitleDefinition & { sources: never },
      awardFactsVersion: 1,
      evaluate: () => ({ matched: false, earnedAt: null }),
    };
    expect(() => defineTitleEvaluationPlan([forged], [])).toThrow(/defineBehaviorTitle\(\) requires kind:"behavior"/);
  });

  it("meta rule配列にkind spoofされたruleが混入していたらreject", () => {
    const behaviorDef = behaviorRule("v2.test.plan.spoofed-meta").definition;
    const forged: MetaTitleRule = {
      definition: behaviorDef as unknown as MetaTitleDefinition,
      awardFactsVersion: 1,
      evaluate: () => ({ matched: false }),
    };
    expect(() => defineTitleEvaluationPlan([], [forged])).toThrow(/requires kind:"meta"/);
  });

  it("planの配列はfreezeされている", () => {
    const plan = defineTitleEvaluationPlan([behaviorRule("v2.test.plan.frozen")], [alwaysMatchMeta("v2.test.plan.frozen-meta")]);
    expect(Object.isFrozen(plan.behaviorRules)).toBe(true);
    expect(Object.isFrozen(plan.metaRules)).toBe(true);
  });
});

describe("meta snapshot: hidden title leak防止（§9, §42）", () => {
  it("snapshotにmember titleKey・userId・edition運用metadataが含まれない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);

    const a = behaviorRule("v2.test.leak.a", { collectionDomainKey: "leak-domain" });
    const b = behaviorRule("v2.test.leak.b", { collectionDomainKey: "leak-domain" });
    const c = behaviorRule("v2.test.leak.c", { collectionDomainKey: "leak-domain" });
    const definitionsMap: ReadonlyMap<string, TitleDefinition> = new Map([
      [a.definition.key, a.definition],
      [b.definition.key, b.definition],
      [c.definition.key, c.definition],
    ]);
    const edition: TitleCollectionEdition = {
      editionKey: "leak-edition",
      members: [
        { titleKey: a.definition.key, collectionDomainKey: "leak-domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.definition.key, collectionDomainKey: "leak-domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: c.definition.key, collectionDomainKey: "leak-domain", collectionCredit: true, fullClearRequired: false },
      ],
      milestones: { startedCollecting: 1, collectorHabit: 2, stillCollecting: 3, thousandMarks: { count: 3, domains: 1 }, almostComplete: { remaining: 1 } },
    };
    store.activateCollectionEdition(edition, definitionsMap, "admin", "leak-note");

    const plan = defineTitleEvaluationPlan([a], [alwaysMatchMeta("v2.test.leak.meta")]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");

    const behaviorTitleKeys = new Set(plan.behaviorRules.map((r) => r.definition.key));
    const snapshot = buildMetaSnapshot(store, "alice", behaviorTitleKeys);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("v2.test.leak.a");
    expect(json).not.toContain("v2.test.leak.b");
    expect(json).not.toContain("alice");
    expect(json).not.toContain("admin");
    expect(json).not.toContain("leak-note");
  });
});

describe("meta snapshot: behaviorOwnershipCount（§10, §23, §36）", () => {
  it("behavior title所持数をカウントする", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const a = behaviorRule("v2.test.count.a");
    const b = behaviorRule("v2.test.count.b");
    const plan = defineTitleEvaluationPlan([a, b], []);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");

    const behaviorTitleKeys = new Set(plan.behaviorRules.map((r) => r.definition.key));
    const snapshot = buildMetaSnapshot(store, "alice", behaviorTitleKeys);
    expect(snapshot.behaviorOwnershipCount).toBe(2);
  });

  it("meta title自身のownershipはbehaviorOwnershipCountへ数えない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const a = behaviorRule("v2.test.count2.a");
    const meta = alwaysMatchMeta("v2.test.count2.meta");
    const plan = defineTitleEvaluationPlan([a], [meta]);

    const first = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");
    expect(first.meta[0]!.outcome).toBe("awarded");
    expect(store.hasOwnership("alice", "v2.test.count2.meta")).toBe(true);

    const behaviorTitleKeys = new Set(plan.behaviorRules.map((r) => r.definition.key));
    const snapshot = buildMetaSnapshot(store, "alice", behaviorTitleKeys);
    // aliceはbehavior title(a)を1つ・meta title(meta)を1つ持つが、カウントは1のまま。
    expect(snapshot.behaviorOwnershipCount).toBe(1);
  });
});

describe("meta snapshot immutability（§15, §48）", () => {
  it("collectionEditions配列へのpush・behaviorOwnershipCountの書き換えはstrict modeでthrowする", () => {
    const { store } = setup();
    const snapshot = buildMetaSnapshot(store, "alice", new Set());
    expect(() => (snapshot.collectionEditions as unknown[]).push({})).toThrow();
    expect(() => ((snapshot as { behaviorOwnershipCount: number }).behaviorOwnershipCount = 999)).toThrow();
  });

  it("rule Aがsnapshotの書き換えを試みても、rule Bは元の値を見る（同一frozen snapshotを共有する契約の直接確認）", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const a = behaviorRule("v2.test.freeze.a");

    let observedAtRuleB: number | undefined;
    const ruleA = metaRule("v2.test.freeze.meta-a", (ctx) => {
      try {
        (ctx.snapshot as { behaviorOwnershipCount: number }).behaviorOwnershipCount = 999;
      } catch {
        /* strict modeでthrowするのが期待動作 */
      }
      return { matched: true, awardFacts: {} };
    });
    const ruleB = metaRule("v2.test.freeze.meta-b", (ctx) => {
      observedAtRuleB = ctx.snapshot.behaviorOwnershipCount;
      return { matched: false };
    });

    const plan = defineTitleEvaluationPlan([a], [ruleA, ruleB]);
    evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");
    expect(observedAtRuleB).toBe(1);
  });
});

describe("pipeline order: behavior → series → meta（§21, §34, §38）", () => {
  it("同一passでSeries member最終stageをaward → mastery成立 → meta award", () => {
    const { db, store, bump } = setup();
    const stage1 = behaviorRule("v2.test.series.stage1", { progression: { seriesKey: "ignite", stage: 1 } });
    const stage2 = behaviorRule("v2.test.series.stage2", { progression: { seriesKey: "ignite", stage: 2 } });
    store.registerSeriesManifests(
      [{ catalog: "test", seriesKey: "ignite", label: "test series", masteryEligible: true, members: [stage1.definition.key, stage2.definition.key] }],
      [stage1.definition, stage2.definition],
    );

    // stage1は事前に取得済み（pipeline外、historical repair等を想定した直接award）。
    directAward(store, "alice", stage1.definition, BASE, null);

    bump.addOnce("m1", "alice", BASE);
    const meta = metaRule("v2.test.series.meta", (ctx) =>
      matchIf(ctx.snapshot.seriesMasteries.some((m) => m.catalogKey === "test" && m.seriesKey === "ignite")),
    );

    const plan = defineTitleEvaluationPlan([stage1, stage2], [meta]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");

    expect(result.series.newlyMastered).toHaveLength(1);
    expect(result.meta[0]!.outcome).toBe("awarded");
    expect(store.hasOwnership("alice", "v2.test.series.meta")).toBe(true);
  });
});

describe("pipeline order: behavior → collection → meta（§39）", () => {
  function fiveMemberEdition(editionKey: string) {
    const domainTitle = (key: `v2.${string}`, domainKey: string) => behaviorRule(key, { collectionDomainKey: domainKey });
    const a = domainTitle("v2.test.col.a", "domain-a");
    const b = domainTitle("v2.test.col.b", "domain-a");
    const c = domainTitle("v2.test.col.c", "domain-a");
    const d = domainTitle("v2.test.col.d", "domain-b");
    const e = domainTitle("v2.test.col.e", "domain-b");
    const defs = [a, b, c, d, e];
    const edition: TitleCollectionEdition = {
      editionKey,
      members: [
        { titleKey: a.definition.key, collectionDomainKey: "domain-a", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.definition.key, collectionDomainKey: "domain-a", collectionCredit: true, fullClearRequired: true },
        { titleKey: c.definition.key, collectionDomainKey: "domain-a", collectionCredit: true, fullClearRequired: false },
        { titleKey: d.definition.key, collectionDomainKey: "domain-b", collectionCredit: true, fullClearRequired: false },
        { titleKey: e.definition.key, collectionDomainKey: "domain-b", collectionCredit: true, fullClearRequired: false },
      ],
      milestones: {
        startedCollecting: 1,
        collectorHabit: 2,
        stillCollecting: 3,
        thousandMarks: { count: 5, domains: 2 },
        almostComplete: { remaining: 1 },
      },
    };
    const definitionsMap: ReadonlyMap<string, TitleDefinition> = new Map(defs.map((r) => [r.definition.key, r.definition]));
    return { a, b, c, d, e, edition, definitionsMap };
  }

  it("behavior stageで最後のfullClearRequired memberをaward → 同一passでmeta match", () => {
    const { db, store, bump } = setup();
    const { a, b, edition, definitionsMap } = fiveMemberEdition("col-edition-active");
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    // aは事前取得済み。bはこのpipeline passのbehavior stageで取得させる。
    directAward(store, "alice", a.definition, BASE, null);

    bump.addOnce("m1", "alice", BASE);
    const meta = metaRule("v2.test.col.meta", (ctx) => {
      const target = ctx.snapshot.collectionEditions.find((e) => e.editionKey === "col-edition-active");
      return matchIf(target?.progress.fullClearComplete === true);
    });

    const plan = defineTitleEvaluationPlan([b], [meta]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");

    expect(result.behavior[0]!.outcome).toBe("awarded");
    expect(result.meta[0]!.outcome).toBe("awarded");
  });
});

describe("closed Collection historical repair integration（§40, §41）", () => {
  function twoMemberClosedFixture() {
    const a = behaviorRule("v2.test.closed.a", { collectionDomainKey: "domain" });
    const b = behaviorRule("v2.test.closed.b", { collectionDomainKey: "domain" });
    const c = behaviorRule("v2.test.closed.c", { collectionDomainKey: "domain" });
    const definitionsMap: ReadonlyMap<string, TitleDefinition> = new Map([
      [a.definition.key, a.definition],
      [b.definition.key, b.definition],
      [c.definition.key, c.definition],
    ]);
    const edition: TitleCollectionEdition = {
      editionKey: "closed-edition",
      members: [
        { titleKey: a.definition.key, collectionDomainKey: "domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.definition.key, collectionDomainKey: "domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: c.definition.key, collectionDomainKey: "domain", collectionCredit: true, fullClearRequired: false },
      ],
      milestones: { startedCollecting: 1, collectorHabit: 2, stillCollecting: 3, thousandMarks: { count: 3, domains: 1 }, almostComplete: { remaining: 1 } },
    };
    return { a, b, definitionsMap, edition };
  }

  it("close後の通常award(earnedAt=null)は旧edition progressへcreditされず、meta matchしない", () => {
    const { db, store, setClock } = setup();
    const { a, definitionsMap, edition } = twoMemberClosedFixture();

    setClock(BASE + 500);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 1000);
    store.closeCollectionEdition("closed-edition", "admin");
    const closedAt = store.collectionEdition("closed-edition")!.closedAt!;

    // close後の通常award: awardedAt >= closedAt, earnedAt=null → credit対象外。
    setClock(closedAt + 100);
    directAward(store, "alice", a.definition, closedAt + 100, null);

    const meta = metaRule("v2.test.closed.meta-a", (ctx) => {
      const target = ctx.snapshot.collectionEditions.find((x) => x.editionKey === "closed-edition");
      return matchIf((target?.progress.collectionOwnedCount ?? 0) > 0);
    });
    const plan = defineTitleEvaluationPlan([], [meta]);
    const result = evaluateUserPipeline(db, store, plan, "alice", closedAt + 200, "daily");
    expect(result.meta[0]!.outcome).toBe("not_matched");
  });

  it("close後のhistorical repair（earnedAt<closedAt）は旧edition progressへcreditされ、meta matchする", () => {
    const { db, store, setClock } = setup();
    const { a, b, definitionsMap, edition } = twoMemberClosedFixture();

    setClock(BASE + 500);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 1000);
    store.closeCollectionEdition("closed-edition", "admin");
    const closedAt = store.collectionEdition("closed-edition")!.closedAt!;

    // bはclose前に既に取得済みだったとする。
    setClock(BASE + 600);
    directAward(store, "bob", b.definition, BASE + 600, null);
    // aはhistorical repairで、close以前に達成していたと後から証明されたケース。
    setClock(closedAt + 500);
    directAward(store, "bob", a.definition, closedAt + 500, closedAt - 10);

    const meta = metaRule("v2.test.closed.meta-b", (ctx) => {
      const target = ctx.snapshot.collectionEditions.find((x) => x.editionKey === "closed-edition");
      return matchIf(target?.progress.fullClearComplete === true);
    });
    const plan = defineTitleEvaluationPlan([], [meta]);
    setClock(closedAt + 600);
    const result = evaluateUserPipeline(db, store, plan, "bob", closedAt + 600, "daily");
    expect(result.meta[0]!.outcome).toBe("awarded");
  });
});

describe("meta-to-meta recursion禁止（§23, §43）", () => {
  it("Meta Aがawardされても、behaviorOwnershipCountを見るMeta Bは同一passでmatchしない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const metaA = alwaysMatchMeta("v2.test.recursion.a");
    const metaB = metaRule("v2.test.recursion.b", (ctx) =>
      ctx.snapshot.behaviorOwnershipCount >= 1 ? { matched: true, awardFacts: {} } : { matched: false },
    );

    const plan = defineTitleEvaluationPlan([], [metaA, metaB]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "daily");

    expect(result.meta[0]!.outcome).toBe("awarded"); // metaA
    expect(result.meta[1]!.outcome).toBe("not_matched"); // metaB: behavior ownership 0のまま

    // 次回passでもbehaviorOwnershipCountは0のまま（meta A ownershipが混ざらない）。
    const second = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 100, "daily");
    expect(second.meta[1]!.outcome).toBe("not_matched");
  });
});

describe("Meta lifecycle（§24, §44）", () => {
  it("active: matched → award", () => {
    const { db, store } = setup();
    const plan = defineTitleEvaluationPlan([], [alwaysMatchMeta("v2.test.lifecycle.active")]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "daily");
    expect(result.meta[0]!.outcome).toBe("awarded");
  });

  it("retired: matchedでもaward無しならskipped", () => {
    const { db, store } = setup();
    const rule = metaRule("v2.test.lifecycle.retired-none", () => ({ matched: true, awardFacts: {} }), "retired");
    const plan = defineTitleEvaluationPlan([], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "daily");
    expect(result.meta[0]!.outcome).toBe("skipped");
    expect(store.hasOwnership("alice", rule.definition.key)).toBe(false);
  });

  it("retired: 既存awardがあればalready_awarded", () => {
    const { db, store } = setup();
    const activeVersion = metaRule("v2.test.lifecycle.retired-existing", () => ({ matched: true, awardFacts: {} }));
    const plan1 = defineTitleEvaluationPlan([], [activeVersion]);
    evaluateUserPipeline(db, store, plan1, "alice", OBSERVED_AT, "daily");

    const retiredVersion = metaRule("v2.test.lifecycle.retired-existing", () => ({ matched: true, awardFacts: {} }), "retired");
    const plan2 = defineTitleEvaluationPlan([], [retiredVersion]);
    const result = evaluateUserPipeline(db, store, plan2, "alice", OBSERVED_AT + 10, "daily");
    expect(result.meta[0]!.outcome).toBe("already_awarded");
  });

  it("disabled: evaluate()自体を呼ばない", () => {
    const { db, store } = setup();
    const rule = metaRule(
      "v2.test.lifecycle.disabled",
      () => {
        throw new Error("disabled meta titleのevaluate()は呼ばれてはいけない");
      },
      "disabled",
    );
    const plan = defineTitleEvaluationPlan([], [rule]);
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "daily");
    expect(result.meta[0]!.outcome).toBe("skipped");
    expect(result.meta[0]!.scopeKey).toBeNull();
  });
});

describe("trigger-aware behavior selection（§19, §45）", () => {
  it("triggerに応じてbehavior ruleを絞り込む（dailyは魔法triggerではない）", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "bob", BASE);
    const vcOnly = behaviorRule("v2.test.trigger.vc-only", { triggers: ["vc_activity"] });
    const dailyOnly = behaviorRule("v2.test.trigger.daily-only", { triggers: ["daily"] });
    const both = behaviorRule("v2.test.trigger.both", { triggers: ["vc_activity", "daily"] });

    const plan = defineTitleEvaluationPlan([vcOnly, dailyOnly, both], []);

    const vcResult = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(vcResult.behavior.map((r) => r.titleKey).sort()).toEqual([vcOnly.definition.key, both.definition.key].sort());

    const dailyResult = evaluateUserPipeline(db, store, plan, "bob", OBSERVED_AT, "daily");
    expect(dailyResult.behavior.map((r) => r.titleKey).sort()).toEqual([dailyOnly.definition.key, both.definition.key].sort());
  });
});

describe("no forged snapshot public API（§16）", () => {
  it("v2.tsはbuildMetaSnapshot/evaluateMetaTitleをexportしない", () => {
    expect((v2Public as Record<string, unknown>).buildMetaSnapshot).toBeUndefined();
    expect((v2Public as Record<string, unknown>).evaluateMetaTitle).toBeUndefined();
  });

  it("evaluateUserPipeline/evaluateBatchPipelineはsnapshot引数を受け取らない（署名の直接確認）", () => {
    // db, store, plan, userId, observedAt, trigger, options? の7引数まで。
    expect(evaluateUserPipeline.length).toBeLessThanOrEqual(7);
    expect(evaluateBatchPipeline.length).toBeLessThanOrEqual(7);
  });
});

describe("resumability（§32, §33, §49）", () => {
  it("behavior ruleがthrowしたら、先行して成功したbehavior awardはrollbackされずpipeline全体がfail-fastする", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const good = behaviorRule("v2.test.resume.good");
    let shouldThrow = true;
    const bad = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.resume.bad",
        name: "bad",
        description: "テスト用fixture",
        sources: ["bump_events"] as const,
        triggers: ["bump_success"],
        lifecycle: "active",
        collectionDomainKey: "test-domain",
        ...COMMON_BEHAVIOR_FIELDS,
      },
      {
        awardFactsVersion: 1,
        evaluate: () => {
          if (shouldThrow) throw new Error("intentional failure");
          return { matched: true, earnedAt: null, awardFacts: {} };
        },
      },
    );
    const meta = alwaysMatchMeta("v2.test.resume.meta");
    const plan = defineTitleEvaluationPlan([good, bad], [meta]);

    expect(() => evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success")).toThrow(/intentional failure/);
    // goodは成功済み、bad失敗によりmeta/seriesステージへは進んでいない。
    expect(store.hasOwnership("alice", good.definition.key)).toBe(true);
    expect(store.hasOwnership("alice", meta.definition.key)).toBe(false);

    shouldThrow = false;
    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 10, "bump_success");
    expect(result.behavior.find((r) => r.titleKey === good.definition.key)!.outcome).toBe("already_awarded");
    expect(result.behavior.find((r) => r.titleKey === bad.definition.key)!.outcome).toBe("awarded");
    expect(result.meta[0]!.outcome).toBe("awarded");
  });
});

describe("evaluateBatchPipeline（§29-30）", () => {
  it("userごとにbehavior→series→metaを完了させてから次userへ進む", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    bump.addOnce("m2", "bob", BASE);
    const behavior = behaviorRule("v2.test.batch.a");
    const meta = alwaysMatchMeta("v2.test.batch.meta");
    const plan = defineTitleEvaluationPlan([behavior], [meta]);

    const results = evaluateBatchPipeline(db, store, plan, ["alice", "bob"], OBSERVED_AT, "bump_success");
    expect(results.map((r) => r.userId)).toEqual(["alice", "bob"]);
    for (const r of results) {
      expect(r.behavior[0]!.outcome).toBe("awarded");
      expect(r.meta[0]!.outcome).toBe("awarded");
    }
  });
});

describe("root packages/core/src/index.ts からpipeline/meta APIは意図的に未export（§14, §52）", () => {
  it("root indexはdocs §14の既存whitelistのまま（pipeline/meta APIは@meigokujo/core/titles/v2経由）", async () => {
    const core = await import("../src/index.js");
    expect((core as Record<string, unknown>).evaluateUserPipeline).toBeUndefined();
    expect((core as Record<string, unknown>).defineMetaTitleRule).toBeUndefined();
  });
});

describe("Evaluation Plan provenance / mutation resistance（PR #156 round 2レビュー §1-5）", () => {
  it("defineTitleEvaluationPlan()を経由しない手書きplanはevaluateUserPipeline()でreject", () => {
    const { db, store } = setup();
    const forged = { behaviorRules: [], metaRules: [] } as unknown as TitleEvaluationPlan;
    expect(() => evaluateUserPipeline(db, store, forged, "alice", OBSERVED_AT, "daily")).toThrow(
      /not produced by defineTitleEvaluationPlan/,
    );
  });

  it("正規planをshallow copy（{ ...realPlan }）してもreject（exact object identityで見ているため）", () => {
    const { db, store } = setup();
    const real = defineTitleEvaluationPlan([], [alwaysMatchMeta("v2.test.provenance.copy")]);
    const copied = { ...real } as TitleEvaluationPlan;
    expect(() => evaluateUserPipeline(db, store, copied, "alice", OBSERVED_AT, "daily")).toThrow(
      /not produced by defineTitleEvaluationPlan/,
    );
  });

  it("正規plan object自体のbehaviorRules/metaRulesフィールド差し替えはfreezeでthrowする", () => {
    const real = defineTitleEvaluationPlan([behaviorRule("v2.test.provenance.frozen")], []);
    expect(() => {
      (real as { behaviorRules: unknown }).behaviorRules = [];
    }).toThrow();
    expect(() => {
      (real as { metaRules: unknown }).metaRules = [];
    }).toThrow();
  });

  it("plan構築後に元behavior ruleのtriggersを書き換えても、pipelineのtrigger selectionは変化しない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.provenance.triggers", { triggers: ["vc_activity"] });
    const plan = defineTitleEvaluationPlan([rule], []);

    // TypeScriptを迂回して、plan構築後に元ruleのtriggersを書き換える。
    (rule.definition as unknown as { triggers: string[] }).triggers = ["daily"];

    // 書き換え前のtrigger("vc_activity")で評価してもcompiled plan側は元のtriggersを
    // 保持しているので評価される。逆に書き換え後の値("daily")では評価されないはず。
    const vcResult = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "vc_activity");
    expect(vcResult.behavior.map((r) => r.titleKey)).toEqual([rule.definition.key]);

    const dailyResult = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT + 10, "daily");
    expect(dailyResult.behavior).toEqual([]);
  });

  it("plan構築後に元behavior ruleのkeyを書き換えても、award/behaviorOwnershipCount分類は元のkeyのまま", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const rule = behaviorRule("v2.test.provenance.key-a");
    const meta = metaRule("v2.test.provenance.key-meta", (ctx) =>
      ctx.snapshot.behaviorOwnershipCount >= 1 ? { matched: true, awardFacts: {} } : { matched: false },
    );
    const plan = defineTitleEvaluationPlan([rule], [meta]);

    // plan構築後に元ruleのkeyを書き換える。
    (rule.definition as { key: string }).key = "v2.test.provenance.key-hacked";

    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");
    // 実際にawardされたtitleKeyはcanonical snapshot時点のkeyのまま（書き換え後の値ではない）。
    expect(result.behavior[0]!.titleKey).toBe("v2.test.provenance.key-a");
    expect(store.hasOwnership("alice", "v2.test.provenance.key-a")).toBe(true);
    expect(store.hasOwnership("alice", "v2.test.provenance.key-hacked")).toBe(false);
    // behaviorOwnershipCountの分類も元keyベースで機能し続ける（meta ruleがmatchしている）。
    expect(result.meta[0]!.outcome).toBe("awarded");
  });

  it("plan構築後に元meta ruleのkey/lifecycleを書き換えても、compiled planのsemanticsは変化しない", () => {
    const { db, store } = setup();
    const meta = metaRule("v2.test.provenance.meta-key", () => ({ matched: true, awardFacts: {} }));
    const plan = defineTitleEvaluationPlan([], [meta]);

    (meta.definition as { key: string }).key = "v2.test.provenance.meta-key-hacked";
    (meta.definition as { lifecycle: string }).lifecycle = "disabled";

    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "daily");
    // lifecycle書き換えが反映されていれば"skipped"になるはずだが、canonical snapshotは
    // activeのままなので"awarded"になる。titleKeyも書き換え前のまま。
    expect(result.meta[0]!.outcome).toBe("awarded");
    expect(result.meta[0]!.titleKey).toBe("v2.test.provenance.meta-key");
  });

  it("plan構築後のmutationでbehavior/meta間のkey collisionを作ろうとしても、compiled planへは反映されない", () => {
    const { db, store, bump } = setup();
    bump.addOnce("m1", "alice", BASE);
    const behavior = behaviorRule("v2.test.provenance.collision-a");
    const meta = alwaysMatchMeta("v2.test.provenance.collision-b");
    const plan = defineTitleEvaluationPlan([behavior], [meta]);

    // plan構築後にbehavior側のkeyをmeta側と衝突させようとする。
    (behavior.definition as { key: string }).key = "v2.test.provenance.collision-b";

    const result = evaluateUserPipeline(db, store, plan, "alice", OBSERVED_AT, "bump_success");
    // compiled planは構築時点のcanonical keyを保持しているため、衝突は起きず、
    // 両方とも元のkeyのまま個別にawardされる。
    expect(result.behavior[0]!.titleKey).toBe("v2.test.provenance.collision-a");
    expect(result.meta[0]!.titleKey).toBe("v2.test.provenance.collision-b");
    expect(store.hasOwnership("alice", "v2.test.provenance.collision-a")).toBe(true);
    expect(store.hasOwnership("alice", "v2.test.provenance.collision-b")).toBe(true);
  });
});

describe("closed edition same-second tie（PR #156 round 2レビュー §6、B2 same-second fail-closed契約の直接固定）", () => {
  function twoMemberClosedFixtureForTie() {
    const a = behaviorRule("v2.test.tie.a", { collectionDomainKey: "domain" });
    const b = behaviorRule("v2.test.tie.b", { collectionDomainKey: "domain" });
    const c = behaviorRule("v2.test.tie.c", { collectionDomainKey: "domain" });
    const definitionsMap: ReadonlyMap<string, TitleDefinition> = new Map([
      [a.definition.key, a.definition],
      [b.definition.key, b.definition],
      [c.definition.key, c.definition],
    ]);
    const edition: TitleCollectionEdition = {
      editionKey: "tie-edition",
      members: [
        { titleKey: a.definition.key, collectionDomainKey: "domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.definition.key, collectionDomainKey: "domain", collectionCredit: true, fullClearRequired: true },
        { titleKey: c.definition.key, collectionDomainKey: "domain", collectionCredit: true, fullClearRequired: false },
      ],
      milestones: { startedCollecting: 1, collectorHabit: 2, stillCollecting: 3, thousandMarks: { count: 3, domains: 1 }, almostComplete: { remaining: 1 } },
    };
    return { a, b, definitionsMap, edition };
  }

  it("Case A: close後の通常award、DB秒精度でawardedAt===closedAt・earnedAt=NULLはcreditしない（fail-closed）", () => {
    const { db, store, setClock } = setup();
    const { a, definitionsMap, edition } = twoMemberClosedFixtureForTie();

    setClock(BASE + 500);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 1000);
    store.closeCollectionEdition("tie-edition", "admin");
    const closedAt = store.collectionEdition("tie-edition")!.closedAt!;

    // 同秒tie: awardedAt===closedAtちょうど。observedAtも同じ秒に揃える。
    setClock(closedAt);
    directAward(store, "alice", a.definition, closedAt, null);

    const meta = metaRule("v2.test.tie.meta-a", (ctx) => {
      const target = ctx.snapshot.collectionEditions.find((x) => x.editionKey === "tie-edition");
      return (target?.progress.collectionOwnedCount ?? 0) > 0 ? { matched: true, awardFacts: {} } : { matched: false };
    });
    const plan = defineTitleEvaluationPlan([], [meta]);
    setClock(closedAt + 50);
    const result = evaluateUserPipeline(db, store, plan, "alice", closedAt + 50, "daily");
    expect(result.meta[0]!.outcome).toBe("not_matched");
  });

  it("Case B: historical repairでearnedAt===closedAtちょうど（<ではない）もcreditしない（fail-closed）", () => {
    const { db, store, setClock } = setup();
    const { a, b, definitionsMap, edition } = twoMemberClosedFixtureForTie();

    setClock(BASE + 500);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 1000);
    store.closeCollectionEdition("tie-edition", "admin");
    const closedAt = store.collectionEdition("tie-edition")!.closedAt!;

    // bはclose前に取得済み。
    setClock(BASE + 600);
    directAward(store, "bob", b.definition, BASE + 600, null);

    // aはhistorical repairだが、earnedAtがclosedAtと"ちょうど同じ"（<closedAtではない）。
    // resolveTitleScope()のeffectiveEnd制約(earnedAt<effectiveEnd)を満たすため、
    // observedAtをclosedAtより後にしてearnedAt=closedAtを許容させる。
    setClock(closedAt + 500);
    directAward(store, "bob", a.definition, closedAt + 500, closedAt);

    const meta = metaRule("v2.test.tie.meta-b", (ctx) => {
      const target = ctx.snapshot.collectionEditions.find((x) => x.editionKey === "tie-edition");
      return target?.progress.fullClearComplete === true ? { matched: true, awardFacts: {} } : { matched: false };
    });
    const plan = defineTitleEvaluationPlan([], [meta]);
    setClock(closedAt + 600);
    const result = evaluateUserPipeline(db, store, plan, "bob", closedAt + 600, "daily");
    // bは所持済みだがaはsame-second tieでcreditされないため、fullClearは未完了のまま。
    expect(result.meta[0]!.outcome).toBe("not_matched");
  });
});

describe("Collection milestone snapshotの将来実装可能性（PR #156 round 2レビュー §7、§37）", () => {
  const milestones = {
    startedCollecting: 1,
    collectorHabit: 5,
    stillCollecting: 10,
    thousandMarks: { count: 20, domains: 3 },
    almostComplete: { remaining: 2 },
  };

  function editionSnapshot(progress: Partial<MetaCollectionEditionSnapshot["progress"]>): MetaCollectionEditionSnapshot {
    return {
      editionKey: "contract-edition",
      state: "active",
      milestones,
      progress: {
        collectionOwnedCount: 0,
        collectionTotalCount: 25,
        collectionOwnedDomainCount: 0,
        collectionTotalDomainCount: 5,
        fullClearOwnedCount: 0,
        fullClearRequiredCount: 5,
        fullClearRemainingCount: 5,
        fullClearComplete: false,
        ...progress,
      },
    };
  }

  /** 将来のcollection meta ruleが実装するであろう、snapshotだけを見た純粋な閾値判定。 */
  function computeMilestoneFlags(edition: MetaCollectionEditionSnapshot) {
    const m = edition.milestones;
    const p = edition.progress;
    return {
      startedCollecting: p.collectionOwnedCount >= m.startedCollecting,
      collectorHabit: p.collectionOwnedCount >= m.collectorHabit,
      stillCollecting: p.collectionOwnedCount >= m.stillCollecting,
      thousandMarks: p.collectionOwnedCount >= m.thousandMarks.count && p.collectionOwnedDomainCount >= m.thousandMarks.domains,
      almostComplete: p.fullClearRemainingCount > 0 && p.fullClearRemainingCount <= m.almostComplete.remaining,
      fullClear: p.fullClearComplete,
    };
  }

  it("startedCollecting: ownedCount>=milestoneでtrue、未満でfalse", () => {
    expect(computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 0 })).startedCollecting).toBe(false);
    expect(computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 1 })).startedCollecting).toBe(true);
  });

  it("collectorHabit: ownedCount>=milestoneでtrue", () => {
    expect(computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 4 })).collectorHabit).toBe(false);
    expect(computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 5 })).collectorHabit).toBe(true);
  });

  it("stillCollecting: ownedCount>=milestoneでtrue", () => {
    expect(computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 9 })).stillCollecting).toBe(false);
    expect(computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 10 })).stillCollecting).toBe(true);
  });

  it("thousandMarks: ownedCountとownedDomainCountの両方を満たして初めてtrue（AND条件）", () => {
    expect(
      computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 20, collectionOwnedDomainCount: 2 })).thousandMarks,
    ).toBe(false); // domain不足
    expect(
      computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 19, collectionOwnedDomainCount: 3 })).thousandMarks,
    ).toBe(false); // count不足
    expect(
      computeMilestoneFlags(editionSnapshot({ collectionOwnedCount: 20, collectionOwnedDomainCount: 3 })).thousandMarks,
    ).toBe(true);
  });

  it("almostComplete: remaining>0かつremaining<=milestoneでtrue（fullClear達成済みはfalseになるguard込み）", () => {
    expect(computeMilestoneFlags(editionSnapshot({ fullClearRemainingCount: 2 })).almostComplete).toBe(true);
    expect(computeMilestoneFlags(editionSnapshot({ fullClearRemainingCount: 3 })).almostComplete).toBe(false); // 閾値超過
    expect(computeMilestoneFlags(editionSnapshot({ fullClearRemainingCount: 0 })).almostComplete).toBe(false); // 既にfull clear済み
  });

  it("fullClear: fullClearCompleteをそのまま使える", () => {
    expect(computeMilestoneFlags(editionSnapshot({ fullClearComplete: false })).fullClear).toBe(false);
    expect(computeMilestoneFlags(editionSnapshot({ fullClearComplete: true })).fullClear).toBe(true);
  });
});
