import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();
const USER = "888888888888888888";
const STAFF = "staff";
const START = 5_000_000;

/**
 * 失効とロール剥奪も、購入時の事実だけを根拠にする。
 *
 * 1. 返金済み・取消済みの購入を、遅れて走った期限切れ処理が上書きしない
 * 2. 商品のロール設定を後から変えても、過去の購入の剥奪対象は変わらない
 * 3. 購入時に付与したと証明できないロールは自動で剥がさない
 * 4. 同じロールを与える有効な別契約があるなら失わせない
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: START,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:expiry-authority",
  });
  return { db, ledger, events, shop };
}
type Ctx = ReturnType<typeof setup>;

const roleItem = (ctx: Ctx, name: string, roleId: string, over: Record<string, unknown> = {}) =>
  ctx.shop.createItem(
    {
      name,
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: roleId }),
      ...over,
    } as never,
    STAFF,
  );

function buy(ctx: Ctx, itemId: number, userId = USER) {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  if (userId !== USER) {
    ctx.ledger.transfer({
      from: TREASURY, to: `user:${userId}`, amount: 100_000, type: "adjust",
      actor: "t", approvedBy: "t", idempotencyKey: `seed:${userId}:${Math.random()}`,
    });
  }
  return ctx.shop.purchase({
    itemId,
    userId,
    actor: `user:${userId}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;
}

/** 実際に配送する（本番では自動配送がロールを付けてから期限が来る） */
function deliver(ctx: Ctx, purchaseId: number) {
  ctx.shop.beginDelivery(purchaseId);
  ctx.shop.markDeliverySucceeded(purchaseId, STAFF);
}

const lapse = (ctx: Ctx, purchaseId: number) =>
  ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);

const expiredEvents = (ctx: Ctx) => ctx.events.listByType("shop_expired").length;
const revocation = (ctx: Ctx, purchaseId: number) =>
  ctx.db.prepare("SELECT * FROM shop_role_revocations WHERE purchase_id=?").get(purchaseId) as
    | { role_id: string | null; status: string }
    | undefined;

describe("失効の状態遷移", () => {
  it("期限が来た有効な購入は失効する", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);
    deliver(ctx, p.id);
    lapse(ctx, p.id);

    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: true, reason: "expired" });
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("expired");
    expect(expiredEvents(ctx)).toBe(1);
    ctx.db.close();
  });

  it("期限が来ていなければ何も動かさない", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);

    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "not_due" });
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(expiredEvents(ctx)).toBe(0);
    ctx.db.close();
  });

  it("存在しない購入では event を作らない", () => {
    const ctx = setup();
    expect(ctx.shop.expireIfDue(9_999, STAFF)).toEqual({ expired: false, reason: "not_found" });
    expect(expiredEvents(ctx)).toBe(0);
    ctx.db.close();
  });

  for (const status of ["refunded", "cancelled", "expired"] as const) {
    it(`${status} の購入を失効で上書きしない`, () => {
      const ctx = setup();
      const p = buy(ctx, roleItem(ctx, "月額", "R1").id);
      lapse(ctx, p.id);
      ctx.db.prepare("UPDATE shop_purchases SET status=? WHERE id=?").run(status, p.id);

      expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "not_active" });
      expect(ctx.shop.getPurchase(p.id)!.status).toBe(status);
      expect(expiredEvents(ctx)).toBe(0);
      expect(revocation(ctx, p.id)).toBeUndefined();
      ctx.db.close();
    });
  }

  it("二重に失効させても、遷移も event も1回だけ", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);
    deliver(ctx, p.id);
    lapse(ctx, p.id);

    expect(ctx.shop.expireIfDue(p.id, STAFF).expired).toBe(true);
    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "not_active" });
    expect(expiredEvents(ctx)).toBe(1);
    ctx.db.close();
  });
});

