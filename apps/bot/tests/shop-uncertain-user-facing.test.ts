import { describe, expect, it, vi } from "vitest";
import {
  EventLog,
  Ledger,
  Nicknames,
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
 * 利用者から見た「確認中」。
 *
 * 提供できたか分からないだけで「失敗しました。もう一度購入してください」と言わない。
 * 内部のエラーコードも状態名も出さない。**二重購入を誘発しない。**
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const deliveryModule = import("../src/shop-delivery.js");
const USER = "1463201396567441441";
const STAFF = "system:test";
const ROLE = "r-vip";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 5_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:ux",
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
  const services = {
    db,
    ledger,
    events,
    settings: new Settings(db),
    shop,
    nicknames: new Nicknames(db, events),
    originalRoles: new OriginalRoles(db, ledger, events),
    subAccounts: new SubAccounts(db, events),
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

/** roles.add は投げたが、そのあとの確認 fetch が返らない */
function unverifiableGuild() {
  const roles = new Set<string>();
  let fetches = 0;
  const member = {
    id: USER,
    roles: { cache: { has: (id: string) => roles.has(id) }, add: vi.fn(async (id: string) => void roles.add(id)) },
  };
  return {
    guild: {
      id: "g1",
      members: {
        fetch: vi.fn(async () => {
          fetches += 1;
          if (fetches > 1) throw new Error("Service Unavailable");
          return member;
        }),
      },
    },
    roles,
  };
}

describe("確認中のときに利用者へ出す文言", () => {
  it("再購入を促さず、内部のコードも状態名も出さない", async () => {
    const { deliverPurchaseUnlocked, UNCERTAIN_USER_MESSAGE } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const w = unverifiableGuild();

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);

    expect(outcome.state).toBe("failed");
    expect(outcome.message).toBe(UNCERTAIN_USER_MESSAGE);
    // 概念として伝わるべきこと
    expect(outcome.message).toContain("購入は受け付けています");
    expect(outcome.message).toContain("確認しています");
    expect(outcome.message).toContain("重ねて購入する必要はありません");
    // 二重購入を誘発する言い回しを出さない
    for (const bad of ["もう一度購入", "再度購入", "購入し直"]) {
      expect(outcome.message).not.toContain(bad);
    }
    // 内部のコード・状態名・tokenを出さない
    for (const leak of ["ERR_", "uncertain", "in_flight", "claim", "delivery_state", "attempt_token"]) {
      expect(outcome.message).not.toContain(leak);
    }
    ctx.db.close();
  });

  it("確認中は自動返金しない（課金は記録されたまま残る）", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const paid = ctx.ledger.balanceOf(`user:${USER}`);
    const w = unverifiableGuild();

    const outcome = await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);

    expect(outcome.refundable).toBe(false);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(paid);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    ctx.db.close();
  });
});

describe("決着は外部状態を壊さない", () => {
  it("提供なしと確定しても、ロールを剥がしにいかない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx);
    const w = unverifiableGuild();
    await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);
    // 実際にはロールが付いていた（確認できなかっただけ）
    expect(w.roles.has(ROLE)).toBe(true);

    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: "operator:1",
      refund: true,
    });

    // **決着はDiscordを触らない。** 剥がすなら別契約の有無まで確かめる必要があり、
    // それはこの経路の仕事ではない
    expect(w.roles.has(ROLE)).toBe(true);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    ctx.db.close();
  });

  it("同じロールの別契約があっても、決着で権利を失わせない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    // 同じロールを与える別商品の、提供済みの契約
    const other = ctx.shop.createItem(
      {
        name: "別ルート",
        price_land: 100,
        kind: "monthly",
        delivery: "auto",
        delivery_kind: "add_role",
        delivery_data: JSON.stringify({ role_id: ROLE }),
      } as never,
      STAFF,
    );
    const kept = ctx.shop.purchase({
      itemId: other.id,
      userId: USER,
      actor: USER,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(other.id).termsToken,
    }).purchase;
    ctx.shop.beginDelivery(kept.id);
    ctx.shop.markDeliverySucceeded(kept.id, STAFF);

    const p = buy(ctx);
    const w = unverifiableGuild();
    await deliverPurchaseUnlocked(ctx.services, w.guild as never, p, STAFF);

    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: "operator:1",
      refund: true,
    });

    // 別契約の権利はそのまま
    expect(w.roles.has(ROLE)).toBe(true);
    expect(ctx.shop.getPurchase(kept.id)!.delivery_state).toBe("delivered");
    expect(ctx.shop.activeRoleEntitlementState(USER, ROLE, p.id)).toBe("delivered");
    ctx.db.close();
  });

  it("購入後に名前が別の理由で変わっていても、決着で上書きしない", async () => {
    const ctx = setup();
    // 改名の購入を「確認できないまま」にする
    const item = ctx.shop.createItem(
      { name: "改名", price_land: 100, kind: "one_shot", delivery: "auto", delivery_kind: "set_nickname", delivery_data: "{}" } as never,
      STAFF,
    );
    const p = ctx.shop.purchase({
      itemId: item.id,
      userId: USER,
      actor: USER,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
    }).purchase;
    ctx.db.prepare("UPDATE shop_purchases SET request_json=? WHERE id=?").run(JSON.stringify({ nickname: "むかしの名前" }), p.id);
    const claim = ctx.shop.claimExternalDelivery({ purchaseId: p.id, deliveryKind: "set_nickname", actor: "system" });
    ctx.shop.markExternalDeliveryUncertain({
      purchaseId: p.id,
      token: (claim as { token: string }).token,
      reason: "final_fetch_failed",
      actor: "system",
    });

    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: "operator:1",
      refund: true,
    });

    // 決着は購入時スナップショットの名前をDiscordへ書き戻さない
    expect(ctx.events.listByType("nickname_set")).toHaveLength(0);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    ctx.db.close();
  });
});
