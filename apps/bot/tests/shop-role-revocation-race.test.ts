import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 失効のロール剥奪と、新しい契約の競合。
 *
 * 剥奪はDiscordへの外部操作なので、判定と実行の間に時間が空く。その隙に同じロールを
 * 与える新しい契約が成立すると、**古い失効が新しい権利のロールを剥がす**。
 * 剥がす直前と直後の両方で確かめ、剥がしてしまった場合は戻す。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const recoveryModule = import("../src/scheduler-recovery.js");
const USER = "1463201396567441441";
const ROLE = "r-vip";
const STAFF = "system:test";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:race",
  });
  const settings = { getString: vi.fn((k: string) => (k === "guild:main" ? "guild" : undefined)) };
  const services = { db, events, shop, settings } as unknown as Services;
  return { db, ledger, events, shop, services };
}
type Ctx = ReturnType<typeof setup>;

const roleItem = (ctx: Ctx, name: string, roleId: string) =>
  ctx.shop.createItem(
    {
      name,
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: roleId }),
    } as never,
    STAFF,
  );

function buyDelivered(ctx: Ctx, itemId: number) {
  const p = ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;
  ctx.shop.beginDelivery(p.id);
  ctx.shop.markDeliverySucceeded(p.id, STAFF);
  return p;
}

/** 買っただけ（まだ配送していない）購入 */
function buyUndelivered(ctx: Ctx, itemId: number) {
  return ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;
}

function expireNow(ctx: Ctx, purchaseId: number) {
  ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);
  ctx.shop.expireIfDue(purchaseId, STAFF);
}

/**
 * Discordのふり。`onFetch` で「member を取り直すたびに何が起きるか」を差し込める
 * （awaitの隙に新しい契約が成立する状況を作るため）。
 */
function world(opts: { hasRole?: boolean; onFetch?: (n: number) => void; removeFails?: boolean; addFails?: boolean } = {}) {
  const roles = new Set<string>(opts.hasRole === false ? [] : [ROLE]);
  let fetches = 0;
  const remove = vi.fn(async (id: string) => {
    if (opts.removeFails) throw new Error("missing permissions");
    roles.delete(id);
  });
  const add = vi.fn(async (id: string) => {
    if (opts.addFails) throw new Error("add failed");
    roles.add(id);
  });
  const member = { roles: { cache: { has: (id: string) => roles.has(id) }, remove, add } };
  const guild = {
    members: {
      fetch: vi.fn(async () => {
        fetches += 1;
        opts.onFetch?.(fetches);
        return member;
      }),
    },
  };
  const client = { guilds: { fetch: vi.fn(async () => guild) } };
  return { client, guild, member, remove, add, roles, fetchCount: () => fetches };
}

const lastError = (ctx: Ctx, purchaseId: number) =>
  (ctx.db.prepare("SELECT last_error FROM shop_role_revocations WHERE purchase_id=?").get(purchaseId) as
    | { last_error: string | null }
    | undefined)?.last_error;

const revocationStatus = (ctx: Ctx, purchaseId: number) =>
  (ctx.db.prepare("SELECT status FROM shop_role_revocations WHERE purchase_id=?").get(purchaseId) as { status: string } | undefined)
    ?.status;

