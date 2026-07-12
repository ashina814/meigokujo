import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherError, EtherExchange, HOUSE_HOLDER } from "./exchange.js";

/**
 * マモンの賭場の共通土台。
 * - 賭け/配当はエテル残高の移動のみ（Land 台帳は動かない・総量保存）
 * - 胴元(house)が全ゲームの相手方。配当可能額 = 胴元残高（テーブルリミット）
 * - 胴元の元手・売上は EtherExchange 経由で賭博場の部署口座と往復する
 * - 戦績は casino_stats に集計（通行証・賭場番付の材料）
 * - ジャックポットは専用保有者(jackpot)に積む
 */
export const JACKPOT_HOLDER = "jackpot";
/** 救済プール（福の重みの半分が入る。デイリー福分けの原資） */
export const RELIEF_HOLDER = "relief";

/** 連鎖ボーナス（連勝チェーン）。casino-bot の CHAIN_TIERS 準拠 */
export const CHAIN_TIERS: ReadonlyArray<{ min: number; mult: number; label: string }> = [
  { min: 1, mult: 1.0, label: "" },
  { min: 2, mult: 1.05, label: "🔥" },
  { min: 3, mult: 1.1, label: "🔥" },
  { min: 5, mult: 1.2, label: "🔥🔥" },
  { min: 7, mult: 1.35, label: "🔥🔥" },
  { min: 10, mult: 1.5, label: "🔥🔥🔥" },
  { min: 15, mult: 1.75, label: "✦🔥🔥🔥" },
  { min: 20, mult: 2.0, label: "✦✦🔥🔥🔥" },
];

export function chainMultiplier(streak: number): { mult: number; label: string } {
  let mult = 1.0;
  let label = "";
  for (const t of CHAIN_TIERS)
    if (streak >= t.min) {
      mult = t.mult;
      label = t.label;
    }
  return { mult, label };
}

/**
 * 福の重み（勝ち分への累進奉納率）。casino-bot 準拠のしきい値 × scale。
 * scale はエテル物価に合わせる係数（既定10 = 冥獄城レート 1Ld=10◈ 相当）。
 */
export function fukuRate(balance: number, scale: number): number {
  if (balance <= 10_000 * scale) return 0;
  if (balance <= 50_000 * scale) return 0.05;
  if (balance <= 100_000 * scale) return 0.1;
  if (balance <= 300_000 * scale) return 0.2;
  return 0.3;
}

export interface CasinoStatsRow {
  user_id: string;
  games: number;
  wins: number;
  losses: number;
  total_wagered: number;
  total_earned: number;
  biggest_win: number;
  current_win_streak: number;
  best_win_streak: number;
  current_lose_streak: number;
  updated_at: number;
}

export interface SettleResult {
  /** 賭け額 */
  wagered: number;
  /** 受け取った配当（0 = 負け・チェーン込み・福の重み控除後） */
  payout: number;
  /** 純損益 */
  net: number;
  /** 連鎖ボーナス（勝ち時のみ・胴元残高が上限） */
  chainBonus: number;
  /** この勝ちで何連勝目か */
  chainStreak: number;
  chainMult: number;
  chainLabel: string;
  /** 福の重みで奉納された額（半分JP・半分救済へ） */
  fukuTax: number;
  fukuRate: number;
}

export interface CasinoOptions {
  /** 福の重みしきい値のスケール（既定10）。関数なら毎回評価 */
  fukuScale?: number | (() => number);
}

const now = () => Math.floor(Date.now() / 1000);

export class Casino {
  private readonly fukuScaleOpt: number | (() => number);

