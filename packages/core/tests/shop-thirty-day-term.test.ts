import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Shop, extendedExpiry, termDays } from "../src/shop/service.js";

registerDefaultTxTypes();

/**
 * 期限は「買った時点から30日」。暦月ではない。
 *
 * 旧仕様は当月末までで、月末に買った人ほど短い期間に満額を払っていた
 * （本番では8/8購入が23日間）。延長は本人が押したときだけ動き、
 * 残り期間は切り捨てない。
 */
const DAY = 86_400;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  return { db, ledger, events, shop };
}

type Ctx = ReturnType<typeof setup>;

function fund(ctx: Ctx, userId: string, amount: number) {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: `seed:${userId}:${amount}:${Math.random()}`,
  });
}

/** Botが利用権を管理する期限商品（自動でロールを付ける＝延長してよい） */
const termItem = (ctx: Ctx, name = "30日券", price = 1_000) =>
  ctx.shop.createItem(
    { name, price_land: price, kind: "monthly", delivery: "auto", delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: "r1" }) },
    "staff",
  );

/** 手動配送の期限商品（旧オリジナルロール継続。汎用延長の対象外） */
const manualTermItem = (ctx: Ctx, name = "旧月額", price = 1_000) =>
  ctx.shop.createItem({ name, price_land: price, kind: "monthly", delivery: "manual" }, "staff");

/** 確認画面に出したのと同じ条件 */
function terms(ctx: Ctx, purchaseId: number) {
  const purchase = ctx.shop.getPurchase(purchaseId)!;
  const item = ctx.shop.getItem(purchase.item_id)!;
  return { priceLand: item.price_land!, days: termDays(item)!, expiresAt: purchase.expires_at };
}

const extendInput = (ctx: Ctx, purchaseId: number, userId: string, operationId: string, roles: string[] = []) => ({
  purchaseId,
  userId,
  actor: userId,
  operationId,
  memberRoleIds: roles,
  expected: terms(ctx, purchaseId),
});

describe("期限の数え方", () => {
  it("購入した時点から30日（暦月ではない）", () => {
    const ctx = setup();
    const item = termItem(ctx);
    fund(ctx, "u1", 10_000);

    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;

    expect(p.expires_at! - p.purchased_at).toBe(30 * DAY);
    ctx.db.close();
  });

  it("期限のない単発商品は期限を持たない", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({ name: "単発", price_land: 100, kind: "one_shot", delivery: "manual" }, "staff");
    fund(ctx, "u1", 10_000);

    expect(ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase.expires_at).toBeNull();
    ctx.db.close();
  });

  it("期限前の延長でも残り期間を損しない", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(extendedExpiry(now + 10 * DAY, 30, now)).toBe(now + 40 * DAY);
  });

  it("切れた後の延長は今から数え直す", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(extendedExpiry(now - 10 * DAY, 30, now)).toBe(now + 30 * DAY);
  });

  it("期間は duration_days を優先し、旧 monthly も30日として読む", () => {
    expect(termDays({ kind: "one_shot", duration_days: 7 })).toBe(7);
    expect(termDays({ kind: "monthly", duration_days: null })).toBe(30);
    expect(termDays({ kind: "one_shot", duration_days: null })).toBeNull();
  });
});

