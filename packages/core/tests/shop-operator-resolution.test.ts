import { describe, expect, it, vi } from "vitest";
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
    const stateBefore = ctx.shop.getPurchase(p.id)!.delivery_state;
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
    // **決着は「外で提供された事実の確認」なので、配送そのものはやっていない。**
    // 工程の状態も配送eventも作らない——作れば、実行していない配送を実行したことにする
    expect(ctx.shop.getPurchase(p.id)!.delivery_state).toBe(stateBefore);
    expect(ctx.shop.getPurchase(p.id)!.delivered_at).toBeNull();
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    // 確認そのものが提供済みの正本になる
    expect(ctx.shop.safetySnapshot(p.id)!.fulfillment.evidence).toBe(true);
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
      note: "運営確認済み",
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

  it("決着の台帳が、実際に確定した結果と一致する", () => {
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
      note: "Discord上に痕跡なし",
    });

    // 実際に起きたこと
    const purchase = ctx.shop.getPurchase(p.id)!;
    expect(purchase.status).toBe("refunded");
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);

    // 台帳がそれと一致していること
    const rows = resolutionsOf(ctx, p.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.refunded).toBe(1);
    expect(row.note).toBe("Discord上に痕跡なし");
    const after = JSON.parse(row.after_state) as Record<string, unknown>;
    expect(after).toMatchObject({
      decision: "no_effect",
      status: "refunded",
      claimState: "released",
      refunded: true,
      refundedAmount: 100,
    });
    expect(after.deliveryState).toBe(purchase.delivery_state);
    ctx.db.close();
  });

  it("返金しない決着なら、台帳も refunded=0 になる", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "delivered",
      expectedToken: quote.token,
      actor: STAFF,
      note: "ロールを目視確認",
    });

    const row = resolutionsOf(ctx, p.id)[0]!;
    expect(row.refunded).toBe(0);
    const after = JSON.parse(row.after_state) as Record<string, unknown>;
    expect(after).toMatchObject({ decision: "delivered", status: "active", claimState: "settled", refunded: false });
    // 工程の状態は決着で動かないので、監査行にも動かない値が残る
    expect(after.deliveryState).toBe(ctx.shop.getPurchase(p.id)!.delivery_state);
    ctx.db.close();
  });

  it("同じ購入が複数の条件に当てはまっても、件数は一覧と一致する", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    // 旧購入の不明に加えて、外部配送の未確定も付く
    uncertain(ctx, p.id);

    expect(ctx.shop.countUnresolvedCases()).toBe(ctx.shop.listUnresolvedCases({ limit: 100 }).length);
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
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
      note: "運営確認済み",
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
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: fresh.token, actor: OTHER , note: "運営確認済み" });

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "no_effect",
        expectedToken: stale.token,
        actor: STAFF,
        note: "運営確認済み",
        refund: true,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));

    // 0 financial mutation / 0 status overwrite
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    // 先に通った決着だけが証拠として立っている（2つ目は1行も書いていない）
    expect(ctx.shop.safetySnapshot(p.id)!.operatorCase.decided).toBe("delivered");
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
      note: "運営確認済み",
      refund: true,
    });
    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "no_effect",
        expectedToken: quote.token,
        actor: STAFF,
        note: "運営確認済み",
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
      ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: quote.token, actor: STAFF , note: "運営確認済み" }),
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
      ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: quote.token, actor: STAFF , note: "運営確認済み" }),
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

    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: a.token, actor: STAFF , note: "運営確認済み" });
    expect(() =>
      ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "no_effect", expectedToken: b.token, actor: OTHER, refund: true , note: "運営確認済み" }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));

    expect(ctx.shop.safetySnapshot(p.id)!.operatorCase.decided).toBe("delivered");
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
        note: "運営確認済み",
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
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: q1.token, actor: STAFF , note: "運営確認済み" });

    const q2 = ctx.shop.quoteOperatorResolution(p.id);
    expect(q2.kind).toBeNull();
    // **決着済みには何も足せない。** UIがボタンを出さないことは authority ではない
    expect(q2.allowedDecisions).toEqual([]);
    const beforeRows = resolutionsOf(ctx, p.id).length;

    for (const decision of ["delivered", "no_effect", "still_unknown"] as const) {
      expect(() =>
        ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision, expectedToken: q2.token, actor: OTHER , note: "運営確認済み" }),
      ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_NOT_APPLICABLE" }));
    }

    // 偽の監査行を1つも足せない
    expect(resolutionsOf(ctx, p.id)).toHaveLength(beforeRows);
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_operator_resolutions WHERE kind='legacy_unknown'").pluck().get(),
    ).toBe(0);
    ctx.db.close();
  });

  it("決着の台帳は書き換えも削除もできない", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({ purchaseId: p.id, decision: "delivered", expectedToken: quote.token, actor: STAFF , note: "運営確認済み" });

    expect(() => ctx.db.prepare("UPDATE shop_operator_resolutions SET decision='no_effect'").run()).toThrow(/append-only/);
    expect(() => ctx.db.prepare("DELETE FROM shop_operator_resolutions").run()).toThrow(/append-only/);
    ctx.db.close();
  });
});

