import type { CasinoRng } from "./rng.js";

/**
 * チンチロの数値モデル（大型UPD PR4）。
 *
 * PR4 まで、チンチロの役判定・倍率・進行はすべて `apps/bot/src/casino/chinchiro.ts` に
 * 埋まっていて core に1行も無かった。他のゲームは `game-models.ts` / `slots-model.ts` を
 * 単一の真実源にしているので、チンチロだけ「胴元債務モデルが倍率を写して持つ」ことになる。
 * ここへ切り出して、bot の実装・債務モデル・RTP テストが同じ定数を読むようにする。
 *
 * DB も Discord も触らない純関数だけを置く。
 */

export type Dice = readonly [number, number, number];

export type Hand =
  | { type: "pinzoro" }
  | { type: "zorome"; value: number }
  | { type: "shigoro" }
  | { type: "hifumi" }
  | { type: "me"; score: number }
  | { type: "menashi" };

/** 最大投数（プレイヤーもマモンも同じ。お守り「二度振りの権」だけ +1） */
export const CHINCHIRO_MAX_ROLLS = 3;

/**
 * 勝ち利益に掛かる胴元エッジ。**旧 5% → 15%**（大型UPD PR4）。
 *
 * 敗北倍率を最大2倍に切ると、胴元の収入が落ちて RTP が **+5.70pt** 跳ね上がる
 * （stop>=5 方針・200万対局の実測）。正本 §1.5 は「基準RTPとの差を ±0.5pt 以内に
 * 収めるよう、勝利側倍率を最小限調整する」としているので、そのぶんを勝ち側から戻す。
 *
 * 役ごとの倍率表（5/3/2/1）は**一切変えない**。実装上、勝ちの利益は
 * `bet × mul × (1 − edge)` なので、この定数1つが「勝利側倍率の一律調整」そのものになる。
 * 表示される配当表を動かさずに済むぶん、これが最小の変更になる。
 *
 * 実測（各方針 200万対局）:
 * | 方針 | 旧RTP | 新RTP | 差 |
 * |---|---|---|---|
 * | 目が出たら必ず止める | 87.36% | 87.82% | +0.46pt |
 * | スコア4以上で止める | 86.86% | 87.00% | +0.14pt |
 * | スコア5以上で止める（マモンと同じ） | 84.85% | 84.82% | −0.03pt |
 * | スコア6以上で止める | 81.49% | 81.33% | −0.16pt |
 * | 投数まで振り続ける | 74.60% | 74.22% | −0.38pt |
 */
export const CHINCHIRO_HOUSE_EDGE = 0.15;

/**
 * 勝ち側の倍率（プレイヤーが勝ったときの利益倍率）。**旧実装から変更していない。**
 * RTP の戻しは {@link CHINCHIRO_HOUSE_EDGE} 側で行う（配当表を動かさないため）。
 */
export const CHINCHIRO_WIN_MULT = {
  pinzoro: 5,
  zorome: 3,
  shigoro: 2,
  /** 相手がヒフミを出したときの勝ち（自爆役の受け） */
  hifumiAgainst: 2,
  /** 目・メナシでの勝ち */
  plain: 1,
} as const;

/**
 * 負け側の倍率の上限（正本 §1.5「敗北倍率を最大2倍へ変更する」）。
 *
 * 旧実装はマモンの役の倍率をそのまま負け側に使っていたため、ピンゾロを出されると
 * **賭け額の5倍**を払う必要があった。「賭け 500 に対して最大損失 2,500」は
 * 初心者向けの金額選択UI（正本 §12.2 の「賭け額と最大損失の併記」）と噛み合わない。
 */
export const CHINCHIRO_MAX_LOSS_MULT = 2;

/**
 * 負け側の素の倍率。**勝ち側とは別の表**にしてある。
 *
 * 「目に負けたら賭け額を失う（1倍）」は構造的な値で、勝ち倍率をいくら動かしても
 * 変わらない。旧実装は勝ち側の表を負け側にも流用していたので、片方を調整すると
 * もう片方が黙って動いた。ここで切り離しておく。
 */
export const CHINCHIRO_LOSS_MULT_BASE = {
  pinzoro: 5,
  zorome: 3,
  shigoro: 2,
  /** 自分がヒフミを出した（自爆） */
  hifumiSelf: 2,
  /** 目・メナシに負けた／同点 */
  plain: 1,
} as const;

const rollOne = (rng: CasinoRng): number => rng.int(1, 6);

export function chinchiroRoll(rng: CasinoRng): Dice {
  return [rollOne(rng), rollOne(rng), rollOne(rng)] as const;
}

