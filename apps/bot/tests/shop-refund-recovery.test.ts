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
 * 「返金しようとして失敗した」を、配送の再試行と混ぜない。
 *
 * 前者は利用者の資産が戻っていないので**返金をやり直す**仕事。
 * 後者は**もう一度配る**仕事。同じキューに入れると、返せていない購入を
 * 配り直そうとしたり、逆に配れば済むものを返金したりする。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const shokanModule = import("../src/commands/shokan.js");
const refundModule = import("../src/shop-refund.js");
const USER = "1463201396567441441";
const STAFF = "222222222222222222";
const ADMIN_ROLE = "r-admin";
const ROLE = "r-vip";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  settings.set("role:admin", ADMIN_ROLE, "staff");
  settings.set("channel:shokan", "c-shokan", "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:recovery",
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
    "staff",
  );
  const sent: string[] = [];
  const client = {
    channels: {
      fetch: vi.fn(async () => ({ isTextBased: () => true, send: vi.fn(async (m: { content: string }) => void sent.push(m.content)) })),
    },
  };
  const services = {
    db,
    ledger,
    settings,
    events,
    shop,
    originalRoles: new OriginalRoles(db, ledger, events),
    subAccounts: new SubAccounts(db, events),
    departments: new Departments(db, ledger),
  } as unknown as Services;
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

/** ロールが無いと確認できる（= verified failure → 返金へ回る） */
const verifiedFailureGuild = () => ({
  id: "g1",
  members: { fetch: vi.fn(async () => ({ id: USER, roles: { cache: { has: () => false }, add: vi.fn(async () => undefined) } })) },
});

