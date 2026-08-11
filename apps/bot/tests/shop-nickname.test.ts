import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { EventLog, Ledger, Settings, Shop, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 名前変更のセルフサービス。
 *
 * 通常のケースでスタッフの仕事を作らないことが要点。
 * - **課金前に分かる不可**（サーバー所有者・Botより上位ロール）は無課金で止める
 * - 課金後に変更できなかったら**自分で返金して**終わらせる
 * - 「処理失敗」に残すのは、**返金まで失敗して自力で収束できなかったとき**だけ
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shopPanelModule = import("../src/commands/shop-panel.js");
const shokanModule = import("../src/commands/shokan.js");
const recoveryModule = import("../src/scheduler-recovery.js");

const USER = "1463201396567441441";
const OWNER = "999999999999999999";
const PRICE = 50_000;

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const item = shop.createItem(
    { name: "名前変更", price_land: PRICE, kind: "one_shot", delivery: "auto", delivery_kind: "set_nickname" },
    "staff",
  );
  settings.set("guild:main", "g1", "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed",
  });
  const services = { db, ledger, settings, events, shop } as unknown as Services;
  return { db, ledger, settings, events, shop, item, services };
}

type Ctx = ReturnType<typeof setup>;

/** ニックネーム変更の成否を差し込めるメンバー／ギルド */
function world(opts: { nickname?: string | null; owner?: boolean; myPosition?: number; theirPosition?: number; setFails?: string } = {}) {
  const state = { nickname: opts.nickname ?? null };
  const member = {
    id: USER,
    get nickname() {
      return state.nickname;
    },
    roles: { cache: new Collection(), highest: { position: opts.theirPosition ?? 10 } },
    setNickname: vi.fn(async (name: string) => {
      if (opts.setFails) throw new Error(opts.setFails);
      state.nickname = name;
      return undefined;
    }),
  };
  const guild = {
    id: "g1",
    ownerId: opts.owner ? USER : OWNER,
    members: {
      me: { roles: { highest: { position: opts.myPosition ?? 100 } } },
      fetch: vi.fn(async () => member),
    },
  };
  return { guild, member, state };
}

function pressInteraction(ctx: Ctx, customId: string, w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  return {
    customId,
    id: `int-${Math.random()}`,
    user: { id: USER, username: "user" },
    guild: w.guild,
    guildId: "g1",
    member: w.member,
    client: { channels: { fetch: vi.fn(async () => null) }, users: { fetch: vi.fn(async () => null) } },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
    ...extra,
  } as never;
}

const contentOf = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])[0]?.content ?? "");
const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

describe("課金前に止まるケース（スタッフの仕事にしない）", () => {
  it("Botより上位ロールの相手は無課金で止まり、運営相談を案内する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ myPosition: 5, theirPosition: 50 });
    const interaction = pressInteraction(ctx, `shop:nick:${ctx.item.id}`, w) as unknown as {
      reply: ReturnType<typeof vi.fn>;
      showModal: ReturnType<typeof vi.fn>;
    };
    const before = balance(ctx);

    await handleShopButton(interaction as never, ctx.services);

    expect(contentOf(interaction.reply)).toContain("運営にご相談");
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(balance(ctx)).toBe(before);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("サーバー所有者は無課金で止まり、自分で変えるよう案内する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ owner: true });
    const interaction = pressInteraction(ctx, `shop:nick:${ctx.item.id}`, w) as unknown as {
      reply: ReturnType<typeof vi.fn>;
      showModal: ReturnType<typeof vi.fn>;
    };
    const before = balance(ctx);

    await handleShopButton(interaction as never, ctx.services);

    expect(contentOf(interaction.reply)).toContain("ご自身で変更");
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(balance(ctx)).toBe(before);
    ctx.db.close();
  });

  it("入力が不正なら無課金で止まる", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "そのまま" });
    for (const [input, hint] of [["", "入れてください"], ["x".repeat(33), "32 文字"], ["そのまま", "同じです"]] as const) {
      const interaction = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
        fields: { getTextInputValue: () => input },
      }) as unknown as { reply: ReturnType<typeof vi.fn> };
      const before = balance(ctx);

      await handleShopModal(interaction as never, ctx.services);

      expect(contentOf(interaction.reply)).toContain(hint);
      expect(balance(ctx)).toBe(before);
    }
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });
});

