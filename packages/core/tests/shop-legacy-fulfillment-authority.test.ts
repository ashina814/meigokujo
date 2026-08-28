import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventLog,
  Ledger,
  REEVAL_INVITE_COUNT,
  REEVAL_PRICE_LAND,
  Settings,
  Shop,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();
const USER = "666666666666666666";
const STAFF = "staff";

/**
 * 旧購入の「提供済み」は、証明できるときだけ提供済みとして扱う。
 *
 * `delivery_state='delivered'` は旧行移行の**既定値**でもある。移行は配送スナップショットを
 * 持たない行について、当時の `shop_items.delivery` を見て delivered / pending を決めていた。
 * つまりその値は「実際に配送した」の一次証拠ではないし、現在の商品設定から過去を推測する
 * という今回の契約違反そのものでもある。
 *
 * ここでは、
 *   1. 移行がその推測をしないこと
 *   2. 読み手が旧行の delivery_state を提供済みの証拠に使わないこと
 * の両方を固定する。
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** delivery_state 列が導入される前の姿でDBを作り、再オープンで移行させる。 */
function makeOldSchemaDb(itemDelivery: "auto" | "manual") {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-legacy-fulfillment-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");

  const db = openDb(dbPath);
  const shop = new Shop(db, new Ledger(db), new EventLog(db));
  const item = shop.createItem(
    itemDelivery === "auto"
      ? {
          name: "旧商品",
          price_land: 10_000,
          kind: "one_shot",
          delivery: "auto",
          delivery_kind: "add_role",
          delivery_data: JSON.stringify({ role_id: "r-legacy" }),
        }
      : { name: "旧商品", price_land: 10_000, kind: "one_shot", delivery: "manual" },
    STAFF,
  );
  // 旧行そのもの: delivered_at なし・snapshot なし・delivery_state なし
  const info = db
    .prepare(
      "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_snapshot_json,delivered_at)" +
        " VALUES (?,?,?,?, 'active',0,NULL,NULL)",
    )
    .run(item.id, USER, 1_700_000_000, 10_000);
  const purchaseId = Number(info.lastInsertRowid);
  // 移行前の状態へ戻す（この列は openDb が後から埋める）
  db.prepare("UPDATE shop_purchases SET delivery_state = NULL, delivery_updated_at = NULL WHERE id = ?").run(purchaseId);
  db.close();

  // 再オープン = migration/backfill が走る
  const reopened = openDb(dbPath);
  return { dbPath, db: reopened, shop: new Shop(reopened, new Ledger(reopened), new EventLog(reopened)), itemId: item.id, purchaseId };
}

describe("旧行の移行は、現在の商品設定から「提供済み」を推測しない", () => {
  for (const itemDelivery of ["auto", "manual"] as const) {
    it(`現在の商品が ${itemDelivery} でも、証拠のない旧購入を提供済みにしない`, () => {
      const ctx = makeOldSchemaDb(itemDelivery);
      const row = ctx.shop.getPurchase(ctx.purchaseId)!;

      // 移行が delivered を書いていない（=「提供済み」と確定していない）
      expect(row.delivery_state).not.toBe("delivered");
      expect(row.delivered_at).toBeNull();

      // 読み手からは「不明」として見える
      expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(1);
      expect(ctx.shop.listLegacyUnknownFulfillment().map((r) => r.id)).toEqual([ctx.purchaseId]);
      expect(ctx.shop.countPendingManual()).toBe(0);

      // 完了ボタンでも確定できない
      expect(ctx.shop.completeManualDelivery(ctx.purchaseId, STAFF)).toEqual({
        completed: false,
        reason: "legacy_unknown",
      });
      expect(ctx.shop.getPurchase(ctx.purchaseId)!.delivered_at).toBeNull();
      ctx.db.close();
    });
  }

  it("現在の商品設定がauto/manualのどちらでも、結果の意味は変わらない", () => {
    const auto = makeOldSchemaDb("auto");
    const manual = makeOldSchemaDb("manual");

    const shape = (c: ReturnType<typeof makeOldSchemaDb>) => ({
      state: c.shop.getPurchase(c.purchaseId)!.delivery_state,
      legacy: c.shop.countLegacyUnknownFulfillment(),
      pending: c.shop.countPendingManual(),
      completion: c.shop.completeManualDelivery(c.purchaseId, STAFF),
    });

    expect(shape(auto)).toEqual(shape(manual));
    auto.db.close();
    manual.db.close();
  });
});

