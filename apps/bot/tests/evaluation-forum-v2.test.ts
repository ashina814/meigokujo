import { describe, expect, it } from "vitest";
import {
  evaluationCommand,
  evaluationForumThresholdsForTesting,
  evaluationReferenceText,
  threadTitleFor,
} from "../src/evaluation-forum-view.js";

describe("evaluation forum v2 UI", () => {
  it("/評価から旧4項目・対象user optionを外している", () => {
    const json = evaluationCommand.toJSON();
    expect(json.options ?? []).toEqual([]);
    expect(JSON.stringify(json)).not.toContain("点");
    expect(JSON.stringify(json)).not.toContain("印");
  });

  it("フォーラムタイトルへ期限を焼かない", () => {
    expect(threadTitleFor("テスト亡霊", 1_800_000_000)).toBe("テスト亡霊｜亡霊評価");
    expect(threadTitleFor("テスト亡霊", null)).toBe("テスト亡霊｜亡霊評価");
    expect(threadTitleFor("テスト亡霊", 1_800_000_000)).not.toContain("期限");
  });

  it("参考文は断定せず3分類に留める", () => {
    const { denLowSeconds, swordsmanLowSeconds } = evaluationForumThresholdsForTesting;
    const lowDen = evaluationReferenceText({
      denDays: 1,
      denSeconds: denLowSeconds - 1,
      swordsmanDays: 0,
      swordsmanSeconds: 0,
    });
    const lowOverlap = evaluationReferenceText({
      denDays: 2,
      denSeconds: denLowSeconds,
      swordsmanDays: 0,
      swordsmanSeconds: swordsmanLowSeconds - 1,
    });
    const enoughOverlap = evaluationReferenceText({
      denDays: 2,
      denSeconds: denLowSeconds,
      swordsmanDays: 1,
      swordsmanSeconds: swordsmanLowSeconds,
    });

    expect(lowDen).toContain("可能性があります");
    expect(lowOverlap).toContain("可能性があります");
    expect(enoughOverlap).toContain("確認してみてください");
    for (const text of [lowDen, lowOverlap, enoughOverlap]) {
      expect(text).not.toContain("昇格不可");
      expect(text).not.toContain("評価可能です");
      expect(text).not.toContain("材料不足です");
    }
  });
});
