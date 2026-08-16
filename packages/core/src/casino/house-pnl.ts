import { HOUSE_HOLDER } from "./chip-ledger.js";

/**
 * 胴元損益に算入する取引種別。
 *
 * 対人順位卓の `table_start` / `table_settle` / `table_fee_refund` は
 * 2026-08-16 の退役で削除した。万一これらの取引が現れたら
 * {@link classifyHousePnlTx} は `unclassified` を返す——退役した機能を
 * 「既知の営業収入」として黙って受け入れないための fail-closed。
 */
export const OPERATING_HOUSE_GROUPS = new Set([
  "solo_game",
  "daily",
  "vip",
  "shop",
]);

export const EXCLUDED_HOUSE_GROUPS = new Set([
  "refund",
  "market_bet",
  "market_settle",
  "deposit",
  "redeem",
  "opening_reset",
  "remittance",
  "bailout",
]);

export type HousePnlClassification =
  | { kind: "operating"; amount: number }
  | { kind: "excluded" }
  | { kind: "unclassified" };

export interface HousePnlChipTx {
  group_kind: string;
  from_holder: string | null;
  to_holder: string | null;
  amount: number;
}

export function classifyHousePnlTx(row: HousePnlChipTx): HousePnlClassification {
  if (!OPERATING_HOUSE_GROUPS.has(row.group_kind)) {
    return EXCLUDED_HOUSE_GROUPS.has(row.group_kind) ? { kind: "excluded" } : { kind: "unclassified" };
  }
  const amount =
    row.to_holder === HOUSE_HOLDER
      ? row.amount
      : row.from_holder === HOUSE_HOLDER
        ? -row.amount
        : 0;
  return { kind: "operating", amount };
}
