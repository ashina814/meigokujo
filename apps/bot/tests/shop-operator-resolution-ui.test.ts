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

function press(customId: string, reply: ReturnType<typeof vi.fn>, showModal = vi.fn(async () => undefined)) {
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
    showModal,
  } as never;
}

/** 根拠入力モーダルの送信 */
function submitNote(customId: string, note: string, reply: ReturnType<typeof vi.fn>) {
  return {
    customId,
    user: { id: STAFF, username: "staff" },
    member: { roles: { cache: new Collection([[ADMIN_ROLE, { id: ADMIN_ROLE }]]) } },
    client: { channels: { fetch: vi.fn(async () => null) } },
    fields: { getTextInputValue: () => note },
    reply,
  } as never;
}

/** Preview まで進んで、根拠入力モーダルの customId を取り出す */
async function openNoteModal(
  handleShokanButton: (i: never, s: Services) => Promise<void>,
  services: Services,
  purchaseId: number,
  match: string,
): Promise<string> {
  const detail = vi.fn(async () => undefined);
  await handleShokanButton(press(`shokan:case:${purchaseId}`, detail), services);
  const preId = buttonIds(detail).find((id) => id.startsWith(match))!;
  const preview = vi.fn(async () => undefined);
  await handleShokanButton(press(preId, preview), services);
  const noteBtn = buttonIds(preview).find((id) => id.startsWith("shokan:case-note:"))!;
  const showModal = vi.fn(async () => undefined);
  await handleShokanButton(press(noteBtn, vi.fn(async () => undefined), showModal), services);
  const modal = (showModal.mock.calls.at(-1) as never[])[0] as { data: { custom_id: string } };
  return modal.data.custom_id;
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
    expect(buttonIds(preview).some((id) => id.startsWith("shokan:case-note:no_effect:1:"))).toBe(true);
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

    const { handleShokanModal } = await shokanModule;
    const modalId = await openNoteModal(handleShokanButton, ctx.services, p.id, "shokan:case-pre:no_effect:1:");

    const confirm = vi.fn(async () => undefined);
    await handleShokanModal(submitNote(modalId, "Discord上に痕跡なし", confirm), ctx.services);

    expect(content(confirm)).toContain("返金しました");
    // **根拠が台帳へ残る**
    expect(ctx.shop.operatorResolutions(p.id)[0]!.note).toBe("Discord上に痕跡なし");
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.shop.countUnresolvedCases()).toBe(0);

    // 二度押しても増えない
    const again = vi.fn(async () => undefined);
    await handleShokanModal(submitNote(modalId, "Discord上に痕跡なし", again), ctx.services);
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
    const { handleShokanModal } = await shokanModule;
    const staleModal = await openNoteModal(handleShokanButton, ctx.services, p.id, "shokan:case-pre:no_effect:1:");

    // 別の運営が先に「提供済み」で決着させた
    const q = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: q.token, actor: "other" , note: "運営確認済み" });
    const before = landOf(ctx);

    const confirm = vi.fn(async () => undefined);
    await handleShokanModal(submitNote(staleModal, "念のため返金", confirm), ctx.services);

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
    const { handleShokanModal } = await shokanModule;
    const modalId = await openNoteModal(handleShokanButton, ctx.services, p.id, "shokan:case-pre:still_unknown:");

    const confirm = vi.fn(async () => undefined);
    await handleShokanModal(submitNote(modalId, "Discordが不安定で確認できず", confirm), ctx.services);

    expect(content(confirm)).toContain("判断保留");
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("uncertain");
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });

  it("根拠が空なら確定しない（判断の理由を残さず決着させない）", async () => {
    const { handleShokanButton, handleShokanModal } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const modalId = await openNoteModal(handleShokanButton, ctx.services, p.id, "shokan:case-pre:no_effect:1:");

    const rejected = vi.fn(async () => undefined);
    await handleShokanModal(submitNote(modalId, "   ", rejected), ctx.services);

    expect(content(rejected)).toContain("根拠を入力してください");
    expect(content(rejected)).toContain("何も変更していません");
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.operatorResolutions(p.id)).toHaveLength(0);
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    ctx.db.close();
  });

  it("実UI経由の決着では、根拠が必ず残る", async () => {
    const { handleShokanButton, handleShokanModal } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const modalId = await openNoteModal(handleShokanButton, ctx.services, p.id, "shokan:case-pre:delivered:");

    const confirm = vi.fn(async () => undefined);
    await handleShokanModal(submitNote(modalId, "ロールを目視で確認した", confirm), ctx.services);

    const rows = ctx.shop.operatorResolutions(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).not.toBeNull();
    expect(rows[0]!.note).toBe("ロールを目視で確認した");
    expect(rows[0]!.operator_id).toContain(STAFF);
    ctx.db.close();
  });

  it("購入時の記録が無い旧購入に「もう一度配る」を出さない", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    // 購入時の配送内容が残っていない旧購入
    const legacy = ctx.db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
         VALUES (?, ?, 1, 100, 'active', 'pending') RETURNING id`,
      )
      .pluck()
      .get(ctx.item.id, USER) as number;
    expect(ctx.shop.unresolvedCaseKind(legacy)).toBe("legacy_unknown");

    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${legacy}`, detail), ctx.services);

    const ids = buttonIds(detail);
    // 何を配り直せばよいか証明できないので、その選択肢は出さない
    expect(ids.some((id) => id.startsWith("shokan:case-pre:no_effect:0:"))).toBe(false);
    // 返金と提供済みと保留は出る
    expect(ids.some((id) => id.startsWith("shokan:case-pre:no_effect:1:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("shokan:case-pre:delivered:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("shokan:case-pre:still_unknown:"))).toBe(true);
    // 「あとで再配送できます」と嘘をつかない
    const text = JSON.stringify(payload(detail)?.embeds ?? []);
    expect(text).toContain("もう一度配ることはできません");
    ctx.db.close();
  });

  it("購入時の記録があれば「もう一度配る」を出す", async () => {
    const { handleShokanButton } = await shokanModule;
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);

    const detail = vi.fn(async () => undefined);
    await handleShokanButton(press(`shokan:case:${p.id}`, detail), ctx.services);

    expect(buttonIds(detail).some((id) => id.startsWith("shokan:case-pre:no_effect:0:"))).toBe(true);
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
