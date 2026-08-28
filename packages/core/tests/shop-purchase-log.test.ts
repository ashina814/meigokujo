import { describe, expect, it } from "vitest";
import { EventLog, Ledger, REEVAL_INVITE_COUNT, REEVAL_PRICE_LAND, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();
const USER = "333333333333333333";

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
    actor: "test",
    approvedBy: "test",
    idempotencyKey: "seed:shop-log",
  });
  return { db, ledger, events, shop };
}

function logs(db: ReturnType<typeof openDb>) {
  return (db.prepare("SELECT payload FROM outbox WHERE kind='shop_purchase_log' ORDER BY id").all() as Array<{payload:string}>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("official shop purchase log outbox", () => {
  it("専用経路（再評価のinvite払い）は方法・kind・amountを残す", () => {
    // 代替支払のlog自体は残す必要がある——資源を実際に消費する専用writerが存在する
    // 経路（再評価チャレンジのinvite払い）だけが、alt-paidな購入を作れる。
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    let reevalItemId: number | null = null;
    const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
    const item = shop.createItem({
      name: "再評価チャレンジ",
      price_land: REEVAL_PRICE_LAND,
      price_alt_kind: "invite",
      price_alt_amount: REEVAL_INVITE_COUNT,
      kind: "one_shot",
      delivery: "manual",
    }, "staff");
    reevalItemId = item.id;
    db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES (?, 'meirei', 1)").run(USER);
    const addInvite = db.prepare("INSERT INTO invites (inviter_id,invitee_id,credited_at) VALUES (?,?,?)");
    for (let i = 0; i < REEVAL_INVITE_COUNT; i += 1) addInvite.run(USER, `guest-${i}`, i + 1);

    const result = shop.purchaseReevaluation({
      itemId: item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [],
      mode: "invite", idempotencyKey: "log:reeval-invite",
    });

    expect(logs(db)).toEqual([
      expect.objectContaining({
        purchaseId: result.purchase.id,
        itemName: "再評価チャレンジ",
        paidLand: null,
        paidAltKind: "invite",
        paidAltAmount: REEVAL_INVITE_COUNT,
        transactionId: null,
      }),
    ]);
    // 資源が実際に消費されている（これが generic alt との違い）
    expect(db.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: REEVAL_INVITE_COUNT });
    db.close();
  });

  it("通常Land購入をshop_purchasesと同じpurchase IDで1件だけ積む", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({
      name: "通常Land商品",
      price_land: 120_000,
      kind: "one_shot",
      delivery: "manual",
    }, "staff");
    const result = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [] });
    const rows = logs(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purchaseId: result.purchase.id,
      itemId: item.id,
      itemName: "通常Land商品",
      userId: USER,
      paidLand: 120_000,
      paidAltKind: null,
      paidAltAmount: null,
      purchasedAt: result.purchase.purchased_at,
      deliveryMode: "manual",
      deliveryKind: null,
      source: "shop_purchase",
    });
    expect(rows[0]?.transactionId).toBeTypeOf("number");
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchase_log_enqueues WHERE purchase_id=?").get(result.purchase.id) as {n:number}).n).toBe(1);
    ctx.db.close();
  });

  it("generic storefrontの代替支払いは成立せず、購入もlogも作らない", () => {
    // 旧実装は`paid_alt_*`を書くだけで資源を消費していなかった（＝払っていないのに
    // 支払済み購入）。generic storefrontでは代替支払を一切成立させない。
    const ctx = setup();
    const item = ctx.shop.createItem({
      name: "代替支払い商品",
      price_land: null,
      price_alt_kind: "invite",
      price_alt_amount: 3,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "role-x" }),
    }, "staff");
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    expect(() => ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], payAlt: true }))
      .toThrow(/ERR_ALT_PAYMENT_UNSUPPORTED/);
    expect(logs(ctx.db)).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 0 });
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    ctx.db.close();
  });

  it("shop_purchasesを直接作るlegacy移行も無償移行として1件だけ積む", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({
      name: "期限アクセス",
      price_land: 50_000,
      kind: "monthly",
      duration_days: 30,
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "legacy-role" }),
    }, "staff");
    const result = ctx.shop.migrateTimedAccessLegacy({
      migrationKey: "legacy-2026-08",
      expectations: [{ itemId: item.id, roleId: "legacy-role", expectedCount: 1, roleHolderIds: [USER] }],
      actor: "user:staff",
      reason: "既存ロール移行",
      startedAt: 1_800_000_000,
    });
    expect(result.imports).toHaveLength(1);
    const rows = logs(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purchaseId: result.imports[0]?.purchase_id,
      itemName: "期限アクセス",
      paidLand: null,
      paidAltKind: null,
      paidAltAmount: null,
      source: "legacy_timed_access_import",
      workType: "legacy_timed_access_import",
      migrationKey: "legacy-2026-08",
    });
    // migration replay creates neither another purchase nor another Discord log.
    const replay = ctx.shop.migrateTimedAccessLegacy({
      migrationKey: "legacy-2026-08",
      expectations: [{ itemId: item.id, roleId: "legacy-role", expectedCount: 1, roleHolderIds: [USER] }],
      actor: "user:staff",
      reason: "既存ロール移行",
      startedAt: 1_800_000_000,
    });
    expect(replay.alreadyApplied).toBe(true);
    expect(logs(ctx.db)).toHaveLength(1);
    ctx.db.close();
  });
});
