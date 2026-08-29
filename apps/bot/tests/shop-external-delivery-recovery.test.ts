import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * Discordへ投げたが結果が分からない配送を、再起動を跨いで収束させる。
 *
 * **推測で返金も剥奪もしない。** 目的状態が成立していれば配送済みへ、成立していないと
 * 確認できたときだけ解放して再試行へ戻す。確かめられないものは人へ残す。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const recoveryModule = import("../src/scheduler-recovery.js");
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
    idempotencyKey: "seed:recovery",
  });
  const settings = { getString: vi.fn((k: string) => (k === "guild:main" ? "guild" : undefined)) };
  const services = { db, events, shop, ledger, settings } as unknown as Services;
  return { db, ledger, events, shop, services };
}
type Ctx = ReturnType<typeof setup>;

const roleItem = (ctx: Ctx, roleId: string) =>
  ctx.shop.createItem(
    {
      name: "裏口",
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: roleId }),
    } as never,
    STAFF,
  );

const buy = (ctx: Ctx, itemId: number) =>
  ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;

/** Discordのふり。`roles` が実状態 */
function world(opts: { roles?: string[]; fetchFails?: boolean } = {}) {
  const roles = new Set<string>(opts.roles ?? []);
  const remove = vi.fn(async (id: string) => void roles.delete(id));
  const add = vi.fn(async (id: string) => void roles.add(id));
  const member = { roles: { cache: { has: (id: string) => roles.has(id) }, remove, add } };
  const guild = {
    members: { fetch: vi.fn(async () => (opts.fetchFails ? Promise.reject(new Error("fetch failed")) : member)) },
  };
  const client = { guilds: { fetch: vi.fn(async () => guild) } };
  return { client, member, remove, add, roles };
}

/** roles.add() は通ったが最終確認前に落ちた状況を作る */
function crashedMidFlight(ctx: Ctx, purchaseId: number) {
  const claim = ctx.shop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: STAFF });
  expect(claim.ok).toBe(true);
  return (claim as { token: string }).token;
}

const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

describe("外部配送の収束", () => {
  it("ロールが付いていれば、再起動後に配送済みへ収束する（返金しない）", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    const p = buy(ctx, item.id);
    const before = landOf(ctx);
    crashedMidFlight(ctx, p.id);
    // Discord側は成功していた
    const w = world({ roles: [ROLE] });

    await convergeExternalDeliveries(w.client as never, ctx.services);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    expect(landOf(ctx)).toBe(before);
    // ロールは1つも剥がさない
    expect(w.remove).not.toHaveBeenCalled();
    ctx.db.close();
  });

  it("収束を二度走らせても delivered イベントは1回だけ", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    const p = buy(ctx, item.id);
    crashedMidFlight(ctx, p.id);

    await convergeExternalDeliveries(world({ roles: [ROLE] }).client as never, ctx.services);
    await convergeExternalDeliveries(world({ roles: [ROLE] }).client as never, ctx.services);

    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    ctx.db.close();
  });

  it("ロールが無いと確認できたら claim を解放し、返金できる状態へ戻す", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    const p = buy(ctx, item.id);
    const before = landOf(ctx);
    crashedMidFlight(ctx, p.id);
    const w = world({ roles: [] });

    await convergeExternalDeliveries(w.client as never, ctx.services);

    // 解放されただけ。配送済みにはしないし、勝手に返金もしない
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(landOf(ctx)).toBe(before);
    // ここまで来て初めて「確認済みの失敗」として返金できる
    expect(ctx.shop.refund(p.id, "配送できなかった", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });

  it("状態を確認できないうちは claim を残す（自動返金しない）", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    const p = buy(ctx, item.id);
    const before = landOf(ctx);
    crashedMidFlight(ctx, p.id);
    const w = world({ fetchFails: true });

    await convergeExternalDeliveries(w.client as never, ctx.services);

    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(1);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(landOf(ctx)).toBe(before);
    // 人が見るまで返金は通さない
    expect(() => ctx.shop.refund(p.id, "配送できなかった", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
    );
    ctx.db.close();
  });

  it("現在の商品ロールを変えても、収束の対象は購入時のロールのまま", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    const p = buy(ctx, item.id);
    crashedMidFlight(ctx, p.id);
    // 運営が商品のロール設定を変えた
    ctx.shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "r-other" }) } as never, STAFF);

    // 実際に付いているのは購入時のロール
    await convergeExternalDeliveries(world({ roles: [ROLE] }).client as never, ctx.services);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    ctx.db.close();
  });

  it("現在の商品ロールだけが付いていても、購入時のロールが無ければ配送済みにしない", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    const p = buy(ctx, item.id);
    crashedMidFlight(ctx, p.id);
    ctx.shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "r-other" }) } as never, STAFF);

    await convergeExternalDeliveries(world({ roles: ["r-other"] }).client as never, ctx.services);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    ctx.db.close();
  });

  it("同じロールの別契約があっても、収束はロールを剥がさない", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    // 同じロールを与える**別商品**の、提供済みの契約
    const otherItem = roleItem(ctx, ROLE);
    const other = buy(ctx, otherItem.id);
    ctx.shop.beginDelivery(other.id);
    ctx.shop.markDeliverySucceeded(other.id, STAFF);
    const p = buy(ctx, item.id);
    crashedMidFlight(ctx, p.id);
    const w = world({ roles: [ROLE] });

    await convergeExternalDeliveries(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(w.roles.has(ROLE)).toBe(true);
    // 別契約の delivered は触らない
    expect(ctx.shop.getPurchase(other.id)!.delivery_state).toBe("delivered");
    ctx.db.close();
  });

  it("収束前に purchase が動いていたら、配送済みにせず人へ残す", async () => {
    const { convergeExternalDeliveries } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, ROLE);
    const p = buy(ctx, item.id);
    crashedMidFlight(ctx, p.id);
    // claim を無視して直接 status を動かした状況（旧プロセスなど）
    ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(p.id);

    await convergeExternalDeliveries(world({ roles: [ROLE] }).client as never, ctx.services);

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(1);
    ctx.db.close();
  });
});
