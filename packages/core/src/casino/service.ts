import type Database from "better-sqlite3";
import { Chips } from "../chips/service.js";
import { EventLog } from "../events/service.js";

/**
 * カジノ（チップで遊ぶ）。掛け金は胴元(sys:house)へ、当たりは胴元から配当。
 * ハウスエッジは各ゲームのオッズに内蔵（ルーレットは0の存在、スロットは出目重み、
 * コインは配当1.95倍）。胴元のチップは賭博場の売上として貯まる（/カジノ 回収で引き出す）。
 * チップは Land100%準備なので、カジノは新規発行せずチップを移動するだけ＝総量保存。
 */
export const HOUSE = "sys:house";

export type CasinoErrorCode =
  | "ERR_BAD_BET"
  | "ERR_INSUFFICIENT_CHIPS"
  | "ERR_HOUSE_SHORT"
  | "ERR_BAD_PICK"
  | "ERR_ACTIVE_GAME"
  | "ERR_NO_GAME";

export class CasinoError extends Error {
  constructor(
    readonly code: CasinoErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "CasinoError";
  }
}

export interface CoinResult {
  bet: number;
  pick: "表" | "裏";
  outcome: "表" | "裏";
  win: boolean;
  payout: number; // 受取り総額（負け=0）
  net: number; // 損益
}

export interface SlotResult {
  bet: number;
  reels: string[];
  multiplier: number;
  payout: number;
  net: number;
}

export type RouletteBet = { kind: "color"; value: "赤" | "黒" } | { kind: "parity"; value: "偶" | "奇" } | { kind: "straight"; value: number };

export interface RouletteResult {
  bet: number;
  target: string;
  number: number;
  color: "赤" | "黒" | "緑";
  win: boolean;
  multiplier: number;
  payout: number;
  net: number;
}

// ---- スロットの出目（重み付き）----
const SLOT_SYMBOLS = ["🍒", "🍋", "🔔", "💎", "7️⃣"] as const;
const SLOT_WEIGHTS = [40, 30, 18, 9, 3]; // 合計100。7ほど激レア
const SLOT_MAX_MULT = 50;

// ルーレットの赤（欧州式）。それ以外(0除く)は黒、0は緑
const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// ---- トランプ（ブラックジャック・ハイロー）----
export interface Card {
  rank: number; // 1..13 (A..K)
  suit: string; // ♠♥♦♣
}
const SUITS = ["♠", "♥", "♦", "♣"];
const RANK_LABEL = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export const cardLabel = (c: Card): string => `${RANK_LABEL[c.rank]}${c.suit}`;
function freshDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) d.push({ rank: r, suit: s });
  return d;
}
/** ブラックジャックの手札価値（Aは11、超えたら1に落とす） */
function bjValue(cards: Card[]): number {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 1) {
      aces++;
      sum += 11;
    } else sum += Math.min(10, c.rank);
  }
  while (sum > 21 && aces > 0) {
    sum -= 10;
    aces--;
  }
  return sum;
}
const isNatural = (cards: Card[]): boolean => cards.length === 2 && bjValue(cards) === 21;

export type BJState = "playing" | "player_bust" | "win" | "lose" | "push" | "blackjack";
export interface BJView {
  bet: number;
  player: { cards: string[]; value: number };
  dealer: { cards: string[]; value: number; hidden: boolean };
  state: BJState;
  payout: number;
  net: number;
}

export type HiLoState = "playing" | "bust" | "cashed";
export interface HiLoView {
  bet: number;
  current: string;
  pot: number;
  streak: number;
  state: HiLoState;
  last?: string; // 直前にめくったカード
  higher: { count: number; mult: number };
  lower: { count: number; mult: number };
  tableLimit: boolean;
  payout?: number;
}

interface BJSession {
  bet: number;
  deck: Card[];
  player: Card[];
  dealer: Card[];
}
interface HiLoSession {
  bet: number;
  pot: number; // 現在の配当見込み（float）
  currentRank: number;
  currentLabel: string;
  streak: number;
}

export class Casino {
  constructor(
    private readonly db: Database.Database,
    private readonly chips: Chips,
    private readonly events: EventLog,
    private readonly rng: () => number = Math.random,
    /** その日の配当倍率（冥界の天気）。既定は等倍 */
    private readonly weather: () => number = () => 1,
  ) {
    void this.db;
  }

  /** 当たり配当に天気倍率を適用（掛け金返却＝pushには適用しない） */
  private win(base: number): number {
    return Math.floor(base * this.weather());
  }

