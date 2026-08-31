import { Collection, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { reconcileTimedAccessForGuild } from "../src/timed-access.js";
import type { Services } from "../src/services.js";

/**
 * **Race F — 通常配送と期限つきアクセスの巡回が同じ外部効果へ向かう。**
 *
 * 衝突するのは購入ではなく Discord の `(guild, user, role)`。両者が同じ鍵で
 * 調停されていることを、`roles.add` の**呼ばれた回数**で確かめる。
 *
 * 時間待ちは使わない。durable な鍵そのものが順序の証拠になる——
 * 片方が握っていれば、もう片方は必ず何もしない。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const deliveryModule = import("../src/shop-delivery.js");
const USER = "1463201396567441441";
const ROLE = "r-vip";
const GUILD = "main-guild";
const ACTOR = "system:test";
const KEY = Shop.discordRoleEffectKey(GUILD, USER, ROLE);

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY, to: `user:${USER}`, amount: 5_000_000, type: "adjust",
    actor: "t", approvedBy: "t", idempotencyKey: "seed:race",
  });
  const mkItem = (name: string) =>
    shop.createItem(
      {
        name, price_land: 100, kind: "monthly", duration_days: 30,
        delivery: "auto", delivery_kind: "add_role",
        delivery_data: JSON.stringify({ role_id: ROLE }),
      } as never,
      "staff",
    );
  const settings = { getString: vi.fn((k: string) => (k === "guild:main" ? GUILD : undefined)) };
  const services = { db, ledger, events, shop, settings } as unknown as Services;
  return { db, ledger, events, shop, mkItem, services };
}
type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx, itemId: number) =>
  ctx.shop.purchase({
    itemId, userId: USER, actor: `user:${USER}`, memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;

/** 期限つきアクセスの巡回が拾える形（#58 と同じ legacy shape） */
function timedAccessPurchase(ctx: Ctx, itemId: number): number {
  return ctx.db
    .prepare(
      `INSERT INTO shop_purchases
         (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivery_snapshot_json)
       VALUES (?,?,1,?,100,'active','delivered',?) RETURNING id`,
    )
    .pluck()
    .get(
      itemId,
      USER,
      Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
    ) as number;
}

/** 1つの Discord を両方の経路で共有する。`add` の回数が唯一の判定材料 */
function discord(opts: { roles?: string[]; finalFetchFails?: boolean; onAdd?: () => void } = {}) {
  const held = new Set(opts.roles ?? []);
  let fetches = 0;
  const add = vi.fn(async (id: string) => {
    held.add(id);
    opts.onAdd?.();
  });
  const remove = vi.fn(async (id: string) => void held.delete(id));
  const member = {
    id: USER,
    manageable: true,
    nickname: null,
    roles: {
      cache: Object.assign(new Collection<string, { id: string }>(), {
        has: (id: string) => held.has(id),
      }),
      add,
      remove,
    },
  };
  const guild = {
    id: GUILD,
    members: {
      fetch: vi.fn(async () => {
        fetches += 1;
        if (opts.finalFetchFails && fetches > 1) throw new Error("fetch failed");
        return member;
      }),
      me: null,
    },
    roles: { cache: { get: () => ({ id: ROLE, position: 1 }) } },
  } as unknown as Guild;
  return { guild, add, remove, held };
}

const holder = (ctx: Ctx) => ctx.shop.externalEffectLockHolder(KEY);
const evidenceCount = (ctx: Ctx) =>
  ctx.db.prepare("SELECT COUNT(*) FROM shop_verified_delivery_evidence").pluck().get() as number;

// ── F1 / F2 どちらが先に鍵を取っても、投げるのは1人 ─────────────────────────

describe("F1: 通常配送が先に鍵を取る", () => {
  it("巡回は roles.add を1回も呼ばない", async () => {
    const ctx = setup();
    const tid = timedAccessPurchase(ctx, ctx.mkItem("庭園").id);
    // 通常配送が鍵を握っている最中
    const lock = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "system:shop-delivery",
    });
    expect(lock.ok).toBe(true);

    const d = discord();
    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(d.add).not.toHaveBeenCalled();
    expect(evidenceCount(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(tid)!.fulfillment.verifiedExternal).toBe(false);
    // 鍵の所有者は変わっていない
    expect(holder(ctx)?.owner).toBe("system:shop-delivery");
    expect(ctx.shop.safetySnapshot(tid)!.contradictions).toEqual([]);
    ctx.db.close();
  });
});