describe("通常の流れ", () => {
  it("入力 → 確認 → 変更する で完了する", async () => {
    const { handleShopModal, handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });

    // 入力 → 確認画面
    const modal = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "あたらしい名前" },
    }) as unknown as { reply: ReturnType<typeof vi.fn>; id: string };
    await handleShopModal(modal as never, ctx.services);
    const confirm = (modal.reply.mock.calls[0] as never[])[0] as {
      content: string;
      components: { toJSON(): { components: { custom_id: string; label: string }[] } }[];
    };
    expect(confirm.content).toContain("まえ");
    expect(confirm.content).toContain("あたらしい名前");
    expect(confirm.content).toContain("50,000");
    const doButton = confirm.components.flatMap((r) => r.toJSON().components)[0]!;
    expect(doButton.label).toBe("変更する");

    // 確定
    const press = pressInteraction(ctx, doButton.custom_id, w) as unknown as { editReply: ReturnType<typeof vi.fn> };
    await handleShopButton(press as never, ctx.services);

    expect(w.state.nickname).toBe("あたらしい名前");
    expect(contentOf(press.editReply)).toContain("あたらしい名前");
    expect(balance(ctx)).toBe(1_000_000 - PRICE);
    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(purchase.delivery_state).toBe("delivered");
    expect(JSON.parse(purchase.request_json!)).toEqual({ nickname: "あたらしい名前" });
    ctx.db.close();
  });

  it("同じ確認画面を二度押しても二重課金しない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    const customId = `shop:nick-do:${ctx.item.id}:conf-1:あたらしい`;

    await handleShopButton(pressInteraction(ctx, customId, w), ctx.services);
    const after = balance(ctx);
    await handleShopButton(pressInteraction(ctx, customId, w), ctx.services);

    expect(balance(ctx)).toBe(after);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    ctx.db.close();
  });
});

describe("課金後に変更できなかったとき", () => {
  it("自動返金して終わる（スタッフの仕事にしない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    const press = pressInteraction(ctx, `shop:nick-do:${ctx.item.id}:conf-1:あたらしい`, w) as unknown as {
      editReply: ReturnType<typeof vi.fn>;
    };

    await handleShopButton(press as never, ctx.services);

    expect(contentOf(press.editReply)).toContain("返金しました");
    expect(balance(ctx)).toBe(1_000_000); // 差し引きゼロ
    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(purchase.status).toBe("refunded");
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    // 「処理失敗」には出ない（自分で収束したので人の出番が無い）
    expect(ctx.shop.listUndeliveredAuto(10)).toHaveLength(0);
    ctx.db.close();
  });

  it("二重返金しない", async () => {
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    const { handleShopButton } = await shopPanelModule;
    await handleShopButton(pressInteraction(ctx, `shop:nick-do:${ctx.item.id}:conf-1:あたらしい`, w), ctx.services);
    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    const after = balance(ctx);

    expect(ctx.shop.refund(purchase.id, "again", "staff")).toEqual({ refunded: false, amount: PRICE });
    expect(balance(ctx)).toBe(after);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("返金まで失敗したときだけ「処理失敗」に残る", async () => {
    const { handleShopButton } = await shopPanelModule;
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    // 返金のLand移動を失敗させる
    ctx.db.prepare("CREATE TRIGGER fail_refund BEFORE INSERT ON transactions WHEN NEW.type='adjust' AND NEW.ref_type='shop_refund' BEGIN SELECT RAISE(ABORT,'injected'); END").run();
    const press = pressInteraction(ctx, `shop:nick-do:${ctx.item.id}:conf-1:あたらしい`, w) as unknown as {
      editReply: ReturnType<typeof vi.fn>;
    };

    await handleShopButton(press as never, ctx.services);

    expect(contentOf(press.editReply)).toContain("返金も完了できませんでした");
    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(purchase.status).toBe("active");
    expect(purchase.delivery_state).toBe("failed");
    expect(ctx.events.listByType("shop_refund_failed")).toHaveLength(1);
    // 管理パネルの「処理失敗」に出る
    const panel = shopAdminPanelMessage(ctx.services) as { embeds: { data: { description: string } }[] };
    expect(panel.embeds[0]!.data.description).toContain("処理失敗 1件");
    ctx.db.close();
  });
});

