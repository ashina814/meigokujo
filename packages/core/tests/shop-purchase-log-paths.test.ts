import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `purchaseInternal()` だけを直して安心しないためのsource boundary。
 * shop_purchases の生成経路が増えたら、このテストを更新するまでCIを落とす。
 */
describe("shop purchase log creation paths", () => {
  it("すべてのshop_purchases生成経路が共通購入ログenqueueを通る", () => {
    const source = readFileSync(new URL("../src/shop/service.ts", import.meta.url), "utf8");
    expect(source.match(/INSERT INTO shop_purchases/g) ?? []).toHaveLength(3);
    expect(source.match(/this\.enqueueShopPurchaseLog\(/g) ?? []).toHaveLength(3);
  });
});