describe("剥奪と新しい契約の競合", () => {
  it("有効な契約が既にあるなら、そもそも剥がさない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    buyDelivered(ctx, item.id); // 新しい契約
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(w.roles.has(ROLE)).toBe(true);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("最初の確認の後に契約が生えても、剥がす直前で気づいて剥がさない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    // member fetch の await 中に新しい契約が成立する
    const w = world({ onFetch: (n) => { if (n === 1) buyDelivered(ctx, item.id); } });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(w.roles.has(ROLE)).toBe(true);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("剥がした後に契約が生えたら、自分が消したロールを戻す", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    const w = world();
    // 剥がしている最中に新しい契約が成立した状況
    w.remove.mockImplementation(async (id: string) => {
      w.roles.delete(id);
      buyDelivered(ctx, item.id);
    });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).toHaveBeenCalledTimes(1);
    expect(w.add).toHaveBeenCalledTimes(1);
    expect(w.roles.has(ROLE)).toBe(true); // 戻っている
    expect(revocationStatus(ctx, old.id)).toBe("done");
    expect(ctx.events.listByType("shop_role_revocation_rolled_back")).toHaveLength(1);
    ctx.db.close();
  });

  it("戻せなかったら done にせず、次の巡回で収束させる", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    const w = world({ addFails: true });
    w.remove.mockImplementation(async (id: string) => {
      w.roles.delete(id);
      buyDelivered(ctx, item.id);
    });

    await expect(processShopRoleRevocations(w.client as never, ctx.services)).rejects.toThrow(/rollback/);

    expect(revocationStatus(ctx, old.id)).toBe("pending");
    expect(w.roles.has(ROLE)).toBe(false); // 外したまま戻せていない

    // **次の巡回でロールを戻してから done にする。**
    // 「有効な契約がある」だけを理由に done にすると、role が無いまま完了扱いになる。
    const w2 = world({ hasRole: false });
    await processShopRoleRevocations(w2.client as never, ctx.services);

    expect(w2.remove).not.toHaveBeenCalled();
    expect(w2.add).toHaveBeenCalledWith(ROLE);
    expect(w2.roles.has(ROLE)).toBe(true);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("remove直後にプロセスが落ちても、再起動後にロールを戻してから done にする", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);

    // remove は成功したが、その直後に落ちた状況を再現する。
    // 「外しにいった」記録はDBに残っている（メモリのフラグでは消えている）。
    const crashed = world();
    crashed.remove.mockImplementation(async () => {
      throw new Error("process died");
    });
    ctx.shop.markRoleRevocationRemoveAttempt(old.id);
    crashed.roles.delete(ROLE);
    // 落ちている間に新しい契約が成立
    buyDelivered(ctx, item.id);

    // 再起動後の巡回
    const w = world({ hasRole: false });
    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(w.add).toHaveBeenCalledWith(ROLE);
    expect(w.roles.has(ROLE)).toBe(true);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("remove直後に落ちて、生えていたのが未配送の契約なら、戻すが done にしない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);

    // remove は通ったが直後に落ちた。記録だけがDBに残っている
    ctx.shop.markRoleRevocationRemoveAttempt(old.id);
    // 落ちている間に成立したのは**未配送の**契約
    const fresh = buyUndelivered(ctx, item.id);

    // 再起動後の巡回。ロールは自分が外したので実体には無い
    const w = world({ hasRole: false });
    await processShopRoleRevocations(w.client as never, ctx.services);

    // `already_absent` で素通り done にしてはいけない。**戻した上で持ち越す**
    expect(w.remove).not.toHaveBeenCalled();
    expect(w.add).toHaveBeenCalledWith(ROLE);
    expect(w.roles.has(ROLE)).toBe(true);
    expect(revocationStatus(ctx, old.id)).toBe("pending");
    expect(lastError(ctx, old.id)).toBe("deferred:active_purchase_unsettled");

    // B が返金されたら、改めて剥がして完了する
    ctx.shop.refund(fresh.id, "配送できなかった", STAFF);
    const w2 = world();
    await processShopRoleRevocations(w2.client as never, ctx.services);
    expect(w2.remove).toHaveBeenCalledWith(ROLE);
    expect(w2.roles.has(ROLE)).toBe(false);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("戻せなければ done にしない（有効な契約があっても）", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    ctx.shop.markRoleRevocationRemoveAttempt(old.id);
    buyDelivered(ctx, item.id);

    const w = world({ hasRole: false, addFails: true });
    await expect(processShopRoleRevocations(w.client as never, ctx.services)).rejects.toThrow(/rollback/);

    expect(w.roles.has(ROLE)).toBe(false);
    expect(revocationStatus(ctx, old.id)).toBe("pending");
    ctx.db.close();
  });

  it("他に契約が無ければ、ロールは一度だけ剥がされる", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);
    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).toHaveBeenCalledTimes(1);
    expect(w.roles.has(ROLE)).toBe(false);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    expect(ctx.events.listByType("shop_role_revocation_done")).toHaveLength(1);
    ctx.db.close();
  });

  it("メンバーが居なければ、剥がさずに完了", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    const w = world();
    w.guild.members.fetch = vi.fn(async () => {
      const err = new Error("Unknown Member") as Error & { code: number };
      err.code = 10007;
      throw err;
    });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("既にロールが無ければ、剥がさずに完了", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    const w = world({ hasRole: false });

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("購入後に商品のロールを R1→R2 へ変えても、R2 は決して剥がされない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    ctx.shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "r-other" }) } as never, STAFF);
    expireNow(ctx, old.id);
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).toHaveBeenCalledTimes(1);
    expect(w.remove).toHaveBeenCalledWith(ROLE);
    expect(w.remove).not.toHaveBeenCalledWith("r-other");
    ctx.db.close();
  });
});

