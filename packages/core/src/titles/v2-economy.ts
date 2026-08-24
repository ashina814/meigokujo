import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";
import { loadEligibleShopPurchaseFacts, TITLE_ELIGIBLE_SHOP_ORIGINS } from "./v2-shop-purchases.js";

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

const EXCLUDED_ECONOMY_TRANSACTION_TYPES = [
  "opening", "initial", "salary", "pension", "vc_reward", "reward_boost", "reward_bump",
  "event_prize", "harvest", "insurance_payout", "room_refund", "shop_personal", "fanclub",
  "inheritance", "dept_in", "dept_out", "commission", "fine", "tax", "shop_official",
  "tip_burn", "event_fee", "insurance_premium", "room_fee", "adjust", "bet", "prize",
  "market_house_fee", "ether_buy", "ether_sell", "ether_burn", "ether_settle", "chip_deposit",
  "chip_redeem", "chip_fund", "chip_settle", "casino_remittance", "casino_bailout",
  "ether_house_fund",
] as const;

/**
 * Titles v2のstable economy semantic family manifest。knownTxTypes()やpublicLogから
 * 自動拡張しない。新機能を称号familyへ入れるには、このmanifestとregressionの明示reviewが必要。
 */
export const ECONOMY_FEATURE_FAMILY_MANIFEST = {
  peer_transfer: {
    canonicalSource: "ledger_transactions",
    eligibleProductionCallsites: ["commands/transfer.ts -> Ledger.transfer(type='transfer')"],
    eligibleTransactionTypes: ["transfer"],
    directions: ["inflow", "outflow"],
    hasHumanCounterpart: true,
    excludedSiblingTransactionTypes: EXCLUDED_ECONOMY_TRANSACTION_TYPES,
    normalCompletionBoundary: "Ledger.transfer committed with actor_id=from_account and human accounts on both sides",
    reversalHandling: "exclude reversal rows and originals reversed before fixed snapshot end",
  },
  tip: {
    canonicalSource: "ledger_transactions",
    eligibleProductionCallsites: ["commands/tip.ts -> Ledger.transfer(type='tip')"],
    eligibleTransactionTypes: ["tip"],
    directions: ["inflow", "outflow"],
    hasHumanCounterpart: true,
    excludedSiblingTransactionTypes: EXCLUDED_ECONOMY_TRANSACTION_TYPES,
    normalCompletionBoundary: "Ledger.transfer committed with actor_id=from_account and human accounts on both sides",
    reversalHandling: "exclude reversal rows and originals reversed before fixed snapshot end",
  },
  shop: {
    canonicalSource: "shop_purchase_title_provenance + shop_purchase_status_history",
    eligibleProductionCallsites: ["Shop.purchase() normal storefront flow"],
    eligibleOrigins: TITLE_ELIGIBLE_SHOP_ORIGINS,
    directions: ["outflow"],
    hasHumanCounterpart: false,
    excludedSiblingTransactionTypes: ["tip_burn", "shop_official", "adjust"],
    normalCompletionBoundary: "canonical shop_purchases row and immutable storefront provenance committed",
    reversalHandling: "exclude canonical refund/cancel occurrences before fixed snapshot end; delivery state is independent",
  },
} as const;

export type EconomyFeatureFamily = keyof typeof ECONOMY_FEATURE_FAMILY_MANIFEST;
export type NaturalEconomyDirection = "inflow" | "outflow";

