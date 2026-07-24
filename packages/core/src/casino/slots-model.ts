import type { CasinoRng } from "./rng.js";

/**
 * 🎰 スロットの純粋モデル（DBもDiscordも触らない）。
 *
 * 目的:
 * - シンボル・配当表・エッジ・JP/フリースピン確率を一箇所に集約する
 * - 実装(apps/bot 側の演出)と数値評価(テスト・シミュレーション)で同じソースを使う
 * - RTP計算やモンテカルロ検証をテストからそのまま呼べるようにする
 *
 * 実測RTP:
 * - `computeRtp()` で理論値を出す（絵柄・配当・重み・エッジから閉形式で計算）
 * - `simulateRtp(rng, spins)` で長期シミュレーションと突き合わせる
 */

export interface SlotSymbol {
  readonly emoji: string;
  readonly name: string;
  readonly weight: number;
  readonly kind: "normal" | "wild" | "scatter";
}

export const SLOT_SYMBOLS: readonly SlotSymbol[] = [
  { emoji: "🦇", name: "蝙蝠", weight: 28, kind: "normal" },
  { emoji: "👻", name: "亡霊", weight: 23, kind: "normal" },
  { emoji: "🔥", name: "獄炎", weight: 17, kind: "normal" },
  { emoji: "⚔️", name: "魔剣", weight: 13, kind: "normal" },
  { emoji: "👑", name: "王冠", weight: 8, kind: "normal" },
  { emoji: "😈", name: "マモン", weight: 3, kind: "normal" },
  { emoji: "🌙", name: "月", weight: 5, kind: "wild" },
  { emoji: "✨", name: "魂片", weight: 3, kind: "scatter" },
];

/**
 * 3揃い配当（表示倍率＝実払戻）。
 *
 * ## 変更履歴
 * - v1: {3, 5, 10, 15, 30, 100, 月:25} + HOUSE_EDGE 0.04（表示100倍→実96倍）
 *      → 理論総合RTP 114% で胴元赤字
 * - v2: 上に加えて HOUSE_EDGE 0.20（表示100倍→実80倍）
 *      → RTP は 95% に降りるが「表示と実際が違う」バグ
 * - v3（現在）: HOUSE_EDGE 廃止・表示倍率＝実払戻。倍率を全体的に引き下げて 95% 帯に。
 *      {2, 3, 5, 10, 25, 100, 月:15}。マモン純3のみJP同伴で従来通り 100 倍。
 */
export const TRIPLE_PAYOUTS: Readonly<Record<string, number>> = {
  蝙蝠: 2,
  亡霊: 3,
  獄炎: 5,
  魔剣: 10,
  王冠: 25,
  マモン: 100,
  月: 15,
};

/**
 * 2揃い配当（表示倍率＝実払戻）。
 *
 * ## 変更履歴
 * - v1/v2: {1, 1.5, 2, 3, 5, 10}（1.5倍が整数払戻で見栄え悪い）
 * - v3（現在）: {1, 1, 2, 3, 5, 10}。亡霊のみ 1.5→1 に整数化。
 */
export const DOUBLE_PAYOUTS: Readonly<Record<string, number>> = {
  蝙蝠: 1,
  亡霊: 1,
  獄炎: 2,
  魔剣: 3,
  王冠: 5,
  マモン: 10,
};

/** JP 積立率（毎ベットの何%を JP プールへ回すか）。積立源は胴元の取り分から */
export const JP_CONTRIBUTION = 0.01;
/** JP 当選時に払い出す割合（残りは次回シードとして残す） */
export const JP_WIN_SHARE = 0.5;
/** スキャッター何個でフリースピン獲得か */
export const SCATTER_TRIGGER_COUNT = 3;

export type SpinKind = "none" | "double" | "triple" | "wild_triple" | "jackpot";

export interface SpinOutcome {
  reels: readonly [SlotSymbol, SlotSymbol, SlotSymbol];
  /** 賭け額に対する配当（賭け額込み・エッジ適用後・整数）。0=負け */
  payout: number;
  kind: SpinKind;
  matched?: string;
  /** フリースピン（3スキャッター）獲得。true なら次スピンは賭け額0で回せる（原作準拠） */
  freeSpin: boolean;
}

