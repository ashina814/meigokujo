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
  /**
   * 実際に保存されている予約（PR5 レビュー指摘）。
   *
   * 同じ鍵の再実行では**要求額ではなく保存済みの額**が返る。呼び出し側は
   * ここから状態を復元する（例: ブラックジャックの `doubleAllowed`）。
   * `ok:false` のときは `undefined`。
   */
  row?: ReservationRow;
  /** `ok:false` の理由。`capacity` = 余力不足、`conflict` = 同じ鍵で内容が違う */
  reason?: "capacity" | "conflict";
  /** `conflict` のときに既に保存されている予約 */
  conflictWith?: ReservationRow;
}

/**
 * 同じ鍵で内容の違う予約を取ろうとした（PR5 レビュー指摘）。
 *
 * 「鍵が同じなら中身を見ずに成功」にすると、たとえばブラックジャックで
 * 「初回はダブル無しで 15,000 しか取れなかったのに、再実行では 20,000 を要求して
 * `ok:true` が返り、呼び出し側が `doubleAllowed=true` を復元する」ことが起きる。
 * 実際の予約は 15,000 のままなので、ダブルされると裏付けが無い。
 */
export class ReservationConflictError extends Error {
  constructor(
    readonly key: string,
    readonly existing: ReservationRow,
    readonly requested: { amount: number; game: string; userId: string },
  ) {
    super(
      `ERR_RESERVATION_CONFLICT: ${key} は既に ` +
        `{amount:${existing.amount}, game:${existing.game}, user:${existing.userId}} で予約済み` +
        `（要求 {amount:${requested.amount}, game:${requested.game}, user:${requested.userId}}）`,
    );
    this.name = "ReservationConflictError";
  }
}

export type ReservationInputErrorCode = "ERR_BAD_KEY" | "ERR_BAD_GAME" | "ERR_BAD_USER" | "ERR_BAD_AMOUNT";

/**
 * 予約APIへの不正な入力（マージ直前レビュー対応）。
 *
 * `key` は元々検証していたが、`game` / `userId` は素通りしていた。空文字が通ると、
 * `game=""` や `userId=""` の予約行が作れてしまい、`totalReserved()` には正しく
 * 乗る一方で、`stale()` の警告や運営の一覧表示で「誰の・何の予約か分からない」行が残る。
 * 他の資金層（`LiabilityError` 等）と同じ形の型付きエラーで fail-closed にする。
 */
export class ReservationInputError extends Error {
  constructor(
    readonly code: ReservationInputErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ReservationInputError";
  }
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

  /**
   * 予約済みの合計。
   *
   * 各行の `amount` は `reserve()` で safe integer に制限しているが、
   * 行数が積み重なった `SUM()` そのものが safe integer を超えていないかは別途見る
   * （破損した行が混じって INTEGER の範囲だけは満たす、といった経路への保険）。
   * 超えていれば `available()` 計算が信用できないので、丸めず例外にする。
   */
  totalReserved(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM casino_house_reservations").get() as {
      total: number;
    };
    if (!Number.isSafeInteger(row.total)) {
      throw new ReservationInputError("ERR_BAD_AMOUNT", { field: "totalReserved", total: row.total });
    }
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
   * **自分が取った予約を支払保証として使える額**（PR5 レビュー指摘）。
   *
   * `available()` は全予約を house 残高から引くので、予約を取った本人が
   * 「自分で確保した枠」まで利用不可として扱われる。スロットのフリースピンのように
   * 「予約を保持したまま、その予約の範囲で払う」処理はこちらを見る。
   *
   * ```text
   * availableIncludingOwn(key) = house残高 − (予約総額 − その鍵の予約額)
   * ```
   *
   * 存在しない鍵を渡した場合は `available()` と同じ（＝自己予約なし）。
   */
  availableIncludingOwn(key: string): number {
    const own = this.get(key)?.amount ?? 0;
    return Math.max(0, this.ether.balanceOf(HOUSE_HOLDER) - (this.totalReserved() - own));
  }

  /**
   * 予約を取る。**`available()` の再確認と INSERT を同一トランザクション**で行う。
   *
   * ## 同じ鍵が既にある場合（PR5 レビュー指摘）
   *
   * 以前は「鍵が同じなら中身を見ずに成功」だった。これだと、たとえば
   *
   * ```text
   * 初回:   ダブル込み 20,000 が取れず → ダブル無し 15,000 を予約（doubleAllowed=false）
   * 再実行: 20,000 を要求 → 同じ鍵の行があるので ok:true
   *         → 呼び出し側が doubleAllowed=true を復元 → 実際の予約は 15,000 のまま
   * ```
   *
   * となり、裏付けの無いダブルを許してしまう。
   *
   * いまは **user_id / game / amount がすべて一致するときだけ**冪等成功にする。
   * 一致しなければ資金を1 Ld も動かさず {@link ReservationConflictError} を投げる。
   * 「取り直したい」場合は呼び出し側が保存済みの額（`row`）から状態を復元すること。
   *
   * @returns 取れたかどうか、実際に保存されている予約、取れなかった場合の現在の上限
   */
  reserve(key: string, amount: number, game: string, userId: string): ReservationResult {
    if (typeof key !== "string" || !key.trim()) throw new ReservationInputError("ERR_BAD_KEY", { key });
    if (typeof game !== "string" || !game.trim()) throw new ReservationInputError("ERR_BAD_GAME", { game });
    if (typeof userId !== "string" || !userId.trim()) throw new ReservationInputError("ERR_BAD_USER", { userId });
    if (!Number.isSafeInteger(amount) || amount < 0) throw new ReservationInputError("ERR_BAD_AMOUNT", { amount });

    const run = this.db.transaction((): ReservationResult => {
      const existing = this.get(key);
      if (existing) {
        // 内容が違うなら冪等成功にしない（同じ鍵で別の債務を名乗らせない）
        if (existing.amount !== amount || existing.game !== game || existing.userId !== userId) {
          throw new ReservationConflictError(key, existing, { amount, game, userId });
        }
        return { ok: true, available: this.available(), row: existing };
      }
      // 債務ゼロ（引き分けしかないゲーム等）は予約行を作らない
      if (amount === 0) return { ok: true, available: this.available() };
      const available = this.available();
      if (amount > available) return { ok: false, available, reason: "capacity" };
      this.db
        .prepare(
          "INSERT INTO casino_house_reservations (key, amount, game, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(key, amount, game, userId, now());
      return { ok: true, available: available - amount, row: this.get(key)! };
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
