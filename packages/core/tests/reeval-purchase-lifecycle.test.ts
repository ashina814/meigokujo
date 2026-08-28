import { describe, expect, it } from "vitest";
import { EventLog, Evaluation, Ledger, REEVAL_INVITE_COUNT, REEVAL_PRICE_LAND, Settings, Shop, Tickets, openDb } from "../src/index.js";
import { Entry } from "../src/entry/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";

/**
 * 面談権（再評価チャレンジの購入）のライフサイクル。
 *
 * `linked_purchase_id` は**予約**であって消費ではない。面談結果を出さずに
 * チケットを普通に閉じたら、購入権は本人へ戻らなければならない。逆に承認・見送りで
 * 結果を出したら二度と使えてはいけない。
 */

registerDefaultTxTypes();
const STAFF = "user:staff";
const USER = "u1";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const tickets = new Tickets(db, events);
  // 面談権は「再評価権として発行された購入」。genericなstorefront購入では作れない
  // （旧商品がgenericへ落ちるのを防ぐguardが働く）ので、実際の発行経路を通す。
  let reevalItemId: number | null = null;
  const shop = new Shop(db, ledger, events, { reevalItemId: () => reevalItemId });
  const item = shop.createItem(
    {
      name: "再評価チャレンジ",
      price_land: REEVAL_PRICE_LAND,
      price_alt_kind: "invite",
      price_alt_amount: REEVAL_INVITE_COUNT,
      kind: "one_shot",
      delivery: "manual",
    },
    STAFF,
  );
  reevalItemId = item.id;
  settings.set("shop:reeval_item_id", item.id, STAFF);
  return { db, ledger, settings, events, entry, evaluation, shop, tickets, item };
}

function buy(ctx: ReturnType<typeof setup>, userId = USER) {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: "sys:treasury",
    to: `user:${userId}`,
    amount: REEVAL_PRICE_LAND * 2,
    type: "adjust",
    actor: STAFF,
    idempotencyKey: `seed-${userId}-${Math.random()}`,
  });
  ctx.db.prepare("INSERT OR IGNORE INTO souls (user_id,status,updated_at) VALUES (?, 'meirei', 1)").run(userId);
  return ctx.shop.purchaseReevaluation({
    itemId: ctx.item.id, userId, actor: STAFF, memberRoleIds: [],
    mode: "land", idempotencyKey: `reeval-${userId}-${Math.random()}`,
  }).purchase;
}

function openTicket(ctx: ReturnType<typeof setup>, threadId: string, userId = USER) {
  ctx.tickets.create(threadId, userId, "reeval", { id: "reeval", name: "再評価面談", notifyRoleIds: [], staffRoleIds: [] });
  return threadId;
}

/** bot 側の findUnconsumedReevalPurchase と同じ条件（未消費・未予約の面談権） */
function unconsumed(ctx: ReturnType<typeof setup>, userId = USER): number | null {
  const row = ctx.db
    .prepare(
      `SELECT p.id FROM shop_purchases p
        WHERE p.item_id = ? AND p.user_id = ? AND p.status = 'active'
          AND p.delivered_at IS NULL AND COALESCE(p.delivery_state,'pending') <> 'delivered'
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.linked_purchase_id = p.id)
        ORDER BY p.purchased_at LIMIT 1`,
    )
    .get(ctx.item.id, userId) as { id: number } | undefined;
  return row?.id ?? null;
}

