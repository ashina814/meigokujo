import { describe, expect, it, vi } from "vitest";

/**
 * サブ垢の有効化も、**階級ロールを触ったあとは sticky**。
 *
 * 開始前の状態へ戻せたと確認できたときだけ「副作用なし」と言える。
 * 確認できないまま claim を解放すると、あとから来る手動返金や失効が素通りする。
 */

vi.mock("../src/sub-account-rank.js", () => ({
  currentLadderRoles: vi.fn(() => []),
  missingLadderRoleKeys: vi.fn(() => []),
  reconcileAltRank: vi.fn(),
  restoreAltRank: vi.fn(),
}));

import {
  EventLog,
  Ledger,
  OriginalRoles,
  Settings,
  Shop,
  SubAccounts,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { reconcileAltRank, restoreAltRank } from "../src/sub-account-rank.js";
import type { Services } from "../src/services.js";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const deliveryModule = import("../src/shop-delivery.js");
const USER = "1463201396567441441";
const ALT = "1463201396567441442";
const STAFF = "system:test";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const settings = new Settings(db);
  const shop = new Shop(db, ledger, events);
  const subAccounts = new SubAccounts(db, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:sticky-sub",
  });
  const services = {
    db,
    ledger,
    events,
    settings,
    shop,
    subAccounts,
    originalRoles: new OriginalRoles(db, ledger, events),
    // 本体の階級が確認できる状態にしておく（ここは今回の検証対象ではない）
    entry: { getSoul: () => ({ user_id: USER, status: "ghost" }) },
  } as unknown as Services;
  return { db, ledger, events, settings, shop, subAccounts, services };
}
type Ctx = ReturnType<typeof setup>;

const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

/** 承認済みのサブ垢申請と、その有効化purchase を用意する */
function paidApplication(ctx: Ctx) {
  const application = ctx.db
    .prepare(
      `INSERT INTO sub_accounts (main_user_id, alt_user_id, status, created_at, updated_at)
       VALUES (?,?, 'approved', 0, 0) RETURNING id`,
    )
    .pluck()
    .get(USER, ALT) as number;
  const item = ctx.shop.createItem(
    {
      name: "サブ垢有効化",
      price_land: 100,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "activate_sub_account",
      delivery_data: "{}",
    } as never,
    STAFF,
  );
  const p = ctx.shop.purchase({
    itemId: item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
  }).purchase;
  ctx.db.prepare("UPDATE shop_purchases SET request_json=? WHERE id=?").run(JSON.stringify({ applicationId: application }), p.id);
  return { applicationId: application, purchase: ctx.shop.getPurchase(p.id)! };
}

function guildStub() {
  const altMember = { id: ALT, roles: { cache: new Map() } };
  const mainMember = { id: USER, roles: { cache: new Map() } };
  return {
    id: "g1",
    roles: { cache: new Map() },
    members: {
      fetch: vi.fn(async (arg: any) => {
        const id = typeof arg === "string" ? arg : arg?.user;
        return id === ALT ? altMember : mainMember;
      }),
    },
  };
}

function expectSticky(ctx: Ctx, purchaseId: number, before: number) {
  expect(ctx.shop.externalDeliveryClaim(purchaseId)?.state).toBe("uncertain");
  expect(() => ctx.shop.refund(purchaseId, "配送できなかった", STAFF)).toThrow(
    expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
  );
  ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);
  expect(ctx.shop.expireIfDue(purchaseId, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });
  expect(ctx.shop.getPurchase(purchaseId)!.status).toBe("active");
  expect(landOf(ctx)).toBe(before);
}

describe("サブ垢: 階級ロールを触ったあとの不確実性", () => {
  it("階級同期に失敗し、戻せたか確認できなければ claim を残す", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    // 変更を始めたあとに失敗し、**戻せたか確認できない**
    vi.mocked(reconcileAltRank).mockResolvedValue({ ok: false, reason: "role_add_failed", restored: false } as never);

    const outcome = await deliverPurchaseUnlocked(ctx.services, guildStub() as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.refundable).toBe(false);
    expectSticky(ctx, purchase.id, before);
    ctx.db.close();
  });

  it("戻せたと確認できたなら claim を解放して返金できる", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    vi.mocked(reconcileAltRank).mockResolvedValue({ ok: false, reason: "role_add_failed", restored: true } as never);

    const outcome = await deliverPurchaseUnlocked(ctx.services, guildStub() as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.refundable).toBe(true);
    expect(ctx.shop.externalDeliveryClaim(purchase.id)).toBeUndefined();
    expect(ctx.shop.refund(purchase.id, "配送できなかった", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });

  it("activate 競合のあと、戻せたか確認できなければ claim を残す", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    vi.mocked(reconcileAltRank).mockResolvedValue({ ok: true } as never);
    // activate が競合し、階級を戻せたか確認できない
    vi.spyOn(ctx.subAccounts, "activate").mockReturnValue(false);
    vi.mocked(restoreAltRank).mockResolvedValue(false as never);

    const outcome = await deliverPurchaseUnlocked(ctx.services, guildStub() as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.refundable).toBe(false);
    expectSticky(ctx, purchase.id, before);
    ctx.db.close();
  });

  it("activate 競合でも、戻せたと確認できたなら解放して返金できる", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    vi.mocked(reconcileAltRank).mockResolvedValue({ ok: true } as never);
    vi.spyOn(ctx.subAccounts, "activate").mockReturnValue(false);
    vi.mocked(restoreAltRank).mockResolvedValue(true as never);

    const outcome = await deliverPurchaseUnlocked(ctx.services, guildStub() as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(ctx.shop.externalDeliveryClaim(purchase.id)).toBeUndefined();
    expect(ctx.shop.refund(purchase.id, "配送できなかった", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });
});
