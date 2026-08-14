import { Collection, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { reconcileTimedAccessForClient, reconcileTimedAccessForGuild } from "../src/timed-access.js";
import { collectTimedAccessLegacyExpectations } from "../src/timed-access-legacy-migration.js";
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
  const settings = { getString: vi.fn((key: string) => key === "guild:main" ? "main-guild" : undefined) };
  return { db, ledger, events, shop, item, purchase, services: { shop, events, settings } as Services };
}

function guildWith(
  roles: string[] = [],
  opts: { id?: string; addFails?: boolean; finalFetchFails?: boolean; expireOnAdd?: () => void } = {},
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
    id: opts.id ?? "main-guild",
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

    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

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

    const first = await reconcileTimedAccessForGuild(failing.guild, ctx.services);
    expect(first.failed).toHaveLength(1);
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("active");
    expect(failing.cache.has(ROLE)).toBe(false);

    const working = guildWith();
    const second = await reconcileTimedAccessForGuild(working.guild, ctx.services);
    expect(second.restored).toBe(1);
    expect(working.cache.has(ROLE)).toBe(true);
    ctx.db.close();
  });

  it("add直後に契約が失効した競合では、自分でロールを剥がしてexpiredへ収束する", async () => {
    const ctx = setup();
    const discord = guildWith([], {
      expireOnAdd: () => ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(ctx.purchase.id),
    });

    await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("expired");
    expect(discord.member.roles.remove).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(discord.cache.has(ROLE)).toBe(false);
    ctx.db.close();
  });

  it("最終force fetch不能なら配送成功にせず、次回の再試行対象に残す", async () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='failed' WHERE id=?").run(ctx.purchase.id);
    const discord = guildWith([], { finalFetchFails: true });

    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services);

    expect(result.failed).toHaveLength(1);
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.delivery_state).toBe("failed");
    expect(ctx.shop.getPurchase(ctx.purchase.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("snapshot導入前の確定済み契約も再参加・再起動時と同じ経路で復元する", async () => {
    const ctx = setup({ legacy: true });
    const discord = guildWith();

    const result = await reconcileTimedAccessForGuild(discord.guild, ctx.services, USER);

    expect(result.restored).toBe(1);
    expect(discord.cache.has(ROLE)).toBe(true);
    ctx.db.close();
  });

  it("GuildMemberAdd相当の復元はmain guild以外でmember fetchもrole変更もしない", async () => {
    const ctx = setup();
    const other = guildWith([], { id: "other-guild" });

    const result = await reconcileTimedAccessForGuild(other.guild, ctx.services, USER);

    expect(result).toEqual({ checked: 0, restored: 0, absent: 0, failed: [] });
    expect(other.guild.members.fetch).not.toHaveBeenCalled();
    expect(other.member.roles.add).not.toHaveBeenCalled();
    ctx.db.close();
  });

  it("起動時復元はguild:mainだけをfetchして収束する", async () => {
    const ctx = setup();
    const main = guildWith();
    const client = { guilds: { fetch: vi.fn(async (id: string) => {
      expect(id).toBe("main-guild");
      return main.guild;
    }) } };

    const result = await reconcileTimedAccessForClient(client as never, ctx.services);

    expect(client.guilds.fetch).toHaveBeenCalledTimes(1);
    expect(result.restored).toBe(1);
    expect(main.cache.has(ROLE)).toBe(true);
    ctx.db.close();
  });
});

describe("legacy移行候補のDiscord実状態取得", () => {
  it("force取得したmain guild memberのうち商品設定roleを持つ人だけを渡す", async () => {
    const ctx = setup();
    const holders = new Collection([
      ["role-user", { id: "role-user", roles: { cache: new Collection([[ROLE, { id: ROLE }]]) } }],
      ["plain-user", { id: "plain-user", roles: { cache: new Collection() } }],
    ]);
    const fetch = vi.fn(async () => holders);
    const guild = { id: "main-guild", members: { fetch } } as unknown as Guild;

    const expectations = await collectTimedAccessLegacyExpectations(
      guild,
      ctx.shop,
      [{ itemId: ctx.item.id, expectedCount: 1 }],
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expectations).toEqual([
      { itemId: ctx.item.id, roleId: ROLE, expectedCount: 1, roleHolderIds: ["role-user"] },
    ]);
    ctx.db.close();
  });
});
