import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { Departments, EventLog, Ledger, Settings, Shop, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 商館スタッフの常設パネル。
 *
 * **通知を仕事の正本にしない。** 以前は手動対応の依頼が #決裁 へ流れ、その
 * メッセージの「配送完了」だけが完了手段だった。流れて見失うと復旧できず、
 * 実際に購入 #1 が1か月放置された。ここでは「パネルを開けば残っている仕事が分かり、
 * その場で終わらせられる」ことを実ハンドラで固定する。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shokanModule = import("../src/commands/shokan.js");
const shopPanelModule = import("../src/commands/shop-panel.js");

const USER = "1463201396567441441";
const STAFF = "222222222222222222";
const ADMIN_ROLE = "r-admin";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const departments = new Departments(db, events);
  const nickname = shop.createItem({ name: "名前変更", price_land: 50_000, kind: "one_shot", delivery: "manual" }, "staff");
  const reeval = shop.createItem({ name: "再評価チャレンジ", price_land: 500_000, kind: "one_shot", delivery: "manual" }, "staff");
  const pass = shop.createItem(
    {
      name: "裏チャット入場券",
      price_land: 80_000,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "r-ura" }),
    },
    "staff",
  );
  settings.set("shop:reeval_item_id", reeval.id, "staff");
  settings.set("role:admin", ADMIN_ROLE, "staff");
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
  const services = { db, ledger, settings, events, shop, departments } as unknown as Services;
  return { db, ledger, settings, events, shop, departments, nickname, reeval, pass, services };
}

type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx, itemId: number) =>
  ctx.shop.purchase({ itemId, userId: USER, actor: USER, memberRoleIds: [] }).purchase;

/** 常設パネル（=ephemeralではないメッセージ）から押した体のインタラクション */
function panelPress(customId: string, reply: ReturnType<typeof vi.fn>) {
  return {
    customId,
    user: { id: STAFF, username: "staff" },
    member: { roles: { cache: new Collection([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) } },
    message: { flags: { has: () => false } },
    client: { channels: { fetch: vi.fn(async () => null) } },
    guild: null,
    reply,
    update: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
  } as never;
}

const payloadOf = (fn: ReturnType<typeof vi.fn>, call = 0) =>
  (fn.mock.calls[call] as never[])[0] as {
    embeds: { data: { title?: string; description?: string } }[];
    components?: { toJSON(): { components: { custom_id: string; label: string; style: number }[] } }[];
    content?: string;
  };

const idsOf = (payload: ReturnType<typeof payloadOf>) =>
  (payload.components ?? []).flatMap((r) => r.toJSON().components).map((c) => c.custom_id);

describe("常設パネルの表示", () => {
  it("残っている仕事の件数が出る", async () => {
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    buy(ctx, ctx.nickname.id);

    const panel = shopAdminPanelMessage(ctx.services) as ReturnType<typeof payloadOf>;

    expect(panel.embeds[0]!.data.description).toContain("要対応 1件");
    expect(idsOf(panel)).toEqual(["shokan:pending", "shokan:failed", "shokan:list", "shokan:history:0"]);
    ctx.db.close();
  });

  it("仕事が無ければそう言う（個人情報は載せない）", async () => {
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();

    const panel = shopAdminPanelMessage(ctx.services) as ReturnType<typeof payloadOf>;

    expect(panel.embeds[0]!.data.description).toContain("残っている仕事はありません");
    expect(JSON.stringify(panel)).not.toContain(USER);
    ctx.db.close();
  });

  it("再評価チャレンジは要対応に出ない（終わらせる方法が無い仕事を並べない）", async () => {
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    buy(ctx, ctx.reeval.id);

    expect((shopAdminPanelMessage(ctx.services) as ReturnType<typeof payloadOf>).embeds[0]!.data.description).toContain(
      "残っている仕事はありません",
    );
    ctx.db.close();
  });

  it("**モジュールの読み込み順に依存しない**（循環importでパネルが壊れない）", async () => {
    // shop-panel → shokan の一方向。先に shop-panel を読んでも常設パネルは描ける
    const { shopPanelMessage } = await shopPanelModule;
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();

    expect(shopPanelMessage(ctx.services).embeds).toBeDefined();
    expect((shopAdminPanelMessage(ctx.services) as ReturnType<typeof payloadOf>).embeds[0]!.data.title).toBe("🛠 冥界商館 管理");
    ctx.db.close();
  });
});

describe("要対応キュー", () => {
  it("パネルから開くと一覧と完了ボタンが同じ画面に出る", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.nickname.id);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress("shokan:pending", reply), ctx.services);

    const payload = payloadOf(reply);
    expect(payload.embeds[0]!.data.description).toContain(`#${purchase.id}`);
    expect(idsOf(payload)).toContain(`shokan:deliver:${purchase.id}`);
    ctx.db.close();
  });

  it("完了を押すと対応済みになり、一覧から消える", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.nickname.id);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, reply), ctx.services);

    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).not.toBeNull();
    expect(payloadOf(reply).embeds[0]!.data.description).toContain("対応待ちはありません");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    ctx.db.close();
  });

  it("**通知を見失っても回収できる**（通知メッセージ無しで完了できる）", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.nickname.id);

    // 通知は一切参照せず、パネル → 要対応 → 完了 だけで終わる
    const list = vi.fn(async () => undefined);
    await handleShokanButton(panelPress("shokan:pending", list), ctx.services);
    const deliverId = idsOf(payloadOf(list)).find((id) => id.startsWith("shokan:deliver:"))!;
    const done = vi.fn(async () => undefined);
    await handleShokanButton(panelPress(deliverId, done), ctx.services);

    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).not.toBeNull();
    ctx.db.close();
  });

  it("再評価チャレンジは完了にできない（権利が消えない）", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.reeval.id);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, reply), ctx.services);

    expect(String(payloadOf(reply).content)).toContain("再評価を受ける権利");
    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
    ctx.db.close();
  });

  it("二重に完了しても記録は1回だけ", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.nickname.id);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, vi.fn(async () => undefined)), ctx.services);
    const second = vi.fn(async () => undefined);
    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, second), ctx.services);

    expect(String(payloadOf(second).content)).toContain("既に対応済み");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    ctx.db.close();
  });
});

