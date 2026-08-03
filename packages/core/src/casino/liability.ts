import { chainMultiplier } from "./service.js";
import { CHOHAN_PAYOUT, CRASH_MAX_MULT_CAP, POKER_CATEGORY_PAYOUTS, ROULETTE_PAYOUTS } from "./game-models.js";
import { SLOT_MAX_PAYOUT_MULT, jackpotCutFor } from "./slots-model.js";
import { chinchiroMaxPayout, chinchiroMaxPlayerLoss } from "./chinchiro-model.js";

/**
 * ゲーム別の最大債務・最大損失モデル（大型UPD PR4・正本 §11.1）。
 *
 * 目的は2つ。
 * 1. **胴元が払えない賭けを受け付けない**（正本 I7）。PR5 の債務予約はこの値を予約する。
 * 2. **利用者に最大損失を正しく見せる**（正本 §12.2）。チンチロだけ賭け額を超えて損をする。
 *
 * 倍率は必ず既存のゲームモデル（`game-models.ts` / `slots-model.ts` / `chinchiro-model.ts`）から
 * 読む。ここへ書き写すと「配当表・実払戻・予約額」が別々に育つ。
 */

export interface LiabilityContext {
  bet: number;
  /** 連鎖ボーナスの算定に使う「いまの連勝数」（この勝ちで winStreak + 1 連勝目になる） */
  playerState: { winStreak: number };
  /** 装備中のお守りの勝利ボーナス上限の合計（現行は最大1種なので実質 0 か 3,000） */
  activeEffects: { winBonusCap: number };
  /** ゲーム固有の情報（ルーレットのベット一覧など） */
  gameState?: unknown;
}

export interface GameLiabilityModel {
  readonly game: string;
  /**
   * この1回で胴元が最悪いくら「純増で」払うか（＝予約すべき額）。
   * 賭け金の回収を織り込む。
   *
   * **JP の当選金は含めない**（jackpot holder から出るので house の債務ではない）。
   * 一方、**通常スピン時の JP 積立は含める**。積立は house → jackpot の支出で、
   * 「他人の予約済み資金を食える house からの流出」になるため（レビュー指摘）。
   * **福の重みは含めない**（プレイヤー → JP/救済 の一方向なので債務を減らす側）。
   */
  maxHouseLiability(ctx: LiabilityContext): number;
  /**
   * この1回で **必ず** house から出ていく額（配当とは別の確定支出）。
   * 現状はスロットの JP 積立だけ。`maxHouseLiability` はこれを内包する。
   */
  mandatoryHouseOutflow(ctx: LiabilityContext): number;
  /** この1回でプレイヤーが最悪いくら失うか（チンチロ以外は賭け額そのもの） */
  maxPlayerLoss(ctx: LiabilityContext): number;
  /** `available` から逆算できる最大ベット（切り捨て。1未満なら 0） */
  maxBetFor(available: number, ctx: Omit<LiabilityContext, "bet">): number;
}

/** そのゲームで連鎖ボーナスが効くか。実装で `chain: false` にしているゲームは 1.0 固定 */
export type ChainMode = "on" | "off";

function chainMult(mode: ChainMode, winStreak: number): number {
  if (mode === "off") return 1;
  return chainMultiplier(winStreak + 1).mult;
}

/**
 * 共通の債務式。
 *
 * 実装（`Casino.settle`）の順序は「お守りを乗せた payout を払う → その payout に連鎖倍率を掛けた
 * ボーナスを足す」なので、連鎖はお守り込みの額に掛かる。したがって安全側の債務は
 *
 * ```text
 * (最大払戻 + お守り上限) × 連鎖倍率 − 賭け金
 * ```
 *
 * 正本 §5.2 の表は `M·bet·C − bet + W` と書いており、お守りぶんに連鎖を掛けていない。
 * ここでは実装の順序に合わせて **W にも連鎖を掛ける**（表より `W × (C − 1)` だけ厳しい）。
 * 予約は多めに取っておくほうが安全側に倒れる。
 *
 * `mandatory` は勝敗に関わらず house から出る額（スロットの JP 積立）。
 * 配当が最大のときも同時に出ていくので、そのまま足す。
 */
