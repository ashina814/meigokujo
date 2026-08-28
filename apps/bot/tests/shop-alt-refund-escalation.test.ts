import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { EventLog, Ledger, Settings, Shop, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 代替支払を含む購入は、配送に失敗しても**自動で「返金済み」にしない**。
 *
 * 招待などの資源を generic refund は戻せない（何をどこへ戻すのかを知らない）。
 * それでも `status='refunded'` を書くと、戻していないのに返金完了という記録が残る。
 * ここでは実際の `deliverOrRefund()` を通して、人へ回ること・購入が有効なまま
 * 残ることを固定する。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const refundModule = import("../src/shop-refund.js");
const USER = "1463201396567441441";
const VIP = "r-vip";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  const services = { db, ledger, settings, events, shop } as unknown as Services;
  const item = shop.createItem(
    {
      name: "招待で買われた特別ロール",
      price_land: 500_000,
      price_alt_kind: "invite",
      price_alt_amount: 3,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: VIP }),
    },
    "test",
  );
  return { db, ledger, settings, events, shop, services, item };
}

type Ctx = ReturnType<typeof setup>;

/**
 * 旧実装が残した alt-paid の購入行。本番にも実在する形（招待は消費されていない）。
 * いまのCoreはこの形の購入を新しく作れないので、履歴として直接置く。
 */
function historicalAltPurchase(ctx: Ctx) {
  const info = ctx.db
    .prepare(
      "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,paid_alt_kind,paid_alt_amount,status,auto_renew)" +
        " VALUES (?,?,?,NULL,'invite',3,'active',0)",
    )
    .run(ctx.item.id, USER, 1_700_000_000);
  return ctx.shop.getPurchase(Number(info.lastInsertRowid))!;
}

/** ロール付与が必ず失敗する世界。通知先チャンネルは無い（外部要因でテストを揺らさない） */
function failingWorld() {
  const member = {
    id: USER,
    roles: {
      cache: new Collection<string, { id: string }>(),
      add: vi.fn(async () => {
        throw new Error("Missing Permissions");
      }),
      remove: vi.fn(async () => undefined),
    },
  };
  const guild = {
    id: "g1",
    members: { fetch: vi.fn(async () => member), me: { roles: { highest: { position: 99 } } } },
    roles: { cache: new Collection([[VIP, { id: VIP, position: 1 }]]) },
  };
  const client = {
    guilds: { fetch: vi.fn(async () => guild) },
    users: { fetch: vi.fn(async () => ({ send: vi.fn(async () => undefined) })) },
    channels: { fetch: vi.fn(async () => null) },
  };
  return { member, guild, client };
}

describe("代替支払を含む購入の配送失敗", () => {
  it("自動返金せず人へ回す（購入は有効なまま・資産も動かさない）", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    const purchase = historicalAltPurchase(ctx);
    const world = failingWorld();
    const landBefore = ctx.ledger.balanceOf(`user:${USER}`);

    const settled = await deliverOrRefund(
      world.client as never,
      ctx.services,
      world.guild as never,
      purchase,
      "system:test",
    );

    expect(settled.outcome.state).toBe("failed");
    // **ここが本体。** 返金済みにせず、人の判断へ回す
    expect(settled.refund).toBe("escalated");

    const after = ctx.shop.getPurchase(purchase.id)!;
    expect(after.status).toBe("active");
    expect(after.status).not.toBe("refunded");
    expect(after.refunded_at ?? null).toBeNull();
    // Landは元々払っていない。勝手に「返金」として増やさない
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(landBefore);
    // 招待も戻していない（戻せないので触らないのが正しい）
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 0 });
    ctx.db.close();
  });

  it("Landで払った購入は今までどおり自動で返る（上の停止が全部を止めていない）", async () => {
    const { deliverOrRefund } = await refundModule;
    const ctx = setup();
    ctx.ledger.ensureAccount(`user:${USER}`, "user");
    ctx.ledger.transfer({
      from: "sys:treasury",
      to: `user:${USER}`,
      amount: 1_000_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed:alt-refund",
    });
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const bought = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
    });
    const world = failingWorld();

    const settled = await deliverOrRefund(
      world.client as never,
      ctx.services,
      world.guild as never,
      bought.purchase,
      "system:test",
    );

    expect(settled.refund).toBe("refunded");
    expect(ctx.shop.getPurchase(bought.purchase.id)!.status).toBe("refunded");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    ctx.db.close();
  });
});
