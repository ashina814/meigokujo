import { describe, expect, it } from "vitest";
import {
  CASINO_DEPARTMENT_ACCOUNT,
  CHIP_ESCROW,
  CHIP_OPENING_VERSION_KEY,
  FORMAL_OPENING_VERSION,
  HOUSE_HOLDER,
  ChipLedger,
  EventLog,
  HouseReservations,
  Ledger,
  Settings,
  TREASURY,
  clearCasinoOpeningConfig,
  openDb,
  registerDefaultTxTypes,
  writeCasinoOpeningConfig,
} from "../src/index.js";
import { CasinoRemittance, CasinoRemittanceError } from "../src/casino/remittance.js";

registerDefaultTxTypes();

const JST_JULY_END = Math.floor(Date.parse("2026-07-31T14:59:59.000Z") / 1000);
const JST_AUG_START = Math.floor(Date.parse("2026-07-31T15:00:00.000Z") / 1000);

interface Ctx {
  db: ReturnType<typeof openDb>;
  settings: Settings;
  ledger: Ledger;
  events: EventLog;
  chips: ChipLedger;
  reservations: HouseReservations;
  remit: CasinoRemittance;
  setFuku(value: number | null): void;
  setNow(value: number): void;
}

function setup(opts: { formal?: boolean; fuku?: number | null; now?: number } = {}): Ctx {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  if (opts.formal !== false) settings.set(CHIP_OPENING_VERSION_KEY, FORMAL_OPENING_VERSION, "test");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new ChipLedger(db, ledger, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holder) => holder === HOUSE_HOLDER ? reservations.totalReserved() : 0);
  let fuku = opts.fuku === undefined ? 0 : opts.fuku;
  let clock = opts.now ?? JST_AUG_START;
  const remit = new CasinoRemittance(db, ledger, chips, reservations, settings, {
    fukuReserve: () => fuku,
    now: () => clock,
  });
  return {
    db, settings, ledger, events, chips, reservations, remit,
    setFuku(value) { fuku = value; },
    setNow(value) { clock = value; },
  };
}

function configure(c: Ctx, input: { min?: number; bps?: number } = {}): void {
  writeCasinoOpeningConfig(c.settings, {
    openingCapital: 10_000,
    openingHouse: 10_000,
    openingJackpot: 0,
    openingRelief: 0,
    minWorkingCapital: input.min ?? 0,
    remitRateBps: input.bps ?? 10_000,
  }, "operator");
}

function fund(c: Ctx, holder: string, amount: number, key: string): void {
  c.chips.fundFromAccount(TREASURY, amount, holder, key);
}

function operatingMove(
  c: Ctx,
  key: string,
  kind: string,
  from: string,
  to: string,
  amount: number,
): void {
  c.chips.runGroup({ groupKey: key, kind, actorId: "actor" }, () => {
    c.chips.transfer(from, to, amount, { reason: "classification must not depend on this text" });
  });
}

function createProfit(c: Ctx, amount: number, key = "profit"): void {
  fund(c, `user:${key}`, amount, `seed:${key}`);
  operatingMove(c, `shop:${key}`, "shop", `user:${key}`, HOUSE_HOLDER, amount);
}

function landTxs(c: Ctx, type: string): Array<{ from: string; to: string; amount: number }> {
  return (c.db.prepare(
    "SELECT from_account, to_account, amount FROM transactions WHERE type=? ORDER BY id",
  ).all(type) as Array<{ from_account: string; to_account: string; amount: number }>).map((r) => ({
    from: r.from_account, to: r.to_account, amount: r.amount,
  }));
}

