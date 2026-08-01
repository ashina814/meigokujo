import { describe, expect, it } from "vitest";
import {
  BLACKJACK_MAX_PAYOUT_MULT,
  CHOHAN_PAYOUT,
  CRASH_MAX_MULT_CAP,
  HOLDEM_MAX_PAYOUT_MULT,
  HOLDEM_MAX_TOTAL_BET_MULT,
  LIABILITY_MODELS,
  POKER_CATEGORY_PAYOUTS,
  SLOT_MAX_PAYOUT_MULT,
  TRIPLE_PAYOUTS,
  blackjackLiability,
  blackjackNoDoubleLiability,
  chainMultiplier,
  chinchiroLiability,
  chinchiroMaxPayout,
  chohanLiability,
  crashLiability,
  holdemLiability,
  liabilityModelFor,
  pokerLiability,
  rouletteIncrementalLiability,
  rouletteTableLiability,
  slotsLiability,
  type LiabilityContext,
} from "../src/index.js";

/**
 * PR4（ゲーム別債務・損失モデル）。
 *
 * 見るのは3つ:
 * - 倍率が core のモデルから来ていること（bot 側から写していない）
 * - JP と福の重みが債務に**入っていない**こと
 * - `maxBetFor` が「その額なら必ず受けられる」逆関数になっていること
 */

const ctx = (bet: number, winStreak = 0, winBonusCap = 0): LiabilityContext => ({
  bet,
  playerState: { winStreak },
  activeEffects: { winBonusCap },
});

describe("倍率は core のモデルから来ている", () => {
  it("スロットの最大払戻はマモン³の配当表の値", () => {
    expect(SLOT_MAX_PAYOUT_MULT).toBe(TRIPLE_PAYOUTS["マモン"]);
    // 連鎖なし・お守りなしなら 100·bet − bet
    expect(slotsLiability.maxHouseLiability(ctx(1_000))).toBe(1_000 * SLOT_MAX_PAYOUT_MULT - 1_000);
  });

  it("丁半は表示の2倍ではなく実払戻 CHOHAN_PAYOUT で見る", () => {
    expect(chohanLiability.maxHouseLiability(ctx(10_000))).toBe(Math.floor(10_000 * CHOHAN_PAYOUT) - 10_000);
    // 1.94 倍なので 2 倍で見積もるより小さい（実払戻に合わせている証拠）
    expect(chohanLiability.maxHouseLiability(ctx(10_000))).toBeLessThan(10_000);
  });

  it("クラッシュは払戻クランプと同じ上限で見る", () => {
    expect(crashLiability.maxHouseLiability(ctx(500))).toBe(500 * CRASH_MAX_MULT_CAP - 500);
  });

  it("ポーカーはロイヤルの配当表の値", () => {
    expect(pokerLiability.maxHouseLiability(ctx(100))).toBe(100 * POKER_CATEGORY_PAYOUTS[11]! - 100);
  });

  it("チンチロはモデルの最大払戻（ピンゾロ勝ち）から出る", () => {
    const bet = 10_000;
    expect(chinchiroLiability.maxHouseLiability(ctx(bet))).toBe(chinchiroMaxPayout(bet) - bet);
  });
});

describe("連鎖ボーナスとお守りの扱い", () => {
  it("連鎖が有効なゲームは連勝ぶんだけ債務が増える", () => {
    const streak = 4;
    const c = chainMultiplier(streak + 1).mult;
    expect(c).toBeGreaterThan(1);
    const base = slotsLiability.maxHouseLiability(ctx(1_000));
    const chained = slotsLiability.maxHouseLiability(ctx(1_000, streak));
    expect(chained).toBe(Math.ceil(1_000 * SLOT_MAX_PAYOUT_MULT * c) - 1_000);
    expect(chained).toBeGreaterThan(base);
  });

  it("実装で連鎖を切っているゲームは連勝しても増えない", () => {
    for (const model of [chohanLiability, crashLiability]) {
      expect(model.maxHouseLiability(ctx(1_000, 9))).toBe(model.maxHouseLiability(ctx(1_000, 0)));
    }
  });

  it("お守りの勝利ボーナス上限は債務に含まれ、連鎖も掛かる（安全側）", () => {
    const cap = 3_000;
    const c = chainMultiplier(3).mult;
    expect(slotsLiability.maxHouseLiability(ctx(1_000, 2, cap))).toBe(
      Math.ceil((1_000 * SLOT_MAX_PAYOUT_MULT + cap) * c) - 1_000,
    );
  });

  it("JP と福の重みは債務に入っていない", () => {
    // JP は jackpot holder から出るので house の債務ではない。
    // スロットの債務は「配当表の最大倍率 − 賭け」ちょうどで、JP プールの大小に依存しない
    const bet = 1_000;
    expect(slotsLiability.maxHouseLiability(ctx(bet))).toBe(bet * SLOT_MAX_PAYOUT_MULT - bet);
    // 福の重みはプレイヤー → JP/救済 の一方向なので、債務を増やす向きには効かない
    // （モデルに福の項が無いことを、式が賭けと倍率だけで決まることで確認する）
    expect(slotsLiability.maxHouseLiability(ctx(bet * 2))).toBe(2 * (bet * SLOT_MAX_PAYOUT_MULT) - bet * 2);
  });
});

