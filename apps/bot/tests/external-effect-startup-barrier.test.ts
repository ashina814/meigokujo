import { Collection, type Guild } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { reconcileTimedAccessForGuild } from "../src/timed-access.js";
import { processShopRoleRevocations, convergeExternalEffectLocks } from "../src/scheduler-recovery.js";
import { __setExternalEffectBarrierForTest } from "../src/external-effect-barrier.js";
import type { Services } from "../src/services.js";

/**
 * **このプロセスは、自分の起動時収束を追い越さない。**
 *
 * 前のプロセスが残した `held` を収束できるのは再起動直後だけ。その収束が終わる前に
 * 新しい worker が同じ資源を取りにいくと、「前のプロセスは死んでいて、新しい worker は
 * まだ動いていない」という収束の前提が崩れる。
 *
 * 時間では証明しない。関門を deferred Promise にして、**解決させるまで**新しい
 * worker が1つも外部効果へ触れないことを見る。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const USER = "1463201396567441441";
const ROLE = "r-vip";
const ROLE_B = "r-other";
const GUILD = "main-guild";
const KEY = Shop.discordRoleEffectKey(GUILD, USER, ROLE);
const KEY_B = Shop.discordRoleEffectKey(GUILD, USER, ROLE_B);

afterEach(() => __setExternalEffectBarrierForTest(null));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY, to: `user:${USER}`, amount: 5_000_000, type: "adjust",
    actor: "t", approvedBy: "t", idempotencyKey: "seed:barrier",
  });
  const mkItem = (name: string, roleId: string) =>
    shop.createItem(
      {
        name, price_land: 100, kind: "monthly", duration_days: 30,
        delivery: "auto", delivery_kind: "add_role",
        delivery_data: JSON.stringify({ role_id: roleId }),
      } as never,
      "staff",
    );
  const settings = { getString: vi.fn((k: string) => (k === "guild:main" ? GUILD : undefined)) };
  const services = { db, ledger, events, shop, settings } as unknown as Services;
  return { db, ledger, events, shop, mkItem, services };
}
type Ctx = ReturnType<typeof setup>;

/** 期限つきアクセスの巡回が拾える契約 */
function timedAccess(ctx: Ctx, itemId: number, roleId: string): number {
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
      JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: roleId } }),
    ) as number;
}

function discord(opts: { roles?: string[]; memberFetchFails?: boolean } = {}) {
  const held = new Set(opts.roles ?? []);
  const add = vi.fn(async (id: string) => void held.add(id));
  const remove = vi.fn(async (id: string) => void held.delete(id));
  const member = {
    id: USER,
    roles: {
      cache: Object.assign(new Collection<string, { id: string }>(), { has: (id: string) => held.has(id) }),
      add,
      remove,
    },
  };
  const guild = {
    id: GUILD,
    members: {
      fetch: vi.fn(async () => {
        if (opts.memberFetchFails) throw new Error("member unavailable");
        return member;
      }),
    },
  } as unknown as Guild;
  return { guild, add, remove, held, client: { guilds: { fetch: vi.fn(async () => guild) } } };
}

// ── RF-H 起動時収束 vs 新しい worker ────────────────────────────────────────