/** roles.add は投げたが確認できない（= withheld） */
function unverifiableGuild() {
  const roles = new Set<string>();
  let fetches = 0;
  const member = { id: USER, roles: { cache: { has: (id: string) => roles.has(id) }, add: vi.fn(async (id: string) => void roles.add(id)) } };
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

/** 配送も返金も失敗した購入を作る */
async function refundFailed(ctx: Ctx) {
  const { deliverOrRefund } = await refundModule;
  const p = buy(ctx);
  // **実際の失敗経路で作る。** 返金は台帳への振替で失敗する
  const spy = vi.spyOn(ctx.ledger, "transfer").mockImplementation(() => {
    throw new Error("ledger unavailable");
  });
  const settled = await deliverOrRefund(ctx.client as never, ctx.services, verifiedFailureGuild() as never, p, "system:test");
  spy.mockRestore();
  expect(settled.refund).toBe("escalated");
  return p;
}

function press(customId: string, reply: ReturnType<typeof vi.fn>) {
  return {
    customId,
    user: { id: STAFF, username: "staff" },
    member: { roles: { cache: new Collection([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) } },
    message: { flags: { has: () => false } },
    client: { channels: { fetch: vi.fn(async () => null) } },
    guild: null,
    reply,
    update: vi.fn(async () => undefined),
  } as never;
}
const payload = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls.at(-1) as never[])?.[0] as any;
const content = (fn: ReturnType<typeof vi.fn>) => String(payload(fn)?.content ?? "");
const buttonIds = (fn: ReturnType<typeof vi.fn>): string[] =>
  (payload(fn)?.components ?? []).flatMap((r: any) => (r.components ?? []).map((c: any) => c.data?.custom_id ?? ""));
const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

describe("返金の未完了は別のキュー", () => {
  it("返金に失敗した購入は返金キューへ出て、配送再試行には出ない", async () => {
    const ctx = setup();
    const p = await refundFailed(ctx);

    expect(ctx.shop.countRefundFailures()).toBe(1);
    expect(ctx.shop.listRefundFailures()[0]).toMatchObject({ purchaseId: p.id, amount: 100 });
    // 配送の再試行キューには出ない
    expect(ctx.shop.listUndeliveredAuto(50).map((r) => r.id)).not.toContain(p.id);
    expect(ctx.shop.countUndeliveredAuto()).toBe(0);
    // 確認待ちの案件でもない
    expect(ctx.shop.countUnresolvedCases()).toBe(0);
    ctx.db.close();
  });

  it("確認できないだけの購入は返金キューに出ない", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const p = buy(ctx);

    const settled = await deliverOrRefund(ctx.client as never, ctx.services, unverifiableGuild() as never, p, "system:test");

    expect(settled.refund).toBe("withheld");
    // **返金を試していないので返金キューには出ない。** 確認待ちの案件として出る
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    ctx.db.close();
  });

  it("運営が返金をやり直すと、ちょうど一度だけ返金される", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = await refundFailed(ctx);
    const before = landOf(ctx);

    const list = vi.fn(async () => undefined);
    await handleShokanButton(press("shokan:refund-open:0", list), ctx.services);
    expect(buttonIds(list)).toContain(`shokan:refund-pre:${p.id}`);

    // 確認画面ではまだ動かない
    const preview = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:refund-pre:${p.id}`, preview), ctx.services);
    expect(landOf(ctx)).toBe(before);
    const doId = buttonIds(preview).find((id) => id.startsWith("shokan:refund-do:"))!;

    const confirm = vi.fn(async () => undefined);
    await handleShokanButton(press(doId, confirm), ctx.services);

    expect(content(confirm)).toContain("返金しました");
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    // キューから消える
    expect(ctx.shop.countRefundFailures()).toBe(0);

    // 二度押しても増えない
    const again = vi.fn(async () => undefined);
    await handleShokanButton(press(doId, again), ctx.services);
    expect(content(again)).toContain("何も変更していません");
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("2人が同時に返金しても、返金は一度だけ", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = await refundFailed(ctx);
    const before = landOf(ctx);

    const a = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:refund-pre:${p.id}`, a), ctx.services);
    const b = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:refund-pre:${p.id}`, b), ctx.services);
    const idA = buttonIds(a).find((id) => id.startsWith("shokan:refund-do:"))!;
    const idB = buttonIds(b).find((id) => id.startsWith("shokan:refund-do:"))!;

    const r1 = vi.fn(async () => undefined);
    await handleShokanButton(press(idA, r1), ctx.services);
    const r2 = vi.fn(async () => undefined);
    await handleShokanButton(press(idB, r2), ctx.services);

    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    expect(content(r2)).toContain("何も変更していません");
    ctx.db.close();
  });

  it("状況が変わっていたら、1つも動かさない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = await refundFailed(ctx);
    const preview = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:refund-pre:${p.id}`, preview), ctx.services);
    const doId = buttonIds(preview).find((id) => id.startsWith("shokan:refund-do:"))!;

    // 別経路で先に返金された
    ctx.shop.refund(p.id, "別経路", "other");
    const before = landOf(ctx);

    const confirm = vi.fn(async () => undefined);
    await handleShokanButton(press(doId, confirm), ctx.services);

    expect(content(confirm)).toContain("何も変更していません");
    expect(landOf(ctx)).toBe(before);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("案件は開いたままでも、画面を出したあとに状況が動いていれば止める", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = await refundFailed(ctx);
    const preview = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:refund-pre:${p.id}`, preview), ctx.services);
    const doId = buttonIds(preview).find((id) => id.startsWith("shokan:refund-do:"))!;

    // まだ返金対象のまま。ただし別経路がもう一度失敗を記録した（状況が動いた）
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "retry_failed", actor: "other" });
    expect(ctx.shop.countRefundFailures()).toBe(1);
    const before = landOf(ctx);

    const confirm = vi.fn(async () => undefined);
    await handleShokanButton(press(doId, confirm), ctx.services);

    expect(content(confirm)).toContain("何も変更していません");
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);

    // 取り直せば通る
    const fresh = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:refund-pre:${p.id}`, fresh), ctx.services);
    const freshDo = buttonIds(fresh).find((id) => id.startsWith("shokan:refund-do:"))!;
    const ok = vi.fn(async () => undefined);
    await handleShokanButton(press(freshDo, ok), ctx.services);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });

  it("提供済みの購入を、返金のやり直しで壊さない", async () => {
    const ctx = setup();
    const p = await refundFailed(ctx);
    // そのあと提供済みとして確定された
    ctx.shop.beginDelivery(p.id);
    ctx.shop.markDeliverySucceeded(p.id, "staff");
    const before = landOf(ctx);

    const quote = ctx.shop.quoteRefundRetry(p.id);
    // 提供済みなので返金は通らない（Phase D の contract をそのまま使う）
    expect(() => ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: "staff" })).toThrow();
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    ctx.db.close();
  });

  it("内部の例外文やエラーコードを運営画面へ出さない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    await refundFailed(ctx);

    const list = vi.fn(async () => undefined);
    await handleShokanButton(press("shokan:refund-open:0", list), ctx.services);

    const text = JSON.stringify(payload(list)?.embeds ?? []);
    for (const leak of ["ledger unavailable", "ERR_", "delivery_state", "escalated"]) {
      expect(text).not.toContain(leak);
    }
    ctx.db.close();
  });
});
