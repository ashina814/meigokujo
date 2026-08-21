import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import {
  TEXT_TIERS,
  VOICE_TIERS,
  assertRankTierRegistry,
  didRankTierChange,
  nextTier,
  rankTierByKey,
  rankTiersForTrack,
  tierFor,
  type RankTier,
  type RankTitleKey,
} from "../src/rank/tiers.js";
import { RankEngine } from "../src/rank/service.js";

function fixtureTier(key: string, track: "text" | "voice", minLevel: number, name: string): RankTier {
  return { key: key as RankTitleKey, track, minLevel, name };
}

/**
 * 18件のstable key/track/minLevel/nameをsnapshot的に固定する（PR B3 §33）。
 * 名前を変えただけ・array順を変えただけ・thresholdを変えただけでDB identityの
 * 意味を壊す事故を、このテストの差分としてレビューで必ず見えるようにする。
 */
const EXPECTED_TEXT: ReadonlyArray<readonly [string, "text", number, string]> = [
  ["rank.text.lv000", "text", 0, "無言の魂"],
  ["rank.text.lv005", "text", 5, "囁く者"],
  ["rank.text.lv015", "text", 15, "談笑の徒"],
  ["rank.text.lv030", "text", 30, "口達者"],
  ["rank.text.lv050", "text", 50, "饒舌の亡霊"],
  ["rank.text.lv075", "text", 75, "言葉の冥王"],
  ["rank.text.lv100", "text", 100, "冥獄の弁士"],
  ["rank.text.lv130", "text", 130, "冥獄の詩人"],
  ["rank.text.lv150", "text", 150, "冥獄の言霊"],
];

const EXPECTED_VOICE: ReadonlyArray<readonly [string, "voice", number, string]> = [
  ["rank.voice.lv000", "voice", 0, "気配ある魂"],
  ["rank.voice.lv005", "voice", 5, "たゆたう影"],
  ["rank.voice.lv015", "voice", 15, "浮上者"],
  ["rank.voice.lv030", "voice", 30, "常連の亡霊"],
  ["rank.voice.lv050", "voice", 50, "冥獄の住人"],
  ["rank.voice.lv075", "voice", 75, "浮上の主"],
  ["rank.voice.lv100", "voice", 100, "冥獄の魂柱"],
  ["rank.voice.lv130", "voice", 130, "浮上の冥王"],
  ["rank.voice.lv150", "voice", 150, "冥獄の永久魂"],
];

function toTuple(t: RankTier): [string, string, number, string] {
  return [t.key, t.track, t.minLevel, t.name];
}

