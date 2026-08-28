import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 失効のロール剥奪と、新しい契約の競合。
 *
 * 剥奪はDiscordへの外部操作なので、判定と実行の間に時間が空く。その隙に同じロールを
 * 与える新しい契約が成立すると、**古い失効が新しい権利のロールを剥がす**。
 * 剥がす直前と直後の両方で確かめ、剥がしてしまった場合は戻す。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const recoveryModule = import("../src/scheduler-recovery.js");
const USER = "1463201396567441441";
const ROLE = "r-vip";
const STAFF = "system:test";

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
    idempotencyKey: "seed:race",
  });
  const settings = { getString: vi.fn((k: string) => (k === "guild:main" ? "guild" : undefined)) };
  const services = { db, events, shop, settings } as unknown as Services;
  return { db, ledger, events, shop, services };
}
type Ctx = ReturnType<typeof setup>;

const roleItem = (ctx: Ctx, name: string, roleId: string) =>
  ctx.shop.createItem(
    {
      name,
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: roleId }),
    } as never,
    STAFF,
  );

function buyDelivered(ctx: Ctx, itemId: number) {
  const p = ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;
  ctx.shop.beginDelivery(p.id);
  ctx.shop.markDeliverySucceeded(p.id, STAFF);
  return p;
}

function expireNow(ctx: Ctx, purchaseId: number) {
  ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);
  ctx.shop.expireIfDue(purchaseId, STAFF);
}

/**
 * Discordのふり。`onFetch` で「member を取り直すたびに何が起きるか」を差し込める
 * （awaitの隙に新しい契約が成立する状況を作るため）。
 */
function world(opts: { hasRole?: boolean; onFetch?: (n: number) => void; removeFails?: boolean; addFails?: boolean } = {}) {
  const roles = new Set<string>(opts.hasRole === false ? [] : [ROLE]);
  let fetches = 0;
  const remove = vi.fn(async (id: string) => {
    if (opts.removeFails) throw new Error("missing permissions");
    roles.delete(id);
  });
  const add = vi.fn(async (id: string) => {
    if (opts.addFails) throw new Error("add failed");
    roles.add(id);
  });
  const member = { roles: { cache: { has: (id: string) => roles.has(id) }, remove, add } };
  const guild = {
    members: {
      fetch: vi.fn(async () => {
        fetches += 1;
        opts.onFetch?.(fetches);
        return member;
      }),
    },
  };
  const client = { guilds: { fetch: vi.fn(async () => guild) } };
  return { client, guild, member, remove, add, roles, fetchCount: () => fetches };
}

const revocationStatus = (ctx: Ctx, purchaseId: number) =>
  (ctx.db.prepare("SELECT status FROM shop_role_revocations WHERE purchase_id=?").get(purchaseId) as { status: string } | undefined)
    ?.status;

