import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, ShopError, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * Phase H の締め。**画面に出した約束と、実際に動く authority を一致させる。**
 *
 * 「もう一度配る」と書いておいて配送やり直しキューへ載らない、
 * 「返金をやり直す」と出しておいて押すと必ず失敗する、
 * 「返金に失敗した」と監査へ書いておいて実は正しく拒んだだけ——
 * どれも操作した人には見えないまま、仕事だけが消える。
 */

registerDefaultTxTypes();
const STAFF = "operator:1";
const USER = "u-closure";
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
    idempotencyKey: "seed:closure",
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

const buy = (ctx: Ctx, userId = USER) => {
  if (userId !== USER) {
    ctx.ledger.ensureAccount(`user:${userId}`, "user");
    ctx.ledger.transfer({
      from: TREASURY,
      to: `user:${userId}`,
      amount: 100_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: `seed:${userId}`,
    });
  }
  return ctx.shop.purchase({
    itemId: ctx.item.id,
    userId,
    actor: `user:${userId}`,
    memberRoleIds: [],
    expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
  }).purchase;
};

/** 購入時スナップショットも provenance も無い旧購入（手動配送の時代） */
function legacyWithoutSnapshot(ctx: Ctx, userId = "u-legacy-a"): number {
  return ctx.db
    .prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
       VALUES (?,?,1,100,'active','pending') RETURNING id`,
    )
    .pluck()
    .get(ctx.item.id, userId) as number;
}

/**
 * 購入時スナップショットはあるが provenance が無い旧購入。
 * `delivery_kind` は読めてしまうが、**結末を証明できない**ので自動では流し直さない。
 */
function legacyWithSnapshot(ctx: Ctx, userId = "u-legacy-b"): number {
  return ctx.db
    .prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state,delivery_snapshot_json)
       VALUES (?,?,1,100,'active','pending',?) RETURNING id`,
    )
    .pluck()
    .get(
      ctx.item.id,
      userId,
      JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
    ) as number;
}

/** 外部へ投げたが結果が分からない、通常の購入 */
function uncertain(ctx: Ctx, purchaseId: number) {
  const claim = ctx.shop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: "system" }) as {
    token: string;
  };
  ctx.shop.markExternalDeliveryUncertain({ purchaseId, token: claim.token, reason: "final_fetch_failed", actor: "system" });
  return claim.token;
}

/** 商館スタッフが手を動かせる4つのキューのうち、どれに出ているか */
const queues = (ctx: Ctx, id: number) => ({
  manual: ctx.shop.listPendingManual({ limit: 500 }).some((r) => r.id === id),
  retry: ctx.shop.listUndeliveredAuto(500).some((r) => r.id === id),
  confirm: ctx.shop.listUnresolvedCases({ limit: 500 }).some((r) => r.purchaseId === id),
  refund: ctx.shop.listRefundFailures({ limit: 500 }).some((r) => r.purchaseId === id),
});
const queueCount = (q: Record<string, boolean>) => Object.values(q).filter(Boolean).length;