export function chinchiroEvaluate(dice: Dice): Hand {
  const [a, b, c] = [...dice].sort((x, y) => x - y) as [number, number, number];
  if (a === b && b === c) return a === 1 ? { type: "pinzoro" } : { type: "zorome", value: a };
  if (a === 4 && b === 5 && c === 6) return { type: "shigoro" };
  if (a === 1 && b === 2 && c === 3) return { type: "hifumi" };
  if (a === b) return { type: "me", score: c };
  if (b === c) return { type: "me", score: a };
  return { type: "menashi" };
}

/** 役の強さ比較用の順序値（大きいほど強い） */
export function chinchiroRank(h: Hand): number {
  switch (h.type) {
    case "pinzoro": return 1000;
    case "zorome": return 800 + h.value;
    case "shigoro": return 700;
    case "me": return 100 + h.score;
    case "menashi": return 0;
    case "hifumi": return -100;
  }
}

/** その役で勝ったときの利益倍率 */
export function chinchiroWinMult(h: Hand): number {
  switch (h.type) {
    case "pinzoro": return CHINCHIRO_WIN_MULT.pinzoro;
    case "zorome": return CHINCHIRO_WIN_MULT.zorome;
    case "shigoro": return CHINCHIRO_WIN_MULT.shigoro;
    case "hifumi": return CHINCHIRO_WIN_MULT.hifumiAgainst;
    default: return CHINCHIRO_WIN_MULT.plain;
  }
}

/**
 * その役に負けたときの支払倍率（賭け額の何倍を払うか）。
 * **必ず `CHINCHIRO_MAX_LOSS_MULT` で頭打ち**にする。
 */
export function chinchiroLossMult(dealerHand: Hand): number {
  const base = (() => {
    switch (dealerHand.type) {
      case "pinzoro": return CHINCHIRO_LOSS_MULT_BASE.pinzoro;
      case "zorome": return CHINCHIRO_LOSS_MULT_BASE.zorome;
      case "shigoro": return CHINCHIRO_LOSS_MULT_BASE.shigoro;
      default: return CHINCHIRO_LOSS_MULT_BASE.plain;
    }
  })();
  return Math.min(CHINCHIRO_MAX_LOSS_MULT, base);
}

/** 終了役（これが出たらそれ以上振らない） */
export function chinchiroIsTerminal(h: Hand): boolean {
  return h.type !== "me" && h.type !== "menashi";
}

export interface ChinchiroCompare {
  result: "player_win" | "dealer_win" | "push";
  /** >0 = プレイヤーの利益倍率 / 0 = 引き分け / <0 = プレイヤーの支払倍率（負値） */
  mul: number;
}

/**
 * 勝敗と倍率。**同点はマモン勝ち（-1倍）**、ヒフミは出した側が負け。
 * 負け側は `chinchiroLossMult` を通すので、必ず `-CHINCHIRO_MAX_LOSS_MULT` 以上。
 */
export function chinchiroCompare(player: Hand, dealer: Hand): ChinchiroCompare {
  if (player.type === "hifumi" && dealer.type === "hifumi") return { result: "push", mul: 0 };
  if (player.type === "hifumi") {
    return { result: "dealer_win", mul: -Math.min(CHINCHIRO_MAX_LOSS_MULT, CHINCHIRO_LOSS_MULT_BASE.hifumiSelf) };
  }
  if (dealer.type === "hifumi") return { result: "player_win", mul: CHINCHIRO_WIN_MULT.hifumiAgainst };
  const pr = chinchiroRank(player);
  const dr = chinchiroRank(dealer);
  if (pr > dr) return { result: "player_win", mul: chinchiroWinMult(player) };
  if (pr < dr) return { result: "dealer_win", mul: -chinchiroLossMult(dealer) };
  // 同点はマモン勝ち（賭け額を失う）
  return { result: "dealer_win", mul: -CHINCHIRO_LOSS_MULT_BASE.plain };
}

/**
 * 賭け額 `bet` と倍率 `mul` から、プレイヤーが受け取る払戻総額（元金込み）を返す。
 * 負けのときは 0（実際に払う額は `chinchiroPlayerLoss` で見る）。
 */
export function chinchiroPayout(bet: number, mul: number): number {
  if (mul > 0) return bet + Math.floor(bet * mul * (1 - CHINCHIRO_HOUSE_EDGE));
  if (mul === 0) return bet;
  return 0;
}

/** 負けたときにプレイヤーが実際に失う総額（賭け額を含む） */
export function chinchiroPlayerLoss(bet: number, mul: number): number {
  if (mul >= 0) return 0;
  return Math.abs(mul) * bet;
}

