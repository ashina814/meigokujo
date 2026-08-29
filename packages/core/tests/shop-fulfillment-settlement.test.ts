import { describe, expect, it } from "vitest";
import {
  EventLog,
  Ledger,
  OriginalRoles,
  REEVAL_INVITE_COUNT,
  REEVAL_PRICE_LAND,
  Settings,
  Shop,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { setStock } from "./helpers/set-stock.js";

registerDefaultTxTypes();
const USER = "555555555555555555";
const STAFF = "staff";
const START = 5_000_000;

/**
 * 買ったあとの状態変更も、実際に起きた事実だけを根拠に確定する。
 *
 * 1. 返金済み・取消済みの購入を、古い「完了」ボタンで配送済みに戻さない
 * 2. 同じ手動対応を二度「完了」にしない。存在しない購入を完了したことにしない
 * 3. 有限在庫を1つ消費した購入が未提供のまま返金されたら、その1つを一度だけ戻す
 * 4. 過去の購入が在庫を消費したか・手動配送だったかを、現在の商品設定から推測しない
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  let reevalItemId: number | null = null;
  const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
  const originalRoles = new OriginalRoles(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: START,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:fulfillment",
  });
  return {
    db,
    ledger,
    settings,
    events,
    shop,
    originalRoles,
    setReevalItem: (id: number | null) => {
      reevalItemId = id;
    },
  };
}

type Ctx = ReturnType<typeof setup>;

function makeItem(ctx: Ctx, over: Record<string, unknown> = {}) {
  return ctx.shop.createItem(
    {
      name: "手動対応の商品",
      price_land: 10_000,
      kind: "one_shot",
      delivery: "manual",
      ...over,
    } as never,
    STAFF,
  );
}

const AUTO = {
  delivery: "auto",
  delivery_kind: "add_role",
  delivery_data: JSON.stringify({ role_id: "r-x" }),
};

/** 再評価の販売商品は構成が固定されている（Coreがそれ以外を受け付けない）。 */
function makeReevalItem(ctx: Ctx, name: string) {
  return ctx.shop.createItem(
    {
      name,
      price_land: REEVAL_PRICE_LAND,
      price_alt_kind: "invite",
      price_alt_amount: REEVAL_INVITE_COUNT,
      kind: "one_shot",
      delivery: "manual",
    } as never,
    STAFF,
  );
}

/**
 * 購入時の記録が無い旧購入を、**本番にある形のまま**作る。
 * provenanceはappend-onlyなので、あとから消して作ることはできない（そこも仕様）。
 */
function legacyPurchase(ctx: Ctx, itemId: number, over: Record<string, unknown> = {}) {
  const info = ctx.db
    .prepare(
      "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew,delivery_state)" +
        " VALUES (?,?,?,?, 'active',0,'pending')",
    )
    .run(itemId, USER, 1_700_000_000, 10_000);
  const id = Number(info.lastInsertRowid);
  for (const [k, v] of Object.entries(over)) {
    ctx.db.prepare(`UPDATE shop_purchases SET ${k}=? WHERE id=?`).run(v as never, id);
  }
  return ctx.shop.getPurchase(id)!;
}

function buy(ctx: Ctx, itemId: number) {
  return ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(itemId).termsToken,
  }).purchase;
}

const delivered = (ctx: Ctx) => ctx.events.listByType("shop_delivered").length;
const restored = (ctx: Ctx) => ctx.events.listByType("shop_stock_restored").length;
const stockOf = (ctx: Ctx, itemId: number) => ctx.shop.getItem(itemId)!.stock;

