import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Shop } from "../src/shop/service.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  ledger.ensureAccount("user:user1", "user");
  ledger.transfer({
    from: TREASURY,
    to: "user:user1",
    amount: 100_000,
    type: "initial",
    actor: "test",
    idempotencyKey: "fund:user1",
  });
  const shop = new Shop(db, ledger, new EventLog(db));
  const createRoleItem = (name: string, roleId: string, deliveryData = JSON.stringify({ role_id: roleId })) =>
    shop.createItem(
      {
        name,
        price_land: 100,
        kind: "monthly",
        delivery: "auto",
        delivery_kind: "add_role",
        delivery_data: deliveryData,
      },
      "staff",
    );
  return { db, shop, createRoleItem };
}

/** 期限を過去にして、失効スイープの対象にする */
function lapse(db: ReturnType<typeof openDb>, purchaseId: number) {
  db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);
}

/**
 * 購入したあと**実際に配送する**。提供していない購入の失効では、
 * 与えていないロールを剥がすことになるので剥奪キューへ載らない。
 */
function deliver(shop: Shop, purchaseId: number) {
  shop.beginDelivery(purchaseId);
  shop.markDeliverySucceeded(purchaseId, "system:test");
}

describe("ショップ 失効時のロール剥奪キュー", () => {
  it("失効購入Aの後に同じ商品を再購入Bした場合、有効購入が同じロールを保護する", () => {
    const { shop, createRoleItem, db } = setup();
    const item = createRoleItem("月額A", "role_old");
    const a = shop.purchase({ expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    deliver(shop, a.id);
    lapse(db, a.id);
    shop.expireOverdue("system:test");
    const b = shop.purchase({ expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    deliver(shop, b.id);

    expect(b.status).toBe("active");
    expect(shop.activePurchaseProvesRoleEntitlement("user1", "role_old", a.id)).toBe(true);
  });

  it("同じrole_idを与える別商品がactiveの場合もロールを保護する", () => {
    const { shop, createRoleItem, db } = setup();
    const aItem = createRoleItem("月額A", "role_shared");
    const bItem = createRoleItem("月額B", "role_shared");
    const a = shop.purchase({ expectedTermsToken: shop.quoteGenericPurchase(aItem.id).termsToken, itemId: aItem.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    deliver(shop, a.id);
    lapse(db, a.id);
    shop.expireOverdue("system:test");
    const b2 = shop.purchase({ expectedTermsToken: shop.quoteGenericPurchase(bItem.id).termsToken, itemId: bItem.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    deliver(shop, b2.id);

    expect(shop.activePurchaseProvesRoleEntitlement("user1", "role_shared", a.id)).toBe(true);
  });

  it("active購入がなければ保護しない", () => {
    const { shop, createRoleItem, db } = setup();
    const item = createRoleItem("月額A", "role_old");
    const a = shop.purchase({ expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    deliver(shop, a.id);
    lapse(db, a.id);
    shop.expireOverdue("system:test");

    expect(shop.activePurchaseProvesRoleEntitlement("user1", "role_old", a.id)).toBe(false);
  });

  it("商品設定のrole_idを後から変更しても、購入時スナップショットのロールを剥奪対象にする", () => {
    const { shop, createRoleItem, db } = setup();
    const item = createRoleItem("月額A", "role_old");
    const a = shop.purchase({ expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    deliver(shop, a.id);
    shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "role_new" }) }, "staff");
    lapse(db, a.id);
    shop.expireOverdue("system:test");

    expect(shop.pendingRoleRevocations()[0]?.role_id).toBe("role_old");
  });

  it("delivery_data不正の購入があっても、他の正常購入は処理候補に残る", () => {
    const { shop, createRoleItem, db } = setup();
    const bad = createRoleItem("bad", "unused");
    const good = createRoleItem("good", "role_good");
    // 購入時の記録が壊れていて対象を証明できない**旧購入**（provenance導入前の形）
    const badId = Number(
      db
        .prepare(
          "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_snapshot_json,delivered_at,delivery_state)" +
            " VALUES (?,?,?,?, 'active',0,'{',?, 'delivered')",
        )
        .run(bad.id, "user1", 1_700_000_000, 100, 1_700_000_500).lastInsertRowid,
    );
    const pBad = shop.getPurchase(badId)!;
    const pGood = shop.purchase({ expectedTermsToken: shop.quoteGenericPurchase(good.id).termsToken, itemId: good.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    deliver(shop, pGood.id);
    lapse(db, pBad.id);
    lapse(db, pGood.id);
    shop.expireOverdue("system:test");

    expect(shop.pendingRoleRevocations().map((r) => r.purchase_id)).toEqual([pGood.id]);
    // 対象を証明できない旧購入は**キューへ載せない**（推測して剥がさない）。
    // 黙って消すのでもなく、運営の確認待ちとして見える。
    expect(db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(pBad.id)).toBeUndefined();
    expect(shop.listUnresolvedExpiryRevocations().map((r) => r.id)).toContain(pBad.id);
    expect(shop.countUnresolvedExpiryRevocations()).toBe(1);
  });
});
