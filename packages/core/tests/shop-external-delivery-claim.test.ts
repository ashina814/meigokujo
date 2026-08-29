import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * 外部（Discord）へ副作用を投げているあいだの durable な場所取り。
 *
 * 返金済み・失効済みなのに配送途中だった権利だけ後から残る、を閉じる。
 * 逆に、Discord側で提供できたのにDB確定の競合だけを理由に自動返金することもしない。
 */

registerDefaultTxTypes();
const STAFF = "system:test";
const USER = "u-claim";
const ROLE = "r-vip";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 10_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:claim",
  });
  const item = shop.createItem(
    {
      name: "裏口",
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE }),
    } as never,
    STAFF,
  );
  return { db, ledger, events, shop, item };
}
type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx) =>
  ctx.shop.purchase({
    itemId: ctx.item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
  }).purchase;

const claim = (ctx: Ctx, purchaseId: number) =>
  ctx.shop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: STAFF });

const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

describe("外部配送の claim", () => {
  it("claim中は返金できない（資産も status も1つも動かさない）", () => {
    const ctx = setup();
    const p = buy(ctx);
    const before = landOf(ctx);
    const got = claim(ctx, p.id);
    expect(got.ok).toBe(true);

    expect(() => ctx.shop.refund(p.id, "配送できなかった", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
    );

    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(landOf(ctx)).toBe(before);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    ctx.db.close();
  });

  it("claim中は失効しない（次の巡回へ持ち越す）", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);
    claim(ctx, p.id);

    const outcome = ctx.shop.expireIfDue(p.id, STAFF);

    expect(outcome).toEqual({ expired: false, reason: "delivery_in_flight" });
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.events.listByType("shop_expired")).toHaveLength(0);
    ctx.db.close();
  });

  it("claimが解決したあとは、通常どおり失効する", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);
    const got = claim(ctx, p.id);
    expect(ctx.shop.expireIfDue(p.id, STAFF).reason).toBe("delivery_in_flight");

    ctx.shop.releaseExternalDelivery({
      purchaseId: p.id,
      token: (got as { token: string }).token,
      reason: "verified_no_effect",
      actor: STAFF,
    });

    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: true, reason: "expired" });
    ctx.db.close();
  });

  it("返金が先に通っていたら claim を取れない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.refund(p.id, "配送できなかった", STAFF);

    const got = claim(ctx, p.id);

    expect(got).toMatchObject({ ok: false, reason: "not_active", status: "refunded" });
    expect(ctx.shop.externalDeliveryInFlight(p.id)).toBe(false);
    ctx.db.close();
  });

  it("失効が先に通っていたら claim を取れない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);
    ctx.shop.expireIfDue(p.id, STAFF);

    expect(claim(ctx, p.id)).toMatchObject({ ok: false, reason: "not_active", status: "expired" });
    ctx.db.close();
  });

  it("1 purchase につき同時に生きている claim は1つだけ", () => {
    const ctx = setup();
    const p = buy(ctx);
    expect(claim(ctx, p.id).ok).toBe(true);

    expect(claim(ctx, p.id)).toMatchObject({ ok: false, reason: "in_flight" });
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_external_delivery_attempts WHERE purchase_id=?").pluck().get(p.id),
    ).toBe(1);
    ctx.db.close();
  });

  it("配送済みなら claim を取らない", () => {
    const ctx = setup();
    const p = buy(ctx);
    const got = claim(ctx, p.id);
    expect(ctx.shop.settleExternalDelivery({ purchaseId: p.id, token: (got as { token: string }).token, actor: STAFF })).toBe(true);

    expect(claim(ctx, p.id)).toMatchObject({ ok: false, reason: "already_delivered" });
    ctx.db.close();
  });

  it("settle は delivered をちょうど一度だけ確定する", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = (claim(ctx, p.id) as { token: string }).token;

    expect(ctx.shop.settleExternalDelivery({ purchaseId: p.id, token, actor: STAFF })).toBe(true);
    // 同じ token で二度目は通らない
    expect(ctx.shop.settleExternalDelivery({ purchaseId: p.id, token, actor: STAFF })).toBe(false);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    expect(ctx.shop.externalDeliveryInFlight(p.id)).toBe(false);
    ctx.db.close();
  });

  it("token が違う試行では確定できない（0 mutation）", () => {
    const ctx = setup();
    const p = buy(ctx);
    claim(ctx, p.id);

    expect(ctx.shop.settleExternalDelivery({ purchaseId: p.id, token: "stale-token", actor: STAFF })).toBe(false);
    expect(
      ctx.shop.releaseExternalDelivery({ purchaseId: p.id, token: "stale-token", reason: "x", actor: STAFF }),
    ).toBe(false);
    expect(
      ctx.shop.markExternalDeliveryUncertain({ purchaseId: p.id, token: "stale-token", reason: "x", actor: STAFF }),
    ).toBe(false);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("in_flight");
    ctx.db.close();
  });

  it("uncertain は claim を残す（返金も失効も通さないまま人へ）", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = (claim(ctx, p.id) as { token: string }).token;

    expect(ctx.shop.markExternalDeliveryUncertain({ purchaseId: p.id, token, reason: "final_fetch_failed", actor: STAFF })).toBe(true);

    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("uncertain");
    expect(() => ctx.shop.refund(p.id, "配送できなかった", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
    );
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(1);
    ctx.db.close();
  });

  it("uncertain だったものも、あとから確認できれば delivered へ収束する", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = (claim(ctx, p.id) as { token: string }).token;
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: p.id, token, reason: "final_fetch_failed", actor: STAFF });

    expect(ctx.shop.settleExternalDelivery({ purchaseId: p.id, token, actor: STAFF })).toBe(true);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    ctx.db.close();
  });

  it("解放できたものは、確認済みの失敗として返金してよい", () => {
    const ctx = setup();
    const p = buy(ctx);
    const before = landOf(ctx);
    const token = (claim(ctx, p.id) as { token: string }).token;
    ctx.shop.releaseExternalDelivery({ purchaseId: p.id, token, reason: "verified_no_effect", actor: STAFF });

    const refund = ctx.shop.refund(p.id, "配送できなかった", STAFF);

    expect(refund.refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    // 二度目は返金しない
    expect(ctx.shop.refund(p.id, "配送できなかった", STAFF).refunded).toBe(false);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });

  it("purchase が動いていたら settle は false（Discord成功をDB成功に化けさせない）", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = (claim(ctx, p.id) as { token: string }).token;
    // claim を無視して直接 status を動かした状況（別プロセスの旧コードなど）
    ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(p.id);

    expect(ctx.shop.settleExternalDelivery({ purchaseId: p.id, token, actor: STAFF })).toBe(false);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    // **claim を消費してはいけない。** ここで settled のまま残すと、Discordにロールが
    // 有るかもしれないのに返金も失効も素通りする購入ができる
    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("in_flight");
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(1);
    ctx.db.close();
  });

  it("claim は消せない（append-only）", () => {
    const ctx = setup();
    const p = buy(ctx);
    claim(ctx, p.id);
    expect(() => ctx.db.prepare("DELETE FROM shop_external_delivery_attempts").run()).toThrow(/append-only/);
    ctx.db.close();
  });

  it("返金と失効が両方来ても、claim 中はどちらも通らない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);
    const before = landOf(ctx);
    claim(ctx, p.id);

    expect(() => ctx.shop.refund(p.id, "配送できなかった", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
    );
    expect(ctx.shop.expireIfDue(p.id, STAFF).expired).toBe(false);

    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });
});