describe("延長", () => {
  it("料金を払って30日延び、残り期間は加算される", () => {
    const ctx = setup();
    const item = termItem(ctx);
    fund(ctx, "u1", 10_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    const balance = ctx.ledger.balanceOf("user:u1");

    const result = ctx.shop.extend(extendInput(ctx, p.id, "u1", "op-1"));

    expect(result.extended).toBe(true);
    expect(result.purchase.expires_at).toBe(p.expires_at! + 30 * DAY);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(balance - 1_000);
    expect(ctx.events.listByType("shop_extended")).toHaveLength(1);
    ctx.db.close();
  });

  it("同じ操作の再送では二重に課金も延長もしない", () => {
    const ctx = setup();
    const item = termItem(ctx);
    fund(ctx, "u1", 10_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;

    const input = extendInput(ctx, p.id, "u1", "op-1");
    const first = ctx.shop.extend(input);
    const balance = ctx.ledger.balanceOf("user:u1");
    // **同じ確認画面の二度押し**（条件は1回目のまま古い）
    const second = ctx.shop.extend(input);

    expect(second.extended).toBe(false);
    expect(second.purchase.expires_at).toBe(first.purchase.expires_at);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(balance);
    ctx.db.close();
  });

  it("他人の契約・失効済み・残高不足は延長できない", () => {
    const ctx = setup();
    const item = termItem(ctx);
    fund(ctx, "u1", 1_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;

    expect(() => ctx.shop.extend(extendInput(ctx, p.id, "u2", "x"))).toThrow("ERR_NOT_OWNER");
    // 残高は購入で使い切っている
    expect(() => ctx.shop.extend(extendInput(ctx, p.id, "u1", "y"))).toThrow("ERR_INSUFFICIENT");
    const expired = extendInput(ctx, p.id, "u1", "z");
    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(p.id);
    expect(() => ctx.shop.extend(expired)).toThrow("ERR_NOT_ACTIVE");
    ctx.db.close();
  });

  it("期限商品は二重に契約できない（延長へ誘導する）", () => {
    const ctx = setup();
    const item = termItem(ctx);
    fund(ctx, "u1", 10_000);
    ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] });

    expect(() => ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] })).toThrow(
      "ERR_ALREADY_ACTIVE",
    );
    ctx.db.close();
  });
});

describe("期限が近い契約", () => {
  it("3日以内のものだけ返す（既に切れたものは返さない）", () => {
    const ctx = setup();
    const item = termItem(ctx);
    const now = Math.floor(Date.now() / 1000);
    for (const [user, offset] of [["soon", 2 * DAY], ["later", 10 * DAY], ["gone", -DAY]] as const) {
      fund(ctx, user, 10_000);
      const p = ctx.shop.purchase({ itemId: item.id, userId: user, actor: user, memberRoleIds: [] }).purchase;
      ctx.db.prepare("UPDATE shop_purchases SET expires_at = ? WHERE id = ?").run(now + offset, p.id);
    }

    expect(ctx.shop.expiringSoon(3).map((p) => p.user_id)).toEqual(["soon"]);
    ctx.db.close();
  });
});

