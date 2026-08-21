import { describe, expect, it } from "vitest";
import { defineBehaviorTitle, defineMetaTitle, type TitleDefinition, type TitleLifecycle } from "../src/titles/v2-contract.js";
import {
  assertCollectionEditionActivatable,
  assertValidCollectionEdition,
  type TitleCollectionEdition,
} from "../src/titles/v2-collection.js";

function behavior(key: `v2.${string}`, themeKey: string, lifecycle: TitleLifecycle = "active"): TitleDefinition {
  return defineBehaviorTitle({
    kind: "behavior",
    key,
    catalog: "v1",
    name: key,
    emoji: "🖋",
    description: "テスト用",
    sources: ["bump_events"],
    triggers: ["daily"],
    lifecycle,
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

// countableCount=5（collectionCredit:trueが5件）、countableThemes=2（theme-a/theme-b）、
// fullClearCount=2（a, bがfullClearRequired）——このスケールなら
// startedCollecting(1) < collectorHabit(2) < stillCollecting(3) <= thousandMarks.count(5)
// <= countableCount(5) というmilestoneの連鎖が矛盾なく成立する。2title程度の小さい
// fixtureだと連鎖する不等式を同時に満たせない（後述のテストで個別に確認する）。
function fiveMemberFixture(): { defs: TitleDefinition[]; members: TitleCollectionEdition["members"] } {
  const a = behavior("v2.test.a", "theme-a");
  const b = behavior("v2.test.b", "theme-a");
  const c = behavior("v2.test.c", "theme-a");
  const d = behavior("v2.test.d", "theme-b");
  const e = behavior("v2.test.e", "theme-b");
  return {
    defs: [a, b, c, d, e],
    members: [
      { titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true },
      { titleKey: b.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true },
      { titleKey: c.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false },
      { titleKey: d.key, themeKey: "theme-b", collectionCredit: true, fullClearRequired: false },
      { titleKey: e.key, themeKey: "theme-b", collectionCredit: true, fullClearRequired: false },
    ],
  };
}

const VALID_MILESTONES = {
  startedCollecting: 1,
  collectorHabit: 2,
  stillCollecting: 3,
  thousandMarks: { count: 5, themes: 2 },
  almostComplete: { remaining: 1 },
};

describe("collection edition validation（§10）", () => {
  it("正常なeditionは通る", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).not.toThrow();
  });

  it("catalogフィールドを持たない（複数catalog由来のtitleを1つのeditionへ束ねられる設計）", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: VALID_MILESTONES,
    };
    // TitleCollectionEditionにcatalogプロパティを渡そうとするとコンパイルエラーになる
    // ——member単位でtitleKeyからdefinitionを引くだけで検証は成立し、edition自体は
    // 特定1catalogへ拘束されない。
    // @ts-expect-error catalogはTitleCollectionEditionに存在しないフィールド
    edition.catalog = "v1";
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).not.toThrow();
  });

  it("member重複をreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
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
      members: [{ titleKey: "v2.test.ghost", themeKey: "theme-a", collectionCredit: true, fullClearRequired: true }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([]))).toThrow(/member title not found/);
  });

  it("themeKeyがdefinitionと不一致ならreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [{ titleKey: a.key, themeKey: "wrong-theme", collectionCredit: true, fullClearRequired: true }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(/themeKey mismatch/);
  });

  it("meta titleをfullClearRequiredにできない", () => {
    const m = meta("v2.test.meta-a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [{ titleKey: m.key, themeKey: "theme-a", collectionCredit: false, fullClearRequired: true }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([m]))).toThrow(
      /meta title cannot be fullClearRequired/,
    );
  });

  it("meta titleをcollectionCreditにもできない（meta titleはcollection/full-clearの分母・分子どちらへも入らない）", () => {
    const m = meta("v2.test.meta-a", "theme-a");
    const b = behavior("v2.test.b", "theme-b");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [
        { titleKey: m.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false },
        { titleKey: b.key, themeKey: "theme-b", collectionCredit: true, fullClearRequired: true },
      ],
      milestones: {
        startedCollecting: 1,
        collectorHabit: 2,
        stillCollecting: 2,
        thousandMarks: { count: 1, themes: 1 },
        almostComplete: { remaining: 1 },
      },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([m, b]))).toThrow(
      /meta title cannot be a collection member \(collectionCredit\)/,
    );
  });

  it("fullClearRequired memberが1件も無いとreject", () => {
    const a = behavior("v2.test.a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [{ titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false }],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a]))).toThrow(/at least one fullClearRequired/);
  });

  it("collectionCredit:falseかつfullClearRequired:falseのmemberをreject（editionのmemberとして意味が無い）", () => {
    const a = behavior("v2.test.a", "theme-a");
    const b = behavior("v2.test.b", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [
        { titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.key, themeKey: "theme-a", collectionCredit: false, fullClearRequired: false },
      ],
      milestones: VALID_MILESTONES,
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a, b]))).toThrow(
      /is neither collectionCredit nor fullClearRequired/,
    );
  });

  it("milestone値の負数をreject", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, collectorHabit: -1 },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(/non-negative integer/);
  });

  it("collectionCredit:falseのmemberのthemeはcountableThemesに数えない", () => {
    // a/b/cはtheme-aでcollectionCredit:true（countableCount=3, countableThemes={theme-a}=1）。
    // dはtheme-bだがcollectionCredit:falseなので、countableThemesにtheme-bは数えない
    // （dはfullClearRequired:trueにしてedition memberとしての意味を持たせる——
    // collectionCredit/fullClearRequiredが両方falseのmemberはそれ自体が別途禁止されている）。
    const a = behavior("v2.test.a", "theme-a");
    const b = behavior("v2.test.b", "theme-a");
    const c = behavior("v2.test.c", "theme-a");
    const d = behavior("v2.test.d", "theme-b");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [
        { titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false },
        { titleKey: c.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: false },
        { titleKey: d.key, themeKey: "theme-b", collectionCredit: false, fullClearRequired: true },
      ],
      milestones: {
        startedCollecting: 1,
        collectorHabit: 2,
        stillCollecting: 3,
        thousandMarks: { count: 3, themes: 2 }, // themes=2はtheme-bも数えた場合の値。countableThemesは1のはず
        almostComplete: { remaining: 1 },
      },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap([a, b, c, d]))).toThrow(
      /thousandMarks\.themes \(2\) exceeds countable theme count \(1\)/,
    );
  });

  it("startedCollecting >= 1", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, startedCollecting: 0, collectorHabit: 1 },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(/startedCollecting \(0\) must be >= 1/);
  });

  it("startedCollecting < collectorHabit", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, startedCollecting: 2, collectorHabit: 2 },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(
      /startedCollecting \(2\) must be < collectorHabit \(2\)/,
    );
  });

  it("collectorHabit < stillCollecting", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, collectorHabit: 3, stillCollecting: 3 },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(
      /collectorHabit \(3\) must be < stillCollecting \(3\)/,
    );
  });

  it("stillCollecting <= thousandMarks.count", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, stillCollecting: 5, thousandMarks: { count: 4, themes: 2 } },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(
      /stillCollecting \(5\) must be <= thousandMarks\.count \(4\)/,
    );
  });

  it("thousandMarks.count <= countableCount", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, thousandMarks: { count: 1000, themes: 2 } },
    };
    // 2タイトルしか無いfixtureではなく、5タイトルの現実的なfixtureでもcountableCount(5)を
    // 超えるthousandMarks.countは無効——「集める対象」の総数を超える閾値は意味を成さない。
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(
      /thousandMarks\.count \(1000\) exceeds countable collection count \(5\)/,
    );
  });

  it("thousandMarks.themes >= 1", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, thousandMarks: { count: 5, themes: 0 } },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(/thousandMarks\.themes \(0\) must be >= 1/);
  });

  it("thousandMarks.themesが数えられるtheme数を超えるとreject", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, thousandMarks: { count: 5, themes: 3 } }, // themeはtheme-a/theme-bの2種類しか無い
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(/exceeds countable theme count/);
  });

  it("thousandMarks.themes <= thousandMarks.count", () => {
    // 5テーマ×5タイトル（1テーマ1タイトル）にして、countableThemes=5を確保する
    // ——先に評価される「themes<=countableThemes」チェックに引っかからないようにする。
    const a = behavior("v2.test.a", "theme-a");
    const b = behavior("v2.test.b", "theme-b");
    const c = behavior("v2.test.c", "theme-c");
    const d = behavior("v2.test.d", "theme-d");
    const e = behavior("v2.test.e", "theme-e");
    const defs = [a, b, c, d, e];
    const members: TitleCollectionEdition["members"] = defs.map((def, i) => ({
      titleKey: def.key,
      themeKey: def.themeKey,
      collectionCredit: true,
      fullClearRequired: i === 0,
    }));
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, thousandMarks: { count: 3, themes: 4 } },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(
      /thousandMarks\.themes \(4\) must be <= thousandMarks\.count \(3\)/,
    );
  });

  it("almostComplete.remaining >= 1", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, almostComplete: { remaining: 0 } },
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(
      /almostComplete\.remaining \(0\) must be >= 1/,
    );
  });

  it("almostComplete.remainingがfull-clear必須総数以上ならreject", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: { ...VALID_MILESTONES, almostComplete: { remaining: 2 } }, // fullClear必須は2件しか無い
    };
    expect(() => assertValidCollectionEdition(edition, definitionsMap(defs))).toThrow(
      /must be less than the full-clear required count/,
    );
  });
});