describe("Blocker 1: 「もう一度配る」は、実際に配れるときだけ出す", () => {
  it("スナップショットの無い旧購入 — 再配送は選べない", () => {
    const ctx = setup();
    const id = legacyWithoutSnapshot(ctx);
    expect(ctx.shop.unresolvedCaseKind(id)).toBe("legacy_unknown");
    expect(ctx.shop.deliveryRetryEligible(id)).toBe(false);
    expect(ctx.shop.quoteOperatorResolution(id).retrySupported).toBe(false);
    ctx.db.close();
  });

  it("スナップショットはあるが provenance が無い旧購入 — 配送種別は読めても再配送は選べない", () => {
    const ctx = setup();
    const id = legacyWithSnapshot(ctx);
    const quote = ctx.shop.quoteOperatorResolution(id);

    // 種別は読める。**それを根拠にしてはいけない**、というのがこのテスト
    expect(quote.deliveryKind).toBe("add_role");
    expect(ctx.shop.isLegacyAutoOutcomeUnknown(id)).toBe(true);
    expect(ctx.shop.deliveryRetryEligible(id)).toBe(false);
    expect(quote.retrySupported).toBe(false);
    ctx.db.close();
  });

  it("通常の購入 — 再配送を選べる", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    const quote = ctx.shop.quoteOperatorResolution(p.id);
    expect(quote.kind).toBe("uncertain_delivery");
    expect(quote.retrySupported).toBe(true);
    ctx.db.close();
  });

  it("再配送を選べる購入は、決着すると**実際に**配送やり直しキューへ載る", () => {
    const ctx = setup();
    const p = buy(ctx);
    uncertain(ctx, p.id);
    expect(ctx.shop.quoteOperatorResolution(p.id).retrySupported).toBe(true);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      decision: "no_effect",
      expectedToken: ctx.shop.quoteOperatorResolution(p.id).token,
      actor: STAFF,
      note: "ロールが付いていないことを確認",
    });

    expect(queues(ctx, p.id).retry).toBe(true);
    expect(queues(ctx, p.id).confirm).toBe(false);
    expect(queueCount(queues(ctx, p.id))).toBe(1);
    ctx.db.close();
  });

  it("決着させても、未提供の購入がすべてのキューから消えない", () => {
    const ctx = setup();
    const id = legacyWithSnapshot(ctx);
    expect(queues(ctx, id).confirm).toBe(true);

    // 画面に出る操作だけを使う。再配送は出ないので、返金で決着させる
    const quote = ctx.shop.quoteOperatorResolution(id);
    expect(quote.retrySupported).toBe(false);
    expect(quote.refundSupported).toBe(true);

    const result = ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "no_effect",
      expectedToken: quote.token,
      actor: STAFF,
      note: "ロールが無いことを確認",
      refund: true,
    });

    // 返金で決着＝仕事は正しく終わっている
    expect(result.refunded).toBe(true);
    expect(ctx.shop.getPurchase(id)!.status).toBe("refunded");
    expect(queueCount(queues(ctx, id))).toBe(0);
    ctx.db.close();
  });

  /**
   * **回帰の本体。** 画面が出す操作だけを順に使い、決着後に
   * 「まだ未提供の active なのに、どのキューからも辿れない」が起きないことを見る。
   *
   * `no_effect` を返金なしで確定する経路は Core API には残る（決着の記録を証拠として
   * 後から返金する、という Phase H の契約がある）。ただし**画面には出さない**——
   * 出すと、再配送されないまま確認キューから消えて誰も気づけなくなる。
   */
  for (const scenario of ["snapshotあり legacy", "snapshotなし legacy", "通常の確認待ち"] as const) {
    it(`${scenario}: 画面に出る操作で決着させても、仕事が消えない`, () => {
      const ctx = setup();
      const id =
        scenario === "snapshotあり legacy"
          ? legacyWithSnapshot(ctx)
          : scenario === "snapshotなし legacy"
            ? legacyWithoutSnapshot(ctx)
            : (() => {
                const p = buy(ctx);
                uncertain(ctx, p.id);
                return p.id;
              })();
      expect(queues(ctx, id).confirm).toBe(true);

      const quote = ctx.shop.quoteOperatorResolution(id);
      // 画面が出すのは「提供できていた」「提供なし→返金」「提供なし→もう一度配る」「まだ分からない」。
      // 返金なしの「提供なし」は `retrySupported` のときだけ出る
      const uiDecision = quote.retrySupported
        ? ({ decision: "no_effect", refund: false } as const)
        : quote.refundSupported
          ? ({ decision: "no_effect", refund: true } as const)
          : ({ decision: "delivered", refund: false } as const);

      ctx.shop.resolveOperatorCase({
        purchaseId: id,
        decision: uiDecision.decision,
        refund: uiDecision.refund,
        expectedToken: quote.token,
        actor: STAFF,
        note: "外部の状態を確認した",
      });

      const purchase = ctx.shop.getPurchase(id)!;
      const stillNeedsWork = purchase.status === "active" && purchase.delivered_at === null;
      if (stillNeedsWork) {
        // まだ未提供で残っているなら、**必ずどこかのキューから辿れる**こと。
        // ここが 0 になるのが、監査で見つかった「静かに消える」状態
        expect(queueCount(queues(ctx, id))).toBeGreaterThan(0);
      } else {
        // 決着し切ったなら、どのキューにも残らない
        expect(queueCount(queues(ctx, id))).toBe(0);
      }
      ctx.db.close();
    });
  }

  it("Core API の「返金なしで提供なしを確定」は残す（決着の記録を後続返金の証拠にする契約）", () => {
    const ctx = setup();
    const id = legacyWithSnapshot(ctx);

    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "no_effect",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: STAFF,
      note: "ロールが無いことを確認",
    });

    // 記録は durable に残り、あとから返金できる
    expect(ctx.shop.operatorResolutions(id).some((r) => r.decision === "no_effect")).toBe(true);
    const before = ctx.ledger.balanceOf("user:u-legacy-b");
    expect(ctx.shop.refund(id, "運営確認済み", STAFF).refunded).toBe(true);
    expect(ctx.ledger.balanceOf("user:u-legacy-b")).toBe(before + 100);
    ctx.db.close();
  });
});

