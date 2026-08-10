import { describe, expect, it } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  DailyRisk,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputes,
  RankedProfileError,
  RankedProfiles,
  RankedTableError,
  RankedTables,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * PR24: 賭博場従業員が使える core 操作の安全性。
 *
 * 従業員に許すのは「卓を開く」「開始前に閉じる」「読むだけ」の3つで、
 * 任意返金・強制精算・強制順位確定へは絶対に到達しない。
 */

const NOW = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;

function setup(options: { unlockedTiers?: readonly string[] } = {}) {
  let now = NOW;
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(now - 60 * 24 * 60 * 60);
  const assets = new CasinoChipAssets(db, chips);
  const dailyRisk = new DailyRisk(db, ledger, assets, {
    now: () => now,
    openingPhase: () => chipTx.openingPhase(),
    dailyLossLimitBps: () => 10_000,
  });
  const casino = new Casino(db, chips, events, { dailyRisk });
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => now });
  const chipFlow = new CasinoChipFlow(db, chips, events, assets);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    now: () => now,
    openingPhase: () => chipTx.openingPhase(),
    onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
    dailyRisk,
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, new CasinoMetrics(db, chipTx, () => now), {
    now: () => now,
    chipFlow,
    reservations,
    disputes,
    dailyRisk,
    openingPhase: () => chipTx.openingPhase(),
    tierUnlocked: (tierKey) => (options.unlockedTiers ?? []).includes(tierKey),
  });
  const rankedProfiles = new RankedProfiles(db, { now: () => now });
  return {
    db,
    ledger,
    chips,
    escrow,
    dailyRisk,
    persistentTables,
    rankedTables,
    rankedProfiles,
    setNow: (value: number) => {
      now = value;
    },
  };
}

type Ctx = ReturnType<typeof setup>;