describe("旧行の delivery_state='delivered' は提供済みの証拠にしない", () => {
  function setup() {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const settings = new Settings(db);
    let reevalItemId: number | null = null;
    const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
    ledger.ensureAccount(`user:${USER}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${USER}`,
      amount: 5_000_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed:legacy-authority",
    });
    return { db, ledger, events, settings, shop, setReevalItem: (id: number | null) => { reevalItemId = id; } };
  }
  type Ctx = ReturnType<typeof setup>;

  const makeItem = (ctx: Ctx, over: Record<string, unknown> = {}) =>
    ctx.shop.createItem(
      { name: "旧商品", price_land: 10_000, kind: "one_shot", delivery: "manual", ...over } as never,
      STAFF,
    );

  /** 移行由来の delivered（delivered_at なし・delivery_updated_at == purchased_at） */
  function migrationDeliveredRow(ctx: Ctx, itemId: number) {
    const purchasedAt = 1_700_000_000;
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew," +
          "delivery_snapshot_json,delivered_at,delivery_state,delivery_updated_at)" +
          " VALUES (?,?,?,?, 'active',0,NULL,NULL,'delivered',?)",
      )
      .run(itemId, USER, purchasedAt, 10_000, purchasedAt);
    return ctx.shop.getPurchase(Number(info.lastInsertRowid))!;
  }

  it("移行由来のdeliveredは「対応済み」ではなく「不明」として扱う", () => {
    const ctx = setup();
    const purchase = migrationDeliveredRow(ctx, makeItem(ctx).id);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({
      completed: false,
      reason: "legacy_unknown",
    });
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(1);
    expect(ctx.shop.countPendingManual()).toBe(0);
    ctx.db.close();
  });

  it("実際の配送記録（shop_delivered event）があれば、旧行でも提供済みとして扱う", () => {
    const ctx = setup();
    const purchase = migrationDeliveredRow(ctx, makeItem(ctx).id);
    ctx.events.log("shop_delivered", { actor: STAFF, payload: { purchaseId: purchase.id } });

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({
      completed: false,
      reason: "already_delivered",
    });
    // 提供済みなので「要確認」にも出さない
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(0);
    ctx.db.close();
  });

  it("delivered_at があれば旧行でも提供済み", () => {
    const ctx = setup();
    const purchase = migrationDeliveredRow(ctx, makeItem(ctx).id);
    ctx.db.prepare("UPDATE shop_purchases SET delivered_at=? WHERE id=?").run(1_700_000_500, purchase.id);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({
      completed: false,
      reason: "already_delivered",
    });
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(0);
    ctx.db.close();
  });

  it("新しい購入（provenanceあり）の delivered は引き続き信頼する", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const purchase = ctx.shop.purchase({
      itemId: item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken,
    }).purchase;
    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF).completed).toBe(true);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({
      completed: false,
      reason: "already_delivered",
    });
    ctx.db.close();
  });
});

