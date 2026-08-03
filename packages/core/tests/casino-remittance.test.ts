import { describe, expect, it } from "vitest";
import {
  CASINO_DEPARTMENT,
  CASINO_DEPARTMENT_KEY,
  CHIP_ESCROW,
  CHIP_OPENING_VERSION_KEY,
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

/** PR12 の開業設定を運営が確定した状態にする。 */
function configureOpening(
  c: ReturnType<typeof setup>,
  input: { bps: number; minimumWorkingCapital: number },
): void {
  c.db.prepare(
    `INSERT INTO casino_opening_configuration
      (id, casino_opening_capital, casino_opening_house, casino_opening_jackpot, casino_opening_relief,
       casino_min_working_capital, casino_remit_rate_bps, casino_opening_configured, configured_by, configured_at)
     VALUES (1, 1000, 1000, 0, 0, ?, ?, 1, 'operator', 0)
     ON CONFLICT(id) DO UPDATE SET
       casino_min_working_capital=excluded.casino_min_working_capital,
       casino_remit_rate_bps=excluded.casino_remit_rate_bps,
       casino_opening_configured=1`,
  ).run(input.minimumWorkingCapital, input.bps);
}

/** 正式開業後の状態にする（準備口座が sys:escrow:casino になる）。 */
function openFormally(c: ReturnType<typeof setup>): void {
  c.db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, 'opening_v1', 0) ON CONFLICT(key) DO UPDATE SET value='opening_v1'",
  ).run(CHIP_OPENING_VERSION_KEY);
  expect(c.chips.reserveHolder()).toBe(CHIP_ESCROW);
}

/** Land取引履歴を from/to/amount で読む。 */
function landTxs(c: ReturnType<typeof setup>, type: string): Array<{ from: string; to: string; amount: number }> {
  return (c.db.prepare("SELECT from_account, to_account, amount FROM transactions WHERE type=? ORDER BY id").all(type) as
    Array<{ from_account: string; to_account: string; amount: number }>)
    .map((r) => ({ from: r.from_account, to: r.to_account, amount: r.amount }));
}

