import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * 分からないため安全側で止まった購入を、**運営が事実を確認した上で決着させる。**
 *
 * 安全だから永久に止めてよい、ではない。ただし決着の根拠は durable に残す——
 * 何を見て何を変えたのか、あとから証明できないまま状態だけ動かさない。
 */

registerDefaultTxTypes();
const STAFF = "operator:1";
const OTHER = "operator:2";
const USER = "u-resolve";
const ROLE = "r-vip";

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
    idempotencyKey: "seed:resolve",
  });
  const item = shop.createItem(
    {
      name: "裏口",
      price_land: 100,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE }),
    } as never,
    STAFF,
  );
  return { db, ledger, events, shop, item };
}
type Ctx = ReturnType<typeof setup>;

const buy = (ctx: Ctx) =>
  ctx.shop.purchase({
    itemId: ctx.item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
  }).purchase;

/** 「投げたが結果が分からない」状態を作る */
function uncertain(ctx: Ctx, purchaseId: number) {
  const claim = ctx.shop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: "system" });
  const token = (claim as { token: string }).token;
  ctx.shop.markExternalDeliveryUncertain({ purchaseId, token, reason: "final_fetch_failed", actor: "system" });
  return token;
}

/** 購入時の記録が無い旧購入（legacy unknown） */
function legacyPurchase(ctx: Ctx) {
  const id = ctx.db
    .prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
       VALUES (?,?,?,100,'active','pending') RETURNING id`,
    )
    .pluck()
    .get(ctx.item.id, USER, 1) as number;
  return ctx.shop.getPurchase(id)!;
}

const landOf = (ctx: Ctx) => ctx.ledger.balanceOf(`user:${USER}`);
const resolutionsOf = (ctx: Ctx, id: number) => ctx.shop.operatorResolutions(id);

describe("運営による決着 — 外部配送の未確定", () => {
  it("提供済みを確認 → delivered をちょうど一度、返金は0", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    expect(quote.kind).toBe("uncertain_delivery");

    const result = ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "delivered",
      expectedToken: quote.token,
      actor: STAFF,
      note: "Discordでロールを確認",
    });

    expect(result.decision).toBe("delivered");
    expect(result.refunded).toBe(false);
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.externalDeliveryClaim(p.id)).toBeUndefined();
    // 決着はキューから消える
    expect(ctx.shop.countUnresolvedCases()).toBe(0);
    expect(ctx.shop.unresolvedCaseKind(p.id)).toBeNull();
    // 判断が台帳に残る
    expect(resolutionsOf(ctx, p.id)).toHaveLength(1);
    expect(resolutionsOf(ctx, p.id)[0]).toMatchObject({ decision: "delivered", operator_id: STAFF });
    ctx.db.close();
  });

  it("提供なしを確認 → 返金までちょうど一度", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    const result = ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: STAFF,
      refund: true,
    });

    expect(result.refunded).toBe(true);
    expect(result.refundedAmount).toBe(100);
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    expect(ctx.shop.externalDeliveryClaim(p.id)).toBeUndefined();
    expect(ctx.shop.countUnresolvedCases()).toBe(0);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("提供なしを確認だけ（返金しない）→ 再試行できる状態へ戻す", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    const result = ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: STAFF,
    });

    // 勝手に「返金したこと」にしない
    expect(result.refunded).toBe(false);
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    // claim は外れたので、再配送も返金もできる
    expect(ctx.shop.externalDeliveryClaim(p.id)).toBeUndefined();
    expect(ctx.shop.beginDelivery(p.id).proceed).toBe(true);
    ctx.db.close();
  });

  it("まだ判断できない → 状態は1つも変えない", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "still_unknown",
      expectedToken: quote.token,
      actor: STAFF,
      note: "Discordが不安定で確認できず",
    });

    expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("uncertain");
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(landOf(ctx)).toBe(before);
    // 確認待ちのまま残る
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    // ただし「見て、保留した」ことは残る
    expect(resolutionsOf(ctx, p.id)[0]!.decision).toBe("still_unknown");
    ctx.db.close();
  });

  it("画面を開いたあとに状況が変われば、1つも書かずに止まる", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const stale = ctx.shop.quoteOperatorResolution(p.id);
    const before = landOf(ctx);
    // 別の運営が先に決着させた
    const fresh = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: fresh.token, actor: OTHER });

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "no_effect",
        expectedToken: stale.token,
        actor: STAFF,
        refund: true,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));

    // 0 financial mutation / 0 status overwrite
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(resolutionsOf(ctx, p.id)).toHaveLength(1);
    ctx.db.close();
  });

  it("同じ決定を二度押しても、効くのは一度だけ", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: STAFF,
      refund: true,
    });
    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "no_effect",
        expectedToken: quote.token,
        actor: STAFF,
        refund: true,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));

    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    ctx.db.close();
  });

  it("決定の途中に返金が先に通っていたら、決着は通らない", () => {
    const ctx = setup();
    const p = buy(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    // まだ claim が無い状態の quote を持ったまま、別経路が返金した
    ctx.shop.refund(p.id, "別経路", OTHER);
    const before = landOf(ctx);

    expect(() =>
      ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: quote.token, actor: STAFF }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));

    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });

  it("決定の途中に失効が先に通っていたら、決着は通らない", () => {
    const ctx = setup();
    const p = buy(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);
    ctx.shop.expireIfDue(p.id, OTHER);

    expect(() =>
      ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: quote.token, actor: STAFF }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));

    expect(ctx.shop.getPurchase(p.id)!.status).toBe("expired");
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    ctx.db.close();
  });

  it("2人の運営が同時に決めても、結果は1つ", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    // 同じ画面を2人が開いた
    const a = ctx.shop.quoteOperatorResolution(p.id);
    const b = ctx.shop.quoteOperatorResolution(p.id);
    expect(a.token).toBe(b.token);

    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: a.token, actor: STAFF });
    expect(() =>
      ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "no_effect", expectedToken: b.token, actor: OTHER, refund: true }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(landOf(ctx)).toBe(before);
    expect(resolutionsOf(ctx, p.id)).toHaveLength(1);
    ctx.db.close();
  });

  it("提供済みと確定しながら返金する、はできない", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    // 「提供済み」と「返金」は両立しない。まとめて通したら、渡したうえで返すことになる
    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "delivered",
        expectedToken: quote.token,
        actor: STAFF,
        refund: true,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_NOT_APPLICABLE" }));

    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
    expect(resolutionsOf(ctx, p.id)).toHaveLength(0);

    // 保留しながら返金する、も同じく通さない
    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "still_unknown",
        expectedToken: quote.token,
        actor: STAFF,
        refund: true,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_NOT_APPLICABLE" }));
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });

  it("決着済みの案件はもう決着できない", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const q1 = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: q1.token, actor: STAFF });

    const q2 = ctx.shop.quoteOperatorResolution(p.id);
    expect(q2.kind).toBeNull();
    expect(q2.allowedDecisions).toEqual(["still_unknown"]);
    expect(() =>
      ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: q2.token, actor: OTHER }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_NOT_APPLICABLE" }));
    ctx.db.close();
  });

  it("決着の台帳は書き換えも削除もできない", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: quote.token, actor: STAFF });

    expect(() => ctx.db.prepare("UPDATE shop_operator_resolutions SET decision='no_effect'").run()).toThrow(/append-only/);
    expect(() => ctx.db.prepare("DELETE FROM shop_operator_resolutions").run()).toThrow(/append-only/);
    ctx.db.close();
  });
});

describe("運営による決着 — 旧購入の不明", () => {
  it("提供済みを確認 → 対応済みになる", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    expect(ctx.shop.unresolvedCaseKind(p.id)).toBe("legacy_unknown");
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "delivered",
      expectedToken: quote.token,
      actor: STAFF,
      note: "当時の対応記録を確認",
    });

    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("delivered");
    expect(ctx.shop.unresolvedCaseKind(p.id)).toBeNull();
    ctx.db.close();
  });

  it("提供なしを確認 → 返金できる（証拠が無いから止まっていたものが動く）", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    const before = landOf(ctx);
    // 証拠が無いので、そのままでは返金できない
    expect(() => ctx.shop.refund(p.id, "test", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_FULFILLMENT_UNKNOWN" }),
    );

    const quote = ctx.shop.quoteOperatorResolution(p.id);
    const result = ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: STAFF,
      refund: true,
      note: "Discord上に痕跡なし",
    });

    expect(result.refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    expect(ctx.shop.unresolvedCaseKind(p.id)).toBeNull();
    ctx.db.close();
  });

  it("まだ不明のままなら、状態は変わらない", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "still_unknown",
      expectedToken: quote.token,
      actor: STAFF,
    });

    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe("pending");
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.unresolvedCaseKind(p.id)).toBe("legacy_unknown");
    ctx.db.close();
  });

  it("現在の商品設定を変えても、旧購入の判断根拠は変わらない", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    const before = ctx.shop.quoteOperatorResolution(p.id);
    // 運営が商品の配送設定を変えた
    ctx.shop.updateItem(ctx.item.id, { delivery_data: JSON.stringify({ role_id: "r-other" }) } as never, STAFF);
    ctx.shop.updateItem(ctx.item.id, { delivery_kind: "set_nickname" } as never, STAFF);

    const after = ctx.shop.quoteOperatorResolution(p.id);
    expect(after.kind).toBe(before.kind);
    expect(after.deliveryKind).toBe(before.deliveryKind); // 購入時スナップショット（無い）を見る
    expect(after.token).toBe(before.token);
    ctx.db.close();
  });
});
