import type Database from "better-sqlite3";
import {
  loadTrustedRoleFamilyIntervals,
  pointInTrustedRoleFamilyInterval,
} from "../role-family/domain-temporal.js";
import { loadEligibleShopPurchaseFacts } from "./v2-shop-purchases.js";

export interface ShopRolePurchaseSafePayload {
  readonly days: ReadonlyArray<{
    readonly date: string;
    readonly eligiblePurchaseCount: number;
  }>;
}

/**
 * No.65: existing storefront eligibility/refund classifierを再利用し、restricted purchased_at
 * pointをその時点でtrustedだったshop family intervalへJOINしてからidentity-freeな日別件数へ
 * 落とす。current roles/current departmentsはevaluation時に読まない。
 */
export function computeShopRolePurchaseSafe(
  db: Database.Database,
  window: { readonly start: number; readonly end: number },
  userIds: readonly string[],
): ReadonlyArray<{ readonly userId: string; readonly payload: ShopRolePurchaseSafePayload }> {
  const counts = new Map<string, Map<string, number>>();
  for (const userId of userIds) counts.set(userId, new Map());
  if (userIds.length === 0 || window.end <= window.start) {
    return userIds.map((userId) => ({ userId, payload: { days: [] } }));
  }

  const intervals = loadTrustedRoleFamilyIntervals(db, userIds, "shop", window);
  for (const purchase of loadEligibleShopPurchaseFacts(db, window, userIds)) {
    if (!pointInTrustedRoleFamilyInterval(intervals.get(purchase.userId) ?? [], purchase.purchasedAt)) continue;
    const days = counts.get(purchase.userId);
    if (days) days.set(purchase.date, (days.get(purchase.date) ?? 0) + 1);
  }

  return userIds.map((userId) => ({
    userId,
    payload: {
      days: [...counts.get(userId)!]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, eligiblePurchaseCount]) => ({ date, eligiblePurchaseCount })),
    },
  }));
}
