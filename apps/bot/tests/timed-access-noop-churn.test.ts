import { Collection, type Guild, type GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { reconcileTimedAccessForGuild } from "../src/timed-access.js";
import type { Services } from "../src/services.js";

/**
 * **やることが無い巡回は、履歴を1行も作らない。**
 *
 * 鍵の表も事件録も append-only なので、「もう付いているロールを毎回確かめる」だけで
 * 永久に行が積み上がる（本番実測: 12.7時間で lock 2,387行・event 4,774件、
 * うち実際の外部効果は 0）。
 *
 * ただし絞り込みの観測に権限を与えてはいけない。決めてよいのは
 * **「いま試す価値が無い」だけ**で、「投げてよい」は取得後の観測だけが決める。
 * 絞り込みが誤って present に見えても、修復が次の巡回へ遅れるだけで、
 * 誤った外部書き込みは起きない——ここを固定する。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const USER = "1463201396567441441";
const ROLE = "r-vip";
const GUILD = "main-guild";
const KEY = Shop.discordRoleEffectKey(GUILD, USER, ROLE);

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY, to: `user:${USER}`, amount: 1_000_000, type: "adjust",
    actor: "t", approvedBy: "t", idempotencyKey: "seed:churn",
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

function timedAccess(ctx: Ctx, itemId: number, userId = USER): number {
  return ctx.db
    .prepare(
      `INSERT INTO shop_purchases
         (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivery_snapshot_json)
       VALUES (?,?,1,?,100,'active','delivered',?) RETURNING id`,
    )
    .pluck()
    .get(
      itemId,
      userId,
      Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
    ) as number;
}

/**
 * fetch ごとに**その時点のスナップショット**を返す Discord。
 * 1つの可変 Set を共有すると「取得前に見た状態」を再現できない。
 */
function snapshotDiscord(opts: { initial?: string[]; failFetch?: boolean; unknownMember?: boolean } = {}) {
  const authoritative = new Set<string>(opts.initial ?? []);
  const trace: string[] = [];
  const add = vi.fn(async (id: string) => {
    trace.push("add");
    authoritative.add(id);
  });
  const remove = vi.fn(async (id: string) => void authoritative.delete(id));
  const fetch = vi.fn(async () => {
    trace.push("fetch");
    if (opts.unknownMember) {
      const e = new Error("Unknown Member") as Error & { code?: number };
      e.code = 10007;
      throw e;
    }
    if (opts.failFetch) throw new Error("member unavailable");
    const frozen = new Set(authoritative);
    return {
      id: USER,
      roles: {
        cache: Object.assign(new Collection<string, { id: string }>(), { has: (id: string) => frozen.has(id) }),
        add,
        remove,
      },
    } as unknown as GuildMember;
  });
  const guild = { id: GUILD, members: { fetch } } as unknown as Guild;
  return { guild, add, remove, fetch, trace, authoritative, becomePresent: () => authoritative.add(ROLE), becomeAbsent: () => authoritative.delete(ROLE) };
}

const locks = (ctx: Ctx) => ctx.db.prepare("SELECT COUNT(*) FROM shop_external_effect_locks").pluck().get() as number;
const evidence = (ctx: Ctx) => ctx.db.prepare("SELECT COUNT(*) FROM shop_verified_delivery_evidence").pluck().get() as number;
const effectEvents = (ctx: Ctx) =>
  ctx.db.prepare("SELECT COUNT(*) FROM events WHERE type LIKE 'shop_external_effect%'").pluck().get() as number;

// ── N1 既に付いている ────────────────────────────────────────────────────────

describe("N1: 取得前に既にロールが在れば、履歴を1行も作らない", () => {
  it("鍵0 / add0 / 証拠0 / 外部効果event0", async () => {
    const ctx = setup();
    const id = timedAccess(ctx, ctx.mkItem("庭園").id);
    const d = snapshotDiscord({ initial: [ROLE] });

    const result = await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(d.add).not.toHaveBeenCalled();
    expect(locks(ctx)).toBe(0);
    expect(evidence(ctx)).toBe(0);
    expect(effectEvents(ctx)).toBe(0);
    expect(result.restored).toBe(0);
    // 購入の履歴も動かない
    expect(ctx.shop.getPurchase(id)!.delivered_at).toBeNull();
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.verifiedExternal).toBe(false);
    ctx.db.close();
  });

  it("何度巡回しても履歴は増えない", async () => {
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("庭園").id);
    for (let i = 0; i < 10; i += 1) {
      await reconcileTimedAccessForGuild(snapshotDiscord({ initial: [ROLE] }).guild, ctx.services);
    }
    expect(locks(ctx)).toBe(0);
    expect(effectEvents(ctx)).toBe(0);
    ctx.db.close();
  });
});