  houseBalance(): number {
    return this.chips.balanceOf(HOUSE);
  }

  /** 胴元にチップを入れる（開帳の元手）。運営操作はbot側で判定 */
  fundHouse(fromUserId: string, chips: number): void {
    this.chips.transfer(fromUserId, HOUSE, chips);
    this.events.log("casino_fund", { actor: fromUserId, payload: { chips } });
  }
  /** 胴元の売上を引き出す（個人チップへ） */
  withdrawHouse(toUserId: string, chips: number): void {
    this.chips.transfer(HOUSE, toUserId, chips);
    this.events.log("casino_withdraw", { actor: toUserId, payload: { chips } });
  }

  /**
   * 胴元の売上を賭博場の部署口座へ Land として精算する。
   * チップ→Land変換は為替と同じスプレッド（焼却シンクあり）。部署の売上として溜まる。
   * @returns 変換したチップ数と部署に入った Land、焼却額
   */
  settleToDept(deptAccount: string, chips: number, actor: string): { chips: number; land: number; burned: number } {
    const n = Math.min(chips, this.houseBalance());
    if (n <= 0) return { chips: 0, land: 0, burned: 0 };
    const q = this.chips.redeemToAccount(HOUSE, n, deptAccount, actor, `casino-settle:${Date.now()}:${n}`);
    this.events.log("casino_settle", { actor, payload: { chips: n, land: q.output, dest: deptAccount, burned: q.burned } });
    return { chips: n, land: q.output, burned: q.burned };
  }

  private ensureBet(playerId: string, bet: number, maxMult: number): void {
    if (!Number.isInteger(bet) || bet <= 0) throw new CasinoError("ERR_BAD_BET", { bet });
    if (this.chips.balanceOf(playerId) < bet) throw new CasinoError("ERR_INSUFFICIENT_CHIPS", { held: this.chips.balanceOf(playerId), bet });
    // 最大配当を胴元が払えるか（天気倍率込み・掛け金を受けた後の残高で判定）
    const need = Math.ceil(bet * maxMult * this.weather());
    if (this.houseBalance() + bet < need) throw new CasinoError("ERR_HOUSE_SHORT", { house: this.houseBalance(), need });
  }

  /** 賭けを受け、結果に応じて配当を払う共通処理 */
  private resolve(playerId: string, bet: number, payout: number): void {
    this.chips.transfer(playerId, HOUSE, bet); // 掛け金を胴元へ
    if (payout > 0) this.chips.transfer(HOUSE, playerId, payout); // 当たりは胴元から
  }

  private readonly bjSessions = new Map<string, BJSession>();
  private readonly hiloSessions = new Map<string, HiLoSession>();

  private randInt(n: number): number {
    return Math.min(n - 1, Math.floor(this.rng() * n));
  }
  private drawFrom(deck: Card[]): Card {
    return deck.splice(this.randInt(deck.length), 1)[0]!;
  }
  /** 掛け金を胴元へ */
  private takeBet(playerId: string, bet: number): void {
    this.chips.transfer(playerId, HOUSE, bet);
  }
  /** 胴元から配当（胴元残でキャップ＝テーブルリミット。新規発行は絶対にしない） */
  private pay(playerId: string, amount: number): number {
    const a = Math.min(Math.floor(amount), this.houseBalance());
    if (a > 0) this.chips.transfer(HOUSE, playerId, a);
    return a;
  }

  // ---- ブラックジャック ----
  hasBlackjack(playerId: string): boolean {
    return this.bjSessions.has(playerId);
  }
  private bjView(bet: number, player: Card[], dealer: Card[], state: BJState, payout: number, hidden: boolean): BJView {
    return {
      bet,
      player: { cards: player.map(cardLabel), value: bjValue(player) },
      dealer: { cards: hidden ? [cardLabel(dealer[0]!), "🂠"] : dealer.map(cardLabel), value: hidden ? bjValue([dealer[0]!]) : bjValue(dealer), hidden },
      state,
      payout,
      net: payout - bet,
    };
  }

