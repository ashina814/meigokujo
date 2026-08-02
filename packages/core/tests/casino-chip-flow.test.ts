import { describe, expect, it } from "vitest";
import {
  CasinoChipFlow,
  ChipLedger,
  EventLog,
  FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  const flow = new CasinoChipFlow(db, chips, new EventLog(db));
  for (const id of ["alice", "bob"]) {
    ledger.ensureAccount(`user:${id}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${id}`, amount: 1_000, type: "initial", actor: "test", idempotencyKey: `seed:${id}` });
  }
  return { db, ledger, chips, flow };
}

describe("PR10 自動預入・自由チップ返還", () => {
  it("不足額だけを1:1で預け、同じ操作の再試行で二重預入しない", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 40, "seed:chips");
    expect(ctx.flow.ensureFreeChips("alice", 100, "spin-1")).toMatchObject({ required: 100, freeBefore: 40, deposited: 60, freeAfter: 100 });
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

  it("永続アクティビティで無操作者だけを返し、失敗者がいても後続を止めない", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "seed:a");
    ctx.chips.deposit("bob", 100, "seed:b");
    ctx.flow.touch("alice", 10);
    ctx.flow.touch("bob", 999);
    const r = ctx.flow.redeemInactive(100, "idle");
    expect(r.redeemed.map((x) => x.userId)).toEqual(["alice"]);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf("bob")).toBe(100);
    ctx.db.close();
  });

  it("域外操作確認票は本人だけが期限内に一度だけ実行権を取得でき、承認前は資金を動かさない", () => {
    const ctx = setup();
    const row = ctx.flow.createExternalConfirmation({ id: "c1", userId: "alice", operationKind: "shop", operationId: "op1", requiredLand: 100, expiresAt: Math.floor(Date.now() / 1000) + 60 });
    expect(row.status).toBe("pending");
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(() => ctx.flow.beginExternalConfirmation("c1", "bob")).toThrow();
    expect(ctx.flow.beginExternalConfirmation("c1", "alice").status).toBe("executing");
    expect(() => ctx.flow.beginExternalConfirmation("c1", "alice")).toThrow();
    expect(ctx.flow.completeExternalConfirmation("c1", "alice")).toBe(true);
    ctx.db.close();
  });

  it("域外確認は本人だけが保存済みoperation IDで再開でき、完了後・他人・古い操作を拒否する", () => {
    const ctx = setup();
    ctx.flow.createExternalConfirmation({ id: "c2", userId: "alice", operationKind: "shop", operationId: "same-op", requiredLand: 100, expiresAt: Math.floor(Date.now() / 1000) + 60 });
    expect(ctx.flow.executeExternalConfirmation("c2", "alice", (operationId) => operationId)).toBe("same-op");
    expect(() => ctx.flow.executeExternalConfirmation("c2", "alice", () => "again")).toThrow();
    expect(() => ctx.flow.executeExternalConfirmation("c2", "bob", () => "other")).toThrow();
    ctx.db.close();
  });

  it("緊急返還は対象人数・額を先に固定し、エスクローを含めず、saga再開でも一度だけ完了する", () => {
    const ctx = setup();
    ctx.chips.deposit("alice", 100, "seed:a");
    ctx.chips.deposit("bob", 200, "seed:b");
    ctx.chips.runGroup({ groupKey: "seed:escrow-2", kind: "test", actorId: "test" }, () =>
      ctx.chips.transfer("alice", "escrow:session:live", 30, { reason: "live escrow" }),
    );
    const draft = ctx.flow.createRefundSaga({ id: "refund-1", requestedBy: "admin", scope: "all" });
    expect(draft).toMatchObject({ status: "draft", targetCount: 2, targetTotal: 270 });
    expect(ctx.chips.freeChips("alice")).toBe(70);
    expect(ctx.flow.executeRefundSaga("refund-1", "admin", { activeGameUsers: () => ["alice"] }).status).toBe("blocked");
    expect(ctx.chips.freeChips("alice")).toBe(70);

    // DB commit後にsagaの完了記録だけ失われたクラッシュを模す。
    // 同じgroup keyのreplayにより、再開しても二重にLandを返さない。
    ctx.flow.redeemFreeChips("alice", "emergency:refund-1:alice", "緊急返還");
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
    const draft = ctx.flow.createRefundSaga({ id: "refund-2", requestedBy: "admin", scope: "user", userId: "alice" });
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