function liabilityFrom(maxPayout: number, ctx: LiabilityContext, chain: ChainMode, mandatory = 0): number {
  const c = chainMult(chain, ctx.playerState.winStreak);
  const gross = Math.ceil((maxPayout + ctx.activeEffects.winBonusCap) * c);
  return Math.max(0, gross + mandatory - ctx.bet);
}

/** `liabilityFrom` の逆算。1 Ld 単位で二分探索する（倍率が実数・切り上げ混じりなので式で解かない） */
function betForLiability(
  available: number,
  ctx: Omit<LiabilityContext, "bet">,
  liabilityOf: (bet: number) => number,
): number {
  if (!Number.isFinite(available) || available < 0) return 0;
  void ctx;
  let lo = 0;
  let hi = Math.max(1, Math.floor(available) + 1);
  // 上限を先に押し上げる（available が大きいときに hi が足りないと打ち切られる）
  while (liabilityOf(hi) <= available && hi < Number.MAX_SAFE_INTEGER / 4) hi *= 2;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (liabilityOf(mid) <= available) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * 最大払戻が「賭け額 × 定数倍率」で表せるゲームの共通実装。
 * @param mandatory 勝敗に関わらず house から出る額（スロットの JP 積立）
 */
function fixedMultModel(
  game: string,
  maxPayoutMult: number,
  chain: ChainMode,
  mandatory: (bet: number) => number = () => 0,
): GameLiabilityModel {
  const maxPayout = (bet: number) => Math.floor(bet * maxPayoutMult);
  const liability = (ctx: LiabilityContext) => liabilityFrom(maxPayout(ctx.bet), ctx, chain, mandatory(ctx.bet));
  return {
    game,
    maxHouseLiability: liability,
    mandatoryHouseOutflow: (ctx) => mandatory(ctx.bet),
    maxPlayerLoss: (ctx) => ctx.bet,
    maxBetFor: (available, ctx) => betForLiability(available, ctx, (bet) => liability({ ...ctx, bet })),
  };
}

// ─── ゲーム別 ───────────────────────────────────────────

/**
 * スロットの**有料スピン1回ぶん**。マモン³ = 100倍。
 *
 * JP **当選金**は jackpot holder から出るので含めない。
 * JP **積立**は house → jackpot の支出なので含める。含めないと、積立が
 * 他の利用者の予約済み資金を食う（house.available を計算に入れずに house を減らす）。
 *
 * **これ単体では予約に使わない。** 1回の操作は必ず {@link slotsLiability}
 * （有料 + フリースピン1回）の単位で扱う。
 */
export const slotsPaidSpinLiability = fixedMultModel("スロット（有料1回）", SLOT_MAX_PAYOUT_MULT, "on", jackpotCutFor);

/**
 * スロットのフリースピン1回ぶんの債務。
 *
 * 賭け金を取らないので**回収がない**（＝払戻がまるごと house からの持ち出し）。
 * 実装（`spinOnce` のフリースピン分岐）は `settle` を通さないので連鎖ボーナスも JP 積立も無い。
 * お守りの勝利ボーナスは有料スピンと同じく乗りうるので、上限を安全側で足す。
 */
function slotsFreeSpinLiability(ctx: LiabilityContext): number {
  return Math.floor(ctx.bet * SLOT_MAX_PAYOUT_MULT) + ctx.activeEffects.winBonusCap;
}

/**
 * **スロット1セット = 有料スピン1回 + 最大1回のフリースピン**（PR5 レビュー指摘）。
 *
 * 予約はセット単位で取るのに、上限表示・事前検証が有料1回ぶんしか見ていなかった。
 * その結果「表示された上限では予約が取れない」状態になっていた。
 * `/遊ぶ スロット` の上限表示・事前検証・予約 INSERT・復帰ボタンはすべてこのモデルを通す。
 *
 * 原作準拠でフリースピン中にさらなるフリースピンは出ないので、多くても1回。
 *
 * 例（連鎖・お守りなし・賭け 5,000）:
 * ```text
 * 有料スピンの純債務  100×5,000 − 5,000 + JP積立50 =   495,050
 * フリースピンの支払  100×5,000                    =   500,000
 * 合計                                             =   995,050
 * ```
 * つまり house 100万では**同時2人ではなく1人**しか受けられない。
 */
export const slotsLiability: GameLiabilityModel = {
  game: "スロット",
  maxHouseLiability: (ctx) => slotsPaidSpinLiability.maxHouseLiability(ctx) + slotsFreeSpinLiability(ctx),
  mandatoryHouseOutflow: (ctx) => slotsPaidSpinLiability.mandatoryHouseOutflow(ctx),
  maxPlayerLoss: (ctx) => ctx.bet,
  maxBetFor: (available, ctx) =>
    betForLiability(available, ctx, (bet) => slotsLiability.maxHouseLiability({ ...ctx, bet })),
};

/** 丁半: CHOHAN_PAYOUT 倍。連鎖は実装で無効（実効RTP が 100% を超える回帰があったため） */
export const chohanLiability = fixedMultModel("丁半", CHOHAN_PAYOUT, "off");

/** クラッシュ: 払戻は CRASH_MAX_MULT_CAP でクランプ済み（PR3）。連鎖は実装で無効 */
export const crashLiability = fixedMultModel("クラッシュ", CRASH_MAX_MULT_CAP, "off");

/** ドローポーカー: ロイヤルフラッシュ 251 倍 */
export const pokerLiability = fixedMultModel("ポーカー", POKER_CATEGORY_PAYOUTS[11]!, "on");

/**
 * ホールデム: プレイヤーの総賭け `T` は **アンティ + 4ラウンドのコール = 5 × ante**。
 *
 * 実装 `holdem.ts` は preflop / flop / turn / river の**4局面すべてでコールできる**。
 * 旧 `MAX_MULT = 8`（「アンティ + 3ラウンド」の想定）は1ラウンドぶん足りず、
 * 受付時のテーブルリミット判定が最悪ケースを覆っていなかった。
 * 勝ちはポット総取り（= 2T）なので、最大払戻は `2 × 5 × ante = 10 × ante`。
 */
export const HOLDEM_CALL_ROUNDS = 4;
export const HOLDEM_MAX_TOTAL_BET_MULT = 1 + HOLDEM_CALL_ROUNDS; // T / ante = 5
export const HOLDEM_MAX_PAYOUT_MULT = HOLDEM_MAX_TOTAL_BET_MULT * 2; // pot / ante = 10

export const holdemLiability: GameLiabilityModel = {
  game: "ホールデム",
  // 賭け金の回収は「実際に積んだ額 T」なので、最悪ケースでは ante ではなく T を引く
  maxHouseLiability: (ctx) => {
    const total = ctx.bet * HOLDEM_MAX_TOTAL_BET_MULT;
    const c = chainMult("on", ctx.playerState.winStreak);
    const gross = Math.ceil((ctx.bet * HOLDEM_MAX_PAYOUT_MULT + ctx.activeEffects.winBonusCap) * c);
    return Math.max(0, gross - total);
  },
  mandatoryHouseOutflow: () => 0,
  // フォールドしても失うのは積んだぶんまで。最悪は T
  maxPlayerLoss: (ctx) => ctx.bet * HOLDEM_MAX_TOTAL_BET_MULT,
  maxBetFor: (available, ctx) =>
    betForLiability(available, ctx, (bet) => holdemLiability.maxHouseLiability({ ...ctx, bet })),
};

/**
 * ブラックジャック: ダブル後に勝つと総賭け 2·bet に対して 4·bet 戻る。
 * ダブルぶんの予約が取れないときは `blackjackNoDoubleLiability` を使い、
 * ダブルボタンだけを無効化する（手そのものは続行できる）。
 */
export const BLACKJACK_MAX_PAYOUT_MULT = 4;
export const BLACKJACK_NO_DOUBLE_MAX_PAYOUT_MULT = 2.5; // ナチュラル BJ は 3:2

export const blackjackLiability: GameLiabilityModel = {
  game: "ブラックジャック",
  maxHouseLiability: (ctx) => {
    const c = chainMult("on", ctx.playerState.winStreak);
    const gross = Math.ceil((ctx.bet * BLACKJACK_MAX_PAYOUT_MULT + ctx.activeEffects.winBonusCap) * c);
    return Math.max(0, gross - ctx.bet * 2); // ダブルで 2·bet を回収する
  },
  mandatoryHouseOutflow: () => 0,
  maxPlayerLoss: (ctx) => ctx.bet * 2,
  maxBetFor: (available, ctx) =>
    betForLiability(available, ctx, (bet) => blackjackLiability.maxHouseLiability({ ...ctx, bet })),
};

export const blackjackNoDoubleLiability = fixedMultModel("ブラックジャック（ダブル不可）", BLACKJACK_NO_DOUBLE_MAX_PAYOUT_MULT, "on");

/**
 * チンチロ: 最大払戻はピンゾロ勝ち。**賭け額を超えて損をしうる唯一のゲーム**で、
 * 最大損失は正本 §11.4 のとおり `2 × bet`。
 */
export const chinchiroLiability: GameLiabilityModel = {
  game: "チンチロ",
  maxHouseLiability: (ctx) => liabilityFrom(chinchiroMaxPayout(ctx.bet), ctx, "on"),
  mandatoryHouseOutflow: () => 0,
  maxPlayerLoss: (ctx) => chinchiroMaxPlayerLoss(ctx.bet),
  maxBetFor: (available, ctx) =>
    betForLiability(available, ctx, (bet) => liabilityFrom(chinchiroMaxPayout(bet), { ...ctx, bet }, "on")),
};

/**
 * ルーレット: 卓単位・複数人・複数箇所。
 * 同じ回転で複数の当たりが同時に成立しうる（赤 + 特定数字）ので、
 * **最大値ではなくベットごとの増分の総和**で予約する。連鎖・福は実装で無効。
 */
export interface RouletteBet {
  type: "even" | "single";
  amount: number;
}

/** ベット1件を追加で受けるときの増分債務（そのベットが当たったぶんの純増） */
export function rouletteIncrementalLiability(bet: RouletteBet): number {
  const odds = bet.type === "single" ? ROULETTE_PAYOUTS.single : ROULETTE_PAYOUTS.even;
  return Math.max(0, Math.ceil(bet.amount * (odds - 1)));
}

/** 卓に載っている全ベットの合計債務 */
export function rouletteTableLiability(bets: readonly RouletteBet[]): number {
  return bets.reduce((sum, b) => sum + rouletteIncrementalLiability(b), 0);
}

// ─── 参照表 ─────────────────────────────────────────────

/** ソロゲーム名 → モデル。`/遊ぶ` のサブコマンド名と揃える */
export const LIABILITY_MODELS: Readonly<Record<string, GameLiabilityModel>> = {
  スロット: slotsLiability,
  丁半: chohanLiability,
  クラッシュ: crashLiability,
  チンチロ: chinchiroLiability,
  ブラックジャック: blackjackLiability,
  ポーカー: pokerLiability,
  ホールデム: holdemLiability,
};

export function liabilityModelFor(game: string): GameLiabilityModel | undefined {
  return LIABILITY_MODELS[game];
}
