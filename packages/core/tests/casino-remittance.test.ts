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
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new ChipLedger(db, ledger, events);
  const reservations = new HouseReservations(db, chips, events);
  const remit = new CasinoRemittance(db, ledger, chips, reservations);
  return { db, ledger, chips, reservations, remit };
}

function fund(c: ReturnType<typeof setup>, holder: string, amount: number, key: string): void {
  c.chips.fundFromAccount(TREASURY, amount, holder, key);
}

function fundHouse(c: ReturnType<typeof setup>, amount = 1_000): void {
  fund(c, "house", amount, `seed:house:${amount}`);
}

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

function openFormally(c: ReturnType<typeof setup>): void {
  c.db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, 'opening_v1', 0) ON CONFLICT(key) DO UPDATE SET value='opening_v1'",
  ).run(CHIP_OPENING_VERSION_KEY);
  expect(c.chips.reserveHolder()).toBe(CHIP_ESCROW);
}

function landTxs(
  c: ReturnType<typeof setup>,
  type: string,
): Array<{ from: string; to: string; amount: number }> {
  return (c.db.prepare(
    "SELECT from_account, to_account, amount FROM transactions WHERE type=? ORDER BY id",
  ).all(type) as Array<{ from_account: string; to_account: string; amount: number }>).map((row) => ({
    from: row.from_account,
    to: row.to_account,
    amount: row.amount,
  }));
}

function touchedLegacyCasinoDepartment(c: ReturnType<typeof setup>): number {
  return (c.db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE from_account='sys:dept:casino' OR to_account='sys:dept:casino'",
  ).get() as { n: number }).n;
}

