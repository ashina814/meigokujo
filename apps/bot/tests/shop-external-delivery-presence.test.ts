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
 * **ロールが付いているかの確認は必ず3状態。**
 *
 * `present` / `absent` / `unknown` を区別しないと、「確認できなかった」が
 * 「付いていない」に倒れる。そのまま `verifiedNoEffect` の根拠にすると、
 * **実際には付いたまま返金する**経路が開く。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const deliveryModule = import("../src/shop-delivery.js");
const USER = "1463201396567441441";
const STAFF = "system:test";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const settings = new Settings(db);
  const shop = new Shop(db, ledger, events);
  const originalRoles = new OriginalRoles(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:presence",
  });
  const services = {
    db,
    ledger,
    events,
    settings,
    shop,
    originalRoles,
    subAccounts: new SubAccounts(db, events),
  } as unknown as Services;
  return { db, ledger, events, shop, originalRoles, services };
}
type Ctx = ReturnType<typeof setup>;

const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);

function paidApplication(ctx: Ctx) {
  const application = ctx.originalRoles.apply({ userId: USER, name: "オリロ", color: 0x123456, actor: STAFF });
  ctx.originalRoles.approve(application.id, STAFF);
  const item = ctx.shop.createItem(
    {
      name: "オリロ作成",
      price_land: 100,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "create_original_role",
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
  ctx.db.prepare("UPDATE shop_purchases SET request_json=? WHERE id=?").run(
    JSON.stringify({ applicationId: application.id }),
    p.id,
  );
  return { applicationId: application.id, purchase: ctx.shop.getPurchase(p.id)! };
}

/**
 * `addBehavior` … roles.add の挙動
 * `presence`    … 付与後の force fetch が返す状態（"present" / "absent" / "unknown"）
 * `removeResolves` … rollback の roles.remove が解決するか
 * `presenceAfterRemove` … rollback 後の force fetch が返す状態
 */
function guildStub(opts: {
  addFails?: boolean;
  presence?: "present" | "absent" | "unknown";
  removeResolves?: boolean;
  presenceAfterRemove?: "present" | "absent" | "unknown";
}) {
  const held = new Set<string>();
  const role: any = { id: "role-1", name: "オリロ", managed: false, editable: true, createdTimestamp: Date.now() };
  role.edit = vi.fn(async () => role);
  role.delete = vi.fn(async () => undefined);
  let removed = false;
  const member = {
    id: USER,
    roles: {
      cache: { has: (id: string) => held.has(id), get: (id: string) => (held.has(id) ? role : undefined) },
      add: vi.fn(async (id: string) => {
        if (opts.addFails) throw new Error("Missing Permissions");
        held.add(id);
      }),
      remove: vi.fn(async () => {
        if (opts.removeResolves === false) throw new Error("Missing Permissions");
        removed = true;
      }),
    },
  };
  const stateFor = () => (removed ? opts.presenceAfterRemove : opts.presence);
  const freshMember = (state: "present" | "absent" | undefined) => ({
    id: USER,
    roles: { cache: { has: (id: string) => state === "present" && id === "role-1" } },
  });
  return {
    guild: {
      id: "g1",
      roles: {
        cache: new Map([["role-1", role]]),
        create: vi.fn(async () => role),
        fetch: vi.fn(async () => new Map([["role-1", role]])),
      },
      members: {
        fetch: vi.fn(async (arg: any) => {
          // force fetch（第2引数付き）は presence 設定に従う。それ以外は素の member
          if (arg && typeof arg === "object" && arg.force) {
            const state = stateFor();
            if (state === "unknown") throw new Error("Service Unavailable");
            return freshMember(state === "present" ? "present" : "absent");
          }
          return member;
        }),
      },
    },
    member,
    role,
    held,
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

describe("付与結果の確認は3状態", () => {
  it("add がエラー＋確認できない → verifiedNoEffect にしない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    const w = guildStub({ addFails: true, presence: "unknown" });

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("role_add_unverified");
    expect(outcome.refundable).toBe(false);
    // 消せたかも分からないロールを消しにいかない
    expect(w.role.delete).not.toHaveBeenCalled();
    expectSticky(ctx, purchase.id, before);
    ctx.db.close();
  });

  it("add がエラーでも、取り直して付いていれば成功側へ進む", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { applicationId, purchase } = paidApplication(ctx);
    const w = guildStub({ addFails: true, presence: "present" });

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, purchase, STAFF);

    expect(outcome.state).toBe("delivered");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
    expect(ctx.originalRoles.get(applicationId)!.status).toBe("active");
    expect(ctx.shop.countUnresolvedExternalDeliveries()).toBe(0);
    ctx.db.close();
  });

  it("add がエラーで、取り直して付いていないと確認できたら解放して返金できる", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    const w = guildStub({ addFails: true, presence: "absent" });

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toContain("role_add_failed");
    expect(ctx.shop.externalDeliveryClaim(purchase.id)).toBeUndefined();
    expect(ctx.shop.refund(purchase.id, "配送できなかった", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });
});

describe("rollback の確認も3状態", () => {
  it("remove が解決しても、取り直せなければ rollback 確定にしない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    // 付与は成功 → activate 競合 → remove は解決するが、確認 fetch が落ちる
    const w = guildStub({ presence: "present", removeResolves: true, presenceAfterRemove: "unknown" });
    vi.spyOn(ctx.originalRoles, "activate").mockReturnValue(false);

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("activate_conflict_rollback_failed");
    expect(outcome.refundable).toBe(false);
    expectSticky(ctx, purchase.id, before);
    ctx.db.close();
  });

  it("remove 後に外れたと確認できたら解放して返金できる", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    const w = guildStub({ presence: "present", removeResolves: true, presenceAfterRemove: "absent" });
    vi.spyOn(ctx.originalRoles, "activate").mockReturnValue(false);

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.error).toBe("activate_conflict");
    expect(ctx.shop.externalDeliveryClaim(purchase.id)).toBeUndefined();
    expect(ctx.shop.refund(purchase.id, "配送できなかった", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });

  it("remove 後もまだ付いていたら uncertain", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const { purchase } = paidApplication(ctx);
    const before = landOf(ctx);
    const w = guildStub({ presence: "present", removeResolves: true, presenceAfterRemove: "present" });
    vi.spyOn(ctx.originalRoles, "activate").mockReturnValue(false);

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, purchase, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.refundable).toBe(false);
    expectSticky(ctx, purchase.id, before);
    ctx.db.close();
  });
});