describe("返金と失効の競合", () => {
  it("返金が先に確定したら、失効は上書きしない", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);
    lapse(ctx, p.id);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    ctx.shop.refund(p.id, "先に返金", STAFF);
    const afterRefund = ctx.ledger.balanceOf(`user:${USER}`);

    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "not_active" });
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    expect(expiredEvents(ctx)).toBe(0);
    expect(revocation(ctx, p.id)).toBeUndefined();
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(afterRefund);
    expect(afterRefund).toBe(before + 100);
    ctx.db.close();
  });

  it("失効が先に確定したら、返金は既存policyどおり止まる", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);
    deliver(ctx, p.id);
    lapse(ctx, p.id);
    ctx.shop.expireIfDue(p.id, STAFF);
    const after = ctx.ledger.balanceOf(`user:${USER}`);

    expect(() => ctx.shop.refund(p.id, "あとから", STAFF)).toThrow(/ERR_NOT_ACTIVE/);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("expired");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(after);
    ctx.db.close();
  });
});

describe("剥奪対象は購入時の事実で決まる", () => {
  it("自動配送の add_role 購入は購入時にロールを記録する", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);

    expect(ctx.shop.roleGrantProvenance(p.id)).toMatchObject({ role_id: "R1", delivery_mode: "auto" });
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(p.id)!)).toMatchObject({ kind: "proven", roleId: "R1" });
    ctx.db.close();
  });

  it("手動配送の add_role 購入も購入時にロールを記録する", () => {
    const ctx = setup();
    const item = roleItem(ctx, "手動ロール", "R1", { delivery: "manual" });
    const p = buy(ctx, item.id);

    expect(ctx.shop.roleGrantProvenance(p.id)).toMatchObject({ role_id: "R1", delivery_mode: "manual" });
    ctx.db.close();
  });

  it("add_role でない商品は剥奪対象を作らない", () => {
    const ctx = setup();
    const item = ctx.shop.createItem(
      { name: "手動商品", price_land: 100, kind: "one_shot", delivery: "manual" } as never,
      STAFF,
    );
    const p = buy(ctx, item.id);

    expect(ctx.shop.roleGrantProvenance(p.id)).toBeUndefined();
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(p.id)!).kind).toBe("proven_non_role");
    ctx.db.close();
  });

  it("商品のロール設定を R1→R2 に変えても、過去の購入の対象は R1 のまま", () => {
    const ctx = setup();
    const item = roleItem(ctx, "月額", "R1");
    const p = buy(ctx, item.id);
    deliver(ctx, p.id);

    ctx.shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "R2" }) } as never, STAFF);

    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(p.id)!)).toMatchObject({ kind: "proven", roleId: "R1" });
    lapse(ctx, p.id);
    ctx.shop.expireIfDue(p.id, STAFF);
    expect(revocation(ctx, p.id)).toMatchObject({ role_id: "R1", status: "pending" });
    ctx.db.close();
  });

  it("商品を無効化・削除しても対象は消えない", () => {
    const ctx = setup();
    const item = roleItem(ctx, "月額", "R1");
    const p = buy(ctx, item.id);
    ctx.shop.updateItem(item.id, { enabled: 0 } as never, STAFF);

    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(p.id)!)).toMatchObject({ kind: "proven", roleId: "R1" });
    ctx.db.close();
  });

  it("購入時の記録は上書きできない（append-only）", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);

    expect(() =>
      ctx.db.prepare("UPDATE shop_purchase_role_grant_provenance SET role_id='R2' WHERE purchase_id=?").run(p.id),
    ).toThrow(/append-only/);
    expect(() =>
      ctx.db.prepare("DELETE FROM shop_purchase_role_grant_provenance WHERE purchase_id=?").run(p.id),
    ).toThrow(/append-only/);
    ctx.db.close();
  });
});