describe("根拠が無ければ決着させない（Core側のauthority）", () => {
  for (const [label, note] of [["空文字", ""], ["空白だけ", "   \n\t "]] as const) {
    for (const decision of ["delivered", "no_effect"] as const) {
      it(`${decision} + ${label} → 何も変えずに拒否する`, () => {
        const ctx = setup();
        const p = buy(ctx);
        uncertain(ctx, p.id);
        const before = landOf(ctx);
        const quote = ctx.shop.quoteOperatorResolution(p.id);

        expect(() =>
          ctx.shop.resolveOperatorCase({
            purchaseId: p.id,
            decision,
            expectedToken: quote.token,
            actor: STAFF,
            note,
          }),
        ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_EVIDENCE_REQUIRED" }));

        // 資産・状態・配送・claim・台帳のどれも動かない
        expect(landOf(ctx)).toBe(before);
        expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
        expect(ctx.shop.getPurchase(p.id)!.delivery_state).not.toBe("delivered");
        expect(ctx.shop.externalDeliveryClaim(p.id)!.state).toBe("uncertain");
        expect(resolutionsOf(ctx, p.id)).toHaveLength(0);
        expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
        ctx.db.close();
      });
    }
  }

  it("no_effect + 返金 + 根拠なし → 返金も走らない", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "no_effect",
        expectedToken: quote.token,
        actor: STAFF,
        note: "  ",
        refund: true,
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_EVIDENCE_REQUIRED" }));

    expect(landOf(ctx)).toBe(before);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("still_unknown は根拠が無くてもよい", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    const result = ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "still_unknown",
      expectedToken: quote.token,
      actor: STAFF,
    });

    expect(result.decision).toBe("still_unknown");
    expect(resolutionsOf(ctx, p.id)[0]!.note).toBeNull();
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    ctx.db.close();
  });

  it("根拠があれば通常どおり決着する", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "delivered",
      expectedToken: quote.token,
      actor: STAFF,
      note: "  ロールを確認  ",
    });

    // 前後の空白は落として保存する
    expect(resolutionsOf(ctx, p.id)[0]!.note).toBe("ロールを確認");
    expect(ctx.shop.safetySnapshot(p.id)!.fulfillment.evidence).toBe(true);
    ctx.db.close();
  });
});

