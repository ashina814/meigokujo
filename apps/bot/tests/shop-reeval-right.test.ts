import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { EventLog, Ledger, Settings, Shop, Tickets, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 再評価チャレンジは「配送する物」ではない。
 *
 * 買ったのは面談を受ける権利で、消費できるのは既存の再評価面談フローだけ。
 * 以前は他の手動商品と同じ配送通知が飛び、その「配送完了」を押すと
 * `delivered_at` が入って**面談前に権利が消えた**（購入 #44 で実際に起きた形）。
 * ここでは実ハンドラを通して、その経路が塞がっていることを固定する。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");
const shokanModule = import("../src/commands/shokan.js");
const reevalModule = import("../src/commands/reeval.js");

const USER = "1463201396567441441";
const STAFF = "222222222222222222";
const ADMIN_ROLE = "r-admin";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const tickets = new Tickets(db, events);
  const reeval = shop.createItem(
    { name: "再評価チャレンジ", description: "面談を受ける権利です。", price_land: 500_000, kind: "one_shot", delivery: "manual" },
    "staff",
  );
  const nickname = shop.createItem(
    { name: "名前変更", description: "運営が対応します。", price_land: 50_000, kind: "one_shot", delivery: "manual" },
    "staff",
  );
  settings.set("shop:reeval_item_id", reeval.id, "staff");
  settings.set("role:admin", ADMIN_ROLE, "staff");
  settings.set("channel:kessai", "ch-kessai", "staff");
  const services = { db, ledger, settings, events, shop, tickets } as unknown as Services;
  return { db, ledger, settings, events, shop, tickets, reeval, nickname, services };
}

type Ctx = ReturnType<typeof setup>;

function fund(ctx: Ctx, amount: number) {
  ctx.ledger.ensureAccount(`user:${USER}`, "user");
  ctx.ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: `seed:${amount}`,
  });
}

/** 購入ボタンの実インタラクション。#決裁への送信は spy で見る */
function buyInteraction(ctx: Ctx, itemId: number, send: ReturnType<typeof vi.fn>) {
  return {
    customId: `shop:buy:${itemId}:land`,
    user: { id: USER },
    guildId: "g1",
    guild: { id: "g1", members: { fetch: vi.fn(async () => ({ id: USER, roles: { cache: new Collection() } })) } },
    member: { roles: { cache: new Collection() } },
    id: `op-${itemId}-${Math.random()}`,
    client: { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) } },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  } as never;
}

const lastReply = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])[0].content ?? "");

describe("再評価チャレンジの購入", () => {
  it("配送通知を出さず、権利として案内する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    fund(ctx, 1_000_000);
    const send = vi.fn(async () => undefined);
    const interaction = buyInteraction(ctx, ctx.reeval.id, send) as unknown as { editReply: ReturnType<typeof vi.fn> };

    await handleShopButton(interaction as never, ctx.services);

    // #決裁 への配送依頼が飛ばない
    expect(send).not.toHaveBeenCalled();
    const content = String((interaction.editReply.mock.calls.at(-1) as never[])[0].content);
    expect(content).toContain("再評価を受ける権利");
    expect(content).not.toContain("スタッフが配送の対応をします");
    // 権利は未使用のまま
    const purchase = ctx.shop.listUserPurchases(USER, { activeOnly: true })[0]!;
    expect(purchase.delivered_at).toBeNull();
    ctx.db.close();
  });

  it("受付パネルが設置済みならジャンプリンクを出す", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    fund(ctx, 1_000_000);
    ctx.tickets.upsertPanel(
      { id: "reeval", name: "再評価面談", title: "再評価面談", description: "説明", buttonLabel: "申請" },
      "staff",
    );
    ctx.db.prepare("UPDATE ticket_panels SET channel_id='ch-1', message_id='msg-1' WHERE id='reeval'").run();
    const interaction = buyInteraction(ctx, ctx.reeval.id, vi.fn()) as unknown as { editReply: ReturnType<typeof vi.fn> };

    await handleShopButton(interaction as never, ctx.services);

    expect(String((interaction.editReply.mock.calls.at(-1) as never[])[0].content)).toContain(
      "https://discord.com/channels/g1/ch-1/msg-1",
    );
    ctx.db.close();
  });

  it("他の手動商品はこれまでどおり配送依頼を出す", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    fund(ctx, 1_000_000);
    const send = vi.fn(async () => undefined);

    await handleShopButton(buyInteraction(ctx, ctx.nickname.id, send), ctx.services);

    expect(send).toHaveBeenCalledTimes(1);
    expect(String((send.mock.calls[0] as never[])[0].content)).toContain("手動配送をお願いします");
    ctx.db.close();
  });
});

