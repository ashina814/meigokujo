import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { EventLog, Ledger, OriginalRoles, Settings, Shop, Tickets, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";
import { setStock } from "./helpers/set-stock.js";

/**
 * 購入画面で見せた条件のまま買えること、そして見せていない条件では買えないこと。
 *
 * ここで固定するのは利用者から見える振る舞いだけ。
 * - 使えない支払方法をボタンとして見せない
 * - 表示後に商品が変わったら、資金を1 Ldも動かさずに出し直す
 * - 断るときも、内部の識別子やhashは見せない
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");
const USER = "1463201396567441441";
const START = 1_000_000;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  let reevalItemId: number | null = null;
  const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
  const tickets = new Tickets(db, events);
  const originalRoles = new OriginalRoles(db, ledger, events);

  const item = shop.createItem(
    {
      name: "裏チャット入場券",
      description: "裏チャットに入れます。",
      price_land: 80_000,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "r-ura", channel_id: "ch-ura" }),
    },
    "staff",
  );
  // 代替支払の値段欄だけがある商品（払える経路は無い）
  const altPriced = shop.createItem(
    {
      name: "招待でも買える（ことになっていた）商品",
      price_land: 50_000,
      price_alt_kind: "invite",
      price_alt_amount: 3,
      kind: "one_shot",
      delivery: "manual",
    },
    "staff",
  );
  const reeval = shop.createItem(
    {
      name: "再評価チャレンジ",
      description: "面談を受ける権利です。",
      price_land: 500_000,
      price_alt_kind: "invite",
      price_alt_amount: 5,
      kind: "one_shot",
      delivery: "manual",
    },
    "staff",
  );
  reevalItemId = reeval.id;
  shop.registerReevaluationSaleItem(reeval.id);
  settings.set("shop:reeval_item_id", reeval.id, "staff");
  settings.set("channel:kessai", "ch-kessai", "staff");
  db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES (?, 'meirei', 1)").run(USER);

  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: START,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:generic-terms-bot",
  });

  const services = { db, ledger, settings, events, shop, originalRoles, tickets } as unknown as Services;
  return { db, ledger, settings, events, shop, item, altPriced, reeval, services };
}

type Ctx = ReturnType<typeof setup>;

const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);
const purchases = (ctx: Ctx) => ctx.shop.listUserPurchases(USER);
const token = (ctx: Ctx, itemId: number) => ctx.shop.quoteGenericPurchase(itemId).termsToken;

function interaction(customId: string) {
  const member = { id: USER, roles: { cache: new Collection<string, { id: string }>(), add: vi.fn(async () => undefined) } };
  const reply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const deferReply = vi.fn(async () => undefined);
  return {
    reply,
    editReply,
    deferReply,
    ui: {
      customId,
      user: { id: USER },
      guildId: "g1",
      guild: { id: "g1", members: { fetch: vi.fn(async () => member) } },
      member,
      id: `op-${Math.random()}`,
      client: { channels: { fetch: vi.fn(async () => null) } },
      deferReply,
      editReply,
      reply,
      update: vi.fn(async () => undefined),
    } as never,
  };
}

/**
 * 直近の返信のうち**利用者が読む文字だけ**を集める。
 * custom_idはボタンの中身で画面には出ないので、ここには含めない。
 */
const saidAll = (...fns: ReturnType<typeof vi.fn>[]) =>
  fns
    .map((fn) => {
      const payload = fn.mock.calls.at(-1)?.[0] as
        | { content?: string; embeds?: { toJSON?: () => unknown }[] }
        | undefined;
      if (!payload) return "";
      const embeds = (payload.embeds ?? []).map((e) => JSON.stringify(e.toJSON ? e.toJSON() : e));
      return [payload.content ?? "", ...embeds].join(" ");
    })
    .join(" ");

/** 商品ページ（一覧のセレクトで商品を選ぶ）を開き、描かれたボタンの custom_id を取り出す */
async function openItemPage(ctx: Ctx, itemId: number): Promise<string[]> {
  const { handleShopSelect } = await shopPanelModule;
  const h = interaction("shop:pick");
  (h.ui as unknown as { values: string[] }).values = [String(itemId)];
  await handleShopSelect(h.ui, ctx.services);
  const payload = h.reply.mock.calls.at(-1)?.[0] as {
    components?: { toJSON(): { components: { custom_id: string }[] } }[];
  };
  return (payload?.components ?? []).flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
}

describe("購入画面 — 使えない支払方法を見せない", () => {
  it("代替支払のボタンは出ない（値段欄があっても払えないなら見せない）", async () => {
    const ctx = setup();
    const ids = await openItemPage(ctx, ctx.altPriced.id);

    expect(ids.some((id) => id.startsWith(`shop:buy:${ctx.altPriced.id}:alt`))).toBe(false);
    expect(ids.some((id) => id.startsWith(`shop:buy:${ctx.altPriced.id}:land`))).toBe(true);
    ctx.db.close();
  });

  it("再評価チャレンジの招待払いボタンは残る（実際に招待を消費する専用経路がある）", async () => {
    const ctx = setup();
    const ids = await openItemPage(ctx, ctx.reeval.id);

    expect(ids.some((id) => id.startsWith(`shop:buy:${ctx.reeval.id}:alt`))).toBe(true);
    ctx.db.close();
  });

  it("代替支払ボタンを直接押しても、Landへ振り替えず1 Ldも動かない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const h = interaction(`shop:buy:${ctx.altPriced.id}:alt`);

    await handleShopButton(h.ui, ctx.services);

    expect(balance(ctx)).toBe(START);
    expect(purchases(ctx)).toHaveLength(0);
    ctx.db.close();
  });
});

