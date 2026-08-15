import { describe, expect, it } from "vitest";
import { formatShopPurchaseLog } from "../src/outbox.js";

describe("shop purchase log formatting", () => {
  it("通常Land購入を読みやすく表示する", () => {
    const text = formatShopPurchaseLog(JSON.stringify({
      purchaseId: 42,
      transactionId: 99,
      itemName: "通話部屋30日",
      userId: "123",
      paidLand: 50000,
      paidAltKind: null,
      paidAltAmount: null,
      purchasedAt: 1800000000,
      deliveryMode: "auto",
      deliveryKind: "add_role",
      workType: null,
      source: "shop_purchase",
    }));
    expect(text).toContain("公式ショップ購入");
    expect(text).toContain("購入 #42 / 取引 #99");
    expect(text).toContain("<@123>");
    expect(text).toContain("通話部屋30日");
    expect(text).toContain("Land / 50,000 Ld");
    expect(text).toContain("auto / add_role");
    expect(text).toContain("<t:1800000000:F>");
  });

  it("代替支払いと特殊購入のticket/staff/work情報も表示する", () => {
    const alt = formatShopPurchaseLog(JSON.stringify({
      purchaseId: 43,
      transactionId: null,
      itemName: "再評価",
      userId: "123",
      paidLand: null,
      paidAltKind: "invite",
      paidAltAmount: 3,
      purchasedAt: 1800000001,
      deliveryMode: "manual",
      deliveryKind: null,
      workType: "special_work",
      source: "shop_purchase",
    }));
    expect(alt).toContain("代替（invite） / 3");
    expect(alt).toContain("special_work");

    const special = formatShopPurchaseLog(JSON.stringify({
      purchaseId: 44,
      transactionId: 100,
      itemName: "オリジナルロール",
      userId: "123",
      paidLand: 750000,
      paidAltKind: null,
      paidAltAmount: null,
      purchasedAt: 1800000002,
      deliveryMode: "manual",
      deliveryKind: null,
      workType: "original_role_invoice:new",
      ticketThreadId: "777",
      staffId: "user:555",
      invoiceId: 8,
      invoiceKind: "new",
      source: "original_role_invoice",
    }));
    expect(special).toContain("請求 #8 / 新規 / 担当 <@555>");
    expect(special).toContain("チケット: <#777>");
    expect(special).toContain("original_role_invoice:new");
  });
});
