import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import type { Guild } from "discord.js";
import { Entry, EventLog, Ledger, Settings, Shop, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { PurchaseRow } from "@meigokujo/core";
import type { Services } from "../src/services.js";

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

// config.ts は環境変数が無いと process.exit(1) するため、shop-delivery は静的 import できない。
// env を先に立ててから動的 import する（ita-land-event.test.ts と同じ流儀）
const deliveryModule = import("../src/shop-delivery.js");

const ROLE = { meirei: "r-meirei", wait: "r-wait", vip: "r-vip" };
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
      name: "特別ロール",
      price_land: 500_000,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE.vip }),
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

describe("自動配送の状態機械", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("正常に配れたら delivered になる", async () => {
    const purchase = buy(ctx);
    const { guild, member } = guildWith({ roles: [] });

    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, guild, purchase, "test");

    expect(outcome.state).toBe("delivered");
    expect(member.roles.add).toHaveBeenCalledWith(ROLE.vip);
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("delivered");
    expect(stateOf(ctx, purchase.id).delivered_at).not.toBeNull();
  });

  it("ロール付与に失敗したら failed。握り潰さず再試行で完了できる", async () => {
    const purchase = buy(ctx);

    const failing = guildWith({ roles: [], addFails: true });
    const first = await (await deliveryModule).deliverPurchase(ctx.services, failing.guild, purchase, "test");

    expect(first.state).toBe("failed");
    expect(first.error).toContain("role_add_failed");
    expect(first.message).not.toContain("付与しました");
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("failed");

    const working = guildWith({ roles: [] });
    const second = await (await deliveryModule).deliverPurchase(ctx.services, working.guild, ctx.shop.getPurchase(purchase.id)!, "test");

    expect(second.state).toBe("delivered");
    expect(stateOf(ctx, purchase.id).delivery_attempts).toBe(2);
  });

  it("既にロールを持っていれば何もせず成功する（冪等）", async () => {
    const purchase = buy(ctx);
    const { guild, member } = guildWith({ roles: [ROLE.vip] });

    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, guild, purchase, "test");

    expect(outcome.state).toBe("delivered");
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it("member取得に失敗したら success 扱いにしない", async () => {
    const purchase = buy(ctx);
    const { guild } = guildWith({ roles: [], memberMissing: true });

    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, guild, purchase, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("member_fetch_failed");
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("failed");
  });

  it("guildが取れない（DM実行など）でも success 扱いにしない", async () => {
    const purchase = buy(ctx);

    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, null, purchase, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("guild_unavailable");
  });

  it("delivered 後に再試行しても副作用が無い", async () => {
    const purchase = buy(ctx);
    const first = guildWith({ roles: [] });
    await (await deliveryModule).deliverPurchase(ctx.services, first.guild, purchase, "test");
    const attemptsAfter = stateOf(ctx, purchase.id).delivery_attempts;

    const again = guildWith({ roles: [] });
    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, again.guild, ctx.shop.getPurchase(purchase.id)!, "test");

    expect(outcome.state).toBe("already_delivered");
    expect(again.guild.members.fetch).not.toHaveBeenCalled();
    expect(again.member.roles.add).not.toHaveBeenCalled();
    expect(stateOf(ctx, purchase.id).delivery_attempts).toBe(attemptsAfter);
  });

  it("同じ購入を何度配送しても二重課金にならない", async () => {
    const purchase = buy(ctx);
    const balanceAfterPurchase = ctx.ledger.balanceOf(`user:${USER}`);

    const failing = guildWith({ roles: [], addFails: true });
    await (await deliveryModule).deliverPurchase(ctx.services, failing.guild, purchase, "test");
    await (await deliveryModule).deliverPurchase(ctx.services, failing.guild, ctx.shop.getPurchase(purchase.id)!, "test");
    const working = guildWith({ roles: [] });
    await (await deliveryModule).deliverPurchase(ctx.services, working.guild, ctx.shop.getPurchase(purchase.id)!, "test");

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(balanceAfterPurchase);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 1 });
  });
});

