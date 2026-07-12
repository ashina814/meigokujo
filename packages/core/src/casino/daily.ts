import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "./exchange.js";
import { RELIEF_HOLDER } from "./service.js";

/**
 * マモンの福分け（デイリーボーナス）。
 * - 24時間に1回受け取れる
 * - 基本額 + 連続日数ボーナス（7日ごとに +50◈、最大 +200◈）
 * - 残高が少ないユーザは救済プール（fukuの半分が溜まる場所）から追加支給
 * - 資金源: 基本額と streak ボーナスは胴元(house)から。救済分は relief から
 *   胴元が空なら基本ぶんも救済プールにフォールバック
 */

export interface DailyClaim {
  base: number;
  streakBonus: number;
  relief: number;
  total: number;
  streak: number;
  isConsecutive: boolean;
}

export type DailyClaimResult = { ok: true; claim: DailyClaim } | { ok: false; reason: "ALREADY_CLAIMED"; nextClaimAt: number };

export interface DailyOptions {
  /** 基本額。関数なら毎回評価 = 設定変更が即反映 */
  base?: number | (() => number);
  /** 救済しきい値: 所持エテル ≤ この額なら救済発動。関数なら毎回評価 */
  reliefThreshold?: number | (() => number);
  /** 救済 1回の最大額 */
  reliefMax?: number | (() => number);
}

const now = () => Math.floor(Date.now() / 1000);
const DAY_SEC = 86_400;
const STREAK_STEP = 50;
const STREAK_CAP = 200;

export class Daily {
  private readonly baseOpt: number | (() => number);
  private readonly reliefThresholdOpt: number | (() => number);
  private readonly reliefMaxOpt: number | (() => number);

  constructor(
    private readonly db: Database.Database,
    private readonly ether: EtherExchange,
    private readonly events: EventLog,
    options: DailyOptions = {},
  ) {
    this.baseOpt = options.base ?? 1_000;
    this.reliefThresholdOpt = options.reliefThreshold ?? 10_000;
    this.reliefMaxOpt = options.reliefMax ?? 500;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_daily (
        user_id     TEXT PRIMARY KEY,
        last_at     INTEGER NOT NULL,
        streak      INTEGER NOT NULL DEFAULT 1,
        total_taken INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private base(): number {
    const v = typeof this.baseOpt === "function" ? this.baseOpt() : this.baseOpt;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1_000;
  }
  private reliefThreshold(): number {
    const v = typeof this.reliefThresholdOpt === "function" ? this.reliefThresholdOpt() : this.reliefThresholdOpt;
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 10_000;
  }
  private reliefMax(): number {
    const v = typeof this.reliefMaxOpt === "function" ? this.reliefMaxOpt() : this.reliefMaxOpt;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 500;
  }

  /** 次に受け取れる時刻（unix秒）。まだ一度も受け取ってなければ 0 */
  nextClaimAt(userId: string): number {
    const row = this.db.prepare("SELECT last_at FROM casino_daily WHERE user_id = ?").get(userId) as { last_at: number } | undefined;
    return row ? row.last_at + DAY_SEC : 0;
  }

  currentStreak(userId: string): number {
    const row = this.db.prepare("SELECT streak, last_at FROM casino_daily WHERE user_id = ?").get(userId) as
      | { streak: number; last_at: number }
      | undefined;
    if (!row) return 0;
    // 連続判定は「前回受取から24時間以上48時間未満」= streak 継続
    const t = now();
    if (t - row.last_at >= 2 * DAY_SEC) return 0;
    return row.streak;
  }

  /**
   * 福分け受け取り。前回から24時間経過してなければ ALREADY_CLAIMED を返す。
   * 資金は胴元から支給、救済プールが自動追加される。胴元が空でも救済プールから
   * 出せる分は出す（賭場が閉じてても福分けは止まらない = 最低保証）。
   */
  claim(userId: string): DailyClaimResult {
    const t = now();
    const row = this.db.prepare("SELECT last_at, streak FROM casino_daily WHERE user_id = ?").get(userId) as
      | { last_at: number; streak: number }
      | undefined;
    if (row && t - row.last_at < DAY_SEC) {
      return { ok: false, reason: "ALREADY_CLAIMED", nextClaimAt: row.last_at + DAY_SEC };
    }
    const isConsecutive = !!row && t - row.last_at < 2 * DAY_SEC;
    const streak = isConsecutive ? row!.streak + 1 : 1;

    const base = this.base();
    const streakBonus = Math.min(Math.floor(streak / 7) * STREAK_STEP, STREAK_CAP);
    const held = this.ether.balanceOf(userId);
    const reliefEligible = held <= this.reliefThreshold();
    const reliefPool = this.ether.balanceOf(RELIEF_HOLDER);
    const relief = reliefEligible ? Math.min(this.reliefMax(), reliefPool) : 0;

    return this.db.transaction((): DailyClaimResult => {
      // 基本 + streak 分は胴元から。胴元不足なら救済プールから振替
      const wanted = base + streakBonus;
      const houseHas = this.ether.balanceOf(HOUSE_HOLDER);
      const fromHouse = Math.min(wanted, houseHas);
      if (fromHouse > 0) this.ether.transfer(HOUSE_HOLDER, userId, fromHouse);
      const shortfall = wanted - fromHouse;
      const fromReliefForBase = Math.min(shortfall, this.ether.balanceOf(RELIEF_HOLDER));
      if (fromReliefForBase > 0) this.ether.transfer(RELIEF_HOLDER, userId, fromReliefForBase);

      // 救済ボーナスは追加で救済プールから
      if (relief > 0) this.ether.transfer(RELIEF_HOLDER, userId, relief);

      const total = fromHouse + fromReliefForBase + relief;
      this.db
        .prepare(
          `INSERT INTO casino_daily (user_id, last_at, streak, total_taken)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET last_at = excluded.last_at, streak = excluded.streak, total_taken = casino_daily.total_taken + ?`,
        )
        .run(userId, t, streak, total, total);
      this.events.log("casino_daily", { actor: userId, payload: { base: fromHouse + fromReliefForBase, streakBonus, relief, streak } });
      return {
        ok: true,
        claim: {
          base: fromHouse + fromReliefForBase - Math.min(streakBonus, fromHouse + fromReliefForBase),
          streakBonus: Math.min(streakBonus, fromHouse + fromReliefForBase),
          relief,
          total,
          streak,
          isConsecutive,
        },
      };
    })();
  }
}
