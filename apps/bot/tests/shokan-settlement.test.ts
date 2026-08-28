import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import {
  Departments,
  EventLog,
  Ledger,
  OriginalRoles,
  Settings,
  Shop,
  SubAccounts,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 古い管理画面のボタンを押しても、事実と食い違う状態を作らない。
 *
 * 管理パネルは ephemeral ではないので、**運営の手元には古い一覧が残り続ける**。
 * そこから押されることを前提に、押した瞬間の現実で判断する。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shokanModule = import("../src/commands/shokan.js");
const USER = "1463201396567441441";
const STAFF = "222222222222222222";
const ADMIN_ROLE = "r-admin";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  let reevalItemId: number | null = null;
  const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
  const departments = new Departments(db, ledger);
  const manual = shop.createItem(
    { name: "名前変更", price_land: 50_000, kind: "one_shot", delivery: "manual" },
    "staff",
  );
  const limited = shop.createItem(
    { name: "限定グッズ", price_land: 30_000, kind: "one_shot", delivery: "manual", stock: 3 },
    "staff",
  );
  const auto = shop.createItem(
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
  const services = {
    db, ledger, settings, events, shop, originalRoles, subAccounts, departments,
  } as unknown as Services;
  return { db, ledger, settings, events, shop, manual, limited, auto, services, setReevalItem: (id: number | null) => { reevalItemId = id; } };
}

type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx, itemId: number) =>
  ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: USER,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;

/** 購入時の記録が無い旧購入（本番に実在する形） */
function legacyPurchase(ctx: Ctx, itemId: number) {
  const info = ctx.db
    .prepare(
      "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_state)" +
        " VALUES (?,?,?,?, 'active',0,'pending')",
    )
    .run(itemId, USER, 1_700_000_000, 50_000);
  return ctx.shop.getPurchase(Number(info.lastInsertRowid))!;
}

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
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferred: false,
    replied: false,
  } as never;
}

const said = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])?.[0]?.content ?? "");
const deliveredEvents = (ctx: Ctx) => ctx.events.listByType("shop_delivered").length;

describe("古い完了ボタン", () => {
  it("返金済みになった購入を、古いボタンで配送済みに戻せない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.manual.id);
    // 一覧を開いた後に、別経路で返金された
    ctx.shop.refund(purchase.id, "配送できなかった", "staff");
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, reply), ctx.services);

    const after = ctx.shop.getPurchase(purchase.id)!;
    expect(after.status).toBe("refunded");
    expect(after.delivered_at).toBeNull();
    expect(after.delivery_state).not.toBe("delivered");
    expect(deliveredEvents(ctx)).toBe(0);
    const message = said(reply);
    expect(message).toContain("対応完了にできる状態ではありません");
    // 内部の状態名やDBの列名は見せない
    expect(message).not.toMatch(/refunded|delivery_state|status=/);
    ctx.db.close();
  });

  it("完了済みの購入を二度押しても、配送記録は増えない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.manual.id);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, vi.fn(async () => undefined)), ctx.services);
    const second = vi.fn(async () => undefined);
    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, second), ctx.services);

    expect(deliveredEvents(ctx)).toBe(1);
    expect(said(second)).toContain("すでに対応済み");
    ctx.db.close();
  });

  it("存在しない購入では配送記録を作らない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress("shokan:deliver:99999", reply), ctx.services);

    expect(deliveredEvents(ctx)).toBe(0);
    expect(said(reply)).toContain("見つかりません");
    ctx.db.close();
  });

  it("普通の手動対応は、完了すると一覧からも件数からも消える", async () => {
    const { handleShokanButton, shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.manual.id);
    expect(ctx.shop.countPendingManual()).toBe(1);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, vi.fn(async () => undefined)), ctx.services);

    expect(ctx.shop.countPendingManual()).toBe(0);
    expect(ctx.shop.listPendingManual()).toEqual([]);
    const panel = shopAdminPanelMessage(ctx.services) as { embeds: { data: { description?: string } }[] };
    expect(panel.embeds[0]!.data.description).toContain("残っている仕事はありません");
    ctx.db.close();
  });
});

describe("旧購入（購入時の提供方式が分からない）", () => {
  it("普通の作業キューには出ず、別枠に出る", async () => {
    const { handleShokanButton, shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    const legacy = legacyPurchase(ctx, ctx.manual.id);

    expect(ctx.shop.countPendingManual()).toBe(0);
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(1);

    const panel = shopAdminPanelMessage(ctx.services) as { embeds: { data: { description?: string } }[] };
    expect(panel.embeds[0]!.data.description).toContain("要確認（旧購入） 1件");

    const view = vi.fn(async () => undefined);
    await handleShokanButton(panelPress("shokan:legacy-unknown", view), ctx.services);
    const payload = (view.mock.calls.at(-1) as never[])[0] as { embeds: { data: { description?: string } }[] };
    expect(payload.embeds[0]!.data.description).toContain(`#${legacy.id}`);
    expect(payload.embeds[0]!.data.description).toContain("提供方式を確認できない");
    ctx.db.close();
  });

  it("完了ボタンを押しても完了にならず、確認を促す", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const legacy = legacyPurchase(ctx, ctx.manual.id);
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(panelPress(`shokan:deliver:${legacy.id}`, reply), ctx.services);

    expect(ctx.shop.getPurchase(legacy.id)!.delivered_at).toBeNull();
    expect(deliveredEvents(ctx)).toBe(0);
    expect(said(reply)).toContain("提供状況を確認してください");
    ctx.db.close();
  });
});

