import { describe, expect, it, vi } from "vitest";
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
import type { Services } from "../src/services.js";

/**
 * **外部APIへ一度でも投げたら、「無かった」と再確認できるまで claim を解放しない。**
 *
 * `refundable=false` は「今回この場では返金しない」だけで、claim の状態を決める根拠には
 * ならない。解放してしまうと、その場の `deliverOrRefund()` が返金を止めても、あとから
 * 来る手動返金や失効は claim が無いので素通りする。
 */

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
  const originalRoles = new OriginalRoles(db, ledger, events);
  const subAccounts = new SubAccounts(db, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:sticky",
  });
  const services = { db, ledger, events, settings, shop, originalRoles, subAccounts } as unknown as Services;
  return { db, ledger, events, settings, shop, originalRoles, subAccounts, services };
}
type Ctx = ReturnType<typeof setup>;

function makeItem(ctx: Ctx, kind: string, data: Record<string, unknown> = {}) {
  return ctx.shop.createItem(
    {
      name: kind,
      price_land: 100,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: kind,
      delivery_data: JSON.stringify(data),
    } as never,
    STAFF,
  );
}

function buy(ctx: Ctx, itemId: number, request?: Record<string, unknown>) {
  const p = ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;
  if (request) ctx.db.prepare("UPDATE shop_purchases SET request_json=? WHERE id=?").run(JSON.stringify(request), p.id);
  return ctx.shop.getPurchase(p.id)!;
}

const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

/** claim が uncertain のまま残り、返金も失効も通らないことを確かめる */
function expectStickyUncertain(ctx: Ctx, purchaseId: number, before: number) {
  const claim = ctx.shop.externalDeliveryClaim(purchaseId);
  expect(claim?.state).toBe("uncertain");
  expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(1);
  // 手動返金は通らない
  expect(() => ctx.shop.refund(purchaseId, "配送できなかった", STAFF)).toThrow(
    expect.objectContaining({ code: "ERR_DELIVERY_IN_FLIGHT" }),
  );
  // 失効も通らない
  ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);
  expect(ctx.shop.expireIfDue(purchaseId, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });
  expect(ctx.shop.getPurchase(purchaseId)!.status).toBe("active");
  expect(landOf(ctx)).toBe(before);
}

describe("外部副作用の不確実性は sticky", () => {
  it("オリロ: 付与後の activate 競合で、戻せたか確認できなければ claim を残す", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const application = ctx.originalRoles.apply({ userId: USER, name: "オリロ", color: 0x123456, actor: STAFF });
    ctx.originalRoles.approve(application.id, STAFF);
    const item = makeItem(ctx, "create_original_role");
    const p = buy(ctx, item.id, { applicationId: application.id });
    const before = landOf(ctx);

    const held = new Set<string>();
    const role: any = { id: "role-1", name: "オリロ", managed: false, editable: true, createdTimestamp: Date.now() };
    role.edit = vi.fn(async () => role);
    role.delete = vi.fn(async () => undefined);
    const member = {
      id: USER,
      roles: {
        cache: { has: (id: string) => held.has(id), get: (id: string) => (held.has(id) ? role : undefined) },
        add: vi.fn(async (id: string) => void held.add(id)),
        // **外せたか確認できない**（remove が失敗する）
        remove: vi.fn(async () => {
          throw new Error("Missing Permissions");
        }),
      },
    };
    const guild = {
      id: "g1",
      roles: {
        cache: new Map([["role-1", role]]),
        create: vi.fn(async () => role),
        fetch: vi.fn(async () => new Map([["role-1", role]])),
      },
      members: { fetch: vi.fn(async () => member) },
    };

    // **付与のあとで** activate が競合する（別経路が先に確定していた等）。
    // ここだけを差し替える——ロール解決の本物の挙動は残す
    vi.spyOn(ctx.originalRoles, "activate").mockReturnValue(false);

    const outcome = await deliverPurchaseUnlocked(ctx.services, guild as never, p, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.refundable).toBe(false);
    // 付与は実際に起きている
    expect(member.roles.add).toHaveBeenCalled();
    expectStickyUncertain(ctx, p.id, before);
    ctx.db.close();
  });

  it("外部mutationのあとの想定外エラーは、解放せず claim を残す", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const item = makeItem(ctx, "set_nickname");
    const p = buy(ctx, item.id, { nickname: "あたらしい名前" });
    const before = landOf(ctx);

    let nickname: string | null = null;
    const member = {
      id: USER,
      manageable: true,
      get nickname() {
        return nickname;
      },
      setNickname: vi.fn(async (v: string) => {
        nickname = v;
      }),
      roles: { cache: new Map(), highest: { id: "r", position: 1 } },
    };
    const guild = {
      id: "g1",
      ownerId: "someone-else",
      members: {
        me: { permissions: { has: () => true }, roles: { highest: { id: "bot", position: 99 } } },
        fetch: vi.fn(async () => member),
      },
    };
    // **名前を変えたあとのDB確定で想定外の例外を起こす**
    const original = ctx.services.nicknames;
    ctx.services.nicknames = {
      ...original,
      stageRename: () => ({ ok: true, nickname: "あたらしい名前", key: "k" }),
      commitRename: () => {
        throw new Error("unexpected boom");
      },
      abortRename: () => undefined,
    } as never;

    const outcome = await deliverPurchaseUnlocked(ctx.services, guild as never, p, STAFF);

    // 外部の目的状態は変わっている
    expect(nickname).toBe("あたらしい名前");
    expect(outcome.state).toBe("failed");
    // **自動返金へ回さない**
    expect(outcome.refundable).toBe(false);
    expectStickyUncertain(ctx, p.id, before);
    ctx.db.close();
  });

  it("外部APIを一度も呼ぶ前の想定外エラーは、解放して返金できる", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const item = makeItem(ctx, "set_nickname");
    const p = buy(ctx, item.id, { nickname: "あたらしい名前" });
    const before = landOf(ctx);

    const guild = {
      id: "g1",
      ownerId: "someone-else",
      members: {
        me: { permissions: { has: () => true }, roles: { highest: { id: "bot", position: 99 } } },
        fetch: vi.fn(async () => {
          throw new Error("unexpected boom before any mutation");
        }),
      },
    };

    const outcome = await deliverPurchaseUnlocked(ctx.services, guild as never, p, STAFF);

    expect(outcome.state).toBe("failed");
    // 投げていないのだから副作用は無い＝解放してよい
    expect(ctx.shop.externalDeliveryClaim(p.id)).toBeUndefined();
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    expect(ctx.shop.refund(p.id, "配送できなかった", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });
});