describe("面談権は予約であって消費ではない", () => {
  it("面談結果を出さずに閉じたら購入権が戻り、次のチケットで使える", () => {
    const ctx = setup();
    const purchase = buy(ctx);
    openTicket(ctx, "t-1");
    expect(ctx.tickets.linkPurchase("t-1", purchase.id, STAFF)).toBe(true);
    // 予約中は他から取れない
    expect(unconsumed(ctx)).toBeNull();

    // 面談結果を出さずに普通に閉じる
    ctx.tickets.close("t-1", STAFF);

    expect(ctx.tickets.get("t-1")!.linked_purchase_id).toBeNull();
    expect(unconsumed(ctx)).toBe(purchase.id);
    // 新しいチケットで同じ購入を使える
    openTicket(ctx, "t-2");
    expect(ctx.tickets.linkPurchase("t-2", purchase.id, STAFF)).toBe(true);
    expect(ctx.events.listByType("ticket_purchase_released")).toHaveLength(1);
  });

  it("消費（配送完了）した後に閉じても購入権は戻らない", () => {
    const ctx = setup();
    const purchase = buy(ctx);
    openTicket(ctx, "t-1");
    ctx.tickets.linkPurchase("t-1", purchase.id, STAFF);

    // 面談結果を出した＝面談サービスを提供した
    ctx.shop.markDelivered(purchase.id, STAFF);
    ctx.tickets.close("t-1", STAFF);

    expect(ctx.tickets.get("t-1")!.linked_purchase_id).toBe(purchase.id);
    expect(unconsumed(ctx)).toBeNull();
    expect(ctx.events.listByType("ticket_purchase_released")).toHaveLength(0);
  });

  it("承認で消費した購入は再利用できない", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, STAFF);
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    openTicket(ctx, "t-1");
    ctx.tickets.linkPurchase("t-1", purchase.id, STAFF);

    // 承認と同じ確定処理（結果記録 + 消費 + close）
    ctx.db.transaction(() => {
      ctx.evaluation.reinstateFromMeirei(USER, STAFF, { purchaseId: purchase.id });
      ctx.shop.markDelivered(purchase.id, STAFF);
      ctx.tickets.close("t-1", STAFF);
    })();

    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
    expect(unconsumed(ctx)).toBeNull();
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).toBe("delivered");
  });

  it("見送りで消費した購入も再利用できない", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, STAFF);
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    openTicket(ctx, "t-1");
    ctx.tickets.linkPurchase("t-1", purchase.id, STAFF);

    ctx.db.transaction(() => {
      ctx.evaluation.recordReevalRejection(USER, STAFF, { purchaseId: purchase.id });
      ctx.shop.markDelivered(purchase.id, STAFF);
      ctx.tickets.close("t-1", STAFF);
    })();

    // 階級は変わらないが、面談権は消費される
    expect(ctx.entry.getSoul(USER)!.status).toBe("meirei");
    expect(unconsumed(ctx)).toBeNull();
    expect(ctx.tickets.get("t-1")!.status).toBe("closed");
  });

  it("面談結果の記録・購入の消費・チケットcloseが同じトランザクションで巻き戻る", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, STAFF);
    ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
    const purchase = buy(ctx);
    openTicket(ctx, "t-1");
    ctx.tickets.linkPurchase("t-1", purchase.id, STAFF);

    expect(() =>
      ctx.db.transaction(() => {
        ctx.evaluation.reinstateFromMeirei(USER, STAFF, { purchaseId: purchase.id });
        ctx.shop.markDelivered(purchase.id, STAFF);
        throw new Error("close で失敗した");
      })(),
    ).toThrow();

    // どれも起きていない
    expect(ctx.entry.getSoul(USER)!.status).toBe("meirei");
    expect(ctx.shop.getPurchase(purchase.id)!.delivery_state).not.toBe("delivered");
    expect(ctx.shop.getPurchase(purchase.id)!.delivered_at).toBeNull();
    // チケットは開いたまま、面談権も予約されたまま（消費されていない）。
    // 閉じれば予約は戻るので、権利は失われない
    expect(ctx.tickets.get("t-1")!.status).toBe("open");
    expect(ctx.tickets.get("t-1")!.linked_purchase_id).toBe(purchase.id);
    ctx.tickets.close("t-1", STAFF);
    expect(unconsumed(ctx)).toBe(purchase.id);
  });

  it("未消費の購入だけを面談権として拾う（返金済みは拾わない）", () => {
    const ctx = setup();
    const purchase = buy(ctx);
    ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(purchase.id);
    expect(unconsumed(ctx)).toBeNull();
  });
});

describe("承認直前の再確認（linked_purchase_id を信用しない）", () => {
  /** bot 側 verifyPurchase と同じ判定 */
  function verify(ctx: ReturnType<typeof setup>, purchaseId: number, ticketUserId: string): string | null {
    const purchase = ctx.shop.getPurchase(purchaseId);
    if (!purchase) return "purchase_not_found";
    if (purchase.user_id !== ticketUserId) return "user_mismatch";
    if (purchase.item_id !== ctx.item.id) return "item_mismatch";
    if (purchase.status !== "active") return `status:${purchase.status}`;
    if (purchase.delivered_at !== null || purchase.delivery_state === "delivered") return "already_consumed";
    return null;
  }

  it("返金済み・取消済みの購入は、link済みでも承認に使えない", () => {
    const ctx = setup();
    const purchase = buy(ctx);
    openTicket(ctx, "t-1");
    ctx.tickets.linkPurchase("t-1", purchase.id, STAFF);

    ctx.db.prepare("UPDATE shop_purchases SET status='refunded' WHERE id=?").run(purchase.id);
    expect(verify(ctx, purchase.id, USER)).toBe("status:refunded");

    ctx.db.prepare("UPDATE shop_purchases SET status='cancelled' WHERE id=?").run(purchase.id);
    expect(verify(ctx, purchase.id, USER)).toBe("status:cancelled");
  });

  it("別の利用者の購入が結ばれていても承認できない", () => {
    const ctx = setup();
    const other = buy(ctx, "someone-else");
    openTicket(ctx, "t-1", USER);
    ctx.tickets.linkPurchase("t-1", other.id, STAFF);

    expect(verify(ctx, other.id, USER)).toBe("user_mismatch");
  });

  it("別商品の購入が結ばれていても承認できない", () => {
    const ctx = setup();
    const another = ctx.shop.createItem({ name: "別商品", price_land: 10, kind: "one_shot", delivery: "manual" }, STAFF);
    ctx.ledger.ensureAccount(`user:${USER}`, "user");
    ctx.ledger.transfer({ from: "sys:treasury", to: `user:${USER}`, amount: 1_000, type: "adjust", actor: STAFF, idempotencyKey: "seed-x" });
    const wrong = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(another.id).termsToken, itemId: another.id, userId: USER, actor: STAFF, memberRoleIds: [] }).purchase;
    openTicket(ctx, "t-1");
    ctx.tickets.linkPurchase("t-1", wrong.id, STAFF);

    expect(verify(ctx, wrong.id, USER)).toBe("item_mismatch");
  });

  it("既に消費済みの購入は承認に使えない", () => {
    const ctx = setup();
    const purchase = buy(ctx);
    openTicket(ctx, "t-1");
    ctx.tickets.linkPurchase("t-1", purchase.id, STAFF);
    ctx.shop.markDelivered(purchase.id, STAFF);

    expect(verify(ctx, purchase.id, USER)).toBe("already_consumed");
  });
});