describe("再評価チャレンジ（revoke_meirei）は自動配送しない", () => {
  /**
   * 仕様変更: 購入 → 再評価面談チケット → 人間が面談 → OKなら亡霊へ復帰。
   * 機械が status とロールを動かしてよい対象ではなくなったので、
   * 旧仕様で売られた購入も自動では実行しない。
   */
  function legacyRevokePurchase(ctx: ReturnType<typeof setup>) {
    const item = ctx.shop.createItem(
      { name: "再評価チャレンジ", price_land: 100, kind: "one_shot", delivery: "auto", delivery_kind: "revoke_meirei" },
      "test",
    );
    ctx.ledger.ensureAccount(`user:${USER}`, "user");
    ctx.ledger.transfer({
      from: "sys:treasury",
      to: `user:${USER}`,
      amount: 1_000,
      type: "adjust",
      actor: "test",
      idempotencyKey: `seed-${Math.random()}`,
    });
    return ctx.shop.purchase({ itemId: item.id, userId: USER, actor: "test", memberRoleIds: [] }).purchase;
  }

  it("status も迷霊ロールも変えない（面談を経ずに復帰させない）", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER);
    const purchase = legacyRevokePurchase(ctx);
    const { guild, member } = guildWith({ roles: [] });

    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, guild, purchase, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("auto_delivery_withdrawn:revoke_meirei");
    expect(outcome.message).toContain("再評価面談チケット");
    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER)).toEqual(before);
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(ctx.events.listByTarget(USER).filter((e) => e.type === "ghost_reset")).toHaveLength(0);
  });

  it("運営の回収導線からも実行できない", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = legacyRevokePurchase(ctx);
    const { guild } = guildWith({ roles: [] });

    const outcome = await (await deliveryModule).redeliverPurchase(ctx.services, guild, purchase.id, "user:staff");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("auto_delivery_withdrawn:revoke_meirei");
  });

  it("未配送一覧にも出さない（誤って撃たせない）", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = legacyRevokePurchase(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='pending' WHERE id=?").run(purchase.id);

    expect(ctx.shop.listUndeliveredAuto().map((p) => p.id)).not.toContain(purchase.id);
  });
});

describe("運営の回収導線（purchase ID 指定の再配送）", () => {
  it("未配送の購入を purchase ID から再配送できる", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    const { guild, member } = guildWith({ roles: [] });

    const outcome = await (await deliveryModule).redeliverPurchase(ctx.services, guild, purchase.id, "user:staff");

    expect(outcome.state).toBe("delivered");
    expect(member.roles.add).toHaveBeenCalledWith(ROLE.vip);
    expect(ctx.events.listByTarget(USER).map((e) => e.type)).toContain("shop_redelivery_requested");
  });

  it("存在しない購入・返金済みの購入は動かせない（任意の効果を撃つ口にしない）", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    const { guild } = guildWith({ roles: [] });

    expect((await (await deliveryModule).redeliverPurchase(ctx.services, guild, 9999, "user:staff")).error).toBe("purchase_not_found");

    ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(purchase.id);
    const refunded = await (await deliveryModule).redeliverPurchase(ctx.services, guild, purchase.id, "user:staff");
    expect(refunded.error).toBe("purchase_not_active");
    expect(refunded.state).toBe("failed");
  });

  it("未配送一覧は自動配送の未完了だけを拾う", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    expect(ctx.shop.listUndeliveredAuto().map((p) => p.id)).toEqual([purchase.id]);

    const { guild } = guildWith({ roles: [] });
    await (await deliveryModule).deliverPurchase(ctx.services, guild, purchase, "test");
    expect(ctx.shop.listUndeliveredAuto()).toHaveLength(0);
  });
});

describe("並行試行と確定済みの成功", () => {
  it("成功が確定したあとに古い試行の失敗が届いても、delivered へ戻さない", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);

    // A と B が同じ購入を並行で拾う（どちらも beginDelivery を通過する）
    const a = ctx.shop.beginDelivery(purchase.id);
    const b = ctx.shop.beginDelivery(purchase.id);
    expect(a.proceed).toBe(true);
    expect(b.proceed).toBe(true);

    // A が先に成功して確定
    expect(ctx.shop.markDeliverySucceeded(purchase.id, "A")).toBe(true);
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("delivered");

    // 遅れて B の失敗が届く
    const accepted = ctx.shop.markDeliveryFailed(purchase.id, "member_fetch_failed", "B");

    expect(accepted).toBe(false);
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("delivered");
    expect(stateOf(ctx, purchase.id).delivered_at).not.toBeNull();
    expect(stateOf(ctx, purchase.id).delivery_error).toBeNull();
    // 握り潰さず、無視した事実は残す
    expect(ctx.events.listByType("shop_delivery_failure_ignored")).toHaveLength(1);
    expect(ctx.events.listByType("shop_delivery_failed")).toHaveLength(0);
    // 回収一覧にも戻ってこない（運営が二度目を撃たされない）
    expect(ctx.shop.listUndeliveredAuto()).toHaveLength(0);
  });

  it("実際に配送実行が競合しても、確定した成功が失敗で塗り替わらない", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    const ok = guildWith({ roles: [ROLE.meirei] });
    const broken = guildWith({ roles: [ROLE.meirei], memberMissing: true });

    // 失敗する試行が beginDelivery だけ先に通過した状態を作る
    ctx.shop.beginDelivery(purchase.id);
    // その隙に成功する試行が最後まで走る
    await (await deliveryModule).deliverPurchase(ctx.services, ok.guild, ctx.shop.getPurchase(purchase.id)!, "test");
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("delivered");

    // 古い試行が失敗して戻ってくる
    const late = await (await deliveryModule).deliverPurchase(ctx.services, broken.guild, ctx.shop.getPurchase(purchase.id)!, "test");

    // 二重配送も巻き戻しも起きない
    expect(late.state).toBe("already_delivered");
    expect(stateOf(ctx, purchase.id).delivery_state).toBe("delivered");
  });

  it("競合で二重に完了マークしても shop_delivered は1回しか記録しない", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);

    expect(ctx.shop.markDeliverySucceeded(purchase.id, "A")).toBe(true);
    expect(ctx.shop.markDeliverySucceeded(purchase.id, "B")).toBe(false);

    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
  });

  it("効果も二度走らない（completeDeliveryWith の effect は確定した1回だけ）", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    const effect = vi.fn();

    expect(ctx.shop.completeDeliveryWith(purchase.id, "A", effect)).toBe(true);
    expect(ctx.shop.completeDeliveryWith(purchase.id, "B", effect)).toBe(false);

    expect(effect).toHaveBeenCalledTimes(1);
  });
});

