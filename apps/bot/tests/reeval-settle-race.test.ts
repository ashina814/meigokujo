import { describe, expect, it } from "vitest";
import { Entry, EventLog, Evaluation, Ledger, REEVAL_PRICE_LAND, Settings, Shop, Tickets, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import type { Services } from "../src/services.js";

/**
 * 面談結果を確定する直前の TOCTOU。
 *
 * ボタンを押してから確定トランザクションへ入るまでの間に、購入が返金される・
 * 階級が動く・別のスタッフがチケットを閉じる、といった変化が挟まりうる。
 * **確定はトランザクション内で正本を取り直し**、崩れていれば何も書かずに終わる。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const reevalModule = import("../src/commands/reeval.js");

const STAFF = "user:staff";
const USER = "1463201396567441441";
const THREAD = "t-1";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  const tickets = new Tickets(db, events);
  // 面談権は「再評価権として発行された購入」なので、fixtureも実際の発行経路
  // （`purchaseReevaluation`）を通す。genericなstorefront購入は再評価権ではない。
  let reevalItemId: number | null = null;
  const shop = new Shop(db, ledger, events, {
    reevalItemId: () => reevalItemId,
    // 受付panelはこのfixtureで用意する（`ready()` が作る）。
    assertReevaluationIntakeAvailable: () => {},
  });
  const item = shop.createItem(
    {
      name: "再評価チャレンジ",
      price_land: REEVAL_PRICE_LAND,
      price_alt_kind: "invite",
      price_alt_amount: 5,
      kind: "one_shot",
      delivery: "manual",
    },
    STAFF,
  );
  reevalItemId = item.id;
  settings.set("shop:reeval_item_id", item.id, STAFF);
  const services = { db, ledger, settings, events, entry, evaluation, shop, tickets } as unknown as Services;
  return { db, ledger, settings, events, entry, evaluation, shop, tickets, item, services };
}

/** 迷霊まで落ちた人 + 面談権 + 予約済みチケット */
function ready(ctx: ReturnType<typeof setup>) {
  ctx.entry.recordJoin(USER);
  ctx.entry.ghostify(USER, STAFF);
  ctx.db.prepare("UPDATE souls SET status='meirei' WHERE user_id=?").run(USER);
  ctx.ledger.transfer({
    from: "sys:treasury",
    to: `user:${USER}`,
    amount: REEVAL_PRICE_LAND * 2,
    type: "adjust",
    actor: STAFF,
    idempotencyKey: `seed-${Math.random()}`,
  });
  const purchase = ctx.shop.purchaseReevaluation({
    itemId: ctx.item.id,
    userId: USER,
    actor: STAFF,
    memberRoleIds: [],
    mode: "land",
    idempotencyKey: `reeval-${Math.random()}`,
  }).purchase;
  ctx.tickets.create(THREAD, USER, "reeval", { id: "reeval", name: "再評価面談", notifyRoleIds: [], staffRoleIds: [] });
  ctx.tickets.linkPurchase(THREAD, purchase.id, STAFF);
  return purchase.id;
}

const settleInput = (purchaseId: number, approve: boolean) => ({
  threadId: THREAD,
  targetId: USER,
  purchaseId,
  actor: STAFF,
  approve,
  evidence: { purchaseId },
});

/** 何も起きていないこと（階級・購入・チケット） */
function expectUntouched(ctx: ReturnType<typeof setup>, purchaseId: number, expectedStatus: string) {
  expect(ctx.entry.getSoul(USER)!.status).toBe(expectedStatus);
  const purchase = ctx.shop.getPurchase(purchaseId)!;
  expect(purchase.delivered_at).toBeNull();
  expect(purchase.delivery_state).not.toBe("delivered");
  expect(ctx.events.listByType("reeval_reinstated")).toHaveLength(0);
  expect(ctx.events.listByType("reeval_rejected")).toHaveLength(0);
}

describe("確定直前に購入が無効化された場合", () => {
  for (const status of ["refunded", "cancelled"] as const) {
    it(`${status} になった購入では承認しない・消費しない`, async () => {
      const { settleInterview } = await reevalModule;
      const ctx = setup();
      const purchaseId = ready(ctx);
      // guard 通過後にここで返金・取消が入った、という状況
      ctx.db.prepare("UPDATE shop_purchases SET status=? WHERE id=?").run(status, purchaseId);

      const result = settleInterview(ctx.services, settleInput(purchaseId, true));

      expect(result).toEqual({ ok: false, reason: `purchase_${status}` });
      expectUntouched(ctx, purchaseId, "meirei");
      expect(ctx.tickets.get(THREAD)!.status).toBe("open");
    });

    it(`${status} になった購入では見送りも記録しない・消費しない`, async () => {
      const { settleInterview } = await reevalModule;
      const ctx = setup();
      const purchaseId = ready(ctx);
      ctx.db.prepare("UPDATE shop_purchases SET status=? WHERE id=?").run(status, purchaseId);

      const result = settleInterview(ctx.services, settleInput(purchaseId, false));

      expect(result).toEqual({ ok: false, reason: `purchase_${status}` });
      expectUntouched(ctx, purchaseId, "meirei");
    });
  }

  it("既に消費済みの購入では二重に確定しない", async () => {
    const { settleInterview } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);
    ctx.shop.consumePurchaseForService(purchaseId, STAFF, { via: "reeval" });

    expect(settleInterview(ctx.services, settleInput(purchaseId, true)).ok).toBe(false);
    expect(ctx.entry.getSoul(USER)!.status).toBe("meirei");
    expect(ctx.events.listByType("reeval_reinstated")).toHaveLength(0);
  });
});

