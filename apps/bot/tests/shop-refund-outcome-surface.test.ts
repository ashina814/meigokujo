import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Settings, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * `RefundOutcome` の4状態を、通知でも表示でも**意味どおり**に扱う。
 *
 * とくに `withheld`（確認できないので返金を試していない）と
 * `escalated`（返金を試して失敗した）は、利用者にもスタッフにも別のことを言う。
 * 混ぜると「返金に失敗しました」と嘘をつくか、「確認中」と言って実害を隠す。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const refundModule = import("../src/shop-refund.js");
const panelModule = import("../src/commands/shop-panel.js");
const USER = "1463201396567441441";
const STAFF = "system:test";
const ROLE = "r-vip";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const settings = new Settings(db);
  const shop = new Shop(db, ledger, events);
  settings.set("channel:shokan", "c-shokan", "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:outcome",
  });
  const item = shop.createItem(
    {
      name: "裏口",
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE }),
    } as never,
    STAFF,
  );
  const sent: string[] = [];
  const client = {
    channels: {
      fetch: vi.fn(async () => ({
        isTextBased: () => true,
        send: vi.fn(async (m: { content: string }) => void sent.push(m.content)),
      })),
    },
  };
  const services = { db, ledger, events, settings, shop } as unknown as Services;
  return { db, ledger, events, shop, item, services, client, sent };
}
type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx) =>
  ctx.shop.purchase({
    itemId: ctx.item.id,
    userId: USER,
    actor: USER,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
  }).purchase;

/** roles.add は投げたが確認できない → withheld になる */
function unverifiableGuild() {
  const roles = new Set<string>();
  let fetches = 0;
  const member = {
    id: USER,
    roles: { cache: { has: (id: string) => roles.has(id) }, add: vi.fn(async (id: string) => void roles.add(id)) },
  };
  return {
    id: "g1",
    members: {
      fetch: vi.fn(async () => {
        fetches += 1;
        if (fetches > 1) throw new Error("Service Unavailable");
        return member;
      }),
    },
  };
}

/** ロールが無いと確認できる → 返金へ回る */
function verifiedFailureGuild() {
  const member = { id: USER, roles: { cache: { has: () => false }, add: vi.fn(async () => undefined) } };
  return { id: "g1", members: { fetch: vi.fn(async () => member) } };
}

const evt = (ctx: Ctx, t: string) => ctx.events.listByType(t).length;

describe("withheld と escalated を混ぜない", () => {
  it("withheld: 返金を試さず、確認待ちとして知らせる", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const p = buy(ctx);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    const settled = await deliverOrRefund(ctx.client as never, ctx.services, unverifiableGuild() as never, p, STAFF);

    expect(settled.refund).toBe("withheld");
    expect(evt(ctx, "shop_refund_withheld")).toBe(1);
    // **返金を試していないので「返金失敗」は0**
    expect(evt(ctx, "shop_refund_failed")).toBe(0);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);

    // 通知は「確認待ち」で、返金失敗とは言わない
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain("自動返金していません");
    expect(ctx.sent[0]).not.toContain("返金に失敗");
    // **現在の入口へ案内する。** 消えた旧名称へ戻さない
    expect(ctx.sent[0]).toContain("対応が必要");
    expect(ctx.sent[0]).toContain("提供状況を確認する");
    expect(ctx.sent[0]).not.toContain("確認待ちの案件");
    expect(ctx.sent[0]).not.toContain("処理失敗");
    ctx.db.close();
  });

  it("escalated: 返金を試して失敗したときだけ「返金に失敗」と知らせる", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const p = buy(ctx);
    // 返金そのものを失敗させる（実際の経路＝台帳への振替で落とす）
    vi.spyOn(ctx.ledger, "transfer").mockImplementation(() => {
      throw new Error("ledger unavailable");
    });

    const settled = await deliverOrRefund(ctx.client as never, ctx.services, verifiedFailureGuild() as never, p, STAFF);

    expect(settled.refund).toBe("escalated");
    expect(evt(ctx, "shop_refund_failed")).toBe(1);
    // **確認待ちではない**
    expect(evt(ctx, "shop_refund_withheld")).toBe(0);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain("返金に失敗");
    expect(ctx.sent[0]).not.toContain("自動返金していません");
    // **現在の入口へ案内する。** 「処理失敗」という入口はもう無い
    expect(ctx.sent[0]).toContain("対応が必要");
    expect(ctx.sent[0]).toContain("返金をやり直す");
    expect(ctx.sent[0]).not.toContain("処理失敗");
    ctx.db.close();
  });

  it("refunded: 通知そのものを出さない（スタッフの仕事を作らない）", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const p = buy(ctx);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    const settled = await deliverOrRefund(ctx.client as never, ctx.services, verifiedFailureGuild() as never, p, STAFF);

    expect(settled.refund).toBe("refunded");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before + 100);
    expect(ctx.sent).toHaveLength(0);
    expect(evt(ctx, "shop_refund_withheld")).toBe(0);
    expect(evt(ctx, "shop_refund_failed")).toBe(0);
    ctx.db.close();
  });
});

describe("サブ垢購入の表示 — RefundOutcome 4状態", () => {
  const opts = {
    purchaseId: 77,
    paidLand: 30_000,
    action: "有効化",
    alreadyDone: "サブ垢の有効化は既に完了しています。",
    note: "内部メモ",
  };

  it("refunded: 有効化できず返金したと言う", async () => {
    const { settlementMessage } = await panelModule;
    const m = settlementMessage("refunded", opts);
    expect(m).toContain("有効化できなかったため");
    expect(m).toContain("返金しました");
    expect(m).not.toContain("確認しています");
  });

  it("already_delivered: 既に完了していると言う", async () => {
    const { settlementMessage } = await panelModule;
    const m = settlementMessage("already_delivered", opts);
    expect(m).toContain("既に完了しています");
    expect(m).not.toContain("返金");
    expect(m).not.toContain("確認しています");
  });

  it("withheld: 確認中として、再購入不要を伝える", async () => {
    const { settlementMessage } = await panelModule;
    const { UNCERTAIN_USER_MESSAGE } = await import("../src/shop-delivery.js");
    const m = settlementMessage("withheld", opts);
    expect(m).toContain(UNCERTAIN_USER_MESSAGE);
    expect(m).toContain("重ねて購入する必要はありません");
    // 「失敗した」とは言わない
    expect(m).not.toContain("できず");
    expect(m).not.toContain("返金も完了できていません");
  });

  it("escalated: 返金も完了していないと言う（確認中とは言わない）", async () => {
    const { settlementMessage } = await panelModule;
    const m = settlementMessage("escalated", opts);
    expect(m).toContain("有効化できず、返金も完了できていません");
    expect(m).toContain("重ねて購入する必要はありません");
    // **確認中と誤魔化さない**
    expect(m).not.toContain("提供できたかを確認しています");
  });

  it("4状態がすべて違う文言になる", async () => {
    const { settlementMessage } = await panelModule;
    const all = (["refunded", "already_delivered", "withheld", "escalated"] as const).map((r) =>
      settlementMessage(r, opts),
    );
    expect(new Set(all).size).toBe(4);
  });
});
