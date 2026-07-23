import type { CasinoRng } from "./rng.js";

/**
 * 各ゲームの純粋数値モデル（DBもDiscordも触らない）。
 *
 * ここに入れる基準:
 * - 賭け結果の乱数と配当計算だけの純関数
 * - RTP テストとシミュレーションから直接呼べる
 * - 実装コード (apps/bot/src/casino/*.ts) は「同じ定数・同じ関数」を import して使う
 *   → 「表示配当表 / 実払戻 / RTPモデル」が定数レベルで一致することを担保
 */

// ─── 丁半 ─────────────────────────────────────────────
/**
 * 丁半（サイコロ2つ / 偶奇当て / 2倍配当）。
 *
 * 実装 (apps/bot/src/casino/chohan.ts) は HOUSE_EDGE=0.03 を減価掛けしていた（表示"2倍"←→実1.94倍）。
 * v3 で「表示倍率＝実払戻」に統一し、代わりに CHOHAN_PAYOUT を 2 未満の実数値で明示する。
 * 現在: 1.94 倍（0.03 のエッジを掛け目に露出）。RTP は P(勝ち) × 1.94 = 0.5 × 1.94 = 0.97。
 * 引き分けは無い（サイコロ2つ合計は必ず偶奇のどちらか）。
 */
export const CHOHAN_PAYOUT = 1.94;

export function chohanRollAndPay(rng: CasinoRng, bet: number, pick: "cho" | "han"): number {
  const d1 = rng.int(1, 6);
  const d2 = rng.int(1, 6);
  const isCho = (d1 + d2) % 2 === 0;
  const won = (pick === "cho") === isCho;
  return won ? Math.floor(bet * CHOHAN_PAYOUT) : 0;
}

/** 丁半の理論RTP（配当 × 勝率）。CHOHAN_PAYOUT を触ったらこのテストが動く */
export function chohanRtp(): number {
  return 0.5 * CHOHAN_PAYOUT;
}

// ─── ルーレット ─────────────────────────────────────────
/**
 * ルーレット（0〜36 の 37 マス / シングルゼロ）。
 * - 赤・黒・奇数・偶数・大・小: 2倍（P(win)=18/37）→ RTP = 36/37 ≈ 97.30%
 * - 零(0)単発:              36倍（P(win)= 1/37）→ RTP = 36/37 ≈ 97.30%
 * 全ベットタイプで同じ RTP になる（シングルゼロの構造）。
 */
export const ROULETTE_SLOTS = 37; // 0..36
export const ROULETTE_PAYOUTS = { even: 2, single: 36 } as const;

export function rouletteSpin(rng: CasinoRng): number {
  return rng.int(0, ROULETTE_SLOTS - 1);
}

/** 各種ベット種別の理論 RTP（全て 36/37） */
export function rouletteRtp(): {
  red: number; black: number; odd: number; even: number; high: number; low: number; single0: number;
} {
  const evens = 18 / ROULETTE_SLOTS;
  const evenBetRtp = evens * ROULETTE_PAYOUTS.even; // 36/37
  const single0Rtp = (1 / ROULETTE_SLOTS) * ROULETTE_PAYOUTS.single; // 36/37
  return { red: evenBetRtp, black: evenBetRtp, odd: evenBetRtp, even: evenBetRtp, high: evenBetRtp, low: evenBetRtp, single0: single0Rtp };
}