describe("手動対応の完了 — 実際に遷移したときだけ完了にする", () => {
  it("未完了の手動購入は完了できる", () => {
    const ctx = setup();
    const purchase = buy(ctx, makeItem(ctx).id);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({ completed: true, reason: "completed" });

    const after = ctx.shop.getPurchase(purchase.id)!;
    expect(after.delivered_at).not.toBeNull();
    expect(after.delivery_state).toBe("delivered");
    expect(delivered(ctx)).toBe(1);
    ctx.db.close();
  });

  it("同じ完了を二度押しても、記録は1回だけ", () => {
    const ctx = setup();
    const purchase = buy(ctx, makeItem(ctx).id);
    ctx.shop.completeManualDelivery(purchase.id, STAFF);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({
      completed: false,
      reason: "already_delivered",
    });
    expect(delivered(ctx)).toBe(1);
    ctx.db.close();
  });

  it("存在しない購入では例外になり、配送eventを作らない", () => {
    const ctx = setup();

    expect(() => ctx.shop.completeManualDelivery(9_999, STAFF)).toThrow(/ERR_PURCHASE_NOT_FOUND/);
    expect(delivered(ctx)).toBe(0);
    ctx.db.close();
  });

  for (const status of ["refunded", "cancelled", "expired"] as const) {
    it(`${status} の購入は完了にできない（DB変更0・event0）`, () => {
      const ctx = setup();
      const purchase = buy(ctx, makeItem(ctx).id);
      ctx.db.prepare("UPDATE shop_purchases SET status=? WHERE id=?").run(status, purchase.id);

      expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({
        completed: false,
        reason: "not_active",
      });

      const after = ctx.shop.getPurchase(purchase.id)!;
      expect(after.delivered_at).toBeNull();
      expect(after.delivery_state).not.toBe("delivered");
      expect(after.status).toBe(status);
      expect(delivered(ctx)).toBe(0);
      ctx.db.close();
    });
  }

  it("自動配送だった購入は、genericな手動完了では終われない", () => {
    const ctx = setup();
    const purchase = buy(ctx, makeItem(ctx, { name: "自動の商品", ...AUTO }).id);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({ completed: false, reason: "not_manual" });
    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
    expect(delivered(ctx)).toBe(0);
    ctx.db.close();
  });

  it("購入時の事実が無い旧購入は legacy_unknown（推測して完了にしない）", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const purchase = legacyPurchase(ctx, item.id);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({
      completed: false,
      reason: "legacy_unknown",
    });
    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
    expect(delivered(ctx)).toBe(0);
    ctx.db.close();
  });

  it("配送スナップショットがある旧購入は、購入時autoだと証明できるので不明にしない", () => {
    // スナップショットは delivery='auto' のときしか作られない。
    // **あることは購入時autoの証明**（無いことは手動の証明にはならない）。
    const ctx = setup();
    const item = makeItem(ctx, { name: "自動の商品", ...AUTO });
    const purchase = legacyPurchase(ctx, item.id, {
      delivery_snapshot_json: JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: null }),
    });

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({ completed: false, reason: "not_manual" });
    // 「要確認」にも積まない（自動配送の再試行キューと二重に仕事が見えてしまう）
    expect(ctx.shop.listLegacyUnknownFulfillment().map((r) => r.id)).not.toContain(purchase.id);
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(0);
    expect(delivered(ctx)).toBe(0);
    ctx.db.close();
  });
});

describe("専用サービスをgenericな手動完了へ混ぜない", () => {
  it("再評価の権利は完了ボタンで消費できない", () => {
    const ctx = setup();
    const reeval = makeReevalItem(ctx, "再評価チャレンジ");
    ctx.setReevalItem(reeval.id);
    ctx.shop.registerReevaluationSaleItem(reeval.id);
    ctx.db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES (?, 'meirei', 1)").run(USER);
    const purchase = ctx.shop.purchaseReevaluation({
      itemId: reeval.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      mode: "land",
      idempotencyKey: "reeval:1",
    }).purchase;

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({ completed: false, reason: "not_manual" });
    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
    expect(delivered(ctx)).toBe(0);
    ctx.db.close();
  });

  it("販売商品がA→Bへ移っても、旧Aの権利は完了ボタンで消費できない", () => {
    const ctx = setup();
    const a = makeReevalItem(ctx, "再評価チャレンジ");
    ctx.setReevalItem(a.id);
    ctx.shop.registerReevaluationSaleItem(a.id);
    ctx.db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES (?, 'meirei', 1)").run(USER);
    const purchase = ctx.shop.purchaseReevaluation({
      itemId: a.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      mode: "land",
      idempotencyKey: "reeval:a",
    }).purchase;

    // 販売商品を差し替える。旧Aは現在の指定ではなくなる。
    const b = makeReevalItem(ctx, "再評価チャレンジ（再作成）");
    ctx.setReevalItem(b.id);
    ctx.shop.registerReevaluationSaleItem(b.id);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({ completed: false, reason: "not_manual" });
    expect(delivered(ctx)).toBe(0);
    ctx.db.close();
  });
});

