import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();
const USER = "444444444444444444";
const START = 1_000_000;

/**
 * generic storefrontの購入契約。
 *
 * 守る約束は4つ。
 * 1. 表示されていない金額・支払方法・商品内容では課金しない。
 * 2. 対応していない代替支払を、払ったことにして商品を渡さない。
 * 3. 代替支払が使えないからといって、Landへ勝手に切り替えない。
 * 4. 戻せると証明できない資産を、返金済み扱いにしない。
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
    actor: "test",
    approvedBy: "test",
    idempotencyKey: "seed:generic-terms",
  });
  return { db, ledger, events, shop };
}

type Ctx = ReturnType<typeof setup>;

function makeItem(ctx: Ctx, over: Record<string, unknown> = {}) {
  return ctx.shop.createItem(
    {
      name: "普通の商品",
      description: "説明",
      price_land: 10_000,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "role-a" }),
      ...over,
    } as never,
    "staff",
  );
}

const balance = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);
const purchaseCount = (ctx: Ctx) =>
  (ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get() as { n: number }).n;

/** 本番と同じ順序：まず契約を見せて、その契約で買う。 */
function buy(
  ctx: Ctx,
  itemId: number,
  expectedTermsToken: string = ctx.shop.quoteGenericPurchase(itemId).termsToken,
) {
  return ctx.shop.purchase({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken,
  });
}

/**
 * 型を迂回するcaller（JS・any経由・古い呼び出し）を再現する。
 * TypeScriptで必須にするだけでは、実行時に来る値を守れない。
 */
function buyRaw(ctx: Ctx, itemId: number, rawToken: unknown) {
  return (ctx.shop.purchase as (input: Record<string, unknown>) => unknown)({
    itemId,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: rawToken,
  });
}

describe("generic購入契約 — 表示した条件でしか課金しない", () => {
  it("契約が変わっていなければ、確認した内容のまま購入できる", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const quote = ctx.shop.quoteGenericPurchase(item.id);

    const result = buy(ctx, item.id, quote.termsToken);

    expect(result.purchase.paid_land).toBe(10_000);
    expect(balance(ctx)).toBe(START - 10_000);
    ctx.db.close();
  });

  it("在庫・販売状態はidentityに含めない（同じ契約のまま在庫だけ減っても買える）", () => {
    // stock/enabled/updated_atは「今売れるか」であって「何をいくらで売るか」ではない。
    // これをidentityに混ぜると、誰かが1つ買っただけで全員のボタンが無効になる。
    const ctx = setup();
    const item = makeItem(ctx, { stock: 5 });
    const before = ctx.shop.quoteGenericPurchase(item.id).termsToken;

    ctx.shop.updateItem(item.id, { stock: 4 } as never, "staff");
    expect(ctx.shop.quoteGenericPurchase(item.id).termsToken).toBe(before);

    ctx.shop.updateItem(item.id, { enabled: 0 } as never, "staff");
    expect(ctx.shop.quoteGenericPurchase(item.id).termsToken).toBe(before);
    ctx.db.close();
  });

  const CHANGES: Array<[string, Record<string, unknown>]> = [
    ["料金", { price_land: 12_000 }],
    ["期間", { duration_days: 30 }],
    ["提供方法", { delivery: "manual", delivery_kind: null, delivery_data: null }],
    ["提供内容", { delivery_data: JSON.stringify({ role_id: "role-b" }) }],
    ["購入条件（必要ロール）", { require_role_id: "role-gate" }],
    ["商品名", { name: "別の商品" }],
    ["説明", { description: "別の説明" }],
  ];

  for (const [label, patch] of CHANGES) {
    it(`${label}が変わったら、1 Ldも動かさずに止まる`, () => {
      const ctx = setup();
      const item = makeItem(ctx);
      const stale = ctx.shop.quoteGenericPurchase(item.id).termsToken;
      ctx.shop.updateItem(item.id, patch as never, "staff");

      expect(() => buy(ctx, item.id, stale)).toThrow(/ERR_TERMS_CHANGED/);
      expect(balance(ctx)).toBe(START);
      expect(purchaseCount(ctx)).toBe(0);
      ctx.db.close();
    });
  }

  it("販売停止・在庫切れは契約変更ではなく、それぞれの理由で止まる", () => {
    const ctx = setup();
    const disabled = makeItem(ctx);
    const disabledToken = ctx.shop.quoteGenericPurchase(disabled.id).termsToken;
    ctx.shop.updateItem(disabled.id, { enabled: 0 } as never, "staff");
    expect(() => buy(ctx, disabled.id, disabledToken)).toThrow(/ERR_ITEM_DISABLED/);

    const soldOut = makeItem(ctx, { name: "在庫あり商品", stock: 1 });
    const soldOutToken = ctx.shop.quoteGenericPurchase(soldOut.id).termsToken;
    buy(ctx, soldOut.id, soldOutToken);
    expect(() => buy(ctx, soldOut.id, soldOutToken)).toThrow(/ERR_NO_STOCK/);

    expect(balance(ctx)).toBe(START - 10_000);
    ctx.db.close();
  });
});