describe("購入画面 — 表示した条件でしか課金しない", () => {
  it("変わっていなければ、そのまま購入できる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const h = interaction(`shop:buy:${ctx.item.id}:land:${token(ctx, ctx.item.id)}`);

    await handleShopButton(h.ui, ctx.services);

    expect(balance(ctx)).toBe(START - 80_000);
    expect(purchases(ctx)).toHaveLength(1);
    ctx.db.close();
  });

  const CHANGES: Array<[string, Record<string, unknown>]> = [
    ["値上げ", { price_land: 120_000 }],
    ["同じ料金のまま期間が変わる", { duration_days: 7 }],
    ["同じ料金のまま提供方法が変わる", { delivery: "manual", delivery_kind: null, delivery_data: null }],
    ["同じ料金のまま渡すロールが変わる", { delivery_data: JSON.stringify({ role_id: "r-other" }) }],
    ["同じ料金のまま購入条件が変わる", { require_role_id: "r-gate" }],
  ];

  for (const [label, patch] of CHANGES) {
    it(`${label} → 資金を動かさず、新しい内容を出し直す`, async () => {
      const { handleShopButton } = await shopPanelModule;
      const ctx = setup();
      // 表示された時点のボタンを持っている
      const stale = interaction(`shop:buy:${ctx.item.id}:land:${token(ctx, ctx.item.id)}`);
      ctx.shop.updateItem(ctx.item.id, patch as never, "staff");

      await handleShopButton(stale.ui, ctx.services);

      expect(balance(ctx)).toBe(START);
      expect(purchases(ctx)).toHaveLength(0);
      const said = saidAll(stale.reply, stale.editReply);
      expect(said).toContain("まだ購入していません");
      // 内部値やhashは見せない
      expect(said).not.toMatch(/termsToken|terms_token|ERR_TERMS_CHANGED|[0-9a-f]{16}/);
      ctx.db.close();
    });
  }

  it("この変更より前に描かれたボタン（契約を持たない）も、課金せず出し直す", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const legacy = interaction(`shop:buy:${ctx.item.id}:land`);

    await handleShopButton(legacy.ui, ctx.services);

    expect(balance(ctx)).toBe(START);
    expect(purchases(ctx)).toHaveLength(0);
    expect(saidAll(legacy.reply, legacy.editReply)).toContain("まだ購入していません");
    ctx.db.close();
  });

  it("出し直した画面のボタンは、そのまま押せば買える", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const stale = interaction(`shop:buy:${ctx.item.id}:land:${token(ctx, ctx.item.id)}`);
    ctx.shop.updateItem(ctx.item.id, { price_land: 120_000 } as never, "staff");
    await handleShopButton(stale.ui, ctx.services);

    // 出し直された画面のボタンをそのまま押す（行き止まりにしない）
    const payload = stale.reply.mock.calls.at(-1)?.[0] as {
      components: { toJSON(): { components: { custom_id: string }[] } }[];
    };
    const buyId = payload.components
      .flatMap((row) => row.toJSON().components.map((c) => c.custom_id))
      .find((id) => id.startsWith(`shop:buy:${ctx.item.id}:land`))!;
    const retry = interaction(buyId);
    await handleShopButton(retry.ui, ctx.services);

    expect(balance(ctx)).toBe(START - 120_000);
    expect(purchases(ctx)).toHaveLength(1);
    ctx.db.close();
  });
});

