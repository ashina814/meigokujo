import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild } from "discord.js";
import { Entry, EventLog, Ledger, Settings, Shop, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { PurchaseRow, ShopItemRow } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { deliverPurchase, redeliverPurchase } from "../src/shop-delivery.js";

/**
 * 自動配送を「課金の後始末」から独立させた状態機械のテスト。
 *
 * 本番で起きた事故が出発点になっている。再評価チャレンジ（迷霊→案内待ち）で
 * **課金は成立したのに迷霊ロールが外れず**、しかも同じ operation の再実行は
 * `replayed=true` で配送そのものを飛ばすため、二度と配れなかった。
 * 「購入は一度きり・配送は成功するまで何度でも」を守れているかを確かめる。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const ROLE = { meirei: "r-meirei", wait: "r-wait" };
const USER = "1463201396567441441";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const shop = new Shop(db, ledger, events);
  settings.set("role:meirei", ROLE.meirei, "test");
  settings.set("role:queue_wait", ROLE.wait, "test");
  const services = { db, ledger, settings, events, entry, shop } as unknown as Services;

  const item = shop.createItem(
    {
      name: "再評価チャレンジ",
      price_land: 500_000,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "revoke_meirei",
    },
    "test",
  );
  return { db, ledger, settings, events, entry, shop, services, item };
}

/** ロール操作の成否を差し込めるメンバー */
function guildWith(opts: { roles: string[]; removeFails?: boolean; addFails?: boolean; memberMissing?: boolean }) {
  const cache = new Collection(opts.roles.map((r) => [r, { id: r }] as [string, { id: string }]));
  const member = {
    id: USER,
    roles: {
      cache,
      remove: vi.fn(async (id: string) => {
        if (opts.removeFails) throw new Error("Missing Permissions");
        cache.delete(id);
      }),
      add: vi.fn(async (id: string) => {
        if (opts.addFails) throw new Error("Missing Permissions");
        cache.set(id, { id });
      }),
    },
  };
  const guild = {
    members: { fetch: vi.fn(async () => (opts.memberMissing ? Promise.reject(new Error("Unknown Member")) : member)) },
  } as unknown as Guild;
  return { guild, member };
}

/** 課金まで済んだ購入行を作る（配送はまだ） */
function buy(ctx: ReturnType<typeof setup>): PurchaseRow {
  ctx.ledger.ensureAccount(`user:${USER}`, "user");
  ctx.ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "test",
    idempotencyKey: `seed-${Math.random()}`,
  });
  const result = ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: "test", memberRoleIds: [] });
  return result.purchase;
}

const stateOf = (ctx: ReturnType<typeof setup>, id: number) =>
  ctx.db.prepare("SELECT delivery_state, delivery_attempts, delivery_error, delivered_at FROM shop_purchases WHERE id=?").get(id) as {
    delivery_state: string | null;
    delivery_attempts: number;
    delivery_error: string | null;
    delivered_at: number | null;
  };

