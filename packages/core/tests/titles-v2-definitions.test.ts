import { describe, expect, it } from "vitest";
import {
  defineBehaviorTitle,
  defineMetaTitle,
  type BehaviorTitleDefinition,
  type MetaTitleDefinition,
} from "../src/titles/v2-contract.js";
import { defineTitleRule, type TitleRule } from "../src/titles/v2-evaluator.js";

const BEHAVIOR_COMMON = {
  catalog: "v1",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "sample-theme",
  groupKey: "sample-group",
  scope: { type: "global" as const },
};

const META_COMMON = {
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "sample-theme",
  groupKey: "sample-group",
  scope: { type: "global" as const },
};

function validBehavior(overrides: Partial<BehaviorTitleDefinition> = {}): BehaviorTitleDefinition {
  return {
    kind: "behavior",
    key: "v2.test.behavior-sample",
    name: "sample",
    description: "テスト用",
    sources: ["bump_events"],
    triggers: ["bump_success"],
    lifecycle: "active",
    ...BEHAVIOR_COMMON,
    ...overrides,
  };
}

function validMeta(overrides: Partial<MetaTitleDefinition> = {}): MetaTitleDefinition {
  return {
    kind: "meta",
    key: "v2.test.meta-sample",
    name: "sample meta",
    description: "テスト用",
    lifecycle: "active",
    ...META_COMMON,
    ...overrides,
  };
}

describe("behavior/meta discriminator（§1）", () => {
  it("kindでbehavior/metaを判別できる", () => {
    const behavior = defineBehaviorTitle(validBehavior());
    const meta = defineMetaTitle(validMeta());
    expect(behavior.kind).toBe("behavior");
    expect(meta.kind).toBe("meta");
  });

  it("metaはsources/triggersを持たない（型レベルで存在しない）", () => {
    const meta = defineMetaTitle(validMeta());
    expect((meta as unknown as Record<string, unknown>).sources).toBeUndefined();
    expect((meta as unknown as Record<string, unknown>).triggers).toBeUndefined();
    expect((meta as unknown as Record<string, unknown>).catalog).toBeUndefined();
    expect((meta as unknown as Record<string, unknown>).progression).toBeUndefined();
  });

  it("metaがbehavior evaluatorへ渡せない（コンパイルエラー、かつruntimeでも二重に拒否される）", () => {
    const meta = validMeta();
    expect(() => {
      // @ts-expect-error MetaTitleDefinitionはBehaviorTitleDefinitionではないため、
      // defineTitleRule()の第1引数として渡すとコンパイルエラーになる——
      // 「meta titleをevaluateTitle()へ渡せないよう型で分離する」の直接的な証明。
      // TypeScriptを迂回されても、defineTitleRule()内部のdefineBehaviorTitle()が
      // kindを見てruntimeでも拒否する（型だけに依存しない）。
      const badRule: TitleRule<any> = defineTitleRule(meta, {
        awardFactsVersion: 1,
        evaluate: () => ({ matched: true, earnedAt: null, awardFacts: {} }),
      });
      return badRule;
    }).toThrow(/requires kind:"behavior"/);
  });

  it("defineBehaviorTitle()はkind!=='behavior'をruntimeでも拒否する", () => {
    const forged = { ...validBehavior(), kind: "meta" } as unknown as BehaviorTitleDefinition;
    expect(() => defineBehaviorTitle(forged)).toThrow(/requires kind:"behavior"/);
  });

  it("defineMetaTitle()はkind!=='meta'をruntimeでも拒否する", () => {
    const forged = { ...validMeta(), kind: "behavior" } as unknown as MetaTitleDefinition;
    expect(() => defineMetaTitle(forged)).toThrow(/requires kind:"meta"/);
  });
});

describe("behavior title guard（§3, §6）", () => {
  it("sourcesが最低1件必要", () => {
    expect(() => defineBehaviorTitle(validBehavior({ sources: [] }))).toThrow(/at least one source/);
  });

  it("triggersが最低1件必要", () => {
    expect(() => defineBehaviorTitle(validBehavior({ triggers: [] }))).toThrow(/at least one trigger/);
  });

  it("重複triggerを拒否する", () => {
    expect(() => defineBehaviorTitle(validBehavior({ triggers: ["daily", "daily"] }))).toThrow(/duplicate trigger/);
  });

  it("TypeScriptを迂回した未知のtriggerをruntimeで拒否する", () => {
    expect(() =>
      defineBehaviorTitle(validBehavior({ triggers: ["totally_unknown_trigger" as never] })),
    ).toThrow(/invalid trigger/);
  });

  it("progressionのseriesKeyはslug、stageは1始まりの正整数", () => {
    expect(() =>
      defineBehaviorTitle(validBehavior({ progression: { seriesKey: "bad key", stage: 1 } })),
    ).toThrow(/must be a slug/);
    expect(() =>
      defineBehaviorTitle(validBehavior({ progression: { seriesKey: "ok-series", stage: 0 } })),
    ).toThrow(/positive integer/);
    expect(
      defineBehaviorTitle(validBehavior({ progression: { seriesKey: "ok-series", stage: 1 } })).progression,
    ).toEqual({ seriesKey: "ok-series", stage: 1 });
  });
});

describe("lifecycleにseasonalは存在しない（§4）", () => {
  it("旧seasonal値はruntimeで拒否される", () => {
    expect(() => defineBehaviorTitle(validBehavior({ lifecycle: "seasonal" as never }))).toThrow(
      /invalid lifecycle/,
    );
  });

  it("active/retired/disabledは通る", () => {
    for (const lifecycle of ["active", "retired", "disabled"] as const) {
      expect(defineBehaviorTitle(validBehavior({ lifecycle })).lifecycle).toBe(lifecycle);
    }
  });
});

describe("scope policy validation（§5, §6）", () => {
  it("不正なscope.typeを拒否する", () => {
    expect(() => defineBehaviorTitle(validBehavior({ scope: { type: "bogus" } as never }))).toThrow(
      /invalid scope\.type/,
    );
  });

  it("metaはscope.type==='global'以外を拒否する（catalog参照が無いため）", () => {
    for (const scope of [{ type: "catalog" }, { type: "month" }, { type: "event", eventKey: "x" }] as const) {
      expect(() => defineMetaTitle(validMeta({ scope }))).toThrow(/only support scope\.type="global"/);
    }
  });

  it("themeKey/groupKey/catalog/eventKeyはslugでなければ拒否する（コロンや空白を許可しない）", () => {
    expect(() => defineBehaviorTitle(validBehavior({ themeKey: "bad:theme" }))).toThrow(/must be a slug/);
    expect(() => defineBehaviorTitle(validBehavior({ groupKey: "bad group" }))).toThrow(/must be a slug/);
    expect(() => defineBehaviorTitle(validBehavior({ catalog: "bad:catalog" }))).toThrow(/must be a slug/);
    expect(() => defineBehaviorTitle(validBehavior({ scope: { type: "event", eventKey: "bad:key" } }))).toThrow(
      /must be a slug/,
    );
  });
});
