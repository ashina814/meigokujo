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
});
