import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { EventLog, Ledger, Nicknames, Settings, Shop, openDb, registerDefaultTxTypes } from "@meigokujo/core";
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
const OTHER = "888888888888888888";
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
  const nicknames = new Nicknames(db, events);
  const services = { db, ledger, settings, events, shop, nicknames } as unknown as Services;
  return { db, ledger, settings, events, shop, nicknames, item, services };
}

type Ctx = ReturnType<typeof setup>;

/** ニックネーム変更の成否を差し込めるメンバー／ギルド */
function world(
  opts: {
    nickname?: string | null;
    /** ニックネーム未設定のときに見えている名前（グローバル表示名） */
    globalName?: string;
    owner?: boolean;
    myPosition?: number;
    theirPosition?: number;
    setFails?: string;
    /** 最初の N 回だけ失敗する（一時的な失敗＝そのあと成功する、を作る） */
    failCalls?: number;
    /** setNickname はエラーを返すが、実際には変わってしまうケース */
    setChangesAnyway?: boolean;
    /** 同時押しを実際に交差させるための待ち */
    setDelayMs?: number;
  } = {},
) {
  const state = {
    nickname: opts.nickname ?? null,
    fails: opts.setFails ?? null,
    failCalls: opts.failCalls ?? Number.POSITIVE_INFINITY,
  };
  const globalName = opts.globalName ?? "グローバル名";
  const member = {
    id: USER,
    get nickname() {
      return state.nickname;
    },
    /** 利用者に実際に見えている名前。ニックネームが無ければグローバル表示名 */
    get displayName() {
      return state.nickname ?? globalName;
    },
    roles: { cache: new Collection(), highest: { position: opts.theirPosition ?? 10 } },
    setNickname: vi.fn(async (name: string) => {
      if (opts.setDelayMs) await new Promise((r) => setTimeout(r, opts.setDelayMs));
      if (state.fails && state.failCalls > 0) {
        state.failCalls -= 1;
        if (opts.setChangesAnyway) state.nickname = name; // APIは失敗を返したが、実際は変わった
        throw new Error(state.fails);
      }
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

/** 確認画面のボタン（確認したときの料金を持つ） */
const nickDo = (ctx: Ctx, confirmationId: string, wanted: string, price: number = PRICE) =>
  `shop:nick-do:${ctx.item.id}:${confirmationId}:${price}:${wanted}`;

/** 直近の返信からボタンの custom_id を取り出す */
function buttonIdOf(fn: ReturnType<typeof vi.fn>): string {
  const payload = (fn.mock.calls.at(-1) as never[])[0] as {
    components: { toJSON(): { components: { custom_id: string }[] } }[];
  };
  return payload.components.flatMap((r) => r.toJSON().components)[0]!.custom_id;
}

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
    const customId = nickDo(ctx, "conf-1", "あたらしい");

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
    const press = pressInteraction(ctx, nickDo(ctx, "conf-1", "あたらしい"), w) as unknown as {
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
    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "あたらしい"), w), ctx.services);
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
    const press = pressInteraction(ctx, nickDo(ctx, "conf-1", "あたらしい"), w) as unknown as {
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
    const client = fakeClient(w, vi.fn(async () => undefined));

    await convergePendingNicknameChanges(client, ctx.services);
    await convergePendingNicknameChanges(client, ctx.services);
    await convergePendingNicknameChanges(client, ctx.services);

    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("他種別の未完了が上限ぶん溜まっていても、名前変更は収束する", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    const purchase = await crashedPurchase(ctx, w);
    // 名前変更のほうが古い＝新しい順の一覧では最後尾になる
    ctx.db.prepare("UPDATE shop_purchases SET purchased_at = purchased_at - 3600 WHERE id = ?").run(purchase.id);
    // 別種別（ロール付与）の失敗が上限を超えて積まれている
    const roleItem = ctx.shop.createItem(
      {
        name: "ロール",
        price_land: 1,
        kind: "one_shot",
        delivery: "auto",
        delivery_kind: "add_role",
        delivery_data: JSON.stringify({ role_id: "r1" }),
      },
      "staff",
    );
    for (let i = 0; i < 25; i++) {
      const p = ctx.shop.purchase({ itemId: roleItem.id, userId: USER, actor: USER, memberRoleIds: [] }).purchase;
      ctx.shop.markDeliveryFailed(p.id, "boom", "test");
    }
    // 前提: 全種別から素直に20件取ると、名前変更は1件も入らない
    expect(ctx.shop.listUndeliveredAuto(20).some((p) => p.id === purchase.id)).toBe(false);

    await convergePendingNicknameChanges(fakeClient(w, vi.fn()), ctx.services);

    expect(w.state.nickname).toBe("あたらしい");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
    ctx.db.close();
  });

  it("巡回側で返金まで失敗したら、管理パネルを更新してスタッフへ知らせる", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    const purchase = await crashedPurchase(ctx, w);
    ctx.db
      .prepare(
        "CREATE TRIGGER fail_refund BEFORE INSERT ON transactions WHEN NEW.type='adjust' AND NEW.ref_type='shop_refund' BEGIN SELECT RAISE(ABORT,'injected'); END",
      )
      .run();
    ctx.settings.set("channel:shokan", "chan-1", "staff");
    ctx.settings.set("panel:shop_admin:chan-1", "msg-1", "staff");
    const send = vi.fn(async () => undefined);
    const edit = vi.fn(async () => undefined);
    const channel = { isTextBased: () => true, send, messages: { fetch: vi.fn(async () => ({ edit })) } };
    const dm = vi.fn(async () => undefined);
    const client = {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => ({ send: dm })) },
      channels: { fetch: vi.fn(async () => channel) },
    } as never;

    await convergePendingNicknameChanges(client, ctx.services);

    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("active"); // 返せていない
    expect(ctx.events.listByType("shop_refund_failed")).toHaveLength(1);
    expect(edit).toHaveBeenCalled(); // 管理パネルを更新した
    const notice = (send.mock.calls.at(-1) as never[])[0] as { content: string; components?: unknown[] };
    expect(notice.content).toContain("返金に失敗");
    expect(notice.components ?? []).toHaveLength(0); // 通知にボタンは付けない（操作は管理パネルが正本）
    expect(dm).not.toHaveBeenCalled(); // 返せていないのに「返金しました」とは言わない
    const panel = shopAdminPanelMessage(ctx.services) as { embeds: { data: { description: string } }[] };
    expect(panel.embeds[0]!.data.description).toContain("処理失敗 1件");
    ctx.db.close();
  });
});