  blackjackStart(playerId: string, bet: number): BJView {
    if (this.bjSessions.has(playerId)) throw new CasinoError("ERR_ACTIVE_GAME", { game: "blackjack" });
    this.ensureBet(playerId, bet, 3); // 最大2.5倍(BJ)＋余裕
    this.takeBet(playerId, bet);
    const deck = freshDeck();
    const player = [this.drawFrom(deck), this.drawFrom(deck)];
    const dealer = [this.drawFrom(deck), this.drawFrom(deck)];
    const playerBJ = isNatural(player);
    const dealerBJ = isNatural(dealer);
    if (playerBJ || dealerBJ) {
      let payout = 0;
      let state: BJState = "lose";
      if (playerBJ && dealerBJ) {
        payout = bet;
        state = "push";
      } else if (playerBJ) {
        payout = this.win(Math.floor((bet * 5) / 2)); // 3:2 ×天気
        state = "blackjack";
      }
      const paid = this.pay(playerId, payout);
      this.events.log("casino_blackjack", { actor: playerId, payload: { bet, state, payout: paid } });
      return this.bjView(bet, player, dealer, state, paid, false);
    }
    this.bjSessions.set(playerId, { bet, deck, player, dealer });
    return this.bjView(bet, player, dealer, "playing", 0, true);
  }

  blackjackHit(playerId: string): BJView {
    const s = this.bjSessions.get(playerId);
    if (!s) throw new CasinoError("ERR_NO_GAME", { game: "blackjack" });
    s.player.push(this.drawFrom(s.deck));
    if (bjValue(s.player) > 21) {
      this.bjSessions.delete(playerId);
      this.events.log("casino_blackjack", { actor: playerId, payload: { bet: s.bet, state: "player_bust", payout: 0 } });
      return this.bjView(s.bet, s.player, s.dealer, "player_bust", 0, false);
    }
    return this.bjView(s.bet, s.player, s.dealer, "playing", 0, true);
  }

  blackjackStand(playerId: string): BJView {
    const s = this.bjSessions.get(playerId);
    if (!s) throw new CasinoError("ERR_NO_GAME", { game: "blackjack" });
    while (bjValue(s.dealer) < 17) s.dealer.push(this.drawFrom(s.deck));
    const pv = bjValue(s.player);
    const dv = bjValue(s.dealer);
    let state: BJState;
    let payout = 0;
    if (dv > 21 || pv > dv) {
      state = "win";
      payout = this.win(s.bet * 2);
    } else if (pv === dv) {
      state = "push";
      payout = s.bet;
    } else {
      state = "lose";
    }
    const paid = this.pay(playerId, payout);
    this.bjSessions.delete(playerId);
    this.events.log("casino_blackjack", { actor: playerId, payload: { bet: s.bet, state, payout: paid } });
    return this.bjView(s.bet, s.player, s.dealer, state, paid, false);
  }

  // ---- ハイロー（連勝＋キャッシュアウト）----
  hasHiLo(playerId: string): boolean {
    return this.hiloSessions.has(playerId);
  }
  private hiloMult(favorable: number): number {
    return favorable <= 0 ? 0 : (0.95 * 13) / favorable; // 5%エッジ。必ず1倍超
  }
  private hiloView(s: HiLoSession, state: HiLoState, last?: string, payout?: number): HiLoView {
    const higherCount = 13 - s.currentRank;
    const lowerCount = s.currentRank - 1;
    return {
      bet: s.bet,
      current: s.currentLabel,
      pot: Math.floor(s.pot),
      streak: s.streak,
      state,
      last,
      higher: { count: higherCount, mult: Math.round(this.hiloMult(higherCount) * 100) / 100 },
      lower: { count: lowerCount, mult: Math.round(this.hiloMult(lowerCount) * 100) / 100 },
      tableLimit: Math.floor(s.pot) >= this.houseBalance(),
      payout,
    };
  }
  private drawCard(): Card {
    return { rank: this.randInt(13) + 1, suit: SUITS[this.randInt(4)]! };
  }

  hiloStart(playerId: string, bet: number): HiLoView {
    if (this.hiloSessions.has(playerId)) throw new CasinoError("ERR_ACTIVE_GAME", { game: "hilo" });
    this.ensureBet(playerId, bet, 2);
    this.takeBet(playerId, bet);
    const c = this.drawCard();
    const s: HiLoSession = { bet, pot: bet, currentRank: c.rank, currentLabel: cardLabel(c), streak: 0 };
    this.hiloSessions.set(playerId, s);
    return this.hiloView(s, "playing");
  }

  hiloGuess(playerId: string, dir: "higher" | "lower"): HiLoView {
    const s = this.hiloSessions.get(playerId);
    if (!s) throw new CasinoError("ERR_NO_GAME", { game: "hilo" });
    const favorable = dir === "higher" ? 13 - s.currentRank : s.currentRank - 1;
    const next = this.drawCard();
    const win = dir === "higher" ? next.rank > s.currentRank : next.rank < s.currentRank;
    if (!win || favorable <= 0) {
      this.hiloSessions.delete(playerId);
      this.events.log("casino_hilo", { actor: playerId, payload: { bet: s.bet, streak: s.streak, state: "bust" } });
      return this.hiloView(s, "bust", cardLabel(next));
    }
    s.pot *= this.hiloMult(favorable);
    s.currentRank = next.rank;
    s.currentLabel = cardLabel(next);
    s.streak++;
    // テーブルリミット: 胴元残を超えたらそこで頭打ち（キャップ）
    if (Math.floor(s.pot) > this.houseBalance()) s.pot = this.houseBalance();
    return this.hiloView(s, "playing", cardLabel(next));
  }

