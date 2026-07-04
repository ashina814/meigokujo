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

export type CasinoErrorCode = "ERR_BAD_BET" | "ERR_INSUFFICIENT_CHIPS" | "ERR_HOUSE_SHORT" | "ERR_BAD_PICK";

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

export class Casino {
  constructor(
    private readonly db: Database.Database,
    private readonly chips: Chips,
    private readonly events: EventLog,
    private readonly rng: () => number = Math.random,
  ) {
    void this.db;
  }

  houseBalance(): number {
    return this.chips.balanceOf(HOUSE);
  }

  /** 胴元にチップを入れる（開帳の元手）。運営操作はbot側で判定 */
  fundHouse(fromUserId: string, chips: number): void {
    this.chips.transfer(fromUserId, HOUSE, chips);
    this.events.log("casino_fund", { actor: fromUserId, payload: { chips } });
  }
  /** 胴元の売上を引き出す */
  withdrawHouse(toUserId: string, chips: number): void {
    this.chips.transfer(HOUSE, toUserId, chips);
    this.events.log("casino_withdraw", { actor: toUserId, payload: { chips } });
  }

  private ensureBet(playerId: string, bet: number, maxMult: number): void {
    if (!Number.isInteger(bet) || bet <= 0) throw new CasinoError("ERR_BAD_BET", { bet });
    if (this.chips.balanceOf(playerId) < bet) throw new CasinoError("ERR_INSUFFICIENT_CHIPS", { held: this.chips.balanceOf(playerId), bet });
    // 最大配当を胴元が払えるか（掛け金を受けた後の残高で判定）
    if (this.houseBalance() + bet < bet * maxMult) throw new CasinoError("ERR_HOUSE_SHORT", { house: this.houseBalance(), need: bet * maxMult });
  }

  /** 賭けを受け、結果に応じて配当を払う共通処理 */
  private resolve(playerId: string, bet: number, payout: number): void {
    this.chips.transfer(playerId, HOUSE, bet); // 掛け金を胴元へ
    if (payout > 0) this.chips.transfer(HOUSE, playerId, payout); // 当たりは胴元から
  }

  private randInt(n: number): number {
    return Math.min(n - 1, Math.floor(this.rng() * n));
  }

  // ---- コイン ----
  coin(playerId: string, bet: number, pick: "表" | "裏"): CoinResult {
    if (pick !== "表" && pick !== "裏") throw new CasinoError("ERR_BAD_PICK", { pick });
    this.ensureBet(playerId, bet, 2);
    const outcome: "表" | "裏" = this.randInt(2) === 0 ? "表" : "裏";
    const win = outcome === pick;
    const payout = win ? Math.floor((bet * 195) / 100) : 0; // 1.95倍（エッジ2.5%）
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
    const payout = bet * multiplier;
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
    const payout = bet * multiplier;
    this.resolve(playerId, bet, payout);
    const targetStr = target.kind === "straight" ? String(target.value) : target.value;
    this.events.log("casino_roulette", { actor: playerId, payload: { bet, target: targetStr, number, color, payout } });
    return { bet, target: targetStr, number, color, win, multiplier, payout, net: payout - bet };
  }
}