describe("Hardening 2: 生きている claim がある間は、返金の復旧キューへ出さない", () => {
  /** claim を握ったまま返金失敗の記録がある、という状態を人工的に作る */
  function claimedWithRefundFailure(ctx: Ctx) {
    const p = buy(ctx);
    const token = uncertain(ctx, p.id);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    return { id: p.id, token };
  }

  it("二重計上しない — 確認待ちにだけ出る", () => {
    const ctx = setup();
    const { id } = claimedWithRefundFailure(ctx);

    const q = queues(ctx, id);
    expect(q.confirm).toBe(true);
    expect(q.refund).toBe(false);
    expect(queueCount(q)).toBe(1);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.countUnresolvedCases()).toBe(1);
    ctx.db.close();
  });

  it("押しても必ず失敗する返金ボタンを出さない", () => {
    const ctx = setup();
    const { id } = claimedWithRefundFailure(ctx);

    const quote = ctx.shop.quoteRefundRetry(id);
    expect(quote.open).toBe(false);
    expect(() => ctx.shop.retryRefund({ purchaseId: id, expectedToken: quote.token, actor: STAFF })).toThrow(
      /ERR_RESOLUTION_NOT_APPLICABLE/,
    );
    // 押せなかったので、失敗記録も積まれない
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(id),
    ).toBe(1);
    ctx.db.close();
  });

  it("claim が解ければ、そのまま返金の復旧キューへ現れる", () => {
    const ctx = setup();
    const { id, token } = claimedWithRefundFailure(ctx);

    ctx.shop.releaseExternalDelivery({ purchaseId: id, token, reason: "operator", actor: STAFF });

    expect(queues(ctx, id).refund).toBe(true);
    expect(ctx.shop.countRefundFailures()).toBe(1);
    expect(ctx.shop.quoteRefundRetry(id).open).toBe(true);
    const quote = ctx.shop.quoteRefundRetry(id);
    expect(ctx.shop.retryRefund({ purchaseId: id, expectedToken: quote.token, actor: STAFF }).refunded).toBe(true);
    ctx.db.close();
  });

  it("claim が守っている間も、失効は止まったまま", () => {
    const ctx = setup();
    const { id } = claimedWithRefundFailure(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(id);

    // 返金キューから外しても、claim 側の guard が失効を止める（守りに切れ目を作らない）
    expect(ctx.shop.expireIfDue(id, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });
    expect(ctx.shop.expireOverdue(STAFF).expired.map((r) => r.id)).not.toContain(id);
    expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    ctx.db.close();
  });
});