describe("旧自動解除の巻き戻し（waiting → meirei）", () => {
  it("status だけ戻し、評価期間・印・Landは復元しない", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, STAFF);
    ctx.evaluation.addMark(USER, "demotion", "user:e1", "evaluation");
    ctx.evaluation.demoteToMeirei(USER, STAFF, "期限到達");
    // 旧自動配送が案内待ちへ戻した状態を再現
    ctx.entry.resetToWaiting(USER, "shop:5");
    const balanceBefore = ctx.ledger.balanceOf(`user:${USER}`);
    const soulBefore = ctx.entry.getSoul(USER)!;
    expect(soulBefore.status).toBe("waiting");
    expect(soulBefore.eval_deadline_at).toBeNull();

    const ok = ctx.evaluation.legacyRollbackToMeirei(USER, STAFF, { purchaseId: 63, basis: "test" });

    expect(ok).toBe(true);
    const soul = ctx.entry.getSoul(USER)!;
    expect(soul.status).toBe("meirei");
    // 旧自動解除で消えた情報を推測して作り直さない
    expect(soul.ghost_at).toBeNull();
    expect(soul.eval_deadline_at).toBeNull();
    expect(soul.eval_started_at).toBeNull();
    expect(soul.eval_policy_version).toBeNull();
    // 印もLandも触らない
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM marks WHERE target_id = ? AND revoked_at IS NULL").get(USER)).toEqual({ n: 1 });
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(balanceBefore);
  });

  it("waiting でなければ何もしない", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, STAFF); // ghost
    const before = ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER);

    expect(ctx.evaluation.legacyRollbackToMeirei(USER, STAFF, {})).toBe(false);

    expect(ctx.db.prepare("SELECT * FROM souls WHERE user_id=?").get(USER)).toEqual(before);
    expect(ctx.events.listByTarget(USER).map((e) => e.type)).toContain("reeval_legacy_rollback_skipped");
  });

  it("巻き戻した後、面談OKで新しい評価サイクルが正規に始まる", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, STAFF);
    ctx.entry.resetToWaiting(USER, "shop:5");
    ctx.evaluation.legacyRollbackToMeirei(USER, STAFF, { purchaseId: 63 });

    const result = ctx.evaluation.reinstateFromMeirei(USER, STAFF, { purchaseId: 63 })!;

    const soul = ctx.entry.getSoul(USER)!;
    expect(soul.status).toBe("ghost");
    expect(soul.eval_deadline_at).toBe(result.deadline);
    expect(soul.eval_policy_version).not.toBeNull();
  });

  it("根拠を事件録へ残す", () => {
    const ctx = setup();
    ctx.entry.recordJoin(USER);
    ctx.entry.ghostify(USER, STAFF);
    ctx.entry.resetToWaiting(USER, "shop:5");

    ctx.evaluation.legacyRollbackToMeirei(USER, "user:approver", { purchaseId: 63, basis: "shop_auto_revoke_meirei_withdrawn" });

    const row = ctx.events.listByTarget(USER).find((e) => e.type === "reeval_legacy_rollback")!;
    expect(row.actor_id).toBe("user:approver");
    expect(JSON.parse(row.payload_json!)).toMatchObject({ from: "waiting", to: "meirei", purchaseId: 63 });
  });
});