describe("generic購入契約 — 契約を見せた証拠なしに課金しない", () => {
  it("tokenを渡さないgeneric購入は成立しない", () => {
    // 型でも必須だが、型を迂回するcallerにも効かないと「Coreが最後の関門」にならない。
    const ctx = setup();
    const item = makeItem(ctx);

    expect(() => buyRaw(ctx, item.id, undefined)).toThrow(/ERR_TERMS_TOKEN_REQUIRED/);
    expect(balance(ctx)).toBe(START);
    expect(purchaseCount(ctx)).toBe(0);
    ctx.db.close();
  });

  it("空文字・形の違う値も「契約を見せた証拠」にはならない", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const valid = ctx.shop.quoteGenericPurchase(item.id).termsToken;

    for (const bad of ["", " ", null, 0, false, {}, [], "short", `${valid}x`, valid.slice(0, 15), valid + "="]) {
      expect(() => buyRaw(ctx, item.id, bad)).toThrow(/ERR_TERMS_TOKEN_REQUIRED/);
    }
    expect(balance(ctx)).toBe(START);
    expect(purchaseCount(ctx)).toBe(0);
    // 正しい形のtokenなら通る（上の拒否が「常に落ちる」のではないことを示す）
    expect(buy(ctx, item.id, valid).purchase.paid_land).toBe(10_000);
    ctx.db.close();
  });

  it("在庫・配送・delivery stateも一切動かない", () => {
    const ctx = setup();
    const item = makeItem(ctx, { stock: 3 });

    expect(() => buyRaw(ctx, item.id, undefined)).toThrow(/ERR_TERMS_TOKEN_REQUIRED/);

    expect(ctx.shop.getItem(item.id)!.stock).toBe(3);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='shop_purchase_log'").get()).toEqual({ n: 0 });
    ctx.db.close();
  });
});

describe("契約の指紋", () => {
  it("16文字のbase64url（96bit）である", () => {
    // 衝突は「契約が変わったのに見逃す」＝防ぎたい結果そのものなので、情報量を上げる。
    // Discordのcustom ID上限があるため文字数は増やせない。同じ16文字で、
    // hex(1文字4bit=64bit)ではなくbase64url(1文字6bit=96bit)を使う。
    const ctx = setup();
    const item = makeItem(ctx);
    const token = ctx.shop.quoteGenericPurchase(item.id).termsToken;

    expect(token).toHaveLength(16);
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // hexだけで構成されていたら64bitに落ちている疑いがある——複数商品で確認する
    const tokens = [token];
    for (const patch of [{ price_land: 1 }, { name: "b" }, { description: "c" }, { duration_days: 9 }]) {
      ctx.shop.updateItem(item.id, patch as never, "staff");
      tokens.push(ctx.shop.quoteGenericPurchase(item.id).termsToken);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(tokens.some((t) => /[^0-9a-f]/.test(t))).toBe(true);
    ctx.db.close();
  });

  it("同じ契約なら同じ指紋、違う契約なら違う指紋", () => {
    const ctx = setup();
    const item = makeItem(ctx);
    const first = ctx.shop.quoteGenericPurchase(item.id).termsToken;
    expect(ctx.shop.quoteGenericPurchase(item.id).termsToken).toBe(first);

    ctx.shop.updateItem(item.id, { price_land: 10_001 } as never, "staff");
    const changed = ctx.shop.quoteGenericPurchase(item.id).termsToken;
    expect(changed).not.toBe(first);

    ctx.shop.updateItem(item.id, { price_land: 10_000 } as never, "staff");
    expect(ctx.shop.quoteGenericPurchase(item.id).termsToken).toBe(first);
    ctx.db.close();
  });
});

describe("generic購入契約 — 払えない支払方法で売らない", () => {
  it("代替支払は成立しない（資源を消費する経路が無い）", () => {
    const ctx = setup();
    const item = makeItem(ctx, { price_land: null, price_alt_kind: "invite", price_alt_amount: 3 });

    expect(() =>
      ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], payAlt: true }),
    ).toThrow(/ERR_ALT_PAYMENT_UNSUPPORTED/);
    expect(purchaseCount(ctx)).toBe(0);
    expect(balance(ctx)).toBe(START);
    ctx.db.close();
  });

  it("代替支払が断られても、Landへ勝手に切り替えない", () => {
    // 利用者は「招待で払う」と言っている。断るなら断る。黙ってLandを引かない。
    const ctx = setup();
    const item = makeItem(ctx, { price_land: 10_000, price_alt_kind: "invite", price_alt_amount: 3 });

    expect(() =>
      ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(item.id).termsToken, itemId: item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], payAlt: true }),
    ).toThrow(/ERR_ALT_PAYMENT_UNSUPPORTED/);
    expect(balance(ctx)).toBe(START);
    expect(purchaseCount(ctx)).toBe(0);
    ctx.db.close();
  });

  it("代替支払の可否はCoreが答える（値段欄の有無を根拠にしない）", () => {
    const ctx = setup();
    const item = makeItem(ctx, { price_alt_kind: "invite", price_alt_amount: 3 });
    expect(item.price_alt_kind).toBe("invite");
    expect(ctx.shop.genericAltPaymentSupported(item.id)).toBe(false);
    ctx.db.close();
  });
});

