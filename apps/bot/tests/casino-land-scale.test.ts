import { describe, expect, it } from "vitest";
import { LAND_SCALE, houseCapacityReport } from "../src/casino/capacity-report.js";
import { exchangePanelMessage } from "../src/commands/exchange-panel.js";

describe("PR13 Land表示と運転資金表", () => {
  it("正本の最小・最大賭け額と福分けスケールを固定し、2/5/10人の予約額を出す", () => {
    expect(LAND_SCALE).toEqual({ minBet: 5, maxBet: 100_000, etherFukuScale: 10 });
    const report = houseCapacityReport(50_000, ["slots", "chinchiro", "holdem"]);
    expect(report.games).toHaveLength(3);
    for (const row of report.games) {
      expect(row.users[5]).toBe(row.maximumReservation * 5);
      expect(row.users[10]).toBe(row.maximumReservation * 10);
    }
    expect(report.recommendedOpeningHouse).toBeGreaterThanOrEqual(50_000);
  });

  it("does not render legacy exchange controls or legacy user-facing terminology", () => {
    const panel = exchangePanelMessage({} as never);
    expect(panel.components).toEqual([]);
    expect(JSON.stringify(panel.embeds[0]!.toJSON())).not.toContain("エテル");
    expect(JSON.stringify(panel.embeds[0]!.toJSON())).not.toContain("ether:");
  });
});
