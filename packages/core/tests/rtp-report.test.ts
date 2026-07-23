import { describe, it } from "vitest";
import { computeRtp, simulateRtp } from "../src/casino/slots-model.js";
import { deterministicRng } from "../src/casino/rng.js";

/**
 * RTP レポート（テストではなく人間向け出力）。
 * v3 移行後は HOUSE_EDGE を撤廃したため、単一の設定値のみ出力する。
 */
describe("スロット RTP レポート（参考出力）", () => {
  it("理論値", () => {
    const r = computeRtp();
    console.log(
      `\n=== 理論RTP ===\n` +
        `regular=${(r.regular * 100).toFixed(2)}%  ` +
        `+freeSpin=${(r.withFreeSpin * 100).toFixed(2)}%  ` +
        `+JP=${(r.withJackpot * 100).toFixed(2)}%  ` +
        `winRate=${(r.winRate * 100).toFixed(2)}%  ` +
        `houseNet=${(r.houseNetPerBet * 100).toFixed(2)}%  ` +
        `jpHit=${(r.jpHitRate * 1_000_000).toFixed(1)}/1M  ` +
        `freeSpin=${(r.freeSpinTriggerRate * 1_000_000).toFixed(1)}/1M`,
    );
  });

  it("実測: 300,000スピン × 5シード", () => {
    console.log("\n=== 実測RTP (300,000 spins) ===");
    for (const seed of [1, 2, 3, 4, 5]) {
      const sim = simulateRtp(deterministicRng(seed), 300_000);
      console.log(
        `seed=${seed}  rtp=${(sim.rtp * 100).toFixed(2)}%  jpHits/1M=${Math.round(sim.jpHitRate * 1_000_000)}  freeSpins/1M=${Math.round(sim.freeSpinTriggerRate * 1_000_000)}`,
      );
    }
  });
});
