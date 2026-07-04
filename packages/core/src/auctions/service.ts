import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";

/**
 * 冥界競売（経済設計.md §5 エスクロー / 世界構想マップ「最強の回収装置」）。
 * 昇り入札(English auction)。現在の最高額だけをエスクローに預り、上書きされたら
 * 前の最高額者へ自動返金。締切で最高額を国庫へ回収（settle）＝通貨供給の回収装置。
 *
 *   入札:   user → sys:escrow:auction        (auction_bid)
 *   上書き: sys:escrow:auction → 前点者        (auction_refund, 自動)
 *   落札:   sys:escrow:auction → sys:treasury  (auction_settle = 回収)
 */
export const AUCTION_ESCROW = "sys:escrow:auction";
/** 競売の台帳操作は自動処理として承認閾値を通す（預り金の移動で対人リスクなし） */
const AUCTION_APPROVER = "system:auction";

export type AuctionErrorCode =
  | "ERR_AUCTION_NOT_FOUND"
  | "ERR_AUCTION_CLOSED"
  | "ERR_AUCTION_ENDED"
  | "ERR_BID_TOO_LOW"
  | "ERR_ALREADY_TOP";

export class AuctionError extends Error {
  constructor(
    readonly code: AuctionErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "AuctionError";
  }
}

export interface AuctionRow {
  id: number;
  title: string;
  description: string | null;
  start_price: number;
  min_increment: number;
  current_bid: number | null;
  current_bidder: string | null;
  status: "open" | "closed" | "cancelled";
  channel_id: string | null;
  message_id: string | null;
  ends_at: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface BidResult {
  auction: AuctionRow;
  /** 上書きで返金された前の最高額者（いなければ null） */
  refundedBidder: string | null;
  refundedAmount: number;
}

export interface CloseResult {
  auction: AuctionRow;
  winnerId: string | null;
  amount: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class Auctions {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
  ) {
    this.ledger.ensureAccount(AUCTION_ESCROW, "system");
  }

  create(args: {
    title: string;
    description?: string;
    startPrice: number;
    minIncrement?: number;
    endsAt: number;
    createdBy: string;
  }): AuctionRow {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO auctions (title, description, start_price, min_increment, ends_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.title.slice(0, 100),
        args.description?.slice(0, 500) ?? null,
        Math.max(0, Math.floor(args.startPrice)),
        Math.max(1, Math.floor(args.minIncrement ?? 1)),
        args.endsAt,
        args.createdBy,
        ts,
        ts,
      );
    const row = this.get(Number(info.lastInsertRowid))!;
    this.events.log("auction_opened", { actor: args.createdBy, payload: { id: row.id, title: row.title } });
    return row;
  }

  get(id: number): AuctionRow | undefined {
    return this.db.prepare("SELECT * FROM auctions WHERE id = ?").get(id) as AuctionRow | undefined;
  }

  private require(id: number): AuctionRow {
    const a = this.get(id);
    if (!a) throw new AuctionError("ERR_AUCTION_NOT_FOUND", { id });
    return a;
  }

  listOpen(): AuctionRow[] {
    return this.db
      .prepare("SELECT * FROM auctions WHERE status = 'open' ORDER BY ends_at")
      .all() as AuctionRow[];
  }

  /** 締切時刻を過ぎたのに open のままの競売（scheduler が締める） */
  listExpired(atTs: number = now()): AuctionRow[] {
    return this.db
      .prepare("SELECT * FROM auctions WHERE status = 'open' AND ends_at <= ? ORDER BY ends_at")
      .all(atTs) as AuctionRow[];
  }

  bidCount(id: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM auction_bids WHERE auction_id = ?").get(id) as { c: number }).c;
  }

  /** 次に必要な最低入札額 */
  minNextBid(a: AuctionRow): number {
    return a.current_bid === null ? a.start_price : a.current_bid + a.min_increment;
  }

  setPanel(id: number, channelId: string, messageId: string): void {
    this.db.prepare("UPDATE auctions SET channel_id = ?, message_id = ?, updated_at = ? WHERE id = ?").run(channelId, messageId, now(), id);
  }

