import type { Shop } from "@meigokujo/core";

/**
 * テスト用に在庫を設定する。**在庫を動かす正式経路をそのまま使う。**
 *
 * `updateItem({ stock })` は塞がれている（未処理の返金義務がある商品を有限へ戻すとき、
 * 運営が入力した数の意味を誰も決めないまま確定してしまうため）。未処理の義務が無い
 * 前提の fixture はこのヘルパを通す。
 */
export function setStock(shop: Shop, itemId: number, stock: number | null, actor = "staff"): void {
  const quote = shop.quoteStockChange(itemId, stock);
  if (quote.requiresReconciliation) {
    throw new Error("setStock: 未処理の返金在庫があります。テストでは明示的に applyStockChange を呼んでください");
  }
  shop.applyStockChange({
    itemId,
    requestedStock: stock,
    reconciliationMode: "none",
    expectedToken: quote.tokens.none!,
    actor,
  });
}
