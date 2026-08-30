import { describe, expect, it, vi } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * 状態モデルの契約を固定する。
 *
 * 機能を増やすためではなく、Phase C〜Hで積み上がった安全機構が
 * **どの事実を authority にしているか**を、コードを追わずに確かめられるようにする。
 * ここが落ちたときは「実装が変わった」ではなく「意味が変わった」。
 */

registerDefaultTxTypes();
const STAFF = "operator:1";
const USER = "u-state";
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
    idempotencyKey: "seed:state",
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
      amount: 10_000,
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

const claim = (ctx: Ctx, purchaseId: number) =>
  (ctx.shop.claimExternalDelivery({ purchaseId, deliveryKind: "add_role", actor: "system" }) as { token: string }).token;

const deliver = (ctx: Ctx, purchaseId: number) => {
  ctx.shop.beginDelivery(purchaseId);
  ctx.shop.markDeliverySucceeded(purchaseId, "system:test");
};

/** 期限を過去にする。月額のまま接続を開き直すと migration が押し戻すので、この場で使い切る */
const lapse = (ctx: Ctx, purchaseId: number) =>
  ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchaseId);

const snap = (ctx: Ctx, purchaseId: number) => ctx.shop.safetySnapshot(purchaseId)!;

describe("A. 返金の復旧待ちは「履歴があること」ではない", () => {
  it("返金失敗の履歴があっても、あとから提供が成功すれば復旧キューから外れる", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    expect(snap(ctx, p.id).refund).toEqual({
      failureHistory: 1,
      settlementPending: true,
      recoveryOpen: true,
      operationsHandoff: false,
    });

    deliver(ctx, p.id);

    const after = snap(ctx, p.id);
    // 履歴は消えない（append-only）。復旧キューから外れるだけ
    // 提供が成功したので、決着そのものが終わっている（4つとも同時に閉じる）
    expect(after.refund).toEqual({
      failureHistory: 1,
      settlementPending: false,
      recoveryOpen: false,
      operationsHandoff: false,
    });
    expect(after.fulfillment.evidence).toBe(true);
    expect(ctx.shop.countRefundFailures()).toBe(0);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(false);
    expect(after.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("一覧・件数・1件判定・snapshot が同じ集合を指す", () => {
    const ctx = setup();
    const open = buy(ctx).id;
    ctx.shop.recordRefundFailure({ purchaseId: open, amount: 100, reason: "delivery_failed", actor: "system" });
    const closed = buy(ctx, "u-state-2").id;
    ctx.shop.recordRefundFailure({ purchaseId: closed, amount: 100, reason: "delivery_failed", actor: "system" });
    deliver(ctx, closed);

    const listed = ctx.shop.listRefundFailures().map((r) => r.purchaseId);
    expect(listed).toEqual([open]);
    expect(ctx.shop.countRefundFailures()).toBe(listed.length);
    expect(snap(ctx, open).refund.recoveryOpen).toBe(true);
    expect(snap(ctx, closed).refund.recoveryOpen).toBe(false);
    ctx.db.close();
  });
});

describe("A2. 提供済みの証拠は、一覧と1件判定で同じ定義", () => {
  /** 購入時 provenance を持たない旧購入を、直接作る */
  function legacyRow(ctx: Ctx, deliveryState: string, deliveredAt: number | null) {
    return ctx.db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state,delivered_at,delivery_snapshot_json)
         VALUES (?,?,?,100,'active',?,?,?) RETURNING id`,
      )
      .pluck()
      .get(
        ctx.item.id,
        "u-legacy",
        1_700_000_000,
        deliveryState,
        deliveredAt,
        JSON.stringify({ delivery_kind: "add_role", delivery_data: { role_id: ROLE } }),
      ) as number;
  }

  it("delivery_state='delivered' だけでは証拠にならない（移行時の既定値でしかない）", () => {
    const ctx = setup();
    const id = legacyRow(ctx, "delivered", null);

    // 1件判定・snapshot・一覧SQL のどれも「提供済み」と言わない
    expect(snap(ctx, id).fulfillment.evidence).toBe(false);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 100, reason: "delivery_failed", actor: "system" });
    expect(snap(ctx, id).refund.recoveryOpen).toBe(true);
    expect(ctx.shop.listRefundFailures().map((r) => r.purchaseId)).toContain(id);
    // 止まる理由は「提供済みだから」ではなく「結末を証明できないから」。
    // 人が確認すれば返せる状態であって、提供済みとして片付けられてはいない
    expect(() => ctx.shop.refund(id, "manual", STAFF)).toThrow(/ERR_FULFILLMENT_UNKNOWN/);
    expect(snap(ctx, id).operatorCase.unresolved).toBe(true);
    ctx.db.close();
  });

  it("shop_delivered event だけでも証拠になる（delivery_state に頼らない）", () => {
    const ctx = setup();
    const id = legacyRow(ctx, "failed", null);
    ctx.events.log("shop_delivered", { actor: "system", payload: { purchaseId: id } });

    expect(snap(ctx, id).fulfillment.evidence).toBe(true);
    // 一覧SQL側も同じ判断。返金の復旧キューには出ない
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 100, reason: "delivery_failed", actor: "system" });
    expect(snap(ctx, id).refund.recoveryOpen).toBe(false);
    expect(ctx.shop.listRefundFailures().map((r) => r.purchaseId)).not.toContain(id);
    // 1件判定側も同じ。提供済みなので返さない
    expect(() => ctx.shop.refund(id, "manual", STAFF)).toThrow(/ERR_ALREADY_DELIVERED/);
    ctx.db.close();
  });

  it("証拠のない旧購入の失効では、ロールを剥がしにいかない", () => {
    const ctx = setup();
    const id = legacyRow(ctx, "delivered", null);
    lapse(ctx, id);

    ctx.shop.expireOverdue(STAFF);

    expect(ctx.shop.getPurchase(id)!.status).toBe("expired");
    // 与えた証拠が無いので剥奪キューへ載せない（与えていないものを取り上げない）
    expect(ctx.shop.pendingRoleRevocations().map((r) => r.purchase_id)).not.toContain(id);
    expect(snap(ctx, id).revocation.status).toBeNull();
    ctx.db.close();
  });
});

describe("A3. 返金の4つの意味を、1つの語へ潰さない", () => {
  /** 代替支払 + provenance。商館では返せないが、決着は終わっていない */
  function altPaid(ctx: Ctx, userId = "u-alt-sm"): number {
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

  it("代替支払: 商館では返せないが、決着は終わっていない", () => {
    const ctx = setup();
    const id = altPaid(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });

    const s = snap(ctx, id);
    // **この4つが同時に成り立つのが正しい状態**
    expect(s.refund).toEqual({
      failureHistory: 1,
      settlementPending: true,
      recoveryOpen: false,
      operationsHandoff: true,
    });
    // `recoveryOpen=false` を「決着が済んだ」と読まない——失効も止まる
    expect(s.expiry.blockedBy).toBe("refund_pending");
    expect(s.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("land 払い: 商館の仕事になり、運営への引き継ぎには出ない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });

    expect(snap(ctx, p.id).refund).toEqual({
      failureHistory: 1,
      settlementPending: true,
      recoveryOpen: true,
      operationsHandoff: false,
    });
    expect(snap(ctx, p.id).expiry.blockedBy).toBe("refund_pending");
    ctx.db.close();
  });

  it("live claim 中: 決着は未了だが、商館の仕事でも引き継ぎでもない", () => {
    const ctx = setup();
    const id = altPaid(ctx, "u-alt-sm2");
    const token = claim(ctx, id);
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: 0, reason: "delivery_failed", actor: "system" });

    const s = snap(ctx, id);
    expect(s.refund).toEqual({
      failureHistory: 1,
      settlementPending: true,
      recoveryOpen: false,
      operationsHandoff: false,
    });
    // claim 側の guard が先に効く
    expect(s.expiry.blockedBy).toBe("delivery_in_flight");

    // claim を解けば引き継ぎへ移り、守りは金銭決着へ切れ目なく引き継がれる
    ctx.shop.releaseExternalDelivery({ purchaseId: id, token, reason: "operator", actor: STAFF });
    const after = snap(ctx, id);
    expect(after.refund.operationsHandoff).toBe(true);
    expect(after.refund.settlementPending).toBe(true);
    expect(after.expiry.blockedBy).toBe("refund_pending");
    ctx.db.close();
  });
});

describe("B. 生きている claim がある間は、返金も失効も通らない", () => {
  it("claim 保持中は refund が拒まれ、期限が来ていても失効しない", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = claim(ctx, p.id);
    lapse(ctx, p.id);

    const s = snap(ctx, p.id);
    expect(s.externalClaim).toMatchObject({ token, state: "in_flight" });
    expect(s.expiry).toMatchObject({ due: true, blockedBy: "delivery_in_flight" });

    expect(() => ctx.shop.refund(p.id, "manual", STAFF)).toThrow(/ERR_DELIVERY_IN_FLIGHT/);
    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("active");
    ctx.db.close();
  });

  it("claim が解けた瞬間から、通常どおり失効できる", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = claim(ctx, p.id);
    lapse(ctx, p.id);
    ctx.shop.releaseExternalDelivery({ purchaseId: p.id, token, reason: "retry", actor: "system" });

    expect(snap(ctx, p.id).expiry.blockedBy).toBeNull();
    expect(ctx.shop.expireIfDue(p.id, STAFF)).toEqual({ expired: true, reason: "expired" });
    ctx.db.close();
  });
});

describe("C. 副作用なしと確認できた失敗は、必ずどちらかへ収束する", () => {
  it("返金できるなら refunded、できないなら durable な義務", () => {
    const ctx = setup();
    const ok = buy(ctx).id;
    const okToken = claim(ctx, ok);
    expect(
      ctx.shop.settleVerifiedFailure({ purchaseId: ok, claimToken: okToken, reason: "delivery_failed", actor: "system" }),
    ).toEqual({ refunded: true, amount: 100 });
    const okSnap = snap(ctx, ok);
    expect(okSnap.contract.status).toBe("refunded");
    expect(okSnap.externalClaim).toBeNull();
    expect(okSnap.refund.recoveryOpen).toBe(false);

    const ng = buy(ctx, "u-state-3").id;
    const ngToken = claim(ctx, ng);
    const spy = vi.spyOn(ctx.ledger, "transfer").mockImplementation(() => {
      throw new Error("ledger unavailable");
    });
    ctx.shop.settleVerifiedFailure({ purchaseId: ng, claimToken: ngToken, reason: "delivery_failed", actor: "system" });
    spy.mockRestore();

    const ngSnap = snap(ctx, ng);
    expect(ngSnap.contract.status).toBe("active");
    expect(ngSnap.refund.recoveryOpen).toBe(true);
    expect(ngSnap.expiry.blockedBy).toBe("refund_pending");
    expect(ctx.shop.quoteRefundRetry(ng).open).toBe(true);
    // どちらの結末でも「守りが外れていて未返金」は残らない
    for (const s of [okSnap, ngSnap]) {
      expect(s.contract.status === "active" && s.externalClaim === null && !s.refund.recoveryOpen && !s.fulfillment.evidence).toBe(
        false,
      );
    }
    ctx.db.close();
  });
});

describe("D. 分からないものを、証拠なしで倒さない", () => {
  it("uncertain は failed / no_effect / delivered のどれにもならない", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = claim(ctx, p.id);
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: p.id, token, reason: "final_fetch_failed", actor: "system" });

    const s = snap(ctx, p.id);
    expect(s.externalClaim).toMatchObject({ state: "uncertain" });
    expect(s.fulfillment.evidence).toBe(false);
    expect(s.operatorCase).toEqual({ unresolved: true, decided: null });
    expect(s.refund.recoveryOpen).toBe(false);
    // 自動では1つも動かない
    expect(() => ctx.shop.refund(p.id, "auto", "system")).toThrow(/ERR_DELIVERY_IN_FLIGHT/);
    ctx.db.close();
  });

  it("still_unknown は決着させず、案件のまま残す", () => {
    const ctx = setup();
    const p = buy(ctx);
    const token = claim(ctx, p.id);
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: p.id, token, reason: "final_fetch_failed", actor: "system" });
    const quote = ctx.shop.quoteOperatorResolution(p.id);

    ctx.shop.resolveOperatorCase({
      purchaseId: p.id,
      expectedToken: quote.token,
      decision: "still_unknown",
      note: "まだ確認できない",
      actor: STAFF,
    });

    const s = snap(ctx, p.id);
    expect(s.operatorCase).toEqual({ unresolved: true, decided: null });
    expect(s.externalClaim).toMatchObject({ state: "uncertain" });
    expect(s.fulfillment.evidence).toBe(false);
    expect(s.contradictions).toEqual([]);
    ctx.db.close();
  });
});

describe("E. 失効の候補選択と最終判断は同じ意味", () => {
  it("候補に入らない理由と、止まる理由が一致する", () => {
    const ctx = setup();
    const inFlight = buy(ctx).id;
    claim(ctx, inFlight);
    const owed = buy(ctx, "u-state-4").id;
    ctx.shop.recordRefundFailure({ purchaseId: owed, amount: 100, reason: "delivery_failed", actor: "system" });
    const plain = buy(ctx, "u-state-5").id;
    deliver(ctx, plain);
    for (const id of [inFlight, owed, plain]) lapse(ctx, id);

    const result = ctx.shop.expireOverdue(STAFF);

    expect(result.expired.map((r) => r.id)).toEqual([plain]);
    expect(snap(ctx, inFlight).expiry.blockedBy).toBe("delivery_in_flight");
    expect(snap(ctx, owed).expiry.blockedBy).toBe("refund_pending");
    // 候補を通さず直接呼んでも同じ理由で止まる
    expect(ctx.shop.expireIfDue(inFlight, STAFF)).toEqual({ expired: false, reason: "delivery_in_flight" });
    expect(ctx.shop.expireIfDue(owed, STAFF)).toEqual({ expired: false, reason: "refund_pending" });
    ctx.db.close();
  });
});

describe("F. 運営の決着には証拠が要る", () => {
  function uncertainCase(ctx: Ctx) {
    const p = buy(ctx);
    const token = claim(ctx, p.id);
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: p.id, token, reason: "final_fetch_failed", actor: "system" });
    return p.id;
  }

  it("根拠が空なら何も変えない", () => {
    const ctx = setup();
    const id = uncertainCase(ctx);
    const before = snap(ctx, id);

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: id,
        expectedToken: ctx.shop.quoteOperatorResolution(id).token,
        decision: "no_effect",
        note: "   ",
        actor: STAFF,
      }),
    ).toThrow(/ERR_RESOLUTION_EVIDENCE_REQUIRED/);

    expect(snap(ctx, id)).toEqual(before);
    ctx.db.close();
  });

  it("古い画面からの決定は1つも書かない", () => {
    const ctx = setup();
    const id = uncertainCase(ctx);
    const stale = ctx.shop.quoteOperatorResolution(id).token;
    // 画面を開いたあとに、別の運営が先に決着させた
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      decision: "delivered",
      note: "別の運営がロールを確認した",
      actor: "operator:2",
    });
    const before = snap(ctx, id);

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: id,
        expectedToken: stale,
        decision: "delivered",
        note: "ロールを目視で確認した",
        actor: STAFF,
      }),
    ).toThrow(/ERR_RESOLUTION_STALE/);

    expect(snap(ctx, id)).toEqual(before);
    ctx.db.close();
  });

  it("delivered と決着すれば、もう不明の案件ではない", () => {
    const ctx = setup();
    const id = uncertainCase(ctx);

    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      decision: "delivered",
      note: "ロールを目視で確認した",
      actor: STAFF,
    });

    const s = snap(ctx, id);
    expect(s.operatorCase).toEqual({ unresolved: false, decided: "delivered" });
    expect(s.fulfillment.evidence).toBe(true);
    expect(s.externalClaim).toBeNull();
    expect(s.refund.recoveryOpen).toBe(false);
    expect(s.contradictions).toEqual([]);
    ctx.db.close();
  });
});

describe("G. 1つの案件は、1つのキューにしか出ない", () => {
  /** 商館スタッフが手を動かせる4つのキュー。ここに二重計上があってはいけない */
  const merchantQueues = (ctx: Ctx, id: number) => ({
    manual: ctx.shop.listPendingManual().some((r) => r.id === id),
    retry: ctx.shop.listUndeliveredAuto(200).some((r) => r.id === id),
    confirm: ctx.shop.listUnresolvedCases({ limit: 200 }).some((r) => r.purchaseId === id),
    refund: ctx.shop.listRefundFailures({ limit: 200 }).some((r) => r.purchaseId === id),
  });
  const queueCount = (q: Record<string, boolean>) => Object.values(q).filter(Boolean).length;

  it("代表的な状態が、どれも「ちょうど1つ」か「仕事なし」に分類される", () => {
    const ctx = setup();

    // 配れないまま止まっている（自動配送のやり直し）
    const failed = buy(ctx);
    ctx.shop.beginDelivery(failed.id);
    ctx.shop.markDeliveryFailed(failed.id, "missing_role", "system");

    // 提供できたか分からない
    const uncertain = buy(ctx, "u-q2");
    const t = claim(ctx, uncertain.id);
    ctx.shop.markExternalDeliveryUncertain({ purchaseId: uncertain.id, token: t, reason: "x", actor: "system" });

    // 返せていない
    const owed = buy(ctx, "u-q3");
    ctx.shop.recordRefundFailure({ purchaseId: owed.id, amount: 100, reason: "delivery_failed", actor: "system" });

    // 正常に提供済み（仕事なし）
    const done = buy(ctx, "u-q4");
    deliver(ctx, done.id);

    expect(queueCount(merchantQueues(ctx, failed.id))).toBe(1);
    expect(queueCount(merchantQueues(ctx, uncertain.id))).toBe(1);
    expect(queueCount(merchantQueues(ctx, owed.id))).toBe(1);
    expect(queueCount(merchantQueues(ctx, done.id))).toBe(0);

    // 件数の合計＝商館の仕事の総数（重複なし）
    const total =
      ctx.shop.countPendingManual() +
      ctx.shop.countUndeliveredAuto() +
      ctx.shop.countUnresolvedCases() +
      ctx.shop.countRefundFailures();
    expect(total).toBe(3);
    ctx.db.close();
  });

  it("剥奪の blocked は商館の仕事に混ぜない（件数にも一覧にも出ない）", () => {
    const ctx = setup();
    const p = buy(ctx);
    deliver(ctx, p.id);
    lapse(ctx, p.id);
    ctx.shop.expireOverdue(STAFF);
    ctx.db.prepare("UPDATE shop_role_revocations SET status='failed', last_error='missing permission' WHERE purchase_id=?").run(
      p.id,
    );

    expect(ctx.shop.countBlockedRoleRevocations()).toBe(1);
    expect(queueCount(merchantQueues(ctx, p.id))).toBe(0);
    expect(snap(ctx, p.id).revocation).toMatchObject({ status: "failed", roleId: ROLE });
    ctx.db.close();
  });
});

describe("矛盾は隠さず、直しもしない", () => {
  it("終わった購入に生きた claim が残っていれば、そう報告する", () => {
    const ctx = setup();
    const p = buy(ctx);
    claim(ctx, p.id);
    // 事故・legacy でしか成立しない組み合わせを、直接作る
    ctx.db.prepare("UPDATE shop_purchases SET status='cancelled' WHERE id=?").run(p.id);

    const s = snap(ctx, p.id);
    expect(s.contradictions).toContain("terminal_purchase_with_live_claim:cancelled");
    // **勝手に直さない。** claim も status もそのまま
    expect(ctx.shop.externalDeliveryInFlight(p.id)).toBe(true);
    expect(ctx.shop.getPurchase(p.id)!.status).toBe("cancelled");
    ctx.db.close();
  });

  /**
   * 終わった購入に、返金を試して失敗した記録だけが残っている。
   *
   * `refunded` ではないので「返った」とは言えない。履歴だけから「未返金が確定した」
   * とも言えない（別経路で戻した可能性を否定できない）。言えるのは
   * **金の決着を人が監査する必要がある**ということだけ。
   */
  for (const status of ["expired", "cancelled"] as const) {
    it(`${status} + 返金失敗の履歴 + 提供の証拠なし → 監査が要ると報告する`, () => {
      const ctx = setup();
      const p = buy(ctx);
      ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
      ctx.db.prepare("UPDATE shop_purchases SET status=? WHERE id=?").run(status, p.id);

      const s = snap(ctx, p.id);
      expect(s.contradictions).toContain(`terminal_with_refund_failure_history_without_delivery_evidence:${status}`);
      // **復旧キューには載らない。** それは「返す必要が無い」という意味ではない
      // terminal なので**どの導線にも載らない**。だが「返した」証明にはならない
      expect(s.refund).toEqual({
        failureHistory: 1,
        settlementPending: false,
        recoveryOpen: false,
        operationsHandoff: false,
      });
      expect(ctx.shop.countRefundFailures()).toBe(0);
      // 勝手に「返金済み」とも「未返金」とも書かない。台帳も購入も動かさない
      expect(ctx.shop.getPurchase(p.id)!.status).toBe(status);
      expect(ctx.events.listByType("shop_refunded").length).toBe(0);
      expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(10_000_000 - 100);
      ctx.db.close();
    });
  }

  it("refunded は履歴が残っていても矛盾ではない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    ctx.shop.retryRefund({ purchaseId: p.id, expectedToken: ctx.shop.quoteRefundRetry(p.id).token, actor: STAFF });

    const s = snap(ctx, p.id);
    expect(s.contract.status).toBe("refunded");
    expect(s.refund).toEqual({
      failureHistory: 1,
      settlementPending: false,
      recoveryOpen: false,
      operationsHandoff: false,
    });
    expect(s.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("提供が成功していれば、履歴が残っていても矛盾ではない", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });
    deliver(ctx, p.id);
    // 期限まで来て普通に失効しても、提供の証拠があるので監査対象にはならない
    lapse(ctx, p.id);
    ctx.shop.expireOverdue(STAFF);

    const s = snap(ctx, p.id);
    expect(s.contract.status).toBe("expired");
    expect(s.fulfillment.evidence).toBe(true);
    expect(s.refund).toEqual({
      failureHistory: 1,
      settlementPending: false,
      recoveryOpen: false,
      operationsHandoff: false,
    });
    expect(s.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("active + 履歴 + 証拠なし は矛盾ではなく、通常の復旧待ち", () => {
    const ctx = setup();
    const p = buy(ctx);
    ctx.shop.recordRefundFailure({ purchaseId: p.id, amount: 100, reason: "delivery_failed", actor: "system" });

    const s = snap(ctx, p.id);
    expect(s.refund).toEqual({
      failureHistory: 1,
      settlementPending: true,
      recoveryOpen: true,
      operationsHandoff: false,
    });
    expect(s.contradictions).toEqual([]);
    expect(ctx.shop.quoteRefundRetry(p.id).open).toBe(true);
    ctx.db.close();
  });

  it("正常な状態では矛盾を報告しない", () => {
    const ctx = setup();
    const p = buy(ctx);
    deliver(ctx, p.id);
    expect(snap(ctx, p.id).contradictions).toEqual([]);
    ctx.db.close();
  });
});
