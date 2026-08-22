import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";
import { isCasinoActivityKey, type CasinoActivityKey } from "../casino/participation-history.js";

/**
 * Casino Safe Participation Source（PR E4）。
 *
 * raw `casino_participations`は1 play = 1 rowのまま保存される（`CasinoParticipationHistory`
 * 自身はday collapseを行わない——retry idempotencyのため実participationごとに区別する）。
 * これをそのままTitle evaluatorへ渡すと、raw play countがGoodhartの標的になる
 * （1日100回遊んで100件のfactを稼ぐ、等）。このmoduleだけが、
 * `user × activityKey × JST calendar day`で最大1 factへcollapseした
 * neutral participation truthへ変換する——generic title ruleは常に
 * `casino_activity_days`（derived、safe、titleUsable:true）経由でしかこの結果を読めない。
 *
 * amount・payout・net・result・opponent等は、そもそも`casino_participations`自体に
 * 保存されていない（`CasinoParticipationHistory`の書き込み契約）ので、この関数が
 * 追加でフィルタする必要はない——参照している列がそもそもneutralである。
 */
export interface CasinoActivityDayFact {
  readonly userId: string;
  readonly activityKey: CasinoActivityKey;
  readonly activityDate: string;
  readonly occurredAt: number;
}

/**
 * `userIds`について、`[window.start, window.end)`の間に観測されたsuccessful casino
 * participationを、`user × activityKey × JST day`で最大1 factへ畳み込んで返す。
 *
 * - DB内に万一allowlist外の`activity_key`が入っていても（corruption・writerバグ）、
 *   stringとしてそのまま公開せずfail-closedでその行をskipする（E2の
 *   `extractUserId()`と同じ考え方——例外で全体を落とすのではなく、該当行だけ無視する）。
 * - `ORDER BY user_id, occurred_at`で読み、`(userId, activityKey, date)`ごとの最初の
 *   行だけを採用する——同日に同じactivityを何度遊んでもfactは1件のまま。`occurredAt`は
 *   その最初のqualifying participationの`occurred_at`。
 */
export function computeCasinoActivityDays(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly CasinoActivityDayFact[] {
  if (userIds.length === 0) return [];

  const placeholders = userIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT user_id, activity_key, occurred_at FROM casino_participations
        WHERE user_id IN (${placeholders}) AND occurred_at >= ? AND occurred_at < ?
        ORDER BY user_id ASC, occurred_at ASC, activity_key ASC`,
    )
    .all(...userIds, window.start, window.end) as Array<{ user_id: string; activity_key: string; occurred_at: number }>;

  const seen = new Set<string>();
  const facts: CasinoActivityDayFact[] = [];
  for (const row of rows) {
    if (!isCasinoActivityKey(row.activity_key)) continue; // 未知/corrupt activity_keyはfail-closedでignore
    const activityKey = row.activity_key;
    const activityDate = jstDateStr(new Date(row.occurred_at * 1000));
    const dedupeKey = `${row.user_id} ${activityKey} ${activityDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    facts.push({ userId: row.user_id, activityKey, activityDate, occurredAt: row.occurred_at });
  }
  return facts;
}

/**
 * Casino Safe Completion Source（PR F2b）。
 *
 * `casino_activity_days`が証明するのは「successful funded participation
 * commitment」であって「ゲームが正常精算まで完了した」ではない——PVP経路は
 * game runner実行前にwriterが発火するため、参加commitmentと実際のgame
 * settlementを区別できない（PR #164レビューで確定したsemantic mismatch）。
 * この関数は別のimmutable正本`casino_participation_completions`（そのゲーム
 * 固有のcanonical financial resolution primitiveが成功したことだけを表す）を
 * 読み、`casino_activity_days`と同じday-collapse契約でneutral factへ変換する。
 *
 * `casino_participation_completions`はactivity_keyを保持しない——activity
 * identityは常にparent `casino_participations`行を正本にする。そのため
 * このクエリはJOINで両テーブルを結び、commitment側のactivity_keyを使う。
 */
export interface CasinoCompletedActivityDayFact {
  readonly userId: string;
  readonly activityKey: CasinoActivityKey;
  readonly activityDate: string;
  readonly completedAt: number;
}

/**
 * `userIds`について、`[window.start, window.end)`の間に観測されたcanonical
 * settlement成功（completion）を、`user × activityKey × JST day`で最大1 fact
 * へ畳み込んで返す。`activityDate`は`completed_at`をJST変換して求める——
 * commitmentの`occurred_at`の日ではない。
 *
 * - windowは`completed_at`（completionが実際に観測された時刻）でフィルタする
 *   ——commitmentのoccurred_atではない。
 * - `ORDER BY user_id, completed_at`で読み、`(userId, activityKey, date)`
 *   ごとの最初の行だけを採用する——同日に同じactivityを1回完了しても100回
 *   完了してもfactは1件のまま。
 * - allowlist外の`activity_key`（DB corruption・writerバグ）はfail-closedで
 *   その行をskipする——`computeCasinoActivityDays()`と同じ考え方。
 */
export function computeCasinoCompletedActivityDays(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly CasinoCompletedActivityDayFact[] {
  if (userIds.length === 0) return [];

  const placeholders = userIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.user_id AS user_id, p.activity_key AS activity_key, c.completed_at AS completed_at
         FROM casino_participation_completions c
         JOIN casino_participations p
           ON p.participation_key = c.participation_key AND p.user_id = c.user_id
        WHERE c.user_id IN (${placeholders}) AND c.completed_at >= ? AND c.completed_at < ?
        ORDER BY c.user_id ASC, c.completed_at ASC, p.activity_key ASC`,
    )
    .all(...userIds, window.start, window.end) as Array<{ user_id: string; activity_key: string; completed_at: number }>;

  const seen = new Set<string>();
  const facts: CasinoCompletedActivityDayFact[] = [];
  for (const row of rows) {
    if (!isCasinoActivityKey(row.activity_key)) continue; // 未知/corrupt activity_keyはfail-closedでignore
    const activityKey = row.activity_key;
    const activityDate = jstDateStr(new Date(row.completed_at * 1000));
    const dedupeKey = `${row.user_id} ${activityKey} ${activityDate}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    facts.push({ userId: row.user_id, activityKey, activityDate, completedAt: row.completed_at });
  }
  return facts;
}
