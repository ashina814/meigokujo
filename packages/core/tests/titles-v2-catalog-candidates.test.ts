import { describe, expect, it } from "vitest";
import { TITLE_V2_CATALOG_CANDIDATES } from "../src/titles/v2-catalog-candidates.js";

/**
 * PR F1: xlsx `Catalog_99_FINAL`（正本）を機械転記した
 * `TITLE_V2_CATALOG_CANDIDATES` が、Summary/Collection_Review/FullClear_Manifestの
 * 固定事実（§4）と実際に一致することを検証する。xlsxの値そのものを
 * 書き換えていないことのregression guard——将来誰かがcandidateデータを
 * 手で編集して数字がズレたら、ここが最初に落ちる。
 */

describe("A. 99 candidates exact", () => {
  it("TITLE_V2_CATALOG_CANDIDATESはちょうど99件", () => {
    expect(TITLE_V2_CATALOG_CANDIDATES).toHaveLength(99);
  });
});

describe("B. 91 behavior / 8 meta", () => {
  it("kind:behaviorが91件、kind:metaが8件", () => {
    const behavior = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.kind === "behavior");
    const meta = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.kind === "meta");
    expect(behavior).toHaveLength(91);
    expect(meta).toHaveLength(8);
  });
});

describe("C. 43 COUNTABLE / 56 NONCOUNT", () => {
  it("Collection CreditがCOUNTABLE 43件・NONCOUNT 56件", () => {
    const countable = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.collectionCredit === "COUNTABLE");
    const noncount = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.collectionCredit === "NONCOUNT");
    expect(countable).toHaveLength(43);
    expect(noncount).toHaveLength(56);
  });
});

describe("D. 91 REQUIRED / 8 EXEMPT_META", () => {
  it("Full ClearがREQUIRED 91件・EXEMPT_META 8件", () => {
    const required = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.fullClear === "REQUIRED");
    const exempt = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.fullClear === "EXEMPT_META");
    expect(required).toHaveLength(91);
    expect(exempt).toHaveLength(8);
  });
});

describe("E. No 1..99 連番・重複なし・欠番なし", () => {
  it("noの集合は1から99までの連番と完全一致する", () => {
    const nos = TITLE_V2_CATALOG_CANDIDATES.map((c) => c.no).sort((a, b) => a - b);
    const expected = Array.from({ length: 99 }, (_, i) => i + 1);
    expect(nos).toEqual(expected);
  });

  it("noに重複が無い", () => {
    const nos = TITLE_V2_CATALOG_CANDIDATES.map((c) => c.no);
    expect(new Set(nos).size).toBe(nos.length);
  });
});

describe("F. provisionalKey unique", () => {
  it("99件すべてnon-emptyかつ重複なし", () => {
    const keys = TITLE_V2_CATALOG_CANDIDATES.map((c) => c.provisionalKey);
    expect(keys.every((k) => k.trim().length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("displayName non-empty", () => {
  it("99件すべてnon-empty", () => {
    expect(TITLE_V2_CATALOG_CANDIDATES.every((c) => c.displayName.trim().length > 0)).toBe(true);
  });
});

describe("G. series stage 重複なし・1始まり・欠番なし", () => {
  it("同じseriesKey内でstageが1..Nの連番と一致する（seriesKey===nullの候補は対象外）", () => {
    const bySeriesKey = new Map<string, number[]>();
    for (const c of TITLE_V2_CATALOG_CANDIDATES) {
      if (c.seriesKey === null) continue;
      expect(c.stage, `candidate #${c.no} has seriesKey but stage is null`).not.toBeNull();
      const list = bySeriesKey.get(c.seriesKey) ?? [];
      list.push(c.stage as number);
      bySeriesKey.set(c.seriesKey, list);
    }
    expect(bySeriesKey.size).toBeGreaterThan(0);
    for (const [seriesKey, stages] of bySeriesKey) {
      const sorted = [...stages].sort((a, b) => a - b);
      const expected = Array.from({ length: sorted.length }, (_, i) => i + 1);
      expect(sorted, `series "${seriesKey}" stages: ${JSON.stringify(sorted)}`).toEqual(expected);
    }
  });

  it("同じcandidateが複数seriesへ入らない（no単位でseriesKeyは高々1つ）", () => {
    // TitleV2CatalogCandidate.seriesKeyはscalarフィールドなので型レベルで
    // 複数所属は不可能——構造上のregression guardとして、
    // 同じ(seriesKey, stage)ペアが複数candidateに重複していないことも確認する。
    const seen = new Set<string>();
    for (const c of TITLE_V2_CATALOG_CANDIDATES) {
      if (c.seriesKey === null) continue;
      const pairKey = `${c.seriesKey}#${c.stage}`;
      expect(seen.has(pairKey), `duplicate (seriesKey, stage) pair: ${pairKey}`).toBe(false);
      seen.add(pairKey);
    }
  });
});

describe("H. behavior/meta invariant", () => {
  it("behaviorは全件fullClear:REQUIRED", () => {
    const behavior = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.kind === "behavior");
    expect(behavior.every((c) => c.fullClear === "REQUIRED")).toBe(true);
  });

  it("metaは全件fullClear:EXEMPT_META", () => {
    const meta = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.kind === "meta");
    expect(meta.every((c) => c.fullClear === "EXEMPT_META")).toBe(true);
  });
});

describe("I. metaはCOUNTABLE 0", () => {
  it("kind:metaでcollectionCredit:COUNTABLEの候補は0件", () => {
    const metaCountable = TITLE_V2_CATALOG_CANDIDATES.filter(
      (c) => c.kind === "meta" && c.collectionCredit === "COUNTABLE",
    );
    expect(metaCountable).toHaveLength(0);
  });
});

describe("J. metaはfullClear REQUIRED 0", () => {
  it("kind:metaでfullClear:REQUIREDの候補は0件", () => {
    const metaRequired = TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.kind === "meta" && c.fullClear === "REQUIRED");
    expect(metaRequired).toHaveLength(0);
  });
});

describe("hiddenは全件false（xlsx Hidden列はNo.1〜99すべて'No'）", () => {
  it("hidden:trueの候補は0件", () => {
    expect(TITLE_V2_CATALOG_CANDIDATES.filter((c) => c.hidden)).toHaveLength(0);
  });
});

describe("Theme No/Theme文字列の整合性", () => {
  it("同じthemeNoは同じtheme文字列を持つ（xlsx内で表記揺れが無い）", () => {
    const byThemeNo = new Map<number, Set<string>>();
    for (const c of TITLE_V2_CATALOG_CANDIDATES) {
      const set = byThemeNo.get(c.themeNo) ?? new Set<string>();
      set.add(c.theme);
      byThemeNo.set(c.themeNo, set);
    }
    for (const [themeNo, names] of byThemeNo) {
      expect(names.size, `themeNo ${themeNo} has inconsistent theme labels: ${[...names].join(", ")}`).toBe(1);
    }
  });
});
