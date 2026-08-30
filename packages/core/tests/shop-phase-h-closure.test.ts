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