describe("PR14 clean remittance / bailout", () => {
  it("opening_v1前はPR14 schemaを作らず、PR12 preflightを汚染しない", () => {
    const c = setup({ formal: false });
    expect(c.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('casino_house_pnl','casino_remittances')",
    ).all()).toEqual([]);
    expect(() => c.remit.draftBailout("b1", 100, "shortage", "maker"))
      .toThrowError(expect.objectContaining({ code: "ERR_CASINO_OPENING_NOT_COMPLETE" }));
    expect(c.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('casino_house_pnl','casino_remittances')",
    ).all()).toEqual([]);
    c.db.close();
  });

  it("opening configはsettings KVSだけを正本にし、旧第二テーブルを読まない", () => {
    const c = setup();
    c.db.exec(`
      CREATE TABLE casino_opening_configuration (
        id INTEGER PRIMARY KEY,
        casino_min_working_capital INTEGER,
        casino_remit_rate_bps INTEGER,
        casino_opening_configured INTEGER
      );
      INSERT INTO casino_opening_configuration VALUES (1, 0, 10000, 1);
    `);
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    expect(() => c.remit.draftRemittance("m1", "maker"))
      .toThrowError(expect.objectContaining({ code: "ERR_OPENING_CONFIG_REQUIRED" }));
    configure(c, { min: 0, bps: 5000 });
    createProfit(c, 800);
    expect(c.remit.draftRemittance("m2", "maker").snapshot)
      .toMatchObject({ minimumWorkingCapital: 0, remitRateBps: 5000, amount: 400 });
    c.db.close();
  });

  it("福分け準備金の正本が未接続なら0と推測せずfail-closedする", () => {
    const db = openDb(":memory:");
    const settings = new Settings(db);
    settings.set(CHIP_OPENING_VERSION_KEY, FORMAL_OPENING_VERSION, "test");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const chips = new ChipLedger(db, ledger, events);
    const reservations = new HouseReservations(db, chips, events);
    chips.setReservedProvider((holder) => holder === HOUSE_HOLDER ? reservations.totalReserved() : 0);
    const remit = new CasinoRemittance(db, ledger, chips, reservations, settings);
    const c: Ctx = { db, settings, ledger, events, chips, reservations, remit, setFuku() {}, setNow() {} };
    configure(c, { min: 0, bps: 0 });
    expect(() => remit.draftRemittance("m1", "maker"))
      .toThrowError(expect.objectContaining({ code: "ERR_FUKU_RESERVE_UNCONFIGURED" }));
    db.close();
  });

  it("house P/Lはreason/行順ではなくsettled groupとhouse純増減で分類する", () => {
    const c = setup();
    configure(c);
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    fund(c, "u1", 500, "seed:u1");

    c.chips.runGroup({ groupKey: "solo:1", kind: "solo_game", actorId: "u1" }, () => {
      c.chips.transfer("u1", HOUSE_HOLDER, 100, { reason: "x" });
      c.chips.transfer(HOUSE_HOLDER, "u1", 30, { reason: "same-text" });
      c.chips.transfer(HOUSE_HOLDER, "u1", 10, { reason: "same-text" });
      c.chips.transfer(HOUSE_HOLDER, "jackpot", 5, { reason: "same-text" });
    });
    c.chips.runGroup({ groupKey: "daily:1", kind: "daily", actorId: "u1" }, () => {
      c.chips.transfer(HOUSE_HOLDER, "u1", 25, { reason: "whatever" });
    });
    c.chips.runGroup({ groupKey: "ranked:fee-refund:1", kind: "table_fee_refund", actorId: "judge" }, () => {
      c.chips.transfer(HOUSE_HOLDER, "u1", 15, { reason: "ranked fee refund" });
    });
    c.chips.runGroup({ groupKey: "refund:1", kind: "refund", actorId: "system" }, () => {
      c.chips.transfer(HOUSE_HOLDER, "u1", 20, { reason: "not parsed" });
    });

    expect(c.remit.syncRealized()).toBe(6);
    expect(c.remit.syncRealized()).toBe(0);
    expect(c.remit.pnl().map((x) => x.amount)).toEqual([100, -30, -10, -5, -25, -15]);
    expect(c.remit.cumulativeProfit()).toBe(15);
    c.db.close();
  });

  it("unknownなhouse-touching groupは損益へ推測算入せずfail-closedする", () => {
    const c = setup();
    configure(c);
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    fund(c, "u1", 100, "seed:u1");
    operatingMove(c, "future:1", "future_feature", "u1", HOUSE_HOLDER, 10);
    expect(() => c.remit.syncRealized())
      .toThrowError(expect.objectContaining({ code: "ERR_UNCLASSIFIED_HOUSE_TX" }));
    expect(c.db.prepare("SELECT COUNT(*) AS n FROM casino_house_pnl").get()).toEqual({ n: 0 });
    c.db.close();
  });

  it("capital funding/deposit/redeemはP/Lへ入らない", () => {
    const c = setup();
    configure(c);
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    fund(c, "u1", 100, "seed:u1");
    c.ledger.ensureAccount("user:u1", "user");
    c.chips.redeem("u1", 10, "redeem:u1");
    expect(c.remit.syncRealized()).toBe(0);
    expect(c.remit.cumulativeProfit()).toBe(0);
    c.db.close();
  });

  it.each([
    { name: "profit <= surplus", house: 1000, profit: 400, reserved: 0, min: 100, fuku: 100, bps: 5000, amount: 200 },
    { name: "surplus <= profit", house: 1000, profit: 900, reserved: 300, min: 300, fuku: 100, bps: 5000, amount: 150 },
    { name: "surplus zero", house: 1000, profit: 900, reserved: 600, min: 300, fuku: 100, bps: 5000, amount: 0 },
    { name: "rate zero", house: 1000, profit: 900, reserved: 0, min: 0, fuku: 0, bps: 0, amount: 0 },
    { name: "rate 10000", house: 1000, profit: 400, reserved: 0, min: 0, fuku: 0, bps: 10000, amount: 400 },
  ])("$name", ({ house, profit, reserved, min, fuku, bps, amount }) => {
    const c = setup({ fuku });
    configure(c, { min, bps });
    fund(c, HOUSE_HOLDER, house - profit, "seed:house");
    createProfit(c, profit);
    if (reserved > 0) c.reservations.reserve("r1", reserved, "slots", "u1");
    const draft = c.remit.draftRemittance("m1", "maker");
    expect(draft.amount).toBe(amount);
    expect(draft.snapshot).toMatchObject({ reservedObligations: reserved, fukuReserve: fuku });
    c.db.close();
  });

  it("profit 0なら納付0", () => {
    const c = setup();
    configure(c, { bps: 10000 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    expect(c.remit.draftRemittance("m1", "maker").amount).toBe(0);
    c.db.close();
  });

  it("SQLite partial UNIQUEが同一月のactive remittanceをDB直書きでも拒否する", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    expect(() => c.db.prepare(`
      INSERT INTO casino_remittances
        (key, kind, period, amount, status, plan_hash, snapshot_json, reason, created_by, created_at)
      SELECT 'm2', kind, period, amount, 'draft', plan_hash, snapshot_json, NULL, 'other', created_at
      FROM casino_remittances WHERE key='m1'
    `).run()).toThrow();
    expect(c.db.prepare(`
      SELECT COUNT(*) AS n FROM casino_remittances
      WHERE kind='remittance' AND period='2026-08' AND status IN ('draft','approved','executed')
    `).get()).toEqual({ n: 1 });
    c.db.close();
  });

  it("同月に別keyで2件目remittance draftを拒否する", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    expect(() => c.remit.draftRemittance("m2", "other"))
      .toThrowError(expect.objectContaining({ code: "ERR_REMITTANCE_PERIOD_LOCKED" }));
    c.db.close();
  });

  it("同月のremittanceがdraft中なら2件目を拒否する", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    expect(c.remit.draftRemittance("m1", "maker").status).toBe("draft");
    expect(() => c.remit.draftRemittance("m2", "other"))
      .toThrowError(expect.objectContaining({
        code: "ERR_REMITTANCE_PERIOD_LOCKED",
        meta: expect.objectContaining({ existingStatus: "draft" }),
      }));
    c.db.close();
  });

  it("同月のremittanceがapproved中なら2件目を拒否する", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    c.remit.approve("m1", "reviewer");
    expect(() => c.remit.draftRemittance("m2", "other"))
      .toThrowError(expect.objectContaining({
        code: "ERR_REMITTANCE_PERIOD_LOCKED",
        meta: expect.objectContaining({ existingStatus: "approved" }),
      }));
    c.db.close();
  });

  it("同月のremittanceがexecuted後も2件目を拒否する", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    c.remit.approve("m1", "reviewer");
    c.remit.execute("m1", "operator");
    expect(() => c.remit.draftRemittance("m2", "other"))
      .toThrowError(expect.objectContaining({
        code: "ERR_REMITTANCE_PERIOD_LOCKED",
        meta: expect.objectContaining({ existingStatus: "executed" }),
      }));
    c.db.close();
  });

  it("rejected後は同一月に別keyでremittanceを再起案できる", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    c.remit.reject("m1", "reviewer", "redo");
    expect(c.remit.draftRemittance("m2", "maker2")).toMatchObject({
      key: "m2", period: "2026-08", status: "draft",
    });
    c.db.close();
  });

  it("JST翌月なら前月active remittanceがあっても起案できる", () => {
    const c = setup({ now: JST_JULY_END });
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    expect(c.remit.draftRemittance("july", "maker").period).toBe("2026-07");
    c.setNow(JST_AUG_START);
    expect(c.remit.draftRemittance("aug", "maker")).toMatchObject({
      period: "2026-08", status: "draft",
    });
    c.db.close();
  });

  it("納付率50%を同月に二重適用できない", () => {
    const c = setup();
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    expect(c.remit.draftRemittance("m1", "maker").amount).toBe(400);
    c.remit.approve("m1", "reviewer");
    c.remit.execute("m1", "operator");
    expect(() => c.remit.draftRemittance("m2", "maker2"))
      .toThrowError(expect.objectContaining({ code: "ERR_REMITTANCE_PERIOD_LOCKED" }));
    expect(c.db.prepare(`
      SELECT COALESCE(SUM(amount),0) AS total FROM casino_remittances
      WHERE kind='remittance' AND period='2026-08' AND status='executed'
    `).get()).toEqual({ total: 400 });
    expect(c.chips.balanceOf(HOUSE_HOLDER)).toBe(600);
    c.db.close();
  });

  it("JST月境界でYYYY-MMを決める", () => {
    const c = setup({ now: JST_JULY_END });
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    expect(c.remit.draftRemittance("july", "maker").period).toBe("2026-07");
    c.setNow(JST_AUG_START);
    expect(c.remit.draftRemittance("aug", "maker").period).toBe("2026-08");
    c.db.close();
  });

  it("chip P/Lの月もJST境界を使う", () => {
    const c = setup();
    configure(c);
    fund(c, "u1", 20, "seed:u1");
    operatingMove(c, "shop:july", "shop", "u1", HOUSE_HOLDER, 10);
    operatingMove(c, "shop:aug", "shop", "u1", HOUSE_HOLDER, 10);
    c.db.prepare("UPDATE casino_tx SET created_at=? WHERE group_key='shop:july'").run(JST_JULY_END);
    c.db.prepare("UPDATE casino_tx SET created_at=? WHERE group_key='shop:aug'").run(JST_AUG_START);
    expect(c.remit.pnl("2026-07").map((x) => x.amount)).toEqual([10]);
    expect(c.remit.pnl("2026-08").map((x) => x.amount)).toEqual([10]);
    c.db.close();
  });

  it("作成者本人のapproveと二重approveを拒否する", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    expect(() => c.remit.approve("m1", "maker"))
      .toThrowError(expect.objectContaining({ code: "ERR_SECOND_APPROVER_REQUIRED" }));
    expect(c.remit.approve("m1", "reviewer").status).toBe("approved");
    expect(() => c.remit.approve("m1", "other"))
      .toThrowError(expect.objectContaining({ code: "ERR_NOT_DRAFT" }));
    c.db.close();
  });

  it("rejectを永続化し、rejected planはexecuteできない", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    expect(c.remit.reject("m1", "reviewer", "not this month")).toMatchObject({
      status: "rejected", rejectedBy: "reviewer", rejectionReason: "not this month",
    });
    expect(() => c.remit.execute("m1", "operator"))
      .toThrowError(expect.objectContaining({ code: "ERR_NOT_APPROVED" }));
    c.db.close();
  });

  it("house/P&Lが変わればstaleで1Ldも動かさない", () => {
    const c = setup();
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    c.remit.draftRemittance("m1", "maker");
    c.remit.approve("m1", "reviewer");
    createProfit(c, 1, "late");
    const before = c.chips.balanceOf(HOUSE_HOLDER);
    expect(() => c.remit.execute("m1", "operator"))
      .toThrowError(expect.objectContaining({ code: "ERR_PLAN_STALE" }));
    expect(c.chips.balanceOf(HOUSE_HOLDER)).toBe(before);
    expect(c.remit.get("m1")?.status).toBe("approved");
    c.db.close();
  });

  it("予約が変わればstaleで止まる", () => {
    const c = setup();
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    c.remit.draftRemittance("m1", "maker");
    c.remit.approve("m1", "reviewer");
    c.reservations.reserve("late", 1, "slots", "u1");
    expect(() => c.remit.execute("m1", "operator"))
      .toThrowError(expect.objectContaining({ code: "ERR_PLAN_STALE" }));
    c.db.close();
  });

  it("opening configまたは福分け準備金が変わればstaleで止まる", () => {
    const c = setup({ fuku: 0 });
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    c.remit.draftRemittance("m1", "maker");
    c.remit.approve("m1", "reviewer");
    c.setFuku(1);
    expect(() => c.remit.execute("m1", "operator"))
      .toThrowError(expect.objectContaining({ code: "ERR_PLAN_STALE" }));
    c.db.close();

    const d = setup({ fuku: 0 });
    configure(d, { min: 0, bps: 5000 });
    fund(d, HOUSE_HOLDER, 200, "seed:house");
    createProfit(d, 800);
    d.remit.draftRemittance("m1", "maker");
    d.remit.approve("m1", "reviewer");
    configure(d, { min: 1, bps: 5000 });
    expect(() => d.remit.execute("m1", "operator"))
      .toThrowError(expect.objectContaining({ code: "ERR_PLAN_STALE" }));
    d.db.close();
  });

  it("納付はhouse chips→賭博場部署Land→treasuryだけを通る", () => {
    const c = setup();
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    const d = c.remit.draftRemittance("m1", "maker");
    expect(d.amount).toBe(400);
    c.remit.approve("m1", "reviewer");
    const executed = c.remit.execute("m1", "operator");
    expect(executed).toMatchObject({ status: "executed", executedBy: "operator" });
    expect(landTxs(c, "chip_settle").at(-1)).toEqual({
      from: CHIP_ESCROW, to: CASINO_DEPARTMENT_ACCOUNT, amount: 400,
    });
    expect(landTxs(c, "casino_remittance")).toEqual([
      { from: CASINO_DEPARTMENT_ACCOUNT, to: TREASURY, amount: 400 },
    ]);
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)).toBe(0);
    expect(c.chips.balanceOf(HOUSE_HOLDER)).toBe(600);
    c.db.close();
  });

  it("補填はtreasury→賭博場部署→casino reserve→houseだけを通る", () => {
    const c = setup();
    configure(c, { min: 500, bps: 0 });
    fund(c, HOUSE_HOLDER, 100, "seed:house");
    const d = c.remit.draftBailout("b1", 250, "capacity shortage", "maker");
    expect(d.snapshot).toMatchObject({
      houseBalance: 100, settleableHouse: 100, gapToMinimumWorkingCapital: 400,
    });
    c.remit.approve("b1", "reviewer");
    const executed = c.remit.execute("b1", "operator");
    expect(executed.status).toBe("executed");
    expect(landTxs(c, "casino_bailout")).toEqual([
      { from: TREASURY, to: CASINO_DEPARTMENT_ACCOUNT, amount: 250 },
    ]);
    expect(landTxs(c, "chip_fund").at(-1)).toEqual({
      from: CASINO_DEPARTMENT_ACCOUNT, to: CHIP_ESCROW, amount: 250,
    });
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)).toBe(0);
    expect(c.chips.balanceOf(HOUSE_HOLDER)).toBe(350);
    c.db.close();
  });

  it("納付途中失敗はchips/Land/statusをまとめてrollbackする", () => {
    const c = setup();
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    c.remit.draftRemittance("m1", "maker");
    c.remit.approve("m1", "reviewer");
    const beforeHouse = c.chips.balanceOf(HOUSE_HOLDER);
    const beforeReserve = c.ledger.balanceOf(CHIP_ESCROW);
    const original = c.ledger.transfer.bind(c.ledger);
    c.ledger.transfer = ((req: Parameters<Ledger["transfer"]>[0]) => {
      if (req.type === "casino_remittance") throw new Error("injected failure");
      return original(req);
    }) as Ledger["transfer"];
    expect(() => c.remit.execute("m1", "operator")).toThrow("injected failure");
    expect(c.chips.balanceOf(HOUSE_HOLDER)).toBe(beforeHouse);
    expect(c.ledger.balanceOf(CHIP_ESCROW)).toBe(beforeReserve);
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)).toBe(0);
    expect(c.remit.get("m1")?.status).toBe("approved");
    c.db.close();
  });

  it("補填途中失敗はtreasury→部署送金もstatusもrollbackする", () => {
    const c = setup();
    configure(c, { min: 500, bps: 0 });
    fund(c, HOUSE_HOLDER, 100, "seed:house");
    c.remit.draftBailout("b1", 250, "shortage", "maker");
    c.remit.approve("b1", "reviewer");
    const treasuryBefore = c.ledger.balanceOf(TREASURY);
    const original = c.chips.fundFromAccount.bind(c.chips);
    c.chips.fundFromAccount = ((...args: Parameters<ChipLedger["fundFromAccount"]>) => {
      if (args[0] === CASINO_DEPARTMENT_ACCOUNT) throw new Error("injected fund failure");
      return original(...args);
    }) as ChipLedger["fundFromAccount"];
    expect(() => c.remit.execute("b1", "operator")).toThrow("injected fund failure");
    expect(c.ledger.balanceOf(TREASURY)).toBe(treasuryBefore);
    expect(c.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)).toBe(0);
    expect(c.chips.balanceOf(HOUSE_HOLDER)).toBe(100);
    expect(c.remit.get("b1")?.status).toBe("approved");
    c.db.close();
  });

  it("0Ld納付は空のchip groupを残さず監査状態だけ実行済みにする", () => {
    const c = setup();
    configure(c, { min: 0, bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("zero", "maker");
    c.remit.approve("zero", "reviewer");
    const row = c.remit.execute("zero", "operator");
    expect(row).toMatchObject({ status: "executed", amount: 0, chipGroupKey: null, landTxId: null });
    expect(c.db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key='casino:remittance:zero'").get())
      .toEqual({ n: 0 });
    c.db.close();
  });

  it("同じexecutorのexecute replayは二重送金せず同じ行を返す", () => {
    const c = setup();
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    c.remit.draftRemittance("m1", "maker");
    c.remit.approve("m1", "reviewer");
    const first = c.remit.execute("m1", "operator");
    const txCount = c.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='casino_remittance'").get();
    const second = c.remit.execute("m1", "operator");
    expect(second.id).toBe(first.id);
    expect(c.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type='casino_remittance'").get()).toEqual(txCount);
    expect(() => c.remit.execute("m1", "other"))
      .toThrowError(expect.objectContaining({ code: "ERR_NOT_APPROVED" }));
    c.db.close();
  });

  it("malformed/corrupt persisted snapshotはfail-closedする", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    c.db.prepare("UPDATE casino_remittances SET snapshot_json='{' WHERE key='m1'").run();
    expect(() => c.remit.get("m1"))
      .toThrowError(expect.objectContaining({ code: "ERR_CORRUPT_STATE" }));
    c.db.close();
  });

  it("row amountとsnapshot amountの不一致をhashが正しくても拒否する", () => {
    const c = setup();
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    c.remit.draftRemittance("m1", "maker");
    c.db.prepare("UPDATE casino_remittances SET amount=1 WHERE key='m1'").run();
    expect(() => c.remit.get("m1"))
      .toThrowError(expect.objectContaining({ code: "ERR_CORRUPT_STATE" }));
    c.db.close();
  });

  it("unsafe opening configをfail-closedする", () => {
    const c = setup();
    configure(c, { bps: 0 });
    c.settings.set("casino_remit_rate_bps", "1.5", "corruptor");
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    expect(() => c.remit.draftRemittance("m1", "maker"))
      .toThrowError(expect.objectContaining({ code: "ERR_OPENING_CONFIG_REQUIRED" }));
    c.db.close();
  });

  it("unsafe fuku reserveをfail-closedする", () => {
    const c = setup({ fuku: Number.MAX_SAFE_INTEGER + 1 });
    configure(c, { bps: 0 });
    fund(c, HOUSE_HOLDER, 1000, "seed:house");
    expect(() => c.remit.draftRemittance("m1", "maker"))
      .toThrowError(expect.objectContaining({ code: "ERR_FUKU_RESERVE_INVALID" }));
    c.db.close();
  });

  it("実行済み納付だけが累積未処分利益から控除され、月を跨いで繰り越される", () => {
    const c = setup({ now: JST_JULY_END });
    configure(c, { min: 0, bps: 5000 });
    fund(c, HOUSE_HOLDER, 200, "seed:house");
    createProfit(c, 800);
    const july = c.remit.draftRemittance("july", "maker");
    expect(july.amount).toBe(400);
    c.remit.approve("july", "reviewer");
    c.remit.execute("july", "operator");
    expect(c.remit.cumulativeUndisposedProfit()).toBe(400);

    c.setNow(JST_AUG_START);
    configure(c, { min: 0, bps: 10000 });
    const aug = c.remit.draftRemittance("aug", "maker");
    expect(aug).toMatchObject({ period: "2026-08", amount: 400 });
    c.db.close();
  });

  it("bailout snapshotもhouse/reservation/config変化でstaleになる", () => {
    const c = setup();
    configure(c, { min: 500, bps: 0 });
    fund(c, HOUSE_HOLDER, 100, "seed:house");
    c.remit.draftBailout("b1", 100, "shortage", "maker");
    c.remit.approve("b1", "reviewer");
    c.reservations.reserve("late", 1, "slots", "u1");
    expect(() => c.remit.execute("b1", "operator"))
      .toThrowError(expect.objectContaining({ code: "ERR_PLAN_STALE" }));
    c.db.close();
  });

  it("開業設定フラグを消すと既存draftのexecuteもfail-closedする", () => {
    const c = setup();
    configure(c, { min: 500, bps: 0 });
    fund(c, HOUSE_HOLDER, 100, "seed:house");
    c.remit.draftBailout("b1", 100, "shortage", "maker");
    c.remit.approve("b1", "reviewer");
    clearCasinoOpeningConfig(c.settings, "operator");
    expect(() => c.remit.execute("b1", "operator"))
      .toThrowError(expect.objectContaining({ code: "ERR_OPENING_CONFIG_REQUIRED" }));
    c.db.close();
  });
});
