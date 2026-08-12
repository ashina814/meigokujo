import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import {
  EventLog,
  Ledger,
  OriginalRoles,
  Settings,
  Shop,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * オリジナルロールの導線。
 *
 * - 申請では **Land を動かさない**
 * - 支払いは承認のあとだけ
 * - 作成に失敗したら自動返金し、**付けられないロールを残さない**
 * - 更新はスタッフを介さない
 * - 期限3日前に知らせ、期限切れで剥奪する
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");
const jobsModule = import("../src/original-role-jobs.js");

const USER = "1463201396567441441";
const PRICE = 750_000;
const RENEW = 250_000;
const DAY = 86_400;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const originalRoles = new OriginalRoles(db, ledger, events);
  const item = shop.createItem(
    { name: "オリジナルロール新規作成", price_land: PRICE, kind: "one_shot", delivery: "auto", delivery_kind: "create_original_role" },
    "staff",
  );
  settings.set("guild:main", "g1", "staff");
  settings.set("shop:original_role_item_id", String(item.id), "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed",
  });
  const services = { db, ledger, settings, events, shop, originalRoles } as unknown as Services;
  return { db, ledger, settings, events, shop, originalRoles, item, services };
}

type Ctx = ReturnType<typeof setup>;
const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

/** ロール作成の成否を差し込めるギルド */
function world(opts: { createFails?: string; addFails?: string } = {}) {
  const roleDeleted: string[] = [];
  const memberRoles: string[] = [];
  const member = {
    id: USER,
    roles: {
      cache: new Collection(),
      add: vi.fn(async (id: string) => {
        if (opts.addFails) throw new Error(opts.addFails);
        memberRoles.push(id);
      }),
      remove: vi.fn(async (id: string) => {
        const i = memberRoles.indexOf(id);
        if (i >= 0) memberRoles.splice(i, 1);
      }),
    },
  };
  let seq = 0;
  const guild = {
    id: "g1",
    roles: {
      create: vi.fn(async (o: { name: string }) => {
        if (opts.createFails) throw new Error(opts.createFails);
        const id = `role-${++seq}`;
        return { id, name: o.name, delete: vi.fn(async () => void roleDeleted.push(id)) };
      }),
    },
    members: { fetch: vi.fn(async () => member) },
  };
  return { guild, member, memberRoles, roleDeleted };
}

function press(ctx: Ctx, customId: string, w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  return {
    customId,
    id: `int-${Math.random()}`,
    user: { id: USER },
    guild: w.guild,
    member: w.member,
    client: { channels: { fetch: vi.fn(async () => null) }, users: { fetch: vi.fn(async () => null) } },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    ...extra,
  } as never;
}

const contentOf = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])[0]?.content ?? "");

