import { Collection, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { reconcileTimedAccessRoles } from "../src/timed-access.js";
import type { Services } from "../src/services.js";

const USER = "user-1";
const ROLE = "access-role";

registerDefaultTxTypes();

function setup(opts: { legacy?: boolean } = {}) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const item = shop.createItem(
    {
      name: "期限付きアクセス",
      price_land: 1_000,
      kind: "monthly",
      duration_days: 30,
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE, channel_id: "access-channel" }),
    },
    "staff",
  );
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 10_000,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: `seed:${Math.random()}`,
  });
  const purchase = shop.purchase({ itemId: item.id, userId: USER, actor: USER, memberRoleIds: [] }).purchase;
  if (opts.legacy) {
    db.prepare(
      "UPDATE shop_purchases SET delivery_snapshot_json=NULL, delivery_state='delivered' WHERE id=?",
    ).run(purchase.id);
  } else {
    db.prepare("UPDATE shop_purchases SET delivery_state='delivered' WHERE id=?").run(purchase.id);
  }
  return { db, ledger, events, shop, item, purchase, services: { shop, events } as Services };
}

function guildWith(
  roles: string[] = [],
  opts: { addFails?: boolean; finalFetchFails?: boolean; expireOnAdd?: () => void } = {},
) {
  const cache = new Collection(roles.map((id) => [id, { id }]));
  let fetches = 0;
  const member = {
    id: USER,
    roles: {
      cache,
      add: vi.fn(async (id: string) => {
        if (opts.addFails) throw new Error("temporary add failure");
        cache.set(id, { id });
        opts.expireOnAdd?.();
      }),
      remove: vi.fn(async (id: string) => {
        cache.delete(id);
      }),
    },
  };
  const guild = {
    members: {
      fetch: vi.fn(async () => {
        fetches += 1;
        if (opts.finalFetchFails && fetches > 1) throw new Error("final fetch unavailable");
        return member;
      }),
    },
  } as unknown as Guild;
  return { guild, member, cache };
}

describe("期限付きアクセスの自己修復", () => {
  it("active契約のロールが消れていればforce fetch後に復元する", async () => {
    const ctx = setup();
    const discord = guildWith();

    const result = await reconcileTimedAccessRoles(discord.guild, ctx.services);

    expect(result).toMatchObject({ checked: 1, restored: 1, failed: [] });
    expect(discord.member.roles.add).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(discord.guild.members.fetch).toHaveBeenCalledWith({ user: USER, force: true });
    expect(discord.cache.has(ROLE)).toBe(true);
    expect(ctx.events.listByType("shop_timed_access_restored")).toHaveLength(1);
    ctx.db.close();
  });

  it("ロール付与失敗はactiveのまま記録し、次の巡回で自動復旧する", async () => {
    const ctx = setup();
    const failing = guildWith([], { addFails: true });

    const first = await reconcileTimedAccessRoles(failing.guild, ctx.services);
    expect(first.failed).toHaveLength(1);
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("active");
    expect(failing.cache.has(ROLE)).toBe(false);

    const working = guildWith();
    const second = await reconcileTimedAccessRoles(working.guild, ctx.services);
    expect(second.restored).toBe(1);
    expect(working.cache.has(ROLE)).toBe(true);
    ctx.db.close();
  });

  it("add直後に契約が失効した競合では、自分でロールを剥がしてexpiredへ収束する", async () => {
    const ctx = setup();
    const discord = guildWith([], {
      expireOnAdd: () => ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(ctx.purchase.id),
    });

    await reconcileTimedAccessRoles(discord.guild, ctx.services);

    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("expired");
    expect(discord.member.roles.remove).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(discord.cache.has(ROLE)).toBe(false);
    ctx.db.close();
  });

  it("最終force fetch不能なら配送成功にせず、次回の再試行対象に残す", async () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='failed' WHERE id=?").run(ctx.purchase.id);
    const discord = guildWith([], { finalFetchFails: true });

    const result = await reconcileTimedAccessRoles(discord.guild, ctx.services);

    expect(result.failed).toHaveLength(1);
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.delivery_state).toBe("failed");
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("snapshot導入前の確定済み契約も再参加・再起動時と同じ経路で復元する", async () => {
    const ctx = setup({ legacy: true });
    const discord = guildWith();

    const result = await reconcileTimedAccessRoles(discord.guild, ctx.services, USER);

    expect(result.restored).toBe(1);
    expect(discord.cache.has(ROLE)).toBe(true);
    ctx.db.close();
  });
});
