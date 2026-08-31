import { Collection, type Guild } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { processShopRoleRevocations } from "../src/scheduler-recovery.js";
import type { Services } from "../src/services.js";

/**
 * **剥奪も、その巻き戻しも、同じ資源の critical section の中で行う。**
 *
 * 剥がしてから鍵を閉じ、そのあとで補償の `roles.add()` を投げる形だと、
 * 閉じてから投げるまでの隙に別 worker が資源を取れてしまう。
 * 資源の遷移が終わるまで所有権を手放さない。
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
    from: TREASURY, to: `user:${USER}`, amount: 5_000_000, type: "adjust",
    actor: "t", approvedBy: "t", idempotencyKey: "seed:rev",
  });
  const item = shop.createItem(
    {
      name: "庭園", price_land: 100, kind: "monthly", duration_days: 30,
      delivery: "auto", delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE }),
    } as never,
    "staff",
  );
  const settings = { getString: vi.fn((k: string) => (k === "guild:main" ? GUILD : undefined)) };
  const services = { db, ledger, events, shop, settings } as unknown as Services;
  return { db, ledger, events, shop, item, services };
}
type Ctx = ReturnType<typeof setup>;

/** 失効済みの購入＋剥奪キュー行（購入時スナップショットで対象が証明できる形） */
function expiredWithRevocation(ctx: Ctx): number {
  const id = ctx.db
    .prepare(
      `INSERT INTO shop_purchases
         (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivered_at,delivery_snapshot_json)
       VALUES (?,?,1,1,100,'expired','delivered',100,?) RETURNING id`,
    )
    .pluck()
    .get(
      ctx.item.id,
      USER,
      JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
    ) as number;
  ctx.db
    .prepare(
      `INSERT INTO shop_role_revocations
         (purchase_id,user_id,role_id,status,attempts,last_error,created_at,updated_at,completed_at)
       VALUES (?,?,?,'pending',0,NULL,1,1,NULL)`,
    )
    .run(id, USER, ROLE);
  return id;
}

function discord(
  opts: {
    roles?: string[];
    removeFails?: boolean;
    finalFetchFails?: boolean;
    onRemove?: () => void;
    onAdd?: () => void;
  } = {},
) {
  const held = new Set(opts.roles ?? [ROLE]);
  let fetches = 0;
  const add = vi.fn(async (id: string) => {
    opts.onAdd?.();
    held.add(id);
  });
  const remove = vi.fn(async (id: string) => {
    opts.onRemove?.();
    if (opts.removeFails) throw new Error("remove failed");
    held.delete(id);
  });
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
        fetches += 1;
        if (opts.finalFetchFails && fetches > 1) throw new Error("fetch failed");
        return member;
      }),
    },
  } as unknown as Guild;
  return { guild, add, remove, held, client: { guilds: { fetch: vi.fn(async () => guild) } } };
}

const holder = (ctx: Ctx) => ctx.shop.externalEffectLockHolder(KEY);
const revocation = (ctx: Ctx, id: number) =>
  ctx.db.prepare("SELECT status FROM shop_role_revocations WHERE purchase_id=?").get(id) as { status: string };

// ── RF-D 別の所有者がいれば剥がさない ───────────────────────────────────────

describe("RF-D: 誰かが資源を持っていれば剥奪しない", () => {
  it("add の所有者がいるあいだ roles.remove は呼ばれない", async () => {
    const ctx = setup();
    const id = expiredWithRevocation(ctx);
    ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "system:shop-timed-access",
    });

    const d = discord();
    await processShopRoleRevocations(d.client as never, ctx.services);

    expect(d.remove).not.toHaveBeenCalled();
    expect(d.add).not.toHaveBeenCalled();
    // 所有者は変わらず、剥奪は保留のまま（失敗ではない）
    expect(holder(ctx)?.owner).toBe("system:shop-timed-access");
    expect(revocation(ctx, id).status).toBe("pending");
    ctx.db.close();
  });
});

// ── RF-E 補償は同じ所有権の中で行う ─────────────────────────────────────────

describe("RF-E: 剥がした直後に契約が生えても、補償は同じ鍵の中", () => {
  it("補償の add の最中に別 worker は資源を取れない", async () => {
    const ctx = setup();
    const id = expiredWithRevocation(ctx);
    let ownerDuringCompensation: string | undefined;
    let rivalCouldAcquire: boolean | undefined;
    let ownerDuringAdd: string | undefined;
    let rivalCouldAcquireDuringAdd: boolean | undefined;

    // roles.remove の最中に、同じロールを与える有効な契約が生える
    const d = discord({
      onRemove: () => {
        const live = ctx.db
          .prepare(
            `INSERT INTO shop_purchases
               (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivered_at,delivery_snapshot_json)
             VALUES (?,?,1,?,100,'active','delivered',100,?) RETURNING id`,
          )
          .pluck()
          .get(
            ctx.item.id,
            USER,
            Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
            JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
          ) as number;
        void live;
        // このタイミングで別 worker が割り込もうとする
        ownerDuringCompensation = holder(ctx)?.owner;
        rivalCouldAcquire = ctx.shop.acquireExternalEffectLock({
          scope: "discord_role", key: KEY, operation: "add", owner: "rival",
        }).ok;
      },
      // **補償の add の最中**に横取りを試す。ここが M19 の境界
      onAdd: () => {
        ownerDuringAdd = holder(ctx)?.owner;
        rivalCouldAcquireDuringAdd = ctx.shop.acquireExternalEffectLock({
          scope: "discord_role", key: KEY, operation: "add", owner: "rival-during-add",
        }).ok;
      },
    });

    await processShopRoleRevocations(d.client as never, ctx.services);

    // 剥奪 worker が資源を握ったまま補償している
    expect(ownerDuringCompensation).toBe("system:shop-role-revocation");
    expect(rivalCouldAcquire).toBe(false);
    // **補償の add を投げている最中も握っている。** 剥がしたあとに閉じてから
    // 戻すと、その隙に別 worker が資源を取れてしまう
    expect(ownerDuringAdd).toBe("system:shop-role-revocation");
    expect(rivalCouldAcquireDuringAdd).toBe(false);
    // 剥がして、戻した（どちらも同じ所有権の中）
    expect(d.remove).toHaveBeenCalledTimes(1);
    expect(d.add).toHaveBeenCalledTimes(1);
    expect(d.held.has(ROLE)).toBe(true);
    // 終わったら閉じている
    expect(holder(ctx)).toBeUndefined();
    expect(revocation(ctx, id).status).toBe("done");
    ctx.db.close();
  });
});