  constructor(
    private readonly db: Database.Database,
    readonly ether: EtherExchange,
    private readonly events: EventLog,
    options: CasinoOptions = {},
  ) {
    this.fukuScaleOpt = options.fukuScale ?? 10;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_stats (
        user_id             TEXT PRIMARY KEY,
        games               INTEGER NOT NULL DEFAULT 0,
        wins                INTEGER NOT NULL DEFAULT 0,
        losses              INTEGER NOT NULL DEFAULT 0,
        total_wagered       INTEGER NOT NULL DEFAULT 0,
        total_earned        INTEGER NOT NULL DEFAULT 0,
        biggest_win         INTEGER NOT NULL DEFAULT 0,
        current_win_streak  INTEGER NOT NULL DEFAULT 0,
        best_win_streak     INTEGER NOT NULL DEFAULT 0,
        current_lose_streak INTEGER NOT NULL DEFAULT 0,
        updated_at          INTEGER NOT NULL
      );
    `);
  }

  /** 胴元のエテル残高（＝配当余力） */
  houseBalance(): number {
    return this.ether.balanceOf(HOUSE_HOLDER);
  }

  /** ジャックポット積立額 */
  jackpotPool(): number {
    return this.ether.balanceOf(JACKPOT_HOLDER);
  }

  /**
   * 賭けの受付可否。胴元が最悪ケースの配当を払えないなら卓を閉じる。
   * @param maxPayout このベットが当たったときの最大支払額（賭け額込み）
   */
  canAccept(maxPayout: number): boolean {
    return this.houseBalance() >= maxPayout;
  }

  private fukuScale(): number {
    const s = typeof this.fukuScaleOpt === "function" ? this.fukuScaleOpt() : this.fukuScaleOpt;
    return Number.isFinite(s) && s > 0 ? s : 10;
  }

  /**
   * 1ゲームの精算（ソロゲーム用）。原子的に:
   * 賭け徴収 → 配当 → 連鎖ボーナス（勝ち・胴元残高が上限） →
   * 福の重み（勝ち利益への累進奉納・半分JP/半分救済） → JP積立 → 戦績更新
   * @param payout 配当（賭け額込みの受取総額。0=負け、bet=引き分け返金）
   * @param jackpotCut 賭け額のうちジャックポットへ積む額（スロット等。胴元取り分から回す）
   * @param opts chain/fuku はソロゲーム既定ON。ルーレット等の共有卓はOFFにする
   */
  settle(
    userId: string,
    game: string,
    bet: number,
    payout: number,
    jackpotCut = 0,
    opts: { chain?: boolean; fuku?: boolean } = {},
  ): SettleResult {
    if (!Number.isInteger(bet) || bet <= 0) throw new EtherError("ERR_BAD_AMOUNT", { bet });
    if (!Number.isInteger(payout) || payout < 0) throw new EtherError("ERR_BAD_AMOUNT", { payout });
    const useChain = opts.chain ?? true;
    const useFuku = opts.fuku ?? true;
    return this.db.transaction((): SettleResult => {
      // 徴収
      this.ether.transfer(userId, HOUSE_HOLDER, bet);
      // 配当
      if (payout > 0) this.ether.transfer(HOUSE_HOLDER, userId, payout);

      const won = payout > bet;
      // 連鎖ボーナス: 「この勝ちで何連勝目か」= 現在の連勝 + 1（recordResult 前に読む）
      let chainBonus = 0;
      let chainStreak = 0;
      let chainMult = 1.0;
      let chainLabel = "";
      if (won && useChain) {
        chainStreak = this.stats(userId).current_win_streak + 1;
        const c = chainMultiplier(chainStreak);
        chainMult = c.mult;
        chainLabel = c.label;
        chainBonus = Math.min(Math.floor(payout * (c.mult - 1)), this.ether.balanceOf(HOUSE_HOLDER));
        if (chainBonus > 0) this.ether.transfer(HOUSE_HOLDER, userId, chainBonus);
      }

      // 福の重み: 勝ち利益（チェーン込み）への累進奉納。半分JP・半分救済
      let fukuTax = 0;
      let rate = 0;
      if (won && useFuku) {
        rate = fukuRate(this.ether.balanceOf(userId), this.fukuScale());
        fukuTax = Math.floor((payout - bet + chainBonus) * rate);
        if (fukuTax > 0) {
          const half = Math.floor(fukuTax / 2);
          if (half > 0) this.ether.transfer(userId, JACKPOT_HOLDER, half);
          if (fukuTax - half > 0) this.ether.transfer(userId, RELIEF_HOLDER, fukuTax - half);
        }
      }

      // JP積立（胴元から）
      if (jackpotCut > 0 && this.ether.balanceOf(HOUSE_HOLDER) >= jackpotCut) {
        this.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, jackpotCut);
      }
      const effectivePayout = payout + chainBonus - fukuTax;
      const net = effectivePayout - bet;
      this.recordResult(userId, bet, payout);
      this.events.log("casino_game", { actor: userId, payload: { game, bet, payout: effectivePayout, net, chainBonus, fukuTax } });
      return { wagered: bet, payout: effectivePayout, net, chainBonus, chainStreak, chainMult, chainLabel, fukuTax, fukuRate: rate };
    })();
  }

  /**
   * ジャックポット払い出し（当選）。
   * @param share 取れる割合（既定 1 = 全額。スロットは 0.5 = 半分獲得・半分シード残留）
   */
  seizeJackpot(userId: string, game: string, share = 1): number {
    return this.db.transaction((): number => {
      const pool = this.jackpotPool();
      const amount = Math.floor(pool * Math.min(1, Math.max(0, share)));
      if (amount <= 0) return 0;
      this.ether.transfer(JACKPOT_HOLDER, userId, amount);
      this.events.log("casino_jackpot", { actor: userId, payload: { game, amount, poolBefore: pool } });
      return amount;
    })();
  }

  /** 戦績更新。payout > bet で勝ち、payout < bet で負け、同額はノーカウント（引き分け） */
  private recordResult(userId: string, bet: number, payout: number): void {
    const ts = now();
    this.db
      .prepare("INSERT INTO casino_stats (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
      .run(userId, ts);
    const win = payout > bet ? 1 : 0;
    const loss = payout < bet ? 1 : 0;
    const netWin = Math.max(0, payout - bet);
    this.db
      .prepare(
        `UPDATE casino_stats SET
           games = games + 1,
           wins = wins + ?,
           losses = losses + ?,
           total_wagered = total_wagered + ?,
           total_earned = total_earned + ?,
           biggest_win = MAX(biggest_win, ?),
           current_win_streak = CASE WHEN ? = 1 THEN current_win_streak + 1 WHEN ? = 1 THEN 0 ELSE current_win_streak END,
           current_lose_streak = CASE WHEN ? = 1 THEN current_lose_streak + 1 WHEN ? = 1 THEN 0 ELSE current_lose_streak END,
           updated_at = ?
         WHERE user_id = ?`,
      )
      .run(win, loss, bet, netWin, netWin, win, loss, loss, win, ts, userId);
    this.db
      .prepare("UPDATE casino_stats SET best_win_streak = MAX(best_win_streak, current_win_streak) WHERE user_id = ?")
      .run(userId);
  }

  stats(userId: string): CasinoStatsRow {
    const row = this.db.prepare("SELECT * FROM casino_stats WHERE user_id = ?").get(userId) as CasinoStatsRow | undefined;
    return (
      row ?? {
        user_id: userId,
        games: 0,
        wins: 0,
        losses: 0,
        total_wagered: 0,
        total_earned: 0,
        biggest_win: 0,
        current_win_streak: 0,
        best_win_streak: 0,
        current_lose_streak: 0,
        updated_at: 0,
      }
    );
  }

  /** 賭場番付用: 指標別 Top N */
  top(
    metric: "balance" | "biggest_win" | "total_earned" | "total_wagered" | "best_win_streak" | "win_rate",
    limit = 10,
  ): Array<{ user_id: string; value: number; sub?: number }> {
    if (metric === "balance") {
      return this.db
        .prepare(
          `SELECT user_id, amount AS value FROM ether_balances
           WHERE user_id NOT IN (?, ?, ?) AND amount > 0
           ORDER BY amount DESC LIMIT ?`,
        )
        .all(HOUSE_HOLDER, JACKPOT_HOLDER, RELIEF_HOLDER, limit) as Array<{ user_id: string; value: number }>;
    }
    if (metric === "win_rate") {
      return this.db
        .prepare(
          `SELECT user_id, CAST(wins AS REAL) * 100 / games AS value, games AS sub
           FROM casino_stats WHERE games >= 10
           ORDER BY value DESC LIMIT ?`,
        )
        .all(limit) as Array<{ user_id: string; value: number; sub: number }>;
    }
    return this.db
      .prepare(`SELECT user_id, ${metric} AS value FROM casino_stats WHERE ${metric} > 0 ORDER BY value DESC LIMIT ?`)
      .all(limit) as Array<{ user_id: string; value: number }>;
  }
}
