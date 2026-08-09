import { describe, expect, it } from "vitest";
import {
  Casino,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  Ledger,
  OpeningPlanner,
  PersistentTables,
  RankedTableError,
  RankedTables,
  RANKED_PROFILES,
  TREASURY,
  classificationFor,
  escrowHolderFor,
  feeForBaseAmount,
  openDb,
  rankedReceipts,
  registerDefaultTxTypes,
  validateRankProfile,
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  CasinoStatus,
  Departments,
  Settings,
  HouseReservations,
  RankedDisputes,
  RankedDisputeError,
  rankedFeeReservationKey,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

function setup(options: ConstructorParameters<typeof RankedTables>[6] = {}) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(1_700_000_000);
  const casino = new Casino(db, chips, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0);
  const recordPlayerNet = (userId: string, net: number) => casino.recordGameNet(userId, net);
  const escrow = new Escrow(db, chips, events, { onPlayerNet: recordPlayerNet });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => 1_700_000_000 });
  const metrics = new CasinoMetrics(db, chipTx, () => 1_700_000_000);
  const chipAssets = new CasinoChipAssets(db, chips);
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, { now: () => 1_700_000_000, onPlayerNet: recordPlayerNet });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, {
    chipFlow,
    now: () => 1_700_000_000,
    reservations,
    disputes,
    ...options,
  });
  return { db, ledger, events, chipTx, chips, casino, escrow, persistentTables, metrics, rankedTables, chipFlow, reservations, disputes };
}