// ── RF-F 持ち越しの復元も所有権の中 ─────────────────────────────────────────

describe("RF-F: 持ち越した復元も所有権を必要とする", () => {
  it("別の所有者がいれば復元の add を実行しない", async () => {
    const ctx = setup();
    const id = expiredWithRevocation(ctx);
    // 前回 remove を投げたかもしれない状態
    ctx.shop.markRoleRevocationRemoveAttempt(id);
    // 同じロールを与える有効な契約がある（＝復元したい状況）
    ctx.db
      .prepare(
        `INSERT INTO shop_purchases
           (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivered_at,delivery_snapshot_json)
         VALUES (?,?,1,?,100,'active','delivered',100,?)`,
      )
      .run(
        ctx.item.id,
        USER,
        Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
      );
    // 別 worker が資源を握っている
    ctx.shop.acquireExternalEffectLock({
      scope: "discord_role", key: KEY, operation: "add", owner: "other-worker",
    });

    const d = discord({ roles: [] }); // ロールは今は無い＝復元したい
    await processShopRoleRevocations(d.client as never, ctx.services);

    // **所有権が無いので復元の add を投げない**
    expect(d.add).not.toHaveBeenCalled();
    expect(d.remove).not.toHaveBeenCalled();
    expect(holder(ctx)?.owner).toBe("other-worker");
    ctx.db.close();
  });

  it("所有権が取れれば復元は所有権の中で実行される", async () => {
    const ctx = setup();
    const id = expiredWithRevocation(ctx);
    ctx.shop.markRoleRevocationRemoveAttempt(id);
    ctx.db
      .prepare(
        `INSERT INTO shop_purchases
           (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivered_at,delivery_snapshot_json)
         VALUES (?,?,1,?,100,'active','delivered',100,?)`,
      )
      .run(
        ctx.item.id,
        USER,
        Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
      );

    const d = discord({ roles: [] });
    await processShopRoleRevocations(d.client as never, ctx.services);

    expect(d.add).toHaveBeenCalledTimes(1);
    expect(d.held.has(ROLE)).toBe(true);
    expect(holder(ctx)).toBeUndefined(); // 終わったら閉じる
    ctx.db.close();
  });
});

// ── RF-G remove の最終確認が取れない ────────────────────────────────────────

describe("RF-G: 剥がしたあと確認が取れないとき", () => {
  it("鍵は uncertain で残り、剥奪は done にならない", async () => {
    const ctx = setup();
    const id = expiredWithRevocation(ctx);
    const d = discord({ finalFetchFails: true });

    await processShopRoleRevocations(d.client as never, ctx.services).catch(() => undefined);

    expect(d.remove).toHaveBeenCalledTimes(1);
    // **「剥がせた」と断定しない**
    expect(holder(ctx)?.state).toBe("uncertain");
    expect(revocation(ctx, id).status).not.toBe("done");
    ctx.db.close();
  });

  it("結果が分からないあいだ、別 worker は同じ資源を触れない", async () => {
    const ctx = setup();
    expiredWithRevocation(ctx);
    const d = discord({ finalFetchFails: true });
    await processShopRoleRevocations(d.client as never, ctx.services).catch(() => undefined);

    expect(
      ctx.shop.acquireExternalEffectLock({
        scope: "discord_role", key: KEY, operation: "add", owner: "system:shop-timed-access",
      }).ok,
    ).toBe(false);
    ctx.db.close();
  });

  it("剥がせていないと確認できたら解放して再試行できる", async () => {
    const ctx = setup();
    const id = expiredWithRevocation(ctx);
    // remove は例外を返し、ロールは残ったまま
    const d = discord({ removeFails: true });

    await processShopRoleRevocations(d.client as never, ctx.services).catch(() => undefined);

    // 実物で「まだ在る」＝資源は動いていないので解放してよい
    expect(holder(ctx)).toBeUndefined();
    expect(revocation(ctx, id).status).not.toBe("done");
    // 次の巡回でやり直せる
    const d2 = discord();
    await processShopRoleRevocations(d2.client as never, ctx.services);
    expect(d2.remove).toHaveBeenCalledTimes(1);
    expect(revocation(ctx, id).status).toBe("done");
    ctx.db.close();
  });
});
