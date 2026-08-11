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

const pendingRevocations = (ctx: Ctx) =>
  ctx.db.prepare("SELECT purchase_id, role_id, status FROM shop_role_revocations ORDER BY purchase_id").all();

describe("期限切れの失効（課金から独立）", () => {
  it("期限が来た購入を失効させ、ロール剥奪キューへ積む", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(p.id);

    const expired = ctx.shop.expireOverdue("system:test");

    expect(expired.map((row) => row.id)).toEqual([p.id]);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("expired");
    expect(pendingRevocations(ctx)).toEqual([{ purchase_id: p.id, role_id: "role_a", status: "pending" }]);
    expect(ctx.events.listByType("shop_expired")).toHaveLength(1);
    ctx.db.close();
  });

  it("**失効しても課金しない**（自動更新は廃止）", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
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
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;

    expect(ctx.shop.expireOverdue("system:test")).toEqual([]);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(pendingRevocations(ctx)).toEqual([]);
    ctx.db.close();
  });

  it("期限を持たない単発商品は失効しない", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({ name: "単発", price_land: 100, kind: "one_shot", delivery: "manual" }, "staff");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;

    expect(ctx.shop.expireOverdue("system:test")).toEqual([]);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("何度巡回しても二重に処理しない", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(p.id);

    ctx.shop.expireOverdue("system:test");
    const second = ctx.shop.expireOverdue("system:test");

    expect(second).toEqual([]);
    expect(ctx.events.listByType("shop_expired")).toHaveLength(1);
    expect(pendingRevocations(ctx)).toHaveLength(1);
    ctx.db.close();
  });

  it("複数件をまとめて失効させ、1件ずつ確定する", () => {
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    for (const u of ["u1", "u2", "u3"]) {
      fund(ctx, u, 1_000);
      const p = ctx.shop.purchase({ itemId: item.id, userId: u, actor: u, memberRoleIds: [] }).purchase;
      ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(p.id);
    }

    const expired = ctx.shop.expireOverdue("system:test");

    expect(expired).toHaveLength(3);
    expect(pendingRevocations(ctx)).toHaveLength(3);
    ctx.db.close();
  });

  it("同じロールを与える有効な購入が残っていれば、剥奪キューは後段で守られる", () => {
    // 剥奪の実行側（bot）が使う判定。失効＝即剥奪ではないことをここでも確かめる
    const ctx = setup();
    const item = roleItem(ctx, "30日券", "role_a");
    fund(ctx, "u1", 1_000);
    const old = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    ctx.db.prepare("UPDATE shop_purchases SET expires_at = 1 WHERE id = ?").run(old.id);
    ctx.shop.expireOverdue("system:test");
    ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] });

    expect(ctx.shop.activePurchaseGrantsRole("u1", "role_a", old.id)).toBe(true);
    ctx.db.close();
  });
});