describe("再評価チャレンジの自動配送", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("DB=迷霊 + 迷霊ロールあり → 案内待ちへ戻り、ロールも直り、delivered になる", async () => {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    const { guild, member } = guildWith({ roles: [ROLE.meirei] });

    const outcome = await deliverPurchase(ctx.services, guild, purchase, ctx.item as ShopItemRow, "test");

    expect(outcome.state).toBe("delivered");
    expect(ctx.entry.getSoul(USER)!.status).toBe("waiting");
    expect(member.roles.remove).toHaveBeenCalledWith(ROLE.meirei);
    expect(member.roles.add).toHaveBeenCalledWith(ROLE.wait);
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("delivered");
    expect(stateOf(ctx, purchase.id).delivered_at).not.toBeNull();
  });

  it("DBのresetは成功、ロール削除が失敗 → failed。再試行でロールだけ直り、DBは二度resetしない", async () => {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);

    // 1回目: ロール削除だけ失敗する
    const failing = guildWith({ roles: [ROLE.meirei], removeFails: true });
    const first = await deliverPurchase(ctx.services, failing.guild, purchase, ctx.item as ShopItemRow, "test");

    expect(first.state).toBe("failed");
    expect(first.error).toContain("meirei_role_remove_failed");
    // 「配送しました」と読める文言を返さない
    expect(first.message).not.toContain("戻しました");
    expect(ctx.entry.getSoul(USER)!.status).toBe("waiting"); // DB側は済んでいる
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("failed");
    const updatedAfterFirst = ctx.entry.getSoul(USER)!.updated_at;

    // 2回目: ロール操作が通る環境で再試行
    const working = guildWith({ roles: [ROLE.meirei] });
    const second = await deliverPurchase(ctx.services, working.guild, ctx.shop.getPurchase(purchase.id)!, ctx.item as ShopItemRow, "test");

    expect(second.state).toBe("delivered");
    expect(working.member.roles.remove).toHaveBeenCalledWith(ROLE.meirei);
    // 二度目の resetToWaiting が走っていない（updated_at が動かない・ghost_reset も増えない）
    expect(ctx.entry.getSoul(USER)!.updated_at).toBe(updatedAfterFirst);
    expect(ctx.events.listByTarget(USER).filter((e) => e.type === "ghost_reset")).toHaveLength(1);
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("delivered");
    expect(stateOf(ctx, purchase.id).delivery_attempts).toBe(2);
  });

  it("DB=案内待ちだが迷霊ロールが残っている → 再配送でロールだけ修復する（本番で起きた形）", async () => {
    ctx.entry.recordJoin(USER); // waiting のまま
    const purchase = buy(ctx);
    const { guild, member } = guildWith({ roles: [ROLE.meirei] });
    const before = ctx.entry.getSoul(USER)!.updated_at;

    const outcome = await deliverPurchase(ctx.services, guild, purchase, ctx.item as ShopItemRow, "test");

    expect(outcome.state).toBe("delivered");
    expect(member.roles.remove).toHaveBeenCalledWith(ROLE.meirei);
    expect(member.roles.add).toHaveBeenCalledWith(ROLE.wait);
    // DBは触らない（再resetしない）
    expect(ctx.entry.getSoul(USER)!.status).toBe("waiting");
    expect(ctx.entry.getSoul(USER)!.updated_at).toBe(before);
    expect(ctx.events.listByTarget(USER).filter((e) => e.type === "ghost_reset")).toHaveLength(0);
  });

  it("DBもロールも既に正常なら、何もせず成功する（冪等）", async () => {
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    const { guild, member } = guildWith({ roles: [ROLE.wait] });

    const outcome = await deliverPurchase(ctx.services, guild, purchase, ctx.item as ShopItemRow, "test");

    expect(outcome.state).toBe("delivered");
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("member取得に失敗したら success 扱いにしない", async () => {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    const { guild } = guildWith({ roles: [ROLE.meirei], memberMissing: true });

    const outcome = await deliverPurchase(ctx.services, guild, purchase, ctx.item as ShopItemRow, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("member_fetch_failed");
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("failed");
  });

  it("guildが取れない（DM実行など）でも success 扱いにしない", async () => {
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);

    const outcome = await deliverPurchase(ctx.services, null, purchase, ctx.item as ShopItemRow, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("guild_unavailable");
  });

  it("亡霊や魔人へは効かせない（迷霊・案内待ち以外は拒否）", async () => {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test"); // ghost
    const purchase = buy(ctx);
    const { guild } = guildWith({ roles: [] });

    const outcome = await deliverPurchase(ctx.services, guild, purchase, ctx.item as ShopItemRow, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("unexpected_status:ghost");
    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
  });

  it("delivered 後に再試行しても副作用が無い", async () => {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    const first = guildWith({ roles: [ROLE.meirei] });
    await deliverPurchase(ctx.services, first.guild, purchase, ctx.item as ShopItemRow, "test");
    const soulAfter = ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER);
    const attemptsAfter = stateOf(ctx, purchase.id).delivery_attempts;

    const again = guildWith({ roles: [] });
    const outcome = await deliverPurchase(ctx.services, again.guild, ctx.shop.getPurchase(purchase.id)!, ctx.item as ShopItemRow, "test");

    expect(outcome.state).toBe("already_delivered");
    expect(again.guild.members.fetch).not.toHaveBeenCalled();
    expect(again.member.roles.add).not.toHaveBeenCalled();
    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER)).toEqual(soulAfter);
    // 試行回数も増やさない
    expect(stateOf(ctx, purchase.id).delivery_attempts).toBe(attemptsAfter);
  });

  it("同じ購入を何度配送しても二重課金にならない（課金は購入時の一度きり）", async () => {
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    const balanceAfterPurchase = ctx.ledger.balanceOf(`user:${USER}`);

    const failing = guildWith({ roles: [ROLE.meirei], removeFails: true });
    await deliverPurchase(ctx.services, failing.guild, purchase, ctx.item as ShopItemRow, "test");
    await deliverPurchase(ctx.services, failing.guild, ctx.shop.getPurchase(purchase.id)!, ctx.item as ShopItemRow, "test");
    const working = guildWith({ roles: [ROLE.meirei] });
    await deliverPurchase(ctx.services, working.guild, ctx.shop.getPurchase(purchase.id)!, ctx.item as ShopItemRow, "test");

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(balanceAfterPurchase);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 1 });
  });
});

describe("運営の回収導線（purchase ID 指定の再配送）", () => {
  it("未配送の購入を purchase ID から再配送できる", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    const { guild, member } = guildWith({ roles: [ROLE.meirei] });

    const outcome = await redeliverPurchase(ctx.services, guild, purchase.id, "user:staff");

    expect(outcome.state).toBe("delivered");
    expect(member.roles.remove).toHaveBeenCalledWith(ROLE.meirei);
    expect(ctx.events.listByTarget(USER).map((e) => e.type)).toContain("shop_redelivery_requested");
  });

  it("存在しない購入・返金済みの購入は動かせない（任意の効果を撃つ口にしない）", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    const { guild } = guildWith({ roles: [ROLE.meirei] });

    expect((await redeliverPurchase(ctx.services, guild, 9999, "user:staff")).error).toBe("purchase_not_found");

    ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(purchase.id);
    const refunded = await redeliverPurchase(ctx.services, guild, purchase.id, "user:staff");
    expect(refunded.error).toBe("purchase_not_active");
    expect(refunded.state).toBe("failed");
  });

  it("未配送一覧は自動配送の未完了だけを拾う", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    expect(ctx.shop.listUndeliveredAuto().map((p) => p.id)).toEqual([purchase.id]);

    const { guild } = guildWith({ roles: [ROLE.meirei] });
    await deliverPurchase(ctx.services, guild, purchase, ctx.item as ShopItemRow, "test");
    expect(ctx.shop.listUndeliveredAuto()).toHaveLength(0);
  });
});
