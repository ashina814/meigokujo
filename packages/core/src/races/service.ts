import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";

/**
 * 冥馬レース（経済設計.md §5 / 世界構想マップ「Bot実況付きレース賭博」）。
 * パリミュチュエル方式。全賭け金をエスクローに集め、発走で1着を抽選、
 * 控除分を国庫へ回収し、残りを的中者へ賭け額に比例して配当する。
 * 的中者ゼロなら全額返金（不成立）。
 *
 *   賭け:   user → sys:escrow:race        (bet)
 *   控除:   sys:escrow:race → 国庫          (race_rake = 回収)
 *   配当:   sys:escrow:race → 的中者        (prize)
 *   返金:   sys:escrow:race → 賭けた人      (race_refund)
 */
export const RACE_ESCROW = "sys:escrow:race";
const RACE_APPROVER = "system:race";

export type RaceErrorCode =
  | "ERR_RACE_NOT_FOUND"
  | "ERR_RACE_CLOSED"
  | "ERR_RACE_STARTED"
  | "ERR_BAD_HORSE"
  | "ERR_BAD_HORSES";

export class RaceError extends Error {
  constructor(
    readonly code: RaceErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "RaceError";
  }
}

export interface RaceRow {
  id: number;
  title: string | null;
  horses_json: string;
  status: "open" | "settled" | "cancelled";
  house_edge_bps: number;
  pool: number;
  winner_index: number | null;
  starts_at: number;
  channel_id: string | null;
  message_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface SettleResult {
  race: RaceRow;
  winnerIndex: number;
  winnerName: string;
  /** 的中者への配当（賭け額按分） */
  payouts: Array<{ userId: string; amount: number }>;
  rakeTotal: number; // 控除＋端数（国庫回収）
  refunded: boolean; // 的中者ゼロで全額返金したか
}

const now = () => Math.floor(Date.now() / 1000);

export class Races {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
    private readonly rng: () => number = Math.random,
  ) {
    this.ledger.ensureAccount(RACE_ESCROW, "system");
  }

  horses(r: RaceRow): string[] {
    try {
      return JSON.parse(r.horses_json) as string[];
    } catch {
      return [];
    }
  }

  create(args: { title?: string; horses: string[]; houseEdgeBps?: number; startsAt: number; createdBy: string }): RaceRow {
    const horses = args.horses.map((h) => h.trim()).filter(Boolean);
    if (horses.length < 2 || horses.length > 8) throw new RaceError("ERR_BAD_HORSES", { count: horses.length });
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO races (title, horses_json, house_edge_bps, pool, starts_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        args.title?.slice(0, 100) ?? null,
        JSON.stringify(horses.map((h) => h.slice(0, 30))),
        Math.min(10_000, Math.max(0, Math.floor(args.houseEdgeBps ?? 1_000))),
        args.startsAt,
        args.createdBy,
        ts,
        ts,
      );
    const row = this.get(Number(info.lastInsertRowid))!;
    this.events.log("race_opened", { actor: args.createdBy, payload: { id: row.id, horses } });
    return row;
  }

  get(id: number): RaceRow | undefined {
    return this.db.prepare("SELECT * FROM races WHERE id = ?").get(id) as RaceRow | undefined;
  }
  private require(id: number): RaceRow {
    const r = this.get(id);
    if (!r) throw new RaceError("ERR_RACE_NOT_FOUND", { id });
    return r;
  }
  listOpen(): RaceRow[] {
    return this.db.prepare("SELECT * FROM races WHERE status = 'open' ORDER BY starts_at").all() as RaceRow[];
  }
  listExpired(atTs: number = now()): RaceRow[] {
    return this.db.prepare("SELECT * FROM races WHERE status = 'open' AND starts_at <= ? ORDER BY starts_at").all(atTs) as RaceRow[];
  }

  /** 馬ごとの賭け合計（オッズ表示用） */
  poolByHorse(id: number): number[] {
    const r = this.require(id);
    const arr = new Array(this.horses(r).length).fill(0);
    const rows = this.db.prepare("SELECT horse_index, COALESCE(SUM(amount),0) AS s FROM race_bets WHERE race_id = ? GROUP BY horse_index").all(id) as Array<{ horse_index: number; s: number }>;
    for (const row of rows) if (row.horse_index >= 0 && row.horse_index < arr.length) arr[row.horse_index] = row.s;
    return arr;
  }
  myBets(id: number, userId: string): Array<{ horse_index: number; amount: number }> {
    return this.db.prepare("SELECT horse_index, SUM(amount) AS amount FROM race_bets WHERE race_id = ? AND bettor_id = ? GROUP BY horse_index").all(id, userId) as Array<{ horse_index: number; amount: number }>;
  }

  setPanel(id: number, channelId: string, messageId: string): void {
    this.db.prepare("UPDATE races SET channel_id = ?, message_id = ?, updated_at = ? WHERE id = ?").run(channelId, messageId, now(), id);
  }