describe("申請", () => {
  it("**申請では Land を動かさない**", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world();
    const m = press(ctx, `shop:orole-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: (f: string) => (f === "name" ? "冥き翼" : "#A855F7") },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    const rows = ctx.originalRoles.listByUser(USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.color).toBe(0xa855f7);
    expect(contentOf(m.reply)).toContain("課金していません");
    ctx.db.close();
  });

  it("色の書式が違えば申請を作らない", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const m = press(ctx, `shop:orole-input:${ctx.item.id}`, world(), {
      fields: { getTextInputValue: (f: string) => (f === "name" ? "あ" : "むらさき") },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(0);
    expect(contentOf(m.reply)).toContain("16進数");
    ctx.db.close();
  });

  it("進行中の申請があれば重ねて出せない", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    ctx.originalRoles.apply({ userId: USER, name: "さき", color: null, actor: "t" });
    const m = press(ctx, `shop:orole-input:${ctx.item.id}`, world(), {
      fields: { getTextInputValue: (f: string) => (f === "name" ? "あと" : "") },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(ctx.originalRoles.listByUser(USER)).toHaveLength(1);
    expect(contentOf(m.reply)).toContain("進行中");
    ctx.db.close();
  });
});

describe("承認後の支払いと作成", () => {
  function approved(ctx: Ctx) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: 0xa855f7, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    return row;
  }

  it("支払うとロールが作られ、付与され、30日の契約が始まる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}`, w), ctx.services);

    expect(w.guild.roles.create).toHaveBeenCalled();
    expect(w.memberRoles).toHaveLength(1);
    const after = ctx.originalRoles.get(row.id)!;
    expect(after.status).toBe("active");
    expect(after.role_id).toBe("role-1");
    expect(after.expires_at! - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * DAY);
    expect(balance(ctx)).toBe(5_000_000 - PRICE);
    ctx.db.close();
  });

  it("**危険な権限を付けない**（権限は空・メンション不可・一覧分けなし）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}`, w), ctx.services);

    const opts = (w.guild.roles.create.mock.calls[0] as never[])[0] as {
      permissions: unknown[];
      mentionable: boolean;
      hoist: boolean;
    };
    expect(opts.permissions).toEqual([]);
    expect(opts.mentionable).toBe(false);
    expect(opts.hoist).toBe(false);
    ctx.db.close();
  });

  it("承認前は支払えない（課金しない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = ctx.originalRoles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    const w = world();

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}`, w), ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(w.guild.roles.create).not.toHaveBeenCalled();
    ctx.db.close();
  });

  it("**作成に失敗したら自動返金する**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world({ createFails: "Missing Permissions" });

    const p = press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}`, w) as unknown as {
      editReply: ReturnType<typeof vi.fn>;
    };
    await handleShopButton(p as never, ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(ctx.originalRoles.get(row.id)!.status).toBe("approved"); // 契約は始まっていない
    expect(contentOf(p.editReply)).toContain("返金");
    ctx.db.close();
  });

  it("**付与に失敗したら作ったロールを残さない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world({ addFails: "Missing Permissions" });

    await handleShopButton(press(ctx, `shop:orole-pay:${ctx.item.id}:${row.id}`, w), ctx.services);

    expect(w.roleDeleted).toEqual(["role-1"]); // 誰のものでもないロールを残さない
    expect(balance(ctx)).toBe(5_000_000); // 返金済み
    ctx.db.close();
  });

  it("二度押しても二重課金せず、ロールも1つだけ", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = approved(ctx);
    const w = world();
    const id = `shop:orole-pay:${ctx.item.id}:${row.id}`;

    await handleShopButton(press(ctx, id, w), ctx.services);
    await handleShopButton(press(ctx, id, w), ctx.services);

    expect(balance(ctx)).toBe(5_000_000 - PRICE);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    expect(w.guild.roles.create).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });
});

describe("更新（スタッフを介さない）", () => {
  function active(ctx: Ctx) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    ctx.originalRoles.activate({ id: row.id, roleId: "role-1", purchaseId: 1, actor: "t" });
    return ctx.originalRoles.get(row.id)!;
  }

  it("確認した料金で更新でき、期限が+30日になる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = active(ctx);

    await handleShopButton(
      press(ctx, `shop:orole-renew-do:${ctx.item.id}:${row.id}:${RENEW}`, world()),
      ctx.services,
    );

    expect(balance(ctx)).toBe(5_000_000 - RENEW);
    expect(ctx.originalRoles.get(row.id)!.expires_at! - row.expires_at!).toBe(30 * DAY);
    ctx.db.close();
  });

  it("**確認後に料金が変わったら課金しない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = active(ctx);
    ctx.settings.set("original_role_renew_price", 300_000, "staff");

    const p = press(ctx, `shop:orole-renew-do:${ctx.item.id}:${row.id}:${RENEW}`, world()) as unknown as {
      update: ReturnType<typeof vi.fn>;
    };
    await handleShopButton(p as never, ctx.services);

    expect(balance(ctx)).toBe(5_000_000);
    expect(ctx.originalRoles.get(row.id)!.expires_at).toBe(row.expires_at);
    expect(contentOf(p.update)).toContain("引き落としていません");
    ctx.db.close();
  });

  it("他人の契約は更新できない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const row = active(ctx);
    ctx.db.prepare("UPDATE original_roles SET user_id='999' WHERE id=?").run(row.id);

    await handleShopButton(
      press(ctx, `shop:orole-renew-do:${ctx.item.id}:${row.id}:${RENEW}`, world()),
      ctx.services,
    );

    expect(balance(ctx)).toBe(5_000_000);
    ctx.db.close();
  });
});