describe("RF-H: 起動時収束が終わるまで、新しい worker は外部効果へ触れない", () => {
  it("巡回は関門が開くまで roles.add を投げない", async () => {
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("庭園", ROLE).id, ROLE);
    const gate = deferred();
    __setExternalEffectBarrierForTest(gate.promise);

    const d = discord();
    let finished = false;
    const run = reconcileTimedAccessForGuild(d.guild, ctx.services).then(() => void (finished = true));

    // 関門が開くまでは Discord を1回も触っていない
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(d.add).not.toHaveBeenCalled();
    expect(d.guild.members.fetch).not.toHaveBeenCalled();

    gate.resolve();
    await run;
    expect(finished).toBe(true);
    expect(d.add).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });

  it("剥奪も関門を待つ", async () => {
    const ctx = setup();
    const gate = deferred();
    __setExternalEffectBarrierForTest(gate.promise);

    const d = discord({ roles: [ROLE] });
    let finished = false;
    const run = processShopRoleRevocations(d.client as never, ctx.services).then(() => void (finished = true));

    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(d.remove).not.toHaveBeenCalled();

    gate.resolve();
    await run;
    expect(finished).toBe(true);
    ctx.db.close();
  });

  it("引き継いだ held は、関門が開く前に別 worker へ奪われない", async () => {
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("庭園", ROLE).id, ROLE);
    // 前のプロセスが残した held
    const inherited = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "previous-process",
    });
    expect(inherited.ok).toBe(true);

    const gate = deferred();
    __setExternalEffectBarrierForTest(gate.promise);
    const d = discord();
    const run = reconcileTimedAccessForGuild(d.guild, ctx.services);

    await Promise.resolve();
    // 関門の手前で止まっている。所有者は前のプロセスのまま
    expect(ctx.shop.externalEffectLockHolder(KEY)?.owner).toBe("previous-process");

    // 起動時収束が実状態（ロール不在）で解決した
    await convergeExternalEffectLocks(d.client as never, ctx.services, { includeHeld: true });
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();

    gate.resolve();
    await run;
    // 収束が済んだあとで初めて、新しい worker が取って投げられる
    expect(d.add).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });
});

// ── RF-I 収束できなかった資源だけが塞がる ───────────────────────────────────

describe("RF-I: 収束できなくても、塞がるのはその資源だけ", () => {
  it("Discord が見えないと held は残り、その資源への取得は拒まれ続ける", async () => {
    const ctx = setup();
    ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "previous-process",
    });

    const blind = discord({ memberFetchFails: true });
    await convergeExternalEffectLocks(blind.client as never, ctx.services, { includeHeld: true });

    // **勝手に解放しない。** 分からないものは分からないまま
    expect(ctx.shop.externalEffectLockHolder(KEY)?.owner).toBe("previous-process");
    expect(
      ctx.shop.acquireExternalEffectLock({
        scope: "discord_role", key: KEY, operation: "add", owner: "new-worker",
      }).ok,
    ).toBe(false);
    ctx.db.close();
  });

  it("別の資源は巻き添えにならない", async () => {
    const ctx = setup();
    ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "previous-process",
    });
    const blind = discord({ memberFetchFails: true });
    await convergeExternalEffectLocks(blind.client as never, ctx.services, { includeHeld: true });

    // 資源 B は誰も持っていないので普通に取れる
    expect(
      ctx.shop.acquireExternalEffectLock({
        scope: "discord_role", key: KEY_B, operation: "add", owner: "new-worker",
      }).ok,
    ).toBe(true);
    // A は塞がれたまま。鍵を捏造も削除もしていない
    expect(ctx.shop.externalEffectLockHolder(KEY)?.state).toBe("held");
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_external_effect_locks").pluck().get(),
    ).toBe(2);
    ctx.db.close();
  });

  it("関門は収束の失敗では閉じたままにならない", async () => {
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("別区画", ROLE_B).id, ROLE_B);
    // 収束が失敗しても関門は開く（プロセス全体は動ける）
    const { beginExternalEffectStartup, awaitExternalEffectReady } = await import(
      "../src/external-effect-barrier.js"
    );
    beginExternalEffectStartup(() => Promise.reject(new Error("discord unavailable")));
    await expect(awaitExternalEffectReady()).resolves.toBeUndefined();

    // 塞ぐのはDB側の実行権だけ
    const d = discord();
    await reconcileTimedAccessForGuild(d.guild, ctx.services);
    expect(d.add).toHaveBeenCalledWith(ROLE_B, expect.any(String));
    ctx.db.close();
  });
});