describe("確認した内容を確定まで持たせる", () => {
  it("確認したあとに料金が変わったら、課金せず新しい料金で確認し直す", async () => {
    const { handleShopModal, handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    const modal = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "あたらしい" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };
    await handleShopModal(modal as never, ctx.services);
    const confirmed = buttonIdOf(modal.reply);
    // 押す前に運営が値上げした
    ctx.db.prepare("UPDATE shop_items SET price_land = 80000 WHERE id = ?").run(ctx.item.id);

    const press = pressInteraction(ctx, confirmed, w) as unknown as {
      update: ReturnType<typeof vi.fn>;
      deferUpdate: ReturnType<typeof vi.fn>;
    };
    await handleShopButton(press as never, ctx.services);

    // 確認した額でしか引かない。違ったら**1Ldも動かさず**新しい料金で出し直す
    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    expect(w.state.nickname).toBe("まえ");
    expect(press.deferUpdate).not.toHaveBeenCalled();
    expect(contentOf(press.update)).toContain("まだ引き落としていません");
    expect(contentOf(press.update)).toContain("80,000");

    // 出し直した確認から確定すれば、新しい料金で通る
    await handleShopButton(pressInteraction(ctx, buttonIdOf(press.update), w), ctx.services);
    expect(balance(ctx)).toBe(1_000_000 - 80_000);
    expect(w.state.nickname).toBe("あたらしい");
    ctx.db.close();
  });

  it("ニックネーム未設定でも、いま見えている名前と同じ入力は無課金で止まる", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    // ニックネームは無い。利用者に見えているのはグローバル表示名のほう
    const w = world({ nickname: null, globalName: "タロウ" });
    const modal = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "タロウ" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(modal as never, ctx.services);

    expect(contentOf(modal.reply)).toContain("同じです");
    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("確認画面には、いま見えている名前を旧名として出す", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: null, globalName: "タロウ" });
    const modal = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "ジロウ" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(modal as never, ctx.services);

    expect(contentOf(modal.reply)).toContain("**タロウ** → **ジロウ**");
    ctx.db.close();
  });
});

