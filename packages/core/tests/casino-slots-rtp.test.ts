import { describe, expect, it } from "vitest";
import {
  computeRtp,
  simulateRtp,
  DOUBLE_PAYOUTS,
  TRIPLE_PAYOUTS,
  JP_CONTRIBUTION,
  evaluate,
  SLOT_SYMBOLS,
} from "../src/casino/slots-model.js";
import { deterministicRng } from "../src/casino/rng.js";

/**
 * スロットの RTP 回帰テスト。
 *
 * ## 前提
 * - v3 で「表示倍率＝実払戻」に統一。HOUSE_EDGE は撤廃。
 * - 期待帯（94〜97%）から外れたら CI で気付く。
 */

describe("スロット: 表示倍率と実払戻の一致", () => {
  it("triple マモン（表示100倍）は実払戻もちょうど bet × 100", () => {
    const mammon = SLOT_SYMBOLS.find((s) => s.name === "マモン")!;
    const out = evaluate([mammon, mammon, mammon] as const, 1_000);
    expect(out.kind).toBe("jackpot");
    expect(out.payout).toBe(100_000); // JP本体は別途 seizeJackpot()。ここは通常配当のみ
  });

  it("triple 王冠（表示25倍）は実払戻 bet × 25", () => {
    const crown = SLOT_SYMBOLS.find((s) => s.name === "王冠")!;
    const out = evaluate([crown, crown, crown] as const, 1_000);
    expect(out.kind).toBe("triple");
    expect(out.payout).toBe(25_000);
  });

  it("double 亡霊（表示1倍）は実払戻 bet × 1（floor 適用）", () => {
    const yurei = SLOT_SYMBOLS.find((s) => s.name === "亡霊")!;
    const bat = SLOT_SYMBOLS.find((s) => s.name === "蝙蝠")!;
    const out = evaluate([yurei, yurei, bat] as const, 1_000);
    expect(out.kind).toBe("double");
    expect(out.matched).toBe("亡霊");
    expect(out.payout).toBe(1_000);
  });

  it("配当表 TRIPLE_PAYOUTS / DOUBLE_PAYOUTS の全キーで、evaluate の payout が bet × 表示倍率と一致", () => {
    const bet = 100;
    for (const [name, mult] of Object.entries(TRIPLE_PAYOUTS)) {
      const sym = SLOT_SYMBOLS.find((s) => s.name === name);
      if (!sym) continue;
      const out = evaluate([sym, sym, sym] as const, bet);
      expect(out.payout).toBe(bet * mult);
    }
    // double: 2つ+違う名前の1つ
    const other = SLOT_SYMBOLS.find((s) => s.name === "王冠")!;
    for (const [name, mult] of Object.entries(DOUBLE_PAYOUTS)) {
      if (name === "王冠") continue; // 3揃いになってしまう
      const sym = SLOT_SYMBOLS.find((s) => s.name === name);
      if (!sym) continue;
      const out = evaluate([sym, sym, other] as const, bet);
      expect(out.kind).toBe(name === other.name ? "triple" : "double");
      if (out.kind === "double") expect(out.payout).toBe(bet * mult);
    }
  });
});

describe("スロット: 理論RTP（閉形式）", () => {
  it("現在の設定の総合RTPが 94〜97% レンジ内に入る", () => {
    const r = computeRtp();
    expect(r.withJackpot).toBeGreaterThanOrEqual(0.94);
    expect(r.withJackpot).toBeLessThanOrEqual(0.97);
    expect(r.houseNetPerBet).toBeGreaterThan(0);
  });

  it("配当が来る勝ちスピン率は 40〜55% レンジ（体感の勝ち味を維持）", () => {
    const r = computeRtp();
    expect(r.winRate).toBeGreaterThan(0.4);
    expect(r.winRate).toBeLessThan(0.55);
  });

  it("JP当選率は 純マモン3つ = (3/100)^3 = 2.7e-5", () => {
    const r = computeRtp();
    expect(r.jpHitRate).toBeCloseTo(0.000027, 6);
  });

  it("フリースピン発生率は 純魂片3つ = (3/100)^3", () => {
    const r = computeRtp();
    expect(r.freeSpinTriggerRate).toBeCloseTo(0.000027, 6);
  });
});

describe("スロット: 実測RTP（決定的シミュレーション）", () => {
  it("300,000スピンで理論値との誤差が 2% 以内に収束する", () => {
    const rng = deterministicRng(20260723);
    const sim = simulateRtp(rng, 300_000);
    const theory = computeRtp();
    // JP のボラティリティが大きいので withFreeSpin 基準で比較
    expect(Math.abs(sim.rtp - theory.withFreeSpin)).toBeLessThan(0.02);
  });

  it("50,000スピン × 10シードで胴元純収支が黒字回数優位（8/10以上）", () => {
    let houseWins = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const sim = simulateRtp(deterministicRng(seed), 50_000);
      if (sim.rtp < 1.0) houseWins++;
    }
    expect(houseWins).toBeGreaterThanOrEqual(8);
  });
});

describe("スロット: JP 積立の整数丸め（bet 額別・決定的算術）", () => {
  // 実装 (apps/bot/src/casino/slots.ts) の jpCut = max(1, floor(bet * JP_CONTRIBUTION))
  const jpCutOf = (bet: number) => Math.max(1, Math.floor(bet * JP_CONTRIBUTION));

  it("bet=50 では jpCut=1 となり実効 JP 積立率が 2%（意図は 1%）", () => {
    // floor(50 * 0.01) = floor(0.5) = 0 → max(1, 0) = 1 → 1/50 = 2%
    const bet = 50;
    const jpCut = jpCutOf(bet);
    expect(jpCut).toBe(1);
    expect(jpCut / bet).toBeCloseTo(0.02, 6);
  });

  it("bet=100 以上では実効 JP 積立率が 1%（意図通り）", () => {
    for (const bet of [100, 1_000, 10_000, 100_000]) {
      const jpCut = jpCutOf(bet);
      expect(jpCut / bet).toBeCloseTo(0.01, 6);
    }
  });

  it("bet < 100 の全域で jpCut=1 のため積立率 > 1%（MIN_BET 引き上げ検討の根拠）", () => {
    for (let bet = 50; bet < 100; bet++) {
      const jpCut = jpCutOf(bet);
      expect(jpCut).toBe(1);
      expect(jpCut / bet).toBeGreaterThan(0.01);
    }
  });
});
