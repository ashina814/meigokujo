import { describe, expect, it } from "vitest";
import { LAND_SCALE, houseCapacityReport } from "../src/casino/capacity-report.js";
import { exchangePanelMessage } from "../src/commands/exchange-panel.js";

describe("PR13 Land表示と運転資金表", () => {
  it("正本の最小・最大賭け額と福分けスケールを固定し、2/5/10人の予約額を出す（正規の日本語ゲーム名で実モデルを使う）", () => {
    expect(LAND_SCALE).toEqual({ minBet: 5, maxBet: 100_000, etherFukuScale: 10 });
    const report = houseCapacityReport(50_000, ["スロット", "チンチロ", "ホールデム"]);
    expect(report.games).toHaveLength(3);
    for (const row of report.games) {
      expect(Number.isSafeInteger(row.maximumReservation)).toBe(true);
      expect(row.maximumReservation).toBeGreaterThan(0);
      expect(row.users[2]).toBe(row.maximumReservation * 2);
      expect(row.users[5]).toBe(row.maximumReservation * 5);
      expect(row.users[10]).toBe(row.maximumReservation * 10);
    }
    const worstTen = Math.max(...report.games.map((r) => r.users[10]));
    expect(report.recommendedOpeningHouse).toBe(50_000 + worstTen);
  });

  it("最低運転資金がnullなら推奨house残高もnullにする（推測で0として計算しない）", () => {
    const report = houseCapacityReport(null, ["スロット"]);
    expect(report.minimumWorkingCapital).toBeNull();
    expect(report.recommendedOpeningHouse).toBeNull();
    // 各ゲーム定数だけから出せる値（1件最大予約・人数別必要額）は表示してよい
    expect(report.games[0]!.maximumReservation).toBeGreaterThan(0);
  });

  it("未知ゲーム名（未登録・タイポ）はfallbackせず例外を投げる（運転資金の安全計算を推測で埋めない）", () => {
    expect(() => houseCapacityReport(50_000, ["unknown"])).toThrow();
    expect(() => houseCapacityReport(50_000, ["slots"])).toThrow(); // 旧英語キーのtypoも拒否
    expect(() => houseCapacityReport(50_000, ["スロツト"])).toThrow(); // 表記ゆれのtypoも拒否
    // 正規キーに未知キーが混ざっている場合も、fallbackで通さず例外にする
    expect(() => houseCapacityReport(50_000, ["スロット", "unknown"])).toThrow();
  });

  it("does not render legacy exchange controls or legacy user-facing terminology", () => {
    const panel = exchangePanelMessage({} as never);
    expect(panel.components).toEqual([]);
    expect(JSON.stringify(panel.embeds[0]!.toJSON())).not.toContain("エテル");
    expect(JSON.stringify(panel.embeds[0]!.toJSON())).not.toContain("ether:");
  });
});