  /**
   * 入札。現最高額を上書きしたら前点者へ自動返金する。
   * 先に新入札をエスクローへ入れてから前点者へ返す（エスクロー非負を保つ）。
   */
  bid(args: { auctionId: number; bidderId: string; amount: number; idempotencyKey: string }): BidResult {
    const a = this.require(args.auctionId);
    if (a.status !== "open") throw new AuctionError("ERR_AUCTION_CLOSED", { id: a.id });
    if (a.ends_at <= now()) throw new AuctionError("ERR_AUCTION_ENDED", { id: a.id });
    if (a.current_bidder === args.bidderId) throw new AuctionError("ERR_ALREADY_TOP", { id: a.id });

    const minBid = this.minNextBid(a);
    if (!Number.isSafeInteger(args.amount) || args.amount < minBid) {
      throw new AuctionError("ERR_BID_TOO_LOW", { id: a.id, min: minBid, amount: args.amount });
    }

    const ts = now();
    const run = this.db.transaction((): BidResult => {
      // 1) 新入札をエスクローへ
      this.ledger.ensureAccount(`user:${args.bidderId}`, "user");
      this.ledger.transfer({
        from: `user:${args.bidderId}`,
        to: AUCTION_ESCROW,
        amount: args.amount,
        type: "auction_bid",
        actor: `user:${args.bidderId}`,
        approvedBy: AUCTION_APPROVER,
        reason: `競売#${a.id} 入札`,
        refType: "auction",
        refId: String(a.id),
        idempotencyKey: args.idempotencyKey,
      });

      // 2) 前の最高額者へ返金
      let refundedBidder: string | null = null;
      let refundedAmount = 0;
      if (a.current_bidder && a.current_bid) {
        this.ledger.transfer({
          from: AUCTION_ESCROW,
          to: `user:${a.current_bidder}`,
          amount: a.current_bid,
          type: "auction_refund",
          actor: AUCTION_APPROVER,
          approvedBy: AUCTION_APPROVER,
          reason: `競売#${a.id} 上書き返金`,
          refType: "auction",
          refId: String(a.id),
          idempotencyKey: `auc-refund:${a.id}:${a.current_bidder}:${a.current_bid}:${ts}`,
        });
        refundedBidder = a.current_bidder;
        refundedAmount = a.current_bid;
      }

      // 3) 最高額を更新・履歴記録
      this.db
        .prepare("UPDATE auctions SET current_bid = ?, current_bidder = ?, updated_at = ? WHERE id = ?")
        .run(args.amount, args.bidderId, ts, a.id);
      this.db
        .prepare("INSERT INTO auction_bids (auction_id, bidder_id, amount, created_at) VALUES (?, ?, ?, ?)")
        .run(a.id, args.bidderId, args.amount, ts);
      this.events.log("auction_bid", { actor: args.bidderId, payload: { id: a.id, amount: args.amount } });

      return { auction: this.get(a.id)!, refundedBidder, refundedAmount };
    });
    return run();
  }

  /** 締切（時間切れ／運営の手動締切）。最高額を国庫へ回収して落札者を返す */
  close(auctionId: number, actor: string): CloseResult {
    const a = this.require(auctionId);
    if (a.status !== "open") throw new AuctionError("ERR_AUCTION_CLOSED", { id: a.id });
    const ts = now();
    const run = this.db.transaction((): CloseResult => {
      if (a.current_bidder && a.current_bid) {
        this.ledger.transfer({
          from: AUCTION_ESCROW,
          to: TREASURY,
          amount: a.current_bid,
          type: "auction_settle",
          actor,
          approvedBy: AUCTION_APPROVER,
          reason: `競売#${a.id} 落札`,
          refType: "auction",
          refId: String(a.id),
          idempotencyKey: `auc-settle:${a.id}`,
        });
      }
      this.db.prepare("UPDATE auctions SET status = 'closed', updated_at = ? WHERE id = ?").run(ts, a.id);
      this.events.log("auction_closed", {
        actor,
        target: a.current_bidder ?? undefined,
        payload: { id: a.id, amount: a.current_bid ?? 0 },
      });
      return { auction: this.get(a.id)!, winnerId: a.current_bidder, amount: a.current_bid ?? 0 };
    });
    return run();
  }

  /** 取消。最高額者がいれば返金してから cancelled にする（回収しない） */
  cancel(auctionId: number, actor: string): AuctionRow {
    const a = this.require(auctionId);
    if (a.status !== "open") throw new AuctionError("ERR_AUCTION_CLOSED", { id: a.id });
    const ts = now();
    const run = this.db.transaction((): AuctionRow => {
      if (a.current_bidder && a.current_bid) {
        this.ledger.transfer({
          from: AUCTION_ESCROW,
          to: `user:${a.current_bidder}`,
          amount: a.current_bid,
          type: "auction_refund",
          actor,
          approvedBy: AUCTION_APPROVER,
          reason: `競売#${a.id} 取消返金`,
          refType: "auction",
          refId: String(a.id),
          idempotencyKey: `auc-cancel:${a.id}`,
        });
      }
      this.db.prepare("UPDATE auctions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(ts, a.id);
      this.events.log("auction_cancelled", { actor, payload: { id: a.id } });
      return this.get(a.id)!;
    });
    return run();
  }
}
