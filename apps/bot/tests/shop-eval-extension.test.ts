import { Collection } from "discord.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  EVAL_EXTENSION_PRICE_LAND,
  EventLog,
  Ledger,
  Settings,
  Shop,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");
const USER = "1463201396567441441";
const NOW = 1_800_000_000;
const DAY = 86_400;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW * 1_000));
});

afterEach(() => vi.useRealTimers());

function setup(balance = 200_000) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const item = shop.createItem(
    {
      name: "評価期間1日延長",
      description: "審判の刻限を1日延長します。購入即時反映。",
      price_land: EVAL_EXTENSION_PRICE_LAND,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "extend_deadline",
      delivery_data: JSON.stringify({ days: 1 }),
    },
    "staff",
  );
  db.prepare(
    `INSERT INTO souls (user_id,status,ghost_at,eval_started_at,eval_deadline_at,updated_at)
     VALUES (?, 'ghost', ?, ?, ?, ?)`,
  ).run(USER, NOW - DAY, NOW - DAY, NOW + 14 * DAY, NOW);
  ledger.ensureAccount(`user:${USER}`, "user");
  if (balance > 0) {
    ledger.transfer({
      from: TREASURY,
      to: `user:${USER}`,
      amount: balance,
      type: "initial",
      actor: "staff",
      idempotencyKey: `seed:${balance}`,
    });
  }
  const services = { db, ledger, settings, events, shop } as unknown as Services;
  return { db, ledger, shop, item, services };
}

type Ctx = ReturnType<typeof setup>;

function select(ctx: Ctx, id = "confirmation-1") {
  const reply = vi.fn(async () => undefined);
  return {
    interaction: {
      customId: "shop:pick",
      values: [String(ctx.item.id)],
      user: { id: USER },
      member: { roles: { cache: new Collection() } },
      id,
      reply,
    } as never,
    reply,
  };
}

function buttonId(reply: ReturnType<typeof vi.fn>): string {
  const payload = reply.mock.calls[0]?.[0] as { components: Array<{ components: Array<{ data: { custom_id?: string } }> }> };
  return payload.components[0]!.components[0]!.data.custom_id!;
}

function press(customId: string, id = `press-${Math.random()}`) {
  const editReply = vi.fn(async () => undefined);
  return {
    interaction: {
      customId,
      user: { id: USER },
      id,
      deferUpdate: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      editReply,
    } as never,
    editReply,
  };
}

function lastContent(fn: ReturnType<typeof vi.fn>): string {
  const payload = fn.mock.calls.at(-1)?.[0] as { content?: string } | undefined;
  return payload?.content ?? "";
}

describe("評価期間+1日の購入UI", () => {
  it("購入前に現在期限・延長後期限・使用回数を表示し、購入後に新期限と残り回数を出す", async () => {
    const { handleShopSelect, handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const picked = select(ctx);

    await handleShopSelect(picked.interaction, ctx.services);

    const before = JSON.stringify(picked.reply.mock.calls[0]?.[0]);
    expect(before).toContain("現在の期限");
    expect(before).toContain("延長後の期限");
    expect(before).toContain("0 / 5");
    const paid = press(buttonId(picked.reply));
    await handleShopButton(paid.interaction, ctx.services);

    expect(lastContent(paid.editReply)).toContain("新しい期限: <t:");
    expect(lastContent(paid.editReply)).toContain("使用回数: **1 / 5**");
    expect(lastContent(paid.editReply)).toContain("残り **4回**");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(150_000);
    ctx.db.close();
  });

  it("commit後に応答を失って同じ確認ボタンを再押下しても成功結果をreplayする", async () => {
    const { handleShopSelect, handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const picked = select(ctx);
    await handleShopSelect(picked.interaction, ctx.services);
    const id = buttonId(picked.reply);

    const first = press(id, "press-a");
    await handleShopButton(first.interaction, ctx.services);
    const second = press(id, "press-b");
    await handleShopButton(second.interaction, ctx.services);

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(150_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    expect(lastContent(second.editReply)).toBe(lastContent(first.editReply));
    expect(lastContent(second.editReply)).toContain("新しい期限: <t:");
    expect(lastContent(second.editReply)).toContain("使用回数: **1 / 5**");
    expect(lastContent(second.editReply)).toContain("残り **4回**");
    expect(lastContent(second.editReply)).not.toContain("料金は発生していません");
    ctx.db.close();
  });

  it("別operationの古い確認は無課金でstale表示し、最新内容へ更新する", async () => {
    const { handleShopSelect, handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const firstPicked = select(ctx, "select-a");
    const secondPicked = select(ctx, "select-b");
    await handleShopSelect(firstPicked.interaction, ctx.services);
    await handleShopSelect(secondPicked.interaction, ctx.services);

    await handleShopButton(press(buttonId(firstPicked.reply), "press-a").interaction, ctx.services);
    const stale = press(buttonId(secondPicked.reply), "press-b");
    await handleShopButton(stale.interaction, ctx.services);

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(150_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    expect(lastContent(stale.editReply)).toContain("料金は発生していません");
    expect(JSON.stringify(stale.editReply.mock.calls.at(-1)?.[0])).toContain("1 / 5");
    ctx.db.close();
  });

  it("確認後に資格を失ったraceはLand 0・購入0", async () => {
    const { handleShopSelect, handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const picked = select(ctx);
    await handleShopSelect(picked.interaction, ctx.services);
    ctx.db.prepare("UPDATE souls SET status='majin' WHERE user_id=?").run(USER);
    const paid = press(buttonId(picked.reply));

    await handleShopButton(paid.interaction, ctx.services);

    expect(lastContent(paid.editReply)).toContain("現在評価中の亡霊だけ");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(200_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("Land不足は期限も購入も動かさない", async () => {
    const { handleShopSelect, handleShopButton } = await shopPanelModule;
    const ctx = setup(49_999);
    const picked = select(ctx);
    await handleShopSelect(picked.interaction, ctx.services);
    const paid = press(buttonId(picked.reply));

    await handleShopButton(paid.interaction, ctx.services);

    expect(lastContent(paid.editReply)).toContain("残高が足りません");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(49_999);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    expect(ctx.db.prepare("SELECT eval_deadline_at FROM souls WHERE user_id=?").get(USER)).toEqual({
      eval_deadline_at: NOW + 14 * DAY,
    });
    ctx.db.close();
  });

  it("旧shop:buyボタンでも即課金せず、最新DB状態の確認画面を挟む", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const reply = vi.fn(async () => undefined);
    await handleShopButton({
      customId: `shop:buy:${ctx.item.id}:land`,
      user: { id: USER },
      id: "legacy-button",
      reply,
    } as never, ctx.services);

    expect(JSON.stringify(reply.mock.calls[0]?.[0])).toContain("現在の期限");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(200_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });
});
