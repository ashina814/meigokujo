import { describe, expect, it } from "vitest";
import {
  CasinoRemittance,
  ChipLedger,
  EventLog,
  HouseReservations,
  Ledger,
  TREASURY,
  deptAccount,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  const reservations = new HouseReservations(db, chips, new EventLog(db));
  const remit = new CasinoRemittance(db, ledger, chips, reservations);
  return { db, ledger, chips, reservations, remit };
}

function fundHouse(c: ReturnType<typeof setup>, amount = 1_000): void {
  c.chips.fundFromAccount(TREASURY, amount, "house", "seed:house");
}

describe("PR14 casino accounting and remittance", () => {
  it("derives classified realised P&L from settled groups exactly once and excludes refunds and JP claims", () => {
    const c = setup();
    fundHouse(c);
    c.chips.fundFromAccount(TREASURY, 100, "u1", "seed:u1");
    c.chips.runGroup({ groupKey: "round:1", kind: "solo_game", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "賭け金", game: "slots" });
      c.chips.transfer("house", "u1", 30, { reason: "配当", game: "slots" });
      c.chips.transfer("house", "u1", 10, { reason: "連鎖ボーナス", game: "slots" });
      c.chips.transfer("house", "jackpot", 5, { reason: "JP積立", game: "slots" });
    });
    c.chips.runGroup({ groupKey: "refund:1", kind: "refund", actorId: "system" }, () => {
      c.chips.transfer("house", "u1", 20, { reason: "無効試合の返金", game: "slots" });
    });
    c.chips.fundFromAccount(TREASURY, 7, "sys:casino:free-spin-jp-claims", "seed:free-claim");
    c.chips.runGroup({ groupKey: "free:claim", kind: "solo_game", actorId: "u1" }, () => {
      c.chips.transfer("sys:casino:free-spin-jp-claims", "u1", 7, { reason: "フリースピンJP請求", game: "slots" });
    });

    expect(c.remit.syncRealized()).toBe(4);
    expect(c.remit.syncRealized()).toBe(0);
    expect(c.remit.pnl().map((row) => [row.category, row.amount])).toEqual([
      ["wager", 100], ["payout", -30], ["chain_bonus", -10], ["jackpot_contribution", -5],
    ]);
    expect(c.remit.cumulativeProfit()).toBe(55);
    c.db.close();
  });

  it("includes VIP and shop income, fuku outflow, reservations and fuku reserve in the remittable base", () => {
    const c = setup();
    fundHouse(c, 1_000);
    c.chips.fundFromAccount(TREASURY, 1_000, "u1", "seed:u1");
    c.chips.runGroup({ groupKey: "income:1", kind: "vip", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "VIP加入" });
      c.chips.transfer("u1", "house", 50, { reason: "商店購入" });
      c.chips.transfer("house", "u1", 25, { reason: "福分け（胴元）" });
    });
    c.reservations.reserve("r1", 200, "slots", "u1");
    const draft = c.remit.draft("m1", 5_000, 300, "maker", { fukuReserve: 100 });

    expect(c.remit.cumulativeProfit()).toBe(125);
    expect(draft.snapshot).toMatchObject({ reservedObligations: 200, fukuReserve: 100, base: 125, amount: 62 });
    c.db.close();
  });

  it("requires durable second-person approval, rejects stale plans, and rolls back a failed execute", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    const draft = c.remit.draft("m1", 5_000, 200, "maker");
    expect(draft.amount).toBe(400);
    expect(() => c.remit.approve("m1", "maker")).toThrow("second approver");
    c.remit.approve("m1", "reviewer");

    c.remit.recordRealized("wager", 1, "manual:changed");
    expect(() => c.remit.execute("m1", "operator")).toThrow("stale");
    expect(c.remit.get("m1")?.status).toBe("approved");

    const fresh = c.remit.draft("m2", 5_000, 200, "maker");
    c.remit.approve("m2", "reviewer");
    c.ledger.ensureAccount(deptAccount("casino"), "system");
    const before = c.chips.balanceOf("house");
    const original = c.ledger.transfer.bind(c.ledger);
    c.ledger.transfer = ((input: never) => {
      if ((input as { type?: string }).type === "casino_remittance") throw new Error("land transfer failed");
      return original(input as never);
    }) as typeof c.ledger.transfer;
    expect(() => c.remit.execute("m2", "operator")).toThrow("land transfer failed");
    expect(c.chips.balanceOf("house")).toBe(before);
    expect(c.remit.get("m2")?.status).toBe("approved");
    c.db.close();
  });

  it("allows a zero-rate zero draft and makes a non-zero remittance exactly once", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    const zero = c.remit.draft("zero", 0, 200, "maker");
    expect(zero.amount).toBe(0);
    c.remit.approve("zero", "reviewer");
    expect(c.remit.execute("zero", "operator").status).toBe("executed");

    const draft = c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");
    const executed = c.remit.execute("m1", "operator");
    expect(executed.status).toBe("executed");
    expect(executed.landTxId).not.toBeNull();
    expect(executed.chipGroupKey).toBe("casino:remittance:m1");
    expect(c.remit.cumulativeUndisposedProfit()).toBe(400);
    expect(() => c.remit.execute("m1", "operator")).toThrow("not approved");
    c.db.close();
  });

  it("keeps bailout as a separate draft → second-person approval → exactly-once execution with shortage audit", () => {
    const c = setup();
    expect(() => c.remit.bailout("b1", 100, "maker", "reviewer")).toThrow("bailoutDraft");
    const draft = c.remit.bailoutDraft("b1", 100, "shortage", { required: 100, house: 0 }, "maker");
    expect(draft.shortage).toEqual({ required: 100, house: 0 });
    expect(() => c.remit.approve("b1", "maker")).toThrow("second approver");
    c.remit.approve("b1", "reviewer");
    const executed = c.remit.execute("b1", "operator");
    expect(executed.status).toBe("executed");
    expect(executed.landTxId).not.toBeNull();
    expect(c.chips.balanceOf("house")).toBe(100);
    expect(() => c.remit.execute("b1", "operator")).toThrow("not approved");
    c.db.close();
  });
});
