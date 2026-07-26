import { describe, expect, it, vi } from "vitest";
import { handleHelpCommand } from "../src/commands/help.js";

describe("/あそびかた", () => {
  it("現行Botの主要導線を案内し、設定値をservicesから読む", async () => {
    const reply = vi.fn(async () => undefined);
    const services = { settings: { getNumber: vi.fn((key: string) => (key === "initial_grant" ? 12345 : 0)) } };

    await handleHelpCommand({ reply } as any, services as any);

    expect(services.settings.getNumber).toHaveBeenCalledWith("initial_grant");
    const payload = reply.mock.calls[0]?.[0];
    const text = JSON.stringify(payload.embeds[0].toJSON());
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
  });
});
