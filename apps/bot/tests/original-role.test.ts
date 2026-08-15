import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  EventLog,
  Ledger,
  OriginalRoleCases,
  OriginalRoles,
  Settings,
  Shop,
  ShopError,
  Tickets,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * オリジナルロールの現在仕様 + 旧自動purchase復旧互換。
 *
 * 現在の通常導線は「ショップ → 専用カルテ → スタッフ請求 → 本人支払い」。
 * Botは新規/継続/再開を期限や金額から判断せず、実ロールも自動作成/付与/剥奪しない。
 *
 * 一方、制度変更前に既に課金済みだった create_original_role purchase は、
 * 再起動・Discord API失敗の途中状態から安全に収束できる互換経路を残す。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");
const jobsModule = import("../src/original-role-jobs.js");
const refundModule = import("../src/shop-refund.js");
const recoveryModule = import("../src/scheduler-recovery.js");
const deliveryModule = import("../src/shop-delivery.js");

const USER = "1463201396567441441";
const PRICE = 750_000;
const DAY = 86_400;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const originalRoles = new OriginalRoles(db, ledger, events);
  const originalRoleCases = new OriginalRoleCases(db, events);
  const tickets = new Tickets(db, events);
  let itemId = 0;
  const shop = new Shop(db, ledger, events, {
    originalRoleItemId: () => itemId || null,
    assertOriginalRolePayable: (applicationId, userId) => originalRoles.assertPayable(applicationId, userId),
  });
  const item = shop.createItem(
    {
      name: "オリジナルロール",
      price_land: PRICE,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "create_original_role",
    },
    "staff",
  );
  itemId = item.id;
  settings.set("guild:main", "g1", "staff");
  settings.set("shop:original_role_item_id", String(item.id), "staff");
  settings.set("original_role_renew_price", 250_000, "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: "seed",
  });
  const chipFlow = {
    externalConfirmation: vi.fn(),
    beginExternalConfirmation: vi.fn(),
    redeemExactFreeChips: vi.fn(),
    completeExternalConfirmation: vi.fn(),
    cancelExternalConfirmation: vi.fn(),
    createExternalConfirmation: vi.fn(),
  };
  const services = {
    db,
    ledger,
    settings,
    events,
    shop,
    originalRoles,
    originalRoleCases,
    tickets,
    chipFlow,
  } as unknown as Services;
  return { db, ledger, settings, events, shop, originalRoles, originalRoleCases, tickets, item, chipFlow, services };
}

type Ctx = ReturnType<typeof setup>;
const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

function expectShopError(run: () => unknown, code: ShopError["code"]) {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ShopError);
    expect((error as ShopError).code).toBe(code);
  }
}

function press(ctx: Ctx, customId: string, extra: Record<string, unknown> = {}) {
  return {
    customId,
    id: `int-${Math.random()}`,
    user: { id: USER },
    member: { roles: { cache: new Collection<string, unknown>() } },
    guild: null,
    client: { channels: { fetch: vi.fn(async () => null) }, users: { fetch: vi.fn(async () => null) } },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    ...extra,
  } as never;
}

function makeLegacyWorld(opts: { createFails?: boolean; fetchFails?: boolean } = {}) {
  const memberCache = new Collection<string, { id: string }>();
  const member = {
    id: USER,
    roles: {
      cache: memberCache,
      add: vi.fn(async (roleId: string) => {
        memberCache.set(roleId, { id: roleId });
      }),
      remove: vi.fn(async (roleId: string) => {
        memberCache.delete(roleId);
      }),
    },
  };
  let seq = 0;
  const roles = new Collection<string, any>();
  const makeRole = (name: string) => {
    const id = `role-${++seq}`;
    const role: any = {
      id,
      name,
      managed: false,
      editable: true,
      createdTimestamp: Date.now(),
      edit: vi.fn(async (input: { name?: string }) => {
        if (input.name) role.name = input.name;
        return role;
      }),
      delete: vi.fn(async () => {
        roles.delete(id);
      }),
    };
    roles.set(id, role);
    return role;
  };
  const guild = {
    id: "g1",
    roles: {
      cache: roles,
      create: vi.fn(async (input: { name: string }) => {
        if (opts.createFails) throw new Error("Missing Permissions");
        return makeRole(input.name);
      }),
      fetch: vi.fn(async () => {
        if (opts.fetchFails) throw new Error("Service Unavailable");
        return roles;
      }),
    },
    members: {
      fetch: vi.fn(async () => member),
    },
  };
  return { guild, member, roles, makeRole };
}

