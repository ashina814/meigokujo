import type Database from "better-sqlite3";
import type { EtherExchange } from "./exchange.js";
import { HOUSE_HOLDER } from "./exchange.js";
import type { EventLog } from "../events/service.js";

/**
 * 胴元債務予約（大型UPD PR5・正本 §11.2）。
 *
 * `Casino.canAccept()` は「いまの house 残高で最悪配当を払えるか」を**1ベット単位で**見るだけで、
 * 検査から精算までの間に別の利用者が胴元を削れる。同時に大勝ちが重なると、誰も見ていない
 * 合計債務が house 残高を超える。実害は「精算が例外で巻き戻る」ので資金は消えないが、
 * **大当たりの瞬間にだけ起きる**ので体験として最悪。
 *
 * そこでゲーム開始時に最悪ケースの純増債務を予約し、`house.available` を
 * `house 残高 − 予約合計` に置き換える。予約が取れないゲームは開始しない（正本 I7）。
 */

export interface ReservationRow {
  key: string;
  amount: number;
  game: string;
  userId: string;
  createdAt: number;
}

export interface ReservationResult {
  ok: boolean;
  /** 予約できなかったときの、いま受けられる上限（＝ available） */
  available: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** 24時間残った予約は「解放し忘れ」とみなして警告する（正本 §11.2） */
export const RESERVATION_STALE_SEC = 24 * 60 * 60;

export class HouseReservations {
  constructor(
    private readonly db: Database.Database,
    private readonly ether: EtherExchange,
    private readonly events: EventLog,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_house_reservations (
        key        TEXT PRIMARY KEY,
        amount     INTEGER NOT NULL CHECK(amount > 0),
        game       TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_casino_reservations_created ON casino_house_reservations(created_at);
    `);
  }

  /** 予約済みの合計 */
  totalReserved(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM casino_house_reservations").get() as {
      total: number;
    };
    return row.total;
  }

  /**
   * いま新しい債務を引き受けられる額。
   * **これが `canAccept` の代わり**になる（house 残高そのものではなく、予約を引いた残り）。
   */
  available(): number {
    return Math.max(0, this.ether.balanceOf(HOUSE_HOLDER) - this.totalReserved());
  }

  /**
   * 予約を取る。**`available()` の再確認と INSERT を同一トランザクション**で行う。
   *
   * すでに同じ鍵で予約済みなら成功として扱う（同じ操作の再試行で二重に取らない）。
   * @returns 取れたかどうかと、取れなかった場合の現在の上限
   */
  reserve(key: string, amount: number, game: string, userId: string): ReservationResult {
    if (!key.trim()) throw new Error("HouseReservations.reserve: key は必須");
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`HouseReservations.reserve: 不正な額 ${amount}`);
    // 債務ゼロ（引き分けしかないゲーム等）は予約行を作らない
    if (amount === 0) return { ok: true, available: this.available() };

    const run = this.db.transaction((): ReservationResult => {
      const existing = this.get(key);
      if (existing) return { ok: true, available: this.available() };
      const available = this.available();
      if (amount > available) return { ok: false, available };
      this.db
        .prepare(
          "INSERT INTO casino_house_reservations (key, amount, game, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(key, amount, game, userId, now());
      return { ok: true, available: available - amount };
    });
    // すでに書き込みトランザクションの中（runGroup の内側）ならそのまま合流する
    return this.db.inTransaction ? run() : run.immediate();
  }

  /** 予約を解放する。存在しなくてもエラーにしない（二重解放を許す） */
  release(key: string): boolean {
    const info = this.db.prepare("DELETE FROM casino_house_reservations WHERE key = ?").run(key);
    return info.changes > 0;
  }

  get(key: string): ReservationRow | undefined {
    const row = this.db.prepare("SELECT * FROM casino_house_reservations WHERE key = ?").get(key) as
      | { key: string; amount: number; game: string; user_id: string; created_at: number }
      | undefined;
    return row ? { key: row.key, amount: row.amount, game: row.game, userId: row.user_id, createdAt: row.created_at } : undefined;
  }

  list(): ReservationRow[] {
    const rows = this.db.prepare("SELECT * FROM casino_house_reservations ORDER BY created_at ASC").all() as Array<{
      key: string; amount: number; game: string; user_id: string; created_at: number;
    }>;
    return rows.map((r) => ({ key: r.key, amount: r.amount, game: r.game, userId: r.user_id, createdAt: r.created_at }));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM casino_house_reservations").get() as { n: number }).n;
  }

  /**
   * 全解放（起動時・正本 §8.2 S9）。
   *
   * ソロゲームの進行はプロセス内の状態なので、再起動後に進行中のものは存在しない。
   * **消す前に件数と総額を events へ残す**（漏れの傾向を後から見るため）。
   */
  releaseAll(reason: string): { count: number; total: number } {
    const count = this.count();
    const total = this.totalReserved();
    if (count > 0) {
      this.events.log("casino_reservations_released", { actor: "system", payload: { reason, count, total } });
    }
    this.db.prepare("DELETE FROM casino_house_reservations").run();
    return { count, total };
  }

  /** 一定時間より古い予約（解放し忘れの検出） */
  stale(olderThanSec = RESERVATION_STALE_SEC): ReservationRow[] {
    const cutoff = now() - olderThanSec;
    const rows = this.db
      .prepare("SELECT * FROM casino_house_reservations WHERE created_at < ? ORDER BY created_at ASC")
      .all(cutoff) as Array<{ key: string; amount: number; game: string; user_id: string; created_at: number }>;
    return rows.map((r) => ({ key: r.key, amount: r.amount, game: r.game, userId: r.user_id, createdAt: r.created_at }));
  }

  /**
   * 古い予約を警告つきで解放する（scheduler が定期的に呼ぶ）。
   * 解放しないと、落ちたゲームの予約が胴元の受注可能額を永久に食う。
   */
  sweepStale(olderThanSec = RESERVATION_STALE_SEC): { count: number; total: number; rows: ReservationRow[] } {
    const rows = this.stale(olderThanSec);
    if (rows.length === 0) return { count: 0, total: 0, rows: [] };
    const total = rows.reduce((s, r) => s + r.amount, 0);
    this.events.log("casino_reservation_stale", {
      actor: "system:scheduler",
      payload: { count: rows.length, total, keys: rows.map((r) => r.key).slice(0, 20) },
    });
    const del = this.db.prepare("DELETE FROM casino_house_reservations WHERE key = ?");
    const tx = this.db.transaction(() => {
      for (const r of rows) del.run(r.key);
    });
    tx();
    return { count: rows.length, total, rows };
  }
}
