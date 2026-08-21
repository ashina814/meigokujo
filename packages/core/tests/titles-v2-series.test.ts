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

  it("themeKeyが異なるmemberをreject", () => {
    const members = validLadder();
    members[1] = stage("v2.test.ignite-2", {
      progression: { seriesKey: "vc_ignite_main", stage: 2 },
      themeKey: "other-theme",
    });
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/different themeKey/);
  });

  it("groupKeyが異なるmemberをreject", () => {
    const members = validLadder();
    members[1] = stage("v2.test.ignite-2", {
      progression: { seriesKey: "vc_ignite_main", stage: 2 },
      groupKey: "other-group",
    });
    expect(() => assertValidSeriesManifest(manifestOf(members), members)).toThrow(/different groupKey/);
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

  it("後からstage4を追加しても、既存manifestのmembersは変えない（immutable運用の確認）", () => {
    const members = validLadder();
    const originalManifest = manifestOf(members);
    const frozenMembers = [...originalManifest.members];

    // 新stageを追加する場合は「新しいmanifest」を作る想定——既存オブジェクトを書き換えない。
    const stage4 = stage("v2.test.ignite-4", { progression: { seriesKey: "vc_ignite_main", stage: 4 } });
    const expandedManifest: TitleSeriesManifest = {
      ...originalManifest,
      members: [...originalManifest.members, stage4.key],
    };

    expect(originalManifest.members).toEqual(frozenMembers);
    expect(expandedManifest.members).not.toEqual(frozenMembers);
    expect(() => assertValidSeriesManifest(expandedManifest, [...members, stage4])).not.toThrow();
  });
});