// ─── クラッシュ ─────────────────────────────────────────
/**
 * クラッシュ（マルチプライヤーが崩壊するまで引き延ばして cashout）。
 *
 * ## 崩壊分布（本モデルが「単一の実装」・bot からも import する）
 * - r ∈ [0, 1) を一様サンプリング
 * - r < 0.01（1%）: crash = 1.0（即崩壊）
 * - r >= 0.01     : crash = (1 - HOUSE_EDGE) / (1 - r) = 0.96 / (1 - r)
 *
 * ## 理論 RTP（重要: 1%即崩壊を "追加" 控除してはいけない）
 * 最低降車 MIN_CASHOUT >= 1.0（実際は 1.5）で降りる固定戦略 M の場合:
 *   crash >= M ⟺ 0.96 / (1 - r) >= M ⟺ r >= 1 - 0.96/M
 *   ここで 1 - 0.96/M > 0.01（M > 0.97）なら、下側の 1% は既に「crash=1.0 < M で負け」に
 *   含まれている（分岐 r < 0.01 は crash=1.0 なので M>1 では絶対に勝てない）。
 *   したがって P(crash >= M) = 1 - (1 - 0.96/M) = 0.96 / M
 *   RTP(M) = P(crash >= M) × M = **0.96**（M に依らず 96%）
 *
 * これに（1 - 即崩壊率）を追加で掛けると 1% を二重控除になる。
 * 実装丸め（`Math.round(x*100)/100` と `Math.max(1.0, ...)`）で若干下振れするので、
 * 実測 RTP はわずかに 96% を下回る（テストは 95〜96% 帯で検証）。
 */
export const CRASH_HOUSE_EDGE = 0.04;
export const CRASH_INSTANT_BUST_RATE = 0.01;
/** 最低降車倍率。M < MIN_CASHOUT の戦略は不能（実装が受け付けない） */
export const CRASH_MIN_CASHOUT = 1.5;
/** 表示・テストで使うテーブルリミット倍率（マモン純3=100倍と同じスケール） */
export const CRASH_MAX_MULT_CAP = 100;

export function crashPoint(rng: CasinoRng): number {
  const r = rng.float();
  if (r < CRASH_INSTANT_BUST_RATE) return 1.0;
  const crash = (1 - CRASH_HOUSE_EDGE) / (1 - r);
  return Math.max(1.0, Math.round(crash * 100) / 100);
}

/**
 * 固定 cashout 戦略の理論 RTP。
 * 分布上 M >= 1 なら (1 - HOUSE_EDGE)、それ以外は 0（M < 1 では受け付け不能）。
 * cashoutTarget は情報として受け取るが、値そのものによらず RTP は一定（この歪みの少ない分布の性質）。
 */
export function crashRtp(cashoutTarget: number): number {
  if (cashoutTarget < 1) return 0;
  return 1 - CRASH_HOUSE_EDGE;
}

// ─── 板（Markets）: 場代 3% ─────────────────────────────
/** 板の場代率。core/casino/market.ts が同名 export を import する（単一の真実源） */
export const MARKET_HOUSE_CUT = 0.03;
export function marketPlayerRtp(): number {
  return 1 - MARKET_HOUSE_CUT;
}

// ─── 競馬（Keiba）: 場代 10% ────────────────────────────
/** 競馬の場代率。apps/bot/src/casino/keiba.ts が同名 export を import する */
export const KEIBA_HOUSE_RATE = 0.1;
export function keibaPlayerRtp(): number {
  return 1 - KEIBA_HOUSE_RATE;
}

// ─── ブラックジャック（固定戦略） ───────────────────────
/**
 * ブラックジャックの単純戦略群。
 *
 * 3種類の比較対象戦略を実装する:
 *   - "always_stand": 常にスタンド（数字にかかわらず1手も引かない）
 *   - "mimic_dealer": ディーラー模倣（<17 でヒット、>=17 でスタンド）
 *   - "hard17":       hard 17 以上でスタンド、A は 11 として計算し バスト時は 1 に自動転換
 *                    （＝ mimic_dealer と実質同義。命名分けで比較しやすくしている）
 *
 * BJ ルール（apps/bot/src/casino/blackjack.ts と一致）:
 *   - 1 デッキ、ディーラーは 17 以上でスタンド（S17）
 *   - ブラックジャック(BJ)自然役: 2.5 倍払い
 *   - 通常勝ち: 2 倍（元金込み）
 *   - プッシュ: 返金
 *   - ダブルダウン・スプリット・保険: 本モデルではオプションで扱う
 *
 * ダブルダウン: `bjSimulate` の opts.doubleOnHard9to11 を true にすると
 *              ハード9-11 のみ最初のアクションでダブル選択（実装 UI に近い簡易版）。
 *
 * 期待値: RTP は「total_payout / total_bet」で報告する（bet=1 スケール）。
 */