describe("Round 2: 商館で返せない購入を、返金キューへ出さない", () => {
  /**
   * 代替支払を含む**いまのコードが作った**購入。generic refund は必ず
   * `ERR_ALT_REFUND_UNSUPPORTED` で拒む。provenance を持つので「結末が分からない旧購入」
   * ではない——確認待ちではなく、純粋に「返せない」だけの案件になる。
   */
  function altPaid(ctx: Ctx, userId = "u-alt"): number {
    const id = ctx.db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,paid_alt_kind,paid_alt_amount,status,delivery_state,delivery_snapshot_json)
         VALUES (?,?,1,0,'invite',5,'active','pending',?) RETURNING id`,
      )
      .pluck()
      .get(
        ctx.item.id,
        userId,
        JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
      ) as number;
    ctx.db
      .prepare(
        `INSERT INTO shop_purchase_fulfillment_provenance (purchase_id,delivery_mode,stock_consumed,captured_at,source)
         VALUES (?, 'auto', 0, 1, 'storefront')`,
      )
      .run(id);
    return id;
  }

  it("Scenario A — land 払いの本当の返金失敗は、これまでどおり商館の仕事", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });

    expect(queues(ctx, p.id).refund).toBe(true);
    expect(ctx.shop.countRefundFailures()).toBe(1);
    expect(ctx.shop.countRefundHandoffs()).toBe(0);
    const quote = ctx.shop.quoteRefundRetry(p.id);
    expect(quote.open).toBe(true);
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    expect(ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF }).refunded).toBe(true);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before + 100);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    ctx.db.close();
  });

  it("Scenario B — 代替支払は証拠を残したまま、商館の返金キューへ出さない", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    // 自動返金は必ず拒まれ、escalation の証拠が durable に残る
    const outcome = ctx.shop.refundOrRecordFailure(id, "delivery_failed", "system");
    expect(outcome).toMatchObject({ failed: true, code: "ERR_ALT_REFUND_UNSUPPORTED" });
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(id)).toBe(1);

    // 商館の仕事には出さない
    expect(queues(ctx, id).refund).toBe(false);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.quoteRefundRetry(id).open).toBe(false);
    // 商館の仕事としては1件も出さない（二重計上どころか、押せる操作が無い）
    expect(queueCount(queues(ctx, id))).toBe(0);

    // **運営判断が必要な案件として発見できる**
    expect(ctx.shop.countRefundHandoffs()).toBe(1);
    const row = ctx.shop.listRefundHandoffs()[0]!;
    expect(row).toMatchObject({ purchaseId: id, paidAltKind: "invite", paidAltAmount: 5 });
    ctx.db.close();
  });

  it("Scenario C — 代替支払への古い返金やり直しは、1つも書かない", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });
    const before = {
      status: ctx.shop.getPurchase(id)!.status,
      land: ctx.ledger.balanceOf("user:u-alt"),
      failures: ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(id),
    };

    const quote = ctx.shop.quoteRefundRetry(id);
    expect(quote.open).toBe(false);
    expect(() => ctx.shop.retryRefund({ purchaseId: id, expectedToken: quote.token, actor: STAFF })).toThrow(
      /ERR_RESOLUTION_NOT_APPLICABLE/,
    );

    expect(ctx.shop.getPurchase(id)!.status).toBe(before.status);
    expect(ctx.ledger.balanceOf("user:u-alt")).toBe(before.land);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(id)).toBe(
      before.failures,
    );
    // 「返金できる」表示にも戻らない
    expect(ctx.shop.quoteRefundRetry(id).open).toBe(false);
    expect(queues(ctx, id).refund).toBe(false);
    ctx.db.close();
  });

  it("Scenario C' — authority が拒んだだけなら retry_failed を積まない", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });

    // 事前 guard を通り抜けて refund() まで届いた場合（競合）でも記録しない
    const real = ctx.shop.refund.bind(ctx.shop);
    (ctx.shop as unknown as { refund: unknown }).refund = () => {
      throw new ShopError("ERR_ALT_REFUND_UNSUPPORTED", { purchaseId: id });
    };
    let code: string | undefined;
    try {
      ctx.shop.retryRefund({ purchaseId: id, expectedToken: "x", actor: STAFF });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    (ctx.shop as unknown as { refund: unknown }).refund = real;

    // stale guard が先に効く。どちらにせよ記録は増えない
    expect(code === "ERR_RESOLUTION_STALE" || code === "ERR_ALT_REFUND_UNSUPPORTED").toBe(true);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(id)).toBe(1);
    ctx.db.close();
  });

  it("Scenario D — live claim + 代替支払でも二重計上せず、失効も止まったまま", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    const claim = ctx.shop.claimExternalDelivery({ purchaseId: id, deliveryKind: "add_role", actor: "system" }) as {
      token: string;
    };
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: id, token: claim.token, reason: "x", actor: "system" });
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(id);

    // authority が強い方（claim）だけが商館の仕事になる
    expect(queues(ctx, id).confirm).toBe(true);
    expect(queues(ctx, id).refund).toBe(false);
    expect(queueCount(queues(ctx, id))).toBe(1);
    // claim 中は運営 handoff にも二重で出さない
    expect(ctx.shop.countRefundHandoffs()).toBe(0);
    // 失効の guard に切れ目を作らない
    expect(ctx.shop.expireIfDue(id, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });

    // claim が解ければ、商館では返せない案件として運営へ出る
    ctx.shop.releaseExternalDelivery({ purchaseId: id, token: claim.token, reason: "operator", actor: STAFF });
    expect(ctx.shop.countRefundHandoffs()).toBe(1);
    expect(queues(ctx, id).refund).toBe(false);
    ctx.db.close();
  });

  it("決着画面でも、商館で返せない購入に「返金する」を出さない", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    // 外部へ投げたが結果が分からない＝確認待ちの案件になる
    const claim = ctx.shop.claimExternalDelivery({ purchaseId: id, deliveryKind: "add_role", actor: "system" }) as {
      token: string;
    };
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: id, token: claim.token, reason: "x", actor: "system" });

    const quote = ctx.shop.quoteOperatorResolution(id);
    expect(quote.kind).toBe("uncertain_delivery");
    // **返金を伴う決着は出さない。** 出すと ERR_ALT_REFUND_UNSUPPORTED で必ず失敗する
    expect(quote.refundSupported).toBe(false);
    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: id,
        decision: "no_effect",
        refund: true,
        expectedToken: quote.token,
        actor: STAFF,
        note: "ロールが無いことを確認",
      }),
    ).toThrow(/ERR_ALT_REFUND_UNSUPPORTED/);
    ctx.db.close();
  });

  it("台帳が落ちた本当の失敗は記録し、authority の拒否は記録しない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    const rows = () =>
      ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(p.id) as number;

    // (1) authority の拒否（ShopError）＝ 資産は動いていない。記録しない
    const real = ctx.shop.refund.bind(ctx.shop);
    (ctx.shop as unknown as { refund: unknown }).refund = () => {
      throw new ShopError("ERR_ALT_REFUND_UNSUPPORTED", { purchaseId: p.id });
    };
    expect(() =>
      ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: ctx.shop.quoteRefundRetry(p.id).token, actor: STAFF }),
    ).toThrow(/ERR_ALT_REFUND_UNSUPPORTED/);
    expect(rows()).toBe(1);

    // (2) 台帳側の失敗＝ 本当に返せなかった。必ず記録する
    (ctx.shop as unknown as { refund: unknown }).refund = () => {
      throw new Error("ledger unavailable");
    };
    expect(() =>
      ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: ctx.shop.quoteRefundRetry(p.id).token, actor: STAFF }),
    ).toThrow(/ledger unavailable/);
    expect(rows()).toBe(2);

    (ctx.shop as unknown as { refund: unknown }).refund = real;
    ctx.db.close();
  });

  it("land 払いなら handoff ではなく、商館の仕事のまま", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    expect(ctx.shop.countRefundHandoffs()).toBe(0);
    expect(ctx.shop.countRefundFailures()).toBe(1);
    ctx.db.close();
  });

  it("返金されれば handoff からも消える（履歴は残る）", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });
    expect(ctx.shop.countRefundHandoffs()).toBe(1);

    // 運営が別経路で決着させた（ここでは status を終端へ動かす操作で代表させる）
    ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(id);

    expect(ctx.shop.countRefundHandoffs()).toBe(0);
    // 追記専用の証拠は消えない
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(id)).toBe(1);
    ctx.db.close();
  });
});

describe("Round 3: 金銭の決着が終わるまで、期限では失効させない", () => {
  /** 代替支払 + provenance。商館では返せないが、決着はまだ終わっていない */
  function altPaid(ctx: Ctx, userId = "u-alt3"): number {
    const id = ctx.db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,paid_alt_kind,paid_alt_amount,status,delivery_state,delivery_snapshot_json)
         VALUES (?,?,1,0,'invite',5,'active','pending',?) RETURNING id`,
      )
      .pluck()
      .get(
        ctx.item.id,
        userId,
        JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
      ) as number;
    ctx.db
      .prepare(
        `INSERT INTO shop_purchase_fulfillment_provenance (purchase_id,delivery_mode,stock_consumed,captured_at,source)
         VALUES (?, 'auto', 0, 1, 'storefront')`,
      )
      .run(id);
    return id;
  }
  const overdue = (ctx: Ctx, id: number) => ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(id);
  const inHandoff = (ctx: Ctx, id: number) => ctx.shop.listRefundHandoffs({ limit: 500 }).some((r) => r.purchaseId === id);

  it("Scenario A — land の返金復旧は、期限が来ても失効しない（既存契約）", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    overdue(ctx, p.id);

    expect(queues(ctx, p.id).refund).toBe(true);
    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");

    // 返金が終わってはじめて終端へ進める
    const quote = ctx.shop.quoteRefundRetry(p.id);
    expect(ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF }).refunded).toBe(true);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("refunded");
    ctx.db.close();
  });

  it("Scenario B — 商館では返せない購入も、期限では失効させない（今回の本体）", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });
    overdue(ctx, id);

    // 商館の仕事ではないが、運営への引き継ぎには出ている
    expect(queues(ctx, id).refund).toBe(false);
    expect(inHandoff(ctx, id)).toBe(true);

    // **ここが修正点。** 「商館で返せない」を「決着が済んだ」と読み替えない
    expect(ctx.shop.expireIfDue(id, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    expect(ctx.shop.expireOverdue(STAFF).expired.map((r) => r.id)).not.toContain(id);
    expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    // 引き継ぎ一覧から消えない（消えると誰も気づけないまま決着未了が残る）
    expect(inHandoff(ctx, id)).toBe(true);
    ctx.db.close();
  });

  it("Scenario C — claim → 解放 → 引き継ぎ → 失効も止まったまま", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    const claim = ctx.shop.claimExternalDelivery({ purchaseId: id, deliveryKind: "add_role", actor: "system" }) as {
      token: string;
    };
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: id, token: claim.token, reason: "x", actor: "system" });
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });
    overdue(ctx, id);

    // 1〜5: claim が守っている
    expect(ctx.shop.expireIfDue(id, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });
    expect(inHandoff(ctx, id)).toBe(false);

    // 6〜7: claim を解放すると引き継ぎへ現れる
    ctx.shop.releaseExternalDelivery({ purchaseId: id, token: claim.token, reason: "operator", actor: STAFF });
    expect(inHandoff(ctx, id)).toBe(true);

    // 8〜11: 守りが claim から金銭決着へ**切れ目なく**引き継がれる
    expect(ctx.shop.expireIfDue(id, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    expect(inHandoff(ctx, id)).toBe(true);
    expect(queues(ctx, id).refund).toBe(false);
    ctx.db.close();
  });

  it("Scenario D — 守られた行で LIMIT を埋めず、通常の期限切れへ到達する", () => {
    const ctx = setup();
    // 古い順に: 代替支払の引き継ぎ / land の返金復旧 / 普通の期限切れ
    const alt = altPaid(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: alt, amount: 0, reason: "delivery_failed", actor: "system" });
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(alt);

    const land = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: land.id, amount: 100, reason: "delivery_failed", actor: "system" });
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=2 WHERE id=?").run(land.id);

    const plain = buy(ctx, "u-plain3").id;
    ctx.shop.beginDelivery(plain);
    ctx.shop.markDeliverySucceeded(plain, "system:test");
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=3 WHERE id=?").run(plain);

    const result = ctx.shop.expireOverdue(STAFF);

    // 守られた2件は候補を占有せず、後ろの普通の期限切れへ到達している
    expect(result.expired.map((r) => r.id)).toEqual([plain]);
    expect(ctx.shop.getPurchase(alt)!.status).toBe("active");
    expect(ctx.shop.getPurchase(land.id)!.status).toBe("active");
    expect(ctx.shop.getPurchase(plain)!.status).toBe("expired");
    // 候補選択と最終判断が同じ理由で止める
    expect(ctx.shop.expireIfDue(alt, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    expect(ctx.shop.expireIfDue(land.id, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    ctx.db.close();
  });

  it("Scenario D2 — 守られた行が200件あっても、後ろの期限切れへ到達する", () => {
    const ctx = setup();
    // **候補選択が LIMIT 前に除外していないと、ここで枠が埋まって後続へ届かない。**
    // 最終判断（expireIfDue）だけを直しても starvation は消えない
    const guarded: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const id = ctx.db
        .prepare(
          `INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,paid_alt_kind,paid_alt_amount,status,delivery_state,delivery_snapshot_json)
           VALUES (?,?,?,?,0,'invite',5,'active','pending',?) RETURNING id`,
        )
        .pluck()
        .get(
          ctx.item.id,
          `u-starve-${i}`,
          i + 1,
          i + 1,
          JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
        ) as number;
      ctx.db
        .prepare(
          `INSERT INTO shop_purchase_fulfillment_provenance (purchase_id,delivery_mode,stock_consumed,captured_at,source)
           VALUES (?, 'auto', 0, 1, 'storefront')`,
        )
        .run(id);
      ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });
      guarded.push(id);
    }
    expect(ctx.shop.countRefundHandoffs()).toBe(200);

    // 後ろに普通の期限切れを1件置く
    const plain = buy(ctx, "u-starve-plain").id;
    ctx.shop.beginDelivery(plain);
    ctx.shop.markDeliverySucceeded(plain, "system:test");
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=? WHERE id=?").run(100_000, plain);

    const result = ctx.shop.expireOverdue(STAFF);

    expect(result.expired.map((r) => r.id)).toContain(plain);
    for (const id of guarded) expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    // 引き継ぎ一覧も減らない
    expect(ctx.shop.countRefundHandoffs()).toBe(200);
    ctx.db.close();
  });

  it("Scenario E — 決着が終われば保護は外れる（履歴があっても永久には守らない）", () => {
    const ctx = setup();
    // (1) 返金で決着 → 終端なので保護対象外
    const refunded = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: refunded.id, amount: 100, reason: "delivery_failed", actor: "system" });
    const quote = ctx.shop.quoteRefundRetry(refunded.id);
    ctx.shop.retryRefund({ purchaseId: refunded.id, expectedToken: quote.token, actor: STAFF });
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(refunded.id);
    expect(ctx.shop.expireIfDue(refunded.id, STAFF)).toEqual({ expired: false, reason: "not_active" });

    // (2) あとから提供が成功した → 返す理由が無いので普通に失効できる
    const delivered = buy(ctx, "u-e2");
    ctx.shop.recordRefundFailure({ purchaseId: delivered.id, amount: 100, reason: "delivery_failed", actor: "system" });
    ctx.shop.beginDelivery(delivered.id);
    ctx.shop.markDeliverySucceeded(delivered.id, "system:test");
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(delivered.id);

    expect(ctx.shop.expireIfDue(delivered.id, STAFF)).toEqual({ expired: true, reason: "expired" });
    expect(ctx.shop.getPurchase(delivered.id)!.status).toBe("expired");
    // 履歴そのものは消えない
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(delivered.id)).toBe(
      1,
    );
    ctx.db.close();
  });

  it("3つの意味を取り違えない — 履歴 ≠ 商館の仕事 ≠ 決着が未了", () => {
    const ctx = setup();
    const alt = altPaid(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: alt, amount: 0, reason: "delivery_failed", actor: "system" });

    // 履歴はある
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(alt)).toBe(1);
    // 商館の仕事ではない
    expect(queues(ctx, alt).refund).toBe(false);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    // **しかし決着は終わっていない**——だから失効させない、運営へ渡す
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(alt);
    expect(ctx.shop.expireIfDue(alt, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    expect(ctx.shop.countRefundHandoffs()).toBe(1);
    ctx.db.close();
  });
});

