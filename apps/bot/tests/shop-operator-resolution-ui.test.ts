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
 * 運営が案件を**開いて、何が起きるか見てから、決着させる**ところまで。
 *
 * 一覧に出すだけで終わらせない。かといって危険な操作を1クリックにもしない。
 * 古い画面からの決定は、資産も外部状態も1つも動かさずに止める。
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
  const shop = new Shop(db, ledger, events);
  settings.set("role:admin", ADMIN_ROLE, "staff");
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:ui",
  });
  const item = shop.createItem(
    {
      name: "裏口",
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "r-vip" }),
    } as never,
    "staff",
  );
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
  return { db, ledger, events, shop, item, services };
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

function uncertain(ctx: Ctx, purchaseId: number) {
  const claim = ctx.shop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: "system" });
  ctx.shop.markExternalDeliveryUncertain({
    purchaseId,
    token: (claim as { token: string }).token,
    reason: "final_fetch_failed",
    actor: "system",
  });
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
    deferUpdate: vi.fn(async () => undefined),
  } as never;
}

const payload = (fn: ReturnType<typeof vi.fn>) => (fn.mock.calls.at(-1) as never[])?.[0] as any;
const content = (fn: ReturnType<typeof vi.fn>) => String(payload(fn)?.content ?? "");
const description = (fn: ReturnType<typeof vi.fn>) => String(payload(fn)?.embeds?.[0]?.data?.description ?? "");
const buttonIds = (fn: ReturnType<typeof vi.fn>): string[] =>
  (payload(fn)?.components ?? []).flatMap((row: any) => (row.components ?? []).map((c: any) => c.data?.custom_id ?? ""));
const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

describe("運営の決着UI", () => {
  it("一覧から案件を開ける（開いただけでは何も変わらない）", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);

    const list = vi.fn(async () => undefined);
    await handleShokanButton(press("shokan:stuck-delivery", list), ctx.services);
    expect(buttonIds(list)).toContain(`shokan:case:${p.id}`);

    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${p.id}`, detail), ctx.services);

    // 決着の選択肢は出るが、まだ確定ボタンではない
    const ids = buttonIds(detail);
    expect(ids.some((id) => id.startsWith("shokan:case-pre:delivered:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("shokan:case-pre:no_effect:1:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("shokan:case-do:"))).toBe(false);
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("uncertain");
    ctx.db.close();
  });

  it("確定前に、実際に起きる変更を見せる（まだ変えない）", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${p.id}`, detail), ctx.services);
    const preId = buttonIds(detail).find((id) => id.startsWith("shokan:case-pre:no_effect:1:"))!;

    const preview = vi.fn(async () => undefined);
    await handleShokanButton(press(preId, preview), ctx.services);

    expect(description(preview)).toContain("これから起きること");
    expect(description(preview)).toContain("返金します");
    expect(buttonIds(preview).some((id) => id.startsWith("shokan:case-do:no_effect:1:"))).toBe(true);
    // まだ1つも動いていない
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("確定すると決着し、キューからちょうど一度だけ消える", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    expect(ctx.shop.countUnresolvedCases()).toBe(1);

    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${p.id}`, detail), ctx.services);
    const doId = buttonIds(detail)
      .find((id) => id.startsWith("shokan:case-pre:no_effect:1:"))!
      .replace("case-pre", "case-do");

    const confirm = vi.fn(async () => undefined);
    await handleShokanButton(press(doId, confirm), ctx.services);

    expect(content(confirm)).toContain("返金しました");
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.shop.countUnresolvedCases()).toBe(0);

    // 二度押しても増えない
    const again = vi.fn(async () => undefined);
    await handleShokanButton(press(doId, again), ctx.services);
    expect(content(again)).toContain("何も変更していません");
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("古い画面からの決定は、資産も状態も動かさない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${p.id}`, detail), ctx.services);
    const staleDo = buttonIds(detail)
      .find((id) => id.startsWith("shokan:case-pre:no_effect:1:"))!
      .replace("case-pre", "case-do");

    // 別の運営が先に「提供済み」で決着させた
    const q = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: q.token, actor: "other" });
    const before = landOf(ctx);

    const confirm = vi.fn(async () => undefined);
    await handleShokanButton(press(staleDo, confirm), ctx.services);

    expect(content(confirm)).toContain("何も変更していません");
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    ctx.db.close();
  });

  it("保留を選ぶと、確認待ちのまま残る", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${p.id}`, detail), ctx.services);
    const doId = buttonIds(detail)
      .find((id) => id.startsWith("shokan:case-pre:still_unknown:"))!
      .replace("case-pre", "case-do");

    const confirm = vi.fn(async () => undefined);
    await handleShokanButton(press(doId, confirm), ctx.services);

    expect(content(confirm)).toContain("判断保留");
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("uncertain");
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });

  it("運営画面に内部のtokenや状態名を出さない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${p.id}`, detail), ctx.services);

    const text = JSON.stringify(payload(detail)?.embeds ?? []);
    for (const leak of ["uncertain", "in_flight", "attempt_token", "delivery_state", "ERR_"]) {
      expect(text).not.toContain(leak);
    }
    ctx.db.close();
  });
});
