import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { Settings } from "../settings/service.js";
import { EventLog } from "../events/service.js";

/**
 * 輪廻籤（経済設計.md §5 / 世界構想マップ「週1宝くじ+キャリーオーバー」）。
 * 参加費は即エスクロー、抽選で控除分だけ国庫へ回収し、残り＋繰越を当選者へ。
 * 参加者ゼロなら繰越（carryover）はエスクローに残り次回へ持ち越す。
 *
 *   購入:   user → sys:escrow:lottery       (lottery_ticket)
 *   控除:   sys:escrow:lottery → 国庫         (lottery_rake = 回収)
 *   当選:   sys:escrow:lottery → 当選者        (lottery_prize)
 *   積立:   国庫 → sys:escrow:lottery         (lottery_seed, 繰越の元手)
 */
export const LOTTERY_ESCROW = "sys:escrow:lottery";
const LOTTERY_APPROVER = "system:lottery";
const CARRYOVER_KEY = "lottery:carryover";

export type LotteryErrorCode =
  | "ERR_LOTTERY_NOT_FOUND"
  | "ERR_LOTTERY_CLOSED"
  | "ERR_LOTTERY_ENDED"
  | "ERR_LOTTERY_EXISTS"
  | "ERR_BAD_QTY";

export class LotteryError extends Error {
  constructor(
    readonly code: LotteryErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "LotteryError";
  }
}

