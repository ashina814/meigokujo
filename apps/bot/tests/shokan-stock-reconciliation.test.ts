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
import { setStock } from "./helpers/set-stock.js";

/**
 * 在庫変更画面は、**現在の在庫を決め打ちで書かない。**
 *
 * 未処理の返金義務は無制限のあいだにしか作られないが、そのあと運営が有限へ切り替えて
 * 義務だけ残っている商品もある。「現在 無制限 で…」と固定表示すると、その商品では
 * 表示が事実と食い違い、運営は自分が何を確定しようとしているのか判断できない。
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
  const departments = new Departments(db, ledger);
  const item = shop.createItem(
    { name: "限定札", price_land: 100, kind: "one_shot", delivery: "manual", delivery_kind: "none", stock: 3 } as never,
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
    idempotencyKey: "seed:stock-ui",
  });
  const services = {
    db,
    ledger,
    settings,
    events,
    shop,
    originalRoles: new OriginalRoles(db, ledger, events),
    subAccounts: new SubAccounts(db, events),
    departments,
  } as unknown as Services;
  return { db, events, shop, item, services };
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

/** 無制限のあいだに返金して、未処理義務(applied=0)を作る */
function makePending(ctx: Ctx, count: number) {
  const purchases = Array.from({ length: count }, () => buy(ctx, ctx.item.id));
  setStock(ctx.shop, ctx.item.id, null);
  for (const p of purchases) ctx.shop.refund(p.id, "未提供のため", "staff");
  return purchases;
}