describe("課金後にBotが落ちた場合の収束", () => {
  async function crashedPurchase(ctx: Ctx, w: ReturnType<typeof world>) {
    // 課金と購入行だけ作り、配送前に落ちた状態を作る
    const purchase = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: USER,
      memberRoleIds: [],
      request: { nickname: "あたらしい" },
    }).purchase;
    return purchase;
  }

  function fakeClient(w: ReturnType<typeof world>, dm: ReturnType<typeof vi.fn>) {
    return {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => ({ send: dm })) },
      channels: { fetch: vi.fn(async () => null) },
    } as never;
  }

  it("まだ変わっていなければ変更をやり直して完了する", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    const purchase = await crashedPurchase(ctx, w);

    await convergePendingNicknameChanges(fakeClient(w, vi.fn()), ctx.services);

    expect(w.state.nickname).toBe("あたらしい");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
    expect(balance(ctx)).toBe(1_000_000 - PRICE);
    ctx.db.close();
  });

  it("**既に希望どおりなら返金しない**（変更済みなのに返金する、を防ぐ）", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    // 落ちる直前に変更だけ成功していた
    const w = world({ nickname: "あたらしい", setFails: "Missing Permissions" });
    const purchase = await crashedPurchase(ctx, w);

    await convergePendingNicknameChanges(fakeClient(w, vi.fn()), ctx.services);

    const after = ctx.shop.getPurchase(purchase.id)!;
    expect(after.delivery_state).toBe("delivered");
    expect(after.status).toBe("active");
    expect(balance(ctx)).toBe(1_000_000 - PRICE); // 返金していない
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    ctx.db.close();
  });

  it("変更できないままなら返金へ倒し、本人へ知らせる", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    const purchase = await crashedPurchase(ctx, w);
    const dm = vi.fn(async () => undefined);

    await convergePendingNicknameChanges(fakeClient(w, dm), ctx.services);

    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("refunded");
    expect(balance(ctx)).toBe(1_000_000);
    expect(String((dm.mock.calls[0] as never[])[0])).toContain("返金");
    ctx.db.close();
  });

  it("何度収束させても二重に課金・返金しない", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    await crashedPurchase(ctx, w);
    const client = fakeClient(w, vi.fn());

    await convergePendingNicknameChanges(client, ctx.services);
    await convergePendingNicknameChanges(client, ctx.services);
    await convergePendingNicknameChanges(client, ctx.services);

    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });
});

describe("旧購入の扱い", () => {
  it("商品を自動化しても、それ以前の手動購入は要対応に残る", async () => {
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    // 自動化する前に買われた購入（スナップショット無し＝当時は手動）
    ctx.db.prepare("UPDATE shop_items SET delivery='manual', delivery_kind=NULL WHERE id=?").run(ctx.item.id);
    const legacy = ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: USER, memberRoleIds: [] }).purchase;
    expect(legacy.delivery_snapshot_json).toBeNull();
    // いま自動化する
    ctx.db.prepare("UPDATE shop_items SET delivery='auto', delivery_kind='set_nickname' WHERE id=?").run(ctx.item.id);

    const panel = shopAdminPanelMessage(ctx.services) as { embeds: { data: { description: string } }[] };

    expect(panel.embeds[0]!.data.description).toContain("要対応 1件");
    expect(ctx.shop.listPendingManual().map((p) => p.id)).toEqual([legacy.id]);
    // 自動処理の対象にはしない（当時の希望内容が無いので勝手に動かさない）
    expect(ctx.shop.listUndeliveredAuto(10)).toHaveLength(0);
    ctx.db.close();
  });
});