describe("Hardening 3: 「提供済みなので返さない」を失敗として記録しない", () => {
  it("提供済みの購入への古い返金やり直しは、1つも書かずに拒む", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    const quote = ctx.shop.quoteRefundRetry(p.id);
    expect(quote.open).toBe(true);

    // 画面を開いたあとに提供が成功した
    ctx.shop.beginDelivery(p.id);
    ctx.shop.markDeliverySucceeded(p.id, "system:test");
    const before = {
      land: ctx.ledger.balanceOf(`user:${USER}`),
      status: ctx.shop.getPurchase(p.id)!.status,
      failures: ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(p.id),
    };

    // stale guard より先に届いた場合でも、記録は増えない
    expect(() => ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF })).toThrow();

    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before.land);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe(before.status);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(p.id)).toBe(
      before.failures,
    );
    // 提供済みなので復旧キューへも戻らない
    expect(queues(ctx, p.id).refund).toBe(false);
    ctx.db.close();
  });

  /**
   * 事前の guard（`open` 判定）を通り抜けて `refund()` まで届くのは、
   * **画面を開いたあと・token 照合のあとに提供が確定した**競合のときだけ。
   * 単一プロセスの同期呼び出しでは作れないので、その瞬間だけを差し込んで確かめる。
   */
  it("競合で提供が先に確定したときも、失敗として記録しない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    const quote = ctx.shop.quoteRefundRetry(p.id);
    expect(quote.open).toBe(true);

    const real = ctx.shop.refund.bind(ctx.shop);
    (ctx.shop as unknown as { refund: unknown }).refund = () => {
      throw new ShopError("ERR_ALREADY_DELIVERED", { purchaseId: p.id });
    };
    let code: string | undefined;
    try {
      ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    (ctx.shop as unknown as { refund: unknown }).refund = real;

    expect(code).toBe("ERR_ALREADY_DELIVERED");
    // **嘘の失敗証拠を積まない。** 返さなかったのは正しい判断であって、失敗ではない
    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(p.id)).toBe(1);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(10_000_000 - 100);
    ctx.db.close();
  });

  it("本当に返金できなかったときは、これまでどおり記録が積まれる", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    const quote = ctx.shop.quoteRefundRetry(p.id);
    const spy = ctx.ledger.transfer.bind(ctx.ledger);
    (ctx.ledger as unknown as { transfer: unknown }).transfer = () => {
      throw new Error("ledger unavailable");
    };

    expect(() => ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: quote.token, actor: STAFF })).toThrow();
    (ctx.ledger as unknown as { transfer: unknown }).transfer = spy;

    expect(ctx.db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(p.id)).toBe(2);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(true);
    // 失敗を積んだので、古いボタンはもう効かない
    expect(ctx.shop.quoteRefundRetry(p.id).token).not.toBe(quote.token);
    ctx.db.close();
  });
});