describe("返還だけ済んだ状態（取り残し）からの再試行", () => {
  /**
   * 確認票の状態と返還記録を**持ち越す**世界。押すたびに新しいmockを作ると、
   * 「前回すでに返還した」という現実を再現できない。
   */
  function chipWorld(ctx: Ctx, itemId: number) {
    const state = { status: "pending" as string, redeemedGroups: new Set<string>() };
    const redeemExactFreeChips = vi.fn((userId: string, amount: number, operationId: string) => {
      state.redeemedGroups.add(`chip:free-redeem:${userId}:external:${operationId.replace(/^external:/, "")}`);
      return { userId, redeemed: amount, land: amount, reason: "test" };
    });
    const row = () => ({
      id: "c1", userId: USER, operationId: "op-stranded", operationKind: `shop:${itemId}:land`,
      status: state.status, chipAmount: 1_000,
    });
    (ctx.services as unknown as Record<string, unknown>).chipFlow = {
      externalConfirmation: vi.fn(() => row()),
      beginExternalConfirmation: vi.fn(() => {
        state.status = "executing";
        return row();
      }),
      redeemExactFreeChips,
      cancelExternalConfirmation: vi.fn(() => true),
      failExternalConfirmation: vi.fn(() => true),
      completeExternalConfirmation: vi.fn(() => true),
    };
    (ctx.services as unknown as Record<string, unknown>).chipAssets = { freeChips: vi.fn(() => 1_000) };
    // 返還の記録は安定キーで残る。ここが「本当に戻したか」の根拠になる。
    (ctx.services as unknown as Record<string, unknown>).chipTx = {
      getGroup: vi.fn((key: string) => (state.redeemedGroups.has(key) ? { group_key: key } : undefined)),
    };
    const press = (customId: string) => {
      const editReply = vi.fn(async () => undefined);
      const member = { id: USER, roles: { cache: new Collection<string, { id: string }>(), add: vi.fn(async () => undefined) } };
      return {
        editReply,
        ui: {
          customId,
          user: { id: USER },
          guildId: "g1",
          guild: { id: "g1", members: { fetch: vi.fn(async () => member) } },
          member,
          id: `op-${Math.random()}`,
          client: { channels: { fetch: vi.fn(async () => null) } },
          isButton: () => true,
          deferUpdate: vi.fn(async () => undefined),
          deferReply: vi.fn(async () => undefined),
          editReply,
          reply: vi.fn(async () => undefined),
          update: vi.fn(async () => undefined),
          deferred: false,
          replied: false,
        } as never,
      };
    };
    return { state, redeemExactFreeChips, press };
  }

  const buttonIds = (fn: ReturnType<typeof vi.fn>): string[] => {
    const payload = fn.mock.calls.at(-1)?.[0] as
      | { components?: { toJSON(): { components: { custom_id: string }[] } }[] }
      | undefined;
    return (payload?.components ?? []).flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
  };

  it("返還済みのまま商品が変わったら、追加で何も動かさず、過去の返還も否定しない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    // 在庫は契約(identity)に含まれないので、在庫だけ切らせば**契約は同じまま**購入だけ失敗する。
    // これが「返還は成功・購入は失敗」の取り残しを作る。
    setStock(ctx.shop, ctx.item.id, 0);
    const world = chipWorld(ctx, ctx.item.id);
    const t1 = token(ctx, ctx.item.id);

    // 1回目：返還は成功し、購入だけ失敗して再試行ボタンが残る
    const first = world.press(`shop:chips:c1:${ctx.item.id}:land:${t1}`);
    await handleShopButton(first.ui, ctx.services);

    expect(world.redeemExactFreeChips).toHaveBeenCalledTimes(1);
    expect(purchases(ctx)).toHaveLength(0);
    const retryId = buttonIds(first.editReply).find((id) => id.startsWith("shop:chips:"));
    expect(retryId).toBeDefined();

    // 運営が商品内容を変更
    ctx.shop.updateItem(ctx.item.id, { price_land: 999_999 } as never, "staff");
    const landBefore = balance(ctx);

    // 2回目：取り残しの再試行ボタンを押す
    const second = world.press(retryId!);
    await handleShopButton(second.ui, ctx.services);

    // 追加の資産移動・購入は一切起きない
    expect(world.redeemExactFreeChips).toHaveBeenCalledTimes(1);
    expect(balance(ctx)).toBe(landBefore);
    expect(purchases(ctx)).toHaveLength(0);

    const said = saidAll(second.editReply);
    expect(said).toContain("商品内容が変更されたため");
    // **過去の返還まで否定しない**
    expect(said).not.toContain("チップ・Landは変更していません");
    expect(said).toContain("以前の返還はすでに完了しており");
    expect(said).toContain("追加で動かしていません");
    ctx.db.close();
  });

  it("返還記録を読めないときは、過去についてどちらも断定しない", async () => {
    // 「記録が無い」のと「記録を読めない」のは別。読めないのに「変更していません」と
    // 言い切ると、実際には返還済みだった場合に嘘になる。
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    setStock(ctx.shop, ctx.item.id, 0);
    const world = chipWorld(ctx, ctx.item.id);
    const t1 = token(ctx, ctx.item.id);

    const first = world.press(`shop:chips:c1:${ctx.item.id}:land:${t1}`);
    await handleShopButton(first.ui, ctx.services);
    const retryId = buttonIds(first.editReply).find((id) => id.startsWith("shop:chips:"))!;

    // 返還記録の置き場そのものが見えない状態にする
    (ctx.services as unknown as Record<string, unknown>).chipTx = undefined;
    ctx.shop.updateItem(ctx.item.id, { price_land: 999_999 } as never, "staff");

    const second = world.press(retryId);
    await handleShopButton(second.ui, ctx.services);

    expect(world.redeemExactFreeChips).toHaveBeenCalledTimes(1);
    expect(purchases(ctx)).toHaveLength(0);
    const said = saidAll(second.editReply);
    expect(said).toContain("この操作ではチップ・Landを追加で動かしていません");
    // 過去について断定する文言はどちらも出さない
    expect(said).not.toContain("チップ・Landは変更していません");
    expect(said).not.toContain("以前の返還はすでに完了しており");
    ctx.db.close();
  });

  it("まだ一度も返還していない確認票では、これまでどおり「変更していません」と言い切る", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const world = chipWorld(ctx, ctx.item.id);
    const stale = `shop:chips:c1:${ctx.item.id}:land:${token(ctx, ctx.item.id)}`;
    ctx.shop.updateItem(ctx.item.id, { price_land: 999_999 } as never, "staff");

    const h = world.press(stale);
    await handleShopButton(h.ui, ctx.services);

    expect(world.redeemExactFreeChips).not.toHaveBeenCalled();
    expect(purchases(ctx)).toHaveLength(0);
    const said = saidAll(h.editReply);
    expect(said).toContain("チップ・Landは変更していません");
    expect(said).not.toContain("以前の返還はすでに完了しており");
    ctx.db.close();
  });
});