describe("処理失敗キュー", () => {
  it("Botが終われなかった自動配送だけが出て、再試行できる", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.pass.id);
    ctx.shop.beginDelivery(purchase.id);
    ctx.shop.markDeliveryFailed(purchase.id, "Missing Permissions");
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress("shokan:failed", reply), ctx.services);

    const payload = payloadOf(reply);
    expect(payload.embeds[0]!.data.description).toContain("Missing Permissions");
    expect(idsOf(payload)).toContain(`shokan:retry:${purchase.id}`);
    ctx.db.close();
  });

  it("手動対応の購入は処理失敗に混ざらない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    buy(ctx, ctx.nickname.id);
    buy(ctx, ctx.reeval.id);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress("shokan:failed", reply), ctx.services);

    expect(payloadOf(reply).embeds[0]!.data.description).toContain("Botが終われなかった処理はありません");
    ctx.db.close();
  });
});

describe("商品設定", () => {
  it("新規作成と配送設定は無くなっている（Botが知らない商品を作らせない）", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress("shokan:list", reply), ctx.services);

    const payload = payloadOf(reply);
    const ids = idsOf(payload);
    expect(ids).toContain("shokan:pick");
    expect(ids).not.toContain("shokan:new");
    expect(JSON.stringify(payload)).not.toContain("配送設定");
    ctx.db.close();
  });

  it("編集できるのは名前・価格・説明・階級要件・販売ON/OFF だけ", async () => {
    const { handleShokanButton, handleShokanModal } = await shokanModule;
    const ctx = setup();
    const reply = vi.fn(async () => undefined);
    await handleShokanButton(panelPress(`shokan:toggle:${ctx.nickname.id}`, reply), ctx.services);
    expect(ctx.shop.getItem(ctx.nickname.id)!.enabled).toBe(0);

    await handleShokanModal(
      {
        customId: `shokan:edit-basic:${ctx.nickname.id}`,
        user: { id: STAFF },
        member: { roles: { cache: new Collection([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) } },
        fields: {
          getTextInputValue: (id: string) => ({ name: "改名", price: "1000", desc: "せつめい" })[id] ?? "",
        },
        reply: vi.fn(async () => undefined),
      } as never,
      ctx.services,
    );

    const item = ctx.shop.getItem(ctx.nickname.id)!;
    expect({ name: item.name, price: item.price_land, desc: item.description }).toEqual({
      name: "改名",
      price: 1000,
      desc: "せつめい",
    });
    // 配送方法と期間は触れない
    expect(item.delivery).toBe("manual");
    expect(item.duration_days).toBeNull();
    ctx.db.close();
  });
});

describe("通知", () => {
  it("手動対応の通知にボタンを置かない（通知を仕事の正本にしない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    ctx.settings.set("channel:kessai", "ch-1", "staff");
    const send = vi.fn(async () => undefined);
    const interaction = {
      customId: `shop:buy:${ctx.nickname.id}:land`,
      user: { id: USER },
      guildId: "g1",
      guild: { id: "g1", members: { fetch: vi.fn(async () => ({ id: USER, roles: { cache: new Collection() } })) } },
      member: { roles: { cache: new Collection() } },
      id: "op-1",
      client: { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send, messages: { fetch: vi.fn() } })) } },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    } as never;

    await handleShopButton(interaction, ctx.services);

    expect(send).toHaveBeenCalledTimes(1);
    const notice = (send.mock.calls[0] as never[])[0] as { content: string; components?: unknown[] };
    expect(notice.components ?? []).toEqual([]);
    expect(notice.content).toContain("要対応");
    ctx.db.close();
  });
});