describe("旧購入の剥奪対象", () => {
  /** provenance を持たない旧購入を、本番にある形のまま作る */
  function legacy(ctx: Ctx, itemId: number, snapshotJson: string | null, deliveredAt: number | null = 1_700_000_500) {
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,auto_renew," +
          "delivery_snapshot_json,delivered_at,delivery_state) VALUES (?,?,?,?,?, 'active',0,?,?, 'delivered')",
      )
      .run(itemId, USER, 1_700_000_000, 1, 100, snapshotJson, deliveredAt);
    return ctx.shop.getPurchase(Number(info.lastInsertRowid))!;
  }
  const snap = (kind: string, roleId?: string) =>
    JSON.stringify({
      delivery: "auto",
      delivery_kind: kind,
      delivery_data: roleId ? JSON.stringify({ role_id: roleId }) : null,
      captured_at: 1,
    });

  it("購入時スナップショットがあれば、そのロールが対象", () => {
    const ctx = setup();
    const p = legacy(ctx, roleItem(ctx, "月額", "R_CURRENT").id, snap("add_role", "R_SNAPSHOT"));

    expect(ctx.shop.roleGrantTarget(p)).toMatchObject({ kind: "proven", roleId: "R_SNAPSHOT" });
    ctx.db.close();
  });

  it("スナップショットが無い旧購入は、現在の商品設定から推測しない", () => {
    const ctx = setup();
    const p = legacy(ctx, roleItem(ctx, "月額", "R_CURRENT").id, null);

    expect(ctx.shop.roleGrantTarget(p).kind).toBe("legacy_unknown");
    ctx.shop.expireIfDue(p.id, STAFF);
    expect(revocation(ctx, p.id)).toBeUndefined();
    expect(ctx.shop.listUnresolvedExpiryRevocations().map((r) => r.id)).toContain(p.id);
    ctx.db.close();
  });

  it("現在の商品ロールを変えても、スナップショット無しの結果の意味は変わらない", () => {
    const ctx = setup();
    const item = roleItem(ctx, "月額", "R_CURRENT");
    const p = legacy(ctx, item.id, null);
    const before = ctx.shop.roleGrantTarget(p).kind;

    ctx.shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "R_OTHER" }) } as never, STAFF);

    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(p.id)!).kind).toBe(before);
    expect(before).toBe("legacy_unknown");
    ctx.db.close();
  });

  it("壊れたスナップショットも推測しない", () => {
    const ctx = setup();
    const p = legacy(ctx, roleItem(ctx, "月額", "R_CURRENT").id, "{");

    expect(ctx.shop.roleGrantTarget(p).kind).toBe("legacy_unknown");
    ctx.db.close();
  });

  it("add_role 以外のスナップショットは「ロール商品ではない」と証明できる", () => {
    const ctx = setup();
    const p = legacy(ctx, roleItem(ctx, "月額", "R_CURRENT").id, snap("extend_deadline"));

    expect(ctx.shop.roleGrantTarget(p).kind).toBe("proven_non_role");
    ctx.db.close();
  });
});