export type BjStrategy = "always_stand" | "mimic_dealer" | "hard17";

interface Card { rank: number; value: number }

function makeDeck(rng: CasinoRng): Card[] {
  const d: Card[] = [];
  const ranks: Array<[number, number]> = [
    [1, 11], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9],
    [10, 10], [11, 10], [12, 10], [13, 10],
  ];
  for (let s = 0; s < 4; s++) for (const [r, v] of ranks) d.push({ rank: r, value: v });
  return rng.shuffle(d);
}
function handValue(h: Card[]): number {
  let total = h.reduce((s, c) => s + c.value, 0);
  let aces = h.filter((c) => c.rank === 1).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}
function isNatural(h: Card[]): boolean {
  return h.length === 2 && handValue(h) === 21;
}

/**
 * BJ 1 ハンドの決着を返す。
 * @returns 賭け 1 に対する payout（0=負け、1=プッシュ、2=通常勝ち、2.5=BJ、負けはダブル時 -2 相当）
 * ダブルダウン発動時は wagered=2 として返す。呼び出し側で wagered で割って RTP を出す。
 */
export function bjSimulateHand(
  rng: CasinoRng,
  strategy: BjStrategy,
  opts: { doubleOnHard9to11?: boolean } = {},
): { payout: number; wagered: number } {
  const deck = makeDeck(rng);
  const player: Card[] = [deck.pop()!, deck.pop()!];
  const dealer: Card[] = [deck.pop()!, deck.pop()!];

  // BJ 自然役の先チェック（ダブルは無効化）
  const playerBj = isNatural(player);
  const dealerBj = isNatural(dealer);
  if (playerBj || dealerBj) {
    if (playerBj && dealerBj) return { payout: 1, wagered: 1 }; // プッシュ
    if (playerBj) return { payout: 2.5, wagered: 1 };
    return { payout: 0, wagered: 1 };
  }

  let wagered = 1;
  // ダブルダウン（最初のアクションのみ・ハード9-11 のとき）
  const initialTotal = handValue(player);
  const initialSoft = player.some((c) => c.rank === 1) && initialTotal <= 21;
  if (opts.doubleOnHard9to11 && !initialSoft && initialTotal >= 9 && initialTotal <= 11) {
    wagered = 2;
    player.push(deck.pop()!);
  } else {
    // ヒット/スタンド
    while (true) {
      const total = handValue(player);
      if (strategy === "always_stand") break;
      if (total >= 17) break; // mimic_dealer / hard17 とも 17 以上でスタンド
      player.push(deck.pop()!);
    }
  }

  const pTotal = handValue(player);
  if (pTotal > 21) return { payout: 0, wagered };

  // ディーラーは 17 以上でスタンド
  while (handValue(dealer) < 17) dealer.push(deck.pop()!);
  const dTotal = handValue(dealer);

  if (dTotal > 21 || pTotal > dTotal) return { payout: wagered * 2, wagered };
  if (pTotal === dTotal) return { payout: wagered, wagered };
  return { payout: 0, wagered };
}

export function bjSimulateRtp(
  rng: CasinoRng,
  hands: number,
  strategy: BjStrategy,
  opts: { doubleOnHard9to11?: boolean } = {},
): { rtp: number; wagered: number; payouts: number } {
  let wagered = 0;
  let payouts = 0;
  for (let i = 0; i < hands; i++) {
    const r = bjSimulateHand(rng, strategy, opts);
    wagered += r.wagered;
    payouts += r.payout;
  }
  return { rtp: payouts / wagered, wagered, payouts };
}