function seedChips(ctx: Ctx, userId: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}`);
}

function createTable(ctx: Ctx, tableId = "t1", baseAmount = 5_000) {
  return ctx.rankedTables.create({
    tableId,
    gameKey: "gf",
    baseAmount,
    creatorId: "employee-1",
    operatorId: "employee-1",
    operationId: `create:${tableId}`,
    authority: "employee",
  });
}

function chipTotal(ctx: Ctx): number {
  const row = ctx.db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ether_balances").get() as { total: number };
  return row.total;
}

function riskEventCount(ctx: Ctx): number {
  if (!ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='casino_daily_risk_events'").get()) return 0;
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_daily_risk_events").get() as { n: number }).n;
}

describe("employee-openable ranked tiers", () => {
  it("lets an employee open minarai through super high but nothing above", () => {
    const ctx = setup({ unlockedTiers: ["extreme", "meigoku"] });
    const available = ctx.rankedTables.rankedTierAvailability("employee").filter((row) => row.available).map((row) => row.tierKey);
    expect(available).toEqual(["minarai", "low", "middle", "high", "super_high"]);

    expect(createTable(ctx, "mid", 5_000).config.baseAmount).toBe(5_000);
    expect(createTable(ctx, "sh", 30_000).config.baseAmount).toBe(30_000);
    // 極卓・冥獄卓は解放済みでも authority 判定が拒否する（UIの出し分けに頼らない）
    for (const [tableId, baseAmount] of [["ex", 50_000], ["mg", 100_000]] as const) {
      expect(() =>
        ctx.rankedTables.create({
          tableId,
          gameKey: "gf",
          baseAmount,
          creatorId: "employee-1",
          operatorId: "employee-1",
          operationId: `create:${tableId}`,
          authority: "employee",
        }),
      ).toThrow(RankedTableError);
    }
  });
});

describe("cancelBeforeStart is the only employee close path", () => {
  it("refunds every participant and cancels a recruiting table without moving the daily net", () => {
    const ctx = setup();
    createTable(ctx);
    seedChips(ctx, "alice", 30_000);
    seedChips(ctx, "bob", 30_000);
    const before = { alice: ctx.chips.balanceOf("alice"), bob: ctx.chips.balanceOf("bob"), total: chipTotal(ctx) };
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    expect(ctx.escrow.poolOf("t1")).toBeGreaterThan(0);

    const snapshot = ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:1" });

    expect(snapshot.table.state).toBe("cancelled");
    expect(ctx.escrow.poolOf("t1")).toBe(0);
    expect(ctx.chips.balanceOf("alice")).toBe(before.alice);
    expect(ctx.chips.balanceOf("bob")).toBe(before.bob);
    // Σchips 保存
    expect(chipTotal(ctx)).toBe(before.total);
    // 開始前の全額返金は純損益0。日次リスクへ1件も書かない（正本 §27）
    expect(riskEventCount(ctx)).toBe(0);
  });

  it("is idempotent and never refunds twice", () => {
    const ctx = setup();
    createTable(ctx);
    seedChips(ctx, "alice", 30_000);
    const before = ctx.chips.balanceOf("alice");
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });

    ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:1" });
    const afterFirst = ctx.chips.balanceOf("alice");
    ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:2" });

    expect(ctx.chips.balanceOf("alice")).toBe(afterFirst);
    expect(afterFirst).toBe(before);
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("cancelled");
  });

  it("closes a ready_check table before the fee is ever charged", () => {
    const ctx = setup();
    createTable(ctx);
    seedChips(ctx, "alice", 30_000);
    seedChips(ctx, "bob", 30_000);
    const before = { alice: ctx.chips.balanceOf("alice"), bob: ctx.chips.balanceOf("bob"), jackpot: chipTotal(ctx) };
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("ready_check");

    ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:1" });

    expect(ctx.chips.balanceOf("alice")).toBe(before.alice);
    expect(ctx.chips.balanceOf("bob")).toBe(before.bob);
    expect(chipTotal(ctx)).toBe(before.jackpot);
    expect(riskEventCount(ctx)).toBe(0);
  });

  it("refuses to close a playing table and leaves the funds untouched", () => {
    const ctx = setup();
    createTable(ctx);
    seedChips(ctx, "alice", 30_000);
    seedChips(ctx, "bob", 30_000);
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("playing");
    const pool = ctx.escrow.poolOf("t1");

    expect(() => ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:1" })).toThrow(RankedTableError);

    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("playing");
    expect(ctx.escrow.poolOf("t1")).toBe(pool);
  });

  it("refuses to close a pending_approval table", () => {
    const ctx = setup();
    createTable(ctx);
    seedChips(ctx, "alice", 30_000);
    seedChips(ctx, "bob", 30_000);
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:1" });
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("pending_approval");

    expect(() => ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:1" })).toThrow(RankedTableError);
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("pending_approval");
  });

  it("refuses to close a disputed table so the employee cannot refund an arbitration case", () => {
    const ctx = setup();
    createTable(ctx);
    seedChips(ctx, "alice", 30_000);
    seedChips(ctx, "bob", 30_000);
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:1" });
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:1" });
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("disputed");
    const pool = ctx.escrow.poolOf("t1");

    expect(() => ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:1" })).toThrow(RankedTableError);
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("disputed");
    expect(ctx.escrow.poolOf("t1")).toBe(pool);
  });

  it("refuses to reopen or re-refund a settled table", () => {
    const ctx = setup();
    createTable(ctx);
    seedChips(ctx, "alice", 30_000);
    seedChips(ctx, "bob", 30_000);
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:1" });
    for (const userId of ["alice", "bob"]) {
      ctx.rankedTables.approve({ tableId: "t1", userId, resultHash: submitted.result!.hash, operationId: `approve:${userId}` });
    }
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("settled");
    const balances = { alice: ctx.chips.balanceOf("alice"), bob: ctx.chips.balanceOf("bob") };

    expect(() => ctx.rankedTables.cancelBeforeStart({ tableId: "t1", actorId: "employee-1", operationId: "close:1" })).toThrow(RankedTableError);
    expect({ alice: ctx.chips.balanceOf("alice"), bob: ctx.chips.balanceOf("bob") }).toEqual(balances);
  });
});

describe("employee close is bounded by tier and guild", () => {
  function createAt(ctx: Ctx, tableId: string, baseAmount: number, guildId: string, authority: "employee" | "manager") {
    return ctx.rankedTables.create({
      tableId,
      gameKey: "gf",
      baseAmount,
      creatorId: "operator-1",
      operatorId: "operator-1",
      guildId,
      operationId: `create:${tableId}`,
      authority,
    });
  }

  function untouched(ctx: Ctx, tableId: string) {
    return {
      state: ctx.rankedTables.snapshot(tableId).table.state,
      pool: ctx.escrow.poolOf(tableId),
      alice: ctx.chips.balanceOf("alice"),
      total: chipTotal(ctx),
      riskEvents: riskEventCount(ctx),
    };
  }

  it("closes an employee-tier table in the same guild", () => {
    const ctx = setup();
    createAt(ctx, "t-high", 10_000, "guild-1", "employee");
    seedChips(ctx, "alice", 40_000);
    ctx.rankedTables.join({ tableId: "t-high", userId: "alice", seat: 1, operationId: "join:alice" });

    const snapshot = ctx.rankedTables.cancelBeforeStart({
      tableId: "t-high",
      actorId: "employee-1",
      operationId: "close:1",
      authority: "employee",
      expectedGuildId: "guild-1",
    });

    expect(snapshot.table.state).toBe("cancelled");
    expect(ctx.escrow.poolOf("t-high")).toBe(0);
  });

  it("refuses every manager-only tier even before start", () => {
    const ctx = setup({ unlockedTiers: ["extreme", "meigoku"] });
    seedChips(ctx, "alice", 400_000);
    const cases: Array<[string, number]> = [["t-ex", 50_000], ["t-mg", 100_000]];
    cases.forEach(([tableId, baseAmount], index) => {
      ctx.setNow(NOW + index * 4_000);
      createAt(ctx, tableId, baseAmount, "guild-1", "manager");
      const before = untouched(ctx, tableId);

      expect(() =>
        ctx.rankedTables.cancelBeforeStart({
          tableId,
          actorId: "employee-1",
          operationId: `close:${tableId}`,
          authority: "employee",
          expectedGuildId: "guild-1",
        }),
      ).toThrow(RankedTableError);

      expect(untouched(ctx, tableId)).toEqual(before);
      expect(ctx.rankedTables.snapshot(tableId).table.state).toBe("recruiting");
    });
  });

  it("refuses a table that belongs to another guild", () => {
    const ctx = setup();
    createAt(ctx, "t-other", 5_000, "guild-2", "employee");
    seedChips(ctx, "alice", 40_000);
    ctx.rankedTables.join({ tableId: "t-other", userId: "alice", seat: 1, operationId: "join:alice" });
    const before = untouched(ctx, "t-other");

    expect(() =>
      ctx.rankedTables.cancelBeforeStart({
        tableId: "t-other",
        actorId: "employee-1",
        operationId: "close:1",
        authority: "employee",
        expectedGuildId: "guild-1",
      }),
    ).toThrow(RankedTableError);

    expect(untouched(ctx, "t-other")).toEqual(before);
  });

  it("fails closed when the caller has no guild context or the table has none", () => {
    const ctx = setup();
    createAt(ctx, "t-guilded", 5_000, "guild-1", "employee");
    ctx.rankedTables.create({
      tableId: "t-nullguild",
      gameKey: "gf",
      baseAmount: 5_000,
      creatorId: "operator-1",
      operatorId: "operator-1",
      operationId: "create:t-nullguild",
      authority: "employee",
    });

    for (const [tableId, expectedGuildId] of [["t-guilded", null], ["t-nullguild", "guild-1"]] as const) {
      expect(() =>
        ctx.rankedTables.cancelBeforeStart({
          tableId,
          actorId: "employee-1",
          operationId: `close:${tableId}`,
          authority: "employee",
          expectedGuildId,
        }),
      ).toThrow(RankedTableError);
      expect(ctx.rankedTables.snapshot(tableId).table.state).toBe("recruiting");
    }
  });

  it("defaults to the narrowest authority when the caller forgets to pass one", () => {
    const ctx = setup({ unlockedTiers: ["extreme"] });
    createAt(ctx, "t-ex", 50_000, "guild-1", "manager");

    // authority 省略 = employee 扱い。忘れても上位卓へ届かない
    expect(() => ctx.rankedTables.cancelBeforeStart({ tableId: "t-ex", actorId: "someone", operationId: "close:1" })).toThrow(RankedTableError);
    expect(ctx.rankedTables.snapshot("t-ex").table.state).toBe("recruiting");
  });

  it("still lets manager authority close an extreme table before start", () => {
    const ctx = setup({ unlockedTiers: ["extreme"] });
    createAt(ctx, "t-ex", 50_000, "guild-1", "manager");
    // 担保は所持の50%までという安全制限があるので、極卓(50,000)には十分な所持が要る
    seedChips(ctx, "alice", 300_000);
    ctx.rankedTables.join({ tableId: "t-ex", userId: "alice", seat: 1, operationId: "join:alice" });
    const before = ctx.chips.balanceOf("alice");

    const snapshot = ctx.rankedTables.cancelBeforeStart({
      tableId: "t-ex",
      actorId: "manager-1",
      operationId: "close:1",
      authority: "manager",
      expectedGuildId: "guild-1",
    });

    expect(snapshot.table.state).toBe("cancelled");
    expect(ctx.chips.balanceOf("alice")).toBeGreaterThan(before);
    expect(ctx.escrow.poolOf("t-ex")).toBe(0);
  });

  it("keeps the state gate unchanged under the new authority argument", () => {
    const ctx = setup();
    createAt(ctx, "t-play", 5_000, "guild-1", "employee");
    seedChips(ctx, "alice", 40_000);
    seedChips(ctx, "bob", 40_000);
    ctx.rankedTables.join({ tableId: "t-play", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t-play", userId: "bob", seat: 2, operationId: "join:bob" });
    // ready_check は引き続き閉じられる
    expect(ctx.rankedTables.snapshot("t-play").table.state).toBe("ready_check");
    ctx.rankedTables.ready({ tableId: "t-play", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t-play", userId: "bob", operationId: "ready:bob" });
    expect(ctx.rankedTables.snapshot("t-play").table.state).toBe("playing");

    expect(() =>
      ctx.rankedTables.cancelBeforeStart({
        tableId: "t-play",
        actorId: "employee-1",
        operationId: "close:1",
        authority: "employee",
        expectedGuildId: "guild-1",
      }),
    ).toThrow(RankedTableError);
    expect(ctx.rankedTables.snapshot("t-play").table.state).toBe("playing");
  });
});

describe("read-only table history", () => {
  it("returns recent tables newest first without changing anything", () => {
    const ctx = setup();
    createTable(ctx, "t1");
    ctx.setNow(NOW + 60);
    createTable(ctx, "t2");
    const before = ctx.db.prepare("SELECT table_id, state, revision FROM casino_tables ORDER BY table_id").all();

    const rows = ctx.persistentTables.listRecentTables(10);

    expect(rows.map((r) => r.tableId)).toEqual(["t2", "t1"]);
    expect(ctx.db.prepare("SELECT table_id, state, revision FROM casino_tables ORDER BY table_id").all()).toEqual(before);
  });

  it("caps the limit and tolerates an empty casino", () => {
    const ctx = setup();
    expect(ctx.persistentTables.listRecentTables(10)).toEqual([]);
    createTable(ctx, "t1");
    expect(ctx.persistentTables.listRecentTables(1_000)).toHaveLength(1);
  });

  it("scopes to one guild and fails closed without a guild", () => {
    const ctx = setup();
    for (const [tableId, guildId] of [["a", "guild-1"], ["b", "guild-2"], ["c", "guild-1"]] as const) {
      ctx.rankedTables.create({
        tableId,
        gameKey: "gf",
        baseAmount: 5_000,
        creatorId: "op",
        operatorId: "op",
        guildId,
        operationId: `create:${tableId}`,
        authority: "employee",
      });
    }

    expect(ctx.persistentTables.listRecentTables(10, "guild-1").map((r) => r.tableId).sort()).toEqual(["a", "c"]);
    expect(ctx.persistentTables.listRecentTables(10, "guild-2").map((r) => r.tableId)).toEqual(["b"]);
    // guildId を渡したのに空なら何も返さない（他サーバーの卓へ漏らさない）
    expect(ctx.persistentTables.listRecentTables(10, null)).toEqual([]);
    // 絞り込みは SQL 側なので、上限を跨いでも件数が目減りしない
    expect(ctx.persistentTables.listRecentTables(2, "guild-1")).toHaveLength(2);
  });
});

describe("operator-registered trusted rank profiles", () => {
  const base = { actorId: "owner", operationId: "op1" };

  it("accepts a zero-sum vector and makes it usable for a generic table", () => {
    const ctx = setup();
    ctx.rankedProfiles.register({ ...base, profileKey: "duel3", label: "三人決", participantCount: 3, rankDeltaBps: [10_000, 0, -10_000] });

    expect(ctx.rankedProfiles.list().map((row) => row.profileKey)).toEqual(["duel3"]);
    const profile = ctx.rankedProfiles.requiredProfile("duel3");
    const snapshot = ctx.rankedTables.create({
      tableId: "g1",
      gameKey: "duel3",
      profile,
      baseAmount: 5_000,
      creatorId: "employee-1",
      operatorId: "employee-1",
      operationId: "create:g1",
      authority: "employee",
    });
    expect(snapshot.config.participantCount).toBe(3);
  });

  it("rejects a distribution that is not zero-sum or not integer Land at every tier", () => {
    const ctx = setup();
    expect(() =>
      ctx.rankedProfiles.register({ ...base, profileKey: "bad", label: "非ゼロ和", participantCount: 2, rankDeltaBps: [10_000, -9_000] }),
    ).toThrow(RankedTableError);
    // 見習卓(500Ld)で整数Landにならない配分は、その場で断る
    expect(() =>
      ctx.rankedProfiles.register({ ...base, profileKey: "odd", label: "端数", participantCount: 2, rankDeltaBps: [10_001, -10_001] }),
    ).toThrow(RankedTableError);
    expect(ctx.rankedProfiles.list()).toEqual([]);
  });

  it("refuses to shadow a core-owned game key", () => {
    const ctx = setup();
    for (const key of ["gf", "sanma", "yonma"]) {
      expect(() =>
        ctx.rankedProfiles.register({ ...base, profileKey: key, label: "上書き", participantCount: 2, rankDeltaBps: [10_000, -10_000] }),
      ).toThrow(RankedProfileError);
    }
  });

  it("replays the same operation and refuses to redefine an existing key", () => {
    const ctx = setup();
    const input = { ...base, profileKey: "duel", label: "決", participantCount: 2, rankDeltaBps: [10_000, -10_000] };
    const first = ctx.rankedProfiles.register(input);
    expect(ctx.rankedProfiles.register(input)).toEqual(first);

    expect(() => ctx.rankedProfiles.register({ ...input, operationId: "op2", rankDeltaBps: [8_000, -8_000] })).toThrow(RankedProfileError);
    expect(ctx.rankedProfiles.get("duel")?.rankDeltaBps).toEqual([10_000, -10_000]);
  });

  it("fails closed when a generic table asks for an unregistered profile", () => {
    const ctx = setup();
    expect(() => ctx.rankedProfiles.requiredProfile("never-registered")).toThrow(RankedProfileError);
    expect(() =>
      ctx.rankedTables.create({
        tableId: "g1",
        gameKey: "never-registered",
        baseAmount: 5_000,
        creatorId: "employee-1",
        operatorId: "employee-1",
        operationId: "create:g1",
        authority: "employee",
      }),
    ).toThrow(RankedTableError);
  });
});
