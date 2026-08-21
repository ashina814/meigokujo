import { describe, expect, it } from "vitest";
import { defineBehaviorTitle, defineMetaTitle, type TitleDefinition } from "../src/titles/v2-contract.js";
import { assertValidCollectionEdition, type TitleCollectionEdition } from "../src/titles/v2-collection.js";

function behavior(key: `v2.${string}`, themeKey: string): TitleDefinition {
  return defineBehaviorTitle({
    kind: "behavior",
    key,
    catalog: "v1",
    name: key,
    emoji: "🖋",
    description: "テスト用",
    sources: ["bump_events"],
    triggers: ["daily"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey,
    groupKey: themeKey,
    scope: { type: "global" },
  });
}

function meta(key: `v2.${string}`, themeKey: string): TitleDefinition {
  return defineMetaTitle({
    kind: "meta",
    key,
    name: key,
    emoji: "🖋",
    description: "テスト用",
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey,
    groupKey: themeKey,
    scope: { type: "global" },
  });
}

function definitionsMap(defs: readonly TitleDefinition[]): ReadonlyMap<string, TitleDefinition> {
  return new Map(defs.map((d) => [d.key, d]));
}

// 単一theme・単一fullClearRequired memberの最小fixtureでも矛盾しない、安全な既定値。
// テストごとに矛盾させたい値だけを明示的に上書きする。
const VALID_MILESTONES = {
  startedCollecting: 1,
  collectorHabit: 5,
  stillCollecting: 20,
  thousandMarks: { count: 1000, themes: 1 },
  almostComplete: { remaining: 0 },
};

describe("collection edition validation（§10）", () => {
  it("正常なeditionは通る", () => {
    const a = behavior("v2.test.a", "theme-a");
    const b = behavior("v2.test.b", "theme-b");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [
        { titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.key, themeKey: "theme-b", collectionCredit: true, fullClearRequired: false },
      ],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a, b]))).not.toThrow();
  });

  it("member重複をreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [
        { titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true },
        { titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false },
      ],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(/duplicate member/);
  });

  it("member titleが存在しないとreject", () => {
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [{ titleKey: "v2.test.ghost", themeKey: "theme-a", collectionCredit: true, fullClearRequired: true }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([]))).toThrow(/member title not found/);
  });

  it("themeKeyがdefinitionと不一致ならreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [{ titleKey: a.key, themeKey: "wrong-theme", collectionCredit: true, fullClearRequired: true }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(/themeKey mismatch/);
  });

  it("meta titleをfullClearRequiredにできない", () => {
    const m = meta("v2.test.meta-a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [{ titleKey: m.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([m]))).toThrow(
      /meta title cannot be fullClearRequired/,
    );
  });

  it("meta titleをcollectionCreditにするのは許可される（fullClearRequiredでなければ）", () => {
    const m = meta("v2.test.meta-a", "theme-a");
    const b = behavior("v2.test.b", "theme-b");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [
        { titleKey: m.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false },
        { titleKey: b.key, themeKey: "theme-b", collectionCredit: true, fullClearRequired: true },
      ],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([m, b]))).not.toThrow();
  });

  it("fullClearRequired memberが1件も無いとreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [{ titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(/at least one fullClearRequired/);
  });

  it("milestone値の負数をreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [{ titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true }],
      milestones: { ...VALID_MILESTONES, collectorHabit: -1 },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(/non-negative integer/);
  });

  it("thousandMarks.themesが数えられるtheme数を超えるとreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [{ titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true }],
      milestones: { ...VALID_MILESTONES, thousandMarks: { count: 1000, themes: 5 } }, // themeは1種類しか無い
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(/exceeds countable theme count/);
  });

  it("almostComplete.remainingがfull-clear必須総数以上ならreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      catalog: "v1",
      members: [{ titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true }],
      milestones: { ...VALID_MILESTONES, almostComplete: { remaining: 1 } }, // fullClear必須は1件だけ
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(
      /must be less than the full-clear required count/,
    );
  });
});
