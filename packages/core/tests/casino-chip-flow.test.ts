import { describe, expect, it } from "vitest";
import {
  CasinoChipFlow,
  ChipLedger,
  EventLog,
  FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
  HouseReservations,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new ChipLedger(db, ledger, events);
  // PR10のactive-ownership検査はPR5の永続予約表を読む。テストでも本番と同じservice構築順にする。
  new HouseReservations(db, chips, events);
  const flow = new CasinoChipFlow(db, chips, events);
  for (const id of ["alice", "bob"]) {
    ledger.ensureAccount(`user:${id}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${id}`,
      amount: 1_000,
      type: "initial",
      actor: "test",
      idempotencyKey: `seed:${id}`,
    });
  }
  return { db, ledger, chips, flow };
}

describe("PR10 自動預入・自由チップ返還", () => {
  it("不足額だけを1:1で預け、同じ操作の再試行で二重預入しない", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 40, "seed:chips");
    expect(ctx.flow.ensureFreeChips("alice", 100, "spin-1")).toMatchObject({
      required: 100,
      freeBefore: 40,
      deposited: 60,
      freeAfter: 100,
    });
    expect(ctx.flow.ensureFreeChips("alice", 100, "spin-1")).toMatchObject({ deposited: 60, freeAfter: 100 });
    expect(ctx.ledger.balanceOf("user:alice")).toBe(900);
    ctx.db.close();
  });

  it("退場は自由チップだけを返し、escrow とフリースピンJP請求holderを触らない", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "chips:alice");
    ctx.chips.runGroup({ groupKey: "seed:escrow", kind: "test", actorId: "test" }, () =>
      ctx.chips.transfer("alice", "escrow:session:live", 30, { reason: "live escrow" }),
    );
    ctx.chips.runGroup({ groupKey: "seed:claim", kind: "test", actorId: "test" }, () =>
      ctx.chips.transfer("alice", FREE_SPIN_JACKPOT_CLAIMS_HOLDER, 20, { reason: "fixed claim" }),
    );
    expect(ctx.flow.leaveCasino("alice", "leave-1").redeemed).toBe(50);
    expect(ctx.chips.balanceOf("escrow:session:live")).toBe(30);
    expect(ctx.chips.balanceOf(FREE_SPIN_JACKPOT_CLAIMS_HOLDER)).toBe(20);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    ctx.db.close();
  });

  it("永続アクティビティで無操作者だけを返し、進行中予約の利用者は呼出側の指定なしでも除外する", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "seed:a");
    ctx.chips.deposit("bob", 100, "seed:b");
    ctx.flow.touch("alice", 10);
    ctx.flow.touch("bob", 10);
    ctx.db.prepare(
      "INSERT INTO casino_house_reservations (key,amount,game,user_id,created_at) VALUES ('active:bob',100,'slots','bob',0)",
    ).run();

    const result = ctx.flow.redeemInactive(100, "idle");
    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["alice"]);
    expect(result.skipped).toContain("bob");
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf("bob")).toBe(100);
    ctx.db.close();
  });

  it("域外確認は承認前に動かさず、固定した自由チップを返した後に同じoperation IDを一度だけ再開する", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 250, "seed:external");
    const confirmation = ctx.flow.createExternalConfirmation({
      id: "c1",
      userId: "alice",
      operationKind: "shop",
      operationId: "same-op",
      requiredLand: 100,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    expect(confirmation).toMatchObject({ status: "pending", chipAmount: 250 });
    expect(ctx.chips.balanceOf("alice")).toBe(250);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(750);

    let calls = 0;
    const first = ctx.flow.executeExternalConfirmation("c1", "alice", (operationId) => {
      calls += 1;
      expect(operationId).toBe("same-op");
      return "done";
    });
    expect(first).toBe("done");
    expect(calls).toBe(1);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(1_000);
    expect(() => ctx.flow.executeExternalConfirmation("c1", "alice", () => "again")).toThrow();
    expect(() => ctx.flow.executeExternalConfirmation("c1", "bob", () => "other")).toThrow();
    ctx.db.close();
  });

  it("域外操作本体が失敗しても返還を二重実行せず、同じoperation IDで再開できる", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 200, "seed:external-retry");
    ctx.flow.createExternalConfirmation({
      id: "c2",
      userId: "alice",
      operationKind: "shop",
      operationId: "stable-op",
      requiredLand: 100,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    expect(() => ctx.flow.executeExternalConfirmation("c2", "alice", () => {
      throw new Error("outside operation failed");
    })).toThrow("outside operation failed");
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(1_000);

    expect(ctx.flow.executeExternalConfirmation("c2", "alice", (operationId) => operationId)).toBe("stable-op");
    expect(ctx.ledger.balanceOf("user:alice")).toBe(1_000);
    expect(ctx.flow.externalConfirmation("c2")?.status).toBe("completed");
    ctx.db.close();
  });

  it("域外確認は進行中予約がある利用者に作成せず、確認後の残高変化も拒否する", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "seed:external-block");
    ctx.db.prepare(
      "INSERT INTO casino_house_reservations (key,amount,game,user_id,created_at) VALUES ('active:alice',100,'slots','alice',0)",
    ).run();
    expect(() => ctx.flow.createExternalConfirmation({
      id: "active",
      userId: "alice",
      operationKind: "shop",
      operationId: "op-active",
      requiredLand: 50,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })).toThrow("進行中");
    ctx.db.prepare("DELETE FROM casino_house_reservations").run();

    ctx.flow.createExternalConfirmation({
      id: "stale",
      userId: "alice",
      operationKind: "shop",
      operationId: "op-stale",
      requiredLand: 50,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    ctx.chips.deposit("alice", 1, "after-confirmation");
    expect(() => ctx.flow.executeExternalConfirmation("stale", "alice", () => undefined)).toThrow("変わっています");
    expect(ctx.chips.balanceOf("alice")).toBe(101);
    ctx.db.close();
  });

  it("緊急返還はdraftの対象人数・額を固定し、確認後に一人でも残高が変われば全件を動かさない", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "seed:a");
    ctx.chips.deposit("bob", 200, "seed:b");
    const draft = ctx.flow.createRefundSaga({ id: "refund-stale", requestedBy: "admin", scope: "all" });
    expect(draft).toMatchObject({ status: "draft", targetCount: 2, targetTotal: 300 });

    ctx.chips.deposit("alice", 1, "after-draft");
    const blocked = ctx.flow.executeRefundSaga("refund-stale", "admin");
    expect(blocked.status).toBe("blocked");
    expect(blocked.failure).toContain("残高が変化");
    expect(ctx.chips.freeChips("alice")).toBe(101);
    expect(ctx.chips.freeChips("bob")).toBe(200);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(899);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(800);
    ctx.db.close();
  });

  it("緊急返還は固定額を返し、クラッシュ後のsaga再開でも同じgroupを再生して一度だけ完了する", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "seed:a");
    ctx.chips.deposit("bob", 200, "seed:b");
    ctx.chips.runGroup({ groupKey: "seed:escrow-2", kind: "test", actorId: "test" }, () =>
      ctx.chips.transfer("alice", "escrow:session:live", 30, { reason: "live escrow" }),
    );
    const draft = ctx.flow.createRefundSaga({ id: "refund-1", requestedBy: "admin", scope: "all" });
    expect(draft).toMatchObject({ status: "draft", targetCount: 2, targetTotal: 270 });

    expect(ctx.flow.executeRefundSaga("refund-1", "admin", { activeGameUsers: () => ["alice"] }).status).toBe("blocked");
    expect(ctx.chips.freeChips("alice")).toBe(70);

    // 資金groupだけcommitし、saga target更新前に落ちた状態を再現する。
    ctx.flow.redeemExactFreeChips("alice", 70, "emergency:refund-1:alice", "緊急返還");
    const resumed = ctx.flow.executeRefundSaga("refund-1", "admin");
    expect(resumed.status).toBe("completed");
    expect(ctx.chips.freeChips("alice")).toBe(0);
    expect(ctx.chips.freeChips("bob")).toBe(0);
    expect(ctx.chips.balanceOf("escrow:session:live")).toBe(30);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(970);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(1_000);
    expect(ctx.flow.executeRefundSaga("refund-1", "admin").status).toBe("completed");
    ctx.db.close();
  });

  it("緊急返還は金銭group中・検算停止中・指定外の実行者を拒否する", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "seed:a");
    const draft = ctx.flow.createRefundSaga({
      id: "refund-2",
      requestedBy: "admin",
      scope: "user",
      userId: "alice",
    });
    expect(() => ctx.flow.executeRefundSaga(draft.id, "staff")).toThrow();
    expect(ctx.flow.executeRefundSaga(draft.id, "admin", { integrityBlocked: () => true }).status).toBe("blocked");
    expect(ctx.chips.freeChips("alice")).toBe(100);
    ctx.chips.runGroup({ groupKey: "test:busy", kind: "test", actorId: "test" }, () => {
      expect(ctx.flow.executeRefundSaga(draft.id, "admin").status).toBe("blocked");
      expect(ctx.chips.freeChips("alice")).toBe(100);
    });
    ctx.db.close();
  });
});
