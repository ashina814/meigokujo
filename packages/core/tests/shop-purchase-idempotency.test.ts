import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * 同じ人が同じ商品を**1秒以内に2回**買う場面がある。
 *
 * 例: 作成に失敗して自動返金され、そのまま買い直す。既定の冪等鍵は秒までしか分けないため、
 * 2回目の課金が「同じ課金の再送」と見なされ、**Land が動かないまま購入行だけができる**。
 * 呼び出し側が操作ごとの鍵を渡せば、ここが閉じる。
 */

registerDefaultTxTypes();
const USER = "111111111111111111";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const item = shop.createItem({ name: "何か", price_land: 1_000, kind: "one_shot", delivery: "manual" }, "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 10_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed",
  });
  return { db, ledger, shop, item };
}

describe("同じ秒の2回目の購入", () => {
  const buy = (ctx: ReturnType<typeof setup>, key?: string) =>
    ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken, userId: USER, itemId: ctx.item.id, actor: "t", memberRoleIds: [], idempotencyKey: key });

  it("**操作ごとの鍵を渡せば、2回目もきちんと課金される**", () => {
    const ctx = setup();

    buy(ctx, "op:1");
    buy(ctx, "op:2");

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(8_000);
    ctx.db.close();
  });

  it("同じ鍵なら課金は1回（二度押しは重ねて引かない）", () => {
    const ctx = setup();

    buy(ctx, "op:1");
    buy(ctx, "op:1");

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(9_000);
    ctx.db.close();
  });
});