describe("返金済み・同時押しでも、変えたうえで返す が起きない", () => {
  it("返金まで済んだあとに古い確認画面を再送しても、名前は変わらない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    const customId = nickDo(ctx, "conf-1", "あたらしい");
    await handleShopButton(pressInteraction(ctx, customId, w), ctx.services);
    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(purchase.status).toBe("refunded");

    // 変更できる状態に戻ってから、同じ確認画面をもう一度押す
    w.state.fails = null;
    const press = pressInteraction(ctx, customId, w) as unknown as { editReply: ReturnType<typeof vi.fn> };
    await handleShopButton(press as never, ctx.services);

    expect(w.state.nickname).toBe("まえ"); // 返した以上、サービスは提供しない
    expect(w.member.setNickname).toHaveBeenCalledTimes(1); // 2回目は Discord を叩きもしない
    expect(balance(ctx)).toBe(1_000_000);
    expect(contentOf(press.editReply)).toContain("返金済み");
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("同じ確認画面の同時二度押し: 変更が通るなら、返金は一切起きない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setDelayMs: 5 });
    const customId = nickDo(ctx, "conf-1", "あたらしい");

    await Promise.all([
      handleShopButton(pressInteraction(ctx, customId, w), ctx.services),
      handleShopButton(pressInteraction(ctx, customId, w), ctx.services),
    ]);

    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1); // 二重課金なし
    expect(w.state.nickname).toBe("あたらしい");
    expect(purchase.status).toBe("active");
    expect(purchase.delivery_state).toBe("delivered");
    expect(balance(ctx)).toBe(1_000_000 - PRICE);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    ctx.db.close();
  });

  it("同じ確認画面の同時二度押し: 変更が通らないなら、返金は一度だけ", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions", setDelayMs: 5 });
    const customId = nickDo(ctx, "conf-1", "あたらしい");

    await Promise.all([
      handleShopButton(pressInteraction(ctx, customId, w), ctx.services),
      handleShopButton(pressInteraction(ctx, customId, w), ctx.services),
    ]);

    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1); // 二重課金なし
    expect(w.state.nickname).toBe("まえ");
    expect(purchase.status).toBe("refunded");
    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1); // 二重返金なし
    // **これが本命**: 「名前が変わった」と「返金した」は絶対に両立しない
    expect(w.state.nickname === "あたらしい" && purchase.status === "refunded").toBe(false);
    ctx.db.close();
  });

  it("同時二度押しで一方が失敗・他方が成功しても、変更と返金は両立しない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    // 1回目だけ失敗する＝返金へ倒れる裏で、もう1本が変更を成功させうる並び
    const w = world({ nickname: "まえ", setFails: "Server Error", failCalls: 1, setDelayMs: 5 });
    const customId = nickDo(ctx, "conf-1", "あたらしい");

    await Promise.all([
      handleShopButton(pressInteraction(ctx, customId, w), ctx.services),
      handleShopButton(pressInteraction(ctx, customId, w), ctx.services),
    ]);

    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(1); // 二重課金なし
    // どちらへ倒れてもよいが、**倒れた先と辻褄が合っていること**。
    // 「名前は変わったのに返金もした」＝払わずにサービスを受けた、を許さない
    if (purchase.status === "refunded") {
      expect(w.state.nickname).toBe("まえ");
      expect(balance(ctx)).toBe(1_000_000);
    } else {
      expect(w.state.nickname).toBe("あたらしい");
      expect(purchase.delivery_state).toBe("delivered");
      expect(balance(ctx)).toBe(1_000_000 - PRICE);
      expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    }
    ctx.db.close();
  });
});

