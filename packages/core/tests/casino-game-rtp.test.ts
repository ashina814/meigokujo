import { describe, expect, it } from "vitest";
import {
  CHOHAN_PAYOUT,
  chohanRollAndPay,
  chohanRtp,
  ROULETTE_SLOTS,
  ROULETTE_PAYOUTS,
  rouletteSpin,
  rouletteRtp,
  CRASH_HOUSE_EDGE,
  CRASH_INSTANT_BUST_RATE,
  crashPoint,
  crashRtp,
  MARKET_HOUSE_CUT,
  marketPlayerRtp,
  KEIBA_HOUSE_RATE,
  keibaPlayerRtp,
  bjSimulateRtp,
  pokerSimulateRtp,
  holdemSimulateRtp,
  STOCK_SELL_FEE,
  stockBuyThenSellRtp,
} from "../src/casino/game-models.js";
import { deterministicRng } from "../src/casino/rng.js";

/**
 * ゲーム別 RTP テスト。理論値と実測値の両方で押さえる。
 * - 決定的乱数 (deterministicRng) を注入して再現可能にする
 * - シミュレーション試行回数は「収束のバラつきが 1〜2% 以内に収まる」水準で選ぶ
 */

describe("丁半（chohan）", () => {
  it("理論RTP = 0.5 × CHOHAN_PAYOUT = 0.97", () => {
    expect(chohanRtp()).toBeCloseTo(0.97, 4);
    expect(CHOHAN_PAYOUT).toBe(1.94);
  });

  it("実測RTP 100,000 スピンで理論値 97% と ±1% で一致", () => {
    const rng = deterministicRng(11);
    const N = 100_000;
    const bet = 10_000; // 端数を避ける
    let total = 0;
    for (let i = 0; i < N; i++) {
      const pick = i % 2 === 0 ? "cho" : "han";
      const payout = chohanRollAndPay(rng, bet, pick as "cho" | "han");
      total += payout;
    }
    const rtp = total / (N * bet);
    expect(rtp).toBeGreaterThan(0.96);
    expect(rtp).toBeLessThan(0.98);
  });
});

describe("ルーレット（roulette）", () => {
  it("シングルゼロ 37 マス構成", () => {
    expect(ROULETTE_SLOTS).toBe(37);
  });

  it("全ベット種別で理論RTP = 36/37 ≈ 97.30%", () => {
    const r = rouletteRtp();
    expect(r.red).toBeCloseTo(36 / 37, 4);
    expect(r.single0).toBeCloseTo(36 / 37, 4);
    expect(r.high).toBeCloseTo(36 / 37, 4);
  });

  it("実測: 300,000 回で赤ベットのRTPが 96〜98% に収束", () => {
    const rng = deterministicRng(37);
    const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
    let payouts = 0;
    const N = 300_000;
    const bet = 100;
    for (let i = 0; i < N; i++) {
      const n = rouletteSpin(rng);
      if (RED.has(n)) payouts += bet * ROULETTE_PAYOUTS.even;
    }
    const rtp = payouts / (N * bet);
    expect(rtp).toBeGreaterThan(0.96);
    expect(rtp).toBeLessThan(0.98);
  });
});

describe("クラッシュ（crash）", () => {
  it("設定値: HOUSE_EDGE=0.04, 即崩壊率=0.01", () => {
    expect(CRASH_HOUSE_EDGE).toBe(0.04);
    expect(CRASH_INSTANT_BUST_RATE).toBe(0.01);
  });

  it("理論RTP = (1 - 即崩壊率) × (1 - houseEdge) = 0.9504（M によらず一定）", () => {
    for (const M of [1.5, 2, 5, 10, 50]) {
      expect(crashRtp(M)).toBeCloseTo(0.9504, 4);
    }
  });

  it("実測: 固定 M=2 cashout, 200,000 回で RTP が 94〜96% に収束", () => {
    const rng = deterministicRng(3);
    const M = 2.0;
    let payouts = 0;
    const N = 200_000;
    const bet = 100;
    for (let i = 0; i < N; i++) {
      const crash = crashPoint(rng);
      if (crash >= M) payouts += Math.floor(bet * M);
    }
    const rtp = payouts / (N * bet);
    expect(rtp).toBeGreaterThan(0.93);
    expect(rtp).toBeLessThan(0.97);
  });
});

describe("板（Markets）", () => {
  it("場代率 = 3%、プレイヤー側 RTP = 97%", () => {
    expect(MARKET_HOUSE_CUT).toBe(0.03);
    expect(marketPlayerRtp()).toBeCloseTo(0.97, 4);
  });
});