  hiloCashout(playerId: string): HiLoView {
    const s = this.hiloSessions.get(playerId);
    if (!s) throw new CasinoError("ERR_NO_GAME", { game: "hilo" });
    const paid = this.pay(playerId, this.win(Math.floor(s.pot)));
    this.hiloSessions.delete(playerId);
    this.events.log("casino_hilo", { actor: playerId, payload: { bet: s.bet, streak: s.streak, state: "cashed", payout: paid } });
    return this.hiloView(s, "cashed", undefined, paid);
  }

  // ---- コイン ----
  coin(playerId: string, bet: number, pick: "表" | "裏"): CoinResult {
    if (pick !== "表" && pick !== "裏") throw new CasinoError("ERR_BAD_PICK", { pick });
    this.ensureBet(playerId, bet, 2);
    const outcome: "表" | "裏" = this.randInt(2) === 0 ? "表" : "裏";
    const win = outcome === pick;
    const payout = win ? this.win(Math.floor((bet * 195) / 100)) : 0; // 1.95倍（エッジ2.5%）×天気
    this.resolve(playerId, bet, payout);
    this.events.log("casino_coin", { actor: playerId, payload: { bet, pick, outcome, payout } });
    return { bet, pick, outcome, win, payout, net: payout - bet };
  }

  // ---- スロット ----
  private spinReel(): string {
    let r = this.randInt(100);
    for (let i = 0; i < SLOT_SYMBOLS.length; i++) {
      if (r < SLOT_WEIGHTS[i]!) return SLOT_SYMBOLS[i]!;
      r -= SLOT_WEIGHTS[i]!;
    }
    return SLOT_SYMBOLS[0]!;
  }
  private slotMultiplier(reels: string[]): number {
    const [a, b, c] = reels;
    if (a === b && b === c) {
      switch (a) {
        case "7️⃣": return 50;
        case "💎": return 20;
        case "🔔": return 10;
        case "🍒": return 5;
        case "🍋": return 3;
      }
    }
    const cherries = reels.filter((s) => s === "🍒").length;
    if (cherries === 2) return 2;
    if (cherries === 1) return 1; // 掛け金だけ返る（実質ハズレ回避）
    return 0;
  }
  slot(playerId: string, bet: number): SlotResult {
    this.ensureBet(playerId, bet, SLOT_MAX_MULT);
    const reels = [this.spinReel(), this.spinReel(), this.spinReel()];
    const multiplier = this.slotMultiplier(reels);
    const payout = this.win(bet * multiplier);
    this.resolve(playerId, bet, payout);
    this.events.log("casino_slot", { actor: playerId, payload: { bet, reels, multiplier, payout } });
    return { bet, reels, multiplier, payout, net: payout - bet };
  }

  // ---- ルーレット ----
  private colorOf(n: number): "赤" | "黒" | "緑" {
    if (n === 0) return "緑";
    return ROULETTE_RED.has(n) ? "赤" : "黒";
  }
  roulette(playerId: string, bet: number, target: RouletteBet): RouletteResult {
    const maxMult = target.kind === "straight" ? 36 : 2;
    if (target.kind === "straight" && (target.value < 0 || target.value > 36)) throw new CasinoError("ERR_BAD_PICK", { target });
    this.ensureBet(playerId, bet, maxMult);
    const number = this.randInt(37); // 0..36
    const color = this.colorOf(number);
    let win = false;
    if (target.kind === "color") win = color === target.value;
    else if (target.kind === "parity") win = number !== 0 && (number % 2 === 0 ? "偶" : "奇") === target.value;
    else win = number === target.value;
    const multiplier = win ? maxMult : 0;
    const payout = this.win(bet * multiplier);
    this.resolve(playerId, bet, payout);
    const targetStr = target.kind === "straight" ? String(target.value) : target.value;
    this.events.log("casino_roulette", { actor: playerId, payload: { bet, target: targetStr, number, color, payout } });
    return { bet, target: targetStr, number, color, win, multiplier, payout, net: payout - bet };
  }
}