describe("未確定の新しい購入では、古い失効を完了させない", () => {
  for (const [label, delivery] of [["自動配送", "auto"], ["手動配送", "manual"]] as const) {
    it(`${label}: B が未配送のうちは剥がさず、A も完了させない`, async () => {
      const { processShopRoleRevocations } = await recoveryModule;
      const ctx = setup();
      const item =
        delivery === "auto"
          ? roleItem(ctx, "月額", ROLE)
          : ctx.shop.createItem(
              {
                name: "手動ロール",
                price_land: 100,
                kind: "one_shot",
                delivery: "manual",
                delivery_kind: "add_role",
                delivery_data: JSON.stringify({ role_id: ROLE }),
              } as never,
              STAFF,
            );
      const old = buyDelivered(ctx, item.id);
      expireNow(ctx, old.id);
      const fresh = buyUndelivered(ctx, item.id);
      const w = world();

      await processShopRoleRevocations(w.client as never, ctx.services);

      // 剥がさない。**かつ完了にもしない**（Bが返金されたらロールだけ残ってしまう）
      expect(w.remove).not.toHaveBeenCalled();
      expect(w.roles.has(ROLE)).toBe(true);
      expect(revocationStatus(ctx, old.id)).toBe("pending");

      // B が配送された → ここで初めて A を完了してよい
      ctx.shop.beginDelivery(fresh.id);
      ctx.shop.markDeliverySucceeded(fresh.id, STAFF);
      const w2 = world();
      await processShopRoleRevocations(w2.client as never, ctx.services);

      expect(w2.remove).not.toHaveBeenCalled();
      expect(w2.roles.has(ROLE)).toBe(true);
      expect(revocationStatus(ctx, old.id)).toBe("done");
      ctx.db.close();
    });
  }

  /**
   * `roles.remove()` の await 中に未配送の契約が生えた場合。
   *
   * 剥がす前も直前も守る契約は無いので、剥奪は正しく走る。問題はその**直後**で、
   * 「提供済みの契約だけ」を見ていると未配送の契約（`unsettled`）を見落とし、
   * **race のときだけ**「剥がさない / done にしない」という契約を破っていた。
   */
  for (const [label, delivery] of [["自動配送", "auto"], ["手動配送", "manual"]] as const) {
    it(`${label}: remove中にBが生えたら、戻した上で A を完了させない`, async () => {
      const { processShopRoleRevocations } = await recoveryModule;
      const ctx = setup();
      const item =
        delivery === "auto"
          ? roleItem(ctx, "月額", ROLE)
          : ctx.shop.createItem(
              {
                name: "手動ロール",
                price_land: 100,
                kind: "one_shot",
                delivery: "manual",
                delivery_kind: "add_role",
                delivery_data: JSON.stringify({ role_id: ROLE }),
              } as never,
              STAFF,
            );
      const old = buyDelivered(ctx, item.id);
      expireNow(ctx, old.id);

      let fresh!: ReturnType<typeof buyUndelivered>;
      const w = world();
      // 剥がしている最中に**未配送の**契約が成立した状況
      w.remove.mockImplementation(async (id: string) => {
        w.roles.delete(id);
        fresh = buyUndelivered(ctx, item.id);
      });

      await processShopRoleRevocations(w.client as never, ctx.services);

      // 剥がしはした（直前までは守る契約が無かった）が、戻す
      expect(w.remove).toHaveBeenCalledTimes(1);
      expect(w.add).toHaveBeenCalledTimes(1);
      expect(w.roles.has(ROLE)).toBe(true);
      expect(ctx.events.listByType("shop_role_revocation_rolled_back")).toHaveLength(1);
      // **done にはしない。** Bが返金されたらもう一度剥がす必要がある
      expect(revocationStatus(ctx, old.id)).toBe("pending");
      expect(lastError(ctx, old.id)).toBe("deferred:active_purchase_unsettled");

      // ── B が配送された → 次の巡回は剥がさず A を完了する
      ctx.shop.beginDelivery(fresh.id);
      ctx.shop.markDeliverySucceeded(fresh.id, STAFF);
      const w2 = world();
      await processShopRoleRevocations(w2.client as never, ctx.services);

      expect(w2.remove).not.toHaveBeenCalled();
      expect(w2.roles.has(ROLE)).toBe(true);
      expect(revocationStatus(ctx, old.id)).toBe("done");
      ctx.db.close();
    });
  }

  it("remove中に生えたBが後で返金されたら、次の巡回で改めて剥がす", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);

    let fresh!: ReturnType<typeof buyUndelivered>;
    const w = world();
    w.remove.mockImplementation(async (id: string) => {
      w.roles.delete(id);
      fresh = buyUndelivered(ctx, item.id);
    });

    await processShopRoleRevocations(w.client as never, ctx.services);
    expect(w.roles.has(ROLE)).toBe(true); // 戻っている
    expect(revocationStatus(ctx, old.id)).toBe("pending");

    // ── B が返金された → 守る契約が無くなったので、改めて剥がして完了する
    ctx.shop.refund(fresh.id, "配送できなかった", STAFF);
    const w2 = world();
    await processShopRoleRevocations(w2.client as never, ctx.services);

    expect(w2.remove).toHaveBeenCalledWith(ROLE);
    expect(w2.roles.has(ROLE)).toBe(false);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });

  it("B が返金されたら、A はロールを剥がして完了する", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const item = roleItem(ctx, "月額", ROLE);
    const old = buyDelivered(ctx, item.id);
    expireNow(ctx, old.id);
    const fresh = buyUndelivered(ctx, item.id);

    // 未確定のあいだは何も起きない
    const w1 = world();
    await processShopRoleRevocations(w1.client as never, ctx.services);
    expect(w1.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("pending");

    // B が配送できずに返金された → 守る契約が無くなる
    ctx.shop.refund(fresh.id, "配送できなかった", STAFF);

    const w2 = world();
    await processShopRoleRevocations(w2.client as never, ctx.services);

    expect(w2.remove).toHaveBeenCalledWith(ROLE);
    expect(w2.roles.has(ROLE)).toBe(false);
    expect(revocationStatus(ctx, old.id)).toBe("done");
    ctx.db.close();
  });
});