  bet(args: { raceId: number; bettorId: string; horseIndex: number; amount: number; idempotencyKey: string }): RaceRow {
    const r = this.require(args.raceId);
    if (r.status !== "open") throw new RaceError("ERR_RACE_CLOSED", { id: r.id });
    if (r.starts_at <= now()) throw new RaceError("ERR_RACE_STARTED", { id: r.id });
    if (!Number.isInteger(args.horseIndex) || args.horseIndex < 0 || args.horseIndex >= this.horses(r).length) {
      throw new RaceError("ERR_BAD_HORSE", { horseIndex: args.horseIndex });
    }
    const ts = now();
    const run = this.db.transaction((): RaceRow => {
      this.ledger.ensureAccount(`user:${args.bettorId}`, "user");
      this.ledger.transfer({
        from: `user:${args.bettorId}`,
        to: RACE_ESCROW,
        amount: args.amount,
        type: "bet",
        actor: `user:${args.bettorId}`,
        approvedBy: RACE_APPROVER,
        reason: `冥馬レース#${r.id} 賭け`,
        refType: "race",
        refId: String(r.id),
        idempotencyKey: args.idempotencyKey,
      });
      this.db.prepare("INSERT INTO race_bets (race_id, bettor_id, horse_index, amount, created_at) VALUES (?, ?, ?, ?, ?)").run(r.id, args.bettorId, args.horseIndex, args.amount, ts);
      this.db.prepare("UPDATE races SET pool = pool + ?, updated_at = ? WHERE id = ?").run(args.amount, ts, r.id);
      this.events.log("race_bet", { actor: args.bettorId, payload: { id: r.id, horse: args.horseIndex, amount: args.amount } });
      return this.get(r.id)!;
    });
    return run();
  }

  /** 発走・清算。1着を抽選し、的中者へ按分配当。的中者ゼロなら全額返金 */
  settle(raceId: number, actor: string): SettleResult {
    const r = this.require(raceId);
    if (r.status !== "open") throw new RaceError("ERR_RACE_CLOSED", { id: r.id });
    const horses = this.horses(r);
    const ts = now();

    const run = this.db.transaction((): SettleResult => {
      const winnerIndex = Math.min(horses.length - 1, Math.floor(this.rng() * horses.length));
      const bets = this.db.prepare("SELECT bettor_id, horse_index, amount FROM race_bets WHERE race_id = ?").all(r.id) as Array<{ bettor_id: string; horse_index: number; amount: number }>;

      // 的中者ごとの賭け合計
      const winners = new Map<string, number>();
      let winnerTotal = 0;
      for (const b of bets) {
        if (b.horse_index === winnerIndex) {
          winners.set(b.bettor_id, (winners.get(b.bettor_id) ?? 0) + b.amount);
          winnerTotal += b.amount;
        }
      }

      const payouts: Array<{ userId: string; amount: number }> = [];
      let rakeTotal = 0;
      let refunded = false;

      if (r.pool === 0) {
        // 賭けなし
      } else if (winnerTotal === 0) {
        // 的中者ゼロ → 全額返金（不成立）
        refunded = true;
        const byBettor = new Map<string, number>();
        for (const b of bets) byBettor.set(b.bettor_id, (byBettor.get(b.bettor_id) ?? 0) + b.amount);
        for (const [userId, amount] of byBettor) {
          this.ledger.transfer({
            from: RACE_ESCROW, to: `user:${userId}`, amount, type: "race_refund", actor,
            approvedBy: RACE_APPROVER, reason: `冥馬レース#${r.id} 不成立返金`, refType: "race", refId: String(r.id),
            idempotencyKey: `race-refund:${r.id}:${userId}`,
          });
        }
      } else {
        const rake = Math.floor((r.pool * r.house_edge_bps) / 10_000);
        const payoutPool = r.pool - rake;
        let distributed = 0;
        for (const [userId, staked] of winners) {
          const amount = Math.floor((staked / winnerTotal) * payoutPool);
          if (amount > 0) {
            this.ledger.transfer({
              from: RACE_ESCROW, to: `user:${userId}`, amount, type: "prize", actor,
              approvedBy: RACE_APPROVER, reason: `冥馬レース#${r.id} 配当`, refType: "race", refId: String(r.id),
              idempotencyKey: `race-prize:${r.id}:${userId}`,
            });
            payouts.push({ userId, amount });
            distributed += amount;
          }
        }
        // 控除＋端数を国庫へ回収
        rakeTotal = r.pool - distributed;
        if (rakeTotal > 0) {
          this.ledger.transfer({
            from: RACE_ESCROW, to: TREASURY, amount: rakeTotal, type: "race_rake", actor,
            approvedBy: RACE_APPROVER, reason: `冥馬レース#${r.id} 控除`, refType: "race", refId: String(r.id),
            idempotencyKey: `race-rake:${r.id}`,
          });
        }
      }

      this.db.prepare("UPDATE races SET status = 'settled', winner_index = ?, updated_at = ? WHERE id = ?").run(winnerIndex, ts, r.id);
      this.events.log("race_settled", { actor, payload: { id: r.id, winnerIndex, winnerName: horses[winnerIndex], rakeTotal, refunded } });
      return { race: this.get(r.id)!, winnerIndex, winnerName: horses[winnerIndex] ?? `${winnerIndex}`, payouts, rakeTotal, refunded };
    });
    return run();
  }

  /** 取消。全賭け金を返金 */
  cancel(raceId: number, actor: string): RaceRow {
    const r = this.require(raceId);
    if (r.status !== "open") throw new RaceError("ERR_RACE_CLOSED", { id: r.id });
    const ts = now();
    const run = this.db.transaction((): RaceRow => {
      const rows = this.db.prepare("SELECT bettor_id, SUM(amount) AS amount FROM race_bets WHERE race_id = ? GROUP BY bettor_id").all(r.id) as Array<{ bettor_id: string; amount: number }>;
      for (const b of rows) {
        this.ledger.transfer({
          from: RACE_ESCROW, to: `user:${b.bettor_id}`, amount: b.amount, type: "race_refund", actor,
          approvedBy: RACE_APPROVER, reason: `冥馬レース#${r.id} 取消返金`, refType: "race", refId: String(r.id),
          idempotencyKey: `race-cancel:${r.id}:${b.bettor_id}`,
        });
      }
      this.db.prepare("UPDATE races SET status = 'cancelled', updated_at = ? WHERE id = ?").run(ts, r.id);
      this.events.log("race_cancelled", { actor, payload: { id: r.id } });
      return this.get(r.id)!;
    });
    return run();
  }
}