describe("チップ返還の確認 — チップを動かす前に契約を見る", () => {
  function chipHarness(ctx: Ctx, itemId: number, customId: string) {
    const redeemExactFreeChips = vi.fn(() => ({ moved: 1_000 }));
    (ctx.services as unknown as Record<string, unknown>).chipFlow = {
      externalConfirmation: vi.fn(() => ({
        id: "c1", userId: USER, operationId: "op1", operationKind: `shop:${itemId}:land`,
        status: "pending", chipAmount: 1_000,
      })),
      beginExternalConfirmation: vi.fn(() => ({
        id: "c1", userId: USER, operationId: "op1", operationKind: `shop:${itemId}:land`,
        status: "executing", chipAmount: 1_000,
      })),
      redeemExactFreeChips,
      cancelExternalConfirmation: vi.fn(() => true),
      failExternalConfirmation: vi.fn(() => true),
      completeExternalConfirmation: vi.fn(() => true),
    };
    (ctx.services as unknown as Record<string, unknown>).chipAssets = { freeChips: vi.fn(() => 1_000) };
    const editReply = vi.fn(async () => undefined);
    const member = { id: USER, roles: { cache: new Collection<string, { id: string }>(), add: vi.fn(async () => undefined) } };
    return {
      redeemExactFreeChips,
      editReply,
      ui: {
        customId,
        user: { id: USER },
        guildId: "g1",
        guild: { id: "g1", members: { fetch: vi.fn(async () => member) } },
        member,
        id: "op-chips",
        client: { channels: { fetch: vi.fn(async () => null) } },
        isButton: () => true,
        deferUpdate: vi.fn(async () => undefined),
        deferReply: vi.fn(async () => undefined),
        editReply,
        reply: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
        deferred: false,
        replied: false,
      } as never,
    };
  }

  it("確認したあとに商品が変わったら、チップを1つも動かさずに止まる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const stale = `shop:chips:c1:${ctx.item.id}:land:${token(ctx, ctx.item.id)}`;
    ctx.shop.updateItem(ctx.item.id, { price_land: 120_000 } as never, "staff");
    const h = chipHarness(ctx, ctx.item.id, stale);

    await handleShopButton(h.ui, ctx.services);

    expect(h.redeemExactFreeChips).not.toHaveBeenCalled();
    expect(balance(ctx)).toBe(START);
    expect(purchases(ctx)).toHaveLength(0);
    const said = saidAll(h.editReply);
    expect(said).toContain("チップ・Landは変更していません");
    expect(said).not.toMatch(/termsToken|ERR_TERMS_CHANGED|[0-9a-f]{16}/);
    ctx.db.close();
  });

  it("変わっていなければ、返還して購入まで通る", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const h = chipHarness(
      ctx,
      ctx.item.id,
      `shop:chips:c1:${ctx.item.id}:land:${token(ctx, ctx.item.id)}`,
    );

    await handleShopButton(h.ui, ctx.services);

    expect(h.redeemExactFreeChips).toHaveBeenCalledTimes(1);
    expect(purchases(ctx)).toHaveLength(1);
    ctx.db.close();
  });
});
