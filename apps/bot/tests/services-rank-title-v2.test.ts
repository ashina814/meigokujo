import { describe, expect, it } from "vitest";
import { RankEngine, TextActivity, TitleEngine, TitleV2Store } from "@meigokujo/core";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
process.env.DB_PATH = ":memory:";

/**
 * PR D2 §3, §57: 旧TitleEngine（`services.titles`）を置換せず、新規`services.titleV2`
 * （TitleV2Store）を別名で追加していることのregression test。
 */
describe("buildServices() — rank-title v2 wiring regression", () => {
  it("services.titlesはlegacy TitleEngineのまま、services.titleVはTitleV2Store、services.ranksはRankEngine", async () => {
    const { buildServices } = await import("../src/services.js");
    const services = buildServices();
    try {
      expect(services.titles).toBeInstanceOf(TitleEngine);
      expect(services.titleV2).toBeInstanceOf(TitleV2Store);
      expect(services.ranks).toBeInstanceOf(RankEngine);
      // PR E1 §15: services.textActivityを既存servicesの置換なしで追加する。
      expect(services.textActivity).toBeInstanceOf(TextActivity);
    } finally {
      services.db.close();
    }
  });
});
