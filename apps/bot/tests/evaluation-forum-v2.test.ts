import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  currentGuildEvaluationTargets,
  evaluationCommand,
  evaluationForumThresholdsForTesting,
  evaluationPanelRow,
  evaluationReferenceText,
  threadTitleFor,
} from "../src/evaluation-forum-view.js";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");

describe("evaluation forum v2 UI", () => {
  it("/評価から旧4項目・対象user optionを外している", () => {
    const json = evaluationCommand.toJSON();
    expect(json.options ?? []).toEqual([]);
    expect(JSON.stringify(json)).not.toContain("点");
    expect(JSON.stringify(json)).not.toContain("印");
  });

  it("常設入口は1択selectではなく何度でも押せるbutton", () => {
    const row = evaluationPanelRow().toJSON();
    expect(row.components).toHaveLength(1);
    expect(row.components[0]).toMatchObject({
      type: 2,
      custom_id: "eval:open",
      label: "評価する亡霊を選択",
    });
    expect(indexSource).toContain("handleEvaluationButton");
    expect(indexSource).toContain('interaction.customId.startsWith("eval:")');
  });

  it("DB上で評価中でもGuild不在なら一覧に出さず、IDを表示名へフォールバックしない", () => {
    const cycles = [
      { userId: "in-guild", startedAt: 100, deadlineAt: 200, inviteBaseline: 0, origin: "entry" as const },
      { userId: "left-guild", startedAt: 100, deadlineAt: 300, inviteBaseline: 0, origin: "entry" as const },
    ];
    const members = new Map([["in-guild", { displayName: "山田" }]]);
    expect(currentGuildEvaluationTargets(cycles, members)).toEqual([
      { userId: "in-guild", displayName: "山田", deadlineAt: 200 },
    ]);
    expect(JSON.stringify(currentGuildEvaluationTargets(cycles, members))).not.toContain("left-guild");
  });

  it("1人選択後はその人を除いた一覧を続けて表示できる", () => {
    const cycles = [
      { userId: "a", startedAt: 100, deadlineAt: 200, inviteBaseline: 0, origin: "entry" as const },
      { userId: "b", startedAt: 100, deadlineAt: 300, inviteBaseline: 0, origin: "entry" as const },
      { userId: "c", startedAt: 100, deadlineAt: 400, inviteBaseline: 0, origin: "entry" as const },
    ];
    const members = new Map([
      ["a", { displayName: "山田" }],
      ["b", { displayName: "佐藤" }],
      ["c", { displayName: "田中" }],
    ]);
    expect(currentGuildEvaluationTargets(cycles, members, "a").map((target) => target.displayName)).toEqual(["佐藤", "田中"]);
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