describe("期限まわり", () => {
  function activeWithExpiry(ctx: Ctx, expiresAt: number) {
    const row = ctx.originalRoles.apply({ userId: USER, name: "冥き翼", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    ctx.originalRoles.activate({ id: row.id, roleId: "role-1", purchaseId: 1, actor: "t" });
    ctx.db.prepare("UPDATE original_roles SET expires_at=? WHERE id=?").run(expiresAt, row.id);
    return row.id;
  }

  function fakeClient(w: ReturnType<typeof world>, dm: ReturnType<typeof vi.fn>) {
    return {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => ({ send: dm })) },
    } as never;
  }

  it("期限3日前に本人へ知らせ、二度は送らない", async () => {
    const { notifyExpiringOriginalRoles } = await jobsModule;
    const ctx = setup();
    activeWithExpiry(ctx, Math.floor(Date.now() / 1000) + 2 * DAY);
    const dm = vi.fn(async () => undefined);

    await notifyExpiringOriginalRoles(fakeClient(world(), dm), ctx.services);
    await notifyExpiringOriginalRoles(fakeClient(world(), dm), ctx.services);

    expect(dm).toHaveBeenCalledTimes(1);
    expect(String((dm.mock.calls[0] as never[])[0])).toContain("期限");
    ctx.db.close();
  });

  it("**期限切れでロールを剥奪する**", async () => {
    const { expireOriginalRoles } = await jobsModule;
    const ctx = setup();
    const id = activeWithExpiry(ctx, Math.floor(Date.now() / 1000) - DAY);
    const w = world();
    w.memberRoles.push("role-1");

    await expireOriginalRoles(fakeClient(w, vi.fn(async () => undefined)), ctx.services);

    expect(w.member.roles.remove).toHaveBeenCalledWith("role-1", expect.any(String));
    expect(w.memberRoles).toHaveLength(0);
    expect(ctx.originalRoles.get(id)!.status).toBe("expired");
    ctx.db.close();
  });

  it("剥奪に失敗しても次の巡回で拾い直す", async () => {
    const { expireOriginalRoles } = await jobsModule;
    const ctx = setup();
    const id = activeWithExpiry(ctx, Math.floor(Date.now() / 1000) - DAY);
    const w = world();
    w.member.roles.remove = vi.fn(async () => {
      throw new Error("Missing Permissions");
    });

    await expireOriginalRoles(fakeClient(w, vi.fn(async () => undefined)), ctx.services);

    expect(ctx.originalRoles.get(id)!.role_removed_at).toBeNull();
    expect(ctx.originalRoles.listExpired().map((r) => r.id)).toEqual([id]);
    ctx.db.close();
  });

  it("承認から7日で支払いが無ければ取り消し、本人へ知らせる", async () => {
    const { cancelUnpaidOriginalRoles } = await jobsModule;
    const ctx = setup();
    const row = ctx.originalRoles.apply({ userId: USER, name: "あ", color: null, actor: "t" });
    ctx.originalRoles.approve(row.id, "staff");
    ctx.db.prepare("UPDATE original_roles SET approved_at=? WHERE id=?").run(
      Math.floor(Date.now() / 1000) - 8 * DAY,
      row.id,
    );
    const dm = vi.fn(async () => undefined);

    await cancelUnpaidOriginalRoles(fakeClient(world(), dm), ctx.services);

    expect(ctx.originalRoles.get(row.id)!.status).toBe("cancelled");
    expect(String((dm.mock.calls[0] as never[])[0])).toContain("取り消し");
    ctx.db.close();
  });
});