// ── M22: 起動時の配線が本当に関門になっているか ─────────────────────────────

describe("起動時の配線は、収束が終わるまで関門を閉じたままにする", () => {
  /**
   * **投げっぱなしにすると、この関門は無いのと同じ。**
   *
   * `armExternalEffectStartupRecovery()` は収束の Promise を関門へ結びつける。
   * ここを `void` にしてしまうと `awaitExternalEffectReady()` が即座に通り、
   * 収束の途中で新しい worker が走り出せる。
   *
   * 収束を「まだ返さない guild fetch」で止め、その間 `awaitExternalEffectReady()` が
   * 解決しないことを見る。時間待ちは使わない。
   */
  it("収束が終わるまで awaitExternalEffectReady は解決しない", async () => {
    const { armExternalEffectStartupRecovery } = await import("../src/scheduler-recovery.js");
    const { awaitExternalEffectReady } = await import("../src/external-effect-barrier.js");
    const ctx = setup();
    ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "previous-process",
    });

    // guild の取得を保留させて、収束を途中で止める
    const gate = deferred();
    const d = discord();
    const client = {
      guilds: {
        fetch: vi.fn(async () => {
          await gate.promise;
          return d.guild;
        }),
      },
    };

    armExternalEffectStartupRecovery(client as never, ctx.services);

    let opened = false;
    void awaitExternalEffectReady().then(() => void (opened = true));

    // 収束が止まっている間は関門も閉じたまま
    await Promise.resolve();
    await Promise.resolve();
    expect(opened).toBe(false);
    // 引き継いだ held もまだ残っている
    expect(ctx.shop.externalEffectLockHolder(KEY)?.owner).toBe("previous-process");

    gate.resolve();
    await awaitExternalEffectReady();
    expect(opened).toBe(true);
    // 収束が済んで、実状態（ロール不在）から解放されている
    expect(ctx.shop.externalEffectLockHolder(KEY)).toBeUndefined();
    ctx.db.close();
  });

  it("収束が終わるまで、巡回は外部効果へ触れない", async () => {
    const { armExternalEffectStartupRecovery } = await import("../src/scheduler-recovery.js");
    const ctx = setup();
    timedAccess(ctx, ctx.mkItem("庭園", ROLE).id, ROLE);

    const gate = deferred();
    const d = discord();
    const client = {
      guilds: {
        fetch: vi.fn(async () => {
          await gate.promise;
          return d.guild;
        }),
      },
    };
    armExternalEffectStartupRecovery(client as never, ctx.services);

    let done = false;
    const run = reconcileTimedAccessForGuild(d.guild, ctx.services).then(() => void (done = true));

    await Promise.resolve();
    await Promise.resolve();
    // **起動時収束を追い越していない**
    expect(done).toBe(false);
    expect(d.add).not.toHaveBeenCalled();

    gate.resolve();
    await run;
    expect(done).toBe(true);
    expect(d.add).toHaveBeenCalledTimes(1);
    ctx.db.close();
  });
});

// ── §7 定期経路は held へ到達できない ───────────────────────────────────────

describe("定期収束は held へ到達できない", () => {
  it("held のキーを渡しても、定期経路では触れない", async () => {
    const ctx = setup();
    const lock = ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "live-worker",
    });
    expect(lock.ok).toBe(true);

    const d = discord();
    // 定期経路（includeHeld なし）
    await convergeExternalEffectLocks(d.client as never, ctx.services);
    expect(ctx.shop.externalEffectLockHolder(KEY)?.owner).toBe("live-worker");

    // Core の guard も直接叩いて確かめる（呼び出し側が鍵を知っていても通らない）
    expect(ctx.shop.recoverExternalEffectLock({ key: KEY, observed: "absent", actor: "attacker" })).toBe(false);
    expect(ctx.shop.externalEffectLockHolder(KEY)?.state).toBe("held");
    ctx.db.close();
  });
});