describe("裏の取れない既存キュー行", () => {
  it("Discordへ触らず、毎分retryし続けない", async () => {
    const { processShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const old = buyDelivered(ctx, roleItem(ctx, "月額", ROLE).id);
    expireNow(ctx, old.id);
    // 旧実装が現在の商品設定から作ったような、裏の取れない対象へ書き換える
    ctx.db.prepare("UPDATE shop_role_revocations SET role_id='r-unproven' WHERE purchase_id=?").run(old.id);
    const w = world();

    await processShopRoleRevocations(w.client as never, ctx.services);

    expect(w.remove).not.toHaveBeenCalled();
    expect(revocationStatus(ctx, old.id)).toBe("failed");
    expect(ctx.events.listByType("shop_role_revocation_blocked")).toHaveLength(1);

    // 2回目でもpendingへ戻らない（毎分Discordを叩き続けない）
    await processShopRoleRevocations(w.client as never, ctx.services);
    expect(w.remove).not.toHaveBeenCalled();
    expect(ctx.events.listByType("shop_role_revocation_blocked")).toHaveLength(1);
    ctx.db.close();
  });
});

describe("失効キューのバックフィル", () => {
  function legacyExpired(ctx: Ctx, itemId: number, snapshotJson: string | null, deliveredAt: number | null) {
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,auto_renew," +
          "delivery_snapshot_json,delivered_at,delivery_state) VALUES (?,?,?,?,?, 'expired',0,?,?, 'delivered')",
      )
      .run(itemId, USER, 1_700_000_000, 1, 100, snapshotJson, deliveredAt);
    return Number(info.lastInsertRowid);
  }
  const snap = (roleId: string) =>
    JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: roleId }), captured_at: 1 });

  it("購入時スナップショット + 配送証拠があるなら、その対象で積む", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, snap("r-snapshot"), 1_700_000_500);

    backfillShopRoleRevocations(ctx.services);

    const row = ctx.db.prepare("SELECT role_id, status FROM shop_role_revocations WHERE purchase_id=?").get(id);
    expect(row).toMatchObject({ role_id: "r-snapshot", status: "pending" });
    ctx.db.close();
  });

  it("スナップショットが無い旧購入から、現在の商品ロールを積まない", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, null, 1_700_000_500);

    backfillShopRoleRevocations(ctx.services);

    expect(ctx.db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(id)).toBeUndefined();
    expect(ctx.shop.listUnresolvedExpiryRevocations().map((r) => r.id)).toContain(id);
    ctx.db.close();
  });

  it("壊れたスナップショットからも現在の商品ロールを積まない", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, "{", 1_700_000_500);

    backfillShopRoleRevocations(ctx.services);

    expect(ctx.db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(id)).toBeUndefined();
    ctx.db.close();
  });

  it("配送した証拠が無い旧購入も積まない", async () => {
    const { backfillShopRoleRevocations } = await recoveryModule;
    const ctx = setup();
    const id = legacyExpired(ctx, roleItem(ctx, "月額", "r-current").id, snap("r-snapshot"), null);

    backfillShopRoleRevocations(ctx.services);

    expect(ctx.db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(id)).toBeUndefined();
    ctx.db.close();
  });
});
