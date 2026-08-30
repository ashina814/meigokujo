import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, ShopError, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * **運営が外部の事実を確認して下した「提供できていた」は、それ自体が提供済みの正本。**
 *
 * Phase H には「提供できていた」という決着があるのに、旧購入では必ず
 * `ERR_RESOLUTION_STALE` で弾かれていた。原因は、この決着が
 * 「これから配送を完了させる」処理（`completeDeliveryWith`）を通っていたこと。
 * 旧購入の `delivery_state='delivered'` は**移行時の推測値**なので、
 * exactly-once guard が「もう配送済み」と見て早期 return する——
 * つまり **推測値が、人間の確認を上書きして黙らせていた**。
 *
 * ここで確かめるのは2つの operation が別物であること。
 *   A. 配送の効果を実行して完了させる … `completeDeliveryWith`（二重実行を禁じる）
 *   B. 外部で提供済みだった事実を記録する … 運営の決着（効果を実行しない）
 */

registerDefaultTxTypes();
const STAFF = "operator:1";
const OTHER = "operator:2";
const USER = "u-authority";
const ROLE = "r-vip";
const PRICE = 30_000;

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
    idempotencyKey: "seed:authority",
  });
  const item = shop.createItem(
    {
      name: "裏口",
      price_land: PRICE,
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

/**
 * **本番に実在する39件と同じ形。**
 *
 * `status='active'` / `delivery_state='delivered'`（移行の推測値）/ `delivered_at IS NULL` /
 * `shop_delivered` event なし / provenance なし / スナップショットなし。
 */
function legacyInferredDelivered(ctx: Ctx, userId = USER, extra: Record<string, unknown> = {}): number {
  const cols = ["item_id", "user_id", "purchased_at", "paid_land", "status", "delivery_state"];
  const vals: unknown[] = [ctx.item.id, userId, 1, PRICE, "active", "delivered"];
  for (const [k, v] of Object.entries(extra)) {
    cols.push(k);
    vals.push(v);
  }
  return ctx.db
    .prepare(`INSERT INTO shop_purchases (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) RETURNING id`)
    .pluck()
    .get(...vals) as number;
}

/** 手動サービス時代の旧購入。推測値すら無く `pending` のまま残っている */
function legacyPending(ctx: Ctx, userId = USER): number {
  return ctx.db
    .prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
       VALUES (?,?,1,?,'active','pending') RETURNING id`,
    )
    .pluck()
    .get(ctx.item.id, userId, PRICE) as number;
}

const confirmDelivered = (ctx: Ctx, id: number, actor = STAFF, note = "本人に確認。庭園を利用済み") =>
  ctx.shop.resolveOperatorCase({
    purchaseId: id,
    decision: "delivered",
    expectedToken: ctx.shop.quoteOperatorResolution(id).token,
    actor,
    note,
  });

const inQueue = (ctx: Ctx, id: number) => ctx.shop.listUnresolvedCases({ limit: 500 }).some((c) => c.purchaseId === id);

// ── §12 legacy regression ────────────────────────────────────────────────────

describe("移行の推測値が、人間の確認を黙らせない", () => {
  it("`delivery_state='delivered'` / `delivered_at=NULL` の旧購入を、運営が決着できる", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);

    // 前提: この形が本当に確認キューへ出ている
    expect(ctx.shop.unresolvedCaseKind(id)).toBe("legacy_unknown");
    expect(inQueue(ctx, id)).toBe(true);
    expect(ctx.shop.getPurchase(id)!.delivered_at).toBeNull();
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);

    const result = confirmDelivered(ctx, id);

    // **ERR_RESOLUTION_STALE にならない**（これが今回の実バグ）
    expect(result.decision).toBe("delivered");
    expect(result.refunded).toBe(false);
    expect(ctx.shop.operatorResolutions(id)).toHaveLength(1);
    expect(ctx.shop.operatorResolutions(id)[0]).toMatchObject({ decision: "delivered", operator_id: STAFF });

    // 決着したので確認キューから消える
    expect(inQueue(ctx, id)).toBe(false);
    expect(ctx.shop.unresolvedCaseKind(id)).toBeNull();
    ctx.db.close();
  });

  it("外部副作用は1つも実行されない — `shop_delivered` を捏造しない", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    confirmDelivered(ctx, id);

    // 配送を実行したことにしない。**記録したのは「人が確認した」という事実だけ**
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    expect(ctx.events.listByType("shop_operator_resolution")).toHaveLength(1);
    ctx.db.close();
  });

  it("歴史を書き換えない — `delivered_at` を今日の日付で捏造しない", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    const before = ctx.shop.getPurchase(id)!;
    confirmDelivered(ctx, id);
    const after = ctx.shop.getPurchase(id)!;

    // 人が今日確認したからといって、今日が配送日時だったわけではない
    expect(after.delivered_at).toBeNull();
    // 過去の工程状態もそのまま。**別の次元の事実として並存させる**
    expect(after.delivery_state).toBe(before.delivery_state);
    expect(after.purchased_at).toBe(before.purchased_at);
    ctx.db.close();
  });

  it("決着後は提供済みの正本になる", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    const snapshotBefore = ctx.shop.safetySnapshot(id)!;
    expect(snapshotBefore.fulfillment.evidence).toBe(false);

    confirmDelivered(ctx, id);

    const snap = ctx.shop.safetySnapshot(id)!;
    expect(snap.fulfillment.evidence).toBe(true);
    expect(snap.operatorCase).toEqual({ unresolved: false, decided: "delivered" });
    expect(snap.refund).toEqual({
      settlementIssueHistory: 0,
      settlementPending: false,
      recoveryOpen: false,
      operationsHandoff: false,
    });
    // **工程状態と観測結果は直交したまま。** 片方から他方を書き換えていない
    expect(snap.fulfillment.deliveredAt).toBeNull();
    expect(snap.fulfillment.state).toBe("delivered"); // 移行の推測値がそのまま残っている
    expect(snap.contradictions).toEqual([]);
    ctx.db.close();
  });
});

// ── §13 pending / manual regression ──────────────────────────────────────────

describe("推測値すら無い旧購入（手動サービス時代）も同じ経路で決着できる", () => {
  it("`delivery_state='pending'` を、偽の配送日時なしで確定できる", () => {
    const ctx = setup();
    const id = legacyPending(ctx);
    expect(ctx.shop.unresolvedCaseKind(id)).toBe("legacy_unknown");

    confirmDelivered(ctx, id, STAFF, "面談を実施済み。記録は面談ログにある");

    const snap = ctx.shop.safetySnapshot(id)!;
    expect(snap.fulfillment.evidence).toBe(true);
    expect(snap.fulfillment.deliveredAt).toBeNull();
    // **`pending` のまま。** authority を通すために `delivered` へ寄せない
    expect(snap.fulfillment.state).toBe("pending");
    expect(snap.operatorCase.decided).toBe("delivered");
    expect(snap.contradictions).toEqual([]);
    expect(inQueue(ctx, id)).toBe(false);
    ctx.db.close();
  });

  it("スナップショットはあるが結末が不明な旧購入も決着できる", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx, USER, {
      delivery_snapshot_json: JSON.stringify({
        delivery: "auto",
        delivery_kind: "add_role",
        delivery_data: { role_id: ROLE },
      }),
      delivery_state: "pending",
    });
    expect(ctx.shop.isLegacyAutoOutcomeUnknown(id)).toBe(true);

    confirmDelivered(ctx, id, STAFF, "Discordでロール保持を確認");

    expect(ctx.shop.isLegacyAutoOutcomeUnknown(id)).toBe(false);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(true);
    expect(inQueue(ctx, id)).toBe(false);
    ctx.db.close();
  });
});

// ── §8 safety ────────────────────────────────────────────────────────────────

describe("決着後の安全性", () => {
  it("返金は `ERR_ALREADY_DELIVERED` で拒まれる", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    confirmDelivered(ctx, id);

    expect(() => ctx.shop.refund(id, "あとから返金", STAFF)).toThrow(
      expect.objectContaining({ code: "ERR_ALREADY_DELIVERED" }),
    );
    expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    expect(ctx.events.listByType("shop_refunded")).toHaveLength(0);
    ctx.db.close();
  });

  it("`no_effect` は逆の authority のまま — 返金できる", () => {
    const ctx = setup();
    const id = legacyPending(ctx);
    const before = ctx.ledger.balanceOf(`user:${USER}`);

    const result = ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "no_effect",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: STAFF,
      note: "何も提供されていないことを確認",
      refund: true,
    });

    expect(result.refunded).toBe(true);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before + PRICE);
    expect(ctx.shop.getPurchase(id)!.status).toBe("refunded");
    // **`delivered` と `no_effect` は正反対。** 「両方ともキューを閉じる」を理由に
    // 同じ扱いにしない
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);
    expect(ctx.shop.operatorConfirmedNoEffect(id)).toBe(true);
    ctx.db.close();
  });

  it("`no_effect` は提供済みの証拠にならない", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "no_effect",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: STAFF,
      note: "提供されていない",
    });
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);
    ctx.db.close();
  });

  it("配送やり直し・手動対応のキューへ戻ってこない", () => {
    const ctx = setup();
    // 通常購入 → 外部claim が結果不明のまま残った確認案件
    const purchase = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
    }).purchase;
    const claim = ctx.shop.claimExternalDelivery({
      purchaseId: purchase.id,
      deliveryKind: "add_role",
      actor: "system",
    }) as { token: string };
    ctx.shop.markExternalDeliveryUncertain({
      purchaseId: purchase.id,
      token: claim.token,
      reason: "final_fetch_failed",
      actor: "system",
    });
    expect(ctx.shop.quoteOperatorResolution(purchase.id).kind).toBe("uncertain_delivery");

    confirmDelivered(ctx, purchase.id, STAFF, "Discord側でロールが付いていることを確認");

    // claim は同じ transaction で決着している
    expect(ctx.shop.externalDeliveryClaim(purchase.id)).toBeUndefined();
    // どのキューにも戻らない
    expect(ctx.shop.listUndeliveredAuto(500).some((r) => r.id === purchase.id)).toBe(false);
    expect(ctx.shop.listPendingManual({ limit: 500 }).some((r) => r.id === purchase.id)).toBe(false);
    expect(ctx.shop.listRefundFailures({ limit: 500 }).some((r) => r.purchaseId === purchase.id)).toBe(false);
    expect(inQueue(ctx, purchase.id)).toBe(false);
    ctx.db.close();
  });

  it("自動配送が効果を再実行しない", () => {
    const ctx = setup();
    const purchase = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
    }).purchase;
    const claim = ctx.shop.claimExternalDelivery({
      purchaseId: purchase.id,
      deliveryKind: "add_role",
      actor: "system",
    }) as { token: string };
    ctx.shop.markExternalDeliveryUncertain({
      purchaseId: purchase.id,
      token: claim.token,
      reason: "final_fetch_failed",
      actor: "system",
    });
    confirmDelivered(ctx, purchase.id, STAFF, "Discord側で確認");

    // **workerが直接叩いてきても止める。** 一覧に出ないことは authority ではない
    const begin = ctx.shop.beginDelivery(purchase.id);
    expect(begin.proceed).toBe(false);
    expect(begin.reason).toBe("delivered");
    ctx.db.close();
  });

  it("剥奪対象は決着からは決めない — 現在の商品設定へ落ちない", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx, USER, { expires_at: 1 });
    confirmDelivered(ctx, id);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(true);
    // 購入時の証拠が無いので、提供済みでも剥がす対象は決まらない
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toEqual({ kind: "legacy_unknown" });

    expect(ctx.shop.expireIfDue(id, "system:cron").expired).toBe(true);
    // **商品の現在設定（role_id=r-vip）からロールを推測して剥奪キューへ入れない**
    expect(
      ctx.db.prepare("SELECT COUNT(*) FROM shop_role_revocations WHERE purchase_id = ?").pluck().get(id),
    ).toBe(0);
    expect(
      ctx.events.listByType("shop_role_revocation_unresolved").some((e) => {
        const p = JSON.parse(e.payload_json ?? "{}") as { purchaseId?: number; reason?: string };
        return p.purchaseId === id && p.reason === "role_target_unknown";
      }),
    ).toBe(true);
    ctx.db.close();
  });

  it("購入時の証拠でロールが確定できるなら、失効時に剥奪キューへ載る", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx, USER, {
      expires_at: 1,
      delivery_snapshot_json: JSON.stringify({
        delivery: "auto",
        delivery_kind: "add_role",
        delivery_data: { role_id: ROLE },
      }),
      delivery_state: "pending",
    });
    confirmDelivered(ctx, id, STAFF, "ロール保持を確認");
    expect(ctx.shop.expireIfDue(id, "system:cron").expired).toBe(true);

    const revocation = ctx.db
      .prepare("SELECT role_id, status FROM shop_role_revocations WHERE purchase_id = ?")
      .get(id) as { role_id: string; status: string } | undefined;
    // 剥奪対象は**購入時スナップショット**由来。決着が根拠になっているのは
    // 「与えたことがある」の方だけ
    expect(revocation).toMatchObject({ role_id: ROLE, status: "pending" });
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toEqual({
      kind: "proven",
      roleId: ROLE,
      source: "purchase_snapshot",
    });
    ctx.db.close();
  });
});

// ── §11 stale / concurrency ──────────────────────────────────────────────────

describe("決着の競合", () => {
  it("H-delivered-1: 何も動いていなければ、ちょうど1行だけ積まれる", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    const quote = ctx.shop.quoteOperatorResolution(id);
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "delivered",
      expectedToken: quote.token,
      actor: STAFF,
      note: "確認済み",
    });
    expect(ctx.shop.operatorResolutions(id)).toHaveLength(1);
    ctx.db.close();
  });

  it("H-delivered-2: 2人が同じ画面を開き、後から出した方は stale で弾かれる", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    const viewA = ctx.shop.quoteOperatorResolution(id);
    const viewB = ctx.shop.quoteOperatorResolution(id); // B も同時に開いている

    confirmDelivered(ctx, id, STAFF);

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: id,
        decision: "delivered",
        expectedToken: viewB.token,
        actor: OTHER,
        note: "こちらでも確認",
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));
    expect(viewA.token).toBe(viewB.token);
    expect(ctx.shop.operatorResolutions(id)).toHaveLength(1);
    ctx.db.close();
  });

  it("H-delivered-3: 画面を開いた後に claim が動いたら、古い決定は通らない", () => {
    const ctx = setup();
    const purchase = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
    }).purchase;
    const claim = ctx.shop.claimExternalDelivery({
      purchaseId: purchase.id,
      deliveryKind: "add_role",
      actor: "system",
    }) as { token: string };
    const stale = ctx.shop.quoteOperatorResolution(purchase.id);

    // 画面を開いたあとに worker が「結果が分からない」へ動かした
    ctx.shop.markExternalDeliveryUncertain({
      purchaseId: purchase.id,
      token: claim.token,
      reason: "final_fetch_failed",
      actor: "system",
    });

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: purchase.id,
        decision: "delivered",
        expectedToken: stale.token,
        actor: STAFF,
        note: "確認済み",
      }),
    ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_STALE" }));
    expect(ctx.shop.operatorResolutions(purchase.id)).toHaveLength(0);
    ctx.db.close();
  });

  it("H-delivered-4: 提出前に返金・失効・取消されたら決着させない", () => {
    for (const terminal of ["refunded", "expired", "cancelled"] as const) {
      const ctx = setup();
      const id = legacyPending(ctx);
      const quote = ctx.shop.quoteOperatorResolution(id);
      ctx.db.prepare("UPDATE shop_purchases SET status = ? WHERE id = ?").run(terminal, id);

      expect(() =>
        ctx.shop.resolveOperatorCase({
          purchaseId: id,
          decision: "delivered",
          expectedToken: quote.token,
          actor: STAFF,
          note: "確認済み",
        }),
      ).toThrow(ShopError);
      expect(ctx.shop.operatorResolutions(id)).toHaveLength(0);
      expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);
      ctx.db.close();
    }
  });

  /**
   * **終わった購入を「提供できていた」にできる唯一の抜け道を塞ぐ。**
   *
   * 生きている claim があると `unresolvedCaseKind()` は status を見ずに
   * `uncertain_delivery` を返す。そのため「もう決着している」判定では止まらない。
   * さらに、決着済みになった**あとに**画面を開けば指紋も一致してしまう。
   * この形では、`delivered` 側の status 判定だけが最後の守りになる。
   */
  it("H-delivered-4b: claim が生きていても、終わった購入は決着させない", () => {
    for (const terminal of ["refunded", "expired", "cancelled"] as const) {
      const ctx = setup();
      const purchase = ctx.shop.purchase({
        itemId: ctx.item.id,
        userId: USER,
        actor: `user:${USER}`,
        memberRoleIds: [],
        expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
      }).purchase;
      const claim = ctx.shop.claimExternalDelivery({
        purchaseId: purchase.id,
        deliveryKind: "add_role",
        actor: "system",
      }) as { token: string };
      ctx.shop.markExternalDeliveryUncertain({
        purchaseId: purchase.id,
        token: claim.token,
        reason: "final_fetch_failed",
        actor: "system",
      });
      // 別経路で終わった。claim は取り残されている
      ctx.db.prepare("UPDATE shop_purchases SET status = ? WHERE id = ?").run(terminal, purchase.id);

      // **決着待ちのまま。** つまり「もう決着している」判定では止まらない
      expect(ctx.shop.unresolvedCaseKind(purchase.id)).toBe("uncertain_delivery");
      // 指紋も一致する（終わったあとに画面を開いた）
      const quote = ctx.shop.quoteOperatorResolution(purchase.id);

      expect(() =>
        ctx.shop.resolveOperatorCase({
          purchaseId: purchase.id,
          decision: "delivered",
          expectedToken: quote.token,
          actor: STAFF,
          note: "確認済み",
        }),
      ).toThrow(expect.objectContaining({ code: "ERR_RESOLUTION_NOT_APPLICABLE" }));

      // 1行も書いていない。claim も動かしていない
      expect(ctx.shop.operatorResolutions(purchase.id)).toHaveLength(0);
      expect(ctx.shop.safetySnapshot(purchase.id)!.fulfillment.evidence).toBe(false);
      expect(ctx.shop.externalDeliveryClaim(purchase.id)?.state).toBe("uncertain");
      ctx.db.close();
    }
  });

  it("H-delivered-5: 提出前に本物の配送証拠が現れたら、二重の authority を作らない", () => {
    const ctx = setup();
    const id = legacyPending(ctx);
    const quote = ctx.shop.quoteOperatorResolution(id);

    // 別経路（手動対応の完了）で本物の配送記録が立った
    ctx.db.prepare("UPDATE shop_purchases SET delivered_at = 100 WHERE id = ?").run(id);

    expect(() =>
      ctx.shop.resolveOperatorCase({
        purchaseId: id,
        decision: "delivered",
        expectedToken: quote.token,
        actor: STAFF,
        note: "確認済み",
      }),
    ).toThrow(ShopError);
    // 証拠は1つのまま。運営の決着行は積まれない
    expect(ctx.shop.operatorResolutions(id)).toHaveLength(0);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(true);
    expect(inQueue(ctx, id)).toBe(false);
    ctx.db.close();
  });
});

// ── §9 #58: 推測値が本物の配送記録を握り潰す衝突 ──────────────────────────────

describe("#58 と同じ衝突を、理解したうえで残さない", () => {
  /**
   * `markDeliverySucceeded()` は「配送を完了させる」operation なので、
   * `delivery_state='delivered'` を見ると**黙って false を返す**。
   *
   * 本番の #58 は、期限つきアクセスの巡回が実際にロールを付け直し、
   * force refetch で在席を確認したうえでこれを呼んだ。しかし移行の推測値が
   * 先にあったため早期 return し、`delivered_at` も `shop_delivered` も残らなかった。
   *
   * **この回帰は「まだ直っていない」ことを固定する。** 直す（＝
   * `shop_timed_access_restored` を提供済みの正本へ昇格させる）のは別タスク。
   * ここで守るのは、衝突の存在が忘れられて別の場所で同じ設計が再導入されないこと。
   */
  it("`markDeliverySucceeded` は推測値の前で黙って false を返す（既知の衝突）", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);

    expect(ctx.shop.markDeliverySucceeded(id, "system:shop-timed-access")).toBe(false);
    // 呼んだ側から見ると成功していないので、証拠が1つも残らない
    expect(ctx.shop.getPurchase(id)!.delivered_at).toBeNull();
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);
    ctx.db.close();
  });

  it("運営の決着はその衝突を通り抜ける — 別の operation だから", () => {
    const ctx = setup();
    const id = legacyInferredDelivered(ctx);
    expect(ctx.shop.markDeliverySucceeded(id, "system")).toBe(false); // A は通らない
    expect(confirmDelivered(ctx, id).decision).toBe("delivered"); // B は通る
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(true);
    ctx.db.close();
  });

  it("通常の配送の exactly-once は壊れていない", () => {
    const ctx = setup();
    const purchase = ctx.shop.purchase({
      itemId: ctx.item.id,
      userId: USER,
      actor: `user:${USER}`,
      memberRoleIds: [],
      expectedTermsToken: ctx.shop.quoteGenericPurchase(ctx.item.id).termsToken,
    }).purchase;

    let effects = 0;
    expect(ctx.shop.completeDeliveryWith(purchase.id, "system", () => void effects++)).toBe(true);
    expect(ctx.shop.completeDeliveryWith(purchase.id, "system", () => void effects++)).toBe(false);
    expect(effects).toBe(1); // **2回目の効果は走らない**
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
    ctx.db.close();
  });
});
