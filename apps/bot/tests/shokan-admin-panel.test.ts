import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { Departments, EventLog, Ledger, OriginalRoles, Settings, Shop, SubAccounts, openDb, registerDefaultTxTypes } from "@meigokujo/core";
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
  // 面談権は実際の発行経路で作る（genericなstorefront購入では作れない）。
  let reevalItemId: number | null = null;
  const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
  const departments = new Departments(db, ledger);
  const nickname = shop.createItem({ name: "名前変更", price_land: 50_000, kind: "one_shot", delivery: "manual" }, "staff");
  const reeval = shop.createItem(
    { name: "再評価チャレンジ", price_land: 500_000, price_alt_kind: "invite", price_alt_amount: 5, kind: "one_shot", delivery: "manual" },
    "staff",
  );
  reevalItemId = reeval.id;
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
  const originalRoles = new OriginalRoles(db, ledger, events);
  const subAccounts = new SubAccounts(db, events);
  const services = { db, ledger, settings, events, shop, originalRoles, subAccounts, departments } as unknown as Services;
  return { db, ledger, settings, events, shop, departments, nickname, reeval, pass, services };
}

type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx, itemId: number) => {
  if (itemId === ctx.reeval.id) {
    ctx.db.prepare("INSERT OR IGNORE INTO souls (user_id,status,updated_at) VALUES (?, 'meirei', 1)").run(USER);
    return ctx.shop.purchaseReevaluation({
      itemId, userId: USER, actor: USER, memberRoleIds: [],
      mode: "land", idempotencyKey: `reeval:${USER}:${Math.random()}`,
    }).purchase;
  }
  return ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken, itemId, userId: USER, actor: USER, memberRoleIds: [] }).purchase;
};

