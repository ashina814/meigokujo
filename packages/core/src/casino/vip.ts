import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "./exchange.js";

/**
 * マモンの賭場 VIP会員（月額エテル制）。casino-bot /vip のシンプル版。
 * - 加入: 月会費エテル支払い → VIP_DAYS 日間 VIP
 * - 既加入者が更新: 現在の期限に日数を加算
 * - 特権: 賭け上限×2（各ゲーム側は effectiveBetCap() を参照）・VIP ロール自動付与
 * - 期限切れは sweepExpired() で自動失効（bot 側でロール剥奪）
 */
const now = () => Math.floor(Date.now() / 1000);
const DAY_SEC = 86_400;

export interface VipOptions {
  price?: number | (() => number);
  days?: number | (() => number);
  betCapMult?: number | (() => number);
}

export type VipJoinResult =
  | { ok: true; expiresAt: number; wasExtension: boolean }
  | { ok: false; reason: "INSUFFICIENT_ETHER" };

export class Vip {
  private readonly priceOpt: number | (() => number);
  private readonly daysOpt: number | (() => number);
  private readonly capMultOpt: number | (() => number);

  constructor(
    private readonly db: Database.Database,
    private readonly ether: EtherExchange,
    private readonly events: EventLog,
    options: VipOptions = {},
  ) {
    this.priceOpt = options.price ?? 30_000;
    this.daysOpt = options.days ?? 30;
    this.capMultOpt = options.betCapMult ?? 2;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_vip (
        user_id    TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  price(): number {
    const v = typeof this.priceOpt === "function" ? this.priceOpt() : this.priceOpt;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 30_000;
  }
  days(): number {
    const v = typeof this.daysOpt === "function" ? this.daysOpt() : this.daysOpt;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 30;
  }
  betCapMult(): number {
    const v = typeof this.capMultOpt === "function" ? this.capMultOpt() : this.capMultOpt;
    return Number.isFinite(v) && v > 0 ? v : 2;
  }

  isVip(userId: string): boolean {
    const row = this.db.prepare("SELECT expires_at FROM casino_vip WHERE user_id = ?").get(userId) as { expires_at: number } | undefined;
    return !!row && row.expires_at > now();
  }

  expiresAt(userId: string): number {
    const row = this.db.prepare("SELECT expires_at FROM casino_vip WHERE user_id = ?").get(userId) as { expires_at: number } | undefined;
    return row?.expires_at ?? 0;
  }

  daysLeft(userId: string): number {
    const e = this.expiresAt(userId);
    if (e <= now()) return 0;
    return Math.ceil((e - now()) / DAY_SEC);
  }

  /** 加入 or 更新。エテル徴収 → 期限延長 */
  join(userId: string): VipJoinResult {
    const price = this.price();
    if (this.ether.balanceOf(userId) < price) return { ok: false, reason: "INSUFFICIENT_ETHER" };
    return this.db.transaction((): VipJoinResult => {
      this.ether.transfer(userId, HOUSE_HOLDER, price);
      const t = now();
      const current = this.expiresAt(userId);
      const base = current > t ? current : t;
      const newExpires = base + this.days() * DAY_SEC;
      this.db
        .prepare(
          `INSERT INTO casino_vip (user_id, expires_at) VALUES (?, ?)
           ON CONFLICT(user_id) DO UPDATE SET expires_at = excluded.expires_at`,
        )
        .run(userId, newExpires);
      this.events.log("casino_vip_join", { actor: userId, payload: { price, days: this.days(), expiresAt: newExpires, extension: current > t } });
      return { ok: true, expiresAt: newExpires, wasExtension: current > t };
    })();
  }

  /** 期限切れの一覧（bot 側でロール剥奪用） */
  expired(): string[] {
    const t = now();
    return (this.db.prepare("SELECT user_id FROM casino_vip WHERE expires_at <= ?").all(t) as Array<{ user_id: string }>).map((r) => r.user_id);
  }

  /** 期限切れをテーブルから削除（ロール剥奪後に呼ぶ） */
  clearExpired(userIds: string[]): void {
    if (userIds.length === 0) return;
    const stmt = this.db.prepare("DELETE FROM casino_vip WHERE user_id = ? AND expires_at <= ?");
    const t = now();
    this.db.transaction(() => {
      for (const u of userIds) stmt.run(u, t);
    })();
  }
}
