import { describe, expect, it, vi } from "vitest";
import { handleHelpCommand } from "../src/commands/help.js";

describe("/あそびかた", () => {
  it("現行Botの主要導線を案内し、設定値をservicesから読む", async () => {
    const reply = vi.fn(async () => undefined);
    const services = { settings: { getNumber: vi.fn((key: string) => (key === "initial_grant" ? 12345 : 0)) } };

    await handleHelpCommand({ reply } as any, services as any);

    expect(services.settings.getNumber).toHaveBeenCalledWith("initial_grant");
    const payload = reply.mock.calls[0]?.[0];
    const json = payload.embeds[0].toJSON();
    const text = JSON.stringify(json);
    for (const word of [
      "初めて",
      "プロフィール",
      "通帳",
      "送金",
      "投げ銭",
      "評価",
      "階級",
      "部屋",
      "VC",
      "ランキング",
      "案内",
      "賭場",
      "トート",
    ]) {
      expect(text).toContain(word);
    }
    expect(text).toContain("12,345Ld");
    expect(text).not.toContain("30,000");
    expect(text).toMatch(/通行証.*賭場.*Land残高.*戦績.*勝率/s);
    expect(text).not.toMatch(/通行証.*入城状態/s);
    // ランキングは活動量の案内であって、Land の多寡を競う導線ではない
    const rankingField = json.fields.find((f: { name: string }) => f.name.includes("ランキング"));
    const rankingCommandLine = rankingField.value
      .split("\n")
      .find((line: string) => line.includes("/ランキング"));
    expect(rankingCommandLine).toBeDefined();
    expect(rankingCommandLine).not.toContain("Land");
    // 利用者画面から旧通貨・旧交換導線を出さない（PR13: Land 表示への統一）
    expect(text).not.toContain("チップ");
    expect(text).not.toContain("エテル");
    expect(text).not.toContain("両替所");
  });
});