/** 別の利用者としてまとめて購入する（キューを積むため） */
function buyAs(ctx: Ctx, itemId: number, userId: string) {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: "sys:treasury",
    to: `user:${userId}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: `seed:${userId}`,
  });
  if (itemId === ctx.reeval.id) {
    ctx.db.prepare("INSERT OR IGNORE INTO souls (user_id,status,updated_at) VALUES (?, 'meirei', 1)").run(userId);
    return ctx.shop.purchaseReevaluation({
      itemId, userId, actor: userId, memberRoleIds: [],
      mode: "land", idempotencyKey: `reeval:${userId}:${Math.random()}`,
    }).purchase;
  }
  return ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken, itemId, userId, actor: userId, memberRoleIds: [] }).purchase;
}

/** 常設パネル（=ephemeralではないメッセージ）から押した体のインタラクション */
function panelPress(
  customId: string,
  reply: ReturnType<typeof vi.fn>,
  options: { userId?: string; roleIds?: string[] } = {},
) {
  const roleIds = options.roleIds ?? [ADMIN_ROLE];
  return {
    customId,
    user: { id: options.userId ?? STAFF, username: "staff" },
    member: { roles: { cache: new Collection(roleIds.map((id) => [id, { id }])) } },
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
    expect(idsOf(panel)).toEqual([
      "shokan:pending",
      "shokan:failed",
      "shokan:list",
      "shokan:orole",
      "shokan:history:0",
      "shokan:sub",
      "shokan:reeval-comp",
      "shokan:legacy-unknown",
    ]);
    expect(panel.components?.every((row) => row.toJSON().components.length <= 5)).toBe(true);
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

describe("再評価チャレンジ例外補償の権限", () => {
  it("商館部署担当者だけでは補償一覧を開けず、既存の運営権限なら開ける", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    ctx.departments.upsert("冥界商館", "冥界商館", "role:shop");

    const deniedReply = vi.fn(async () => undefined);
    await handleShokanButton(
      panelPress("shokan:reeval-comp", deniedReply, { userId: "shop-staff", roleIds: ["role:shop"] }),
      ctx.services,
    );
    expect(String(payloadOf(deniedReply).content)).toContain("獄卒判断");

    const allowedReply = vi.fn(async () => undefined);
    await handleShokanButton(panelPress("shokan:reeval-comp", allowedReply), ctx.services);
    expect(payloadOf(allowedReply).embeds[0]!.data.title).toContain("再評価チャレンジ");
    ctx.db.close();
  });

  it("商館部署担当者はstale selectやmodalからも補償を確定できない", async () => {
    const { handleShokanModal, handleShokanSelect } = await shokanModule;
    const ctx = setup();
    ctx.departments.upsert("冥界商館", "冥界商館", "role:shop");

    const selectReply = vi.fn(async () => undefined);
    const selectUpdate = vi.fn(async () => undefined);
    await handleShokanSelect(
      {
        customId: "shokan:reeval-comp-purchase",
        values: ["1"],
        user: { id: "shop-staff" },
        member: { roles: { cache: new Collection([["role:shop", { id: "role:shop" }]]) } },
        isStringSelectMenu: () => true,
        isRoleSelectMenu: () => false,
        reply: selectReply,
        update: selectUpdate,
      } as never,
      ctx.services,
    );
    expect(String(payloadOf(selectReply).content)).toContain("獄卒判断");
    expect(selectUpdate).not.toHaveBeenCalled();

    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const modalReply = vi.fn(async () => undefined);
    await handleShokanModal(
      {
        customId: "shokan:reeval-comp-submit:1:stale-token",
        user: { id: "shop-staff" },
        member: { roles: { cache: new Collection([["role:shop", { id: "role:shop" }]]) } },
        fields: { getTextInputValue: (id: string) => (id === "amount" ? "500000" : "人間判断") },
        reply: modalReply,
      } as never,
      ctx.services,
    );
    expect(String(payloadOf(modalReply).content)).toContain("獄卒判断");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_reeval_compensations").get()).toEqual({ n: 0 });
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

    expect(String(payloadOf(second).content)).toContain("すでに対応済み");
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
      customId: `shop:buy:${ctx.nickname.id}:land:${ctx.shop.quoteGenericPurchase(ctx.nickname.id).termsToken}`,
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

describe("件数と操作の対応（表示上限で数えない）", () => {
  it("11件以上でも正確な件数を出し、表示した分には全部ボタンが付く", async () => {
    const { shopAdminPanelMessage, handleShokanButton } = await shokanModule;
    const ctx = setup();
    for (let i = 0; i < 12; i += 1) buyAs(ctx, ctx.nickname.id, `u${i}`);

    const panel = shopAdminPanelMessage(ctx.services) as ReturnType<typeof payloadOf>;
    expect(panel.embeds[0]!.data.description).toContain("要対応 12件");

    const reply = vi.fn(async () => undefined);
    await handleShokanButton(panelPress("shokan:pending", reply), ctx.services);
    const view = payloadOf(reply);
    const listed = (view.embeds[0]!.data.description ?? "").match(/`#\d+`/g) ?? [];
    const buttons = idsOf(view).filter((id) => id.startsWith("shokan:deliver:"));
    // 出した案件の数とボタンの数が一致する
    expect(buttons).toHaveLength(listed.length);
    expect(listed.length).toBe(8);
    expect(view.embeds[0]!.data.description).toContain("ほか **4件**");
    expect(view.embeds[0]!.data.footer?.text ?? "").toContain("全 12件");
    ctx.db.close();
  });

  it("処理失敗も表示上限で数えない", async () => {
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    for (let i = 0; i < 11; i += 1) {
      const p = buyAs(ctx, ctx.pass.id, `f${i}`);
      ctx.shop.beginDelivery(p.id);
      ctx.shop.markDeliveryFailed(p.id, "Missing Permissions");
    }

    expect((shopAdminPanelMessage(ctx.services) as ReturnType<typeof payloadOf>).embeds[0]!.data.description).toContain(
      "処理失敗 11件",
    );
    ctx.db.close();
  });
});