describe("専用サービス・自動配送は普通の仕事として出さない", () => {
  it("自動配送の購入は手動キューにも出ず、完了ボタンでも終われない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.auto.id);
    const reply = vi.fn(async () => undefined);

    expect(ctx.shop.listPendingManual().map((r) => r.id)).not.toContain(purchase.id);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, reply), ctx.services);

    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
    expect(deliveredEvents(ctx)).toBe(0);
    expect(said(reply)).toContain("ここで完了にする対象ではありません");
    ctx.db.close();
  });

  it("自動配送の再試行導線は変えていない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.auto.id);
    ctx.db.prepare("UPDATE shop_purchases SET delivery_state='failed', delivery_error='boom' WHERE id=?").run(purchase.id);

    expect(ctx.shop.listUndeliveredAuto(10).map((r) => r.id)).toContain(purchase.id);

    const reply = vi.fn(async () => undefined);
    await handleShokanButton(panelPress(`shokan:retry:${purchase.id}`, reply), ctx.services);
    // 再試行はここでは成否を問わない。手動完了の経路へ吸われていないことだけを見る。
    expect(said(reply)).toContain(`#${purchase.id}`);
    ctx.db.close();
  });
});

describe("現在の商品ID指定で、過去の普通の購入を隠さない", () => {
  it("普通に買ったあとで再評価商品に指定されても、キューから消えない", async () => {
    const { handleShokanButton, shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.manual.id);
    expect(ctx.shop.countPendingManual()).toBe(1);

    // あとから運営がこの商品を再評価商品に指定する
    ctx.settings.set("shop:reeval_item_id", ctx.manual.id, "staff");
    ctx.setReevalItem(ctx.manual.id);

    // この購入には再評価の実績が無いので、普通の仕事のまま
    expect(ctx.shop.countPendingManual()).toBe(1);
    expect(ctx.shop.listPendingManual().map((r) => r.id)).toContain(purchase.id);
    const panel = shopAdminPanelMessage(ctx.services) as { embeds: { data: { description?: string } }[] };
    expect(panel.embeds[0]!.data.description).toContain("要対応 1件");

    // **実際に描画される一覧にも出る。** countだけ見ていると、
    // 「バッジは1件なのに開くと空」というズレを見逃す。
    const view = vi.fn(async () => undefined);
    await handleShokanButton(panelPress("shokan:pending", view), ctx.services);
    const listed = (view.mock.calls.at(-1) as never[])[0] as {
      embeds: { data: { description?: string } }[];
      components?: { toJSON(): { components: { custom_id: string }[] } }[];
    };
    expect(listed.embeds[0]!.data.description).toContain(`#${purchase.id}`);
    expect(
      (listed.components ?? []).flatMap((r) => r.toJSON().components).map((c) => c.custom_id),
    ).toContain(`shokan:deliver:${purchase.id}`);

    // 完了もできる（一覧に出るのに完了できない、が起きない）
    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, vi.fn(async () => undefined)), ctx.services);
    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).not.toBeNull();
    expect(deliveredEvents(ctx)).toBe(1);
    ctx.db.close();
  });

  it("普通に買ったあとでオリジナルロール商品に指定されても、キューから消えない", async () => {
    const { handleShokanButton, shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.manual.id);

    ctx.settings.set("shop:original_role_item_id", ctx.manual.id, "staff");

    expect(ctx.shop.countPendingManual()).toBe(1);
    expect(ctx.shop.listPendingManual().map((r) => r.id)).toContain(purchase.id);
    const panel = shopAdminPanelMessage(ctx.services) as { embeds: { data: { description?: string } }[] };
    expect(panel.embeds[0]!.data.description).toContain("要対応 1件");

    // 描画される一覧にも出ている（バッジと中身が食い違わない）
    const view = vi.fn(async () => undefined);
    await handleShokanButton(panelPress("shokan:pending", view), ctx.services);
    const listed = (view.mock.calls.at(-1) as never[])[0] as { embeds: { data: { description?: string } }[] };
    expect(listed.embeds[0]!.data.description).toContain(`#${purchase.id}`);
    ctx.db.close();
  });

  it("証拠の無い旧購入は、現在の専用商品IDに一致するだけでは専用扱いしない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const legacy = legacyPurchase(ctx, ctx.manual.id);
    ctx.settings.set("shop:reeval_item_id", ctx.manual.id, "staff");
    ctx.setReevalItem(ctx.manual.id);

    // 「不明」として見える（専用サービスとは推測しない）
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(1);
    const reply = vi.fn(async () => undefined);
    await handleShokanButton(panelPress(`shokan:deliver:${legacy.id}`, reply), ctx.services);
    expect(said(reply)).toContain("提供状況を確認してください");
    expect(deliveredEvents(ctx)).toBe(0);
    ctx.db.close();
  });
});

describe("在庫の戻し（運営から見える結果）", () => {
  it("未提供のまま返金すると、限定商品の在庫が1つ戻る", async () => {
    const ctx = setup();
    const purchase = buy(ctx, ctx.limited.id);
    expect(ctx.shop.getItem(ctx.limited.id)!.stock).toBe(2);

    ctx.shop.refund(purchase.id, "配送できなかった", "staff");

    expect(ctx.shop.getItem(ctx.limited.id)!.stock).toBe(3);
    ctx.db.close();
  });

  it("完了した購入は返金できないので、在庫も戻らない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const purchase = buy(ctx, ctx.limited.id);

    await handleShokanButton(panelPress(`shokan:deliver:${purchase.id}`, vi.fn(async () => undefined)), ctx.services);

    expect(() => ctx.shop.refund(purchase.id, "やっぱり", "staff")).toThrow(/ERR_ALREADY_DELIVERED/);
    expect(ctx.shop.getItem(ctx.limited.id)!.stock).toBe(2);
    ctx.db.close();
  });
});