function seedUser(ctx: ReturnType<typeof setup>, userId: string, amount = 30_000): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}:${amount}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}:${amount}`);
}

function seedLandOnly(ctx: ReturnType<typeof setup>, userId: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `land:${userId}:${amount}` });
}

function createTable(ctx: ReturnType<typeof setup>, tableId = "t1", gameKey = "gf", baseAmount = 5_000) {
  return ctx.rankedTables.create({ tableId, gameKey, baseAmount, creatorId: "operator", operatorId: "operator", operationId: `create:${tableId}` });
}

function join(ctx: ReturnType<typeof setup>, tableId: string, userId: string, seat: number) {
  return ctx.rankedTables.join({ tableId, userId, seat, operationId: `join:${tableId}:${userId}` });
}

function startGf(ctx: ReturnType<typeof setup>, tableId = "t1") {
  createTable(ctx, tableId);
  seedUser(ctx, "alice");
  seedUser(ctx, "bob");
  join(ctx, tableId, "alice", 1);
  join(ctx, tableId, "bob", 2);
  ctx.rankedTables.ready({ tableId, userId: "alice", operationId: `ready:${tableId}:alice` });
  return ctx.rankedTables.ready({ tableId, userId: "bob", operationId: `ready:${tableId}:bob` });
}

function approveAll(ctx: ReturnType<typeof setup>, tableId: string, ordered: string[]) {
  const submitted = ctx.rankedTables.submitResult({ tableId, userId: ordered[0]!, orderedUserIds: ordered, operationId: `result:${tableId}:${ordered.join("-")}` });
  const hash = submitted.result!.hash;
  for (const userId of ordered) ctx.rankedTables.approve({ tableId, userId, resultHash: hash, operationId: `approve:${tableId}:${userId}` });
  return ctx.rankedTables.snapshot(tableId);
}

function escrowRows(ctx: ReturnType<typeof setup>, tableId: string): Array<{ user_id: string; amount: number; source: string }> {
  return ctx.db.prepare("SELECT user_id, amount, source FROM casino_escrow WHERE session_id=? ORDER BY user_id").all(tableId) as Array<{ user_id: string; amount: number; source: string }>;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [values.slice()];
  const out: T[][] = [];
  values.forEach((value, index) => {
    const rest = values.filter((_, i) => i !== index);
    for (const tail of permutations(rest)) out.push([value, ...tail]);
  });
  return out;
}

describe("ranked table math", () => {
  it("computes fixed GF, sanma, yonma receipts without floats", () => {
    expect(rankedReceipts(RANKED_PROFILES.gf, 5_000)).toEqual([10_000, 0]);
    expect(rankedReceipts(RANKED_PROFILES.sanma, 10_000)).toEqual([25_000, 5_000, 0]);
    expect(rankedReceipts(RANKED_PROFILES.yonma, 10_000)).toEqual([20_000, 15_000, 5_000, 0]);
    expect(feeForBaseAmount(5_000)).toBe(150);
  });

  it("accepts only explicit valid generic rank profiles", () => {
    expect(validateRankProfile({ key: "trusted", participantCount: 5, rankDeltaBps: [10_000, 5_000, 0, -5_000, -10_000] }, 5_000).participantCount).toBe(5);
    expect(() => validateRankProfile({ key: "bad", participantCount: 3, rankDeltaBps: [10_000, 0, 0] }, 5_000)).toThrow(RankedTableError);
    expect(() => validateRankProfile({ key: "bad", participantCount: 2, rankDeltaBps: [3_333, -3_333] }, 5_000)).toThrow(RankedTableError);
    expect(() => validateRankProfile({ key: "bad", participantCount: 2, rankDeltaBps: [-20_000, 20_000] }, 5_000)).toThrow(RankedTableError);
  });

  it("rejects custom payout profiles for fixed games but accepts canonical fixed and generic explicit profiles", () => {
    const ctx = setup();
    expect(() =>
      ctx.rankedTables.create({ tableId: "bad-gf", gameKey: "gf", baseAmount: 5_000, profile: { key: "gf", participantCount: 2, rankDeltaBps: [5_000, -5_000] }, creatorId: "operator", operatorId: "operator", operationId: "create:bad-gf" }),
    ).toThrow(RankedTableError);
    expect(() =>
      ctx.rankedTables.create({ tableId: "bad-sanma", gameKey: "sanma", baseAmount: 10_000, profile: { key: "sanma", participantCount: 3, rankDeltaBps: [10_000, 0, -10_000] }, creatorId: "operator", operatorId: "operator", operationId: "create:bad-sanma" }),
    ).toThrow(RankedTableError);
    expect(() =>
      ctx.rankedTables.create({ tableId: "bad-yonma", gameKey: "yonma", baseAmount: 10_000, profile: { key: "yonma", participantCount: 4, rankDeltaBps: [15_000, 0, -5_000, -10_000] }, creatorId: "operator", operatorId: "operator", operationId: "create:bad-yonma" }),
    ).toThrow(RankedTableError);
    expect(ctx.rankedTables.create({ tableId: "ok-gf", gameKey: "gf", baseAmount: 5_000, profile: RANKED_PROFILES.gf, creatorId: "operator", operatorId: "operator", operationId: "create:ok-gf" }).config.profile).toEqual(RANKED_PROFILES.gf);
    expect(ctx.rankedTables.create({ tableId: "ok-generic", gameKey: "trusted5", baseAmount: 5_000, profile: { key: "trusted5", participantCount: 5, rankDeltaBps: [10_000, 5_000, 0, -5_000, -10_000] }, creatorId: "operator2", operatorId: "operator", operationId: "create:ok-generic" }).config.participantCount).toBe(5);
  });
});

describe("RankedTables join and ready", () => {
  it("auto-deposits the exact join shortage before holding escrow", () => {
    const ctx = setup();
    createTable(ctx);
    seedLandOnly(ctx, "alice", 5_150);
    join(ctx, "t1", "alice", 1);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(0);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(escrowRows(ctx, "t1")).toEqual([{ user_id: "alice", amount: 5_150, source: escrowHolderFor("t1") }]);
  });

  it("auto-deposits only the missing part when free chips already exist", () => {
    const ctx = setup();
    createTable(ctx);
    seedLandOnly(ctx, "alice", 5_150);
    ctx.chips.deposit("alice", 1_000, "seed:partial-free");
    join(ctx, "t1", "alice", 1);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(0);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(5_150);
  });

  it("rolls back auto-deposit when later join work fails", () => {
    const ctx = setup({ afterAutoDepositForTesting: () => { throw new Error("after deposit"); } });
    createTable(ctx);
    seedLandOnly(ctx, "alice", 5_150);
    expect(() => join(ctx, "t1", "alice", 1)).toThrow("after deposit");
    expect(ctx.ledger.balanceOf("user:alice")).toBe(5_150);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(escrowRows(ctx, "t1")).toEqual([]);
    expect(ctx.persistentTables.participants("t1")).toEqual([]);
  });

  it("rolls back auto-deposit and escrow hold when a concurrent seat conflict reaches the insert", () => {
    const ctx = setup({
      afterAutoDepositForTesting: () => {
        ctx.db.prepare(
          `INSERT INTO casino_table_participants
             (table_id, user_id, seat, joined_at, operation_id, request_fingerprint, ready_state, approval_state, participant_state)
           VALUES ('t1', 'carol', 1, 1, 'join:carol', '{}', NULL, NULL, 'active')`,
        ).run();
      },
    });
    createTable(ctx);
    seedLandOnly(ctx, "alice", 5_150);
    expect(() => join(ctx, "t1", "alice", 1)).toThrow();
    expect(ctx.ledger.balanceOf("user:alice")).toBe(5_150);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(0);
    expect(ctx.persistentTables.participants("t1")).toEqual([]);
  });

  it("leaves Land, chips, escrow, and participants unchanged when Land is insufficient", () => {
    const ctx = setup();
    createTable(ctx);
    seedLandOnly(ctx, "alice", 5_149);
    expect(() => join(ctx, "t1", "alice", 1)).toThrow();
    expect(ctx.ledger.balanceOf("user:alice")).toBe(5_149);
    expect(ctx.chips.balanceOf("alice")).toBe(0);
    expect(escrowRows(ctx, "t1")).toEqual([]);
    expect(ctx.persistentTables.participants("t1")).toEqual([]);
  });

  it("holds R+fee atomically and replays without double hold", () => {
    const ctx = setup();
    createTable(ctx);
    seedUser(ctx, "alice");
    const first = ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    expect(first.participants).toHaveLength(1);
    expect(escrowRows(ctx, "t1")).toEqual([{ user_id: "alice", amount: 5_150, source: escrowHolderFor("t1") }]);
    expect(ctx.chips.balanceOf("alice")).toBe(24_850);
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    expect(escrowRows(ctx, "t1")).toHaveLength(1);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(5_150);
    expect(() => ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 2, operationId: "join:alice" })).toThrow(RankedTableError);
  });

  it("leaves no participant or escrow on insufficient funds", () => {
    const ctx = setup();
    createTable(ctx);
    seedUser(ctx, "alice", 1_000);
    expect(() => join(ctx, "t1", "alice", 1)).toThrow(RankedTableError);
    expect(ctx.persistentTables.participants("t1")).toEqual([]);
    expect(escrowRows(ctx, "t1")).toEqual([]);
    expect(ctx.chips.balanceOf("alice")).toBe(1_000);
  });

  it("moves to ready_check at capacity and starts with exactly one fee commit", () => {
    const ctx = setup();
    createTable(ctx);
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    join(ctx, "t1", "alice", 1);
    const readyCheck = join(ctx, "t1", "bob", 2);
    expect(readyCheck.table.state).toBe("ready_check");
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    const playing = ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    expect(playing.table.state).toBe("playing");
    expect(playing.table.startedAt).toBe(1_700_000_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(300);
    expect(ctx.reservations.get(rankedFeeReservationKey("t1"))?.amount).toBe(300);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_000);
    expect(escrowRows(ctx, "t1").map((r) => r.amount)).toEqual([5_000, 5_000]);
    expect(ctx.casino.stats("alice").total_lost).toBe(150);
    expect(ctx.casino.stats("bob").total_lost).toBe(150);
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(300);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_type='table_start'").get() as { n: number }).n).toBe(1);
  });

  it("rolls back fee commit if starting fails later in the same transaction", () => {
    const ctx = setup({ afterFeeCommitForTesting: () => { throw new Error("boom after fee"); } });
    createTable(ctx);
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    join(ctx, "t1", "alice", 1);
    join(ctx, "t1", "bob", 2);
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    expect(() => ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" })).toThrow("boom after fee");
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("ready_check");
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_300);
    expect(escrowRows(ctx, "t1").map((r) => r.amount)).toEqual([5_150, 5_150]);
    expect(ctx.casino.stats("alice").total_lost).toBe(0);
  });

  it("decline refunds R+fee and returns remaining users to recruiting", () => {
    const ctx = setup();
    createTable(ctx);
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    join(ctx, "t1", "alice", 1);
    join(ctx, "t1", "bob", 2);
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    const snapshot = ctx.rankedTables.decline({ tableId: "t1", userId: "bob", operationId: "decline:bob" });
    expect(snapshot.table.state).toBe("recruiting");
    expect(ctx.chips.balanceOf("bob")).toBe(30_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    expect(escrowRows(ctx, "t1")).toEqual([{ user_id: "alice", amount: 5_150, source: escrowHolderFor("t1") }]);
    expect(snapshot.participants.find((p) => p.userId === "alice")!.readyState).toBeNull();
  });

  it("allows replacement users to reuse declined seats without replay double refunds or holds", () => {
    const ctx = setup();
    createTable(ctx);
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    seedUser(ctx, "carol");
    join(ctx, "t1", "alice", 1);
    join(ctx, "t1", "bob", 2);
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.decline({ tableId: "t1", userId: "bob", operationId: "decline:bob" });
    ctx.rankedTables.decline({ tableId: "t1", userId: "bob", operationId: "decline:bob" });
    const replaced = join(ctx, "t1", "carol", 2);
    expect(replaced.participants.filter((p) => p.participantState !== "declined").map((p) => [p.userId, p.seat])).toEqual([["alice", 1], ["carol", 2]]);
    expect(ctx.chips.balanceOf("bob")).toBe(30_000);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_300);
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:t1:bob" });
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_300);
  });
});

describe("RankedTables result approval and settlement", () => {
  it("requires submitter approval and settles GF atomically", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    expect(submitted.table.state).toBe("pending_approval");
    expect(submitted.participants.every((p) => p.approvalState !== "approved")).toBe(true);
    const hash = submitted.result!.hash;
    ctx.rankedTables.approve({ tableId: "t1", userId: "alice", resultHash: hash, operationId: "approve:alice" });
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("pending_approval");
    const settled = ctx.rankedTables.approve({ tableId: "t1", userId: "bob", resultHash: hash, operationId: "approve:bob" });
    expect(settled.table.state).toBe("settled");
    expect(escrowRows(ctx, "t1")).toEqual([]);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(0);
    expect(ctx.chips.balanceOf("alice")).toBe(34_850);
    expect(ctx.chips.balanceOf("bob")).toBe(24_850);
    expect(ctx.reservations.get(rankedFeeReservationKey("t1"))).toBeUndefined();
    expect(ctx.casino.stats("alice").total_earned).toBe(5_000);
    expect(ctx.casino.stats("bob").total_lost).toBe(5_150);
    expect((ctx.db.prepare("SELECT source FROM casino_ranked_match_history WHERE table_id='t1'").get() as { source: string }).source).toBe("unanimous");
  });

  it("rejects stale hashes, outsiders, and records disputes without moving collateral", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    expect(() => ctx.rankedTables.approve({ tableId: "t1", userId: "alice", resultHash: "bad", operationId: "approve:bad" })).toThrow(RankedTableError);
    expect(() => ctx.rankedTables.approve({ tableId: "t1", userId: "carol", resultHash: submitted.result!.hash, operationId: "approve:carol" })).toThrow(RankedTableError);
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("disputed");
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(300);
    expect(ctx.reservations.get(rankedFeeReservationKey("t1"))?.amount).toBe(300);
    expect(ctx.disputes.publicStatus("t1")?.evidenceDeadlineAt).toBe(1_700_259_200);
  });

  it("settles every GF and sanma permutation and every yonma permutation conserving the pool", () => {
    const cases: Array<{ game: string; users: string[]; base: number }> = [
      { game: "gf", users: ["a", "b"], base: 5_000 },
      { game: "sanma", users: ["a", "b", "c"], base: 10_000 },
      { game: "yonma", users: ["a", "b", "c", "d"], base: 10_000 },
    ];
    for (const c of cases) {
      for (const order of permutations(c.users)) {
        const ctx = setup();
        createTable(ctx, "t", c.game, c.base);
        c.users.forEach((userId, index) => {
          seedUser(ctx, userId, 50_000);
          join(ctx, "t", userId, index + 1);
        });
        c.users.forEach((userId) => ctx.rankedTables.ready({ tableId: "t", userId, operationId: `ready:${userId}` }));
        const settled = approveAll(ctx, "t", order);
        expect(settled.table.state).toBe("settled");
        expect(ctx.chips.balanceOf(escrowHolderFor("t"))).toBe(0);
        expect(escrowRows(ctx, "t")).toEqual([]);
        expect(ctx.chips.pool()).toBe(ctx.ledger.balanceOf("sys:escrow:casino"));
      }
    }
  });

  it("rolls back settlement if a transfer fails before completion", () => {
    const ctx = setup({ beforeSettlementTransferForTesting: (index) => { if (index === 0) throw new Error("settle boom"); } });
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.approve({ tableId: "t1", userId: "alice", resultHash: submitted.result!.hash, operationId: "approve:alice" });
    expect(() => ctx.rankedTables.approve({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "approve:bob" })).toThrow("settle boom");
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("pending_approval");
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_000);
    expect(escrowRows(ctx, "t1").map((r) => r.amount)).toEqual([5_000, 5_000]);
  });

  it("moves settlement consistency mismatches to disputed without moving funds", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.approve({ tableId: "t1", userId: "alice", resultHash: submitted.result!.hash, operationId: "approve:alice" });
    ctx.db.prepare("UPDATE casino_escrow SET amount=amount-1 WHERE session_id='t1' AND user_id='alice'").run();
    const disputed = ctx.rankedTables.approve({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "approve:bob" });
    expect(disputed.table.state).toBe("disputed");
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_000);
    expect(escrowRows(ctx, "t1").map((r) => r.amount)).toEqual([4_999, 5_000]);
  });

  it("does not silently coerce partial stored results to no result at runtime", () => {
    const ctx = setup();
    startGf(ctx);
    ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.db.prepare("UPDATE casino_tables SET result_submitted_at=NULL WHERE table_id='t1'").run();
    expect(() => ctx.rankedTables.snapshot("t1")).toThrow(RankedTableError);
  });

  it("rejects ranked table states that require or forbid stored results", () => {
    const pending = setup();
    startGf(pending);
    pending.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    pending.db
      .prepare(
        `UPDATE casino_tables
            SET result_json=NULL, result_hash=NULL, result_submitted_by=NULL, result_submitted_at=NULL, result_operation_id=NULL
          WHERE table_id='t1'`,
      )
      .run();
    expect(() => pending.rankedTables.snapshot("t1")).toThrow(RankedTableError);

    const playing = setup();
    startGf(playing);
    expect(playing.rankedTables.snapshot("t1").result).toBeNull();
    playing.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    playing.db.prepare("UPDATE casino_tables SET state='playing' WHERE table_id='t1'").run();
    expect(() => playing.rankedTables.snapshot("t1")).toThrow(RankedTableError);
  });
});

describe("RankedDisputes evidence and arbitration", () => {
  it("rejects participant third-party testimony and does not count supporting-only evidence for ranked settlement", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
    expect(() =>
      ctx.disputes.submitEvidence({
        tableId: "t1",
        submitterId: "alice",
        evidenceKind: "third_party_testimony",
        operationId: "evidence:bad",
        privateChannelId: "private",
        privateMessageId: "msg1",
        payloadDigest: "digest",
      }),
    ).toThrow(RankedDisputeError);
    ctx.disputes.submitEvidence({
      tableId: "t1",
      submitterId: "carol",
      evidenceKind: "third_party_testimony",
      operationId: "evidence:supporting",
      privateChannelId: "private",
      privateMessageId: "msg2",
      payloadDigest: "digest2",
    });
    ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "judge", assignedBy: "owner", operationId: "assign:t1" });
    expect(() =>
      ctx.disputes.resolveRankedResult({
        tableId: "t1",
        actorId: "judge",
        orderedUserIds: ["bob", "alice"],
        feeOutcome: "keep",
        recordStats: true,
        publicSummary: "supporting evidence only",
        operationId: "resolve:t1",
      }),
    ).toThrow(RankedDisputeError);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(300);
  });

  it("settles ranked arbitration with stored main evidence and releases fee reservation", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
    ctx.disputes.submitEvidence({
      tableId: "t1",
      submitterId: "bob",
      evidenceKind: "screenshot",
      operationId: "evidence:main",
      privateChannelId: "private",
      privateMessageId: "msg",
      payloadDigest: "digest",
    });
    ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "judge", assignedBy: "owner", operationId: "assign:t1" });
    const resolved = ctx.disputes.resolveRankedResult({
      tableId: "t1",
      actorId: "judge",
      orderedUserIds: ["bob", "alice"],
      feeOutcome: "fault_refund",
      recordStats: true,
      publicSummary: "main evidence supports reversed order",
      operationId: "resolve:t1",
    });
    expect(resolved.resolutionKind).toBe("ranked_result");
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("settled");
    expect(ctx.chips.balanceOf("alice")).toBe(25_000);
    expect(ctx.chips.balanceOf("bob")).toBe(35_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    expect(ctx.reservations.get(rankedFeeReservationKey("t1"))).toBeUndefined();
    expect((ctx.db.prepare("SELECT source FROM casino_ranked_match_history WHERE table_id='t1'").get() as { source: string }).source).toBe("arbitration");
  });

  it("blocks participant arbitrators and refund-resolves collateral without match history", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
    expect(() => ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "alice", assignedBy: "owner", operationId: "assign:alice" })).toThrow(RankedDisputeError);
    ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "judge", assignedBy: "owner", operationId: "assign:judge" });
    ctx.disputes.resolveCollateralRefund({
      tableId: "t1",
      actorId: "judge",
      feeOutcome: "keep",
      publicSummary: "neutral collateral refund",
      operationId: "refund:t1",
    });
    expect(ctx.persistentTables.get("t1")?.state).toBe("cancelled_by_admin");
    expect(ctx.chips.balanceOf("alice")).toBe(29_850);
    expect(ctx.chips.balanceOf("bob")).toBe(29_850);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_ranked_match_history WHERE table_id='t1'").get() as { n: number }).n).toBe(0);
  });

  it("auto-refunds collateral at the 72h evidence deadline when no stored main evidence exists", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
    const processed = ctx.disputes.processEvidenceDeadlines(1_700_259_200);
    expect(processed).toEqual({ closed: 0, autoRefunded: 1, failed: 0 });
    expect(ctx.persistentTables.get("t1")?.state).toBe("cancelled");
    expect(ctx.chips.balanceOf("alice")).toBe(29_850);
    expect(ctx.chips.balanceOf("bob")).toBe(29_850);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(300);
    expect(ctx.reservations.get(rankedFeeReservationKey("t1"))).toBeUndefined();
  });

  it("closes evidence collection without moving money when stored main evidence exists", () => {
    const ctx = setup();
    startGf(ctx);
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
    ctx.disputes.submitEvidence({
      tableId: "t1",
      submitterId: "bob",
      evidenceKind: "history_url",
      operationId: "evidence:main",
      privateChannelId: "private",
      privateMessageId: "msg",
      payloadDigest: "digest",
    });
    expect(ctx.disputes.processEvidenceDeadlines(1_700_259_200)).toEqual({ closed: 1, autoRefunded: 0, failed: 0 });
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(300);
    expect(() =>
      ctx.disputes.submitEvidence({
        tableId: "t1",
        submitterId: "bob",
        evidenceKind: "replay_id",
        operationId: "evidence:late",
        privateChannelId: "private",
        privateMessageId: "msg2",
        payloadDigest: "digest2",
      }),
    ).toThrow(RankedDisputeError);
  });
});

describe("RankedTables timeout, metrics, and opening safety", () => {
  it("processes durable deadlines idempotently", () => {
    const ctx = setup();
    createTable(ctx);
    seedUser(ctx, "alice");
    join(ctx, "t1", "alice", 1);
    ctx.db.prepare("UPDATE casino_tables SET deadline_at=? WHERE table_id='t1'").run(1_699_999_999);
    expect(ctx.rankedTables.processDueTables(1_700_000_000)).toEqual({ processed: 1, refunded: 1, disputed: 0 });
    expect(ctx.chips.balanceOf("alice")).toBe(30_000);
    expect(ctx.rankedTables.processDueTables(1_700_000_000)).toEqual({ processed: 0, refunded: 0, disputed: 0 });

    startGf(ctx, "playing-timeout");
    ctx.db.prepare("UPDATE casino_tables SET deadline_at=? WHERE table_id='playing-timeout'").run(1_699_999_999);
    expect(ctx.rankedTables.processDueTables(1_700_000_000).disputed).toBe(1);
    expect(ctx.chips.balanceOf(escrowHolderFor("playing-timeout"))).toBe(10_000);
  });

  it("applies state-aware ranked deadlines and keeps the recruiting hard cap anchored to created_at", () => {
    const ctx = setup();
    startGf(ctx, "playing-hardcap");
    ctx.db.prepare("UPDATE casino_tables SET created_at=?, expires_at=?, deadline_at=? WHERE table_id='playing-hardcap'").run(1_699_980_000, 1_699_990_800, 1_700_086_400);
    expect(ctx.rankedTables.processDueTables(1_700_000_000)).toEqual({ processed: 0, refunded: 0, disputed: 0 });
    expect(ctx.rankedTables.snapshot("playing-hardcap").table.state).toBe("playing");
    ctx.db.prepare("UPDATE casino_tables SET deadline_at=? WHERE table_id='playing-hardcap'").run(1_699_999_999);
    expect(ctx.rankedTables.processDueTables(1_700_000_000).disputed).toBe(1);

    const pending = setup();
    startGf(pending, "pending-timeout");
    const submitted = pending.rankedTables.submitResult({ tableId: "pending-timeout", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:pending-timeout" });
    pending.db.prepare("UPDATE casino_tables SET deadline_at=? WHERE table_id='pending-timeout'").run(1_699_999_999);
    expect(submitted.table.state).toBe("pending_approval");
    expect(pending.rankedTables.processDueTables(1_700_000_000).disputed).toBe(1);

    const ready = setup();
    createTable(ready);
    seedUser(ready, "alice");
    seedUser(ready, "bob");
    join(ready, "t1", "alice", 1);
    join(ready, "t1", "bob", 2);
    ready.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ready.db.prepare("UPDATE casino_tables SET created_at=?, deadline_at=? WHERE table_id='t1'").run(1_699_989_300, 1_699_999_999);
    ready.rankedTables.processDueTables(1_700_000_000);
    const returned = ready.rankedTables.snapshot("t1").table;
    expect(returned.state).toBe("recruiting");
    expect(returned.expiresAt).toBe(1_700_000_100);
  });

  it("does not process a stale due-list snapshot after the deadline is extended", () => {
    const ctx = setup();
    createTable(ctx);
    seedUser(ctx, "alice");
    join(ctx, "t1", "alice", 1);
    ctx.db.prepare("UPDATE casino_tables SET deadline_at=? WHERE table_id='t1'").run(1_699_999_999);
    expect(ctx.persistentTables.listDueTables(1_700_000_000)).toHaveLength(1);
    ctx.db.prepare("UPDATE casino_tables SET deadline_at=? WHERE table_id='t1'").run(1_700_000_500);
    expect(ctx.rankedTables.processDueTables(1_700_000_000)).toEqual({ processed: 0, refunded: 0, disputed: 0 });
    expect(ctx.rankedTables.snapshot("t1").table.state).toBe("recruiting");
  });

  it("rolls up table_fee_income from idempotent table_start metrics and matches house P/L", () => {
    const ctx = setup();
    startGf(ctx);
    ctx.db.prepare("UPDATE casino_tx SET created_at=? WHERE session_id='t1'").run(1_700_000_000);
    const row = ctx.metrics.rollupDaily("2023-11-15")!;
    expect(row.table_fee_income).toBe(300);
    expect(row.house_pnl).toBe(300);
    expect(row.table_start_count).toBe(1);
    ctx.metrics.record({
      eventKey: "table_start:t1",
      eventType: "table_start",
      game: "gf",
      amount: 300,
      operationId: "ready:t1:bob",
      payload: { tableId: "t1", feePerUser: 150, participants: 2 },
      occurredAt: 1_700_000_000,
    });
    expect(ctx.metrics.rollupDaily("2023-11-15")!.table_fee_income).toBe(300);
  });

  it("keeps casino table opening classification known without adding new casino tables", () => {
    expect(classificationFor("casino_tables")).toBeTruthy();
    expect(classificationFor("casino_table_participants")).toBeTruthy();
    const ctx = setup();
    createTable(ctx);
    const chipAssets = new CasinoChipAssets(ctx.db, ctx.chips);
    const integrity = new CasinoIntegrity(ctx.db, ctx.ledger, ctx.chips, ctx.escrow, chipAssets);
    const status = new CasinoStatus(ctx.db);
    const settings = new Settings(ctx.db);
    const departments = new Departments(ctx.db, ctx.ledger);
    const planner = new OpeningPlanner({ db: ctx.db, ledger: ctx.ledger, chips: ctx.chips, chipAssets, integrity, status, settings, departments });
    const preflight = planner.dryRun();
    expect(preflight.tableAudits.find((audit) => audit.table === "casino_tables")?.classification).not.toBe("unknown");
    expect(preflight.tableAudits.find((audit) => audit.table === "casino_table_participants")?.classification).not.toBe("unknown");
  });
});