describe("剥奪と新しい契約の競合", () => {
  it("有効な契約が既にあるなら、そもそも剥がさない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    buyDelivered(ctx, item.id); // 新しい契約
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(w.roles.has(ROLE)).toBe(true);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("最初の確認の後に契約が生えても、剥がす直前で気づいて剥がさない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    // member fetch の await 中に新しい契約が成立する
    const w = world({ onFetch: (n) => { if (n === 1) buyDelivered(ctx, item.id); } });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(w.roles.has(ROLE)).toBe(true);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("剥がした後に契約が生えたら、自分が消したロールを戻す", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    const w = world();
    // 剥がしている最中に新しい契約が成立した状況
    w.remove.mockImplementation(async (id: string) => {
      w.roles.delete(id);
      buyDelivered(ctx, item.id);
    });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).toHaveBeenCalledTimes(1);
    expect(w.add).toHaveBeenCalledTimes(1);
    expect(w.roles.has(ROLE)).toBe(true); // 戻っている
    expect(revocationStatus(ctx, old.id)).toBe("done");
    expect(ctx.events.listByType("shop_role_revocation_rolled_back")).toHaveLength(1);
    ctx.db.close();
  });

  it("戻せなかったら done にせず、次の巡回で収束させる", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    const w = world({ addFails: true });
    w.remove.mockImplementation(async (id: string) => {
      w.roles.delete(id);
      buyDelivered(ctx, item.id);
    });

    await expect(processShopRoleRevocations(w.client as never, ctx.services)).rejects.toThrow(/rollback/);

    expect(revocationStatus(ctx, old.id)).toBe("pending");

    // 次の巡回では、有効な契約があるので**そもそも剥がさない**
    const w2 = world({ hasRole: false });
    await processShopRoleRevocations(w2.client as never, ctx.services);
    expect(w2.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("他に契約が無ければ、ロールは一度だけ剥がされる", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);
    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).toHaveBeenCalledTimes(1);
    expect(w.roles.has(ROLE)).toBe(false);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    expect(ctx.events.listByType("shop_role_revocation_done")).toHaveLength(1);
    ctx.db.close();
  });

  it("メンバーが居なければ、剥がさずに完了", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    const w = world();
    w.guild.members.fetch = vi.fn(async () => {
      const err = new Error("Unknown Member") as Error & { code: number };
      err.code = 10007;
      throw err;
    });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("既にロールが無ければ、剥がさずに完了", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    const w = world({ hasRole: false });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("購入後に商品のロールを R1→R2 へ変えても、R2 は決して剥がされない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    ctx.shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "r-other" }) } as never, STAFF);
    expireNow(ctx, old.id);
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).toHaveBeenCalledTimes(1);
    expect(w.remove).toHaveBeenCalledWith(ROLE);
    expect(w.remove).not.toHaveBeenCalledWith("r-other");
    ctx.db.close();
  });
});

describe("裏の取れない既存キュー行", () => {
  it("Discordへ触らず、毎分retryし続けない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    // 旧実装が現在の商品設定から作ったような、裏の取れない対象へ書き換える
    ctx.db.prepare("UPDATE shop_role_revocations SET role_id='r-unproven' WHERE purchase_id=?").run(old.id);
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("failed");
    expect(ctx.events.listByType("shop_role_revocation_blocked")).toHaveLength(1);

    // 2回目でもpendingへ戻らない（毎分Discordを叩き続けない）
    await processShopRoleRevocations(w.client as never, ctx.services);
    expect(w.remove).not.toHaveBeenCalled();
    expect(ctx.events.listByType("shop_role_revocation_blocked")).toHaveLength(1);
    ctx.db.close();
  });
});

describe("失効キューのバックフィル", () => {
  function legacyExpired(ctx: Ctx, itemId: number, snapshotJson: string | null, deliveredAt: number | null) {
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,auto_renew," +
          "delivery_snapshot_json,delivered_at,delivery_state) VALUES (?,?,?,?,?, 'expired',0,?,?, 'delivered')",
      )
      .run(itemId, USER, 1_700_000_000, 1, 100, snapshotJson, deliveredAt);
    return Number(info.lastInsertRowid);
  }
  const snap = (roleId: string) =>
    JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: roleId }), captured_at: 1 });

  it("購入時スナップショット + 配送証拠があるなら、その対象で積む", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, snap("r-snapshot"), 1_700_000_500);

    backfillShopRoleRevocations(ctx.services);

    const row = ctx.db.prepare("SELECT role_id, status FROM shop_role_revocations WHERE purchase_id=?").get(id);
    expect(row).toMatchObject({ role_id: "r-snapshot", status: "pending" });
    ctx.db.close();
  });

  it("スナップショットが無い旧購入から、現在の商品ロールを積まない", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, null, 1_700_000_500);

    backfillShopRoleRevocations(ctx.services);

    expect(ctx.db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(id)).toBeUndefined();
    expect(ctx.shop.listUnresolvedExpiryRevocations().map((r) => r.id)).toContain(id);
    ctx.db.close();
  });

  it("壊れたスナップショットからも現在の商品ロールを積まない", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, "{", 1_700_000_500);

    backfillShopRoleRevocations(ctx.services);

    expect(ctx.db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(id)).toBeUndefined();
    ctx.db.close();
  });

  it("配送した証拠が無い旧購入も積まない", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, snap("r-snapshot"), null);

    backfillShopRoleRevocations(ctx.services);

    expect(ctx.db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(id)).toBeUndefined();
    ctx.db.close();
  });
});
