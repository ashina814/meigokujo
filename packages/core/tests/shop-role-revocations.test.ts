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

describe("ショップ 失効時のロール剥奪キュー", () => {
  it("失効購入Aの後に同じ商品を再購入Bした場合、有効購入が同じロールを保護する", () => {
    const { shop, createRoleItem, db } = setup();
    const item = createRoleItem("月額A", "role_old");
    const a = shop.purchase({ itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    lapse(db, a.id);
    shop.expireOverdue("system:test");
    const b = shop.purchase({ itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;

    expect(b.status).toBe("active");
    expect(shop.activePurchaseGrantsRole("user1", "role_old", a.id)).toBe(true);
  });

  it("同じrole_idを与える別商品がactiveの場合もロールを保護する", () => {
    const { shop, createRoleItem, db } = setup();
    const aItem = createRoleItem("月額A", "role_shared");
    const bItem = createRoleItem("月額B", "role_shared");
    const a = shop.purchase({ itemId: aItem.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    lapse(db, a.id);
    shop.expireOverdue("system:test");
    shop.purchase({ itemId: bItem.id, userId: "user1", actor: "user1", memberRoleIds: [] });

    expect(shop.activePurchaseGrantsRole("user1", "role_shared", a.id)).toBe(true);
  });

  it("active購入がなければ保護しない", () => {
    const { shop, createRoleItem, db } = setup();
    const item = createRoleItem("月額A", "role_old");
    const a = shop.purchase({ itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    lapse(db, a.id);
    shop.expireOverdue("system:test");

    expect(shop.activePurchaseGrantsRole("user1", "role_old", a.id)).toBe(false);
  });

  it("商品設定のrole_idを後から変更しても、購入時スナップショットのロールを剥奪対象にする", () => {
    const { shop, createRoleItem, db } = setup();
    const item = createRoleItem("月額A", "role_old");
    const a = shop.purchase({ itemId: item.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "role_new" }) }, "staff");
    lapse(db, a.id);
    shop.expireOverdue("system:test");

    expect(shop.pendingRoleRevocations()[0]?.role_id).toBe("role_old");
  });

  it("delivery_data不正の購入があっても、他の正常購入は処理候補に残る", () => {
    const { shop, createRoleItem, db } = setup();
    const bad = createRoleItem("bad", "unused", "{");
    const good = createRoleItem("good", "role_good");
    const pBad = shop.purchase({ itemId: bad.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    const pGood = shop.purchase({ itemId: good.id, userId: "user1", actor: "user1", memberRoleIds: [] }).purchase;
    lapse(db, pBad.id);
    lapse(db, pGood.id);
    shop.expireOverdue("system:test");

    expect(shop.pendingRoleRevocations().map((r) => r.purchase_id)).toEqual([pGood.id]);
    const failed = db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(pBad.id) as { status: string };
    expect(failed.status).toBe("failed");
  });
});
