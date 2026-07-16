import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherError, EtherExchange, HOUSE_HOLDER } from "./exchange.js";

/**
 * マモンの賭場の株式市場。casino-bot /株 のシンプル版移植。
 * - 銘柄マスタは固定 6 銘柄
 * - 価格は 1 時間ごとにランダムウォーク（trend でバイアス）
 * - 買い: 株価 × 株数 を胴元へ、holdings に加算（avg_cost 平均化）
 * - 売り: holdings から株数を引いて 株価 × 株数 を胴元から
 * - 保有上限日数（3日）を過ぎたら次の更新で強制売却（インフレ抑制）
 * - 総量保存（Land は動かない・エテル残高のみ移動）
 */
export const STOCK_HOLD_DAYS = 3;
/** 売却手数料（胴元の取り分）。ランダムウォークは期待値中立のため、これが唯一の胴元エッジ */
export const STOCK_SELL_FEE_RATE = 0.01;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1時間

export interface Stock {
  id: string;
  name: string;
  emoji: string;
  price: number;
  prev_price: number;
  trend: number;
  last_update: number; // unix秒
}

export interface Holding {
  user_id: string;
  stock_id: string;
  shares: number;
  avg_cost: number;
  bought_at: number;
}

/** 初期銘柄マスタ */
const INITIAL_STOCKS: Array<Omit<Stock, "price" | "prev_price" | "trend" | "last_update">> = [
  { id: "hone", name: "骸骨精鉱", emoji: "💀" },
  { id: "gou", name: "業火公社", emoji: "🔥" },
  { id: "kyou", name: "冥界通信", emoji: "📡" },
  { id: "sui", name: "冥水運輸", emoji: "🚢" },
  { id: "jou", name: "冥獄不動産", emoji: "🏚" },
  { id: "kan", name: "看破製薬", emoji: "🧪" },
];

const now = () => Math.floor(Date.now() / 1000);

export type StockErrorCode = "ERR_UNKNOWN_STOCK" | "ERR_INSUFFICIENT_ETHER" | "ERR_INSUFFICIENT_SHARES" | "ERR_BAD_AMOUNT";
export class StockError extends Error {
  constructor(readonly code: StockErrorCode, readonly meta: Record<string, unknown> = {}) {
    super(code);
    this.name = "StockError";
  }
}