function modalSubmit(customId: string, stock: string, reply: ReturnType<typeof vi.fn>) {
  return {
    customId,
    user: { id: STAFF, username: "staff" },
    member: { roles: { cache: new Collection([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) } },
    fields: { getTextInputValue: () => stock },
    reply,
  } as never;
}

function buttonPress(customId: string, reply: ReturnType<typeof vi.fn>) {
  return {
    customId,
    user: { id: STAFF, username: "staff" },
    member: { roles: { cache: new Collection([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) } },
    message: { flags: { has: () => false } },
    guild: null,
    reply,
    update: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
  } as never;
}

/** 直近の reply から embed の description を取り出す */
function description(fn: ReturnType<typeof vi.fn>): string {
  const payload = (fn.mock.calls.at(-1) as never[])?.[0] as { embeds?: Array<{ data?: { description?: string } }> };
  return payload?.embeds?.[0]?.data?.description ?? "";
}
function buttonIds(fn: ReturnType<typeof vi.fn>): string[] {
  const payload = (fn.mock.calls.at(-1) as never[])?.[0] as {
    components?: Array<{ components?: Array<{ data?: { custom_id?: string } }> }>;
  };
  return (payload?.components?.[0]?.components ?? []).map((c) => c.data?.custom_id ?? "");
}
const content = (fn: ReturnType<typeof vi.fn>) => String((fn.mock.calls.at(-1) as never[])?.[0]?.content ?? "");
const stockOf = (ctx: Ctx) => ctx.shop.getItem(ctx.item.id)!.stock;

describe("在庫変更画面 — 現在の在庫は事実どおりに出す", () => {
  it("現在が無制限なら「無制限」と出し、2択を出す", async () => {
    const { handleShokanModal } = await shokanModule;
    const ctx = setup();
    makePending(ctx, 1);
    expect(stockOf(ctx)).toBeNull();
    const reply = vi.fn(async () => undefined);

    await handleShokanModal(modalSubmit(`shokan:edit-stock:${ctx.item.id}`, "5", reply), ctx.services);

    const desc = description(reply);
    expect(desc).toContain("現在の在庫: **無制限**");
    expect(desc).toContain("未処理の返金在庫: **1個**");
    const ids = buttonIds(reply);
    expect(ids.some((id) => id.startsWith("shokan:stock-fix:final_stock:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("shokan:stock-fix:add_restorations:"))).toBe(true);
    // 何も確定していない
    expect(stockOf(ctx)).toBeNull();
    ctx.db.close();
  });

  it("現在が有限なら実際の数を出し、「現在 無制限」とは書かない", async () => {
    const { handleShokanModal } = await shokanModule;
    const ctx = setup();
    makePending(ctx, 1);
    // 義務を残したまま有限へ切り替わっている状態（Phase F 以前からの持ち越し）を作る
    ctx.db.prepare("UPDATE shop_items SET stock=5 WHERE id=?").run(ctx.item.id);
    expect(stockOf(ctx)).toBe(5);
    expect(ctx.shop.pendingStockRestorations(ctx.item.id).quantity).toBe(1);
    const reply = vi.fn(async () => undefined);

    await handleShokanModal(modalSubmit(`shokan:edit-stock:${ctx.item.id}`, "5", reply), ctx.services);

    const desc = description(reply);
    expect(desc).toContain("現在の在庫: **5個**");
    expect(desc).not.toContain("無制限");
    expect(desc).toContain("未処理の返金在庫: **1個**");
    expect(buttonIds(reply)).toHaveLength(2);
    ctx.db.close();
  });

  it("現在が有限でも、final_stock は5・add_restorations は6になる", async () => {
    const { handleShokanModal, handleShokanButton } = await shokanModule;

    for (const [mode, expected] of [
      ["final_stock", 5],
      ["add_restorations", 6],
    ] as const) {
      const ctx = setup();
      makePending(ctx, 1);
      ctx.db.prepare("UPDATE shop_items SET stock=5 WHERE id=?").run(ctx.item.id);
      const reply = vi.fn(async () => undefined);
      await handleShokanModal(modalSubmit(`shokan:edit-stock:${ctx.item.id}`, "5", reply), ctx.services);
      const id = buttonIds(reply).find((c) => c.startsWith(`shokan:stock-fix:${mode}:`))!;

      const confirm = vi.fn(async () => undefined);
      await handleShokanButton(buttonPress(id, confirm), ctx.services);

      expect(stockOf(ctx)).toBe(expected);
      expect(ctx.shop.pendingStockRestorations(ctx.item.id).quantity).toBe(0);
      ctx.db.close();
    }
  });

  it("未処理が無ければ2択を出さず、そのまま確定する", async () => {
    const { handleShokanModal } = await shokanModule;
    const ctx = setup();
    expect(ctx.shop.pendingStockRestorations(ctx.item.id).quantity).toBe(0);
    const reply = vi.fn(async () => undefined);

    await handleShokanModal(modalSubmit(`shokan:edit-stock:${ctx.item.id}`, "9", reply), ctx.services);

    expect(description(reply)).toBe("");
    expect(buttonIds(reply)).toEqual([]);
    expect(content(reply)).toContain("9個");
    expect(stockOf(ctx)).toBe(9);
    ctx.db.close();
  });

  it("表示のあとに状況が変わったら、何も変更せずやり直しを促す", async () => {
    const { handleShokanModal, handleShokanButton } = await shokanModule;
    const ctx = setup();
    const [, second] = makePending(ctx, 2);
    const reply = vi.fn(async () => undefined);
    await handleShokanModal(modalSubmit(`shokan:edit-stock:${ctx.item.id}`, "5", reply), ctx.services);
    const id = buttonIds(reply).find((c) => c.startsWith("shokan:stock-fix:final_stock:"))!;

    // 画面を出したあとに、別経路で義務が始末された
    const other = ctx.shop.quoteStockChange(ctx.item.id, 7);
    ctx.shop.applyStockChange({
      itemId: ctx.item.id,
      requestedStock: 7,
      reconciliationMode: "final_stock",
      expectedToken: other.tokens.final_stock!,
      actor: "staff",
    });
    expect(stockOf(ctx)).toBe(7);
    const settlementsBefore = ctx.db.prepare("SELECT COUNT(*) FROM shop_stock_restoration_settlements").pluck().get();

    const confirm = vi.fn(async () => undefined);
    await handleShokanButton(buttonPress(id, confirm), ctx.services);

    expect(content(confirm)).toContain("何も変更していません");
    // 0 mutation
    expect(stockOf(ctx)).toBe(7);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_stock_restoration_settlements").pluck().get()).toBe(
      settlementsBefore,
    );
    expect(second).toBeDefined();
    ctx.db.close();
  });
});
