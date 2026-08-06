import { afterEach, describe, expect, it } from "vitest";
import type { Interaction } from "discord.js";
import type { Services } from "../src/services.js";
import {
  bindCapacityVipBetCapMultProvider,
  houseCapacityReport,
} from "../src/casino/capacity-report.js";
import { denyIfCasinoClosed } from "../src/casino/gate.js";

afterEach(() => {
  bindCapacityVipBetCapMultProvider(() => 2);
});

describe("capacity report runtime VIP倍率provider", () => {
  it("管理導線を通ると現在のservices.vip.betCapMult()を次のcapacity計算へ反映する", async () => {
    const interaction = {
      isChatInputCommand: () => false,
      customId: "mgmt:casino",
    } as unknown as Interaction;
    const services = {
      vip: { betCapMult: () => 3 },
    } as unknown as Services;

    expect(await denyIfCasinoClosed(interaction, services)).toBe(false);

    const report = houseCapacityReport(0, ["ポーカー"]);
    expect(report.assumptions.vipBetCapMult).toBe(3);
    expect(report.assumptions.maximumBet).toBe(300_000);
    expect(report.games[0]!.maximumReservation).toBeGreaterThan(100_206_000);
  });
});