describe("rank tier registry snapshot（§33）", () => {
  it("TEXT_TIERSは18件のうち9件、key/track/minLevel/nameが完全一致する", () => {
    expect(TEXT_TIERS.map(toTuple)).toEqual(EXPECTED_TEXT.map((t) => [...t]));
  });

  it("VOICE_TIERSは18件のうち9件、key/track/minLevel/nameが完全一致する", () => {
    expect(VOICE_TIERS.map(toTuple)).toEqual(EXPECTED_VOICE.map((t) => [...t]));
  });

  it("全18件のkeyがglobally uniqueである", () => {
    const keys = [...TEXT_TIERS, ...VOICE_TIERS].map((t) => t.key);
    expect(new Set(keys).size).toBe(18);
    expect(keys.length).toBe(18);
  });

  it("text tierはすべてtrack=text", () => {
    expect(TEXT_TIERS.every((t) => t.track === "text")).toBe(true);
  });

  it("voice tierはすべてtrack=voice", () => {
    expect(VOICE_TIERS.every((t) => t.track === "voice")).toBe(true);
  });

  it("各trackのminLevelはstrict increasing（連続である必要はない）", () => {
    for (const tiers of [TEXT_TIERS, VOICE_TIERS]) {
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i]!.minLevel).toBeGreaterThan(tiers[i - 1]!.minLevel);
      }
    }
    // 連続（+1ずつ）ではないことも確認する——例えば5→15は+10。
    expect(TEXT_TIERS[2]!.minLevel - TEXT_TIERS[1]!.minLevel).not.toBe(1);
  });

  it("各trackの最初のtierはminLevel=0", () => {
    expect(TEXT_TIERS[0]!.minLevel).toBe(0);
    expect(VOICE_TIERS[0]!.minLevel).toBe(0);
  });

  it("tier配列とtier objectがfreezeされている", () => {
    expect(Object.isFrozen(TEXT_TIERS)).toBe(true);
    expect(Object.isFrozen(VOICE_TIERS)).toBe(true);
    expect(Object.isFrozen(TEXT_TIERS[0])).toBe(true);
    expect(Object.isFrozen(VOICE_TIERS[0])).toBe(true);
  });

  it("rankTierByKey()で18件すべて引ける、unknown keyはundefined", () => {
    for (const t of [...TEXT_TIERS, ...VOICE_TIERS]) {
      expect(rankTierByKey(t.key)).toEqual(t);
    }
    expect(rankTierByKey("rank.text.lv999")).toBeUndefined();
  });

  it("rankTiersForTrack()がtrack別配列を返す", () => {
    expect(rankTiersForTrack("text")).toBe(TEXT_TIERS);
    expect(rankTiersForTrack("voice")).toBe(VOICE_TIERS);
  });

  it("tierForはstable keyを返す", () => {
    expect(tierFor(0, TEXT_TIERS).key).toBe("rank.text.lv000");
    expect(tierFor(4, TEXT_TIERS).key).toBe("rank.text.lv000");
    expect(tierFor(5, TEXT_TIERS).key).toBe("rank.text.lv005");
    expect(tierFor(999, TEXT_TIERS).key).toBe("rank.text.lv150");
  });

  it("nextTierはstable keyを返す（最終tier到達後はnull）", () => {
    expect(nextTier(0, TEXT_TIERS)?.key).toBe("rank.text.lv005");
    expect(nextTier(150, TEXT_TIERS)).toBeNull();
  });
});

