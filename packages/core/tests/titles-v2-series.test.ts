import { describe, expect, it } from "vitest";
import { defineBehaviorTitle, type BehaviorTitleDefinition } from "../src/titles/v2-contract.js";
import {
  assertNoOverlappingSeriesMembership,
  assertValidSeriesManifest,
  type TitleSeriesManifest,
} from "../src/titles/v2-series.js";

function stage(
  key: `v2.${string}`,
  overrides: Partial<BehaviorTitleDefinition> & { progression: NonNullable<BehaviorTitleDefinition["progression"]> },
): BehaviorTitleDefinition {
  return defineBehaviorTitle({
    kind: "behavior",
    key,
    catalog: "v1",
    name: key,
    emoji: "🔥",
    description: "テスト用",
    sources: ["bump_events"],
    triggers: ["daily"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey: "vc_ignite",
    groupKey: "vc_ignite",
    collectionDomainKey: "vc_ignite",
    scope: { type: "global" },
    ...overrides,
  });
}

function validLadder(): BehaviorTitleDefinition[] {
  return [
    stage("v2.test.ignite-1", { progression: { seriesKey: "vc_ignite_main", stage: 1 } }),
    stage("v2.test.ignite-2", { progression: { seriesKey: "vc_ignite_main", stage: 2 } }),
    stage("v2.test.ignite-3", { progression: { seriesKey: "vc_ignite_main", stage: 3 } }),
  ];
}

function manifestOf(members: readonly BehaviorTitleDefinition[]): TitleSeriesManifest {
  return {
    catalog: "v1",
    seriesKey: "vc_ignite_main",
    label: "場を起こす",
    masteryEligible: true,
    members: members.map((d) => d.key),
  };
}

describe("series manifest validation（§9）", () => {
  it("正常な連番ladderは通る", () => {
    const members = validLadder();
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).not.toThrow();
  });

  it("members >= 2 を要求する", () => {
    const members = [stage("v2.test.solo", { progression: { seriesKey: "vc_ignite_main", stage: 1 } })];
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/at least 2 members/);
  });

  it("member titleが存在しないとreject", () => {
    const members = validLadder();
    const manifest = { ...manifestOf(members), members: [...manifestOf(members).members, "v2.test.ghost" as const] };
    expect(() => assertValidSeriesManifest(manifest, members)).toThrow(/member title not found/);
  });

  it("stage重複をreject", () => {
    const members = [
      stage("v2.test.dup-1", { progression: { seriesKey: "vc_ignite_main", stage: 1 } }),
      stage("v2.test.dup-2", { progression: { seriesKey: "vc_ignite_main", stage: 1 } }),
    ];
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/duplicate stage/);
  });

  it("stageの欠番（1,2,4）をreject", () => {
    const members = [
      stage("v2.test.gap-1", { progression: { seriesKey: "vc_ignite_main", stage: 1 } }),
      stage("v2.test.gap-2", { progression: { seriesKey: "vc_ignite_main", stage: 2 } }),
      stage("v2.test.gap-4", { progression: { seriesKey: "vc_ignite_main", stage: 4 } }),
    ];
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/contiguous sequence/);
  });

  it("themeKeyが異なっていてもsame group/seriesならvalid（themeはlogicに使わない、契約correction B）", () => {
    const members = validLadder();
    members[1] = stage("v2.test.ignite-2", {
      progression: { seriesKey: "vc_ignite_main", stage: 2 },
      themeKey: "other-theme",
    });
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).not.toThrow();
  });

  it("groupKeyが異なるmemberをreject", () => {
    const members = validLadder();
    members[1] = stage("v2.test.ignite-2", {
      progression: { seriesKey: "vc_ignite_main", stage: 2 },
      groupKey: "other-group",
    });
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/different groupKey/);
  });

  it("manifest.catalogはslugでなければ拒否する", () => {
    const members = validLadder();
    const manifest = { ...manifestOf(members), catalog: "bad:catalog" };
    expect(() => assertValidSeriesManifest(manifest, members)).toThrow(/must be a slug/);
  });

  it("catalogが異なるmemberをreject", () => {
    const members = validLadder();
    members[1] = stage("v2.test.ignite-2", {
      progression: { seriesKey: "vc_ignite_main", stage: 2 },
      catalog: "v2",
    });
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/different catalog/);
  });

  it("progressionを持たない・seriesKeyが違うmemberをreject", () => {
    const members = validLadder();
    members[1] = stage("v2.test.ignite-2", { progression: { seriesKey: "other-series", stage: 2 } });
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/does not declare progression/);
  });

  it("manifest内のmember重複をreject", () => {
    const members = validLadder();
    const manifest = { ...manifestOf(members), members: [members[0]!.key, members[0]!.key, members[1]!.key] };
    expect(() => assertValidSeriesManifest(manifest, members)).toThrow(/duplicate member/);
  });

  it("1titleが複数seriesへ所属することをmanifest横断で拒否する", () => {
    const members = validLadder();
    const seriesA: TitleSeriesManifest = manifestOf(members);
    const otherLadder = [
      stage("v2.test.other-1", { progression: { seriesKey: "other_series", stage: 1 } }),
      stage("v2.test.other-2", { progression: { seriesKey: "other_series", stage: 2 } }),
    ];
    const seriesB: TitleSeriesManifest = {
      ...manifestOf(otherLadder),
      seriesKey: "other_series",
      // わざとseriesAのmemberを混ぜる
      members: [...manifestOf(otherLadder).members, members[0]!.key],
    };
    expect(() => assertNoOverlappingSeriesMembership([seriesA, seriesB])).toThrow(/belongs to multiple series/);
  });

  it("同じseriesKey文字列でもcatalogが異なれば別identityとして扱い、overlapを見逃さない", () => {
    // owner mapがcatalogを見ずseriesKeyだけで比較していると、
    // 「catalog-a/foo」と「catalog-b/foo」を同一seriesとみなしてoverlapを
    // 見逃してしまうバグを再現する回帰テスト。
    const sharedTitle = stage("v2.test.shared", { catalog: "catalog-a", progression: { seriesKey: "foo", stage: 1 } });
    const restOfA = stage("v2.test.rest-a", { catalog: "catalog-a", progression: { seriesKey: "foo", stage: 2 } });
    const seriesA: TitleSeriesManifest = {
      catalog: "catalog-a",
      seriesKey: "foo",
      label: "A",
      masteryEligible: true,
      members: [sharedTitle.key, restOfA.key],
    };
    const restOfB = stage("v2.test.rest-b", { catalog: "catalog-b", progression: { seriesKey: "foo", stage: 2 } });
    const seriesB: TitleSeriesManifest = {
      catalog: "catalog-b",
      seriesKey: "foo",
      label: "B",
      masteryEligible: true,
      // sharedTitleのkeyを誤って別catalogのseriesへも混ぜてしまった想定
      // （sharedTitle自体はcatalog-a/foo向けのprogressionしか持たない）。
      members: [sharedTitle.key, restOfB.key],
    };
    expect(() => assertNoOverlappingSeriesMembership([seriesA, seriesB])).toThrow(
      /belongs to multiple series: catalog-a\/foo, catalog-b\/foo/,
    );
  });

  it("同一(catalog, seriesKey)を名乗るmanifestが複数存在することをreject（memberが重複していなくても）", () => {
    const members = validLadder();
    const original: TitleSeriesManifest = manifestOf(members);
    // stage4を追加した「新しい」manifestのつもりで作ったが、同じ(catalog, seriesKey)を
    // 名乗ったまま元のmanifestと並存させてしまった——想定される事故パターン。
    const stage4 = stage("v2.test.ignite-4", { progression: { seriesKey: "vc_ignite_main", stage: 4 } });
    const wronglyCoexisting: TitleSeriesManifest = {
      ...original,
      members: [...original.members, stage4.key],
    };
    expect(() => assertNoOverlappingSeriesMembership([original, wronglyCoexisting])).toThrow(
      /series identity \(catalog, seriesKey\) is used by multiple manifests/,
    );
  });

  it("新しいladderが欲しい場合は新しいseriesKey + 新しいtitle key群を作る（released seriesのmembersは変えない）", () => {
    const originalMembers = validLadder();
    const originalManifest = manifestOf(originalMembers);
    const frozenMembers = [...originalManifest.members];

    // 「stage4を追加する」場合でも、既存の(catalog, seriesKey)を使い回さない——
    // 別のseriesKey配下に、新しいtitle key群（stage1-4）を作り直す。既存の
    // 《一門皆伝》条件（vc_ignite_mainの3段）は事後的に変わらない。
    const nextGenMembers = [
      stage("v2.test.ignite-v2-1", { progression: { seriesKey: "vc_ignite_main_v2", stage: 1 } }),
      stage("v2.test.ignite-v2-2", { progression: { seriesKey: "vc_ignite_main_v2", stage: 2 } }),
      stage("v2.test.ignite-v2-3", { progression: { seriesKey: "vc_ignite_main_v2", stage: 3 } }),
      stage("v2.test.ignite-v2-4", { progression: { seriesKey: "vc_ignite_main_v2", stage: 4 } }),
    ];
    const nextGenManifest: TitleSeriesManifest = {
      catalog: "v1",
      seriesKey: "vc_ignite_main_v2",
      label: "場を起こす（4段版）",
      masteryEligible: true,
      members: nextGenMembers.map((d) => d.key),
    };

    // 元のmanifestのmembersは一切変わっていない。
    expect(originalManifest.members).toEqual(frozenMembers);
    // 新しいseriesKeyを使えば単独でvalidであり、既存manifestと(catalog, seriesKey)の
    // identityが衝突しないため並存できる。
    expect(() => assertValidSeriesManifest(nextGenManifest, nextGenMembers)).not.toThrow();
    expect(() => assertNoOverlappingSeriesMembership([originalManifest, nextGenManifest])).not.toThrow();
  });
});