describe("作業キューと完了APIが食い違わない", () => {
  it("一覧に出るものは必ず完了でき、完了APIが断るものは一覧に出ない", () => {
    const ctx = setup();
    const manual = makeItem(ctx, { name: "手動" });
    const auto = makeItem(ctx, { name: "自動", ...AUTO });
    const manualPurchase = buy(ctx, manual.id);
    const autoPurchase = buy(ctx, auto.id);
    const legacy = legacyPurchase(ctx, manual.id);

    const listed = ctx.shop.listPendingManual();
    expect(listed.map((r) => r.id)).toEqual([manualPurchase.id]);
    expect(ctx.shop.countPendingManual()).toBe(1);
    expect(ctx.shop.countPendingManual()).toBe(ctx.shop.listPendingManual({ limit: 1000 }).length);

    // 一覧のものは完了できる
    for (const row of listed) {
      expect(ctx.shop.completeManualDelivery(row.id, STAFF).completed).toBe(true);
    }
    // 出ていないものは完了APIが断る
    expect(ctx.shop.completeManualDelivery(autoPurchase.id, STAFF).completed).toBe(false);
    expect(ctx.shop.completeManualDelivery(legacy.id, STAFF).completed).toBe(false);

    // 旧購入は消えず、別枠に出る
    expect(ctx.shop.listLegacyUnknownFulfillment().map((r) => r.id)).toEqual([legacy.id]);
    expect(ctx.shop.countLegacyUnknownFulfillment()).toBe(1);
    ctx.db.close();
  });

  it("完了すると一覧からも件数からも消える", () => {
    const ctx = setup();
    const purchase = buy(ctx, makeItem(ctx).id);
    expect(ctx.shop.countPendingManual()).toBe(1);

    ctx.shop.completeManualDelivery(purchase.id, STAFF);

    expect(ctx.shop.listPendingManual()).toEqual([]);
    expect(ctx.shop.countPendingManual()).toBe(0);
    ctx.db.close();
  });
});

describe("在庫を消費した事実を購入時に残す", () => {
  it("有限在庫の購入は stock_consumed=1、在庫は1減る", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 5 });
    const purchase = buy(ctx, item.id);

    expect(stockOf(ctx, item.id)).toBe(4);
    const provenance = ctx.shop.fulfillmentProvenance(purchase.id)!;
    expect(provenance.stock_consumed).toBe(1);
    expect(provenance.delivery_mode).toBe("manual");
    expect(provenance.source).toBe("storefront");
    ctx.db.close();
  });

  it("無制限の購入は stock_consumed=0", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const purchase = buy(ctx, item.id);

    expect(stockOf(ctx, item.id)).toBeNull();
    expect(ctx.shop.fulfillmentProvenance(purchase.id)!.stock_consumed).toBe(0);
    ctx.db.close();
  });

  it("購入時の事実は上書きできない（append-only）", () => {
    const ctx = setup();
    const purchase = buy(ctx, makeItem(ctx, { stock: 2 }).id);

    expect(() =>
      ctx.db.prepare("UPDATE shop_purchase_fulfillment_provenance SET stock_consumed=0 WHERE purchase_id=?").run(purchase.id),
    ).toThrow(/append-only/);
    expect(() =>
      ctx.db.prepare("DELETE FROM shop_purchase_fulfillment_provenance WHERE purchase_id=?").run(purchase.id),
    ).toThrow(/append-only/);
    ctx.db.close();
  });
});

describe("未提供のまま返金したら、消費した1枠を一度だけ戻す", () => {
  it("有限在庫 + 未提供の返金 → 在庫はちょうど+1", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });
    const purchase = buy(ctx, item.id);
    expect(stockOf(ctx, item.id)).toBe(2);

    ctx.shop.refund(purchase.id, "配送できなかった", STAFF);

    expect(stockOf(ctx, item.id)).toBe(3);
    expect(ctx.shop.stockRestoration(purchase.id)).toMatchObject({ quantity: 1, applied: 1 });
    expect(restored(ctx)).toBe(1);
    ctx.db.close();
  });

  it("返金をやり直しても在庫は2回戻らない", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });
    const purchase = buy(ctx, item.id);
    ctx.shop.refund(purchase.id, "一度目", STAFF);
    expect(stockOf(ctx, item.id)).toBe(3);

    // 返金済みからの再実行（冪等）
    expect(ctx.shop.refund(purchase.id, "二度目", STAFF).refunded).toBe(false);
    // 状態を無理やり active へ戻して、もう一度返金経路を通す
    ctx.db.prepare("UPDATE shop_purchases SET status='active', delivery_state='pending' WHERE id=?").run(purchase.id);
    ctx.shop.refund(purchase.id, "三度目", STAFF);

    expect(stockOf(ctx, item.id)).toBe(3);
    expect(restored(ctx)).toBe(1);
    ctx.db.close();
  });

  it("無制限の購入を返金しても在庫は湧かない", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const purchase = buy(ctx, item.id);

    ctx.shop.refund(purchase.id, "配送できなかった", STAFF);

    expect(stockOf(ctx, item.id)).toBeNull();
    expect(ctx.shop.stockRestoration(purchase.id)).toBeUndefined();
    expect(restored(ctx)).toBe(0);
    ctx.db.close();
  });

  it("提供済みの購入はそもそも返金できない（在庫も戻らない）", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });
    const purchase = buy(ctx, item.id);
    ctx.shop.completeManualDelivery(purchase.id, STAFF);

    expect(() => ctx.shop.refund(purchase.id, "やっぱり", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);
    expect(stockOf(ctx, item.id)).toBe(2);
    expect(ctx.shop.stockRestoration(purchase.id)).toBeUndefined();
    ctx.db.close();
  });

  it("代替支払を含む購入は返金自体が止まる（在庫も動かない）", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });
    const purchase = buy(ctx, item.id);
    ctx.db.prepare("UPDATE shop_purchases SET paid_alt_kind='invite', paid_alt_amount=3 WHERE id=?").run(purchase.id);

    expect(() => ctx.shop.refund(purchase.id, "配送できなかった", STAFF)).toThrow(/ERR_ALT_REFUND_UNSUPPORTED/);
    expect(stockOf(ctx, item.id)).toBe(2);
    expect(ctx.shop.stockRestoration(purchase.id)).toBeUndefined();
    ctx.db.close();
  });

  it("購入時の事実が無い旧購入は、現在の在庫設定を見て戻さない", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });
    // 旧購入。当時在庫を消費したかどうかも、提供したかどうかも記録されていない。
    const purchase = legacyPurchase(ctx, item.id);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    // 提供したかどうかが分からないので、返金そのものが止まる（人の判断へ回す）
    expect(() => ctx.shop.refund(purchase.id, "配送できなかった", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);

    expect(stockOf(ctx, item.id)).toBe(3);
    expect(ctx.shop.stockRestoration(purchase.id)).toBeUndefined();
    expect(restored(ctx)).toBe(0);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.shop.getPurchase(purchase.id)!.status).toBe("active");
    ctx.db.close();
  });
});

