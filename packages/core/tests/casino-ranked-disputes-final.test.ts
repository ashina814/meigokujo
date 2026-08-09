import { describe, expect, it } from "vitest";
import {
  Casino,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputeError,
  RankedDisputes,
  RankedTables,
  TREASURY,
  escrowHolderFor,
  openDb,
  rankedFeeReservationKey,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

function setup() {
  const clock = { now: 1_700_000_000 };
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  const casino = new Casino(db, chips, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0);
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => clock.now });
  const metrics = new CasinoMetrics(db, chipTx, () => clock.now);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    openingPhase: () => chipTx.openingPhase(),
    now: () => clock.now,
    onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, {
    now: () => clock.now,
    reservations,
    disputes,
  });
  return { clock, db, ledger, chips, escrow, persistentTables, reservations, disputes, rankedTables };
}

function seed(ctx: ReturnType<typeof setup>, userId: string): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount: 30_000,
    type: "initial",
    actor: "test",
    idempotencyKey: `seed:${userId}`,
  });
  ctx.chips.deposit(userId, 30_000, `deposit:${userId}`);
}

function createJoined(ctx: ReturnType<typeof setup>, tableId = "t1"): void {
  ctx.rankedTables.create({
    tableId,
    gameKey: "gf",
    baseAmount: 5_000,
    creatorId: "operator",
    operatorId: "operator",
    guildId: "guild",
    channelId: "channel",
    messageId: "message",
    operationId: `create:${tableId}`,
  });
  for (const userId of ["alice", "bob"]) seed(ctx, userId);
  ctx.rankedTables.join({ tableId, userId: "alice", seat: 1, operationId: `join:${tableId}:alice` });
  ctx.rankedTables.join({ tableId, userId: "bob", seat: 2, operationId: `join:${tableId}:bob` });
}

function createPostStartDispute(ctx: ReturnType<typeof setup>, tableId = "t1", withMainEvidence = false): void {
  createJoined(ctx, tableId);
  ctx.rankedTables.ready({ tableId, userId: "alice", operationId: `ready:${tableId}:alice` });
  ctx.rankedTables.ready({ tableId, userId: "bob", operationId: `ready:${tableId}:bob` });
  const submitted = ctx.rankedTables.submitResult({
    tableId,
    userId: "alice",
    orderedUserIds: ["alice", "bob"],
    operationId: `result:${tableId}`,
  });
  ctx.rankedTables.dispute({ tableId, userId: "bob", resultHash: submitted.result!.hash, operationId: `dispute:${tableId}:bob` });
  if (withMainEvidence) {
    ctx.disputes.submitEvidence({
      tableId,
      submitterId: "alice",
      evidenceKind: "screenshot",
      operationId: `evidence:${tableId}`,
      privateChannelId: "private-channel",
      privateMessageId: "private-message",
      payloadDigest: "secret-digest",
      storageStatus: "stored",
    });
  }
}

function createPreStartDispute(ctx: ReturnType<typeof setup>, tableId = "t1"): void {
  createJoined(ctx, tableId);
  const current = ctx.persistentTables.get(tableId)!;
  const disputed = ctx.persistentTables.markDisputedFromRecovery(tableId, current.revision, "pre-start recovery dispute");
  ctx.disputes.openForTable(disputed, "pre-start recovery dispute");
}