// ─── ポーカー（Jacks or Better 相当・固定戦略） ────────────
/**
 * ドローポーカー（apps/bot/src/casino/poker.ts のロジックを RTP 用にモデル化）。
 *
 * 実装コードは配当表を持つが、ここではペア以上を「勝ち」として RTP の下限見積もりを行う。
 * より精密な RTP は apps/bot 実装の payoutTable と戦略（=どのカードを残すか）に依存するため、
 * この関数は「上位手役が出る確率」の計測のみを行う。
 *
 * 戦略 "hold_all": 交換しない（初手の 5 枚のみで役判定）。最悪ケース RTP の下限。
 * 戦略 "hold_pairs": ペア以上があればそれをキープ、なければ最高2枚のみキープ、他は捨てる。
 *
 * より現実的な RTP は運用中の実測ログか、より複雑なドロー戦略の実装が必要（今回は対象外）。
 */
export type PokerStrategy = "hold_all" | "hold_pairs";

interface PkCard { rank: number; suit: number }
function pkDeck(rng: CasinoRng): PkCard[] {
  const d: PkCard[] = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s });
  return rng.shuffle(d);
}
type HandRank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; // 0=high, 1=pair, 2=two pair, 3=three, 4=straight, 5=flush, 6=full, 7=four, 8=SF, 9=RF
function evalPoker(h: PkCard[]): HandRank {
  const ranks = h.map((c) => c.rank).sort((a, b) => a - b);
  const suits = h.map((c) => c.suit);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const cs = [...counts.values()].sort((a, b) => b - a);
  const flush = suits.every((s) => s === suits[0]);
  // ストレート判定（A=14 だが A-2-3-4-5 は 5-high として許容）
  const unique = [...new Set(ranks)].sort((a, b) => a - b);
  let straight = false;
  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[4]! - unique[0]! === 4) { straight = true; straightHigh = unique[4]!; }
    if (unique[0] === 2 && unique[1] === 3 && unique[2] === 4 && unique[3] === 5 && unique[4] === 14) { straight = true; straightHigh = 5; }
  }
  if (straight && flush && straightHigh === 14) return 9; // Royal
  if (straight && flush) return 8; // Straight flush
  if (cs[0] === 4) return 7; // Four
  if (cs[0] === 3 && cs[1] === 2) return 6; // Full house
  if (flush) return 5;
  if (straight) return 4;
  if (cs[0] === 3) return 3;
  if (cs[0] === 2 && cs[1] === 2) return 2;
  if (cs[0] === 2) return 1;
  return 0;
}

/**
 * Jacks or Better 配当表（単一の真実源）。
 * apps/bot/src/casino/poker.ts の payMult もここから import する。
 *
 * インデックスは実装（apps/bot/src/casino/poker.ts の category）と一致:
 *   0=未使用, 1=ハイカード, 2=J未満のペア, 3=J以上のペア, 4=ツーペア, 5=スリー,
 *   6=ストレート, 7=フラッシュ, 8=フルハウス, 9=フォー, 10=ストレートフラッシュ, 11=ロイヤル
 * 配当は「payout multiplier（元金含む）」= bet × mult が戻ってくる額。
 */
export const POKER_CATEGORY_PAYOUTS: readonly number[] = [
  0, // (未使用: category は 1 始まり)
  0, // 1: ハイカード
  0, // 2: J 未満のペア
  2, // 3: J 以上のペア（Jacks or Better）
  3, // 4: ツーペア
  4, // 5: スリーカード
  5, // 6: ストレート
  7, // 7: フラッシュ
  10, // 8: フルハウス
  26, // 9: フォーカード
  51, // 10: ストレートフラッシュ
  251, // 11: ロイヤルフラッシュ
];

/**
 * 旧形式 API（RTPシミュレータの HandRank 0-9 用）。
 * 新規コードは POKER_CATEGORY_PAYOUTS を使うこと。
 */
export const POKER_PAYOUTS: Readonly<Record<HandRank, number>> = {
  0: POKER_CATEGORY_PAYOUTS[1]!, // high
  1: POKER_CATEGORY_PAYOUTS[2]!, // low pair
  2: POKER_CATEGORY_PAYOUTS[4]!, // two pair
  3: POKER_CATEGORY_PAYOUTS[5]!, // three
  4: POKER_CATEGORY_PAYOUTS[6]!, // straight
  5: POKER_CATEGORY_PAYOUTS[7]!, // flush
  6: POKER_CATEGORY_PAYOUTS[8]!, // full
  7: POKER_CATEGORY_PAYOUTS[9]!, // four
  8: POKER_CATEGORY_PAYOUTS[10]!, // straight flush
  9: POKER_CATEGORY_PAYOUTS[11]!, // royal
};