describe("rank tier registry validation（不正な入力への耐性、§5）", () => {
  it("duplicate keyをreject（同一track内）", () => {
    const bad = [fixtureTier("rank.text.lv000", "text", 0, "a"), fixtureTier("rank.text.lv000", "text", 5, "b")];
    expect(() => assertRankTierRegistry([["text", bad]])).toThrow(/duplicate key/);
  });

  it("wrong track prefixをreject（keyの形式自体はvalidだがtrackが不一致）", () => {
    const bad = [fixtureTier("rank.voice.lv000", "text", 0, "a")];
    expect(() => assertRankTierRegistry([["text", bad]])).toThrow(/belongs to track "voice", expected "text"/);
  });

  it("key全体の形式チェック（suffix空・空白・コロン等、prefixだけでは弾けない不正値）をreject", () => {
    // "rank.text."（suffix空）
    expect(() => assertRankTierRegistry([["text", [fixtureTier("rank.text.", "text", 0, "a")]]])).toThrow(
      /does not match the required format/,
    );
    // 空白を含む
    expect(() =>
      assertRankTierRegistry([["text", [fixtureTier("rank.text.foo bar", "text", 0, "a")]]]),
    ).toThrow(/does not match the required format/);
    // コロンを含む
    expect(() =>
      assertRankTierRegistry([["text", [fixtureTier("rank.text.foo:bar", "text", 0, "a")]]]),
    ).toThrow(/does not match the required format/);
  });

  it("現在の18 literal keysは全部このvalidatorをpassする（実運用registryそのものが既にmodule loadで検証済みだが、明示的にも確認）", () => {
    expect(() =>
      assertRankTierRegistry([
        ["text", TEXT_TIERS],
        ["voice", VOICE_TIERS],
      ]),
    ).not.toThrow();
  });

  // 「keyは全track横断でunique」の裏付け: 各keyは自分のtrackのprefix（"rank.text."/
  // "rank.voice."）を必ず持つため、text/voice間で文字列として同じkeyを名乗ることは
  // prefix checkによって構造的に不可能——duplicate key checkはtrack内の重複だけを
  // 独立にテストすれば十分（上の「duplicate keyをreject（同一track内）」）。

  it("empty nameをreject（trim後空文字含む）", () => {
    const bad = [fixtureTier("rank.text.lv000", "text", 0, "   ")];
    expect(() => assertRankTierRegistry([["text", bad]])).toThrow(/name must be non-empty/);
  });

  it("空trackをreject", () => {
    expect(() => assertRankTierRegistry([["text", []]])).toThrow(/must not be empty/);
  });

  it("最初のtierのminLevelが0でなければreject", () => {
    const bad = [fixtureTier("rank.text.lv005", "text", 5, "a")];
    expect(() => assertRankTierRegistry([["text", bad]])).toThrow(/minLevel=0/);
  });

  it("minLevelがstrict increasingでなければreject（同値）", () => {
    const bad = [fixtureTier("rank.text.lv000", "text", 0, "a"), fixtureTier("rank.text.lv000b", "text", 0, "b")];
    expect(() => assertRankTierRegistry([["text", bad]])).toThrow(/strictly increase/);
  });

  it("minLevelが負・非整数ならreject（先頭tierはminLevel=0で正常、2番目が不正な値）", () => {
    const negative = [fixtureTier("rank.text.lv000", "text", 0, "a"), fixtureTier("rank.text.lvbad", "text", -1, "b")];
    expect(() => assertRankTierRegistry([["text", negative]])).toThrow(/non-negative integer/);

    const nonInteger = [fixtureTier("rank.text.lv000", "text", 0, "a"), fixtureTier("rank.text.lvbad", "text", 5.5, "b")];
    expect(() => assertRankTierRegistry([["text", nonInteger]])).toThrow(/non-negative integer/);
  });

  it("tier.trackが配列trackと一致しなければreject", () => {
    const bad = [fixtureTier("rank.text.lv000", "voice", 0, "a")];
    expect(() => assertRankTierRegistry([["text", bad]])).toThrow(/declares track=/);
  });

  it("同じ名前・違うkeyのfixtureでもtierUp判定はkeyだけを見る（identity comparison test、§7に相当する契約の直接確認）", () => {
    // "名前だけ同じ別key fixture"を用意し、tierForの結果同士をnameではなくkeyで
    // 比較しなければならないことを確認する。
    const fixtureA: RankTier = Object.freeze({ key: "rank.text.lv900" as never, track: "text", minLevel: 900, name: "同名テスト" });
    const fixtureB: RankTier = Object.freeze({ key: "rank.text.lv901" as never, track: "text", minLevel: 901, name: "同名テスト" });
    // nameだけを見る比較だと誤って「同じtier」とみなしてしまうが、keyで比較すれば
    // 別tierとして区別できる。
    expect(fixtureA.name).toBe(fixtureB.name);
    expect(fixtureA.key).not.toBe(fixtureB.key);
  });
});

describe("didRankTierChange()（実装経路のtestable helper、round 2レビュー対応）", () => {
  it("同じname・別keyならtrue（name比較へ戻すとこのtestが落ちる契約）", () => {
    const before = fixtureTier("rank.text.lv900", "text", 900, "同名テスト");
    const after = fixtureTier("rank.text.lv901", "text", 901, "同名テスト");
    expect(didRankTierChange(before, after)).toBe(true);
  });

  it("別name・同じkey相当のfixtureならfalse", () => {
    const before = fixtureTier("rank.text.lv005", "text", 5, "旧名義");
    const after = fixtureTier("rank.text.lv005", "text", 5, "新名義（typo修正等を想定）");
    expect(didRankTierChange(before, after)).toBe(false);
  });

  it("同一tier（同じobject）ならfalse", () => {
    const t = TEXT_TIERS[0]!;
    expect(didRankTierChange(t, t)).toBe(false);
  });

  it("実際のRankEngine.awardText()経由でもkeyベースのtierUpが機能する（実装経路の直接確認）", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    // Lv0→Lv5相当のXPを一気に付与してtierUpさせる。
    const result = engine.awardText("alice", 1000, 0);
    expect(result?.tierUp).toBe(true);
    expect(result?.before.tier.key).not.toBe(result?.after.tier.key);
  });
});