describe("F2: 巡回が先に鍵を取る", () => {
  it("通常配送は roles.add を1回も呼ばず、勝手に失敗確定もしない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx, ctx.mkItem("裏口").id);
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    // 巡回が鍵を握っている
    const lock = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "system:shop-timed-access",
    });
    expect(lock.ok).toBe(true);

    const d = discord();
    const outcome = await deliverPurchaseUnlocked(ctx.services, d.guild, p, ACTOR);

    expect(d.add).not.toHaveBeenCalled();
    expect(outcome.state).not.toBe("delivered");
    expect(outcome.error).toBe("external_effect_busy");
    // **自動返金へ回さない。** 相手が投げている最中なので結末は分からない
    expect(outcome.refundable).toBe(false);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    // 鍵は相手のもののまま
    expect(holder(ctx)?.owner).toBe("system:shop-timed-access");
    ctx.db.close();
  });

  it("鍵が解放されれば、通常配送は普通に完了する", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx, ctx.mkItem("裏口").id);
    const lock = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "other",
    });
    if (!lock.ok) return;
    const d = discord();
    await deliverPurchaseUnlocked(ctx.services, d.guild, p, ACTOR);
    expect(d.add).not.toHaveBeenCalled();

    ctx.shop.releaseExternalEffectLock({ key: KEY, token: lock.token, reason: "done", actor: "other" });
    const outcome = await deliverPurchaseUnlocked(ctx.services, d.guild, p, ACTOR);

    expect(outcome.state).toBe("delivered");
    expect(d.add).toHaveBeenCalledTimes(1);
    expect(holder(ctx)).toBeUndefined(); // 使い終わった鍵は閉じている
    ctx.db.close();
  });
});

// ── F4 別購入・同じ user/role ────────────────────────────────────────────────

describe("F4: 別購入が同じ (user, role) を指していても、外部効果は1回だけ", () => {
  it("通常配送と巡回が同時に走っても roles.add は合計1回", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    // 別商品なので両方 active でいられる（同一商品は ERR_ALREADY_ACTIVE）
    const normal = buy(ctx, ctx.mkItem("裏口・月額").id);
    const timed = timedAccessPurchase(ctx, ctx.mkItem("裏口・特別").id);

    // 前提: purchase 単位の claim は両方取れてしまう＝purchaseId では守れない
    const d = discord();
    const outcome = await deliverPurchaseUnlocked(ctx.services, d.guild, normal, ACTOR);
    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    // **合計1回。** 通常配送が付けたので、巡回は既に在るものへ何もしない
    expect(d.add).toHaveBeenCalledTimes(1);
    expect(outcome.state).toBe("delivered");

    // 巡回側の購入へは証拠を作らない（Task #213 の帰属規則）
    expect(ctx.shop.verifiedDeliveryEvidence(timed)).toHaveLength(0);
    expect(ctx.shop.safetySnapshot(timed)!.contradictions).toEqual([]);
    // 鍵は残っていない
    expect(holder(ctx)).toBeUndefined();
    ctx.db.close();
  });

  it("巡回が先でも roles.add は合計1回で、帰属は曖昧なので証拠0", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const normal = buy(ctx, ctx.mkItem("裏口・月額").id);
    const timed = timedAccessPurchase(ctx, ctx.mkItem("裏口・特別").id);
    const d = discord();

    await reconcileTimedAccessForGuild(d.guild, ctx.services);
    const outcome = await deliverPurchaseUnlocked(ctx.services, d.guild, normal, ACTOR);

    expect(d.add).toHaveBeenCalledTimes(1);
    // **同じロールを与える契約が2つあるので、どちらへも証拠を付けない**
    expect(evidenceCount(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(timed)!.fulfillment.verifiedExternal).toBe(false);
    expect(outcome.state === "delivered" || outcome.state === "already_delivered").toBe(true);
    expect(holder(ctx)).toBeUndefined();
    ctx.db.close();
  });
});

// ── F8 / F12 ─────────────────────────────────────────────────────────────────

describe("F8: 最後の確認が取れないとき", () => {
  it("鍵は握ったまま残し、証拠は作らない", async () => {
    const ctx = setup();
    const tid = timedAccessPurchase(ctx, ctx.mkItem("庭園").id);
    const d = discord({ finalFetchFails: true });

    const result = await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(result.failed).toHaveLength(1);
    expect(evidenceCount(ctx)).toBe(0);
    // **「失敗だった」と断定しない。** 鍵を残して収束処理と人へ渡す
    expect(holder(ctx)?.state).toBe("uncertain");
    expect(ctx.shop.safetySnapshot(tid)!.fulfillment.verifiedExternal).toBe(false);
    ctx.db.close();
  });

  it("結果が分からないあいだ、別の worker は投げられない", async () => {
    const ctx = setup();
    timedAccessPurchase(ctx, ctx.mkItem("庭園").id);
    await reconcileTimedAccessForGuild(discord({ finalFetchFails: true }).guild, ctx.services);
    expect(holder(ctx)?.state).toBe("uncertain");

    const second = discord();
    await reconcileTimedAccessForGuild(second.guild, ctx.services);
    expect(second.add).not.toHaveBeenCalled();
    ctx.db.close();
  });
});