describe("再配送は購入時スナップショットだけを正本にする", () => {
  it("購入後に商品の配送設定を変えても、過去購入の配送内容は変わらない", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx); // r-vip を配る商品として売った

    // 商品の配送先ロールを別物へ差し替える
    ctx.shop.updateItem(
      ctx.item.id,
      { delivery: "auto", delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: "r-changed-later" }) },
      "test",
    );

    const { guild, member } = guildWith({ roles: [] });
    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, guild, ctx.shop.getPurchase(purchase.id)!, "test");

    // 売った時点の r-vip が配られる。差し替え後のロールは付かない
    expect(outcome.state).toBe("delivered");
    expect(member.roles.add).toHaveBeenCalledWith(ROLE.vip);
    expect(member.roles.add).not.toHaveBeenCalledWith("r-changed-later");
  });

  it("購入後に配送種別ごと変えても、売った時点の種別で実行される", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, "test");
    const purchase = buy(ctx); // add_role として売った
    const deadlineBefore = ctx.entry.getSoul(USER)!.eval_deadline_at;

    // 商品を「評価期限の延長」へ作り替える
    ctx.shop.updateItem(
      ctx.item.id,
      { delivery: "auto", delivery_kind: "extend_deadline", delivery_data: JSON.stringify({ days: 30 }) },
      "test",
    );

    const { guild, member } = guildWith({ roles: [] });
    await (await deliveryModule).deliverPurchase(ctx.services, guild, ctx.shop.getPurchase(purchase.id)!, "test");

    expect(member.roles.add).toHaveBeenCalledWith(ROLE.vip);
    // 期限は動かない（extend_deadline は売られていない）
    expect(ctx.entry.getSoul(USER)!.eval_deadline_at).toBe(deadlineBefore);
  });

  it("商品を手動配送へ変えても、自動配送として売った過去購入は再配送できる", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    ctx.shop.updateItem(ctx.item.id, { delivery: "manual", delivery_kind: null }, "test");

    const { guild } = guildWith({ roles: [] });
    const outcome = await (await deliveryModule).redeliverPurchase(ctx.services, guild, purchase.id, "user:staff");

    expect(outcome.state).toBe("delivered");
  });

  it("スナップショットが無ければ、現在の商品定義で代用せず何もしない", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET delivery_snapshot_json = NULL WHERE id=?").run(purchase.id);

    const { guild, member } = guildWith({ roles: [] });
    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, guild, ctx.shop.getPurchase(purchase.id)!, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("snapshot_missing");
    expect(member.roles.remove).not.toHaveBeenCalled();
    expect(ctx.entry.getSoul(USER)!.status).toBe("meirei"); // 触っていない
  });

  it("スナップショットが壊れていても現在の商品定義へ落ちない", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET delivery_snapshot_json = '{壊れたJSON' WHERE id=?").run(purchase.id);

    const { guild, member } = guildWith({ roles: [] });
    const outcome = await (await deliveryModule).deliverPurchase(ctx.services, guild, ctx.shop.getPurchase(purchase.id)!, "test");

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("snapshot_unreadable");
    expect(member.roles.remove).not.toHaveBeenCalled();
  });

  it("スナップショットの無い購入は回収一覧にも再配送導線にも出さない", async () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    const purchase = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET delivery_snapshot_json = NULL, delivery_state='pending' WHERE id=?").run(purchase.id);

    expect(ctx.shop.listUndeliveredAuto()).toHaveLength(0);
    const { guild } = guildWith({ roles: [] });
    const outcome = await (await deliveryModule).redeliverPurchase(ctx.services, guild, purchase.id, "user:staff");
    expect(outcome.error).toBe("snapshot_missing");
  });
});
