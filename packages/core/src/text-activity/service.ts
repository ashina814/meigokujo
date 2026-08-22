import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";

/**
 * TC（発言）安全source（PR E1）。
 *
 * raw message数もmessage内容も一切保存しない。保存するのは
 * 「そのJST日に少なくとも1回、称号対象として安全な発言活動が観測された」という
 * 事実だけ——1 user × 1 JST day で最大1行。rank_text（XP/level/cooldown）とは
 * 完全に独立したsubsystem——rank XP・tierUp・cooldown成否をこのserviceの判定に
 * 一切使わない（Rank subsystemから独立、§14）。
 *
 * 既存本番DBにも安全に追加できる、冪等なtable作成（`BumpCounter`と同じ構築パターン）。
 */
export class TextActivity {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS text_active_days (
        user_id       TEXT NOT NULL,
        activity_date TEXT NOT NULL,
        observed_at   INTEGER NOT NULL CHECK (observed_at >= 0),
        PRIMARY KEY (user_id, activity_date)
      );
    `);
  }

  /**
   * その日最初のqualifying発言を記録する。
   *
   * - `observedAt`はcallerが検証済みのeligibility（bot除外・guild外除外・空message除外・
   *   除外channel除外）を通過した後のMessageCreate event time（unix秒）——`Date.now()`で
   *   捏造しない。
   * - JST日への変換はここで一元化する（`jstDateStr()`、`entry/sessions.ts`の既存JST
   *   utilityを再利用——timezone hardcodeを複数実装しない）。UTC日ではなくAsia/Tokyo日。
   * - 同じuser×同じJST日の2回目以降の呼び出しは`ON CONFLICT DO NOTHING`——
   *   first persisted observationを保持し、`observed_at`をUPDATEしない（§11）。
   */
  recordActiveDay(userIdRaw: string, observedAtRaw: number): { readonly recorded: boolean; readonly activityDate: string } {
    const userId = requireText(userIdRaw, "userId");
    const observedAt = requireObservedAt(observedAtRaw);
    const activityDate = jstDateStr(new Date(observedAt * 1000));

    const result = this.db
      .prepare(
        `INSERT INTO text_active_days (user_id, activity_date, observed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, activity_date) DO NOTHING`,
      )
      .run(userId, activityDate, observedAt);

    return { recorded: result.changes > 0, activityDate };
  }
}

function requireText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

/** NaN・Infinity・負数・小数をすべてrejectする——safe integer unix秒だけを受け付ける。 */
function requireObservedAt(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`observedAt must be a non-negative safe integer unix second: ${value}`);
  }
  return value;
}