describe("返金の未完了は「まだ返せていない」ものだけ", () => {
  function refundFailed(ctx: Ctx) {
    const p = buy(ctx);
    ctx.shop.markDeliveryFailed(p.id, "role_add_failed", "system");
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    return p;
  }

  it("返金に失敗したら出る", () => {
    const ctx = setup();
    const p = refundFailed(ctx);
    expect(ctx.shop.countRefundFailures()).toBe(1);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(true);
    ctx.db.close();
  });

  it("そのあと提供済みになったら消える（返金のやり直しもできない）", () => {
    const ctx = setup();
    const p = refundFailed(ctx);
    ctx.shop.beginDelivery(p.id);
    ctx.shop.markDeliverySucceeded(p.id, STAFF);

    // active のままだが、提供済みなので「返金の未完了」ではない
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.listRefundFailures()).toHaveLength(0);
    const quote = ctx.shop.quoteRefundRetry(p.id);
    expect(quote.open).toBe(false);
    expect(() => ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF })).toThrow(
      expect.objectContaining({ code: "ERR_RESOLUTION_NOT_APPLICABLE" }),
    );
    ctx.db.close();
  });

  it("返金済みになったら消える", () => {
    const ctx = setup();
    const p = refundFailed(ctx);
    ctx.shop.refund(p.id, "別経路", STAFF);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(false);
    ctx.db.close();
  });

  it("期限が来ても、返し終わるまでは失効させない（消えない）", () => {
    const ctx = setup();
    const p = refundFailed(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);

    // **失効させない。** 失効させると refund() が active からしか動けないので復旧不能になる
    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.countRefundFailures()).toBe(1);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(true);

    // 返し終われば、そのあとは普通に失効できる
    const quote = ctx.shop.quoteRefundRetry(p.id);
    ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF });
    expect(ctx.shop.countRefundFailures()).toBe(0);
    ctx.db.close();
  });

  it("提供済みで返さないのが正しい場合は、返金義務を作らない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.beginDelivery(p.id);
    ctx.shop.markDeliverySucceeded(p.id, STAFF);
    const before = landOf(ctx);

    // 提供済みなので返金は拒否される。**これは「返せていない義務」ではない**
    expect(() => ctx.shop.refundOrRecordFailure(p.id, "delivery_failed", "system")).toThrow(
      expect.objectContaining({ code: "ERR_ALREADY_DELIVERED" }),
    );

    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures").pluck().get()).toBe(0);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(false);
    expect(landOf(ctx)).toBe(before);
    ctx.db.close();
  });

  it("やり直してまた失敗したら、その事実が残る", () => {
    const ctx = setup();
    const p = refundFailed(ctx);
    const rows = () => ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(p.id);
    expect(rows()).toBe(1);

    const spy = () => {
      throw new Error("ledger unavailable");
    };
    const original = ctx.shop.refund.bind(ctx.shop);
    (ctx.shop as unknown as { refund: unknown }).refund = spy;
    const q1 = ctx.shop.quoteRefundRetry(p.id);
    expect(() => ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: q1.token, actor: STAFF })).toThrow();
    // **記録が巻き戻らない**
    expect(rows()).toBe(2);

    const q2 = ctx.shop.quoteRefundRetry(p.id);
    // 失敗が増えたので古いボタンは通らない
    expect(q2.token).not.toBe(q1.token);
    expect(() => ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: q1.token, actor: STAFF })).toThrow(
      expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }),
    );
    expect(() => ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: q2.token, actor: STAFF })).toThrow();
    expect(rows()).toBe(3);

    // まだ active・1件の案件として残る
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.countRefundFailures()).toBe(1);

    // 記録は書き換えも削除もできない
    expect(() => ctx.db.prepare("UPDATE shop_refund_failures SET reason='x'").run()).toThrow(/append-only/);
    expect(() => ctx.db.prepare("DELETE FROM shop_refund_failures").run()).toThrow(/append-only/);

    // 復旧すればちょうど一度だけ返る
    (ctx.shop as unknown as { refund: unknown }).refund = original;
    const before = landOf(ctx);
    const q3 = ctx.shop.quoteRefundRetry(p.id);
    expect(ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: q3.token, actor: STAFF }).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(1);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    ctx.db.close();
  });
});

