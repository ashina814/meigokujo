import { describe, expect, it } from "vitest";
import {
  CAPACITY_REPORT_GAMES,
  houseCapacityReport,
  runWithCapacityVipBetCapMult,
} from "../src/casino/capacity-report.js";

describe("capacity report runtime context", () => {
  it("並行する管理リクエストごとにVIP倍率を隔離する", async () => {
    let releaseX2!: () => void;
    const x2MayContinue = new Promise<void>((resolve) => {
      releaseX2 = resolve;
    });

    const x2Promise = runWithCapacityVipBetCapMult(2, async () => {
      await x2MayContinue;
      return houseCapacityReport(0, CAPACITY_REPORT_GAMES);
    });
    const x3Promise = runWithCapacityVipBetCapMult(3, async () => {
      const report = houseCapacityReport(0, CAPACITY_REPORT_GAMES);
      releaseX2();
      return report;
    });

    const [x2, x3] = await Promise.all([x2Promise, x3Promise]);
    expect(x2.assumptions.vipBetCapMult).toBe(2);
    expect(x2.assumptions.maximumBet).toBe(200_000);
    expect(x3.assumptions.vipBetCapMult).toBe(3);
    expect(x3.assumptions.maximumBet).toBe(300_000);
    expect(x3.games.find((row) => row.game === "ポーカー")!.maximumReservation).toBeGreaterThan(
      x2.games.find((row) => row.game === "ポーカー")!.maximumReservation,
    );
  });

  it("壊れた倍率は無関係な管理処理を止めず、capacity計算時だけfail-closed", () => {
    expect(runWithCapacityVipBetCapMult(0, () => "unrelated-admin-ok")).toBe("unrelated-admin-ok");
    expect(() =>
      runWithCapacityVipBetCapMult(0, () => houseCapacityReport(0, CAPACITY_REPORT_GAMES)),
    ).toThrow(/vipBetCapMult/);
  });

  it("管理画面経路のゲーム一覧が正本を欠いたらfail-closed", () => {
    const incomplete = CAPACITY_REPORT_GAMES.slice(0, -1);
    expect(() =>
      runWithCapacityVipBetCapMult(2, () => houseCapacityReport(0, incomplete)),
    ).toThrow(/game coverage mismatch/);
  });

  it("productionでリクエストスコープなしの呼び出しを既定値へ黙って倒さない", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => houseCapacityReport(0, CAPACITY_REPORT_GAMES)).toThrow(/context is not set/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("明示倍率を渡す純粋計算では対象ゲームの部分集合も検証できる", () => {
    const report = houseCapacityReport(0, ["ポーカー"], 2);
    expect(report.games.map((row) => row.game)).toEqual(["ポーカー"]);
    expect(report.assumptions.vipBetCapMult).toBe(2);
  });
});