describe("PR22 final review: durable public message sync and pre-start disputes", () => {
  it("playing timeout -> disputed queues durable message sync", () => {
    const ctx = setup();
    createJoined(ctx);
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:a" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:b" });
    ctx.db.prepare("UPDATE casino_tables SET deadline_at=? WHERE table_id='t1'").run(ctx.clock.now - 1);

    expect(ctx.rankedTables.processDueTables(ctx.clock.now).disputed).toBe(1);
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    expect(ctx.disputes.listMessageSyncPending().map((row) => row.tableId)).toContain("t1");
  });

  it("evidence close queues sync without resolving post-start evidence-backed dispute", () => {
    const ctx = setup();
    createPostStartDispute(ctx, "t1", true);
    ctx.disputes.markMessageSyncSucceeded("t1");
    const deadline = ctx.disputes.publicStatus("t1")!.evidenceDeadlineAt;

    expect(ctx.disputes.processEvidenceDeadlines(deadline)).toEqual({ closed: 1, autoRefunded: 0, failed: 0 });
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    expect(ctx.disputes.publicStatus("t1")?.evidenceClosedAt).toBe(deadline);
    expect(ctx.disputes.listMessageSyncPending().map((row) => row.tableId)).toContain("t1");
  });

  it("post-start insufficient evidence auto-refund becomes terminal and queues sync with exact refund receipts", () => {
    const ctx = setup();
    createPostStartDispute(ctx);
    ctx.disputes.markMessageSyncSucceeded("t1");
    const deadline = ctx.disputes.publicStatus("t1")!.evidenceDeadlineAt;

    expect(ctx.disputes.processEvidenceDeadlines(deadline)).toEqual({ closed: 0, autoRefunded: 1, failed: 0 });
    expect(ctx.persistentTables.get("t1")?.state).toBe("cancelled");
    expect(ctx.disputes.publicStatus("t1")?.refundAmounts).toEqual([
      { userId: "alice", amount: 5_000 },
      { userId: "bob", amount: 5_000 },
    ]);
    expect(ctx.disputes.listMessageSyncPending().map((row) => row.tableId)).toContain("t1");
  });

  it("pre-start + stored main evidence + 72h refunds full escrow instead of awaiting arbitration", () => {
    const ctx = setup();
    createPreStartDispute(ctx);
    ctx.disputes.submitEvidence({
      tableId: "t1",
      submitterId: "alice",
      evidenceKind: "screenshot",
      operationId: "evidence:prestart",
      privateChannelId: "secret-channel",
      privateMessageId: "secret-message",
      payloadDigest: "secret-digest",
      storageStatus: "stored",
    });
    ctx.disputes.markMessageSyncSucceeded("t1");
    const deadline = ctx.disputes.publicStatus("t1")!.evidenceDeadlineAt;

    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    expect(ctx.reservations.get(rankedFeeReservationKey("t1"))).toBeUndefined();
    expect(ctx.disputes.processEvidenceDeadlines(deadline)).toEqual({ closed: 0, autoRefunded: 1, failed: 0 });

    const status = ctx.disputes.publicStatus("t1")!;
    expect(ctx.persistentTables.get("t1")?.state).toBe("cancelled");
    expect(status.resolutionKind).toBe("refund_collateral");
    expect(status.preStart).toBe(true);
    expect(status.refundAmounts).toEqual([
      { userId: "alice", amount: 5_150 },
      { userId: "bob", amount: 5_150 },
    ]);
    expect(ctx.db.prepare("SELECT status FROM casino_table_disputes WHERE table_id='t1'").get()).toEqual({ status: "refund_collateral" });
    expect(ctx.escrow.list("t1")).toEqual([]);
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(0);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    expect(ctx.reservations.get(rankedFeeReservationKey("t1"))).toBeUndefined();
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_ranked_match_history WHERE table_id='t1'").get() as { n: number }).n).toBe(0);
    expect(ctx.disputes.listMessageSyncPending().map((row) => row.tableId)).toContain("t1");
  });

  it("resolveRankedResult explicitly rejects a pre-start dispute even with main evidence", () => {
    const ctx = setup();
    createPreStartDispute(ctx);
    ctx.disputes.submitEvidence({
      tableId: "t1",
      submitterId: "alice",
      evidenceKind: "history_url",
      operationId: "evidence:prestart-result",
      privateChannelId: "secret-channel",
      privateMessageId: "secret-message",
      payloadDigest: "secret-digest",
      storageStatus: "stored",
    });
    ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "judge", assignedBy: "owner", operationId: "assign:judge" });

    try {
      ctx.disputes.resolveRankedResult({
        tableId: "t1",
        actorId: "judge",
        orderedUserIds: ["alice", "bob"],
        feeOutcome: "keep",
        recordStats: true,
        publicSummary: "pre-start result must not settle",
        operationId: "resolve:prestart",
      });
      throw new Error("expected resolveRankedResult to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(RankedDisputeError);
      expect((error as RankedDisputeError).code).toBe("ERR_DISPUTE_PRE_START_RESULT");
    }
    expect(ctx.persistentTables.get("t1")?.state).toBe("disputed");
    expect(ctx.chips.balanceOf(escrowHolderFor("t1"))).toBe(10_300);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
  });
});