// ── N2 取得境界で present になる（M6 の恒久回帰）────────────────────────────

describe("N2: 絞り込みでは absent、取得境界で present になる", () => {
  it("鍵は取るが、取得後の観測で present なので投げない", async () => {
    const ctx = setup();
    const id = timedAccess(ctx, ctx.mkItem("庭園").id);
    const d = snapshotDiscord({ initial: [] });

    const realAcquire = ctx.shop.acquireExternalEffectLock.bind(ctx.shop);
    const spy = vi.spyOn(ctx.shop, "acquireExternalEffectLock").mockImplementation((input) => {
      d.trace.push("acquire");
      const r = realAcquire(input);
      d.becomePresent(); // ← 取得の境界で外部が変わった
      return r;
    });

    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    // 鍵は取った（絞り込みでは absent だったので）
    expect(locks(ctx)).toBe(1);
    // **取得後の観測が正本なので投げない**
    expect(d.add).not.toHaveBeenCalled();
    expect(evidence(ctx)).toBe(0);
    // 鍵は終端まで進んでいる（握りっぱなしにしない）
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();
    expect(ctx.shop.safetySnapshot(id)!.contradictions).toEqual([]);
    // 絞り込み → 取得 → 権威ある観測
    expect(d.trace.indexOf("fetch")).toBeLessThan(d.trace.indexOf("acquire"));
    expect(d.trace.lastIndexOf("fetch")).toBeGreaterThan(d.trace.indexOf("acquire"));
    spy.mockRestore();
    ctx.db.close();
  });
});

// ── N3 絞り込みが present、直後に absent（修復は遅れてよい）──────────────────

describe("N3: 絞り込みが present、その直後に消える", () => {
  it("この巡回では何も書かない。次の巡回で安全に復元する", async () => {
    const ctx = setup();
    const id = timedAccess(ctx, ctx.mkItem("庭園").id);

    // 1回目: 絞り込みで present → 何もしない。直後に外部で剥がれる
    const first = snapshotDiscord({ initial: [ROLE] });
    await reconcileTimedAccessForGuild(first.guild, ctx.services);
    first.becomeAbsent();

    expect(first.add).not.toHaveBeenCalled();
    expect(locks(ctx)).toBe(0);
    expect(evidence(ctx)).toBe(0);
    expect(effectEvents(ctx)).toBe(0);
    // 履歴の書き換えも無い
    expect(ctx.shop.getPurchase(id)!.delivery_state).toBe("delivered");
    expect(ctx.shop.getPurchase(id)!.delivered_at).toBeNull();

    // 2回目: 通常の安全な経路で復元される（＝修復が遅れるだけ）
    const second = snapshotDiscord({ initial: [] });
    await reconcileTimedAccessForGuild(second.guild, ctx.services);

    expect(second.add).toHaveBeenCalledTimes(1);
    expect(second.authoritative.has(ROLE)).toBe(true);
    expect(locks(ctx)).toBe(1);
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();
    ctx.db.close();
  });
});

// ── N4 絞り込みの fetch が失敗 ───────────────────────────────────────────────

