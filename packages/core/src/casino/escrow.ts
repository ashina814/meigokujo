import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherError, EtherExchange, HOUSE_HOLDER } from "./exchange.js";

/**
 * 賭場のエスクロー台帳。
 * 「賭け金を先取りして胴元(house)に一時保管する」ゲーム（対人・競馬・丁半・PvPポーカー等）で、
 * 誰からいくら預かっているかを DB に記録する。
 *
 * 目的: プロセス再起動やクラッシュでゲームセッション（in-memory）が消えても、
 * 台帳が残っていれば起動時 sweepAll() で全額返金できる。
 * 板（Markets）の refundAllPending と同じ思想を、セッション型ゲーム全般に広げたもの。
 *
 * 使い方:
 * - hold():   徴収と同時に記録（同一セッション同一ユーザーは加算）
 * - clear():  正常精算後に記録だけ削除（金は動かさない）
 * - refund(): セッション全員に返金して削除
 * - refundOne(): 1人だけ返金して削除（ロビー離脱）
 * - sweepAll(): 起動時に残っている全記録を返金（クラッシュ回収）
 */

export interface EscrowRow {
  session_id: string;
  user_id: string;
  amount: number;
  game: string;
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class Escrow {
  constructor(
    private readonly db: Database.Database,
    private readonly ether: EtherExchange,
    private readonly events: EventLog,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_escrow (
        session_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        amount     INTEGER NOT NULL CHECK(amount > 0),
        game       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
    `);
  }

  /**
   * user から amount を徴収して house に預け、台帳に記録する。
   * 同一セッション・同一ユーザーの2回目以降は加算（丁半の増額など）。
   * 残高不足なら false（何も動かさない）。
   */
  hold(sessionId: string, userId: string, amount: number, game: string): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    if (this.ether.balanceOf(userId) < amount) return false;
    try {
      this.db.transaction(() => {
        this.ether.transfer(userId, HOUSE_HOLDER, amount);
        this.db
          .prepare(
            `INSERT INTO casino_escrow (session_id, user_id, amount, game, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id, user_id) DO UPDATE SET amount = amount + excluded.amount`,
          )
          .run(sessionId, userId, amount, game, now());
      })();
      return true;
    } catch (e) {
      if (e instanceof EtherError) return false;
      throw e;
    }
  }

  /** セッションの預かり記録（返金額の確認用） */
  list(sessionId: string): EscrowRow[] {
    return this.db.prepare("SELECT * FROM casino_escrow WHERE session_id = ?").all(sessionId) as EscrowRow[];
  }

  /** 正常精算した: 記録だけ消す（金は精算側が動かした後） */
  clear(sessionId: string): void {
    this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sessionId);
  }

  /** セッションの全員に預かり額を返金して記録を消す。返金した人数を返す */
  refund(sessionId: string): number {
    return this.db.transaction((): number => {
      const rows = this.list(sessionId);
      for (const r of rows) this.ether.transfer(HOUSE_HOLDER, r.user_id, r.amount);
      this.clear(sessionId);
      return rows.length;
    })();
  }

  /** 1人だけ返金して記録を消す（ロビー離脱）。記録が無ければ false */
  refundOne(sessionId: string, userId: string): boolean {
    return this.db.transaction((): boolean => {
      const row = this.db
        .prepare("SELECT * FROM casino_escrow WHERE session_id = ? AND user_id = ?")
        .get(sessionId, userId) as EscrowRow | undefined;
      if (!row) return false;
      this.ether.transfer(HOUSE_HOLDER, userId, row.amount);
      this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ? AND user_id = ?").run(sessionId, userId);
      return true;
    })();
  }

  /**
   * 起動時掃除: 残っている全エスクローを返金して消す。
   * 残っている = 前回プロセスが精算前に死んだ、ということ。
   */
  sweepAll(actor: string): { sessions: number; users: number; total: number } {
    return this.db.transaction((): { sessions: number; users: number; total: number } => {
      const rows = this.db.prepare("SELECT * FROM casino_escrow").all() as EscrowRow[];
      const sessions = new Set(rows.map((r) => r.session_id)).size;
      let total = 0;
      for (const r of rows) {
        this.ether.transfer(HOUSE_HOLDER, r.user_id, r.amount);
        total += r.amount;
      }
      this.db.prepare("DELETE FROM casino_escrow").run();
      if (rows.length > 0) {
        this.events.log("casino_escrow_sweep", { actor, payload: { sessions, users: rows.length, total } });
      }
      return { sessions, users: rows.length, total };
    })();
  }
}
