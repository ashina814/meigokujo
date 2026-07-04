import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";

/**
 * 魂株市場（世界構想マップ「住人に投資、昇格で配当、迷霊落ちで紙くず」）。
 * 板・約定エンジンは重いので bonding-curve AMM で実装する。各魂に線形の株価曲線
 * price(k) = base + step*k を持たせ、買い＝住人→エスクロー、売り＝エスクロー→住人。
 * 曲線が対称なのでエスクローは常に「全株の買い取り原資」= priceSum(0,shares) を保つ（solvent）。
 *
 *   昇格: base を bonus 上げ、国庫が bonus*shares をエスクローへ注入（stock_dividend）
 *         → 既存株主の含み益。これが「昇格で配当」の資金的裏付け。
 *   迷霊落ち/去りし魂: 廃止。エスクロー残を国庫へ没収（stock_delist）、株主は紙くず。
 */
export const MARKET_ESCROW = "sys:escrow:market";
const MARKET_APPROVER = "system:market";

export type StockErrorCode =
  | "ERR_STOCK_NOT_FOUND"
  | "ERR_STOCK_DELISTED"
  | "ERR_STOCK_EXISTS"
  | "ERR_BAD_QTY"
  | "ERR_NO_SHARES";

export class StockError extends Error {
  constructor(
    readonly code: StockErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "StockError";
  }
}

export interface StockRow {
  subject_id: string;
  base_price: number;
  step: number;
  promotion_bonus: number;
  shares: number;
  escrow: number;
  status: "listed" | "delisted";
  promotion_credited: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface TradeResult {
  stock: StockRow;
  qty: number;
  cash: number; // 買い=支払い / 売り=受取り
  newPrice: number;
}

export interface Holding {
  subject_id: string;
  shares: number;
  status: StockRow["status"];
  price: number; // 現在株価
  value: number; // 今売った場合の受取り（廃止なら0）
}

export interface StatusChange {
  subjectId: string;
  kind: "promoted" | "delisted";
  reclaimed?: number; // 廃止で国庫回収した額
}

const now = () => Math.floor(Date.now() / 1000);

/** Σ_{k=start}^{start+n-1} (base + step*k) */
function priceSum(base: number, step: number, start: number, n: number): number {
  return n * base + step * (n * start + (n * (n - 1)) / 2);
}

export class Stocks {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
  ) {
    this.ledger.ensureAccount(MARKET_ESCROW, "system");
  }

  get(subjectId: string): StockRow | undefined {
    return this.db.prepare("SELECT * FROM stocks WHERE subject_id = ?").get(subjectId) as StockRow | undefined;
  }
  private require(subjectId: string): StockRow {
    const s = this.get(subjectId);
    if (!s) throw new StockError("ERR_STOCK_NOT_FOUND", { subjectId });
    return s;
  }
  listListed(): StockRow[] {
    return this.db.prepare("SELECT * FROM stocks WHERE status = 'listed' ORDER BY base_price + step * shares DESC").all() as StockRow[];
  }

  /** 現在株価（次の1株の価格） */
  price(s: StockRow): number {
    return s.base_price + s.step * s.shares;
  }