function touchedCasinoDeptKey(c: ReturnType<typeof setup>): number {
  return (c.db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE from_account='sys:dept:casino' OR to_account='sys:dept:casino'",
  ).get() as { n: number }).n;
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

  it("books the house-funded fuku payout as its own expense instead of a plain payout", () => {
    const c = setup();
    fundHouse(c);
    c.chips.fundFromAccount(TREASURY, 100, "u1", "seed:u1");
    c.chips.runGroup({ groupKey: "daily:1", kind: "daily", actorId: "u1" }, () => {
      c.chips.transfer("house", "u1", 40, { reason: "福分け（胴元）" });
      c.chips.transfer("house", "u1", 30, { reason: "配当", game: "slots" });
    });

    expect(c.remit.pnl().map((row) => [row.category, row.amount])).toEqual([
      ["fuku_distribution", -40], ["payout", -30],
    ]);
    expect(c.remit.cumulativeProfit()).toBe(-70);
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

  it("takes the remittance rate and minimum working capital from the operator-approved opening configuration", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");

    // 設定前は納付できない（仕様16.3: 運営が設定するまで納付しない）
    expect(c.remit.configuration()).toBeNull();
    expect(() => c.remit.draftFromConfiguration("m0", "maker")).toThrow("opening configuration");

    configureOpening(c, { bps: 5_000, minimumWorkingCapital: 200 });
    expect(c.remit.configuration()).toEqual({ remittanceBps: 5_000, minimumWorkingCapital: 200 });

    const draft = c.remit.draftFromConfiguration("m1", "maker");
    expect(draft.snapshot).toMatchObject({ bps: 5_000, minimumWorkingCapital: 200, base: 800, amount: 400 });

    // 納付率0の設定でも、金額0のdraftを監査用に残せる
    configureOpening(c, { bps: 0, minimumWorkingCapital: 200 });
    const zero = c.remit.draftFromConfiguration("m2", "maker");
    expect(zero.amount).toBe(0);
    c.db.close();
  });

  it("納付・補填とも正本の賭博場部署だけを通し、sys:dept:casino へは1件も出さない", () => {
    expect(CASINO_DEPARTMENT_KEY).toBe("賭博場");
    expect(CASINO_DEPARTMENT).toBe("sys:dept:賭博場");

    const c = setup();
    openFormally(c);
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");
    c.remit.execute("m1", "operator");

    // 納付: house chips → sys:escrow:casino → sys:dept:賭博場 → treasury
    expect(landTxs(c, "chip_settle")).toEqual([{ from: CHIP_ESCROW, to: CASINO_DEPARTMENT, amount: 400 }]);
    expect(landTxs(c, "casino_remittance")).toEqual([{ from: CASINO_DEPARTMENT, to: TREASURY, amount: 400 }]);

    c.remit.bailoutDraft("b1", 150, "shortage", { required: 150 }, "maker");
    c.remit.approve("b1", "reviewer");
    c.remit.execute("b1", "operator");

    // 補填: treasury → sys:dept:賭博場 → sys:escrow:casino → house chips
    expect(landTxs(c, "casino_bailout")).toEqual([{ from: TREASURY, to: CASINO_DEPARTMENT, amount: 150 }]);
    expect(landTxs(c, "chip_fund").at(-1)).toEqual({ from: CASINO_DEPARTMENT, to: CHIP_ESCROW, amount: 150 });

    expect(touchedCasinoDeptKey(c)).toBe(0);
    expect(c.ledger.balanceOf("sys:dept:casino")).toBe(0);
    // 部署口座は通過点。納付・補填が終われば残らない
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(0);
    c.db.close();
  });

  it("納付が途中で失敗したら、部署口座にも準備口座にも残高を残さない", () => {
    const c = setup();
    openFormally(c);
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");

    const original = c.ledger.transfer.bind(c.ledger);
    c.ledger.transfer = ((input: never) => {
      if ((input as { type?: string }).type === "casino_remittance") throw new Error("land transfer failed");
      return original(input as never);
    }) as typeof c.ledger.transfer;

    expect(() => c.remit.execute("m1", "operator")).toThrow("land transfer failed");
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(0);
    expect(c.ledger.balanceOf("sys:dept:casino")).toBe(0);
    expect(c.chips.balanceOf("house")).toBe(1_000);
    expect(c.ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(c.remit.get("m1")?.status).toBe("approved");
    c.db.close();
  });

  it("未処分利益は月をまたいで累積し、納付済みぶんだけ減る", () => {
    const c = setup();
    fundHouse(c, 10_000);
    c.remit.recordRealized("wager", 800, "manual:2026-01", "2026-01");
    c.remit.recordRealized("wager", 100, "manual:2026-02", "2026-02");

    // 1月に納付せず2月のdraftを作ると、繰り越しを含む 900 が基礎になる
    const feb = c.remit.draft("m-feb", 10_000, 0, "maker", { period: "2026-02" });
    expect(feb.snapshot).toMatchObject({
      period: "2026-02", periodRealizedProfit: 100, cumulativeRealizedProfit: 900, cumulativeUndisposedProfit: 900, base: 900, amount: 900,
    });
    c.db.close();

    // 1月に300納付済みなら、2月の未処分は 900 - 300 = 600
    const d = setup();
    fundHouse(d, 10_000);
    d.remit.recordRealized("wager", 800, "manual:2026-01", "2026-01");
    d.remit.draft("m-jan", 3_750, 0, "maker", { period: "2026-01" });
    d.remit.approve("m-jan", "reviewer");
    expect(d.remit.execute("m-jan", "operator").amount).toBe(300);

    d.remit.recordRealized("wager", 100, "manual:2026-02", "2026-02");
    const feb2 = d.remit.draft("m-feb", 10_000, 0, "maker", { period: "2026-02" });
    expect(feb2.snapshot).toMatchObject({
      period: "2026-02", periodRealizedProfit: 100, cumulativeRealizedProfit: 900, cumulativeUndisposedProfit: 600, base: 600, amount: 600,
    });
    expect(d.remit.cumulativeUndisposedProfit()).toBe(600);

    // 同じperiodをもう一度draftしても、未処分は二重に増減しない
    const again = d.remit.draft("m-feb-2", 10_000, 0, "maker", { period: "2026-02" });
    expect(again.snapshot).toMatchObject({ cumulativeUndisposedProfit: 600, amount: 600 });
    expect(d.remit.cumulativeUndisposedProfit()).toBe(600);
    d.db.close();
  });

  it("承認後に予約額が動けば、資金移動と同じトランザクションでstale拒否する", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");

    // runGroup に入る直前に予約が増えるのを、chips.runGroup をフックして再現する
    const originalRunGroup = c.chips.runGroup.bind(c.chips);
    let hooked = false;
    c.chips.runGroup = ((input: never, body: never) => {
      if (!hooked) {
        hooked = true;
        c.reservations.reserve("late", 900, "slots", "u1");
      }
      return originalRunGroup(input as never, body as never);
    }) as typeof c.chips.runGroup;

    expect(() => c.remit.execute("m1", "operator")).toThrow("stale");
    expect(c.chips.balanceOf("house")).toBe(1_000);
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(0);
    expect(c.ledger.balanceOf(TREASURY)).toBe(-1_000);
    expect(c.remit.get("m1")?.status).toBe("approved");
    c.db.close();
  });

  it("金額0のdraftでも、承認後に設定が変われば実行できない", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    c.remit.draft("zero", 0, 200, "maker");
    c.remit.approve("zero", "reviewer");

    c.remit.recordRealized("wager", 1, "manual:changed");
    expect(() => c.remit.execute("zero", "operator")).toThrow("stale");
    expect(c.remit.get("zero")?.status).toBe("approved");
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