describe("返すべき金は、期限が来ても消えない", () => {
  /** 有期限の購入を作り、配送失敗 → 返金失敗まで進める */
  function owedAndExpiring(ctx: Ctx) {
    const p = buy(ctx);
    ctx.shop.markDeliveryFailed(p.id, "role_add_failed", "system");
    const original = ctx.ledger.transfer.bind(ctx.ledger);
    (ctx.ledger as unknown as { transfer: unknown }).transfer = () => {
      throw new Error("ledger unavailable");
    };
    const outcome = ctx.shop.refundOrRecordFailure(p.id, "delivery_failed", "system");
    (ctx.ledger as unknown as { transfer: unknown }).transfer = original;
    expect(outcome).toMatchObject({ failed: true });
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);
    return p;
  }

  it("返金の未完了がある購入は失効しない", () => {
    const ctx = setup();
    const p = owedAndExpiring(ctx);
    const before = landOf(ctx);

    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    const sweep = ctx.shop.expireOverdue(STAFF);
    expect(sweep.expired.map((r) => r.id)).not.toContain(p.id);

    // 金は返っていない／義務は残る／キューから消えない／復旧できる
    expect(landOf(ctx)).toBe(before);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.countRefundFailures()).toBe(1);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(true);

    const quote = ctx.shop.quoteRefundRetry(p.id);
    expect(ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF }).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    ctx.db.close();
  });

  it("何度巡回しても失効せず、再起動後も復旧できる", () => {
    const ctx = setup();
    const p = owedAndExpiring(ctx);
    for (let i = 0; i < 5; i += 1) ctx.shop.expireOverdue(STAFF);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");

    // 別インスタンス（再起動相当）から見ても同じ
    const fresh = new Shop(ctx.db, ctx.ledger, ctx.events);
    expect(fresh.countRefundFailures()).toBe(1);
    expect(fresh.quoteRefundRetry(p.id).open).toBe(true);
    expect(fresh.expireIfDue(p.id, STAFF).reason).toBe("refund_pending");
    ctx.db.close();
  });

  it("返金の試行と義務の記録の間に失効が割り込めない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.markDeliveryFailed(p.id, "role_add_failed", "system");
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);

    let interleaved = false;
    const original = ctx.ledger.transfer.bind(ctx.ledger);
    (ctx.ledger as unknown as { transfer: unknown }).transfer = () => {
      // 同じ transaction の中で失効を走らせる
      interleaved = true;
      ctx.shop.expireIfDue(p.id, "system:sweep");
      throw new Error("ledger unavailable");
    };
    const outcome = ctx.shop.refundOrRecordFailure(p.id, "delivery_failed", "system");
    (ctx.ledger as unknown as { transfer: unknown }).transfer = original;

    expect(interleaved).toBe(true);
    expect(outcome).toMatchObject({ failed: true });
    // **義務は残り、購入は active のまま。** 復旧不能な expired にならない
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.shop.countRefundFailures()).toBe(1);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(true);
    ctx.db.close();
  });

  it("義務が無ければ、期限どおり失効する", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(p.id);
    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: true, reason: "expired" });
    ctx.db.close();
  });
});