describe("setNickname がエラーを返したとき", () => {
  it("取り直して希望どおりになっていれば、成功として扱い返金しない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    // APIはエラーを返したが、実際には変わっていた（応答だけ落ちた等）
    const w = world({ nickname: "まえ", setFails: "Service Unavailable", setChangesAnyway: true });
    const press = pressInteraction(ctx, nickDo(ctx, "conf-1", "あたらしい"), w) as unknown as {
      editReply: ReturnType<typeof vi.fn>;
    };

    await handleShopButton(press as never, ctx.services);

    expect(w.state.nickname).toBe("あたらしい");
    const purchase = ctx.shop.listUserPurchases(USER)[0]!;
    expect(purchase.delivery_state).toBe("delivered");
    expect(purchase.status).toBe("active");
    expect(balance(ctx)).toBe(1_000_000 - PRICE); // 変わったのだから返さない
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    expect(contentOf(press.editReply)).toContain("変更しました");
    ctx.db.close();
  });

  it("取り直しても変わっていなければ返金する", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });
    const press = pressInteraction(ctx, nickDo(ctx, "conf-1", "あたらしい"), w) as unknown as {
      editReply: ReturnType<typeof vi.fn>;
    };

    await handleShopButton(press as never, ctx.services);

    expect(w.state.nickname).toBe("まえ");
    expect(balance(ctx)).toBe(1_000_000);
    expect(contentOf(press.editReply)).toContain("返金しました");
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