describe("maxPlayerLoss", () => {
  it("チンチロだけ賭け額を超える（2×bet）", () => {
    expect(chinchiroLiability.maxPlayerLoss(ctx(500))).toBe(1_000);
  });

  it("ブラックジャックはダブルぶんまで（2×bet）", () => {
    expect(blackjackLiability.maxPlayerLoss(ctx(500))).toBe(1_000);
    expect(blackjackNoDoubleLiability.maxPlayerLoss(ctx(500))).toBe(500);
  });

  it("ホールデムは積みうる総額（5×ante）", () => {
    expect(holdemLiability.maxPlayerLoss(ctx(500))).toBe(500 * HOLDEM_MAX_TOTAL_BET_MULT);
  });

  it("それ以外は賭け額そのもの", () => {
    for (const model of [slotsLiability, chohanLiability, crashLiability, pokerLiability]) {
      expect(model.maxPlayerLoss(ctx(777))).toBe(777);
    }
  });
});

describe("ホールデムの最大コール経路 T", () => {
  it("preflop/flop/turn/river の4局面すべてでコールできるので T = 5×ante", () => {
    expect(HOLDEM_MAX_TOTAL_BET_MULT).toBe(5);
    expect(HOLDEM_MAX_PAYOUT_MULT).toBe(10);
  });

  it("旧値 8 では最悪ケースを覆えない（回帰）", () => {
    const ante = 1_000;
    const worstPayout = ante * HOLDEM_MAX_PAYOUT_MULT;
    expect(worstPayout).toBeGreaterThan(ante * 8);
    // 債務は「ポット総取り − 積んだ総額」
    expect(holdemLiability.maxHouseLiability(ctx(ante))).toBe(
      ante * HOLDEM_MAX_PAYOUT_MULT - ante * HOLDEM_MAX_TOTAL_BET_MULT,
    );
  });
});

describe("ブラックジャックのダブル", () => {
  it("ダブル込みは 4×bet 払って 2×bet 回収", () => {
    expect(blackjackLiability.maxHouseLiability(ctx(1_000))).toBe(1_000 * BLACKJACK_MAX_PAYOUT_MULT - 2_000);
  });

  it("ダブル不可なら債務が下がる（ボタンだけ無効化できる）", () => {
    expect(blackjackNoDoubleLiability.maxHouseLiability(ctx(1_000))).toBeLessThan(
      blackjackLiability.maxHouseLiability(ctx(1_000)),
    );
  });
});

describe("ルーレットは増分の総和で予約する", () => {
  it("同じ回転で複数の当たりが同時成立しうるので最大値ではなく総和", () => {
    const bets = [
      { type: "even" as const, amount: 1_000 },
      { type: "single" as const, amount: 500 },
    ];
    expect(rouletteIncrementalLiability(bets[0]!)).toBe(1_000);
    expect(rouletteIncrementalLiability(bets[1]!)).toBe(500 * 35);
    expect(rouletteTableLiability(bets)).toBe(1_000 + 17_500);
    // 最大値だけで予約すると 1,000 ぶん足りない
    expect(rouletteTableLiability(bets)).toBeGreaterThan(Math.max(1_000, 17_500));
  });

  it("ベットが無ければ債務ゼロ", () => {
    expect(rouletteTableLiability([])).toBe(0);
  });
});

describe("maxBetFor は maxHouseLiability の逆関数", () => {
  const models = Object.entries(LIABILITY_MODELS);

  it("返した額は必ず受けられ、1 Ld 増やすと受けられない", () => {
    for (const [name, model] of models) {
      for (const available of [0, 999, 100_000, 1_234_567, 50_000_000]) {
        for (const winStreak of [0, 5]) {
          const rest = { playerState: { winStreak }, activeEffects: { winBonusCap: 0 } };
          const bet = model.maxBetFor(available, rest);
          expect(bet, `${name}/${available}`).toBeGreaterThanOrEqual(0);
          if (bet > 0) {
            expect(model.maxHouseLiability({ ...rest, bet }), `${name}/${available}`).toBeLessThanOrEqual(available);
          }
          expect(model.maxHouseLiability({ ...rest, bet: bet + 1 }), `${name}/${available}`).toBeGreaterThan(available);
        }
      }
    }
  });

  it("胴元の余力が増えれば受けられる額も増える（単調）", () => {
    for (const [name, model] of models) {
      const rest = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
      const small = model.maxBetFor(100_000, rest);
      const large = model.maxBetFor(10_000_000, rest);
      expect(large, name).toBeGreaterThan(small);
    }
  });

  it("倍率が大きいゲームほど同じ余力で受けられる額が小さい", () => {
    const rest = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
    const available = 10_000_000;
    // ポーカー(251倍) < スロット(100倍) < 丁半(1.94倍)
    expect(pokerLiability.maxBetFor(available, rest)).toBeLessThan(slotsLiability.maxBetFor(available, rest));
    expect(slotsLiability.maxBetFor(available, rest)).toBeLessThan(chohanLiability.maxBetFor(available, rest));
  });
});

describe("参照表", () => {
  it("/遊ぶ の全ソロゲームにモデルがある", () => {
    for (const game of ["スロット", "丁半", "クラッシュ", "チンチロ", "ブラックジャック", "ポーカー", "ホールデム"]) {
      expect(liabilityModelFor(game), game).toBeDefined();
      expect(liabilityModelFor(game)!.game).toBeTruthy();
    }
    expect(liabilityModelFor("知らないゲーム")).toBeUndefined();
  });

  it("ルーレットは卓単位なので1ベット用の表には入れない", () => {
    // 複数人・複数箇所を増分で予約するので、bet 1つを渡す形のモデルにしない
    expect(liabilityModelFor("ルーレット")).toBeUndefined();
  });
});