describe("暦月からの移行", () => {
  it("最後に払った時点+30日と現在の期限の、遅い方へ揃える（誰も短くならない）", () => {
    const dir = mkdtempSync(join(tmpdir(), "shop-term-"));
    const file = join(dir, "bot.db");
    try {
      // 旧仕様のデータを作る: 暦月期限・duration_days なし
      const before = openDb(file);
      const ledger = new Ledger(before);
      const events = new EventLog(before);
      const shop = new Shop(before, ledger, events);
      const item = shop.createItem({ name: "月額", price_land: 100, kind: "monthly", delivery: "manual" }, "staff");
      before.prepare("UPDATE shop_items SET duration_days = NULL WHERE id = ?").run(item.id);
      const now = Math.floor(Date.now() / 1000);
      const monthEnd = now + 5 * DAY; // 当月末のつもり

      const mk = (userId: string, purchasedAt: number) => {
        ledger.ensureAccount(`user:${userId}`, "user");
        ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 10_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: `s:${userId}` });
        const p = shop.purchase({ itemId: item.id, userId, actor: userId, memberRoleIds: [] }).purchase;
        before.prepare("UPDATE shop_purchases SET purchased_at = ?, expires_at = ? WHERE id = ?").run(purchasedAt, monthEnd, p.id);
        return p.id;
      };
      // 月初に買って一括請求で更新された人（最後の支払い = 請求時刻）
      const renewed = mk("renewed", now - 40 * DAY);
      ledger.transfer({
        from: "user:renewed", to: TREASURY, amount: 100, type: "tip_burn", actor: "system:shop-monthly",
        refType: "shop_monthly", refId: String(renewed), idempotencyKey: `shop:monthly:${renewed}:2026-08`,
      });
      before.prepare("UPDATE transactions SET created_at = ? WHERE idempotency_key = ?").run(now - 2 * DAY, `shop:monthly:${renewed}:2026-08`);
      // 月末近くに買って損している人
      const late = mk("late", now - DAY);
      before.close();

      // 開き直す＝移行が走る
      const after = openDb(file);
      const rows = after.prepare("SELECT id, expires_at FROM shop_purchases ORDER BY id").all() as Array<{ id: number; expires_at: number }>;
      const byId = new Map(rows.map((r) => [r.id, r.expires_at]));

      // 商品は30日の期限商品になる
      expect((after.prepare("SELECT duration_days AS d FROM shop_items WHERE id = ?").get(item.id) as { d: number }).d).toBe(30);
      // 一括請求で更新された人: 請求時刻 + 30日
      expect(byId.get(renewed)).toBe(now - 2 * DAY + 30 * DAY);
      // 月末近くの人: 購入 + 30日
      expect(byId.get(late)).toBe(now - DAY + 30 * DAY);
      // どちらも元の期限より短くならない
      for (const row of rows) expect(row.expires_at).toBeGreaterThanOrEqual(monthEnd);
      // 監査に残す
      const audit = after.prepare("SELECT payload FROM outbox WHERE payload LIKE ? ORDER BY id DESC LIMIT 1").get("%shop_term_migrated_to_30d%") as { payload: string };
      expect(JSON.parse(audit.payload).extended).toHaveLength(2);

      // 二度目に開いても動かない
      after.close();
      const again = openDb(file);
      expect((again.prepare("SELECT expires_at AS e FROM shop_purchases WHERE id = ?").get(late) as { e: number }).e).toBe(byId.get(late));
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("汎用延長を受け付ける商品の線引き", () => {
  it("Botがロールを付ける期限商品だけが延長できる", () => {
    const ctx = setup();
    const auto = ctx.shop.getItem(termItem(ctx).id)!;
    const manual = ctx.shop.getItem(manualTermItem(ctx).id)!;
    const oneShot = ctx.shop.getItem(
      ctx.shop.createItem({ name: "単発", price_land: 1, kind: "one_shot", delivery: "auto", delivery_kind: "extend_deadline" }, "staff").id,
    )!;

    expect(ctx.shop.isExtendable(auto)).toBe(true);
    expect(ctx.shop.isExtendable(manual)).toBe(false); // 旧オリジナルロール継続
    expect(ctx.shop.isExtendable(oneShot)).toBe(false); // 期限が無い
    ctx.db.close();
  });

  it("手動配送の期限商品は無課金で拒否する（旧#2を汎用延長させない）", () => {
    const ctx = setup();
    const item = manualTermItem(ctx);
    fund(ctx, "u1", 10_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    const balance = ctx.ledger.balanceOf("user:u1");

    expect(() => ctx.shop.extend(extendInput(ctx, p.id, "u1", "op-1"))).toThrow("ERR_NOT_EXTENDABLE");
    expect(ctx.ledger.balanceOf("user:u1")).toBe(balance);
    expect(ctx.shop.getPurchase(p.id)!.expires_at).toBe(p.expires_at);
    ctx.db.close();
  });
});

describe("確認した内容と実際の課金内容", () => {
  it("価格・期間・期限のどれかが変わっていたら無課金で拒否する", () => {
    for (const change of ["price", "expiry"] as const) {
      const ctx = setup();
      const item = termItem(ctx);
      fund(ctx, "u1", 10_000);
      const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
      const stale = extendInput(ctx, p.id, "u1", `op-${change}`);
      // 確認画面を出したあとに条件が動く
      if (change === "price") ctx.shop.updateItem(item.id, { price_land: 2_000 }, "staff");
      else ctx.db.prepare("UPDATE shop_purchases SET expires_at = expires_at + 86400 WHERE id = ?").run(p.id);
      const balance = ctx.ledger.balanceOf("user:u1");
      const expires = ctx.shop.getPurchase(p.id)!.expires_at;

      expect(() => ctx.shop.extend(stale)).toThrow("ERR_TERMS_CHANGED");
      expect(ctx.ledger.balanceOf("user:u1")).toBe(balance);
      expect(ctx.shop.getPurchase(p.id)!.expires_at).toBe(expires);
      ctx.db.close();
    }
  });

  it("古い確認画面は拒否されるが、新しい確認画面ならそのまま通る", () => {
    const ctx = setup();
    const item = termItem(ctx);
    fund(ctx, "u1", 10_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    const old = extendInput(ctx, p.id, "u1", "op-old");
    ctx.shop.extend(extendInput(ctx, p.id, "u1", "op-new")); // 別の画面から先に延長された

    expect(() => ctx.shop.extend(old)).toThrow("ERR_TERMS_CHANGED");
    // 出し直せば通る
    expect(ctx.shop.extend(extendInput(ctx, p.id, "u1", "op-new2")).extended).toBe(true);
    ctx.db.close();
  });
});

describe("課金と期限更新の原子性", () => {
  it("期限更新に失敗したらLandも減らない。障害が去れば同じ操作で成功する", () => {
    const ctx = setup();
    const item = termItem(ctx);
    fund(ctx, "u1", 10_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: [] }).purchase;
    const balance = ctx.ledger.balanceOf("user:u1");
    const input = extendInput(ctx, p.id, "u1", "op-1");
    // 課金の**後**に来る期限更新だけを失敗させる
    ctx.db
      .prepare(
        `CREATE TRIGGER fail_extend BEFORE UPDATE OF expires_at ON shop_purchases
           BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
      )
      .run();

    expect(() => ctx.shop.extend(input)).toThrow("injected failure");
    expect(ctx.ledger.balanceOf("user:u1")).toBe(balance);
    expect(ctx.shop.getPurchase(p.id)!.expires_at).toBe(p.expires_at);
    // Land取引ごと巻き戻っているので、同じ冪等キーで再試行できる
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key = ?").get(`shop:extend:${p.id}:op-1`)).toEqual({ n: 0 });

    ctx.db.prepare("DROP TRIGGER fail_extend").run();
    const retry = ctx.shop.extend(input);

    expect(retry.extended).toBe(true);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(balance - 1_000);
    expect(retry.purchase.expires_at).toBe(p.expires_at! + 30 * DAY);
    ctx.db.close();
  });
});

describe("延長時の階級要件", () => {
  it("購入後に要件を失っていたら無課金で拒否する", () => {
    const ctx = setup();
    const item = termItem(ctx);
    ctx.shop.updateItem(item.id, { require_role_id: "role-majin" }, "staff");
    fund(ctx, "u1", 10_000);
    const p = ctx.shop.purchase({ itemId: item.id, userId: "u1", actor: "u1", memberRoleIds: ["role-majin"] }).purchase;
    const balance = ctx.ledger.balanceOf("user:u1");

    // いまは要件ロールを持っていない
    expect(() => ctx.shop.extend(extendInput(ctx, p.id, "u1", "op-1", []))).toThrow("ERR_ROLE_REQUIRED");
    expect(ctx.ledger.balanceOf("user:u1")).toBe(balance);
    expect(ctx.shop.getPurchase(p.id)!.expires_at).toBe(p.expires_at);

    // 持っていれば通る
    expect(ctx.shop.extend(extendInput(ctx, p.id, "u1", "op-2", ["role-majin"])).extended).toBe(true);
    ctx.db.close();
  });
});
