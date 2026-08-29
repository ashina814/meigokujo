import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 配送そのものの経路。**DB確定の戻り値を捨てない。**
 *
 * Discord側で提供できたのに、DB確定が競合しただけで「失敗」として自動返金すると、
 * ロールは付いたまま払い戻すことになる。逆に、確認できていない失敗を
 * 「確認済みの失敗」として扱うのも同じ穴になる。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const deliveryModule = import("../src/shop-delivery.js");
const USER = "1463201396567441441";
const STAFF = "system:test";
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
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:path",
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
  const services = { db, events, shop, ledger } as unknown as Services;
  return { db, ledger, events, shop, item, services };
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

/**
 * Discordのふり。
 * `finalFetchFails` … roles.add() は通るが、その後の確認 fetch が返らない
 * `onAdd` … roles.add() の最中に起きること（返金・失効の割り込み）
 */
function guildStub(opts: { finalFetchFails?: boolean; onAdd?: () => void } = {}) {
  const roles = new Set<string>();
  let fetches = 0;
  const add = vi.fn(async (id: string) => {
    roles.add(id);
    opts.onAdd?.();
  });
  const member = { roles: { cache: { has: (id: string) => roles.has(id) }, add }, manageable: true, nickname: null };
  return {
    guild: {
      members: {
        fetch: vi.fn(async () => {
          fetches += 1;
          if (opts.finalFetchFails && fetches > 1) throw new Error("fetch failed");
          return member;
        }),
        me: null,
      },
      roles: { cache: { get: () => ({ id: ROLE, position: 1 }) } },
    },
    roles,
    add,
  };
}

const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

describe("配送経路の外部副作用", () => {
  it("ロール付与が通ったら、配送済みまで確定する", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const w = guildStub();

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);

    expect(outcome.state).toBe("delivered");
    expect(w.roles.has(ROLE)).toBe(true);
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    ctx.db.close();
  });

  it("付与後にDB確定が競合したら、成功扱いにせず自動返金もしない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const before = landOf(ctx);
    // roles.add() の最中に、claim を無視した別経路が status を動かした状況
    const w = guildStub({
      onAdd: () => void ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(p.id),
    });

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);

    // **delivered を返さない。** そして自動返金へは回さない
    expect(outcome.state).not.toBe("delivered");
    expect(outcome.refundable).toBe(false);
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    // ロールは付いたまま。人が確認するための claim が残る
    expect(w.roles.has(ROLE)).toBe(true);
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(1);
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });

  it("付与後に状態を確認できないときは、自動返金せず claim を残す", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const before = landOf(ctx);
    const w = guildStub({ finalFetchFails: true });

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);

    expect(outcome.state).toBe("failed");
    // **確認できていない失敗を「確認済みの失敗」にしない**
    expect(outcome.refundable).toBe(false);
    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("uncertain");
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(1);
    // 返金は通さない
    expect(() => ctx.shop.refund(p.id, "配送できなかった", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
    );
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });

  it("設定不備など、副作用を起こす前の失敗は claim を解放して返金できる", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const before = landOf(ctx);
    // ロールIDが読めない購入（副作用は一切起きない）
    ctx.db.prepare("UPDATE shop_purchases SET delivery_snapshot_json=? WHERE id=?").run(
      JSON.stringify({ delivery_kind: "add_role", delivery_data: {} }),
      p.id,
    );
    const fresh = ctx.shop.getPurchase(p.id)!;
    const w = guildStub();

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, fresh, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.refundable).not.toBe(false);
    expect(w.roles.size).toBe(0);
    // 解放されているので返金できる
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    expect(ctx.shop.refund(p.id, "配送できなかった", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });

  it("返金済みの購入へは、Discordを一切触らない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.refund(p.id, "配送できなかった", STAFF);
    const w = guildStub();

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);

    expect(outcome.state).toBe("not_active");
    expect(w.add).not.toHaveBeenCalled();
    expect(w.roles.size).toBe(0);
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    ctx.db.close();
  });

  it("同じ購入を二重に配送しても、外部副作用は一度きり", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const w = guildStub();

    await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);
    const second = await deliverPurchaseUnlocked(ctx.services, ctx.shop.getPurchase(p.id) as never, p, STAFF);

    expect(second.state).toBe("already_delivered");
    expect(w.add).toHaveBeenCalledTimes(1);
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    ctx.db.close();
  });
});