/** 賭け額に対してプレイヤーが被りうる最大損失（正本 §11.4: `2 × bet`） */
export function chinchiroMaxPlayerLoss(bet: number): number {
  return CHINCHIRO_MAX_LOSS_MULT * bet;
}

/** 賭け額に対する最大払戻（元金込み）。胴元債務モデルが読む */
export function chinchiroMaxPayout(bet: number): number {
  return chinchiroPayout(bet, CHINCHIRO_WIN_MULT.pinzoro);
}

// ─── シミュレーション（RTP 計測用） ─────────────────────────

/**
 * 「目」が出たときに振り直すかどうかの方針。
 * 実装は利用者がボタンで選ぶので、RTP は方針ごとに変わる。比較は同じ方針同士で行う。
 */
export type ChinchiroPolicy =
  /** 目が出たら必ず止める（画面の時間切れ既定と同じ） */
  | { kind: "always_stop" }
  /** スコアが threshold 以上なら止める（マモンは threshold=5） */
  | { kind: "stop_at"; threshold: number }
  /** 投数が尽きるまで振り直す */
  | { kind: "always_reroll" };

function shouldStop(policy: ChinchiroPolicy, score: number): boolean {
  switch (policy.kind) {
    case "always_stop": return true;
    case "stop_at": return score >= policy.threshold;
    case "always_reroll": return false;
  }
}

/** マモンの方針（実装 `chinchiro.ts` と同じ: 終了役か、目でスコア5以上なら止める） */
export const CHINCHIRO_DEALER_POLICY: ChinchiroPolicy = { kind: "stop_at", threshold: 5 };

/** 片側の手番を1回まわす */
export function chinchiroPlayTurn(
  rng: CasinoRng,
  policy: ChinchiroPolicy,
  maxRolls = CHINCHIRO_MAX_ROLLS,
): { dice: Dice; hand: Hand } {
  let dice = chinchiroRoll(rng);
  let hand = chinchiroEvaluate(dice);
  for (let rollNo = 1; rollNo < maxRolls; rollNo++) {
    if (chinchiroIsTerminal(hand)) break;
    // メナシは自動再振り。目は方針で決める
    if (hand.type === "me" && shouldStop(policy, hand.score)) break;
    dice = chinchiroRoll(rng);
    hand = chinchiroEvaluate(dice);
  }
  return { dice, hand };
}

export interface ChinchiroRtpResult {
  /** 払戻総額 / 賭け総額。負けの倍付けぶんは「賭け総額」ではなく払戻のマイナスとして扱う */
  rtp: number;
  wagered: number;
  payouts: number;
  /** プレイヤーが失った総額（倍付け負けを含む） */
  losses: number;
  winRate: number;
  pushRate: number;
  /** 倍付け負け（|mul| >= 2）の発生率 */
  doubleLossRate: number;
}

/**
 * RTP 実測。
 *
 * チンチロは**賭け額を超えて損をしうる**ので、「払戻 / 賭け」だけでは実態が出ない。
 * ここでは `RTP = (受取総額) / (支払総額)` として、支払総額に倍付けの追加徴収を含める。
 * こうすると 1.0 が損益分岐になり、他ゲームの RTP と同じ物差しで読める。
 */
export function chinchiroSimulateRtp(
  rng: CasinoRng,
  rounds: number,
  policy: ChinchiroPolicy = { kind: "stop_at", threshold: 5 },
  bet = 10_000,
): ChinchiroRtpResult {
  let paid = 0; // プレイヤーが出した総額（賭け + 倍付けの追加徴収）
  let received = 0; // プレイヤーが受け取った総額
  let wins = 0;
  let pushes = 0;
  let doubleLosses = 0;

  for (let i = 0; i < rounds; i++) {
    const p = chinchiroPlayTurn(rng, policy);
    const d = chinchiroPlayTurn(rng, CHINCHIRO_DEALER_POLICY);
    const cmp = chinchiroCompare(p.hand, d.hand);
    if (cmp.mul > 0) {
      paid += bet;
      received += chinchiroPayout(bet, cmp.mul);
      wins++;
    } else if (cmp.mul === 0) {
      paid += bet;
      received += bet;
      pushes++;
    } else {
      const loss = chinchiroPlayerLoss(bet, cmp.mul);
      paid += loss;
      if (loss > bet) doubleLosses++;
    }
  }
  return {
    rtp: received / paid,
    wagered: paid,
    payouts: received,
    losses: paid - received,
    winRate: wins / rounds,
    pushRate: pushes / rounds,
    doubleLossRate: doubleLosses / rounds,
  };
}