export interface EconomySemanticSafePayload {
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly families: readonly EconomyFeatureFamily[];
    /** subject自身がこの日にoutflowとして利用したfamily。incomingは含めない。 */
    readonly subjectUsedFamilies: readonly EconomyFeatureFamily[];
    readonly directions: readonly NaturalEconomyDirection[];
    readonly distinctHumanCounterparts: number;
  }>;
  /** No.61用: inflow/outflow双方で観測したeconomy family全体。 */
  readonly distinctFamilies: number;
  /** No.63用: subject自身がoutflowとして正常利用したfamilyだけ。 */
  readonly subjectUsedFamilies: readonly EconomyFeatureFamily[];
  readonly distinctSubjectUsedFamilies: number;
  readonly distinctHumanCounterparts: number;
  readonly hasNaturalInflow: boolean;
  readonly hasNaturalOutflow: boolean;
  readonly outgoingTip: {
    readonly days: ReadonlyArray<{ readonly date: string; readonly distinctRecipients: number }>;
    readonly distinctRecipients: number;
  };
}

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

const LEDGER_FAMILY_BY_TYPE: ReadonlyMap<string, EconomyFeatureFamily> = new Map([
  ["transfer", "peer_transfer"],
  ["tip", "tip"],
]);
const FAMILY_ORDER = Object.keys(ECONOMY_FEATURE_FAMILY_MANIFEST) as EconomyFeatureFamily[];
const DIRECTION_ORDER: readonly NaturalEconomyDirection[] = ["inflow", "outflow"];

interface RestrictedEconomyActivity {
  readonly userId: string;
  readonly date: string;
  readonly family: EconomyFeatureFamily;
  readonly direction: NaturalEconomyDirection;
  readonly humanCounterpartId: string | null;
  readonly outgoingTipRecipientId: string | null;
}

function userIdFromAccount(account: string): string | null {
  if (!account.startsWith("user:")) return null;
  const userId = account.slice("user:".length);
  return userId.length > 0 ? userId : null;
}

/**
 * No.59/61/63用のthreshold-neutral aggregate。
 *
 * transaction reason/ref/publicLogはSELECTすらしない。explicit manifestのtransfer/tipと、
 * canonical storefront purchase provenanceだけをrestricted identity付きで集約した後、
 * safe count/day/family/directionへ畳む。
 */