describe("F12: 鍵を取ったらロールが既に在った", () => {
  it("投げないし、証拠も作らない。鍵は閉じる", async () => {
    const ctx = setup();
    const tid = timedAccessPurchase(ctx, ctx.mkItem("庭園").id);
    const d = discord({ roles: [ROLE] });

    const result = await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(d.add).not.toHaveBeenCalled();
    expect(result.restored).toBe(0);
    // **ロールの起源を証明していない**ので提供済みにしない（Task #213）
    expect(evidenceCount(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(tid)!.fulfillment.verifiedExternal).toBe(false);
    // 鍵は握りっぱなしにしない（次の処理を止めてしまう）
    expect(holder(ctx)).toBeUndefined();
    ctx.db.close();
  });
});

// ── F5 / F7 落ちたあと ───────────────────────────────────────────────────────

describe("F5 / F7: 落ちた worker の鍵が残っているとき", () => {
  it("巡回も通常配送も、その効果へは投げない", async () => {
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const ctx = setup();
    const p = buy(ctx, ctx.mkItem("裏口").id);
    timedAccessPurchase(ctx, ctx.mkItem("庭園").id);
    // 落ちたプロセスが held のまま残した
    ctx.shop.acquireExternalEffectLock({ scope: "discord_role", key: KEY, operation: "add", owner: "crashed-worker" });

    const d = discord();
    await reconcileTimedAccessForGuild(d.guild, ctx.services);
    const outcome = await deliverPurchaseUnlocked(ctx.services, d.guild, p, ACTOR);

    expect(d.add).not.toHaveBeenCalled();
    expect(outcome.error).toBe("external_effect_busy");
    expect(ctx.shop.listUnresolvedExternalEffectLocks()).toHaveLength(1);
    ctx.db.close();
  });

  it("収束処理が Discord の実状態で閉じれば、通常へ戻る", async () => {
    const { convergeExternalEffectLocks } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    const p = buy(ctx, ctx.mkItem("裏口").id);
    ctx.shop.acquireExternalEffectLock({ scope: "discord_role", key: KEY, operation: "add", owner: "crashed-worker" });

    // ロールは付いていない＝副作用は残っていないと実物で確認できる
    const d = discord();
    const client = { guilds: { fetch: vi.fn(async () => d.guild) } };

    // **稼働中の定期収束は held を触らない。** 所有者がまだ実行中かもしれない
    await convergeExternalEffectLocks(client as never, ctx.services);
    expect(ctx.shop.listUnresolvedExternalEffectLocks()).toHaveLength(1);

    // 再起動直後の境界でだけ収束できる
    await convergeExternalEffectLocks(client as never, ctx.services, { includeHeld: true });
    expect(ctx.shop.listUnresolvedExternalEffectLocks()).toHaveLength(0);
    const { deliverPurchaseUnlocked } = await deliveryModule;
    const outcome = await deliverPurchaseUnlocked(ctx.services, d.guild, p, ACTOR);
    expect(outcome.state).toBe("delivered");
    expect(d.add).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });

  it("RF-A: 稼働中の定期収束は、生きている held を奪わない", async () => {
    const { convergeExternalEffectLocks } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    const lock = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "live-worker",
    });
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    const d = discord();
    const client = { guilds: { fetch: vi.fn(async () => d.guild) } };
    await convergeExternalEffectLocks(client as never, ctx.services);

    // 所有者もトークンもそのまま。別 worker はまだ取れない
    const after = holder(ctx)!;
    expect(after.state).toBe("held");
    expect(after.owner).toBe("live-worker");
    expect(after.owner_token).toBe(lock.token);
    expect(
      ctx.shop.acquireExternalEffectLock({
        scope: "discord_role", key: KEY, operation: "add", owner: "rival",
      }).ok,
    ).toBe(false);
    ctx.db.close();
  });

  it("収束は時間では消さない — 確かめられなければ残す", async () => {
    const { convergeExternalEffectLocks } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    ctx.shop.acquireExternalEffectLock({ scope: "discord_role", key: KEY, operation: "add", owner: "crashed-worker" });

    // member が取れない＝実状態を確認できない
    const guild = {
      id: GUILD,
      members: { fetch: vi.fn(async () => { throw new Error("unavailable"); }) },
    } as unknown as Guild;
    const client = { guilds: { fetch: vi.fn(async () => guild) } };
    await convergeExternalEffectLocks(client as never, ctx.services);

    // **分からないものは分からないまま残す**
    expect(ctx.shop.listUnresolvedExternalEffectLocks()).toHaveLength(1);
    ctx.db.close();
  });
});