describe("現在の商品ID指定で、過去の普通の購入を隠さない", () => {
  function setup() {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const settings = new Settings(db);
    let reevalItemId: number | null = null;
    const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
    ledger.ensureAccount(`user:${USER}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${USER}`,
      amount: 5_000_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed:designation",
    });
    return { db, ledger, events, settings, shop, setReevalItem: (id: number | null) => { reevalItemId = id; } };
  }
  type Ctx = ReturnType<typeof setup>;

  const buy = (ctx: Ctx, itemId: number) =>
    ctx.shop.purchase({
      itemId,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
    }).purchase;

  it("普通に買ったあとで再評価商品に指定されても、仕事は消えない", () => {
    const ctx = setup();
    // 再評価の構成を満たすが、まだ再評価商品には指定していない手動商品
    const a = ctx.shop.createItem(
      {
        name: "あとで再評価に指定される商品",
        price_land: REEVAL_PRICE_LAND,
        price_alt_kind: "invite",
        price_alt_amount: REEVAL_INVITE_COUNT,
        kind: "one_shot",
        delivery: "manual",
      } as never,
      STAFF,
    );
    const purchase = buy(ctx, a.id);
    expect(ctx.shop.fulfillmentProvenance(purchase.id)).toMatchObject({
      delivery_mode: "manual",
      source: "storefront",
    });
    expect(ctx.shop.countPendingManual()).toBe(1);

    // あとから運営が A を再評価商品に指定する
    ctx.setReevalItem(a.id);
    ctx.settings.set("shop:reeval_item_id", a.id, STAFF);
    ctx.shop.registerReevaluationSaleItem(a.id);

    // この購入には再評価の実績が無い。普通の仕事のまま。
    expect(ctx.shop.isReevaluationPurchase(purchase.id)).toBe(false);
    expect(ctx.shop.countPendingManual()).toBe(1);
    expect(ctx.shop.listPendingManual().map((r) => r.id)).toEqual([purchase.id]);
    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({ completed: true, reason: "completed" });
    ctx.db.close();
  });

  it("普通に買ったあとでオリジナルロール商品に指定されても、仕事は消えない", () => {
    const ctx = setup();
    const a = ctx.shop.createItem(
      { name: "あとでオリロに指定される商品", price_land: 250_000, kind: "one_shot", delivery: "manual" } as never,
      STAFF,
    );
    const purchase = buy(ctx, a.id);
    expect(ctx.shop.countPendingManual()).toBe(1);

    ctx.settings.set("shop:original_role_item_id", a.id, STAFF);

    expect(ctx.shop.countPendingManual()).toBe(1);
    expect(ctx.shop.listPendingManual().map((r) => r.id)).toEqual([purchase.id]);
    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF).completed).toBe(true);
    ctx.db.close();
  });

  it("一覧に出るものは完了でき、完了APIが断るものは一覧に出ない（指定変更後も）", () => {
    const ctx = setup();
    const a = ctx.shop.createItem(
      { name: "手動商品", price_land: 10_000, kind: "one_shot", delivery: "manual" } as never,
      STAFF,
    );
    const purchase = buy(ctx, a.id);
    ctx.settings.set("shop:reeval_item_id", a.id, STAFF);
    ctx.setReevalItem(a.id);

    const listed = ctx.shop.listPendingManual({ limit: 1000 });
    expect(listed.map((r) => r.id)).toContain(purchase.id);
    expect(ctx.shop.countPendingManual()).toBe(listed.length);
    for (const row of listed) {
      expect(ctx.shop.completeManualDelivery(row.id, STAFF).completed).toBe(true);
    }
    ctx.db.close();
  });

  it("証拠の無い旧購入は、現在の専用商品IDに一致するだけでは専用サービス扱いしない", () => {
    const ctx = setup();
    const a = ctx.shop.createItem(
      { name: "旧商品", price_land: 10_000, kind: "one_shot", delivery: "manual" } as never,
      STAFF,
    );
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_state)" +
          " VALUES (?,?,?,?, 'active',0,'pending')",
      )
      .run(a.id, USER, 1_700_000_000, 10_000);
    const purchaseId = Number(info.lastInsertRowid);

    ctx.settings.set("shop:reeval_item_id", a.id, STAFF);
    ctx.setReevalItem(a.id);

    // 専用サービスと推測せず、「不明」として見える
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(1);
    expect(ctx.shop.listLegacyUnknownFulfillment().map((r) => r.id)).toEqual([purchaseId]);
    expect(ctx.shop.completeManualDelivery(purchaseId, STAFF)).toEqual({
      completed: false,
      reason: "legacy_unknown",
    });
    ctx.db.close();
  });
});