describe("古い画面からの操作", () => {
  it("失効・返金・取消の購入は完了にできない", async () => {
    const { handleShokanButton } = await shokanModule;
    for (const status of ["expired", "refunded", "cancelled"] as const) {
      const ctx = setup();
      const purchase = buy(ctx, ctx.nickname.id);
      ctx.db.prepare("UPDATE shop_purchases SET status=? WHERE id=?").run(status, purchase.id);
      const reply = vi.fn(async () => undefined);

      await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, reply), ctx.services);

      const said = String(payloadOf(reply).content);
      expect(said).toContain("対応完了にできる状態ではありません");
      // 内部の状態名（expired/refunded/cancelled）はそのまま見せない
      expect(said).not.toContain(status);
      expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
      expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).not.toBe("delivered");
      expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
      ctx.db.close();
    }
  });

  it("自動配送の購入を手動完了ボタンからは終われない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.pass.id);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, reply), ctx.services);

    expect(String(payloadOf(reply).content)).toContain("ここで完了にする対象ではありません");
    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    ctx.db.close();
  });

  it("失効した購入は古い再試行ボタンから再配送されない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.pass.id);
    ctx.shop.beginDelivery(purchase.id);
    ctx.shop.markDeliveryFailed(purchase.id, "Missing Permissions");
    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(purchase.id);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:retry:${purchase.id}`, reply), ctx.services);

    expect(String(payloadOf(reply).content)).toContain("expired");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("failed");
    ctx.db.close();
  });

  it("既に完了した購入を二度完了できない（古い一覧からの二度押し）", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.nickname.id);
    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, vi.fn(async () => undefined)), ctx.services);
    const second = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, second), ctx.services);

    expect(String(payloadOf(second).content)).toContain("すでに対応済み");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    ctx.db.close();
  });
});

describe("移行待ちの商品", () => {
  function legacyItem(ctx: Ctx) {
    const legacy = ctx.shop.createItem(
      { name: "オリジナルロール継続or付与", price_land: 250_000, kind: "monthly", delivery: "manual" },
      "staff",
    );
    ctx.db.prepare("UPDATE shop_items SET enabled=0, duration_days=30 WHERE id=?").run(legacy.id);
    return legacy;
  }

  it("販売停止した旧オリジナルロール継続は再販売できない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const legacy = legacyItem(ctx);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:toggle:${legacy.id}`, reply), ctx.services);

    expect(String(payloadOf(reply).content)).toContain("移行待ち");
    expect(ctx.shop.getItem(legacy.id)!.enabled).toBe(0);
    ctx.db.close();
  });

  it("coreでも再販売を拒否する（UIを迂回されても止まる）", async () => {
    const ctx = setup();
    const legacy = legacyItem(ctx);

    expect(() => ctx.shop.setEnabled(legacy.id, true, "staff")).toThrow("ERR_SALES_LOCKED");
    // 自動配送の期限商品は普通に止めて再開できる
    ctx.shop.setEnabled(ctx.pass.id, false, "staff");
    ctx.shop.setEnabled(ctx.pass.id, true, "staff");
    expect(ctx.shop.getItem(ctx.pass.id)!.enabled).toBe(1);
    ctx.db.close();
  });

  it("商品一覧で「移行待ち」と分かる", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    legacyItem(ctx);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress("shokan:list", reply), ctx.services);

    expect(payloadOf(reply).embeds[0]!.data.description).toContain("🔒");
    ctx.db.close();
  });
});

describe("自動処理の失敗通知", () => {
  it("初回の失敗でスタッフへ知らせる（ボタンは置かない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    ctx.settings.set("channel:kessai", "ch-1", "staff");
    const send = vi.fn(async () => undefined);
    const interaction = {
      customId: `shop:buy:${ctx.pass.id}:land:${ctx.shop.quoteGenericPurchase(ctx.pass.id).termsToken}`,
      user: { id: USER },
      guildId: "g1",
      guild: {
        id: "g1",
        roles: { cache: new Collection() },
        members: {
          fetch: vi.fn(async () => ({
            id: USER,
            roles: {
              cache: new Collection(),
              add: vi.fn(async () => {
                throw new Error("Missing Permissions");
              }),
            },
          })),
        },
      },
      member: { roles: { cache: new Collection() } },
      id: "op-fail",
      client: { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send, messages: { fetch: vi.fn() } })) } },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    } as never;

    await handleShopButton(interaction, ctx.services);

    const purchase = ctx.shop.listUserPurchases(USER, { activeOnly: true })[0]!;
    expect(purchase.delivery_state).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    const notice = (send.mock.calls[0] as never[])[0] as { content: string; components?: unknown[] };
    expect(notice.content).toContain("自動処理に失敗");
    expect(notice.content).toContain("処理失敗");
    expect(notice.components ?? []).toEqual([]);
    ctx.db.close();
  });
});
