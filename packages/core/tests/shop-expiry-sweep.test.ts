import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Shop } from "../src/shop/service.js";

registerDefaultTxTypes();

/**
 * 期限切れの失効が、課金から独立して動くか。
 *
 * 以前は失効判定が月次一括請求の中にしか無かった。つまり請求を止めた瞬間に
 * 「期限は過ぎているのに失効しない＝権利が剥がれない」状態になる構造だった。
 * 自動更新を廃止するので、ここを完全に切り離したことをテストで固定する。
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  return { db, ledger, events, shop };
}

type Ctx = ReturnType<typeof setup>;

function roleItem(ctx: Ctx, name: string, roleId: string) {
  return ctx.shop.createItem(
    {
      name,
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: roleId }),
    },
    "staff",
  );
}

function fund(ctx: Ctx, userId: string, amount: number) {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: `seed:${userId}:${amount}`,
  });
}

/**
 * 購入したあと**実際に配送する**。本番では自動配送がロールを付けてから期限が来る。
 * 提供していない購入の失効でロールを剥がすことはできないので、
 * 剥奪キューを見るテストではここを通す必要がある。
 */
function deliver(ctx: Ctx, purchaseId: number) {
  ctx.shop.beginDelivery(purchaseId);
  ctx.shop.markDeliverySucceeded(purchaseId, "system:test");
  return purchaseId;
}

const pendingRevocations = (ctx: Ctx) =>
  ctx.db.prepare("SELECT purchase_id, role_id, status FROM shop_role_revocations ORDER BY purchase_id").all();

describe("期限切れの失効（課金から独立）", () => {
  it("期限が来た購入を失効させ、ロール剥奪キューへ積む", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    deliver(ctx, p.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(p.id);

    const { expired, failed } = ctx.shop.expireOverdue("system:test");

    expect(expired.map((row) => row.id)).toEqual([p.id]);
    expect(failed).toEqual([]);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("expired");
    expect(pendingRevocations(ctx)).toEqual([{ purchase_id: p.id, role_id: "role_a", status: "pending" }]);
    expect(ctx.events.listByType("shop_expired")).toHaveLength(1);
    ctx.db.close();
  });

  it("**失効しても課金しない**（自動更新は廃止）", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    deliver(ctx, p.id);
    const balanceAfterPurchase = ctx.ledger.balanceOf("user:u1");
    ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(p.id);

    ctx.shop.expireOverdue("system:test");
    ctx.shop.expireOverdue("system:test");

    expect(ctx.ledger.balanceOf("user:u1")).toBe(balanceAfterPurchase);
    // 期限を延ばす更新も勝手に起きない
    expect(ctx.shop.getPurchase(p.id)!.expires_at).toBe(1);
    ctx.db.close();
  });

  it("期限前のものには触れない", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    deliver(ctx, p.id);

    expect(ctx.shop.expireOverdue("system:test").expired).toEqual([]);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(pendingRevocations(ctx)).toEqual([]);
    ctx.db.close();
  });

  it("期限を持たない単発商品は失効しない", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({ name: "単発", price_land: 100, kind: "one_shot", delivery: "manual" }, "staff");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    deliver(ctx, p.id);

    expect(ctx.shop.expireOverdue("system:test").expired).toEqual([]);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("何度巡回しても二重に処理しない", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    deliver(ctx, p.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(p.id);

    ctx.shop.expireOverdue("system:test");
    const second = ctx.shop.expireOverdue("system:test");

    expect(second.expired).toEqual([]);
    expect(ctx.events.listByType("shop_expired")).toHaveLength(1);
    expect(pendingRevocations(ctx)).toHaveLength(1);
    ctx.db.close();
  });

  it("複数件をまとめて失効させ、1件ずつ確定する", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    for (const u of ["u1", "u2", "u3"]) {
      fund(ctx, u, 1_000);
      const p = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: u, actor: u, memberRoleIds: [] }).purchase;
      deliver(ctx, p.id);
      ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(p.id);
    }

    const { expired } = ctx.shop.expireOverdue("system:test");

    expect(expired).toHaveLength(3);
    expect(pendingRevocations(ctx)).toHaveLength(3);
    ctx.db.close();
  });

  it("同じロールを与える有効な購入が残っていれば、剥奪キューは後段で守られる", () => {
    // 剥奪の実行側（bot）が使う判定。失効＝即剥奪ではないことをここでも確かめる
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const old = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    deliver(ctx, old.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(old.id);
    ctx.shop.expireOverdue("system:test");
    const next = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;

    // 買っただけでは古い失効を守り切らない。提供されたか未確定のうちは
    // 「剥がさないが、完了にもしない」として持ち越す（後で返金されることがある）。
    expect(ctx.shop.activeRoleEntitlementState("u1", "role_a", old.id)).toBe("unsettled");
    expect(ctx.shop.activePurchaseProvesRoleEntitlement("u1", "role_a", old.id)).toBe(false);

    // 提供されたと分かって初めて、古い失効を守る根拠になる。
    // 判定は購入時の事実だけで行う（現在の商品設定は見ない）
    deliver(ctx, next.id);
    expect(ctx.shop.activeRoleEntitlementState("u1", "role_a", old.id)).toBe("delivered");
    expect(ctx.shop.activePurchaseProvesRoleEntitlement("u1", "role_a", old.id)).toBe(true);
    ctx.db.close();
  });

  it("先頭1件が失敗しても、後続の期限切れは失効し剥奪キューへ進む", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    const ids: number[] = [];
    for (const u of ["u1", "u2", "u3"]) {
      fund(ctx, u, 1_000);
      const p = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: u, actor: u, memberRoleIds: [] }).purchase;
      deliver(ctx, p.id);
      ctx.db.prepare("UPDATE shop_purchases SET expires_at = ? WHERE id = ?").run(ids.length + 1, p.id);
      ids.push(p.id);
    }
    // 先頭（期限が最も古い＝u1）の剥奪キュー登録だけを失敗させる
    const head = ids[0]!;
    ctx.db
      .prepare(
        `CREATE TRIGGER fail_head BEFORE INSERT ON shop_role_revocations
           WHEN NEW.purchase_id = ${head}
           BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
      )
      .run();

    const { expired, failed } = ctx.shop.expireOverdue("system:test");

    // 失敗した1件は active のまま残り、次の巡回で再試行できる
    expect(failed.map((f) => f.purchaseId)).toEqual([head]);
    expect(ctx.shop.getPurchase(head)!.status).toBe("active");
    expect(ctx.events.listByType("shop_expire_failed")).toHaveLength(1);
    // 後続はきちんと失効し、剥奪キューにも積まれている
    expect(expired.map((p) => p.id)).toEqual(ids.slice(1));
    for (const id of ids.slice(1)) expect(ctx.shop.getPurchase(id)!.status).toBe("expired");
    expect(pendingRevocations(ctx)).toHaveLength(ids.length - 1);

    // 障害が去れば次の巡回で先頭も失効する
    ctx.db.prepare("DROP TRIGGER fail_head").run();
    const retry = ctx.shop.expireOverdue("system:test");
    expect(retry.failed).toEqual([]);
    expect(retry.expired.map((p) => p.id)).toEqual([head]);
    expect(ctx.shop.getPurchase(head)!.status).toBe("expired");
    ctx.db.close();
  });
});