describe("generic購入契約 — 戻せないものを返金済みにしない", () => {
  it("Land購入は今までどおり返金できる", () => {
    const ctx = setup();
    const item = makeItem(ctx, { delivery: "manual", delivery_kind: null, delivery_data: null });
    const bought = buy(ctx, item.id);

    ctx.shop.refund(bought.purchase.id, "test refund", "staff");

    expect(balance(ctx)).toBe(START);
    expect(ctx.shop.getPurchase(bought.purchase.id)!.status).toBe("refunded");
    ctx.db.close();
  });

  it("代替支払を含む購入はgeneric refundの対象外（0 Ldのまま返金済みと書かない）", () => {
    const ctx = setup();
    const item = makeItem(ctx, { delivery: "manual", delivery_kind: null, delivery_data: null });
    const info = ctx.db
      .prepare(
        "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,paid_alt_kind,paid_alt_amount,status,auto_renew)" +
          " VALUES (?,?,?,NULL,'invite',3,'active',0)",
      )
      .run(item.id, USER, 1_700_000_000);
    const purchaseId = Number(info.lastInsertRowid);

    expect(() => ctx.shop.refund(purchaseId, "test refund", "staff")).toThrow(/ERR_ALT_REFUND_UNSUPPORTED/);
    expect(ctx.shop.getPurchase(purchaseId)!.status).toBe("active");
    expect(balance(ctx)).toBe(START);
    ctx.db.close();
  });

  it("金額が壊れている代替支払（kindだけ・amountだけ）も返金済みにしない", () => {
    // 「片方だけ埋まっている」履歴は、何をどれだけ戻すべきか**証明できない**。
    // 証明できないものを「返金済み」と書かない。
    const ctx = setup();
    const item = makeItem(ctx, { delivery: "manual", delivery_kind: null, delivery_data: null });
    const insert = ctx.db.prepare(
      "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,paid_alt_kind,paid_alt_amount,status,auto_renew)" +
        " VALUES (?,?,?,NULL,?,?,'active',0)",
    );
    const kindOnly = Number(insert.run(item.id, USER, 1_700_000_000, "invite", null).lastInsertRowid);
    const amountOnly = Number(insert.run(item.id, USER, 1_700_000_000, null, 3).lastInsertRowid);

    expect(() => ctx.shop.refund(kindOnly, "test refund", "staff")).toThrow(/ERR_ALT_REFUND_UNSUPPORTED/);
    expect(() => ctx.shop.refund(amountOnly, "test refund", "staff")).toThrow(/ERR_ALT_REFUND_UNSUPPORTED/);
    expect(ctx.shop.getPurchase(kindOnly)!.status).toBe("active");
    expect(ctx.shop.getPurchase(amountOnly)!.status).toBe("active");
    ctx.db.close();
  });
});
