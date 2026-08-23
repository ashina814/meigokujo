import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";

/**
 * Economy Safe Classification（PR E2）。
 *
 * raw `transactions`には salary/pension/fine/tax/bet/prize/casino chip/department等
 * 多数のdomainが同居し、amount・counterparty・reason・ref・approved_byといった機微データも
 * 含む——`transactions`自体は`titleUsable:false`（`v2-contract.ts`の`ledger_transactions`、
 * `restrictedUse:"economy_safe_classification"`）のまま。このmoduleだけが、厳密に
 * `transfer`/`tip`だけを対象にした、identity-minimized + amount-minimized + count-minimized
 * なsafe factへ変換する——generic title ruleは常に`economy_safe_peer_actions`（derived、
 * safe、titleUsable:true）経由でしかこの結果を読めない。
 *
 * **exact allowlist（内部のみ）**: `transfer`/`tip`だけ。`knownTxTypes()`から
 * `publicLog:true`のtypeを動的採用しない——将来型が追加されても、明示的コード変更・
 * レビュー無しではsafe boundaryが広がらない。`tip_burn`は同じ「投げ銭」文脈に見えるが
 * 実際には(A)Bot宛投げ銭 (B)公式ショップ購入 (C)ショップ延長 (D)オリジナルロール請求等
 * 複数domainに使われ意味が一意ではないため、意図的に除外する（to_accountがuser account
 * ではない＝`sys:treasury`宛のため、下記query自体もtip_burnを拾わない構造になっている）。
 */
const SAFE_PEER_ECONOMY_TYPES = ["transfer", "tip"] as const;
export type SafePeerEconomyActionKind = (typeof SAFE_PEER_ECONOMY_TYPES)[number];

export interface SafeEconomyPeerActionFact {
  readonly userId: string;
  readonly kind: SafePeerEconomyActionKind;
  readonly date: string;
  readonly occurredAt: number;
}

function extractUserId(fromAccount: string): string | null {
  if (!fromAccount.startsWith("user:")) return null;
  const id = fromAccount.slice("user:".length);
  return id.length > 0 ? id : null;
}

/**
 * `userIds`（subject候補、`from_account = user:<id>`側だけを見る——受取専用の行動は
 * 数えない、§15）について、`[window.start, window.end)`の間に本人が実行した安全な
 * 対人経済行動を、`user × JST date × kind`で最大1件へ畳み込んで返す。
 *
 * 安全性の全条件（すべてSQL WHEREで絞り込む——JS側の後処理でamount等を読み捨てるのではなく、
 * SELECTする列自体を最小化する、§25, §40）:
 * - `type IN ('transfer', 'tip')`——exact allowlistだけ。
 * - `actor_id = from_account`——本人が実行した取引だけ（staff/system代行を除外、§16）。
 * - `t.reversal_of IS NULL`——reversal transaction自体はfactを作らない。
 * - `NOT EXISTS (... r.reversal_of = t.id AND r.created_at < window.end)`——
 *   evaluation snapshot時点ですでにreverse済みのoriginal transactionもfactを作らない。
 *   future reversalはhistorical snapshotを書き換えず、`window.end`ちょうどのreversalも
 *   `[start, end)`契約上はまだ成立していないものとして扱う。
 * - `to_account LIKE 'user:%'`——相手も利用者口座（system口座宛のtip_burn等を除外）。
 *
 * dedupeは`ORDER BY from_account, created_at, id`で読み、`(userId, date, kind)`ごとの
 * 最初の行だけを採用する——invalid originalをSQLで先に除外するため、同日の最初の
 * transactionがreverse済みでも、後続のvalid transactionがfactを作る。同日に同じkindを
 * 何度実行してもfactは1件のまま（§21-22）。`occurredAt`はsnapshot内で最初のvalid
 * qualifying transactionの`created_at`——first valid qualifying observation（§23）。
 */
export function computeSafeEconomyPeerActions(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly SafeEconomyPeerActionFact[] {
  if (userIds.length === 0) return [];

  const fromAccounts = userIds.map((id) => `user:${id}`);
  const fromPlaceholders = fromAccounts.map(() => "?").join(",");
  const typePlaceholders = SAFE_PEER_ECONOMY_TYPES.map(() => "?").join(",");

  // SELECTはfrom_account/type/created_atだけ——amount・to_account・reason・ref・
  // approved_by・idempotency_key・reversal_ofはSELECT文自体に含めない。
  const rows = db
    .prepare(
      `SELECT from_account, type, created_at FROM transactions AS t
        WHERE t.from_account IN (${fromPlaceholders})
          AND t.type IN (${typePlaceholders})
          AND t.actor_id = t.from_account
          AND t.reversal_of IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM transactions AS r
             WHERE r.reversal_of = t.id
               AND r.created_at < ?
          )
          AND t.to_account LIKE 'user:%'
          AND t.created_at >= ? AND t.created_at < ?
        ORDER BY t.from_account ASC, t.created_at ASC, t.id ASC`,
    )
    .all(...fromAccounts, ...SAFE_PEER_ECONOMY_TYPES, window.end, window.start, window.end) as Array<{
    from_account: string;
    type: string;
    created_at: number;
  }>;

  const seen = new Set<string>();
  const facts: SafeEconomyPeerActionFact[] = [];
  for (const row of rows) {
    const userId = extractUserId(row.from_account);
    if (!userId) continue; // 不正/corrupt account文字列はfail-closedでignore（§26）
    const kind = row.type as SafePeerEconomyActionKind;
    const date = jstDateStr(new Date(row.created_at * 1000));
    const dedupeKey = `${userId} ${date} ${kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    facts.push({ userId, kind, date, occurredAt: row.created_at });
  }
  return facts;
}