describe("汎用の配送完了操作", () => {
  function staffInteraction(customId: string, reply: ReturnType<typeof vi.fn>) {
    return {
      customId,
      user: { id: STAFF, username: "staff" },
      member: { roles: { cache: new Collection([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) } },
      message: { editable: false, content: "📦 通知", edit: vi.fn() },
      reply,
      update: vi.fn(async () => undefined),
    } as never;
  }

  it("再評価チャレンジの購入は完了にできない（権利が消えない）", async () => {
    const { handleShokanButton } = await shokanModule;
    const { findUnconsumedReevalPurchase } = await reevalModule;
    const ctx = setup();
    fund(ctx, 1_000_000);
    const purchase = ctx.shop.purchase({ itemId: ctx.reeval.id, userId: USER, actor: USER, memberRoleIds: [] }).purchase;
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(staffInteraction(`shokan:deliver:${purchase.id}`, reply), ctx.services);

    expect(lastReply(reply)).toContain("再評価を受ける権利");
    const after = ctx.shop.getPurchase(purchase.id)!;
    expect(after.delivered_at).toBeNull();
    expect(after.delivery_state).not.toBe("delivered");
    // 既存の未使用権利判定がそのまま生きている
    expect(findUnconsumedReevalPurchase(ctx.services, USER)).toEqual({ id: purchase.id });
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    ctx.db.close();
  });

  it("他の手動商品はこれまでどおり完了にできる", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    fund(ctx, 1_000_000);
    const purchase = ctx.shop.purchase({ itemId: ctx.nickname.id, userId: USER, actor: USER, memberRoleIds: [] }).purchase;
    const reply = vi.fn(async () => undefined);

    await handleShokanButton(staffInteraction(`shokan:deliver:${purchase.id}`, reply), ctx.services);

    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).not.toBeNull();
    expect(lastReply(reply)).toContain("配送済み");
    ctx.db.close();
  });
});

describe("自動更新を廃止した後の利用者表示", () => {
  it("ショップ本文に自動再課金の案内が無い", async () => {
    const { shopPanelMessage } = await shopPanelModule;
    const ctx = setup();

    const text = JSON.stringify(shopPanelMessage(ctx.services));

    expect(text).not.toContain("毎月1日");
    expect(text).not.toContain("自動再課金");
    expect(text).toContain("自動で再課金しません");
    ctx.db.close();
  });

  it("契約中に自動更新・解約が出ない（存在しない操作を見せない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    fund(ctx, 1_000_000);
    ctx.shop.purchase({ itemId: ctx.nickname.id, userId: USER, actor: USER, memberRoleIds: [] });
    const reply = vi.fn(async () => undefined);

    await handleShopButton(
      { customId: "shop:contracts", user: { id: USER }, reply } as never,
      ctx.services,
    );

    const payload = (reply.mock.calls[0] as never[])[0] as { embeds: { data: { description: string } }[]; components?: unknown[] };
    const description = payload.embeds[0]!.data.description;
    expect(description).not.toContain("自動更新");
    expect(description).not.toContain("更新停止");
    expect(description).toContain("自動では再課金しません");
    // 解約の選択メニューそのものを出さない
    expect(payload.components ?? []).toEqual([]);
    ctx.db.close();
  });
});