function pokerHold(rng: CasinoRng, strategy: PokerStrategy): { payout: number; hand: HandRank } {
  const deck = pkDeck(rng);
  const hand: PkCard[] = [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];
  if (strategy === "hold_all") {
    const r = evalPoker(hand);
    return { payout: POKER_PAYOUTS[r], hand: r };
  }
  // hold_pairs: ペア以上があれば残す。無ければ全交換。
  const counts = new Map<number, number>();
  for (const c of hand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  const paired = [...counts.entries()].filter(([, c]) => c >= 2).map(([r]) => r);
  const kept: PkCard[] = [];
  if (paired.length > 0) {
    for (const c of hand) if (paired.includes(c.rank)) kept.push(c);
  }
  while (kept.length < 5) kept.push(deck.pop()!);
  const r = evalPoker(kept);
  return { payout: POKER_PAYOUTS[r], hand: r };
}

export function pokerSimulateRtp(
  rng: CasinoRng,
  hands: number,
  strategy: PokerStrategy,
): { rtp: number; handCounts: Record<number, number> } {
  let payouts = 0;
  const handCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
  for (let i = 0; i < hands; i++) {
    const r = pokerHold(rng, strategy);
    payouts += r.payout;
    handCounts[r.hand]!++;
  }
  return { rtp: payouts / hands, handCounts };
}

// ─── ホールデム（対マモン簡易・固定戦略） ─────────────────
/**
 * apps/bot/src/casino/holdem.ts はプリフロップ〜リバーまで対マモンで進行する簡易版。
 * ここでは「1ハンド = ante 1 のみ・全 street check-only（コール無し）」を仮定した最小モデルで
 * RTP を測る。この戦略下では期待値は 0.5 に近い（マモンとの単純ヘッズアップ）。
 * より現実に近い RTP は実装 UI 側の bet 分岐込みで測る必要がある（今回は対象外）。
 */
export function holdemSimulateRtp(rng: CasinoRng, hands: number): { rtp: number; wins: number; losses: number; ties: number } {
  let wins = 0, losses = 0, ties = 0;
  for (let i = 0; i < hands; i++) {
    const deck = pkDeck(rng);
    const player = [deck.pop()!, deck.pop()!];
    const dealer = [deck.pop()!, deck.pop()!];
    // ボード5枚
    const board = [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];
    const bestFive = (extras: PkCard[]): HandRank => {
      // 7枚から最高5枚を探す（21通り）
      let best: HandRank = 0;
      for (let i = 0; i < extras.length; i++)
        for (let j = i + 1; j < extras.length; j++) {
          const five = extras.filter((_, k) => k !== i && k !== j);
          const r = evalPoker(five);
          if (r > best) best = r;
        }
      return best;
    };
    const pRank = bestFive([...player, ...board]);
    const dRank = bestFive([...dealer, ...board]);
    if (pRank > dRank) wins++;
    else if (pRank < dRank) losses++;
    else ties++;
  }
  // ante 1 で勝ち: +1、負け: -1、引き分け: 0 と仮定した RTP（元金込み）
  const rtp = (wins * 2 + ties) / hands;
  return { rtp, wins, losses, ties };
}

// ─── 株（Stocks）: ランダムウォーク＋売却手数料 ──────────
/** stocks.ts と同じ手数料率 */
export const STOCK_SELL_FEE = 0.01;
/**
 * 売却手数料以外に胴元エッジが無い（買値=売値の期待値）なら、
 * 買って即売る戦略の RTP = (1 - STOCK_SELL_FEE)。
 * ランダムウォーク自体は期待値中立なので、この式で正しい。
 */
export function stockBuyThenSellRtp(): number {
  return 1 - STOCK_SELL_FEE;
}
