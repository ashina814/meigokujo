import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchangeCore, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino } from "../src/casino/service.js";
import { deptAccount, Departments } from "../src/departments/service.js";
import {
  BLACKJACK_MAX_PAYOUT_MULT,
  CHOHAN_PAYOUT,
  CRASH_MAX_MULT_CAP,
  HOLDEM_MAX_PAYOUT_MULT,
  HOLDEM_MAX_TOTAL_BET_MULT,
  LIABILITY_MODELS,
  LiabilityError,
  MAX_SAFE_LIABILITY_BET,
  POKER_CATEGORY_PAYOUTS,
  SLOT_MAX_PAYOUT_MULT,
  TRIPLE_PAYOUTS,
  blackjackLiability,
  blackjackNoDoubleLiability,
  chainMultiplier,
  chinchiroLiability,
  chinchiroMaxPayout,
  chinchiroPayout,
  chohanLiability,
  crashLiability,
  holdemLiability,
  liabilityModelFor,
  pokerLiability,
  rouletteIncrementalLiability,
  rouletteTableLiability,
  slotsJackpotCutFor,
  slotsLiability,
  slotsPaidSpinLiability,
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
    // 有料スピン1回なら 100·bet − bet + JP積立
    expect(slotsPaidSpinLiability.maxHouseLiability(ctx(1_000))).toBe(
      1_000 * SLOT_MAX_PAYOUT_MULT - 1_000 + slotsJackpotCutFor(1_000),
    );
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
    const base = slotsPaidSpinLiability.maxHouseLiability(ctx(1_000));
    const chained = slotsPaidSpinLiability.maxHouseLiability(ctx(1_000, streak));
    expect(chained).toBe(Math.ceil(1_000 * SLOT_MAX_PAYOUT_MULT * c) - 1_000 + slotsJackpotCutFor(1_000));
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
    expect(slotsPaidSpinLiability.maxHouseLiability(ctx(1_000, 2, cap))).toBe(
      Math.ceil((1_000 * SLOT_MAX_PAYOUT_MULT + cap) * c) - 1_000 + slotsJackpotCutFor(1_000),
    );
  });

  it("JP当選金と福の重みは債務に入っていない（積立は入る）", () => {
    // JP **当選金**は jackpot holder から出るので house の債務ではない。
    // 一方 JP **積立**は house からの支出なので入る（レビュー指摘）。
    const bet = 1_000;
    expect(slotsPaidSpinLiability.maxHouseLiability(ctx(bet))).toBe(
      bet * SLOT_MAX_PAYOUT_MULT - bet + slotsJackpotCutFor(bet),
    );
    // 福の重みはプレイヤー → JP/救済 の一方向なので、債務を増やす向きには効かない
    // （モデルに福の項が無いことを、式が賭けと倍率と積立だけで決まることで確認する）
    expect(slotsPaidSpinLiability.maxHouseLiability(ctx(bet * 2))).toBe(
      2 * (bet * SLOT_MAX_PAYOUT_MULT) - bet * 2 + slotsJackpotCutFor(bet * 2),
    );
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

/**
 * JP 積立は house → jackpot の**支出**なので、債務に含めないと
 * 「他人の予約済み資金から JP へ流れる」経路が残る（レビュー指摘）。
 */
describe("JP積立が胴元債務に含まれる", () => {
  const ctx = (bet: number): LiabilityContext => ({
    bet,
    playerState: { winStreak: 0 },
    activeEffects: { winBonusCap: 0 },
  });

  it("スロットの必須流出は実装と同じ jackpotCutFor", () => {
    for (const bet of [50, 999, 1_000, 5_000, 1_234_567]) {
      expect(slotsLiability.mandatoryHouseOutflow(ctx(bet)), `bet=${bet}`).toBe(slotsJackpotCutFor(bet));
      expect(slotsPaidSpinLiability.mandatoryHouseOutflow(ctx(bet)), `bet=${bet}`).toBe(slotsJackpotCutFor(bet));
    }
    // 端数でも必ず 1 以上積む（率だけで計算すると 0 になる領域）
    expect(slotsJackpotCutFor(50)).toBe(1);
  });

  it("有料スピンの債務は「最大払戻 − 賭け金 + JP積立」", () => {
    const bet = 5_000;
    const maxPayout = bet * SLOT_MAX_PAYOUT_MULT;
    expect(slotsPaidSpinLiability.maxHouseLiability(ctx(bet))).toBe(maxPayout - bet + slotsJackpotCutFor(bet));
  });

  /**
   * レビュー指摘: 予約はセット（有料 + フリースピン1回）で取るのに、
   * 上限表示・事前検証が有料1回ぶんしか見ていなかった。
   * `liabilityModelFor("スロット")` はセット全体を返す。
   */
  it("スロットのモデルは1セット（有料 + フリースピン1回）", () => {
    const bet = 5_000;
    const set = liabilityModelFor("スロット")!;
    expect(set).toBe(slotsLiability);
    // 有料スピンの純債務 495,050 + フリースピンの丸ごと支払い 500,000
    expect(slotsPaidSpinLiability.maxHouseLiability(ctx(bet))).toBe(495_050);
    expect(set.maxHouseLiability(ctx(bet))).toBe(995_050);
    // house 100万では同時1人ぶんしか受けられない（PR本文の「同時2人」は誤り）
    expect(set.maxHouseLiability(ctx(bet)) * 2).toBeGreaterThan(1_000_000);
  });

  it("フリースピンぶんにはお守り上限も乗る（安全側）", () => {
    const bet = 1_000;
    const cap = 3_000;
    const withAmulet = slotsLiability.maxHouseLiability({
      bet,
      playerState: { winStreak: 0 },
      activeEffects: { winBonusCap: cap },
    });
    const without = slotsLiability.maxHouseLiability(ctx(bet));
    // 有料側とフリースピン側の両方に上限を足しているので 2×cap ぶん増える
    expect(withAmulet - without).toBe(cap * 2);
  });

  it("JP積立を持たないゲームの必須流出は 0", () => {
    for (const [name, model] of Object.entries(LIABILITY_MODELS)) {
      if (name === "スロット") continue;
      expect(model.mandatoryHouseOutflow(ctx(1_000)), name).toBe(0);
    }
  });

  it("逆算した最大ベットは JP積立ぶんも余力に収まる", () => {
    const rest = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
    for (const available of [100_000, 995_000, 10_000_000]) {
      const bet = slotsLiability.maxBetFor(available, rest);
      const need = slotsLiability.maxHouseLiability({ ...rest, bet });
      expect(need, `available=${available}`).toBeLessThanOrEqual(available);
      // +1 すると必ず溢れる（上限がぴったり）
      expect(slotsLiability.maxHouseLiability({ ...rest, bet: bet + 1 })).toBeGreaterThan(available);
    }
  });
});

describe("入力検証（PR4監査対応）: 0・負数・小数・NaN・Infinity を黙って受け入れない", () => {
  const models = Object.entries(LIABILITY_MODELS);
  const badBets = [0, -1, -100, 1.5, NaN, Infinity, -Infinity];

  it("maxHouseLiability はどのゲームでも不正な bet を例外にする", () => {
    for (const [name, model] of models) {
      for (const bet of badBets) {
        expect(() => model.maxHouseLiability(ctx(bet)), `${name}/${bet}`).toThrow(LiabilityError);
      }
    }
  });

  it("mandatoryHouseOutflow / maxPlayerLoss も同様に例外にする（liabilityFrom を経由しない経路も含む）", () => {
    for (const [name, model] of models) {
      for (const bet of badBets) {
        expect(() => model.mandatoryHouseOutflow(ctx(bet)), `${name}/${bet}`).toThrow(LiabilityError);
        expect(() => model.maxPlayerLoss(ctx(bet)), `${name}/${bet}`).toThrow(LiabilityError);
      }
    }
  });

  it("winStreak・winBonusCap が不正でも例外にする", () => {
    for (const [name, model] of models) {
      expect(() => model.maxHouseLiability(ctx(1_000, NaN)), `${name}/winStreak=NaN`).toThrow(LiabilityError);
      expect(() => model.maxHouseLiability(ctx(1_000, -1)), `${name}/winStreak=-1`).toThrow(LiabilityError);
      expect(() => model.maxHouseLiability(ctx(1_000, 1.5)), `${name}/winStreak=1.5`).toThrow(LiabilityError);
      expect(() => model.maxHouseLiability(ctx(1_000, 0, -1)), `${name}/winBonusCap=-1`).toThrow(LiabilityError);
      expect(() => model.maxHouseLiability(ctx(1_000, 0, NaN)), `${name}/winBonusCap=NaN`).toThrow(LiabilityError);
    }
  });

  it("safe integer を超える bet は明示的に拒否する（オーバーフロー後の小さい値で予約を通さない）", () => {
    for (const [name, model] of models) {
      expect(() => model.maxHouseLiability(ctx(MAX_SAFE_LIABILITY_BET + 1)), name).toThrow(LiabilityError);
      // 境界ちょうどは通り、有限の安全な整数を返す（NaN や Infinity ではない）
      const ok = model.maxHouseLiability(ctx(MAX_SAFE_LIABILITY_BET));
      expect(Number.isFinite(ok), name).toBe(true);
      expect(Number.isInteger(ok), name).toBe(true);
    }
  });

  it("winBonusCap は safe integer でなければ例外にする（マージ直前レビュー対応）", () => {
    const badWinBonusCaps = [0.5, Number.MAX_SAFE_INTEGER + 1, 1e308, NaN, Infinity, -1];
    for (const [name, model] of models) {
      for (const winBonusCap of badWinBonusCaps) {
        expect(() => model.maxHouseLiability(ctx(1_000, 0, winBonusCap)), `${name}/winBonusCap=${winBonusCap}`).toThrow(
          LiabilityError,
        );
      }
      // 境界ちょうど（MAX_SAFE_INTEGER）は「入力としては」許すが、掛け算後の結果が
      // safe integer を超えれば ERR_BET_OVERFLOW で拒否される（下の別テストで検証）。
      // ここでは winStreak=0・小さい bet の組み合わせで、入力自体は拒否されないことだけ見る。
      expect(() => model.maxHouseLiability(ctx(1_000, 0, Number.MAX_SAFE_INTEGER))).toThrow(LiabilityError);
    }
  });

  it("winStreak は safe integer でなければ例外にする", () => {
    const badWinStreaks = [0.5, Number.MAX_SAFE_INTEGER + 1, 1e308, NaN, Infinity, -1, -Infinity];
    for (const [name, model] of models) {
      for (const winStreak of badWinStreaks) {
        expect(() => model.maxHouseLiability(ctx(1_000, winStreak)), `${name}/winStreak=${winStreak}`).toThrow(
          LiabilityError,
        );
      }
    }
  });

  it("通常の winBonusCap=3,000 は例外にせず有限の safe integer を返す", () => {
    for (const [name, model] of models) {
      const value = model.maxHouseLiability(ctx(1_000, 0, 3_000));
      expect(Number.isSafeInteger(value), name).toBe(true);
    }
  });

  it("計算結果が safe integer を超える組み合わせ（巨大 bet × 巨大 winBonusCap）は ERR_BET_OVERFLOW で拒否する", () => {
    // bet 自体は MAX_SAFE_LIABILITY_BET 以下で許容範囲でも、
    // winBonusCap に極端な safe integer 上限を足すと gross が safe integer を超えうる
    for (const [name, model] of models) {
      expect(
        () => model.maxHouseLiability(ctx(MAX_SAFE_LIABILITY_BET, 20, Number.MAX_SAFE_INTEGER)),
        name,
      ).toThrow(LiabilityError);
    }
  });

  it("不明なゲームは債務0として扱わず undefined を返す（fail-closed）", () => {
    expect(liabilityModelFor("知らないゲーム")).toBeUndefined();
    expect(liabilityModelFor("")).toBeUndefined();
    expect(liabilityModelFor("__proto__")).toBeUndefined();
  });

  it("ルーレットの増分債務も不正な amount を例外にする", () => {
    for (const amount of badBets) {
      expect(() => rouletteIncrementalLiability({ type: "single", amount }), `amount=${amount}`).toThrow(LiabilityError);
      expect(() => rouletteTableLiability([{ type: "even", amount: 1_000 }, { type: "single", amount }]), `amount=${amount}`).toThrow(
        LiabilityError,
      );
    }
  });

  it("ルーレットの未知 type は even 扱いにせず例外にする（fail-closed・マージ直前レビュー対応）", () => {
    const unknownTypes = ["unknown", "", "__proto__"];
    for (const type of unknownTypes) {
      const bet = { type, amount: 1_000 } as unknown as { type: "even" | "single"; amount: number };
      expect(() => rouletteIncrementalLiability(bet), `type=${JSON.stringify(type)}`).toThrow(LiabilityError);
      expect(
        () => rouletteTableLiability([{ type: "even", amount: 500 }, bet]),
        `type=${JSON.stringify(type)}`,
      ).toThrow(LiabilityError);
    }
  });

  it("maxBetFor は available が不正でも例外にせず 0 を返す（内部値・システム由来のため）", () => {
    const rest = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
    for (const [name, model] of models) {
      for (const bad of [NaN, -1, -Infinity]) {
        expect(model.maxBetFor(bad, rest), `${name}/${bad}`).toBe(0);
      }
    }
  });
});

describe("実精算 <= モデル債務の直接比較（決定的乱数・境界入力での回帰）", () => {
  it("スロット: 100回の決定的スピンで実配当が house liability を超えない", () => {
    // 配当表のインデックスを総当たりして「最大の払戻になる出目」を作る決定的 RNG は使わず、
    // ここでは liability モデルの式そのもの（bet*SLOT_MAX_PAYOUT_MULT）が
    // 配当表の最大値と一致することを担保する（実配当は配当表を超えられない）。
    for (const bet of [1, 50, 1_000, 999_999]) {
      const maxTablePayout = bet * SLOT_MAX_PAYOUT_MULT;
      const modeled = slotsLiability.maxHouseLiability(ctx(bet)) + bet - slotsJackpotCutFor(bet);
      expect(modeled, `bet=${bet}`).toBeGreaterThanOrEqual(maxTablePayout);
    }
  });

  it("チンチロ: chinchiroPayout の実測最大値が chinchiroMaxPayout 以下（全役総当たり）", () => {
    for (const bet of [1, 100, 12_345]) {
      const winMuls = [1, 2, 3, 5]; // plain / shigoro,hifumiAgainst / zorome / pinzoro
      for (const mul of winMuls) {
        expect(chinchiroPayout(bet, mul), `bet=${bet}/mul=${mul}`).toBeLessThanOrEqual(chinchiroMaxPayout(bet));
      }
    }
  });

  /** casino.settle() を実際に動かし、house の実残高減少を liability モデルと突き合わせる */
  function liveSetup() {
    registerDefaultTxTypes();
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const ether = new EtherExchangeCore(db, ledger, new EventLog(db));
    const casino = new Casino(db, ether, new EventLog(db));
    const departments = new Departments(db, ledger);
    departments.upsert("賭博場", "賭博場", null);
    ledger.transfer({
      from: TREASURY, to: deptAccount("賭博場"), amount: 10_000_000, type: "adjust", actor: "t", approvedBy: "t",
      idempotencyKey: "seed:dept",
    });
    // 胴元へ十分すぎる元手（過小評価は house 残高では隠れないよう極端に大きくする）
    ether.fundFromAccount(deptAccount("賭博場"), 10_000_000, HOUSE_HOLDER, "seed:house");
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 1_000_000, type: "initial", actor: "t", idempotencyKey: "seed:a" });
    ether.buy("a", 1_000_000, "seed:buy:a");
    return { ether, casino };
  }

  it("実際の Casino.settle: 各ゲームの最大払戻を流しても house liability を超えない（winStreak=0）", () => {
    const bet = 1_000;
    const cases: Array<{ game: string; payout: number; jackpotCut?: number; model: typeof slotsLiability }> = [
      { game: "スロット", payout: bet * SLOT_MAX_PAYOUT_MULT, jackpotCut: slotsJackpotCutFor(bet), model: slotsLiability },
      { game: "丁半", payout: Math.floor(bet * CHOHAN_PAYOUT), model: chohanLiability },
      { game: "クラッシュ", payout: bet * CRASH_MAX_MULT_CAP, model: crashLiability },
      { game: "ポーカー", payout: bet * POKER_CATEGORY_PAYOUTS[11]!, model: pokerLiability },
    ];
    for (const c of cases) {
      const { ether, casino } = liveSetup();
      const houseBefore = ether.balanceOf(HOUSE_HOLDER);
      casino.settle("a", c.game, bet, c.payout, c.jackpotCut ?? 0, { operationId: `max-payout-${c.game}` });
      const houseAfter = ether.balanceOf(HOUSE_HOLDER);
      const actualOutflow = houseBefore - houseAfter;
      const modeledLiability = c.model.maxHouseLiability(ctx(bet));
      expect(actualOutflow, c.game).toBeLessThanOrEqual(modeledLiability);
    }
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
