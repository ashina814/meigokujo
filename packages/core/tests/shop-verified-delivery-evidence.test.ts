import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, ShopError, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

/**
 * **Bot が外部効果の成立を独立に確認できたなら、それも提供済みの正本になる。**
 *
 * Task #211 で「配送を実行する」と「提供済みの事実を記録する」を分けた。
 * 記録側の authority は運営（人）しか持っていなかったので、Bot が自分で確かめた
 * 事実は行き場が無く、工程状態の推測値に握り潰されて消えていた（本番 #58）。
 *
 * ここで確かめるのは、記録側に **Bot の観測**という2つ目の出所を足しても、
 * 実行側の exactly-once も、返金・失効・剥奪の authority も緩まないこと。
 */

registerDefaultTxTypes();
const USER = "u-verified";
const ROLE = "r-vip";
const PRICE = 30_000;
const WRITER = "system:shop-timed-access";
const SOURCE = "timed_access_role_added_and_refetched" as const;

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
    idempotencyKey: "seed:verified",
  });
  const item = shop.createItem(
    {
      name: "迷霊庭園入場券",
      price_land: PRICE,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: ROLE }),
    } as never,
    "staff",
  );
  return { db, ledger, events, shop, item };
}
type Ctx = ReturnType<typeof setup>;

const YEAR = 365 * 24 * 3600;
const snapshotJson = (roleId = ROLE) =>
  JSON.stringify({ delivery: "auto", delivery_kind: "add_role", delivery_data: { role_id: roleId } });

/**
 * **本番 #58 と同じ形。** `delivery_state='delivered'` は移行時の推測値で、
 * `delivered_at` も `shop_delivered` も provenance も無い。期限つきロール契約。
 */
function legacyTimedAccess(
  ctx: Ctx,
  opts: { userId?: string; roleId?: string; expiresIn?: number; deliveryState?: string } = {},
): number {
  return ctx.db
    .prepare(
      `INSERT INTO shop_purchases
         (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state,delivery_snapshot_json)
       VALUES (?,?,1,?,?,'active',?,?) RETURNING id`,
    )
    .pluck()
    .get(
      ctx.item.id,
      opts.userId ?? USER,
      Math.floor(Date.now() / 1000) + (opts.expiresIn ?? YEAR),
      PRICE,
      opts.deliveryState ?? "delivered",
      snapshotJson(opts.roleId ?? ROLE),
    ) as number;
}

/** 巡回が外部で確認できた、として記録を試みる */
const record = (ctx: Ctx, id: number, roleId = ROLE, userId = USER) =>
  ctx.shop.recordTimedAccessVerifiedDelivery({
    purchaseId: id,
    userId,
    roleId,
    writer: WRITER,
    detail: { itemId: ctx.item.id, verification: "force_refetch_role_present" },
  });