describe("剥奪には「対象」と「提供した事実」の両方が要る", () => {
  it("提供済み + 対象が証明できる → キューへ載る", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);
    deliver(ctx, p.id);
    lapse(ctx, p.id);

    ctx.shop.expireIfDue(p.id, STAFF);

    expect(revocation(ctx, p.id)).toMatchObject({ role_id: "R1", status: "pending" });
    ctx.db.close();
  });

  it("未提供の新しい購入からはロールを剥がさない", () => {
    const ctx = setup();
    const p = buy(ctx, roleItem(ctx, "月額", "R1").id);
    lapse(ctx, p.id);

    ctx.shop.expireIfDue(p.id, STAFF);

    expect(revocation(ctx, p.id)).toBeUndefined();
    expect(ctx.shop.listUnresolvedExpiryRevocations().map((r) => r.id)).toContain(p.id);
    ctx.db.close();
  });

  it("対象は分かるが提供したか分からない旧購入も剥がさない", () => {
    const ctx = setup();
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,auto_renew," +
          "delivery_snapshot_json,delivered_at,delivery_state) VALUES (?,?,?,?,?, 'active',0,?,NULL,'delivered')",
      )
      .run(
        roleItem(ctx, "月額", "R1").id,
        USER,
        1_700_000_000,
        1,
        100,
        JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: JSON.stringify({ role_id: "R1" }), captured_at: 1 }),
      );
    const id = Number(info.lastInsertRowid);

    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toMatchObject({ kind: "proven", roleId: "R1" });
    ctx.shop.expireIfDue(id, STAFF);

    expect(revocation(ctx, id)).toBeUndefined();
    ctx.db.close();
  });

  it("ロール商品でなければ剥奪キューを作らない（確認待ちにもしない）", () => {
    const ctx = setup();
    const item = ctx.shop.createItem(
      { name: "手動商品", price_land: 100, kind: "monthly", delivery: "manual" } as never,
      STAFF,
    );
    const p = buy(ctx, item.id);
    ctx.shop.completeManualDelivery(p.id, STAFF);
    lapse(ctx, p.id);

    ctx.shop.expireIfDue(p.id, STAFF);

    expect(revocation(ctx, p.id)).toBeUndefined();
    expect(ctx.shop.listUnresolvedExpiryRevocations().map((r) => r.id)).not.toContain(p.id);
    ctx.db.close();
  });

  it("証明できないキュー行はDiscordへ触る前に止める", () => {
    const ctx = setup();
    const item = roleItem(ctx, "月額", "R1");
    const p = buy(ctx, item.id);
    deliver(ctx, p.id);
    lapse(ctx, p.id);
    ctx.shop.expireIfDue(p.id, STAFF);
    // 旧実装が現在の商品設定から作ったような、裏の取れない対象へ書き換える
    ctx.db.prepare("UPDATE shop_role_revocations SET role_id='R_UNPROVEN' WHERE purchase_id=?").run(p.id);

    expect(ctx.shop.roleRevocationTargetProven(p.id, "R_UNPROVEN")).toBe(false);
    expect(ctx.shop.roleRevocationTargetProven(p.id, "R1")).toBe(true);
    ctx.db.close();
  });
});

describe("有効な別契約が同じロールを与えているか", () => {
  it("購入時の事実で証明できる active 契約は守る", () => {
    const ctx = setup();
    const item = roleItem(ctx, "月額", "R1");
    const a = buy(ctx, item.id);
    deliver(ctx, a.id);
    lapse(ctx, a.id);
    ctx.shop.expireIfDue(a.id, STAFF);
    const b = buy(ctx, item.id);
    deliver(ctx, b.id);

    expect(ctx.shop.activePurchaseProvesRoleEntitlement(USER, "R1", a.id)).toBe(true);
    ctx.db.close();
  });

  it("現在の商品設定でしか一致しない契約は守らない", () => {
    const ctx = setup();
    const item = roleItem(ctx, "月額", "R1");
    // 購入時の記録を持たない旧 active 購入（現在の商品だけが R1 を指す）
    ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_snapshot_json,delivered_at,delivery_state)" +
          " VALUES (?,?,?,?, 'active',0,NULL,?, 'delivered')",
      )
      .run(item.id, USER, 1_700_000_000, 100, 1_700_000_500);

    expect(ctx.shop.activePurchaseProvesRoleEntitlement(USER, "R1")).toBe(false);
    ctx.db.close();
  });

  it("商品のロールを後から変えても、購入時 R1 の active 契約は R1 を守り続ける", () => {
    const ctx = setup();
    const item = roleItem(ctx, "月額", "R1");
    const b = buy(ctx, item.id);
    deliver(ctx, b.id);
    ctx.shop.updateItem(item.id, { delivery_data: JSON.stringify({ role_id: "R2" }) } as never, STAFF);

    expect(ctx.shop.activePurchaseProvesRoleEntitlement(USER, "R1")).toBe(true);
    expect(ctx.shop.activePurchaseProvesRoleEntitlement(USER, "R2")).toBe(false);
    ctx.db.close();
  });

  it("別のロールを与える契約は守らない", () => {
    const ctx = setup();
    const b = buy(ctx, roleItem(ctx, "月額B", "R2").id);
    deliver(ctx, b.id);

    expect(ctx.shop.activePurchaseProvesRoleEntitlement(USER, "R1")).toBe(false);
    ctx.db.close();
  });
});