describe("止められた行が、失効の巡回を詰まらせない", () => {
  /** overdue だが「今は動かせない」購入を n 件作る（古い順に並ぶ） */
  function guardedOverdue(ctx: Ctx, n: number, kind: "refund" | "claim"): number[] {
    const ids: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = ctx.db
        .prepare(
          `INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivery_snapshot_json)
           VALUES (?,?,?,?,100,'active','failed',?) RETURNING id`,
        )
        .pluck()
        .get(ctx.item.id, `${USER}-g${i}`, i + 1, i + 1, JSON.stringify({ delivery_kind: "add_role", delivery_data: { role_id: ROLE } })) as number;
      if (kind === "refund") {
        ctx.shop.recordRefundFailure({ purchaseId: id, amount: 100, reason: "delivery_failed", actor: "system" });
      } else {
        const claim = ctx.shop.claimExternalDelivery({ purchaseId: id, deliveryKind: "add_role", actor: "system" });
        ctx.shop.markExternalDeliveryUncertain({
          purchaseId: id,
          token: (claim as { token: string }).token,
          reason: "final_fetch_failed",
          actor: "system",
        });
      }
      ids.push(id);
    }
    return ids;
  }

  /**
   * 普通に失効できる overdue 購入（止められた行より新しい期限）。
   *
   * **実際に買って実際に配る。** 直接INSERTした行は購入時 provenance を持たないので
   * 「何を与えたか証明できない旧購入」扱いになり、失効しても剥奪キューへ載らない。
   * それでは「後処理まで届いた」ことを確かめたことにならない。
   */
  function plainOverdue(ctx: Ctx, seq: number): number {
    const purchase = buy(ctx);
    ctx.shop.beginDelivery(purchase.id);
    ctx.shop.markDeliverySucceeded(purchase.id, "system:test");
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=? WHERE id=?").run(100_000 + seq, purchase.id);
    return purchase.id;
  }

  it("返金待ちが200件あっても、その後ろの期限切れへ到達できる", () => {
    const ctx = setup();
    const guarded = guardedOverdue(ctx, 200, "refund");
    const plain = plainOverdue(ctx, 1);

    // 既定の limit（200）で1回だけ回す
    const result = ctx.shop.expireOverdue(STAFF);

    // 止められた200件は active のまま
    for (const id of guarded) expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    expect(ctx.shop.countRefundFailures()).toBe(200);
    // **後ろの普通の購入へ到達できている**
    expect(result.expired.map((r) => r.id)).toContain(plain);
    expect(ctx.shop.getPurchase(plain)!.status).toBe("expired");
    // 通常の後処理（剥奪キュー）も走っている
    expect(ctx.shop.pendingRoleRevocations().map((r) => r.purchase_id)).toContain(plain);
    ctx.db.close();
  });

  it("配送中が200件あっても、その後ろの期限切れへ到達できる", () => {
    const ctx = setup();
    const guarded = guardedOverdue(ctx, 200, "claim");
    const plain = plainOverdue(ctx, 1);

    const result = ctx.shop.expireOverdue(STAFF);

    for (const id of guarded) expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    expect(result.expired.map((r) => r.id)).toContain(plain);
    expect(ctx.shop.getPurchase(plain)!.status).toBe("expired");
    ctx.db.close();
  });

  it("最終判断は expireIfDue に残っている（候補選択だけを安全境界にしない）", () => {
    const ctx = setup();
    const [id] = guardedOverdue(ctx, 1, "refund");
    // 候補選択を通り越して直接呼んでも止まる
    expect(ctx.shop.expireIfDue(id!, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    const [claimed] = guardedOverdue(ctx, 1, "claim");
    expect(ctx.shop.expireIfDue(claimed!, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });
    ctx.db.close();
  });
});

describe("返金義務が閉じた購入は、また失効できる", () => {
  /**
   * 一度返金に失敗しても、**あとから提供が成功すれば返金の義務は消える**。
   * 既存の回帰（`countRefundFailures()===0` / `quoteRefundRetry().open===false`）が
   * それを正本として決めている。失効の候補選択がそれと違う意味を持つと、
   * 「もう返す必要は無いのに、失効も剥奪判断も永久に来ない」購入ができる。
   */
  function refundFailedThenDelivered(ctx: Ctx) {
    const purchase = buy(ctx);
    ctx.shop.recordRefundFailure({
      purchaseId: purchase.id,
      amount: 100,
      reason: "delivery_failed",
      actor: "system",
    });
    expect(ctx.shop.countRefundFailures()).toBe(1);
    // あとから提供が成功した＝返す理由が無くなった
    ctx.shop.beginDelivery(purchase.id);
    ctx.shop.markDeliverySucceeded(purchase.id, "system:test");
    return purchase.id;
  }

  it("自動決着の対応記録があっても、提供が成功していれば期限で失効する", () => {
    const ctx = setup();
    const id = refundFailedThenDelivered(ctx);

    // 正本の判定では、もう返金の未完了ではない
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.quoteRefundRetry(id).open).toBe(false);

    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(id);
    const result = ctx.shop.expireOverdue(STAFF);

    // **候補に入り、失効し、通常の後処理まで進む**
    expect(result.expired.map((r) => r.id)).toContain(id);
    expect(ctx.shop.getPurchase(id)!.status).toBe("expired");
    expect(
      ctx.events
        .listByType("shop_expired")
        .some((e) => (JSON.parse(e.payload_json ?? "{}") as { purchaseId?: number }).purchaseId === id),
    ).toBe(true);
    expect(ctx.shop.pendingRoleRevocations().map((r) => r.purchase_id)).toContain(id);
    ctx.db.close();
  });

  it("履歴の有無ではなく、いま返す義務があるかで止める", () => {
    const ctx = setup();
    const closed = refundFailedThenDelivered(ctx);
    // 同じ利用者の月額は二重に持てないので、義務が open な方は別の利用者で作る
    const other = "u-resolve-2";
    ctx.ledger.ensureAccount(`user:${other}`, "user");
    ctx.ledger.transfer({
      from: TREASURY,
      to: `user:${other}`,
      amount: 10_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed:resolve-2",
    });
    const open = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: other,
      actor: `user:${other}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
    }).purchase.id;
    ctx.shop.recordRefundFailure({ purchaseId: open, amount: 100, reason: "delivery_failed", actor: "system" });

    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id IN (?,?)").run(closed, open);
    const result = ctx.shop.expireOverdue(STAFF);

    expect(result.expired.map((r) => r.id)).toEqual([closed]);
    expect(ctx.shop.getPurchase(open)!.status).toBe("active");
    // 最終判断も同じ意味
    expect(ctx.shop.expireIfDue(open, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    ctx.db.close();
  });
});

describe("決着は「どの claim を閉じるのか」を検証する", () => {
  /** 生きている claim を1つ持った、配送失敗直前の購入 */
  function claimed(ctx: Ctx) {
    const purchase = buy(ctx);
    const claim = ctx.shop.claimExternalDelivery({
      purchaseId: purchase.id,
      deliveryKind: "add_role",
      actor: "system",
    });
    return { id: purchase.id, token: (claim as { token: string }).token };
  }

  const snapshot = (ctx: Ctx, id: number) => ({
    status: ctx.shop.getPurchase(id)!.status,
    deliveryState: ctx.shop.getPurchase(id)!.delivery_state,
    balance: ctx.ledger.balanceOf(`user:${USER}`),
    obligations: ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(id) as number,
    refunds: ctx.events.listByType("shop_refunded").length,
    attempts: ctx.db
      .prepare("SELECT attempt_token, state FROM shop_external_delivery_attempts WHERE purchase_id=? ORDER BY attempt_token")
      .all(id),
  });

  const settle = (ctx: Ctx, id: number, token: string | null) =>
    ctx.shop.settleVerifiedFailure({ purchaseId: id, claimToken: token, reason: "delivery_failed", actor: "system" });

  it("生きている claim をちょうど1件閉じて、返金まで進む", () => {
    const ctx = setup();
    const { id, token } = claimed(ctx);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    expect(settle(ctx, id, token)).toEqual({ refunded: true, amount: 100 });

    expect(ctx.shop.getPurchase(id)!.status).toBe("refunded");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before + 100);
    expect(ctx.shop.externalDeliveryInFlight(id)).toBe(false);
    ctx.db.close();
  });

  it("知らない token では、1つも書かない", () => {
    const ctx = setup();
    const { id } = claimed(ctx);
    const before = snapshot(ctx, id);

    expect(() => settle(ctx, id, "not-a-real-token")).toThrow(/ERR_CLAIM_UNKNOWN/);

    expect(snapshot(ctx, id)).toEqual(before);
    ctx.db.close();
  });

  it("既に解放された token では、1つも書かない", () => {
    const ctx = setup();
    const { id, token } = claimed(ctx);
    ctx.shop.releaseExternalDelivery({ purchaseId: id, token, reason: "retry", actor: "system" });
    const before = snapshot(ctx, id);

    expect(() => settle(ctx, id, token)).toThrow(/ERR_CLAIM_STALE/);

    expect(snapshot(ctx, id)).toEqual(before);
    ctx.db.close();
  });

  it("既に決着済みなら、二重に書かずにその結末を返す", () => {
    const ctx = setup();
    const { id, token } = claimed(ctx);
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    expect(settle(ctx, id, token)).toEqual({ refunded: true, amount: 100 });
    const after = snapshot(ctx, id);

    // 同じ token でもう一度呼んでも、返金は増えない
    expect(settle(ctx, id, token)).toEqual({ refunded: true, amount: 100 });

    expect(snapshot(ctx, id)).toEqual(after);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before + 100);
    expect(ctx.events.listByType("shop_refunded").length).toBe(1);
    ctx.db.close();
  });

  it("返金の義務が既に立っているなら、積み増さずにその事実を返す", () => {
    const ctx = setup();
    const { id, token } = claimed(ctx);
    const spy = vi.spyOn(ctx.ledger, "transfer").mockImplementation(() => {
      throw new Error("ledger unavailable");
    });
    const first = settle(ctx, id, token);
    spy.mockRestore();
    expect(first).toMatchObject({ failed: true });
    const after = snapshot(ctx, id);

    const again = settle(ctx, id, token);

    expect(again).toMatchObject({ failed: true });
    expect(snapshot(ctx, id)).toEqual(after);
    expect(ctx.shop.countRefundFailures()).toBe(1);
    ctx.db.close();
  });

  it("別の claim が生きているなら、古い呼び出しには何も書かせない", () => {
    const ctx = setup();
    const { id, token: tokenA } = claimed(ctx);
    // A を片付けて、B を新しく取る（同時に生きている claim は1つだけ）
    ctx.shop.releaseExternalDelivery({ purchaseId: id, token: tokenA, reason: "retry", actor: "system" });
    const claimB = ctx.shop.claimExternalDelivery({ purchaseId: id, deliveryKind: "add_role", actor: "system" });
    const tokenB = (claimB as { token: string }).token;
    const before = snapshot(ctx, id);

    expect(() => settle(ctx, id, tokenA)).toThrow(/ERR_CLAIM_SUPERSEDED/);

    // 資産も配送状態も claim も動いていない
    expect(snapshot(ctx, id)).toEqual(before);
    expect(ctx.shop.externalDeliveryInFlight(id)).toBe(true);
    // B は生きたまま。正しい token なら通る
    expect(settle(ctx, id, tokenB)).toEqual({ refunded: true, amount: 100 });
    ctx.db.close();
  });

  it("「purchase が active だから」を理由に続けない", () => {
    const ctx = setup();
    const { id, token: tokenA } = claimed(ctx);
    ctx.shop.releaseExternalDelivery({ purchaseId: id, token: tokenA, reason: "retry", actor: "system" });
    ctx.shop.claimExternalDelivery({ purchaseId: id, deliveryKind: "add_role", actor: "system" });

    // 購入は active のまま——それでも古い token は通さない
    expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    expect(() => settle(ctx, id, tokenA)).toThrow(/ERR_CLAIM_SUPERSEDED/);
    ctx.db.close();
  });
});

describe("決着させた旧購入は、もう「不明」に戻らない", () => {
  it("提供なしで決着したら決着キューから消える", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: STAFF,
      note: "痕跡なし",
    });

    expect(ctx.shop.unresolvedCaseKind(p.id)).toBeNull();
    expect(ctx.shop.countUnresolvedCases()).toBe(0);
    expect(ctx.shop.listUnresolvedCases({ limit: 100 })).toHaveLength(0);

    // 別の決着を後から足せない
    const fresh = ctx.shop.quoteOperatorResolution(p.id);
    expect(fresh.kind).toBeNull();
    expect(fresh.allowedDecisions).toEqual([]);
    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: p.id,
        decision: "delivered",
        expectedToken: fresh.token,
        actor: OTHER,
        note: "やっぱり提供済み",
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_NOT_APPLICABLE" }));

    // 残した確認は後続の返金の証拠として使える
    const before = landOf(ctx);
    expect(ctx.shop.refund(p.id, "運営確認済み", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
    ctx.db.close();
  });

  it("提供済みで決着しても消える", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "delivered",
      expectedToken: quote.token,
      actor: STAFF,
      note: "記録を確認",
    });
    expect(ctx.shop.countUnresolvedCases()).toBe(0);
    ctx.db.close();
  });

  it("保留のままなら残る", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "still_unknown",
      expectedToken: quote.token,
      actor: STAFF,
    });
    expect(ctx.shop.unresolvedCaseKind(p.id)).toBe("legacy_unknown");
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    expect(ctx.shop.listUnresolvedCases({ limit: 100 })).toHaveLength(1);
    ctx.db.close();
  });
});

describe("決着待ちキューは全件を辿れる", () => {
  /** 決着待ちの案件を n 件作る */
  function makeCases(ctx: Ctx, n: number): number[] {
    const ids: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = ctx.db
        .prepare(
          `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
           VALUES (?,?,?,100,'active','pending') RETURNING id`,
        )
        .pluck()
        .get(ctx.item.id, `${USER}-${i}`, i + 1) as number;
      ids.push(id);
    }
    return ids;
  }

  it("12件をページで辿れて、重複も欠落もない", () => {
    const ctx = setup();
    const ids = makeCases(ctx, 12);
    expect(ctx.shop.countUnresolvedCases()).toBe(12);

    const page = (offset: number) =>
      ctx.shop.listUnresolvedCases({ limit: 5, offset }).map((c) => c.purchaseId);
    const p1 = page(0);
    const p2 = page(5);
    const p3 = page(10);

    expect(p1).toHaveLength(5);
    expect(p2).toHaveLength(5);
    expect(p3).toHaveLength(2);
    // 重複なし・全件到達
    const seen = [...p1, ...p2, ...p3];
    expect(new Set(seen).size).toBe(12);
    expect(seen.sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    // 古い案件が先（stuckSince ASC）
    expect(p1[0]).toBe(ids[0]);
    ctx.db.close();
  });

  it("先頭5件を全部「判断できない」にしても、6件目以降へ到達できる", () => {
    const ctx = setup();
    makeCases(ctx, 12);
    for (const c of ctx.shop.listUnresolvedCases({ limit: 5, offset: 0 })) {
      const q = ctx.shop.quoteOperatorResolution(c.purchaseId);
      ctx.shop.resolveOperatorCase({
        purchaseId: c.purchaseId,
        decision: "still_unknown",
        expectedToken: q.token,
        actor: STAFF,
      });
    }
    // 保留は案件を残すので、1ページ目は同じまま
    expect(ctx.shop.countUnresolvedCases()).toBe(12);
    const p1 = ctx.shop.listUnresolvedCases({ limit: 5, offset: 0 }).map((c) => c.purchaseId);
    const p2 = ctx.shop.listUnresolvedCases({ limit: 5, offset: 5 }).map((c) => c.purchaseId);
    expect(p2).toHaveLength(5);
    expect(p1.some((id) => p2.includes(id))).toBe(false);
    ctx.db.close();
  });

  it("1件決着させると、件数も一覧も同じだけ減る", () => {
    const ctx = setup();
    makeCases(ctx, 12);
    const first = ctx.shop.listUnresolvedCases({ limit: 1, offset: 0 })[0]!;
    const q = ctx.shop.quoteOperatorResolution(first.purchaseId);
    ctx.shop.resolveOperatorCase({
      purchaseId: first.purchaseId,
      decision: "delivered",
      expectedToken: q.token,
      actor: STAFF,
      note: "確認済み",
    });

    expect(ctx.shop.countUnresolvedCases()).toBe(11);
    const all = ctx.shop.listUnresolvedCases({ limit: 100 }).map((c) => c.purchaseId);
    expect(all).toHaveLength(11);
    expect(all).not.toContain(first.purchaseId);
    ctx.db.close();
  });

  it("件数は distinct purchase と一致する（一覧と同じ集合）", () => {
    const ctx = setup();
    makeCases(ctx, 7);
    expect(ctx.shop.countUnresolvedCases()).toBe(ctx.shop.listUnresolvedCases({ limit: 1000 }).length);
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

    // **偽の配送日時を作らずに**提供済みの正本が立つ
    expect(ctx.shop.getPurchase(p.id)!.delivered_at).toBeNull();
    expect(ctx.shop.safetySnapshot(p.id)!.fulfillment.evidence).toBe(true);
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

  it("提供なしと確認しておけば、あとから別経路で返金できる", () => {
    const ctx = setup();
    const p = legacyPurchase(ctx);
    const before = landOf(ctx);
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    // 返金までは一緒にやらない（確認だけ残す）
    const result = ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: STAFF,
      note: "痕跡なし",
    });
    expect(result.refunded).toBe(false);
    expect(landOf(ctx)).toBe(before);

    // **残した確認記録が証拠になる。** 別経路の返金がそれを根拠に通る
    expect(ctx.shop.operatorConfirmedNoEffect(p.id)).toBe(true);
    expect(ctx.shop.refund(p.id, "運営確認済み", STAFF).refunded).toBe(true);
    expect(landOf(ctx)).toBe(before + 100);
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