export const isScatterSym = (s: SlotSymbol): boolean => s.kind === "scatter";
export const isWildSym = (s: SlotSymbol): boolean => s.kind === "wild";

/** 1リール分の抽選（重み比例）。テストは deterministicRng で再現可能 */
export function spinReel(rng: CasinoRng): SlotSymbol {
  return rng.weighted(SLOT_SYMBOLS.map((s) => [s, s.weight] as const));
}

/**
 * リール結果 → 配当判定。純粋関数（副作用なし）。
 * apps/bot 側の演出コードは、この結果を使ってエテル移動と描画をする。
 *
 * ## 表示倍率＝実払戻の原則
 * v3 以降、隠れハウスエッジ (1 - HOUSE_EDGE) 倍を配当式から除去した。
 * `pay(mult) = bet * mult`（整数化のため floor）。配当表と実払戻がテスト・監査で同じ値になる。
 * RTP 調整はエッジ乗算ではなく `TRIPLE_PAYOUTS`/`DOUBLE_PAYOUTS` の実数値で行う。
 */
export function evaluate(
  reels: readonly [SlotSymbol, SlotSymbol, SlotSymbol],
  bet: number,
): SpinOutcome {
  const scatterCount = reels.filter(isScatterSym).length;
  const freeSpin = scatterCount >= SCATTER_TRIGGER_COUNT;
  const noScatter = !reels.some(isScatterSym);
  const pay = (mult: number) => Math.floor(bet * mult);

  if (noScatter && reels[0].name === reels[1].name && reels[1].name === reels[2].name) {
    const name = reels[0].name;
    const mult = TRIPLE_PAYOUTS[name] ?? 0;
    if (mult > 0) {
      if (name === "マモン") return { reels, payout: pay(mult), kind: "jackpot", matched: name, freeSpin };
      return { reels, payout: pay(mult), kind: name === "月" ? "wild_triple" : "triple", matched: name, freeSpin };
    }
  }
  if (noScatter) {
    const wilds = reels.filter(isWildSym).length;
    const normals = reels.filter((s) => s.kind === "normal");
    if (wilds > 0 && wilds < 3 && normals.length > 0 && normals.every((s) => s.name === normals[0]!.name)) {
      const mult = TRIPLE_PAYOUTS[normals[0]!.name] ?? 0;
      if (mult > 0) return { reels, payout: pay(mult), kind: "wild_triple", matched: normals[0]!.name, freeSpin };
    }
  }
  if (noScatter) {
    for (const sym of SLOT_SYMBOLS) {
      if (sym.kind !== "normal") continue;
      if (reels.filter((r) => r.name === sym.name).length === 2) {
        const mult = DOUBLE_PAYOUTS[sym.name] ?? 0;
        if (mult > 0) return { reels, payout: pay(mult), kind: "double", matched: sym.name, freeSpin };
      }
    }
  }
  return { reels, payout: 0, kind: "none", freeSpin };
}

/**
 * 理論RTPを閉形式で計算する（8^3 = 512 通りを列挙）。
 * @returns 各種RTP指標（bet=1 に正規化）
 *
 * ## 定義
 * - regular: 通常配当のみ（フリースピン加算とJP当選金は含まない）
 * - withFreeSpin: 通常配当 + フリースピン獲得時に得られる期待払戻を1回分加算
 * - withJackpot: withFreeSpin + JP当選金の長期期待（steady state）
 * - houseNetPerBet: 胴元から見た1ベット当たりの純収支（負なら胴元赤字）
 *
 * ## JP steady-state の扱い
 * 毎ベット JP_CONTRIBUTION がプールへ流れ、triple マモンで JP_WIN_SHARE を払い出す。
 * 平均プールサイズは C / (P × S) に収束（P=triple マモン確率, S=JP_WIN_SHARE）。
 * したがって長期のプレイヤーRTP寄与は JP_CONTRIBUTION に等しい（＝プレイヤーが払った分は
 * 平均的にすべて返ってくる。ただし当選がまばらでボラティリティが高い）。
 */