describe("構造契約とactivation eligibilityの分離（historical repairとの整合性）", () => {
  it("全member activeなら構造validation・activation validationの両方を通る", () => {
    const { defs, members } = fiveMemberFixture();
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members,
      milestones: VALID_MILESTONES,
    };
    const map = definitionsMap(defs);
    expect(() => assertValidCollectionEdition(edition, map)).not.toThrow();
    expect(() => assertCollectionEditionActivatable(edition, map)).not.toThrow();
  });

  it("retired memberを含むeditionは構造validationは通るがactivation validationはreject（最低限）", () => {
    // historical closed editionの想定: fullClearRequired titleが後日retiredになっても、
    // edition自体のmanifestは書き換えない——構造としては引き続き有効（repairに使える）。
    // milestone連鎖を成立させるためfiveMemberFixture()を使い、fullClearRequired:trueな
    // memberの1つ（a）だけをretiredへ差し替える。
    const { defs, members } = fiveMemberFixture();
    const retiredDefs = defs.map((d) => (d.key === "v2.test.a" ? behavior("v2.test.a", "theme-a", "retired") : d));
    const edition: TitleCollectionEdition = { editionKey: "v1-edition", members, milestones: VALID_MILESTONES };
    const map = definitionsMap(retiredDefs);
    expect(() => assertValidCollectionEdition(edition, map)).not.toThrow();
    expect(() => assertCollectionEditionActivatable(edition, map)).toThrow(
      /cannot activate — member .* is not active \(lifecycle=retired\)/,
    );
  });

  it("disabled memberを含むeditionは構造validationは通るがactivation validationはreject（collectionCreditのみでも同様）", () => {
    // cはcollectionCredit:trueのみ（fullClearRequired:false）——fullClearRequiredで
    // なくてもlifecycleチェックが効くことを確認する。
    const { defs, members } = fiveMemberFixture();
    const disabledDefs = defs.map((d) => (d.key === "v2.test.c" ? behavior("v2.test.c", "theme-a", "disabled") : d));
    const edition: TitleCollectionEdition = { editionKey: "v1-edition", members, milestones: VALID_MILESTONES };
    const map = definitionsMap(disabledDefs);
    expect(() => assertValidCollectionEdition(edition, map)).not.toThrow();
    expect(() => assertCollectionEditionActivatable(edition, map)).toThrow(
      /cannot activate — member .* is not active \(lifecycle=disabled\)/,
    );
  });

  it("collectionCredit/fullClearRequiredが両方falseのmemberは構造validationの時点でreject（activationまで進まない）", () => {
    const a = behavior("v2.test.a", "theme-a");
    const b = behavior("v2.test.b", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [
        { titleKey: a.key, themeKey: "theme-a", collectionCredit: true, fullClearRequired: true },
        { titleKey: b.key, themeKey: "theme-a", collectionCredit: false, fullClearRequired: false },
      ],
      milestones: VALID_MILESTONES,
    };
    const map = definitionsMap([a, b]);
    expect(() => assertValidCollectionEdition(edition, map)).toThrow(/is neither collectionCredit nor fullClearRequired/);
    expect(() => assertCollectionEditionActivatable(edition, map)).toThrow(/is neither collectionCredit nor fullClearRequired/);
  });

  it("meta titleのfail-closedチェックは構造validation側に残っている（activation eligibilityへ移していない）", () => {
    const m = meta("v2.test.meta-a", "theme-a");
    const edition: TitleCollectionEdition = {
      editionKey: "v1-edition",
      members: [{ titleKey: m.key, themeKey: "theme-a", collectionCredit: false, fullClearRequired: true }],
      milestones: VALID_MILESTONES,
    };
    const map = definitionsMap([m]);
    expect(() => assertValidCollectionEdition(edition, map)).toThrow(/meta title cannot be fullClearRequired/);
    expect(() => assertCollectionEditionActivatable(edition, map)).toThrow(/meta title cannot be fullClearRequired/);
  });
});
