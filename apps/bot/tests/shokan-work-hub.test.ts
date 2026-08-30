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
 * 商館スタッフから見た「今やる仕事」。
 *
 * 内部で状態を厳密に分けるのはよいが、現場に状態機械を読ませない。
 * トップは「対応が必要 N件」の1つだけ。中身は**やることの言葉**で出す。
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
    idempotencyKey: "seed:hub",
  });
  const manual = shop.createItem({ name: "名前変更", price_land: 100, kind: "one_shot", delivery: "manual" } as never, "staff");
  const auto = shop.createItem(
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
  return { db, ledger, events, shop, manual, auto, services };
}
type Ctx = ReturnType<typeof setup>;

let buyerSeq = 0;
const buy = (ctx: Ctx, itemId: number, userId = USER) => {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  if (userId !== USER) {
    ctx.ledger.transfer({
      from: "sys:treasury",
      to: `user:${userId}`,
      amount: 1_000_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: `seed:${userId}`,
    });
  }
  return ctx.shop.purchase({
    itemId,
    userId,
    actor: userId,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;
};
const nextBuyer = () => `9999999999999999${(buyerSeq += 1)}`;

/** 提供状況が分からない案件 */
function uncertain(ctx: Ctx) {
  const p = buy(ctx, ctx.auto.id, nextBuyer());
  const claim = ctx.shop.claimExternalDelivery({ purchaseId: p.id, deliveryKind: "add_role", actor: "system" });
  ctx.shop.markExternalDeliveryUncertain({
    purchaseId: p.id,
    token: (claim as { token: string }).token,
    reason: "final_fetch_failed",
    actor: "system",
  });
  return p;
}

/** 返金できていない案件 */
function refundOpen(ctx: Ctx) {
  const p = buy(ctx, ctx.auto.id, nextBuyer());
  ctx.shop.markDeliveryFailed(p.id, "role_add_failed", "system");
  ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
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
const desc = (fn: ReturnType<typeof vi.fn>) => String(payload(fn)?.embeds?.[0]?.data?.description ?? "");
const fields = (fn: ReturnType<typeof vi.fn>) => JSON.stringify(payload(fn)?.embeds?.[0]?.data?.fields ?? []);
const buttonIds = (fn: ReturnType<typeof vi.fn>): string[] =>
  (payload(fn)?.components ?? []).flatMap((r: any) => (r.components ?? []).map((c: any) => c.data?.custom_id ?? ""));
const panelDesc = (ctx: Ctx, m: any) => String((m.shopAdminPanelMessage(ctx.services) as any).embeds[0].data.description);

describe("仕事があるのに「仕事はありません」と言わない", () => {
  it("提供状況の確認だけがあっても、仕事ありと出る", async () => {
    const m = await shokanModule;
    const ctx = setup();
    uncertain(ctx);
    expect(ctx.shop.countPendingManual()).toBe(0);
    // 確認待ちと配送やり直しで同じ購入を二重に数えない
    expect(ctx.shop.countUndeliveredAuto()).toBe(0);

    const d = panelDesc(ctx, m);
    expect(d).toContain("対応が必要な仕事: 1件");
    expect(d).not.toContain("仕事はありません");
    ctx.db.close();
  });

  it("返金の未完了だけがあっても、仕事ありと出る", async () => {
    const m = await shokanModule;
    const ctx = setup();
    refundOpen(ctx);

    const d = panelDesc(ctx, m);
    expect(d).toContain("対応が必要な仕事: 1件");
    expect(d).not.toContain("仕事はありません");
    ctx.db.close();
  });

  it("手動対応だけでも、配送やり直しだけでも、仕事ありと出る", async () => {
    const m = await shokanModule;
    const ctx = setup();
    buy(ctx, ctx.manual.id);
    expect(panelDesc(ctx, m)).toContain("対応が必要な仕事: 1件");

    const ctx2 = setup();
    const p = buy(ctx2, ctx2.auto.id, nextBuyer());
    ctx2.shop.markDeliveryFailed(p.id, "role_add_failed", "system");
    expect(ctx2.shop.countUndeliveredAuto()).toBe(1);
    expect(panelDesc(ctx2, m)).toContain("対応が必要な仕事: 1件");
    ctx.db.close();
    ctx2.db.close();
  });

  it("全部0のときだけ「対応が必要な仕事はありません」", async () => {
    const m = await shokanModule;
    const ctx = setup();
    expect(panelDesc(ctx, m)).toContain("対応が必要な仕事はありません");
    ctx.db.close();
  });
});

describe("仕事の入口は1つ", () => {
  it("トップは「対応が必要」だけで、種類ごとの入口を並べない", async () => {
    const { shopAdminPanelMessage } = await shokanModule;
    const ctx = setup();
    uncertain(ctx);
    refundOpen(ctx);
    buy(ctx, ctx.manual.id);

    const panel = shopAdminPanelMessage(ctx.services) as any;
    const ids = panel.components.flatMap((r: any) => r.toJSON().components).map((c: any) => c.custom_id);
    expect(ids).toContain("shokan:work");
    expect(ids).not.toContain("shokan:pending");
    expect(ids).not.toContain("shokan:failed");
    expect(ids).not.toContain("shokan:stuck-delivery");
    expect(ids).not.toContain("shokan:refund-open:0");
    ctx.db.close();
  });

  it("「対応が必要」を開くと、非0のものだけがやることの言葉で並ぶ", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    uncertain(ctx);
    refundOpen(ctx);

    const hub = vi.fn(async () => undefined);
    await handleShokanButton(press("shokan:work", hub), ctx.services);

    const d = desc(hub);
    expect(d).toContain("提供状況を確認する");
    expect(d).toContain("返金をやり直す");
    // 0件のものは出さない
    expect(d).not.toContain("手動で対応する");
    expect(d).not.toContain("配送をやり直す");
    // それぞれの入口へ行ける
    const ids = buttonIds(hub);
    expect(ids).toContain("shokan:stuck-delivery:0");
    expect(ids).toContain("shokan:refund-open:0");
    ctx.db.close();
  });

  it("内部の状態名を商館スタッフへ出さない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    uncertain(ctx);
    refundOpen(ctx);

    const hub = vi.fn(async () => undefined);
    await handleShokanButton(press("shokan:work", hub), ctx.services);

    const text = JSON.stringify(payload(hub)?.embeds ?? []);
    for (const leak of ["failed", "uncertain", "claim", "escalated", "operator resolution", "ERR_", "delivery_state"]) {
      expect(text).not.toContain(leak);
    }
    ctx.db.close();
  });
});

describe("商館で処理できない仕事を押し付けない", () => {
  it("商館で返せない返金は、仕事に数えず・押せるボタンも出さず・運営へ渡すと分かる", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    // 代替支払を含む購入。generic refund では戻せないので、押せる操作を作らない
    const id = ctx.db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,paid_alt_kind,paid_alt_amount,status,delivery_state,delivery_snapshot_json)
         VALUES (?,?,1,0,'invite',5,'active','pending',?) RETURNING id`,
      )
      .pluck()
      .get(ctx.auto.id, USER, JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: "r-vip" } })) as number;
    ctx.db
      .prepare(
        `INSERT INTO shop_purchase_fulfillment_provenance (purchase_id,delivery_mode,stock_consumed,captured_at,source)
         VALUES (?, 'auto', 0, 1, 'storefront')`,
      )
      .run(id);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });
    expect(ctx.shop.countRefundHandoffs()).toBe(1);
    expect(ctx.shop.countRefundFailures()).toBe(0);

    // **仕事の件数には入らない**（商館スタッフには返せない）
    const top = panelDesc(ctx, await shokanModule);
    expect(top).toContain("対応が必要な仕事はありません");
    // **しかしトップから存在は分かる**
    expect(top).toContain("運営判断が必要: 1件");

    const hub = vi.fn(async () => undefined);
    await handleShokanButton(press("shokan:work", hub), ctx.services);
    const f = fields(hub);
    // 剥奪の話と混ぜない
    expect(f).toContain("商館では返せない返金");
    expect(f).toContain("利用者へ返せていない購入");
    expect(f).toContain("運営へ");
    // 押せば必ず失敗するボタンを出さない
    const ids = (payload(hub)?.components ?? []).flatMap((r: any) => (r.components ?? []).map((c: any) => c.data?.custom_id ?? ""));
    expect(ids.some((x: string) => x.startsWith("shokan:refund-open"))).toBe(false);
    expect(ids.some((x: string) => x.startsWith("shokan:refund-pre"))).toBe(false);
    // 内部のコード名は出さない
    expect(f).not.toContain("ERR_ALT_REFUND_UNSUPPORTED");
    ctx.db.close();
  });

  it("剥奪の確認は仕事の件数に入れず、誰へ渡すかを書く", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx, ctx.auto.id, nextBuyer());
    ctx.shop.beginDelivery(p.id);
    ctx.shop.markDeliverySucceeded(p.id, "staff");
    // 自動では二度と再試行されない剥奪を作る
    ctx.db
      .prepare(
        `INSERT INTO shop_role_revocations (purchase_id, user_id, role_id, status, last_error, created_at, updated_at)
         VALUES (?,?, 'r-vip', 'failed', 'blocked:target_unproven', 0, 0)`,
      )
      .run(p.id, USER);
    expect(ctx.shop.countBlockedRoleRevocations()).toBe(1);

    // **仕事の件数には入らない**（商館スタッフには直せない）
    const top = panelDesc(ctx, await shokanModule);
    expect(top).toContain("対応が必要な仕事はありません");
    // **しかしトップから存在は分かる。** 気づかれずに永久に止まるのを防ぐ
    expect(top).toContain("運営判断が必要: 1件");
    expect(top).toContain("商館では処理できません");
    // ボタンからも辿れる（グレーで埋もれさせない）
    const panel = (await shokanModule).shopAdminPanelMessage(ctx.services) as any;
    const workBtn = panel.components
      .flatMap((r: any) => r.toJSON().components)
      .find((c: any) => c.custom_id === "shokan:work");
    expect(workBtn.label).toContain("運営判断");
    expect(workBtn.style).toBe(1); // Primary（Secondaryで埋もれさせない）

    const hub = vi.fn(async () => undefined);
    await handleShokanButton(press("shokan:work", hub), ctx.services);
    const f = fields(hub);
    expect(f).toContain("運営判断が必要");
    // merchant work の総数には混ぜない
    expect(desc(hub)).toContain("対応が必要な仕事はありません");
    expect(f).toContain("商館では処理できません");
    // 次に誰へ渡すか書いてある
    expect(f).toContain("運営へ");
    ctx.db.close();
  });
});