describe("現在の在庫設定を過去の事実の根拠にしない", () => {
  it("購入時は有限 → いま無制限：数値は動かさず、戻すべきだった記録は残す", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 5 });
    const purchase = buy(ctx, item.id);
    expect(stockOf(ctx, item.id)).toBe(4);
    expect(ctx.shop.fulfillmentProvenance(purchase.id)!.stock_consumed).toBe(1);

    // 運営が無制限販売へ切り替えた
    setStock(ctx.shop, item.id, null, STAFF);

    ctx.shop.refund(purchase.id, "配送できなかった", STAFF);

    // NULL + 1 のような壊れ方をしない
    expect(stockOf(ctx, item.id)).toBeNull();
    // 「1枠を戻すべきだった」という事実は消えない
    expect(ctx.shop.stockRestoration(purchase.id)).toMatchObject({ quantity: 1, applied: 0 });
    // 購入時の事実も消えない
    expect(ctx.shop.fulfillmentProvenance(purchase.id)!.stock_consumed).toBe(1);
    ctx.db.close();
  });

  it("購入時は無制限 → いま有限：返金しても在庫は増えない", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const purchase = buy(ctx, item.id);
    expect(ctx.shop.fulfillmentProvenance(purchase.id)!.stock_consumed).toBe(0);

    // 運営があとから有限在庫にした
    setStock(ctx.shop, item.id, 10, STAFF);

    ctx.shop.refund(purchase.id, "配送できなかった", STAFF);

    expect(stockOf(ctx, item.id)).toBe(10);
    expect(ctx.shop.stockRestoration(purchase.id)).toBeUndefined();
    ctx.db.close();
  });
});

describe("提供と返金が競合しても矛盾しない", () => {
  it("完了が先に確定したら、返金は止まる", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });
    const purchase = buy(ctx, item.id);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF).completed).toBe(true);
    expect(() => ctx.shop.refund(purchase.id, "競合", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(stockOf(ctx, item.id)).toBe(2);
    expect(ctx.shop.stockRestoration(purchase.id)).toBeUndefined();
    ctx.db.close();
  });

  it("返金が先に確定したら、古い完了ボタンは何も動かさない", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });
    const purchase = buy(ctx, item.id);

    ctx.shop.refund(purchase.id, "先に返金", STAFF);
    const stockAfterRefund = stockOf(ctx, item.id);

    expect(ctx.shop.completeManualDelivery(purchase.id, STAFF)).toEqual({ completed: false, reason: "not_active" });

    const after = ctx.shop.getPurchase(purchase.id)!;
    expect(after.status).toBe("refunded");
    expect(after.delivered_at).toBeNull();
    expect(after.delivery_state).not.toBe("delivered");
    expect(delivered(ctx)).toBe(0);
    expect(stockOf(ctx, item.id)).toBe(stockAfterRefund);
    ctx.db.close();
  });
});