export function computeEconomySemanticSafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): ReadonlyArray<{ readonly userId: string; readonly payload: EconomySemanticSafePayload }> {
  const subjectIds = new Set(userIds);
  const activities: RestrictedEconomyActivity[] = [];
  if (userIds.length > 0 && window.end > window.start) {
    const accounts = userIds.map((userId) => `user:${userId}`);
    const placeholders = accounts.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT t.from_account, t.to_account, t.type, t.created_at
         FROM transactions AS t
        WHERE (t.from_account IN (${placeholders}) OR t.to_account IN (${placeholders}))
          AND t.type IN ('transfer','tip')
          AND t.actor_id = t.from_account
          AND t.from_account LIKE 'user:%'
          AND t.to_account LIKE 'user:%'
          AND t.from_account <> t.to_account
          AND t.reversal_of IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM transactions AS r
             WHERE r.reversal_of = t.id AND r.created_at < ?
          )
          AND t.created_at >= ? AND t.created_at < ?
        ORDER BY t.created_at ASC, t.id ASC`,
    ).all(...accounts, ...accounts, window.end, window.start, window.end) as Array<{
      from_account: string;
      to_account: string;
      type: string;
      created_at: number;
    }>;
    for (const row of rows) {
      const family = LEDGER_FAMILY_BY_TYPE.get(row.type);
      const fromUserId = userIdFromAccount(row.from_account);
      const toUserId = userIdFromAccount(row.to_account);
      if (!family || !fromUserId || !toUserId || fromUserId === toUserId) continue;
      const date = jstDateStr(new Date(row.created_at * 1_000));
      if (subjectIds.has(fromUserId)) {
        activities.push({
          userId: fromUserId,
          date,
          family,
          direction: "outflow",
          humanCounterpartId: toUserId,
          outgoingTipRecipientId: row.type === "tip" ? toUserId : null,
        });
      }
      if (subjectIds.has(toUserId)) {
        activities.push({
          userId: toUserId,
          date,
          family,
          direction: "inflow",
          humanCounterpartId: fromUserId,
          outgoingTipRecipientId: null,
        });
      }
    }

    for (const purchase of loadEligibleShopPurchaseFacts(db, window, userIds)) {
      activities.push({
        userId: purchase.userId,
        date: purchase.date,
        family: "shop",
        direction: "outflow",
        humanCounterpartId: null,
        outgoingTipRecipientId: null,
      });
    }
  }

  interface DayAggregate {
    families: Set<EconomyFeatureFamily>;
    subjectUsedFamilies: Set<EconomyFeatureFamily>;
    directions: Set<NaturalEconomyDirection>;
    counterparts: Set<string>;
  }
  interface UserAggregate {
    days: Map<string, DayAggregate>;
    families: Set<EconomyFeatureFamily>;
    subjectUsedFamilies: Set<EconomyFeatureFamily>;
    counterparts: Set<string>;
    tipDays: Map<string, Set<string>>;
    tipRecipients: Set<string>;
    directions: Set<NaturalEconomyDirection>;
  }
  const byUser = new Map<string, UserAggregate>();
  for (const userId of userIds) {
    byUser.set(userId, {
      days: new Map(),
      families: new Set(),
      subjectUsedFamilies: new Set(),
      counterparts: new Set(),
      tipDays: new Map(),
      tipRecipients: new Set(),
      directions: new Set(),
    });
  }
  for (const activity of activities) {
    const aggregate = byUser.get(activity.userId);
    if (!aggregate) continue;
    aggregate.families.add(activity.family);
    aggregate.directions.add(activity.direction);
    const day = aggregate.days.get(activity.date) ?? {
      families: new Set<EconomyFeatureFamily>(),
      subjectUsedFamilies: new Set<EconomyFeatureFamily>(),
      directions: new Set<NaturalEconomyDirection>(),
      counterparts: new Set<string>(),
    };
    day.families.add(activity.family);
    day.directions.add(activity.direction);
    if (activity.direction === "outflow") {
      aggregate.subjectUsedFamilies.add(activity.family);
      day.subjectUsedFamilies.add(activity.family);
    }
    if (activity.humanCounterpartId !== null) {
      aggregate.counterparts.add(activity.humanCounterpartId);
      day.counterparts.add(activity.humanCounterpartId);
    }
    aggregate.days.set(activity.date, day);
    if (activity.outgoingTipRecipientId !== null) {
      aggregate.tipRecipients.add(activity.outgoingTipRecipientId);
      const recipients = aggregate.tipDays.get(activity.date) ?? new Set<string>();
      recipients.add(activity.outgoingTipRecipientId);
      aggregate.tipDays.set(activity.date, recipients);
    }
  }

  return userIds.map((userId) => {
    const aggregate = byUser.get(userId)!;
    return {
      userId,
      payload: {
        days: [...aggregate.days.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, day]) => ({
            date,
            families: FAMILY_ORDER.filter((family) => day.families.has(family)),
            subjectUsedFamilies: FAMILY_ORDER.filter((family) => day.subjectUsedFamilies.has(family)),
            directions: DIRECTION_ORDER.filter((direction) => day.directions.has(direction)),
            distinctHumanCounterparts: day.counterparts.size,
          })),
        distinctFamilies: aggregate.families.size,
        subjectUsedFamilies: FAMILY_ORDER.filter((family) => aggregate.subjectUsedFamilies.has(family)),
        distinctSubjectUsedFamilies: aggregate.subjectUsedFamilies.size,
        distinctHumanCounterparts: aggregate.counterparts.size,
        hasNaturalInflow: aggregate.directions.has("inflow"),
        hasNaturalOutflow: aggregate.directions.has("outflow"),
        outgoingTip: {
          days: [...aggregate.tipDays.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, recipients]) => ({ date, distinctRecipients: recipients.size })),
          distinctRecipients: aggregate.tipRecipients.size,
        },
      },
    };
  });
}
