import { describe, expect, it } from "vitest";
import { LAND_SCALE, houseCapacityReport } from "../src/casino/capacity-report.js";
import { exchangePanelMessage } from "../src/commands/exchange-panel.js";

describe("PR13 Land表示と運転資金表", () => {
  it("VIP上限・最大連鎖・armed_win上限を含む最悪条件で2/5/10人の予約額を出す", () => {
    expect(LAND_SCALE).toEqual({ minBet: 5, maxBet: 100_000, etherFukuScale: 10 });
    const report = houseCapacityReport(
      50_000,
      ["スロット", "チンチロ", "ホールデム", "ポーカー"],
      2,
    );

    expect(report.assumptions).toEqual({
      maximumBet: 200_000,
      vipBetCapMult: 2,
      maximumWinStreak: 19,
      maximumChainMultiplier: 2,
      maximumWinBonusCap: 3_000,
    });

    for (const row of report.games) {
      expect(Number.isSafeInteger(row.maximumReservation)).toBe(true);
      expect(row.maximumReservation).toBeGreaterThan(0);
      expect(row.users[2]).toBe(row.maximumReservation * 2);
      expect(row.users[5]).toBe(row.maximumReservation * 5);
      expect(row.users[10]).toBe(row.maximumReservation * 10);
      expect(Number.isSafeInteger(row.users[10])).toBe(true);
    }

    const poker = report.games.find((row) => row.game === "ポーカー")!;
    // 251倍払戻・VIP上限200,000・最大連鎖2倍・勝利お守り上限3,000・賭け金回収を反映。
    expect(poker.maximumReservation).toBe(100_206_000);
    expect(poker.maximumReservation).toBeGreaterThan(25_000_000); // 旧「通常上限・連鎖なし」の過小値
    expect(poker.users[10]).toBe(1_002_060_000);

    const worstTen = Math.max(...report.games.map((row) => row.users[10]));
    expect(report.recommendedOpeningHouse).toBe(50_000 + worstTen);
  });

  it("現在のVIP倍率が上がれば最大賭け額と最大予約額も追従する", () => {
    const x2 = houseCapacityReport(0, ["ポーカー"], 2);
    const x3 = houseCapacityReport(0, ["ポーカー"], 3);
    expect(x2.assumptions.maximumBet).toBe(200_000);
    expect(x3.assumptions.maximumBet).toBe(300_000);
    expect(x3.games[0]!.maximumReservation).toBeGreaterThan(x2.games[0]!.maximumReservation);
  });

  it("最低運転資金がnullなら推奨house残高もnullにする（推測で0として計算しない）", () => {
    const report = houseCapacityReport(null, ["スロット"], 2);
    expect(report.minimumWorkingCapital).toBeNull();
    expect(report.recommendedOpeningHouse).toBeNull();
    // ゲーム定数と最大条件だけから出せる値は引き続き算出する。
    expect(report.games[0]!.maximumReservation).toBeGreaterThan(0);
  });

  it("未知ゲーム名（未登録・タイポ）はfallbackせず例外を投げる", () => {
    expect(() => houseCapacityReport(50_000, ["unknown"], 2)).toThrow();
    expect(() => houseCapacityReport(50_000, ["slots"], 2)).toThrow();
    expect(() => houseCapacityReport(50_000, ["スロツト"], 2)).toThrow();
    expect(() => houseCapacityReport(50_000, ["スロット", "unknown"], 2)).toThrow();
  });

  it("不正VIP倍率・空ゲーム・safe integer超過はfail-closed", () => {
    expect(() => houseCapacityReport(50_000, ["ポーカー"], 0)).toThrow();
    expect(() => houseCapacityReport(50_000, ["ポーカー"], Number.NaN)).toThrow();
    expect(() => houseCapacityReport(50_000, [], 2)).toThrow();
    expect(() => houseCapacityReport(Number.MAX_SAFE_INTEGER, ["ポーカー"], 2)).toThrow();
    expect(() => houseCapacityReport(50_000, ["ポーカー"], Number.MAX_VALUE)).toThrow();
  });

  it("does not render legacy exchange controls or legacy user-facing terminology", () => {
    const panel = exchangePanelMessage({} as never);
    expect(panel.components).toEqual([]);
    expect(JSON.stringify(panel.embeds[0]!.toJSON())).not.toContain("エテル");
    expect(JSON.stringify(panel.embeds[0]!.toJSON())).not.toContain("ether:");
  });
});