  /** 上場。既に上場済み（listed）なら拒否。廃止済みは再上場で作り直す */
  list(subjectId: string, args: { basePrice?: number; step?: number; promotionBonus?: number; createdBy: string }): StockRow {
    const existing = this.get(subjectId);
    if (existing?.status === "listed") throw new StockError("ERR_STOCK_EXISTS", { subjectId });
    const base = Math.max(1, Math.floor(args.basePrice ?? 1_000));
    const step = Math.max(0, Math.floor(args.step ?? 100));
    const bonus = Math.max(0, Math.floor(args.promotionBonus ?? 5_000));
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO stocks (subject_id, base_price, step, promotion_bonus, shares, escrow, status, promotion_credited, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, 'listed', 0, ?, ?, ?)
         ON CONFLICT(subject_id) DO UPDATE SET
           base_price = excluded.base_price, step = excluded.step, promotion_bonus = excluded.promotion_bonus,
           shares = 0, escrow = 0, status = 'listed', promotion_credited = 0, updated_at = excluded.updated_at`,
      )
      .run(subjectId, base, step, bonus, args.createdBy, ts, ts);
    // 再上場時に古い保有をクリア（前回の紙くずを持ち越さない）
    this.db.prepare("DELETE FROM stock_holdings WHERE subject_id = ?").run(subjectId);
    this.events.log("stock_listed", { actor: args.createdBy, target: subjectId, payload: { base, step } });
    return this.get(subjectId)!;
  }

  buy(subjectId: string, holderId: string, qty: number, idempotencyKey: string): TradeResult {
    const s = this.require(subjectId);
    if (s.status !== "listed") throw new StockError("ERR_STOCK_DELISTED", { subjectId });
    if (!Number.isInteger(qty) || qty <= 0 || qty > 100_000) throw new StockError("ERR_BAD_QTY", { qty });
    const cost = priceSum(s.base_price, s.step, s.shares, qty);
    const ts = now();
    return this.db.transaction((): TradeResult => {
      this.ledger.ensureAccount(`user:${holderId}`, "user");
      this.ledger.transfer({
        from: `user:${holderId}`, to: MARKET_ESCROW, amount: cost, type: "stock_buy", actor: `user:${holderId}`,
        approvedBy: MARKET_APPROVER, reason: `魂株 買い ${qty}株`, refType: "stock", refId: subjectId, idempotencyKey,
      });
      this.db.prepare("UPDATE stocks SET shares = shares + ?, escrow = escrow + ?, updated_at = ? WHERE subject_id = ?").run(qty, cost, ts, subjectId);
      this.db
        .prepare(`INSERT INTO stock_holdings (subject_id, holder_id, shares, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(subject_id, holder_id) DO UPDATE SET shares = shares + excluded.shares, updated_at = excluded.updated_at`)
        .run(subjectId, holderId, qty, ts);
      this.events.log("stock_buy", { actor: holderId, target: subjectId, payload: { qty, cost } });
      const ns = this.get(subjectId)!;
      return { stock: ns, qty, cash: cost, newPrice: this.price(ns) };
    })();
  }

  sharesOf(subjectId: string, holderId: string): number {
    const row = this.db.prepare("SELECT shares FROM stock_holdings WHERE subject_id = ? AND holder_id = ?").get(subjectId, holderId) as { shares: number } | undefined;
    return row?.shares ?? 0;
  }

  sell(subjectId: string, holderId: string, qty: number, idempotencyKey: string): TradeResult {
    const s = this.require(subjectId);
    if (s.status !== "listed") throw new StockError("ERR_STOCK_DELISTED", { subjectId });
    if (!Number.isInteger(qty) || qty <= 0) throw new StockError("ERR_BAD_QTY", { qty });
    const held = this.sharesOf(subjectId, holderId);
    if (held < qty) throw new StockError("ERR_NO_SHARES", { held, qty });
    const proceeds = priceSum(s.base_price, s.step, s.shares - qty, qty);
    const ts = now();
    return this.db.transaction((): TradeResult => {
      this.ledger.transfer({
        from: MARKET_ESCROW, to: `user:${holderId}`, amount: proceeds, type: "stock_sell", actor: `user:${holderId}`,
        approvedBy: MARKET_APPROVER, reason: `魂株 売り ${qty}株`, refType: "stock", refId: subjectId, idempotencyKey,
      });
      this.db.prepare("UPDATE stocks SET shares = shares - ?, escrow = escrow - ?, updated_at = ? WHERE subject_id = ?").run(qty, proceeds, ts, subjectId);
      this.db.prepare("UPDATE stock_holdings SET shares = shares - ?, updated_at = ? WHERE subject_id = ? AND holder_id = ?").run(qty, ts, subjectId, holderId);
      this.events.log("stock_sell", { actor: holderId, target: subjectId, payload: { qty, proceeds } });
      const ns = this.get(subjectId)!;
      return { stock: ns, qty, cash: proceeds, newPrice: this.price(ns) };
    })();
  }

  /** 昇格反映: base を bonus 上げ、国庫が bonus*shares をエスクローへ注入（含み益の裏付け） */
  applyPromotion(subjectId: string, actor: string): boolean {
    const s = this.get(subjectId);
    if (!s || s.status !== "listed" || s.promotion_credited) return false;
    const ts = now();
    this.db.transaction(() => {
      const dividend = s.promotion_bonus * s.shares;
      if (dividend > 0) {
        this.ledger.transfer({
          from: TREASURY, to: MARKET_ESCROW, amount: dividend, type: "stock_dividend", actor,
          approvedBy: MARKET_APPROVER, reason: `魂株 昇格配当`, refType: "stock", refId: subjectId, idempotencyKey: `stock-div:${subjectId}`,
        });
      }
      this.db.prepare("UPDATE stocks SET base_price = base_price + ?, escrow = escrow + ?, promotion_credited = 1, updated_at = ? WHERE subject_id = ?").run(s.promotion_bonus, dividend, ts, subjectId);
      this.events.log("stock_promoted", { actor, target: subjectId, payload: { bonus: s.promotion_bonus, dividend } });
    })();
    return true;
  }

  /** 廃止（紙くず）: エスクロー残を国庫へ没収。株主の保有は無価値になる */
  delist(subjectId: string, actor: string): number {
    const s = this.require(subjectId);
    if (s.status !== "listed") return 0;
    const ts = now();
    return this.db.transaction((): number => {
      const reclaimed = s.escrow;
      if (reclaimed > 0) {
        this.ledger.transfer({
          from: MARKET_ESCROW, to: TREASURY, amount: reclaimed, type: "stock_delist", actor,
          approvedBy: MARKET_APPROVER, reason: `魂株 廃止・回収`, refType: "stock", refId: subjectId, idempotencyKey: `stock-delist:${subjectId}:${ts}`,
        });
      }
      this.db.prepare("UPDATE stocks SET status = 'delisted', escrow = 0, updated_at = ? WHERE subject_id = ?").run(ts, subjectId);
      this.events.log("stock_delisted", { actor, target: subjectId, payload: { reclaimed } });
      return reclaimed;
    })();
  }

  /** 対象魂の状態に合わせて市場を同期。昇格→配当、迷霊/去りし魂→廃止。変化を返す */
  syncStatuses(): StatusChange[] {
    const changes: StatusChange[] = [];
    for (const s of this.listListed()) {
      const soul = this.db.prepare("SELECT status FROM souls WHERE user_id = ?").get(s.subject_id) as { status: string } | undefined;
      const st = soul?.status;
      if (st === "meirei" || st === "departed") {
        const reclaimed = this.delist(s.subject_id, "system:market");
        changes.push({ subjectId: s.subject_id, kind: "delisted", reclaimed });
      } else if (st === "majin" && !s.promotion_credited) {
        if (this.applyPromotion(s.subject_id, "system:market")) changes.push({ subjectId: s.subject_id, kind: "promoted" });
      }
    }
    return changes;
  }

  /** 保有一覧（廃止銘柄は value=0） */
  portfolio(holderId: string): Holding[] {
    const rows = this.db.prepare("SELECT subject_id, shares FROM stock_holdings WHERE holder_id = ? AND shares > 0").all(holderId) as Array<{ subject_id: string; shares: number }>;
    return rows.map((h) => {
      const s = this.get(h.subject_id)!;
      const value = s.status === "listed" ? priceSum(s.base_price, s.step, s.shares - h.shares, h.shares) : 0;
      return { subject_id: h.subject_id, shares: h.shares, status: s.status, price: this.price(s), value };
    });
  }

  /** その銘柄の株主上位 */
  holders(subjectId: string, limit = 10): Array<{ holder_id: string; shares: number }> {
    return this.db.prepare("SELECT holder_id, shares FROM stock_holdings WHERE subject_id = ? AND shares > 0 ORDER BY shares DESC LIMIT ?").all(subjectId, limit) as Array<{ holder_id: string; shares: number }>;
  }
}