export interface LotteryRow {
  id: number;
  status: "open" | "drawn" | "cancelled";
  ticket_price: number;
  house_edge_bps: number;
  pot: number;
  carryover_in: number;
  winner_id: string | null;
  prize: number | null;
  rake: number | null;
  draws_at: number;
  channel_id: string | null;
  message_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface DrawResult {
  lottery: LotteryRow;
  winnerId: string | null;
  prize: number;
  rake: number;
  totalTickets: number;
  participants: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class Lottery {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly settings: Settings,
    private readonly events: EventLog,
    /** テスト用に差し替え可能な乱数（0..1） */
    private readonly rng: () => number = Math.random,
  ) {
    this.ledger.ensureAccount(LOTTERY_ESCROW, "system");
  }

  carryover(): number {
    return Number(this.settings.getString(CARRYOVER_KEY) ?? 0) || 0;
  }
  private setCarryover(v: number, actor: string): void {
    this.settings.set(CARRYOVER_KEY, Math.max(0, Math.floor(v)), actor);
  }

  get(id: number): LotteryRow | undefined {
    return this.db.prepare("SELECT * FROM lotteries WHERE id = ?").get(id) as LotteryRow | undefined;
  }
  private require(id: number): LotteryRow {
    const l = this.get(id);
    if (!l) throw new LotteryError("ERR_LOTTERY_NOT_FOUND", { id });
    return l;
  }
  activeOpen(): LotteryRow | undefined {
    return this.db.prepare("SELECT * FROM lotteries WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as
      | LotteryRow
      | undefined;
  }
  listExpired(atTs: number = now()): LotteryRow[] {
    return this.db
      .prepare("SELECT * FROM lotteries WHERE status = 'open' AND draws_at <= ? ORDER BY draws_at")
      .all(atTs) as LotteryRow[];
  }

  entries(id: number): Array<{ user_id: string; qty: number }> {
    return this.db
      .prepare("SELECT user_id, qty FROM lottery_entries WHERE lottery_id = ? AND qty > 0 ORDER BY user_id")
      .all(id) as Array<{ user_id: string; qty: number }>;
  }
  totalTickets(id: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(qty),0) AS s FROM lottery_entries WHERE lottery_id = ?").get(id) as { s: number }).s;
  }
  ticketsOf(id: number, userId: string): number {
    const row = this.db.prepare("SELECT qty FROM lottery_entries WHERE lottery_id = ? AND user_id = ?").get(id, userId) as { qty: number } | undefined;
    return row?.qty ?? 0;
  }
  /** 見込み当選額（今のエスクロー：繰越 + 売上 − 控除見込み） */
  jackpot(l: LotteryRow): number {
    const rake = Math.floor((l.pot * l.house_edge_bps) / 10_000);
    return l.carryover_in + l.pot - rake;
  }

  setPanel(id: number, channelId: string, messageId: string): void {
    this.db.prepare("UPDATE lotteries SET channel_id = ?, message_id = ?, updated_at = ? WHERE id = ?").run(channelId, messageId, now(), id);
  }

  /** 新しい回を開く。開催中があれば拒否（同時に1回だけ） */
  open(args: { ticketPrice: number; houseEdgeBps?: number; drawsAt: number; createdBy: string }): LotteryRow {
    if (this.activeOpen()) throw new LotteryError("ERR_LOTTERY_EXISTS");
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO lotteries (ticket_price, house_edge_bps, pot, carryover_in, draws_at, created_by, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(Math.max(1, Math.floor(args.ticketPrice)), Math.min(10_000, Math.max(0, Math.floor(args.houseEdgeBps ?? 2_000))), this.carryover(), args.drawsAt, args.createdBy, ts, ts);
    const row = this.get(Number(info.lastInsertRowid))!;
    this.events.log("lottery_opened", { actor: args.createdBy, payload: { id: row.id, ticketPrice: row.ticket_price } });
    return row;
  }

  /** 繰越の積み立て（国庫→エスクロー）。当選プールを厚くする */
  seed(amount: number, actor: string): number {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new LotteryError("ERR_BAD_QTY", { amount });
    this.ledger.transfer({
      from: TREASURY,
      to: LOTTERY_ESCROW,
      amount,
      type: "lottery_seed",
      actor,
      approvedBy: LOTTERY_APPROVER,
      reason: "輪廻籤 積立",
      idempotencyKey: `lot-seed:${actor}:${now()}:${amount}`,
    });
    const next = this.carryover() + amount;
    this.setCarryover(next, actor);
    // 開催中なら表示上の carryover_in も更新
    const open = this.activeOpen();
    if (open) this.db.prepare("UPDATE lotteries SET carryover_in = ?, updated_at = ? WHERE id = ?").run(next, now(), open.id);
    return next;
  }

  /** 籤を買う（複数枚可）。参加費は即エスクロー */
  buy(args: { lotteryId: number; userId: string; qty: number; idempotencyKey: string }): { qty: number; cost: number } {
    const l = this.require(args.lotteryId);
    if (l.status !== "open") throw new LotteryError("ERR_LOTTERY_CLOSED", { id: l.id });
    if (l.draws_at <= now()) throw new LotteryError("ERR_LOTTERY_ENDED", { id: l.id });
    if (!Number.isInteger(args.qty) || args.qty <= 0 || args.qty > 1000) throw new LotteryError("ERR_BAD_QTY", { qty: args.qty });

    const cost = l.ticket_price * args.qty;
    const ts = now();
    const run = this.db.transaction((): { qty: number; cost: number } => {
      this.ledger.ensureAccount(`user:${args.userId}`, "user");
      this.ledger.transfer({
        from: `user:${args.userId}`,
        to: LOTTERY_ESCROW,
        amount: cost,
        type: "lottery_ticket",
        actor: `user:${args.userId}`,
        approvedBy: LOTTERY_APPROVER,
        reason: `輪廻籤#${l.id} ${args.qty}枚`,
        refType: "lottery",
        refId: String(l.id),
        idempotencyKey: args.idempotencyKey,
      });
      this.db
        .prepare(
          `INSERT INTO lottery_entries (lottery_id, user_id, qty, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(lottery_id, user_id) DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at`,
        )
        .run(l.id, args.userId, args.qty, ts);
      this.db.prepare("UPDATE lotteries SET pot = pot + ?, updated_at = ? WHERE id = ?").run(cost, ts, l.id);
      this.events.log("lottery_ticket", { actor: args.userId, payload: { id: l.id, qty: args.qty } });
      return { qty: this.ticketsOf(l.id, args.userId), cost };
    });
    return run();
  }

  /** 抽選。控除を国庫へ、残り＋繰越を当選者へ。参加者ゼロなら繰越据え置き */
  draw(lotteryId: number, actor: string): DrawResult {
    const l = this.require(lotteryId);
    if (l.status !== "open") throw new LotteryError("ERR_LOTTERY_CLOSED", { id: l.id });
    const ts = now();
    const entries = this.entries(l.id);
    const total = entries.reduce((s, e) => s + e.qty, 0);

    const run = this.db.transaction((): DrawResult => {
      if (total === 0) {
        // 参加者なし → 繰越はエスクローに残したまま次回へ
        this.db.prepare("UPDATE lotteries SET status = 'drawn', winner_id = NULL, prize = 0, rake = 0, updated_at = ? WHERE id = ?").run(ts, l.id);
        this.events.log("lottery_drawn", { actor, payload: { id: l.id, winner: null, carryover: this.carryover() } });
        return { lottery: this.get(l.id)!, winnerId: null, prize: 0, rake: 0, totalTickets: 0, participants: 0 };
      }

      const rake = Math.floor((l.pot * l.house_edge_bps) / 10_000);
      if (rake > 0) {
        this.ledger.transfer({
          from: LOTTERY_ESCROW,
          to: TREASURY,
          amount: rake,
          type: "lottery_rake",
          actor,
          approvedBy: LOTTERY_APPROVER,
          reason: `輪廻籤#${l.id} 控除`,
          refType: "lottery",
          refId: String(l.id),
          idempotencyKey: `lot-rake:${l.id}`,
        });
      }
      const prize = l.pot - rake + l.carryover_in;
      const winnerId = this.pickWeighted(entries, total);
      if (prize > 0) {
        this.ledger.transfer({
          from: LOTTERY_ESCROW,
          to: `user:${winnerId}`,
          amount: prize,
          type: "lottery_prize",
          actor,
          approvedBy: LOTTERY_APPROVER,
          reason: `輪廻籤#${l.id} 当選`,
          refType: "lottery",
          refId: String(l.id),
          idempotencyKey: `lot-prize:${l.id}`,
        });
      }
      this.setCarryover(0, actor); // 払い出したので繰越リセット
      this.db.prepare("UPDATE lotteries SET status = 'drawn', winner_id = ?, prize = ?, rake = ?, updated_at = ? WHERE id = ?").run(winnerId, prize, rake, ts, l.id);
      this.events.log("lottery_drawn", { actor, target: winnerId, payload: { id: l.id, prize, rake } });
      return { lottery: this.get(l.id)!, winnerId, prize, rake, totalTickets: total, participants: entries.length };
    });
    return run();
  }

  /** 取消。全参加者へ返金し、繰越は据え置き */
  cancel(lotteryId: number, actor: string): LotteryRow {
    const l = this.require(lotteryId);
    if (l.status !== "open") throw new LotteryError("ERR_LOTTERY_CLOSED", { id: l.id });
    const ts = now();
    const run = this.db.transaction((): LotteryRow => {
      for (const e of this.entries(l.id)) {
        const refund = e.qty * l.ticket_price;
        this.ledger.transfer({
          from: LOTTERY_ESCROW,
          to: `user:${e.user_id}`,
          amount: refund,
          type: "lottery_refund",
          actor,
          approvedBy: LOTTERY_APPROVER,
          reason: `輪廻籤#${l.id} 取消返金`,
          refType: "lottery",
          refId: String(l.id),
          idempotencyKey: `lot-refund:${l.id}:${e.user_id}`,
        });
      }
      this.db.prepare("UPDATE lotteries SET status = 'cancelled', updated_at = ? WHERE id = ?").run(ts, l.id);
      this.events.log("lottery_cancelled", { actor, payload: { id: l.id } });
      return this.get(l.id)!;
    });
    return run();
  }

  private pickWeighted(entries: Array<{ user_id: string; qty: number }>, total: number): string {
    let r = Math.floor(this.rng() * total); // 0..total-1
    for (const e of entries) {
      if (r < e.qty) return e.user_id;
      r -= e.qty;
    }
    return entries[entries.length - 1]!.user_id; // 保険（丸め対策）
  }
}
