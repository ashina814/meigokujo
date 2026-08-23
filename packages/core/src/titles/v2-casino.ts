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
 * PR #166レビューBLOCKER1: `recordCompletedParticipation()`はwriter時点で
 * commitment/participant set不一致・partial completion行・mixed completed_at・
 * completed_at<occurred_atをすべてfail-closedでreject済みだが、DB corruption
 * （直接SQL操作・マイグレーションミス等）はwriter APIを経由しないため、reader側
 * でも同じ7条件を`participation_key`ごとに独立して再検証する——1条件でも
 * 満たさないgroupは、そのgroupの行をまとめて（1人分だけでも）一切emitしない。
 * `casino_completed_activity_days`は`titleUsable:true`/`orderable:true`なので、
 * 壊れた`completedAt`が`earnedAt`証拠として使われることを防ぐ必要がある。
 *
 * 検証する7条件（`participation_key`ごと）:
 *   1. commitment行が存在する
 *   2. commitment行: `activity_key`が全行で一致
 *   3. commitment行: `occurred_at`が全行で一致
 *   4. completion参加者set === commitment参加者set（完全一致、部分一致はNG）
 *   5. completion行: `completed_at`が全行で一致
 *   6. `completed_at >= occurred_at`
 *   7. `activity_key`が`CASINO_ACTIVITY_KEYS`allowlistに含まれる
 *
 * 相手（counterpart）userIdはgroup検証のために内部で読むが、safe payloadには
 * 一切出さない——requestされた`userIds`に含まれる参加者の分だけfactを返す。
 *
 * PR #166レビューBLOCKER3: candidate participationKeyの集合をSQL host parameter
 * （`IN (?,?,...)`）へ展開してはならない——D1が`userIds`を`BULK_USER_CHUNK_SIZE`で
 * chunkしているのはSQLiteのbind変数上限を守るためであり、historicalに無制限へ
 * 増え得るparticipationKey数をそのままbind変数へ展開すると同じ上限へ再度衝突する
 * （global scopeでは1 userチャンクでも累積completion件数はいくらでも増え得る）。
 * そのためcandidate keyの算出はCTE（`candidate_keys`）で行い、commitment/completion
 * どちらのfull group取得もそのCTEへJOINする形にする——bind変数は常に「requested
 * userIds（既に上限済み）+ window境界2個」だけに保たれ、candidate key数には
 * 一切依存しない。
 */
export function computeCasinoCompletedActivityDays(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly CasinoCompletedActivityDayFact[] {
  if (userIds.length === 0) return [];

  const requestedUserIds = new Set(userIds);
  const userPlaceholders = userIds.map(() => "?").join(",");
  const candidateKeysCte = `
    WITH candidate_keys AS (
      SELECT DISTINCT participation_key FROM casino_participation_completions
       WHERE user_id IN (${userPlaceholders}) AND completed_at >= ? AND completed_at < ?
    )`;
  const bindParams = [...userIds, window.start, window.end];

  const completionRows = db
    .prepare(
      `${candidateKeysCte}
       SELECT c.participation_key AS participation_key, c.user_id AS user_id, c.completed_at AS completed_at
         FROM casino_participation_completions c
         JOIN candidate_keys k ON k.participation_key = c.participation_key`,
    )
    .all(...bindParams) as Array<{ participation_key: string; user_id: string; completed_at: number }>;
  if (completionRows.length === 0) return [];

  const commitmentRows = db
    .prepare(
      `${candidateKeysCte}
       SELECT p.participation_key AS participation_key, p.user_id AS user_id,
              p.activity_key AS activity_key, p.occurred_at AS occurred_at
         FROM casino_participations p
         JOIN candidate_keys k ON k.participation_key = p.participation_key`,
    )
    .all(...bindParams) as Array<{
    participation_key: string;
    user_id: string;
    activity_key: string;
    occurred_at: number;
  }>;

  const commitmentsByKey = new Map<string, typeof commitmentRows>();
  for (const row of commitmentRows) {
    const group = commitmentsByKey.get(row.participation_key);
    if (group) group.push(row);
    else commitmentsByKey.set(row.participation_key, [row]);
  }
  const completionsByKey = new Map<string, typeof completionRows>();
  for (const row of completionRows) {
    const group = completionsByKey.get(row.participation_key);
    if (group) group.push(row);
    else completionsByKey.set(row.participation_key, [row]);
  }
  const candidateKeys = [...completionsByKey.keys()];

  const seen = new Set<string>();
  const facts: CasinoCompletedActivityDayFact[] = [];
  for (const participationKey of candidateKeys) {
    const commitment = commitmentsByKey.get(participationKey);
    if (!commitment || commitment.length === 0) continue; // 条件1: commitment行が存在する

    const commitmentActivityKey = commitment[0]!.activity_key;
    const commitmentOccurredAt = commitment[0]!.occurred_at;
    const commitmentConsistent = commitment.every(
      (r) => r.activity_key === commitmentActivityKey && r.occurred_at === commitmentOccurredAt,
    );
    if (!commitmentConsistent) continue; // 条件2・3: activity_key/occurred_atが全行一致

    if (!isCasinoActivityKey(commitmentActivityKey)) continue; // 条件7: allowlistに含まれる
    const activityKey = commitmentActivityKey;

    const completion = completionsByKey.get(participationKey);
    if (!completion || completion.length === 0) continue; // completion行が無いgroupは対象外

    const commitmentUserIds = [...new Set(commitment.map((r) => r.user_id))].sort();
    const completionUserIds = [...new Set(completion.map((r) => r.user_id))].sort();
    const sameParticipantSet =
      commitmentUserIds.length === completionUserIds.length &&
      commitmentUserIds.every((id, i) => id === completionUserIds[i]);
    if (!sameParticipantSet) continue; // 条件4: 完全な参加者set一致（部分一致はNG）

    const completedAt = completion[0]!.completed_at;
    const completionConsistent = completion.every((r) => r.completed_at === completedAt);
    if (!completionConsistent) continue; // 条件5: completed_atが全行一致

    if (completedAt < commitmentOccurredAt) continue; // 条件6: completed_at >= occurred_at
    if (completedAt < window.start || completedAt >= window.end) continue; // window境界の再確認

    const activityDate = jstDateStr(new Date(completedAt * 1000));
    for (const userId of completionUserIds) {
      if (!requestedUserIds.has(userId)) continue; // 相手(counterpart)のuserIdはpayloadへ出さない
      const dedupeKey = `${userId} ${activityKey} ${activityDate}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      facts.push({ userId, activityKey, activityDate, completedAt });
    }
  }
  // candidateKeysの列挙順（`SELECT DISTINCT`）はSQLiteの内部実装依存で保証されないため、
  // 呼び出し側から見て決定的な順序（旧実装と同じ契約）へ明示的に揃える。
  facts.sort((a, b) => {
    if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
    if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
    return a.activityKey < b.activityKey ? -1 : a.activityKey > b.activityKey ? 1 : 0;
  });
  return facts;
}
