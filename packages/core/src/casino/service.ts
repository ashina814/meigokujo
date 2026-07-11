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
  /** 受け取った配当（0 = 負け） */
  payout: number;
  /** 純損益 */
  net: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class Casino {
  constructor(
    private readonly db: Database.Database,
    readonly ether: EtherExchange,
    private readonly events: EventLog,
  ) {
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

  /**
   * 1ゲームの精算（ソロゲーム用）。
   * 賭け額を徴収→配当を支払い、戦績を更新する。原子的に行う。
   * @param payout 配当（賭け額込みの受取総額。0=負け、bet=引き分け返金）
   * @param jackpotCut 賭け額のうちジャックポットへ積む額（スロット等。胴元取り分から回す）
   */
  settle(userId: string, game: string, bet: number, payout: number, jackpotCut = 0): SettleResult {
    if (!Number.isInteger(bet) || bet <= 0) throw new EtherError("ERR_BAD_AMOUNT", { bet });
    if (!Number.isInteger(payout) || payout < 0) throw new EtherError("ERR_BAD_AMOUNT", { payout });
    return this.db.transaction((): SettleResult => {
      // 徴収
      this.ether.transfer(userId, HOUSE_HOLDER, bet);
      // 配当
      if (payout > 0) this.ether.transfer(HOUSE_HOLDER, userId, payout);
      // JP積立（胴元から）
      if (jackpotCut > 0 && this.ether.balanceOf(HOUSE_HOLDER) >= jackpotCut) {
        this.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, jackpotCut);
      }
      const net = payout - bet;
      this.recordResult(userId, bet, payout);
      this.events.log("casino_game", { actor: userId, payload: { game, bet, payout, net } });
      return { wagered: bet, payout, net };
    })();
  }

  /** ジャックポット払い出し（当選）。積立全額を当選者へ */
  seizeJackpot(userId: string, game: string): number {
    return this.db.transaction((): number => {
      const pool = this.jackpotPool();
      if (pool <= 0) return 0;
      this.ether.transfer(JACKPOT_HOLDER, userId, pool);
      this.events.log("casino_jackpot", { actor: userId, payload: { game, amount: pool } });
      return pool;
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
           WHERE user_id NOT IN (?, ?) AND amount > 0
           ORDER BY amount DESC LIMIT ?`,
        )
        .all(HOUSE_HOLDER, JACKPOT_HOLDER, limit) as Array<{ user_id: string; value: number }>;
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