export class Stocks {
  constructor(
    private readonly db: Database.Database,
    private readonly ether: EtherExchange,
    private readonly events: EventLog,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_stocks (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        emoji       TEXT NOT NULL,
        price       INTEGER NOT NULL DEFAULT 1000,
        prev_price  INTEGER NOT NULL DEFAULT 1000,
        trend       REAL NOT NULL DEFAULT 0,
        last_update INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS casino_holdings (
        user_id   TEXT NOT NULL,
        stock_id  TEXT NOT NULL,
        shares    INTEGER NOT NULL DEFAULT 0 CHECK(shares >= 0),
        avg_cost  INTEGER NOT NULL DEFAULT 0,
        bought_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, stock_id)
      );
    `);
    this.seed();
  }

  private seed(): void {
    const ts = now();
    for (const s of INITIAL_STOCKS) {
      this.db
        .prepare(
          "INSERT INTO casino_stocks (id, name, emoji, price, prev_price, trend, last_update) VALUES (?, ?, ?, 1000, 1000, 0, ?) ON CONFLICT(id) DO NOTHING",
        )
        .run(s.id, s.name, s.emoji, ts);
    }
  }

  list(): Stock[] {
    return this.db.prepare("SELECT * FROM casino_stocks ORDER BY id").all() as Stock[];
  }

  get(id: string): Stock | undefined {
    return this.db.prepare("SELECT * FROM casino_stocks WHERE id = ?").get(id) as Stock | undefined;
  }

  /**
   * 1時間ごとに呼ぶ更新tick。各銘柄の価格をランダムウォーク（trend でバイアス）で動かす。
   * 呼び側は scheduler 経由。
   */
  updateAll(): void {
    const ts = now();
    const stocks = this.list();
    for (const s of stocks) {
      if (ts - s.last_update < UPDATE_INTERVAL_MS / 1000) continue;
      // ランダムウォーク: ±10% + trend×5%
      const noise = (Math.random() * 2 - 1) * 0.1;
      const bias = s.trend * 0.05;
      const changePct = noise + bias;
      let newPrice = Math.max(100, Math.floor(s.price * (1 + changePct)));
      // trend は 0.6*前回 + 少しノイズ で寄せる（暴走防止）
      const newTrend = Math.max(-1, Math.min(1, s.trend * 0.6 + (Math.random() * 2 - 1) * 0.15));
      this.db
        .prepare("UPDATE casino_stocks SET prev_price = price, price = ?, trend = ?, last_update = ? WHERE id = ?")
        .run(newPrice, newTrend, ts, s.id);
    }
  }

  /** 保有上限日を超えた保有株を強制売却（価格は現在値）。scheduler tick で呼ぶ */
  forceSellExpired(): Array<{ userId: string; stockId: string; shares: number; proceeds: number }> {
    const ts = now();
    const expireBefore = ts - STOCK_HOLD_DAYS * 86_400;
    const rows = this.db
      .prepare("SELECT * FROM casino_holdings WHERE shares > 0 AND bought_at < ? AND bought_at > 0")
      .all(expireBefore) as Holding[];
    const results: Array<{ userId: string; stockId: string; shares: number; proceeds: number }> = [];
    for (const h of rows) {
      const s = this.get(h.stock_id);
      if (!s) continue;
      const proceeds = Math.floor(s.price * h.shares * (1 - STOCK_SELL_FEE_RATE));
      // 胴元が払えないなら没収せず保留（次の tick で再試行）。株だけ消すと実質没収になる
      if (this.ether.balanceOf(HOUSE_HOLDER) < proceeds) continue;
      this.db.transaction(() => {
        this.ether.transfer(HOUSE_HOLDER, h.user_id, proceeds);
        this.db
          .prepare("UPDATE casino_holdings SET shares = 0, avg_cost = 0, bought_at = 0 WHERE user_id = ? AND stock_id = ?")
          .run(h.user_id, h.stock_id);
      })();
      this.events.log("stock_force_sell", { actor: h.user_id, payload: { stockId: h.stock_id, shares: h.shares, proceeds } });
      results.push({ userId: h.user_id, stockId: h.stock_id, shares: h.shares, proceeds });
    }
    return results;
  }

  /** 株を買う */
  buy(userId: string, stockId: string, shares: number): { cost: number; avgCost: number; newShares: number } {
    if (!Number.isInteger(shares) || shares <= 0) throw new StockError("ERR_BAD_AMOUNT", { shares });
    const s = this.get(stockId);
    if (!s) throw new StockError("ERR_UNKNOWN_STOCK", { stockId });
    const cost = s.price * shares;
    if (this.ether.balanceOf(userId) < cost) throw new StockError("ERR_INSUFFICIENT_ETHER", { held: this.ether.balanceOf(userId), cost });
    return this.db.transaction((): { cost: number; avgCost: number; newShares: number } => {
      this.ether.transfer(userId, HOUSE_HOLDER, cost);
      const cur = this.db.prepare("SELECT * FROM casino_holdings WHERE user_id = ? AND stock_id = ?").get(userId, stockId) as Holding | undefined;
      const newShares = (cur?.shares ?? 0) + shares;
      const newAvgCost = cur && cur.shares > 0 ? Math.floor((cur.avg_cost * cur.shares + cost) / newShares) : s.price;
      // 保有期限は「最初に買った時点」から。買い増しでタイマーをリセットさせない
      const boughtAt = cur && cur.shares > 0 && cur.bought_at > 0 ? cur.bought_at : now();
      this.db
        .prepare(
          `INSERT INTO casino_holdings (user_id, stock_id, shares, avg_cost, bought_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, stock_id) DO UPDATE SET shares = excluded.shares, avg_cost = excluded.avg_cost, bought_at = excluded.bought_at`,
        )
        .run(userId, stockId, newShares, newAvgCost, boughtAt);
      this.events.log("stock_buy", { actor: userId, payload: { stockId, shares, cost, avgCost: newAvgCost } });
      return { cost, avgCost: newAvgCost, newShares };
    })();
  }

  /** 株を売る */
  sell(userId: string, stockId: string, shares: number): { proceeds: number; remaining: number } {
    if (!Number.isInteger(shares) || shares <= 0) throw new StockError("ERR_BAD_AMOUNT", { shares });
    const s = this.get(stockId);
    if (!s) throw new StockError("ERR_UNKNOWN_STOCK", { stockId });
    const cur = this.db.prepare("SELECT * FROM casino_holdings WHERE user_id = ? AND stock_id = ?").get(userId, stockId) as Holding | undefined;
    if (!cur || cur.shares < shares) throw new StockError("ERR_INSUFFICIENT_SHARES", { held: cur?.shares ?? 0, shares });
    const proceeds = Math.floor(s.price * shares * (1 - STOCK_SELL_FEE_RATE));
    // 胴元が払えないなら売却自体を拒否（株だけ消して支払わない、を防ぐ）
    if (proceeds > 0 && this.ether.balanceOf(HOUSE_HOLDER) < proceeds) {
      throw new StockError("ERR_INSUFFICIENT_ETHER", { house: this.ether.balanceOf(HOUSE_HOLDER), proceeds });
    }
    return this.db.transaction((): { proceeds: number; remaining: number } => {
      if (proceeds > 0) this.ether.transfer(HOUSE_HOLDER, userId, proceeds);
      const remaining = cur.shares - shares;
      if (remaining === 0) {
        this.db
          .prepare("UPDATE casino_holdings SET shares = 0, avg_cost = 0, bought_at = 0 WHERE user_id = ? AND stock_id = ?")
          .run(userId, stockId);
      } else {
        this.db
          .prepare("UPDATE casino_holdings SET shares = ? WHERE user_id = ? AND stock_id = ?")
          .run(remaining, userId, stockId);
      }
      this.events.log("stock_sell", { actor: userId, payload: { stockId, shares, proceeds } });
      return { proceeds, remaining };
    })();
  }


  holdings(userId: string): Array<Holding & { stock: Stock }> {
    const rows = this.db
      .prepare("SELECT * FROM casino_holdings WHERE user_id = ? AND shares > 0")
      .all(userId) as Holding[];
    return rows
      .map((h) => {
        const s = this.get(h.stock_id);
        return s ? { ...h, stock: s } : null;
      })
      .filter((x): x is Holding & { stock: Stock } => x !== null);
  }
}