export function computeRtp(): {
  regular: number;
  withFreeSpin: number;
  withJackpot: number;
  houseNetPerBet: number;
  winRate: number;
  jpHitRate: number;
  freeSpinTriggerRate: number;
} {
  const totalW = SLOT_SYMBOLS.reduce((s, x) => s + x.weight, 0);
  let regular = 0;
  let freeSpinTriggerRate = 0;
  let winRate = 0;
  let jpHitRate = 0;
  for (const a of SLOT_SYMBOLS)
    for (const b of SLOT_SYMBOLS)
      for (const c of SLOT_SYMBOLS) {
        const p = (a.weight * b.weight * c.weight) / (totalW * totalW * totalW);
        const out = evaluate([a, b, c] as const, 1);
        // 生の掛け率で足し合わせる（bet=1 で floor 誤差が出るため raw を再計算）
        const rawMultiplier = rawPayoutMultiplier(out.kind, out.matched);
        regular += p * rawMultiplier;
        if (out.kind !== "none") winRate += p;
        if (out.kind === "jackpot") jpHitRate += p;
        if (out.freeSpin) freeSpinTriggerRate += p;
      }
  // フリースピンは同じ分布で1回追加のスピンが賭け額ゼロで走る。ただしフリースピン中は
  // さらなるフリースピン獲得は無効（原作準拠: !isFreeSpin ガード）。
  // したがって「フリースピンで期待される追加払戻 = regular RTP そのもの」を確率で重み付け。
  const withFreeSpin = regular + freeSpinTriggerRate * regular;
  // JP steady state: 長期の平均RTP寄与は JP_CONTRIBUTION と一致（本文参照）
  const withJackpot = withFreeSpin + JP_CONTRIBUTION;
  const houseNetPerBet = 1 - withJackpot;
  return { regular, withFreeSpin, withJackpot, houseNetPerBet, winRate, jpHitRate, freeSpinTriggerRate };
}

/** floor を経由しない生の掛け率。RTP 計算の内部専用 */
function rawPayoutMultiplier(kind: SpinKind, matched: string | undefined): number {
  if (kind === "jackpot") return TRIPLE_PAYOUTS["マモン"]!;
  if (kind === "triple" && matched) return TRIPLE_PAYOUTS[matched] ?? 0;
  if (kind === "wild_triple" && matched) return TRIPLE_PAYOUTS[matched] ?? 0;
  if (kind === "double" && matched) return DOUBLE_PAYOUTS[matched] ?? 0;
  return 0;
}

/**
 * モンテカルロ実測RTP。理論値との突き合わせ用（RNG差替えテストや回帰検出）。
 * フリースピンとJPを含めた最終的なプレイヤー観測RTPを返す。
 */
export function simulateRtp(
  rng: CasinoRng,
  spins: number,
  opts: { jpSeed?: number } = {},
): { rtp: number; freeSpinTriggerRate: number; jpHitRate: number; wagered: number; payouts: number } {
  const bet = 1000; // floor 誤差を小さくするため大きめの bet を使う
  let wagered = 0;
  let payouts = 0;
  let jpPool = opts.jpSeed ?? 0;
  let freeSpins = 0;
  let jpHits = 0;
  for (let i = 0; i < spins; i++) {
    wagered += bet;
    jpPool += Math.floor(bet * JP_CONTRIBUTION);
    const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(rng), spinReel(rng), spinReel(rng)];
    const out = evaluate(reels, bet);
    payouts += out.payout;
    if (out.kind === "jackpot") {
      jpHits++;
      const jpWin = Math.floor(jpPool * JP_WIN_SHARE);
      payouts += jpWin;
      jpPool -= jpWin;
    }
    if (out.freeSpin) {
      freeSpins++;
      // フリースピンは賭け額ゼロで1回。原作同様 isFreeSpin 中はさらなるフリースピンなし
      const freeReels: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(rng), spinReel(rng), spinReel(rng)];
      const freeOut = evaluate(freeReels, bet);
      payouts += freeOut.payout;
      if (freeOut.kind === "jackpot") {
        jpHits++;
        const jpWin = Math.floor(jpPool * JP_WIN_SHARE);
        payouts += jpWin;
        jpPool -= jpWin;
      }
    }
  }
  return {
    rtp: payouts / wagered,
    freeSpinTriggerRate: freeSpins / spins,
    jpHitRate: jpHits / spins,
    wagered,
    payouts,
  };
}