describe("入城の名前制度との統合", () => {
  it("**予約が正本**。改名すると予約が移り、古い名前は他の人が取れる", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    ctx.nicknames.claim({ userId: USER, nickname: "まえ", setVia: "entry", actor: "t" });

    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "あと"), w), ctx.services);

    expect(w.state.nickname).toBe("あと");
    expect(ctx.nicknames.get(USER)?.nickname).toBe("あと");
    expect(ctx.nicknames.reservation("あと")?.user_id).toBe(USER);
    expect(ctx.nicknames.reservation("まえ")).toBeNull(); // 手放した
    ctx.db.close();
  });

  it("**入城で固定された名前も、商館の正式な改名なら越えられる**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "こてい" });
    ctx.nicknames.claim({ userId: USER, nickname: "こてい", setVia: "entry", actor: "t" });
    ctx.nicknames.lock(USER, "staff");

    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "あたらしい"), w), ctx.services);

    expect(w.state.nickname).toBe("あたらしい");
    expect(ctx.nicknames.get(USER)?.nickname).toBe("あたらしい");
    expect(ctx.nicknames.get(USER)?.locked_at).not.toBeNull(); // 固定は外れない
    expect(ctx.nicknames.get(USER)?.set_via).toBe("shop");
    ctx.db.close();
  });

  it("記号を含む名前は無課金で止まる（入城パネルと同じ規則）", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    const m = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "★ほし★" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(contentOf(m.reply)).toContain("使えない文字");
    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("禁止語に当たる名前は無課金で止まる（払っても規則を迂回できない）", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    ctx.nicknames.addDenyWord("ばつ", "staff", { action: "reject" });
    const m = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "ばつわーど" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("他の人が使っている名前は無課金で止まる", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    ctx.nicknames.claim({ userId: "999999999999999999", nickname: "とられている", setVia: "entry", actor: "t" });
    const m = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "とられている" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(contentOf(m.reply)).toContain("既に他の方");
    expect(balance(ctx)).toBe(1_000_000);
    ctx.db.close();
  });

  it("既存の重複（誰の持ち物でもない予約）も無課金で止まる", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    ctx.nicknames.importLegacy(
      [
        { userId: "888888888888888888", nickname: "かぶり" },
        { userId: "999999999999999999", nickname: "かぶり" },
      ],
      "staff",
    );
    const m = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "かぶり" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(contentOf(m.reply)).toContain("既に城内で使われている");
    expect(balance(ctx)).toBe(1_000_000);
    ctx.db.close();
  });

  it("**確認後に他の人へ取られていたら、課金せず止まる**", async () => {
    const { handleShopModal, handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    const modal = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "きそう" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };
    await handleShopModal(modal as never, ctx.services);
    const doId = buttonIdOf(modal.reply);

    // 確認画面を見ている間に、別の人がその名前を取った
    ctx.nicknames.claim({ userId: "999999999999999999", nickname: "きそう", setVia: "entry", actor: "t" });
    const press = pressInteraction(ctx, doId, w) as unknown as { update: ReturnType<typeof vi.fn> };
    await handleShopButton(press as never, ctx.services);

    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    expect(w.state.nickname).toBe("まえ");
    expect(contentOf(press.update)).toContain("既に他の方");
    ctx.db.close();
  });

  it("**課金後にDiscordが失敗したら、予約も返金も戻す**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ", setFails: "Missing Permissions" });

    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "とれない"), w), ctx.services);

    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    expect(ctx.nicknames.get(USER)).toBeNull(); // 正本を残さない
    expect(ctx.nicknames.reservation("とれない")).toBeNull(); // 予約も残さない
    // 他の人がその名前を取れる
    expect(ctx.nicknames.claim({ userId: "999999999999999999", nickname: "とれない", setVia: "entry", actor: "t" }).ok).toBe(true);
    ctx.db.close();
  });

  it("巻き戻しても、それ以前に登録していた名前は失われない", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "もとの", setFails: "Missing Permissions" });
    ctx.nicknames.claim({ userId: USER, nickname: "もとの", setVia: "entry", actor: "t" });

    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "あたらしい"), w), ctx.services);

    expect(ctx.nicknames.get(USER)?.nickname).toBe("もとの");
    expect(ctx.nicknames.reservation("もとの")?.user_id).toBe(USER);
    expect(ctx.nicknames.reservation("あたらしい")).toBeNull();
    expect(balance(ctx)).toBe(1_000_000);
    ctx.db.close();
  });

  it("購入後に他の人へ取られていたら、配送で気づいて返金する", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    // 課金だけ済んで落ちた
    ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: USER, memberRoleIds: [], request: { nickname: "よこどり" } });
    // 落ちている間に別の人がその名前を取った
    ctx.nicknames.claim({ userId: "999999999999999999", nickname: "よこどり", setVia: "entry", actor: "t" });
    const client = {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => undefined) })) },
      channels: { fetch: vi.fn(async () => null) },
    } as never;

    await convergePendingNicknameChanges(client, ctx.services);

    expect(w.state.nickname).toBe("まえ"); // 変えていない
    expect(balance(ctx)).toBe(1_000_000); // 返金した
    expect(ctx.nicknames.reservation("よこどり")?.user_id).toBe("999999999999999999"); // 横取りしない
    ctx.db.close();
  });
});