function fakeClient(guild?: ReturnType<typeof makeLegacyWorld>["guild"]) {
  return {
    guilds: { fetch: vi.fn(async () => guild ?? null) },
    users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => undefined) })) },
    channels: { fetch: vi.fn(async () => null) },
  } as never;
}

function approvedLegacy(ctx: Ctx) {
  const row = ctx.originalRoles.apply({ userId: USER, name: "旧方式オリロ", color: 0xa855f7, actor: "test" });
  ctx.originalRoles.approve(row.id, "staff");
  return row;
}

function paidLegacy(ctx: Ctx) {
  const row = approvedLegacy(ctx);
  const paid = ctx.shop.purchaseOriginalRole({
    itemId: ctx.item.id,
    applicationId: row.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    idempotencyKey: `legacy-orole:${row.id}`,
  });
  return { row, purchase: paid.purchase };
}

describe("現在の通常導線", () => {
  it("generic shopでは設定済みオリロを誤購入できない", () => {
    const ctx = setup();
    const before = balance(ctx);
    expectShopError(
      () => ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [] }),
      "ERR_ORIGINAL_ROLE_SPECIAL_PURCHASE_REQUIRED",
    );
    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("古いgeneric購入ボタンも無課金で専用カルテ導線へ戻す", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const interaction = press(ctx, `shop:buy:${ctx.item.id}:land`) as unknown as { reply: ReturnType<typeof vi.fn> };
    const before = balance(ctx);

    await handleShopButton(interaction as never, ctx.services);

    const payload = JSON.stringify(interaction.reply.mock.calls.at(-1)?.[0]);
    expect(payload).toContain("ticket:open:original_role");
    expect(payload).toContain("料金");
    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("旧申請フォームは申請行も課金も作らない", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const before = balance(ctx);
    const interaction = press(ctx, `shop:orole-input:${ctx.item.id}`, {
      fields: { getTextInputValue: vi.fn(() => "旧入力") },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(interaction as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(0);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    expect(balance(ctx)).toBe(before);
    expect(String(interaction.reply.mock.calls.at(-1)?.[0]?.content)).toContain("旧申請フォームは終了");
    ctx.db.close();
  });

  it("旧支払い/セルフ更新ボタンでは1Ldも動かさず実ロールも触らない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const before = balance(ctx);
    const oldPay = press(ctx, `shop:orole-pay:${ctx.item.id}:999:${PRICE}:old`) as unknown as { reply: ReturnType<typeof vi.fn> };
    const oldRenew = press(ctx, `shop:orole-renew-do:${ctx.item.id}:999:250000`) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopButton(oldPay as never, ctx.services);
    await handleShopButton(oldRenew as never, ctx.services);

    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    expect(String(oldPay.reply.mock.calls.at(-1)?.[0]?.content)).toContain("自動で新規・継続・再開を判断");
    expect(String(oldRenew.reply.mock.calls.at(-1)?.[0]?.content)).toContain("旧オリジナルロール支払い/更新UIは終了");
    ctx.db.close();
  });

  it("3日前通知済みでも期限到来はDBをexpiredへ進め、Discordロールを自動剥奪しない", async () => {
    const { expireOriginalRoles } = await jobsModule;
    const ctx = setup();
    const application = approvedLegacy(ctx);
    ctx.originalRoles.activate({ id: application.id, roleId: "role-existing", purchaseId: 1, actor: "test" });
    ctx.db.prepare("UPDATE original_roles SET expires_at=?, notified_expiry_at=123, role_removed_at=NULL WHERE id=?")
      .run(Math.floor(Date.now() / 1000) - DAY, application.id);
    const dm = vi.fn(async () => undefined);
    const client = {
      users: { fetch: vi.fn(async () => ({ send: dm })) },
      guilds: { fetch: vi.fn(async () => { throw new Error("expiry job must not touch guild roles"); }) },
    } as never;

    await expireOriginalRoles(client, ctx.services);

    const after = ctx.originalRoles.get(application.id)!;
    expect(after.status).toBe("expired");
    expect(after.role_id).toBe("role-existing");
    expect(after.role_removed_at).toBeNull();
    expect(dm).not.toHaveBeenCalled(); // 3日前通知を重複送信しない
    ctx.db.close();
  });
});

describe("旧create_original_role purchaseの復旧互換", () => {
  it("制度変更前に支払済みで止まったpurchaseは再起動巡回で収束できる", async () => {
    const { convergePendingOriginalRoles } = await recoveryModule;
    const ctx = setup();
    const world = makeLegacyWorld();
    const before = balance(ctx);
    const { row, purchase } = paidLegacy(ctx);
    expect(balance(ctx)).toBe(before - PRICE);

    await convergePendingOriginalRoles(fakeClient(world.guild), ctx.services);

    const current = ctx.originalRoles.get(row.id)!;
    expect(current.status).toBe("active");
    expect(current.role_id).toBeTruthy();
    expect(world.member.roles.cache.has(current.role_id!)).toBe(true);
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
    expect(balance(ctx)).toBe(before - PRICE);
    ctx.db.close();
  });

  it("旧purchase復旧で新規作成するロールは危険権限を持たない", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const world = makeLegacyWorld();
    const { purchase } = paidLegacy(ctx);

    await deliverOrRefund(fakeClient(world.guild), ctx.services, world.guild as never, purchase, "system:test");

    const createArg = world.guild.roles.create.mock.calls[0]?.[0] as {
      permissions?: unknown[]; mentionable?: boolean; hoist?: boolean;
    } | undefined;
    expect(createArg?.permissions).toEqual([]);
    expect(createArg?.mentionable).toBe(false);
    expect(createArg?.hoist).toBe(false);
    ctx.db.close();
  });

  it("ロール一覧を確認できない旧purchaseは二個目を作らず返金へ倒す", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const world = makeLegacyWorld({ fetchFails: true });
    const before = balance(ctx);
    const { row, purchase } = paidLegacy(ctx);
    expect(balance(ctx)).toBe(before - PRICE);

    const settled = await deliverOrRefund(fakeClient(world.guild), ctx.services, world.guild as never, purchase, "system:test");

    expect(settled.outcome.state).toBe("failed");
    expect(settled.refund).toBe("refunded");
    expect(world.guild.roles.create).not.toHaveBeenCalled();
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("refunded");
    expect(ctx.originalRoles.get(row.id)!.status).toBe("approved");
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("旧purchaseのロール作成自体に失敗した場合も課金だけを残さない", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const world = makeLegacyWorld({ createFails: true });
    const before = balance(ctx);
    const { row, purchase } = paidLegacy(ctx);

    const settled = await deliverOrRefund(fakeClient(world.guild), ctx.services, world.guild as never, purchase, "system:test");

    expect(settled.outcome.state).toBe("failed");
    expect(settled.refund).toBe("refunded");
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("refunded");
    expect(ctx.originalRoles.get(row.id)!.status).toBe("approved");
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("作成直後クラッシュ相当の仮ロールを拾い、二個目を作らず復旧する", async () => {
    const { deliverOrRefund } = await refundModule;
    const { stagingRoleName } = await deliveryModule;
    const ctx = setup();
    const world = makeLegacyWorld();
    const { row, purchase } = paidLegacy(ctx);
    ctx.originalRoles.markRoleCreationStarted(row.id);
    const staged = world.makeRole(stagingRoleName(row.id));

    const settled = await deliverOrRefund(fakeClient(world.guild), ctx.services, world.guild as never, purchase, "system:test");

    expect(settled.outcome.state).toBe("delivered");
    expect(world.guild.roles.create).not.toHaveBeenCalled();
    expect(ctx.originalRoles.get(row.id)!.role_id).toBe(staged.id);
    expect(staged.name).toBe("旧方式オリロ");
    expect(world.member.roles.cache.has(staged.id)).toBe(true);
    ctx.db.close();
  });

  it("配送済み旧purchaseを再処理しても二重課金・二重作成しない", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const world = makeLegacyWorld();
    const before = balance(ctx);
    const { purchase } = paidLegacy(ctx);

    const first = await deliverOrRefund(fakeClient(world.guild), ctx.services, world.guild as never, purchase, "system:test");
    const second = await deliverOrRefund(fakeClient(world.guild), ctx.services, world.guild as never, ctx.shop.getPurchase(purchase.id)!, "system:test");

    expect(first.outcome.state).toBe("delivered");
    expect(second.outcome.state).toBe("already_delivered");
    expect(world.guild.roles.create).toHaveBeenCalledTimes(1);
    expect(balance(ctx)).toBe(before - PRICE);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    ctx.db.close();
  });
});