describe("PR14 casino accounting and remittance", () => {
  it("settled solo groupsを一度だけ分類し、返金と固定済みJP請求を除外する", () => {
    const c = setup();
    fundHouse(c);
    fund(c, "u1", 100, "seed:u1");
    c.chips.runGroup({ groupKey: "round:1", kind: "solo_game", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "任意の賭け文言", game: "slots" });
      c.chips.transfer("house", "u1", 30, { reason: "任意の配当文言", game: "slots" });
      c.chips.transfer("house", "u1", 10, { reason: "任意の追加配当文言", game: "slots" });
      c.chips.transfer("house", "jackpot", 5, { reason: "任意のJP文言", game: "slots" });
    });
    c.chips.runGroup({ groupKey: "refund:1", kind: "refund", actorId: "system" }, () => {
      c.chips.transfer("house", "u1", 20, { reason: "文言に依存しない返金" });
    });
    fund(c, "sys:casino:free-spin-jp-claims", 7, "seed:claim");
    c.chips.runGroup({ groupKey: "free:claim", kind: "solo_game", actorId: "u1" }, () => {
      c.chips.transfer("sys:casino:free-spin-jp-claims", "u1", 7, { reason: "固定済み請求" });
    });

    expect(c.remit.syncRealized()).toBe(4);
    expect(c.remit.syncRealized()).toBe(0);
    expect(c.remit.pnl().map((row) => [row.category, row.amount])).toEqual([
      ["wager", 100],
      ["payout", -30],
      ["chain_bonus", -10],
      ["jackpot_contribution", -5],
    ]);
    expect(c.remit.cumulativeProfit()).toBe(55);
    c.db.close();
  });

  it("daily groupの胴元支出を福分けとして別建てする", () => {
    const c = setup();
    fundHouse(c);
    c.chips.runGroup({ groupKey: "daily:1", kind: "daily", actorId: "u1" }, () => {
      c.chips.transfer("house", "u1", 40, { reason: "表示文言は任意" });
    });
    expect(c.remit.pnl().map((row) => [row.category, row.amount])).toEqual([
      ["fuku_distribution", -40],
    ]);
    expect(c.remit.cumulativeProfit()).toBe(-40);
    c.db.close();
  });

  it("VIP・賭場商店・福分けを実際のgroupごとに集計し、予約と準備額を控除する", () => {
    const c = setup();
    fundHouse(c, 1_000);
    fund(c, "u1", 1_000, "seed:u1");
    c.chips.runGroup({ groupKey: "vip:1", kind: "vip", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "VIP表示文言" });
    });
    c.chips.runGroup({ groupKey: "shop:1", kind: "shop", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 50, { reason: "商品表示文言" });
    });
    c.chips.runGroup({ groupKey: "daily:1", kind: "daily", actorId: "u1" }, () => {
      c.chips.transfer("house", "u1", 25, { reason: "福分け表示文言" });
    });
    c.reservations.reserve("r1", 200, "slots", "u1");

    const draft = c.remit.draft("m1", 5_000, 300, "maker", { fukuReserve: 100 });
    expect(c.remit.pnl().map((row) => [row.category, row.amount])).toEqual([
      ["vip", 100],
      ["shop", 50],
      ["fuku_distribution", -25],
    ]);
    expect(c.remit.cumulativeProfit()).toBe(125);
    expect(draft.snapshot).toMatchObject({
      reservedObligations: 200,
      fukuReserve: 100,
      base: 125,
      amount: 62,
    });
    c.db.close();
  });

  it("別人承認を要求し、stale planと途中失敗を資金不動で拒否する", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    const first = c.remit.draft("m1", 5_000, 200, "maker");
    expect(first.amount).toBe(400);
    expect(() => c.remit.approve("m1", "maker")).toThrow("second approver");
    c.remit.approve("m1", "reviewer");
    c.remit.recordRealized("wager", 1, "manual:changed");
    expect(() => c.remit.execute("m1", "operator")).toThrow("stale");
    expect(c.remit.get("m1")?.status).toBe("approved");

    c.remit.draft("m2", 5_000, 200, "maker");
    c.remit.approve("m2", "reviewer");
    const houseBefore = c.chips.balanceOf("house");
    const original = c.ledger.transfer.bind(c.ledger);
    c.ledger.transfer = ((input: never) => {
      if ((input as { type?: string }).type === "casino_remittance") {
        throw new Error("land transfer failed");
      }
      return original(input as never);
    }) as typeof c.ledger.transfer;
    expect(() => c.remit.execute("m2", "operator")).toThrow("land transfer failed");
    expect(c.chips.balanceOf("house")).toBe(houseBefore);
    expect(c.remit.get("m2")?.status).toBe("approved");
    c.db.close();
  });

  it("納付率0の監査draftを許可し、非0納付は一度だけ成功する", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    const zero = c.remit.draft("zero", 0, 200, "maker");
    expect(zero.amount).toBe(0);
    c.remit.approve("zero", "reviewer");
    expect(c.remit.execute("zero", "operator").status).toBe("executed");

    c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");
    const executed = c.remit.execute("m1", "operator");
    expect(executed).toMatchObject({ status: "executed", chipGroupKey: "casino:remittance:m1" });
    expect(executed.landTxId).not.toBeNull();
    expect(c.remit.cumulativeUndisposedProfit()).toBe(400);
    expect(() => c.remit.execute("m1", "operator")).toThrow("not approved");
    c.db.close();
  });

  it("納付率と最低運転資金を開業設定だけから読む", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    expect(c.remit.configuration()).toBeNull();
    expect(() => c.remit.draftFromConfiguration("m0", "maker")).toThrow("opening configuration");

    configureOpening(c, { bps: 5_000, minimumWorkingCapital: 200 });
    expect(c.remit.configuration()).toEqual({ remittanceBps: 5_000, minimumWorkingCapital: 200 });
    expect(c.remit.draftFromConfiguration("m1", "maker").snapshot).toMatchObject({
      bps: 5_000,
      minimumWorkingCapital: 200,
      base: 800,
      amount: 400,
    });

    configureOpening(c, { bps: 0, minimumWorkingCapital: 200 });
    expect(c.remit.draftFromConfiguration("m2", "maker").amount).toBe(0);
    c.db.close();
  });

  it("納付・補填を正本の賭博場部署だけに通す", () => {
    expect(CASINO_DEPARTMENT_KEY).toBe("賭博場");
    expect(CASINO_DEPARTMENT).toBe("sys:dept:賭博場");
    const c = setup();
    openFormally(c);
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");
    c.remit.execute("m1", "operator");
    expect(landTxs(c, "chip_settle")).toEqual([
      { from: CHIP_ESCROW, to: CASINO_DEPARTMENT, amount: 400 },
    ]);
    expect(landTxs(c, "casino_remittance")).toEqual([
      { from: CASINO_DEPARTMENT, to: TREASURY, amount: 400 },
    ]);

    c.remit.bailoutDraft("b1", 150, "shortage", { required: 150 }, "maker");
    c.remit.approve("b1", "reviewer");
    c.remit.execute("b1", "operator");
    expect(landTxs(c, "casino_bailout")).toEqual([
      { from: TREASURY, to: CASINO_DEPARTMENT, amount: 150 },
    ]);
    expect(landTxs(c, "chip_fund").at(-1)).toEqual({
      from: CASINO_DEPARTMENT,
      to: CHIP_ESCROW,
      amount: 150,
    });
    expect(touchedLegacyCasinoDepartment(c)).toBe(0);
    expect(c.ledger.balanceOf("sys:dept:casino")).toBe(0);
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(0);
    c.db.close();
  });

  it("納付の第二Land取引が失敗したらhouse・部署・準備口座をすべて戻す", () => {
    const c = setup();
    openFormally(c);
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");
    const original = c.ledger.transfer.bind(c.ledger);
    c.ledger.transfer = ((input: never) => {
      if ((input as { type?: string }).type === "casino_remittance") {
        throw new Error("land transfer failed");
      }
      return original(input as never);
    }) as typeof c.ledger.transfer;
    expect(() => c.remit.execute("m1", "operator")).toThrow("land transfer failed");
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(0);
    expect(c.ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(c.chips.balanceOf("house")).toBe(1_000);
    expect(c.remit.get("m1")?.status).toBe("approved");
    c.db.close();
  });

  it("未処分利益を月跨ぎで繰り越し、実行済み納付だけを控除する", () => {
    const c = setup();
    fundHouse(c, 10_000);
    c.remit.recordRealized("wager", 800, "manual:jan", "2026-01");
    c.remit.recordRealized("wager", 100, "manual:feb", "2026-02");
    expect(c.remit.draft("feb", 10_000, 0, "maker", { period: "2026-02" }).snapshot).toMatchObject({
      periodRealizedProfit: 100,
      cumulativeRealizedProfit: 900,
      cumulativeUndisposedProfit: 900,
      base: 900,
      amount: 900,
    });
    c.db.close();

    const d = setup();
    fundHouse(d, 10_000);
    d.remit.recordRealized("wager", 800, "manual:jan", "2026-01");
    d.remit.draft("jan", 3_750, 0, "maker", { period: "2026-01" });
    d.remit.approve("jan", "reviewer");
    expect(d.remit.execute("jan", "operator").amount).toBe(300);
    d.remit.recordRealized("wager", 100, "manual:feb", "2026-02");
    expect(d.remit.draft("feb", 10_000, 0, "maker", { period: "2026-02" }).snapshot).toMatchObject({
      cumulativeRealizedProfit: 900,
      cumulativeUndisposedProfit: 600,
      base: 600,
      amount: 600,
    });
    expect(d.remit.draft("feb-2", 10_000, 0, "maker", { period: "2026-02" }).amount).toBe(600);
    d.db.close();
  });

  it("承認後に予約額が変われば資金移動と同じtransaction内でstale拒否する", () => {
    const c = setup();
    fundHouse(c);
    c.remit.recordRealized("wager", 800, "manual:profit");
    c.remit.draft("m1", 5_000, 200, "maker");
    c.remit.approve("m1", "reviewer");
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
    expect(c.remit.get("m1")?.status).toBe("approved");
    c.db.close();
  });

  it("金額0draftでも承認後の損益変化をstaleとして拒否する", () => {
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

  it("補填を永続draft・別人承認・一度だけ実行に限定する", () => {
    const c = setup();
    expect(() => c.remit.bailout("b1", 100, "maker", "reviewer")).toThrow("bailoutDraft");
    const draft = c.remit.bailoutDraft(
      "b1",
      100,
      "shortage",
      { required: 100, house: 0 },
      "maker",
    );
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

  it("同じchip txを何度同期してもP&Lを二重記録しない", () => {
    const c = setup();
    fund(c, "u1", 100, "seed:u1");
    c.chips.runGroup({ groupKey: "shop:once", kind: "shop", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "文言は任意" });
    });
    expect(c.remit.syncRealized()).toBe(1);
    expect(c.remit.syncRealized()).toBe(0);
    expect(c.remit.pnl()).toHaveLength(1);
    c.db.close();
  });
});
