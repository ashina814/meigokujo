import { HOUSE_HOLDER } from "./chip-ledger.js";

/**
 * 胴元損益に算入する取引種別。
 *
 * **`table_settle` / `table_refund` という group kind 自体は退役していない。**
 * ルーレット・`/勝負` の対人ゲーム・競馬が現在も精算・返金に使っている。
 * ただしそれらの経路で抜く場代は `jackpot` 行きで、`house` を動かさない
 * （胴元損益の集計は `house` を触る取引だけを読むので、そもそも到達しない）。
 *
 * 退役したのは group kind ではなく、**`table_*` で `house` の収支を動かす経路**
 * ——つまり対人順位卓の場代・精算だけ。これらがここに載っていないため、
 * 万一 `table_*` の house 取引が現れたら {@link classifyHousePnlTx} は
 * `unclassified` を返し、納付処理が fail-closed で止まる。
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