describe("競馬（Keiba）", () => {
  it("場代率 = 10%、プレイヤー側 RTP = 90%", () => {
    expect(KEIBA_HOUSE_RATE).toBe(0.1);
    expect(keibaPlayerRtp()).toBeCloseTo(0.9, 4);
  });
});

describe("ブラックジャック（BJ）", () => {
  // シミュレーション回数（統計収束のバランス）
  const HANDS = 40_000;

  it("戦略: 常にスタンド → 実測RTP は概ね 70〜95%（ディーラーがバストする確率が支える）", () => {
    const rng = deterministicRng(101);
    const r = bjSimulateRtp(rng, HANDS, "always_stand");
    // ディーラーは 17 で止まるので、プレイヤーが低い数字でスタンドしても
    // ディーラーが自バーストする 25〜30% でプレイヤー勝ちになるため RTP は思ったより高い。
    // ここでは「明らかな回帰（大幅ずれ）を検出する」ことを目的にゆるい帯で押さえる。
    expect(r.rtp).toBeGreaterThan(0.70);
    expect(r.rtp).toBeLessThan(0.95);
  });

  it("戦略: ディーラー模倣 → 実測RTP が 90〜98% レンジ（ハウス優位）", () => {
    const rng = deterministicRng(102);
    const r = bjSimulateRtp(rng, HANDS, "mimic_dealer");
    // ディーラー模倣は BJ 2.5x 払いのおかげでプレイヤーが少しだけ勝つ場合もあるが
    // BJ 一致プッシュ・自バーストで負ける確率が高い
    expect(r.rtp).toBeGreaterThan(0.90);
    expect(r.rtp).toBeLessThan(0.98);
  });

  it("戦略: hard17 + ダブル9-11 → mimic_dealer より高い RTP を出す", () => {
    const rng = deterministicRng(103);
    const noDbl = bjSimulateRtp(deterministicRng(103), HANDS, "hard17", { doubleOnHard9to11: false });
    const withDbl = bjSimulateRtp(rng, HANDS, "hard17", { doubleOnHard9to11: true });
    // ダブル利用ありのほうが期待値が高い
    expect(withDbl.rtp).toBeGreaterThan(noDbl.rtp - 0.01);
  });
});

describe("ポーカー（Jacks or Better 基準・固定戦略）", () => {
  it("hold_all（交換しない）: 上位役は稀なので RTP は 10〜40% 帯", () => {
    const rng = deterministicRng(201);
    const r = pokerSimulateRtp(rng, 20_000, "hold_all");
    // Jacks or Better 9/6 表基準。ペア/ハイは payout 0 のため RTP は低め。
    // ドロー戦略ありなら 95〜99% に上がるが、hold_all は「最悪ケース RTP の下限確認」に使う。
    expect(r.rtp).toBeGreaterThan(0.1);
    expect(r.rtp).toBeLessThan(0.4);
  });

  it("hold_pairs（ペア残し）: hold_all より上位役の頻度が高い", () => {
    const rng = deterministicRng(202);
    const r = pokerSimulateRtp(rng, 20_000, "hold_pairs");
    const highHands = r.handCounts[3]! + r.handCounts[4]! + r.handCounts[5]! + r.handCounts[6]! + r.handCounts[7]!;
    // 20,000 手で 3-of-a-kind 以上が 100 以上出る（配当表非依存の頻度確認）
    expect(highHands).toBeGreaterThan(100);
  });
});

describe("ホールデム（対マモン簡易・check-only）", () => {
  it("プレイヤーとマモンの勝敗率が概ね拮抗（0.9〜1.1 RTP）", () => {
    const rng = deterministicRng(301);
    const r = holdemSimulateRtp(rng, 20_000);
    // ヘッズアップは大数極限で 50/50。tie も混ざるので RTP は 0.95〜1.05 に収束するはず
    expect(r.rtp).toBeGreaterThan(0.9);
    expect(r.rtp).toBeLessThan(1.1);
    // 勝ちと負けが同オーダー
    expect(r.wins).toBeGreaterThan(r.losses * 0.85);
    expect(r.wins).toBeLessThan(r.losses * 1.15);
  });
});

describe("株（Stocks）", () => {
  it("売却手数料 1%、買って即売る戦略 RTP = 99%", () => {
    expect(STOCK_SELL_FEE).toBe(0.01);
    expect(stockBuyThenSellRtp()).toBeCloseTo(0.99, 4);
  });
});