/** 購入時の証拠が何も無い旧購入（スナップショットも provenance も移行記録も無い） */
function legacyWithoutAnyTarget(ctx: Ctx): number {
  return ctx.db
    .prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,expires_at,paid_land,status,delivery_state)
       VALUES (?,?,1,?,?,'active','delivered') RETURNING id`,
    )
    .pluck()
    .get(ctx.item.id, USER, Math.floor(Date.now() / 1000) + YEAR, PRICE) as number;
}

// ── §12 #58 regression ───────────────────────────────────────────────────────

describe("#58 と同じ形で、証拠が推測値に握り潰されない", () => {
  it("移行の推測値があっても、確認した事実を記録できる", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);

    // 前提: この形は「配送を完了させる」経路では黙って弾かれる
    expect(ctx.shop.markDeliverySucceeded(id, WRITER)).toBe(false);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);

    // 記録側は通る。**別の operation だから**
    expect(record(ctx, id)).toBe(true);

    const snap = ctx.shop.safetySnapshot(id)!;
    expect(snap.fulfillment.evidence).toBe(true);
    expect(snap.fulfillment.verifiedExternal).toBe(true);
    expect(snap.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("工程の歴史を書き換えない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    const before = ctx.shop.getPurchase(id)!;

    record(ctx, id);

    const after = ctx.shop.getPurchase(id)!;
    expect(after.delivered_at).toBeNull(); // 偽の配送日時を作らない
    expect(after.delivery_state).toBe("delivered"); // 推測値も「直さない」
    expect(after.delivery_state).toBe(before.delivery_state);
    expect(after.status).toBe(before.status);
    // 「配送完了処理が走った」という印も捏造しない
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(0);
    expect(ctx.events.listByType("shop_delivery_evidence_recorded")).toHaveLength(1);
    ctx.db.close();
  });

  it("実行側の exactly-once は緩んでいない", () => {
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
    expect(effects).toBe(1);
    ctx.db.close();
  });

  it("記録しても、配送の再実行は始まらない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    record(ctx, id);

    const begin = ctx.shop.beginDelivery(id);
    expect(begin.proceed).toBe(false);
    expect(begin.reason).toBe("delivered");
    expect(ctx.shop.listUndeliveredAuto(500).some((r) => r.id === id)).toBe(false);
    ctx.db.close();
  });
});

// ── §8 append-only / idempotency ─────────────────────────────────────────────

describe("証拠は append-only で冪等", () => {
  it("同じ確認を何度やり直しても1行に収束する", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);

    expect(record(ctx, id)).toBe(true);
    expect(record(ctx, id)).toBe(false);
    expect(record(ctx, id)).toBe(false);

    expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(1);
    // event も1回だけ。再試行のたびに積むと確認回数を数えられなくなる
    expect(ctx.events.listByType("shop_delivery_evidence_recorded")).toHaveLength(1);
    ctx.db.close();
  });

  it("記録した行は書き換えも削除もできない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    record(ctx, id);

    expect(() => ctx.db.prepare("UPDATE shop_verified_delivery_evidence SET writer='x'").run()).toThrow(
      /append-only/,
    );
    expect(() => ctx.db.prepare("DELETE FROM shop_verified_delivery_evidence").run()).toThrow(/append-only/);
    ctx.db.close();
  });

  it("何を記録したかが監査できる", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    record(ctx, id);

    const row = ctx.shop.verifiedDeliveryEvidence(id)[0]!;
    expect(row).toMatchObject({ purchase_id: id, source: SOURCE, writer: WRITER, effect_target: ROLE });
    expect(row.observed_at).toBeGreaterThan(0);
    expect(JSON.parse(row.detail!)).toMatchObject({ verification: "force_refetch_role_present" });
    ctx.db.close();
  });

  it("終わった購入へは後から証拠を足さない", () => {
    for (const terminal of ["refunded", "expired", "cancelled"] as const) {
      const ctx = setup();
      const id = legacyTimedAccess(ctx);
      ctx.db.prepare("UPDATE shop_purchases SET status = ? WHERE id = ?").run(terminal, id);

      // throw ではなく false。**積めないことは失敗の証拠ではない**
      expect(record(ctx, id)).toBe(false);
      expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(0);
      expect(ctx.shop.safetySnapshot(id)!.contradictions).toEqual([]);
      ctx.db.close();
    }
  });

  it("存在しない購入は拒否する", () => {
    const ctx = setup();
    expect(() => record(ctx, 9999)).toThrow(
      expect.objectContaining({ code: "ERR_PURCHASE_NOT_FOUND" }),
    );
    ctx.db.close();
  });

  it("呼び出し側の transaction が巻き戻れば、証拠も残らない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    expect(() =>
      ctx.db.transaction(() => {
        record(ctx, id);
        throw new Error("boom");
      })(),
    ).toThrow("boom");
    expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(0);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);
    ctx.db.close();
  });
});

// ── §6 attribution ───────────────────────────────────────────────────────────

describe("帰属が一意でなければ、何も推測しない", () => {
  it("A: 契約1つ — 帰属は一意", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    expect(ctx.shop.timedAccessAttributionUnique(id, USER, ROLE)).toBe(true);
    ctx.db.close();
  });

  it("B: 同じ利用者・同じロールの契約が2つ — どちらへも帰属できない", () => {
    const ctx = setup();
    const a = legacyTimedAccess(ctx);
    const b = legacyTimedAccess(ctx);

    // **どちらも false。** ロールの付与は1回で、それがどちらの効果かは決まらない
    expect(ctx.shop.timedAccessAttributionUnique(a, USER, ROLE)).toBe(false);
    expect(ctx.shop.timedAccessAttributionUnique(b, USER, ROLE)).toBe(false);
    ctx.db.close();
  });

  it("C: 期限が違っても、同じロールなら帰属は決まらない", () => {
    const ctx = setup();
    const short = legacyTimedAccess(ctx, { expiresIn: 3600 });
    const long = legacyTimedAccess(ctx, { expiresIn: YEAR });
    // 「期限が長い方が本命」のような順序づけをしない
    expect(ctx.shop.timedAccessAttributionUnique(short, USER, ROLE)).toBe(false);
    expect(ctx.shop.timedAccessAttributionUnique(long, USER, ROLE)).toBe(false);
    ctx.db.close();
  });

  it("F: 片方が失効すれば、残った1つへ帰属できる", () => {
    const ctx = setup();
    const a = legacyTimedAccess(ctx);
    const b = legacyTimedAccess(ctx);
    expect(ctx.shop.timedAccessAttributionUnique(b, USER, ROLE)).toBe(false);

    ctx.db.prepare("UPDATE shop_purchases SET status='expired' WHERE id=?").run(a);

    expect(ctx.shop.timedAccessAttributionUnique(b, USER, ROLE)).toBe(true);
    expect(ctx.shop.timedAccessAttributionUnique(a, USER, ROLE)).toBe(false);
    ctx.db.close();
  });

  it("ロールが違えば互いに干渉しない", () => {
    const ctx = setup();
    const vip = legacyTimedAccess(ctx, { roleId: ROLE });
    const other = legacyTimedAccess(ctx, { roleId: "r-other" });
    expect(ctx.shop.timedAccessAttributionUnique(vip, USER, ROLE)).toBe(true);
    expect(ctx.shop.timedAccessAttributionUnique(other, USER, "r-other")).toBe(true);
    ctx.db.close();
  });

  it("利用者が違えば互いに干渉しない", () => {
    const ctx = setup();
    const mine = legacyTimedAccess(ctx);
    const theirs = legacyTimedAccess(ctx, { userId: "u-other" });
    expect(ctx.shop.timedAccessAttributionUnique(mine, USER, ROLE)).toBe(true);
    expect(ctx.shop.timedAccessAttributionUnique(theirs, "u-other", ROLE)).toBe(true);
    ctx.db.close();
  });

  it("帰属の判定は購入の並び順に依存しない", () => {
    const ctx = setup();
    const ids = [legacyTimedAccess(ctx), legacyTimedAccess(ctx), legacyTimedAccess(ctx)];
    // Map の後勝ちで「id最大」が代表になるが、**代表であることは証拠ではない**
    for (const id of ids) expect(ctx.shop.timedAccessAttributionUnique(id, USER, ROLE)).toBe(false);
    ctx.db.close();
  });

  it("現在の商品設定を変えても、帰属の判定は変わらない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    expect(ctx.shop.timedAccessAttributionUnique(id, USER, ROLE)).toBe(true);

    // 運営が商品のロールを差し替えた。**購入時スナップショットが正本**
    ctx.db
      .prepare("UPDATE shop_items SET delivery_data = ? WHERE id = ?")
      .run(JSON.stringify({ role_id: "r-changed" }), ctx.item.id);

    expect(ctx.shop.timedAccessAttributionUnique(id, USER, ROLE)).toBe(true);
    expect(ctx.shop.timedAccessAttributionUnique(id, USER, "r-changed")).toBe(false);
    ctx.db.close();
  });
});

// ── Round 1 §1/§4: 購入時の不変な証拠だけを帰属の根拠にする ──────────────────

describe("互換で復元できることと、提供済みへ昇格できることは別", () => {
  it("購入時の証拠が無い旧購入は、現在の商品設定が一致していても証拠にならない", () => {
    const ctx = setup();
    const id = legacyWithoutAnyTarget(ctx);
    // 現在の商品は期限つき add_role で、ロールも一致している
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toEqual({ kind: "legacy_unknown" });

    // 巡回が互換経路でロールを復元し、force refetch まで成功したとしても——
    expect(record(ctx, id, ROLE)).toBe(false);

    // **現在の商品設定を根拠に、過去の購入の返金を拒む authority を作らない**
    expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(0);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.verifiedExternal).toBe(false);
    ctx.db.close();
  });

  it("購入時のロールと観測したロールが違えば書かない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { roleId: "r-contracted" });
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toMatchObject({ roleId: "r-contracted" });

    expect(record(ctx, id, "r-observed")).toBe(false);
    expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(0);
    ctx.db.close();
  });

  it("購入時のロールと観測したロールが一致すれば書く（#58型）", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toEqual({
      kind: "proven",
      roleId: ROLE,
      source: "purchase_snapshot",
    });

    expect(record(ctx, id, ROLE)).toBe(true);
    expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(1);
    ctx.db.close();
  });

  it("購入者が違えば書かない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    expect(record(ctx, id, ROLE, "u-someone-else")).toBe(false);
    expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(0);
    ctx.db.close();
  });

  it("移行記録で対象は証明できても、契約として見えなければ書かない（安全側）", () => {
    const ctx = setup();
    const id = legacyWithoutAnyTarget(ctx);
    // 期限つきアクセスの移行で「このロールを配った」と明示的に残っている
    ctx.db
      .prepare(
        `INSERT INTO shop_timed_access_legacy_runs
           (migration_key, plan_json, actor_id, reason, started_at, completed_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run("test-migration", "[]", "staff", "test", 1, 1);
    ctx.db
      .prepare(
        `INSERT INTO shop_timed_access_legacy_imports
           (purchase_id, migration_key, item_id, user_id, role_id, started_at, expires_at, reason, actor_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, "test-migration", ctx.item.id, USER, ROLE, 1, Math.floor(Date.now() / 1000) + YEAR, "test", "staff", 1);
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toMatchObject({
      kind: "proven",
      roleId: ROLE,
      source: "timed_access_legacy_import",
    });

    // それでも書けない。スナップショットが無い購入が有効な期限つき契約として
    // 見えるのは**互換経路だけ**で、その経路は「既に提供済みの証拠がある」ことを
    // 前提にしている。まだ証拠が無い段階では帰属先として数えられない。
    // **緩めない。** 対象が証明できることと、帰属が一意に決まることは別の問い
    expect(ctx.shop.timedAccessAttributionUnique(id, USER, ROLE)).toBe(false);
    expect(record(ctx, id, ROLE)).toBe(false);
    ctx.db.close();
  });

  it("互換経路で見えていても、帰属の根拠は移行記録（現在の商品設定ではない）", () => {
    const ctx = setup();
    const id = legacyWithoutAnyTarget(ctx);
    ctx.db
      .prepare(
        `INSERT INTO shop_timed_access_legacy_runs
           (migration_key, plan_json, actor_id, reason, started_at, completed_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run("m2", "[]", "staff", "test", 1, 1);
    ctx.db
      .prepare(
        `INSERT INTO shop_timed_access_legacy_imports
           (purchase_id, migration_key, item_id, user_id, role_id, started_at, expires_at, reason, actor_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, "m2", ctx.item.id, USER, ROLE, 1, Math.floor(Date.now() / 1000) + YEAR, "test", "staff", 1);
    // 運営が確認済みなので、互換経路で有効契約として見えるようになった
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "delivered",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: "operator:1",
      note: "確認済み",
    });
    expect(ctx.shop.timedAccessAttributionUnique(id, USER, ROLE)).toBe(true);

    // **帰属の根拠は移行記録。** 現在の商品設定と違うロールを観測したら書かない
    expect(record(ctx, id, "r-from-current-config")).toBe(false);
    expect(record(ctx, id, ROLE)).toBe(true);
    ctx.db.close();
  });
});

// ── Round 1 §3: Race F — 通常配送と巡回の競合 ────────────────────────────────

describe("通常配送が外部へ投げている最中は、観測を帰属しない", () => {
  it("生きている claim があるあいだは証拠を書かない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    ctx.shop.claimExternalDelivery({ purchaseId: id, deliveryKind: "add_role", actor: "system:auto" });

    // 誰の実行による効果かが決まらない。**曖昧なまま提供済みにしない**
    expect(record(ctx, id, ROLE)).toBe(false);
    expect(ctx.shop.verifiedDeliveryEvidence(id)).toHaveLength(0);
    // claim を握ったままの購入へ提供済みを立てると、この矛盾が成立してしまう
    expect(ctx.shop.safetySnapshot(id)!.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("結果が分からないまま残っている claim でも書かない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    const claim = ctx.shop.claimExternalDelivery({
      purchaseId: id,
      deliveryKind: "add_role",
      actor: "system:auto",
    }) as { token: string };
    ctx.shop.markExternalDeliveryUncertain({
      purchaseId: id,
      token: claim.token,
      reason: "final_fetch_failed",
      actor: "system:auto",
    });

    expect(record(ctx, id, ROLE)).toBe(false);
    expect(ctx.shop.safetySnapshot(id)!.contradictions).toEqual([]);
    ctx.db.close();
  });

  it("claim が決着したあとなら書ける", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    const claim = ctx.shop.claimExternalDelivery({
      purchaseId: id,
      deliveryKind: "add_role",
      actor: "system:auto",
    }) as { token: string };
    expect(record(ctx, id, ROLE)).toBe(false);

    ctx.shop.releaseExternalDelivery({
      purchaseId: id,
      token: claim.token,
      reason: "verified_no_effect",
      actor: "system:auto",
    });

    expect(record(ctx, id, ROLE)).toBe(true);
    expect(ctx.shop.safetySnapshot(id)!.contradictions).toEqual([]);
    ctx.db.close();
  });
});

// ── §9 / §10 canonical authority ─────────────────────────────────────────────

describe("正本としての強さと、金銭への帰結", () => {
  it("返金は拒まれる", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx);
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    record(ctx, id);

    expect(() => ctx.shop.refund(id, "あとから返金", "staff")).toThrow(
      expect.objectContaining({ code: "ERR_ALREADY_DELIVERED" }),
    );
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);
    expect(ctx.shop.getPurchase(id)!.status).toBe("active");
    ctx.db.close();
  });

  it("確認キュー・手動対応・配送やり直しのどこにも出ない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    expect(ctx.shop.unresolvedCaseKind(id)).toBe("legacy_unknown");

    record(ctx, id);

    expect(ctx.shop.unresolvedCaseKind(id)).toBeNull();
    expect(ctx.shop.listUnresolvedCases({ limit: 500 }).some((c) => c.purchaseId === id)).toBe(false);
    expect(ctx.shop.listPendingManual({ limit: 500 }).some((r) => r.id === id)).toBe(false);
    expect(ctx.shop.listUndeliveredAuto(500).some((r) => r.id === id)).toBe(false);
    expect(ctx.shop.listRefundFailures({ limit: 500 }).some((r) => r.purchaseId === id)).toBe(false);
    ctx.db.close();
  });

  it("運営の `no_effect` とは絶対に共有しない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "no_effect",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: "operator:1",
      note: "ロールが付いていないことを確認",
    });

    // 人が「提供されていない」と確認した。Botの証拠は1つも無い
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.evidence).toBe(false);
    expect(ctx.shop.safetySnapshot(id)!.fulfillment.verifiedExternal).toBe(false);
    expect(ctx.shop.operatorConfirmedNoEffect(id)).toBe(true);
    ctx.db.close();
  });

  it("Botの証拠と人の `no_effect` が同時に立てば、矛盾として表に出す", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "no_effect",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: "operator:1",
      note: "ロールが付いていないことを確認",
    });
    record(ctx, id);

    // **黙って片方を勝たせない。** 説明できない組み合わせは説明できないと出す
    expect(ctx.shop.safetySnapshot(id)!.contradictions).toContain("delivered_evidence_vs_operator_no_effect");
    ctx.db.close();
  });

  it("運営の決着と重なっても、意味は矛盾しない", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    ctx.shop.resolveOperatorCase({
      purchaseId: id,
      decision: "delivered",
      expectedToken: ctx.shop.quoteOperatorResolution(id).token,
      actor: "operator:1",
      note: "確認済み",
    });
    record(ctx, id);

    const snap = ctx.shop.safetySnapshot(id)!;
    expect(snap.fulfillment.evidence).toBe(true);
    expect(snap.fulfillment.verifiedExternal).toBe(true);
    expect(snap.operatorCase.decided).toBe("delivered");
    expect(snap.contradictions).toEqual([]);
    ctx.db.close();
  });
});

// ── §11 expiry / revocation separation ───────────────────────────────────────

describe("剥奪の対象は、証拠からは決めない", () => {
  it("購入時スナップショットがあれば、そこからだけ決まる", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { expiresIn: 60 });
    record(ctx, id);
    ctx.db.prepare("UPDATE shop_items SET kind='one_shot' WHERE id=?").run(ctx.item.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(id);

    expect(ctx.shop.expireIfDue(id, "system:cron").expired).toBe(true);
    const rev = ctx.db
      .prepare("SELECT role_id FROM shop_role_revocations WHERE purchase_id=?")
      .get(id) as { role_id: string } | undefined;
    expect(rev?.role_id).toBe(ROLE);
    expect(ctx.shop.roleGrantTarget(ctx.shop.getPurchase(id)!)).toMatchObject({ source: "purchase_snapshot" });
    ctx.db.close();
  });

  it("証拠の `effect_target` は照合のためだけ — 剥奪対象は購入時の証拠が決める", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { expiresIn: 60 });
    expect(record(ctx, id)).toBe(true);
    expect(ctx.shop.verifiedDeliveryEvidence(id)[0]!.effect_target).toBe(ROLE);

    // 商品の現在設定を差し替えても、剥奪対象は購入時スナップショットのまま
    ctx.db
      .prepare("UPDATE shop_items SET delivery_data = ?, kind='one_shot' WHERE id = ?")
      .run(JSON.stringify({ role_id: "r-changed" }), ctx.item.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(id);

    expect(ctx.shop.expireIfDue(id, "system:cron").expired).toBe(true);
    const rev = ctx.db
      .prepare("SELECT role_id FROM shop_role_revocations WHERE purchase_id=?")
      .get(id) as { role_id: string } | undefined;
    expect(rev?.role_id).toBe(ROLE);
    ctx.db.close();
  });

  it("失効の安全性は変わらない — 決着待ちの返金が残っていれば止まる", () => {
    const ctx = setup();
    const id = legacyTimedAccess(ctx, { deliveryState: "pending" });
    ctx.shop.recordRefundFailure({ purchaseId: id, amount: PRICE, reason: "delivery_failed", actor: "system" });
    ctx.db.prepare("UPDATE shop_items SET kind='one_shot' WHERE id=?").run(ctx.item.id);
    ctx.db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(id);
    expect(ctx.shop.expireIfDue(id, "system:cron").expired).toBe(false);
    ctx.db.close();
  });
});

// ── ShopError の型を使っていることの確認（未使用importにしない）──────────────
describe("エラーの型", () => {
  it("存在しない購入は ShopError", () => {
    const ctx = setup();
    expect(() => record(ctx, 12345)).toThrow(ShopError);
    ctx.db.close();
  });
});