describe("確定直前に階級が動いた場合", () => {
  for (const status of ["ghost", "majin", "waiting"] as const) {
    it(`${status} へ変わっていたら承認も見送りも成立しない`, async () => {
      const { settleInterview } = await reevalModule;
      const ctx = setup();
      const purchaseId = ready(ctx);
      ctx.db.prepare("UPDATE souls SET status=? WHERE user_id=?").run(status, USER);

      const approve = settleInterview(ctx.services, settleInput(purchaseId, true));
      const reject = settleInterview(ctx.services, settleInput(purchaseId, false));

      expect(approve).toEqual({ ok: false, reason: `not_meirei:${status}` });
      expect(reject).toEqual({ ok: false, reason: `not_meirei:${status}` });
      expectUntouched(ctx, purchaseId, status);
      expect(ctx.tickets.get(THREAD)!.status).toBe("open");
    });
  }
});

describe("通常closeと面談結果確定の競合", () => {
  it("closeが先なら購入権が戻り、後続の承認は何もしない", async () => {
    const { settleInterview, findUnconsumedReevalPurchase } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);

    // 面談結果を出さずに閉じられた
    ctx.tickets.close(THREAD, STAFF);
    const result = settleInterview(ctx.services, settleInput(purchaseId, true));

    expect(result).toEqual({ ok: false, reason: "ticket_closed" });
    // 購入権は本人へ戻っている
    expect(findUnconsumedReevalPurchase(ctx.services, USER)).toEqual({ id: purchaseId });
    expectUntouched(ctx, purchaseId, "meirei");
  });

  it("承認が先なら購入は消費され、後続のcloseで権利が復活しない", async () => {
    const { settleInterview, findUnconsumedReevalPurchase } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);

    const result = settleInterview(ctx.services, settleInput(purchaseId, true));

    expect(result.ok).toBe(true);
    expect(ctx.entry.getSoul(USER)!.status).toBe("ghost");
    expect(ctx.tickets.get(THREAD)!.status).toBe("closed");
    expect(ctx.shop.getPurchase(purchaseId)!.delivery_state).toBe("delivered");

    // 後からもう一度閉じても権利は戻らない
    ctx.tickets.close(THREAD, STAFF);
    expect(findUnconsumedReevalPurchase(ctx.services, USER)).toBeNull();
    expect(ctx.events.listByType("ticket_purchase_released")).toHaveLength(0);
  });

  it("見送りが先でも購入は消費され、権利は復活しない", async () => {
    const { settleInterview, findUnconsumedReevalPurchase } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);

    const result = settleInterview(ctx.services, settleInput(purchaseId, false));

    expect(result.ok).toBe(true);
    expect(ctx.entry.getSoul(USER)!.status).toBe("meirei"); // 階級は動かない
    expect(ctx.tickets.get(THREAD)!.status).toBe("closed");
    ctx.tickets.close(THREAD, STAFF);
    expect(findUnconsumedReevalPurchase(ctx.services, USER)).toBeNull();
  });

  it("承認の二度押しは一度しか成立しない", async () => {
    const { settleInterview } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);

    const first = settleInterview(ctx.services, settleInput(purchaseId, true));
    const second = settleInterview(ctx.services, settleInput(purchaseId, true));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(ctx.events.listByType("reeval_reinstated")).toHaveLength(1);
    expect(ctx.events.listByType("shop_delivered")).toHaveLength(1);
  });
});