describe("レビュー指摘の4点", () => {
  it("**確認が必要な名前（flag）は課金前に止める**（払っても素通しにしない）", async () => {
    const { handleShopModal } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "まえ" });
    ctx.nicknames.addDenyWord("ようかくにん", "staff", { action: "flag" });
    const m = pressInteraction(ctx, `shop:nick-input:${ctx.item.id}`, w, {
      fields: { getTextInputValue: () => "ようかくにんな名前" },
    }) as unknown as { reply: ReturnType<typeof vi.fn> };

    await handleShopModal(m as never, ctx.services);

    expect(contentOf(m.reply)).toContain("確認が必要");
    expect(contentOf(m.reply)).not.toContain("ようかくにん"); // どの語で止まったかは見せない
    expect(balance(ctx)).toBe(1_000_000);
    expect(ctx.shop.listUserPurchases(USER)).toHaveLength(0);
    ctx.db.close();
  });

  it("**A→BのDiscord変更待ち中、別の人はAを取得できない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "えー", setDelayMs: 40 });
    ctx.nicknames.claim({ userId: USER, nickname: "えー", setVia: "entry", actor: "t" });

    const pending = handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "びー"), w), ctx.services);
    await new Promise((r) => setTimeout(r, 15)); // Discord 変更の途中

    // 旧名は手放していない
    expect(ctx.nicknames.reservation("えー")?.user_id).toBe(USER);
    expect(ctx.nicknames.claim({ userId: OTHER, nickname: "えー", setVia: "entry", actor: "t" }).ok).toBe(false);
    // 新名も既に押さえてある（他の人は取れない）
    expect(ctx.nicknames.claim({ userId: OTHER, nickname: "びー", setVia: "entry", actor: "t" }).ok).toBe(false);
    await pending;
    ctx.db.close();
  });

  it("**A→Bが失敗したら、Aの登録も予約もそのまま残る**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "えー", setFails: "Missing Permissions" });
    ctx.nicknames.claim({ userId: USER, nickname: "えー", setVia: "entry", actor: "t" });

    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "びー"), w), ctx.services);

    expect(ctx.nicknames.get(USER)?.nickname).toBe("えー");
    expect(ctx.nicknames.reservation("えー")?.user_id).toBe(USER);
    expect(ctx.nicknames.reservation("えー")?.staged_for_purchase).toBeNull();
    expect(ctx.nicknames.reservation("びー")).toBeNull(); // 仮押さえだけ解放
    expect(balance(ctx)).toBe(1_000_000); // 返金済み
    ctx.db.close();
  });

  it("**A→B成功後はAが解放され、別の人が取得できる**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    const w = world({ nickname: "えー" });
    ctx.nicknames.claim({ userId: USER, nickname: "えー", setVia: "entry", actor: "t" });

    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "びー"), w), ctx.services);

    expect(w.state.nickname).toBe("びー");
    expect(ctx.nicknames.get(USER)?.nickname).toBe("びー");
    expect(ctx.nicknames.reservation("びー")?.staged_for_purchase).toBeNull(); // 確定済み
    expect(ctx.nicknames.reservation("えー")).toBeNull(); // 解放された
    expect(ctx.nicknames.claim({ userId: OTHER, nickname: "えー", setVia: "entry", actor: "t" }).ok).toBe(true);
    ctx.db.close();
  });

  it("**仮押さえ後に落ちて、再試行も失敗した場合もAが残る**", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    const w = world({ nickname: "えー", setFails: "Missing Permissions" });
    ctx.nicknames.claim({ userId: USER, nickname: "えー", setVia: "entry", actor: "t" });
    // 課金と仮押さえまで済んで落ちた状態
    const purchase = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: USER,
      memberRoleIds: [],
      request: { nickname: "びー" },
    }).purchase;
    ctx.nicknames.stageRename({ userId: USER, nickname: "びー", purchaseId: purchase.id, actor: "t", allowLocked: true });
    // 落ちている間も旧名は他の人に取られない
    expect(ctx.nicknames.claim({ userId: OTHER, nickname: "えー", setVia: "entry", actor: "t" }).ok).toBe(false);

    const client = {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => undefined) })) },
      channels: { fetch: vi.fn(async () => null) },
    } as never;
    await convergePendingNicknameChanges(client, ctx.services);

    expect(ctx.nicknames.get(USER)?.nickname).toBe("えー");
    expect(ctx.nicknames.reservation("えー")?.user_id).toBe(USER);
    expect(ctx.nicknames.reservation("びー")).toBeNull();
    expect(balance(ctx)).toBe(1_000_000);
    ctx.db.close();
  });

  it("Discord変更だけ成功して落ちても、巡回で確定できる", async () => {
    const { convergePendingNicknameChanges } = await recoveryModule;
    const ctx = setup();
    // Discord は既に びー。仮押さえのまま落ちた
    const w = world({ nickname: "びー" });
    ctx.nicknames.claim({ userId: USER, nickname: "えー", setVia: "entry", actor: "t" });
    const purchase = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: USER,
      memberRoleIds: [],
      request: { nickname: "びー" },
    }).purchase;
    ctx.nicknames.stageRename({ userId: USER, nickname: "びー", purchaseId: purchase.id, actor: "t", allowLocked: true });

    const client = {
      guilds: { fetch: vi.fn(async () => w.guild) },
      users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => undefined) })) },
      channels: { fetch: vi.fn(async () => null) },
    } as never;
    await convergePendingNicknameChanges(client, ctx.services);

    expect(ctx.nicknames.get(USER)?.nickname).toBe("びー"); // 確定した
    expect(ctx.nicknames.reservation("びー")?.staged_for_purchase).toBeNull();
    expect(ctx.nicknames.reservation("えー")).toBeNull();
    expect(balance(ctx)).toBe(1_000_000 - PRICE); // 提供できたので返金しない
    ctx.db.close();
  });

  it("**同じ人の別購入（A→B と A→C）が同時に走っても正本が壊れない**", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    // 1本目だけ Discord 変更に失敗する＝巻き戻しと、もう1本の登録が噛み合う並び
    const w = world({ nickname: "もとの", setFails: "Missing Permissions", failCalls: 1, setDelayMs: 5 });
    ctx.nicknames.claim({ userId: USER, nickname: "もとの", setVia: "entry", actor: "t" });

    await Promise.all([
      handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-B", "びー"), w), ctx.services),
      handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-C", "しー"), w), ctx.services),
    ]);

    // **DBの正本と Discord の表示が食い違わない**（片方の巻き戻しが他方を消さない）
    const row = ctx.nicknames.get(USER);
    expect(row?.nickname ?? null).toBe(w.state.nickname);
    if (row) {
      expect(ctx.nicknames.reservation(row.name_key)?.user_id).toBe(USER);
      const keys = (ctx.db.prepare("SELECT name_key FROM nickname_reservations").all() as Array<{ name_key: string }>)
        .map((r) => r.name_key);
      expect(keys).toEqual([row.name_key]); // 使っていない名前の予約が残らない
    }
    ctx.db.close();
  });

  it("**成功判定は nickname を見る**（グローバル表示名の一致で誤認しない）", async () => {
    const { handleShopButton } = await shopPanelModule;
    const ctx = setup();
    // 登録名は別。ニックネームは未設定で、グローバル表示名がたまたま希望と同じ
    const w = world({ nickname: null, globalName: "きぼう", setFails: "Missing Permissions" });
    ctx.nicknames.claim({ userId: USER, nickname: "とうろく", setVia: "entry", actor: "t" });

    await handleShopButton(pressInteraction(ctx, nickDo(ctx, "conf-1", "きぼう"), w), ctx.services);

    // displayName で見ていると「既に希望どおり」と誤認し、課金したまま完了になる
    expect(w.member.setNickname).toHaveBeenCalled(); // 変更を試みている
    expect(w.state.nickname).toBeNull(); // 実際には変わっていない
    expect(balance(ctx)).toBe(1_000_000); // 返金された
    expect(ctx.nicknames.get(USER)?.nickname).toBe("とうろく"); // 元の登録へ戻る
    ctx.db.close();
  });
});
