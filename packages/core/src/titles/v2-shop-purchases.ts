import type Database from "better-sqlite3";
import { jstDateStr } from "../entry/sessions.js";

/**
 * No.62のeligible商品contract。
 *
 * `storefront`はShop.purchase()の通常客導線だけ。original-role、再評価、評価延長、
 * legacy migrationは同じshop_purchases表へ入るがeligibleではない。item名・現在の
 * enabled/delivery設定・request/reasonからoriginを推測しない。
 */
export const TITLE_ELIGIBLE_SHOP_ORIGINS = ["storefront"] as const;

export interface ShopPurchaseSafePayload {
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly distinctEligibleProducts: number;
  }>;
  readonly distinctEligibleProducts: number;
}

/** restricted aggregate用。productKey/userIdはsafe payloadへ出さない。 */
export interface EligibleShopPurchaseFact {
  readonly userId: string;
  readonly productKey: string;
  readonly date: string;
  /** Restricted point occurrence used by F3b role-at-purchase JOIN. */
  readonly purchasedAt: number;
}

/**
 * 購入時に凍結したprovenanceだけを読む。shop_items/current status/request_jsonや
 * natural-language reasonは一切参照しない。refund/cancelはappend-only status historyを
 * fixed snapshot endで切るため、future reversalが過去snapshotを変えない。
 */
export function loadEligibleShopPurchaseFacts(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): readonly EligibleShopPurchaseFact[] {
  if (userIds.length === 0 || window.end <= window.start) return [];
  const placeholders = userIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT p.user_id, p.product_key, p.purchased_at
       FROM shop_purchase_title_provenance AS p
      WHERE p.user_id IN (${placeholders})
        AND p.origin = 'storefront'
        AND p.title_eligible = 1
        AND p.purchased_at >= ? AND p.purchased_at < ?
        AND NOT EXISTS (
          SELECT 1
            FROM shop_purchase_status_history AS h
           WHERE h.purchase_id = p.purchase_id
             AND h.status IN ('refunded','cancelled')
             AND h.occurred_at < ?
        )
      ORDER BY p.user_id ASC, p.purchased_at ASC, p.purchase_id ASC`,
  ).all(...userIds, window.start, window.end, window.end) as Array<{
    user_id: string;
    product_key: string;
    purchased_at: number;
  }>;
  return rows.map((row) => ({
    userId: row.user_id,
    productKey: row.product_key,
    date: jstDateStr(new Date(row.purchased_at * 1_000)),
    purchasedAt: row.purchased_at,
  }));
}

export function computeShopPurchaseSafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): ReadonlyArray<{ readonly userId: string; readonly payload: ShopPurchaseSafePayload }> {
  const facts = loadEligibleShopPurchaseFacts(db, window, userIds);
  const byUser = new Map<string, { products: Set<string>; byDate: Map<string, Set<string>> }>();
  for (const userId of userIds) byUser.set(userId, { products: new Set(), byDate: new Map() });
  for (const fact of facts) {
    const aggregate = byUser.get(fact.userId);
    if (!aggregate) continue;
    aggregate.products.add(fact.productKey);
    const daily = aggregate.byDate.get(fact.date) ?? new Set<string>();
    daily.add(fact.productKey);
    aggregate.byDate.set(fact.date, daily);
  }
  return userIds.map((userId) => {
    const aggregate = byUser.get(userId)!;
    return {
      userId,
      payload: {
        days: [...aggregate.byDate.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, products]) => ({ date, distinctEligibleProducts: products.size })),
        distinctEligibleProducts: aggregate.products.size,
      },
    };
  });
}
