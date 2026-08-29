import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, ShopError, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * 返金で戻すはずだった在庫（`applied=0`）の始末。
 *
 * Phase D で「無制限のあいだに返金されたので数値は動かさなかった」という事実は残るように
 * なったが、その後の扱いが無かった。有限在庫へ戻すときに黙って消すことも、黙って足すことも
 * しない——運営が入力した数の意味を、運営自身に選ばせる。
 */

registerDefaultTxTypes();
const STAFF = "system:test";
const USER = "u-stock";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 10_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:stock",
  });
  return { db, ledger, events, shop };
}
type Ctx = ReturnType<typeof setup>;

/** 有限在庫の単発商品 */
function item(ctx: Ctx, stock: number | null) {
  return ctx.shop.createItem(
    {
      name: "限定札",
      price_land: 100,
      kind: "one_shot",
      delivery: "manual",
      delivery_kind: "none",
      stock,
    } as never,
    STAFF,
  );
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

const stockOf = (ctx: Ctx, id: number) => ctx.shop.getItem(id)!.stock;

/** 無制限へ切り替える（在庫API経由。ここでは義務が無いので `none`） */
function goUnlimited(ctx: Ctx, itemId: number) {
  const q = ctx.shop.quoteStockChange(itemId, null);
  return ctx.shop.applyStockChange({
    itemId,
    requestedStock: null,
    reconciliationMode: "none",
    expectedToken: q.tokens.none!,
    actor: STAFF,
  });
}

describe("返金在庫の始末", () => {
  it("有限のまま返金されたら、その場で +1 される（始末の対象にならない）", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    expect(stockOf(ctx, it1.id)).toBe(2);

    ctx.shop.refund(p.id, "未提供のため", STAFF);

    expect(stockOf(ctx, it1.id)).toBe(3);
    expect(ctx.shop.stockRestoration(p.id)!.applied).toBe(1);
    // applied=1 は返金時に戻し済み。未処理としては出さない（二度戻さない）
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(0);
    ctx.db.close();
  });

  it("無制限のあいだに返金されたら applied=0 で、在庫は NULL のまま", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);

    ctx.shop.refund(p.id, "未提供のため", STAFF);

    expect(stockOf(ctx, it1.id)).toBeNull();
    expect(ctx.shop.stockRestoration(p.id)!.applied).toBe(0);
    expect(ctx.shop.pendingStockRestorations(it1.id)).toMatchObject({ count: 1, quantity: 1 });
    ctx.db.close();
  });

  it("final_stock は入力した数がそのまま最終在庫になる（勝手に上乗せしない）", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(p.id, "未提供のため", STAFF);

    const q = ctx.shop.quoteStockChange(it1.id, 5);
    expect(q.requiresReconciliation).toBe(true);
    expect(q.resultingStock.final_stock).toBe(5);
    expect(q.resultingStock.add_restorations).toBe(6);

    const result = ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 5,
      reconciliationMode: "final_stock",
      expectedToken: q.tokens.final_stock!,
      actor: STAFF,
    });

    expect(result.newStock).toBe(5);
    expect(stockOf(ctx, it1.id)).toBe(5);
    expect(ctx.shop.stockRestorationSettlement(p.id)!.disposition).toBe("absorbed");
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(0);
    ctx.db.close();
  });

  it("add_restorations は入力した数に返金分を上乗せする", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const a = buy(ctx, it1.id);
    const b = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(a.id, "未提供のため", STAFF);
    ctx.shop.refund(b.id, "未提供のため", STAFF);
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(2);

    const q = ctx.shop.quoteStockChange(it1.id, 5);
    const result = ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 5,
      reconciliationMode: "add_restorations",
      expectedToken: q.tokens.add_restorations!,
      actor: STAFF,
    });

    expect(result.newStock).toBe(7);
    expect(stockOf(ctx, it1.id)).toBe(7);
    expect(ctx.shop.stockRestorationSettlement(a.id)!.disposition).toBe("applied");
    expect(ctx.shop.stockRestorationSettlement(b.id)!.disposition).toBe("applied");
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(0);
    ctx.db.close();
  });

  it("同じ返金義務は二度始末できない", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(p.id, "未提供のため", STAFF);

    const q = ctx.shop.quoteStockChange(it1.id, 5);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 5,
      reconciliationMode: "add_restorations",
      expectedToken: q.tokens.add_restorations!,
      actor: STAFF,
    });
    expect(stockOf(ctx, it1.id)).toBe(6);

    // 同じ確認をもう一度押しても、義務はもう無いので指紋が合わない
    expect(() =>
      ctx.shop.applyStockChange({
        itemId: it1.id,
        requestedStock: 5,
        reconciliationMode: "add_restorations",
        expectedToken: q.tokens.add_restorations!,
        actor: STAFF,
      }),
    ).toThrow(ShopError);
    expect(stockOf(ctx, it1.id)).toBe(6);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_stock_restoration_settlements").pluck().get()).toBe(1);
    ctx.db.close();
  });

  it("表示したあとに返金が起きたら、古い確認では確定できない（1つも書かない）", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const a = buy(ctx, it1.id);
    const b = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(a.id, "未提供のため", STAFF);

    // 運営が「未処理1個」を見て確認を出した
    const stale = ctx.shop.quoteStockChange(it1.id, 5);
    // その後に別の返金が起きた
    ctx.shop.refund(b.id, "未提供のため", STAFF);

    expect(() =>
      ctx.shop.applyStockChange({
        itemId: it1.id,
        requestedStock: 5,
        reconciliationMode: "final_stock",
        expectedToken: stale.tokens.final_stock!,
        actor: STAFF,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_STOCK_TERMS_CHANGED" }));

    // 0 mutation
    expect(stockOf(ctx, it1.id)).toBeNull();
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_stock_restoration_settlements").pluck().get()).toBe(0);
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(2);

    // 取り直せば、増えた分が見えている
    expect(ctx.shop.quoteStockChange(it1.id, 5).pending.quantity).toBe(2);
    ctx.db.close();
  });

  it("件数も合計も同じでも、中身が入れ替わった義務では確定できない", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const a = buy(ctx, it1.id);
    const b = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(a.id, "未提供のため", STAFF);

    // 運営が「未処理1個（aの分）」を見て確認を出した
    const stale = ctx.shop.quoteStockChange(it1.id, 5);
    expect(stale.pending).toMatchObject({ count: 1, quantity: 1 });

    // その間に別の確定が走り、aの義務は始末された
    const other = ctx.shop.quoteStockChange(it1.id, 7);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 7,
      reconciliationMode: "final_stock",
      expectedToken: other.tokens.final_stock!,
      actor: STAFF,
    });
    // そして無制限へ戻され、別の返金(b)が入った
    const back = ctx.shop.quoteStockChange(it1.id, null);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: null,
      reconciliationMode: "none",
      expectedToken: back.tokens.none!,
      actor: STAFF,
    });
    ctx.shop.refund(b.id, "未提供のため", STAFF);

    // 在庫もNULL、未処理も1個・合計1 —— 数字だけ見ると表示時と同じに見える。
    // だが中身は a から b へ入れ替わっている
    const nowQuote = ctx.shop.quoteStockChange(it1.id, 5);
    expect(nowQuote.pending).toMatchObject({ count: 1, quantity: 1 });
    expect(nowQuote.pending.purchaseIds).not.toEqual(stale.pending.purchaseIds);

    expect(() =>
      ctx.shop.applyStockChange({
        itemId: it1.id,
        requestedStock: 5,
        reconciliationMode: "final_stock",
        expectedToken: stale.tokens.final_stock!,
        actor: STAFF,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_STOCK_TERMS_CHANGED" }));

    expect(stockOf(ctx, it1.id)).toBeNull();
    expect(ctx.shop.stockRestorationSettlement(b.id)).toBeUndefined();
    ctx.db.close();
  });

  it("有限へ確定したあとの返金は、これまでどおり +1 される", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);

    // 未処理ゼロのまま有限へ戻す
    const q = ctx.shop.quoteStockChange(it1.id, 5);
    expect(q.requiresReconciliation).toBe(false);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 5,
      reconciliationMode: "none",
      expectedToken: q.tokens.none!,
      actor: STAFF,
    });
    expect(stockOf(ctx, it1.id)).toBe(5);

    // そのあとの返金は有限在庫へ直接戻る
    ctx.shop.refund(p.id, "未提供のため", STAFF);
    expect(stockOf(ctx, it1.id)).toBe(6);
    expect(ctx.shop.stockRestoration(p.id)!.applied).toBe(1);
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(0);
    ctx.db.close();
  });

  it("無制限のままなら、未処理の義務は始末しない", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(p.id, "未提供のため", STAFF);

    const q = ctx.shop.quoteStockChange(it1.id, null);
    expect(q.requiresReconciliation).toBe(false);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: null,
      reconciliationMode: "none",
      expectedToken: q.tokens.none!,
      actor: STAFF,
    });

    expect(stockOf(ctx, it1.id)).toBeNull();
    expect(ctx.shop.stockRestorationSettlement(p.id)).toBeUndefined();
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(1);
    ctx.db.close();
  });

  it("汎用の updateItem では在庫を動かせない", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);

    expect(() => ctx.shop.updateItem(it1.id, { stock: 99 } as never, STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_STOCK_CHANGE_REQUIRES_API" }),
    );
    expect(stockOf(ctx, it1.id)).toBe(3);

    // 在庫以外は今までどおり更新できる
    ctx.shop.updateItem(it1.id, { name: "別名" } as never, STAFF);
    expect(ctx.shop.getItem(it1.id)!.name).toBe("別名");
    ctx.db.close();
  });

  it("購入時の記録が無い旧購入は、そもそも返金できない（在庫消費を推測しない）", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    // Phase D 以前の購入を模す。provenance は append-only なので消せない——
    // 「最初から記録が無い」行を直接作る
    const legacyId = ctx.db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state)
         VALUES (?,?,?,NULL,100,'active','pending') RETURNING id`,
      )
      .pluck()
      .get(it1.id, USER, Math.floor(Date.now() / 1000)) as number;
    expect(ctx.shop.fulfillmentProvenance(legacyId)).toBeUndefined();
    const before = stockOf(ctx, it1.id);

    // 「いま有限だから1枠使ったはず」と決めつけない。証明できないので返金自体を止める
    expect(() => ctx.shop.refund(legacyId, "未提供のため", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_FULFILLMENT_UNKNOWN" }),
    );

    expect(stockOf(ctx, it1.id)).toBe(before);
    expect(ctx.shop.stockRestoration(legacyId)).toBeUndefined();
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(0);
    ctx.db.close();
  });

  it("在庫を消費していない購入は、返金しても在庫を増やさない", () => {
    const ctx = setup();
    // 無制限で売った＝1枠も消費していない、という購入時の事実
    const it1 = item(ctx, null);
    const p = buy(ctx, it1.id);
    expect(ctx.shop.fulfillmentProvenance(p.id)!.stock_consumed).toBe(0);

    // そのあと運営が有限在庫にした
    const q = ctx.shop.quoteStockChange(it1.id, 5);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 5,
      reconciliationMode: "none",
      expectedToken: q.tokens.none!,
      actor: STAFF,
    });

    ctx.shop.refund(p.id, "未提供のため", STAFF);

    // 「いま有限だから戻すべき」ではない。購入時に消費していないので増やさない
    expect(stockOf(ctx, it1.id)).toBe(5);
    expect(ctx.shop.stockRestoration(p.id)).toBeUndefined();
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(0);
    ctx.db.close();
  });

  it("applied=1 の返金を、あとから有限へ戻すときに二重加算しない", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    ctx.shop.refund(p.id, "未提供のため", STAFF); // 有限のまま返金 → applied=1 / stock 3
    expect(stockOf(ctx, it1.id)).toBe(3);

    goUnlimited(ctx, it1.id);
    const q = ctx.shop.quoteStockChange(it1.id, 5);

    // applied=1 は未処理ではないので、2択そのものが出ない
    expect(q.pending.quantity).toBe(0);
    expect(q.requiresReconciliation).toBe(false);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 5,
      reconciliationMode: "none",
      expectedToken: q.tokens.none!,
      actor: STAFF,
    });
    expect(stockOf(ctx, it1.id)).toBe(5);
    ctx.db.close();
  });

  it("2択が要る場面では、選ばずに確定する手段が配られない", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(p.id, "未提供のため", STAFF);

    const q = ctx.shop.quoteStockChange(it1.id, 5);
    // 選ばずに確定するための指紋は、そもそも存在しない
    expect(q.tokens.none).toBeUndefined();
    expect(q.allowedModes).toEqual(["final_stock", "add_restorations"]);

    // 片方の指紋を別モードで使い回しても通らない
    expect(() =>
      ctx.shop.applyStockChange({
        itemId: it1.id,
        requestedStock: 5,
        reconciliationMode: "none",
        expectedToken: q.tokens.final_stock!,
        actor: STAFF,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_STOCK_TERMS_CHANGED" }));
    expect(() =>
      ctx.shop.applyStockChange({
        itemId: it1.id,
        requestedStock: 5,
        reconciliationMode: "add_restorations",
        expectedToken: q.tokens.final_stock!,
        actor: STAFF,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_STOCK_TERMS_CHANGED" }));

    expect(stockOf(ctx, it1.id)).toBeNull();
    expect(ctx.shop.pendingStockRestorations(it1.id).quantity).toBe(1);
    ctx.db.close();
  });

  it("既に有限の商品に未処理義務が残っていても、勝手に足さない", () => {
    const ctx = setup();
    const it1 = item(ctx, 3);
    const p = buy(ctx, it1.id);
    goUnlimited(ctx, it1.id);
    ctx.shop.refund(p.id, "未提供のため", STAFF);
    // migrationでは何も起きない。有限へ戻す操作のときだけ運営が選ぶ
    const reopened = openDb(":memory:");
    reopened.close();

    // 「今すでに有限」を模して、まず final_stock で 4 に確定する
    const q1 = ctx.shop.quoteStockChange(it1.id, 4);
    ctx.shop.applyStockChange({
      itemId: it1.id,
      requestedStock: 4,
      reconciliationMode: "final_stock",
      expectedToken: q1.tokens.final_stock!,
      actor: STAFF,
    });
    expect(stockOf(ctx, it1.id)).toBe(4);
    // 義務は始末済みなので、次の変更は普通の変更になる
    const q2 = ctx.shop.quoteStockChange(it1.id, 9);
    expect(q2.requiresReconciliation).toBe(false);
    ctx.db.close();
  });
});