describe("チケットと購入の対応が崩れている場合", () => {
  it("予約が別の購入へ差し替わっていたら確定しない", async () => {
    const { settleInterview } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);
    ctx.db.prepare("UPDATE tickets SET linked_purchase_id = NULL WHERE thread_id = ?").run(THREAD);

    const result = settleInterview(ctx.services, settleInput(purchaseId, true));

    expect(result).toEqual({ ok: false, reason: "purchase_link_changed" });
    expectUntouched(ctx, purchaseId, "meirei");
  });

  it("再評価面談以外のチケットでは確定しない", async () => {
    const { settleInterview } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);
    ctx.db.prepare("UPDATE tickets SET panel_id = 'consult' WHERE thread_id = ?").run(THREAD);

    expect(settleInterview(ctx.services, settleInput(purchaseId, true))).toEqual({
      ok: false,
      reason: "ticket_missing_or_wrong_panel",
    });
    expectUntouched(ctx, purchaseId, "meirei");
  });

  it("販売設定が外れていても、既に成立した面談権は確定できる", async () => {
    // 利用者が買ったのは商品IDではなく「面談を1回受ける権利」。運営が販売設定を外しても、
    // 既に成立した権利まで確定不能にしてはいけない（新規販売が止まるだけ）。
    const { settleInterview } = await reevalModule;
    const ctx = setup();
    const purchaseId = ready(ctx);
    ctx.db.prepare("DELETE FROM settings WHERE key = 'shop:reeval_item_id'").run();

    const result = settleInterview(ctx.services, settleInput(purchaseId, true));
    expect(result.ok).toBe(true);
    const purchase = ctx.shop.getPurchase(purchaseId)!;
    expect(purchase.delivery_state).toBe("delivered");
    expect(ctx.db.prepare("SELECT status FROM souls WHERE user_id=?").get(USER)).toEqual({ status: "ghost" });
  });

  it("再評価権として発行されていない購入では確定しない（fail-closed）", async () => {
    const { settleInterview } = await reevalModule;
    const ctx = setup();
    ready(ctx);
    // genericなstorefront購入は面談権ではない。ticketへ結び替えても確定できない。
    const generic = ctx.shop.createItem({ name: "別商品", price_land: 1, kind: "one_shot", delivery: "manual" }, STAFF);
    const other = ctx.shop.purchase({ expectedTermsToken: ctx.shop.quoteGenericPurchase(generic.id).termsToken, itemId: generic.id, userId: USER, actor: STAFF, memberRoleIds: [] }).purchase;
    ctx.db.prepare("UPDATE tickets SET linked_purchase_id=? WHERE thread_id=?").run(other.id, THREAD);

    expect(settleInterview(ctx.services, settleInput(other.id, true))).toEqual({
      ok: false,
      reason: "purchase_not_reevaluation",
    });
    expect(ctx.db.prepare("SELECT status FROM souls WHERE user_id=?").get(USER)).toEqual({ status: "meirei" });
  });
});