describe("N4: 絞り込みの観測が取れないとき", () => {
  it("鍵を取らない・証拠なし・投げない・購入は不変", async () => {
    const ctx = setup();
    const id = timedAccess(ctx, ctx.mkItem("庭園").id);
    const before = ctx.shop.getPurchase(id)!;
    const d = snapshotDiscord({ failFetch: true });

    const result = await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(locks(ctx)).toBe(0);
    expect(effectEvents(ctx)).toBe(0);
    expect(evidence(ctx)).toBe(0);
    expect(d.add).not.toHaveBeenCalled();
    const after = ctx.shop.getPurchase(id)!;
    expect(after.status).toBe(before.status);
    expect(after.delivery_state).toBe(before.delivery_state);
    expect(after.delivered_at).toBe(before.delivered_at);
    // 失敗は失敗として運営には見える（黙って捨てない）
    expect(result.failed).toHaveLength(1);
    ctx.db.close();
  });

  it("退会（Unknown Member）でも鍵も履歴も作らない", async () => {
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("庭園").id);
    const d = snapshotDiscord({ unknownMember: true });

    const result = await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(result.absent).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(locks(ctx)).toBe(0);
    expect(effectEvents(ctx)).toBe(0);
    ctx.db.close();
  });
});

// ── N5 本当に無い ───────────────────────────────────────────────────────────

describe("N5: 本当にロールが無いときは、通常どおり復元する", () => {
  it("鍵1 / add1 / 確認あり / 帰属が安全なら証拠", async () => {
    const ctx = setup();
    const id = timedAccess(ctx, ctx.mkItem("庭園").id);
    const d = snapshotDiscord({ initial: [] });

    const result = await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(d.add).toHaveBeenCalledTimes(1);
    expect(d.authoritative.has(ROLE)).toBe(true);
    expect(locks(ctx)).toBe(1);
    expect(result.restored).toBe(1);
    // 帰属が一意で購入時対象も証明できるので証拠が立つ
    expect(evidence(ctx)).toBe(1);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.verifiedExternal).toBe(true);
    // 付与のあとに確認の fetch がある
    expect(d.trace.lastIndexOf("fetch")).toBeGreaterThan(d.trace.indexOf("add"));
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();
    ctx.db.close();
  });
});

// ── N6 絞り込みのあとで別 worker が資源を握っている ─────────────────────────

describe("N6: 絞り込みは absent、しかし取得できない", () => {
  it("投げない・相手の所有権はそのまま・証拠なし", async () => {
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("庭園").id);
    const rival = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "rival-worker",
    });
    expect(rival.ok).toBe(true);

    const d = snapshotDiscord({ initial: [] });
    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(d.add).not.toHaveBeenCalled();
    expect(evidence(ctx)).toBe(0);
    expect(ctx.shop.externalEffectLockHolder(KEY)?.owner).toBe("rival-worker");
    expect(ctx.shop.externalEffectLockHolder(KEY)?.state).toBe("held");
    ctx.db.close();
  });
});

// ── N7 別購入・同一 (user, role) ────────────────────────────────────────────

describe("N7: 同じロールを与える契約が2つでも、外部効果は1回まで", () => {
  it("add は合計1回、帰属が曖昧なので証拠0", async () => {
    const ctx = setup();
    const a = timedAccess(ctx, ctx.mkItem("庭園・月額").id);
    const b = timedAccess(ctx, ctx.mkItem("庭園・特別").id);
    const d = snapshotDiscord({ initial: [] });

    await reconcileTimedAccessForGuild(d.guild, ctx.services);

    expect(d.add).toHaveBeenCalledTimes(1);
    // **どちらへも証拠を付けない**（Task #213 の帰属規則）
    expect(evidence(ctx)).toBe(0);
    expect(ctx.shop.safetySnapshot(a)!.fulfillment.verifiedExternal).toBe(false);
    expect(ctx.shop.safetySnapshot(b)!.fulfillment.verifiedExternal).toBe(false);
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();
    ctx.db.close();
  });

  it("2周目は既に付いているので、履歴が増えない", async () => {
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("庭園・月額").id);
    timedAccess(ctx, ctx.mkItem("庭園・特別").id);
    const first = snapshotDiscord({ initial: [] });
    await reconcileTimedAccessForGuild(first.guild, ctx.services);
    const afterFirst = locks(ctx);

    for (let i = 0; i < 5; i += 1) {
      await reconcileTimedAccessForGuild(snapshotDiscord({ initial: [ROLE] }).guild, ctx.services);
    }
    expect(locks(ctx)).toBe(afterFirst); // 増えていない
    ctx.db.close();
  });
});
