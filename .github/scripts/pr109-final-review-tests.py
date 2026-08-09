from pathlib import Path

p = Path("apps/bot/tests/casino-ranked-table-ui.test.ts")
text = p.read_text(encoding="utf-8")
text = text.replace(
    'rankedDisputes: { publicStatus: vi.fn(() => null) },',
    'rankedDisputes: { publicStatus: vi.fn(() => null), markMessageSyncSucceeded: vi.fn(), markMessageSyncFailed: vi.fn() },',
)
target = '''      evidenceClosedAt: null,\n      assignedArbitratorId: "judge",'''
replacement = '''      evidenceClosedAt: null,\n      preStart: false,\n      refundAmounts: null,\n      assignedArbitratorId: "judge",'''
if target not in text:
    raise SystemExit("missing ranked UI public status fixture target")
text = text.replace(target, replacement, 1)
p.write_text(text, encoding="utf-8")

Path("packages/core/tests/casino-ranked-disputes-final.test.ts").write_text(r'''import { describe, expect, it } from "vitest";
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
''', encoding="utf-8")

Path("packages/core/tests/helpers/ranked-dispute-final-runner.ts").write_text(r'''import {
  Casino,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputes,
  openDb,
  registerDefaultTxTypes,
} from "../../src/index.js";

registerDefaultTxTypes();

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  tableId: string;
  operation: "deadline" | "finalize" | "ranked_result";
  operationId: string;
  actor: string;
  serviceNow: number;
  deadlineNow: number;
  startAt: number;
};

const db = openDb(input.dbPath);
const ledger = new Ledger(db);
const events = new EventLog(db);
const chipTx = new ChipTx(db);
const chips = new ChipLedger(db, ledger, events, { chipTx });
const casino = new Casino(db, chips, events);
const reservations = new HouseReservations(db, chips, events);
chips.setReservedProvider((holderId) => holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0);
const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => input.serviceNow });
const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
  openingPhase: () => chipTx.openingPhase(),
  now: () => input.serviceNow,
  onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
});

disputes.publicStatus(input.tableId);

setTimeout(() => {
  try {
    if (input.operation === "deadline") {
      const result = disputes.processEvidenceDeadlines(input.deadlineNow);
      console.log(JSON.stringify({ ok: true, result }));
    } else if (input.operation === "finalize") {
      const result = disputes.finalizeEvidenceStored({
        operationId: input.operationId,
        privateChannelId: "private-channel",
        privateMessageId: "private-message",
        metadata: { source: "race-test" },
      });
      console.log(JSON.stringify({ ok: true, result }));
    } else {
      const result = disputes.resolveRankedResult({
        tableId: input.tableId,
        actorId: input.actor,
        orderedUserIds: ["alice", "bob"],
        feeOutcome: "fault_refund",
        recordStats: true,
        publicSummary: "manual arbitration race",
        operationId: input.operationId,
      });
      console.log(JSON.stringify({ ok: true, resolutionKind: result.resolutionKind, resolvedAt: result.resolvedAt }));
    }
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? err.name, error: err.message }));
  } finally {
    db.close();
  }
}, Math.max(0, input.startAt - Date.now()));
''', encoding="utf-8")

Path("packages/core/tests/casino-ranked-disputes-final-concurrency.serial.test.ts").write_text(r'''import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "ranked-dispute-final-runner.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunnerResult {
  ok: boolean;
  code?: string;
  error?: string;
  result?: { closed: number; autoRefunded: number; failed: number } | { evidenceId: string; status: string };
  resolutionKind?: string | null;
}

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-pr22-final-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  const casino = new Casino(db, chips, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0);
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => 1_700_000_000 });
  const metrics = new CasinoMetrics(db, chipTx, () => 1_700_000_000);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    openingPhase: () => chipTx.openingPhase(),
    now: () => 1_700_000_000,
    onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, {
    now: () => 1_700_000_000,
    reservations,
    disputes,
  });
  return { dbPath, db, ledger, chips, escrow, reservations, disputes, rankedTables };
}

function seed(ctx: ReturnType<typeof setupFileDb>, userId: string): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 30_000, type: "initial", actor: "test", idempotencyKey: `seed:${userId}` });
  ctx.chips.deposit(userId, 30_000, `deposit:${userId}`);
}

function disputedPostStart(ctx: ReturnType<typeof setupFileDb>, evidence: "pending" | "stored"): { deadline: number; evidenceOperationId: string } {
  ctx.rankedTables.create({ tableId: "t1", gameKey: "gf", baseAmount: 5_000, creatorId: "operator", operatorId: "operator", operationId: "create:t1" });
  seed(ctx, "alice");
  seed(ctx, "bob");
  ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
  ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
  ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
  ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
  const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
  ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
  const evidenceOperationId = "evidence:race";
  ctx.disputes.beginEvidenceSubmission({ tableId: "t1", submitterId: "alice", evidenceKind: "screenshot", operationId: evidenceOperationId, payloadDigest: "digest" });
  if (evidence === "stored") {
    ctx.disputes.finalizeEvidenceStored({ operationId: evidenceOperationId, privateChannelId: "private-channel", privateMessageId: "private-message" });
  }
  return { deadline: ctx.disputes.publicStatus("t1")!.evidenceDeadlineAt, evidenceOperationId };
}

function spawnRunner(
  dbPath: string,
  operation: "deadline" | "finalize" | "ranked_result",
  operationId: string,
  serviceNow: number,
  deadlineNow: number,
  startAt: number,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({ dbPath, tableId: "t1", operation, operationId, actor: "judge", serviceNow, deadlineNow, startAt });
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, input], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line) as RunnerResult);
    });
  });
}

function chipSum(db: ReturnType<typeof openDb>): number {
  return (db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM ether_balances").get() as { n: number }).n;
}

describe("PR22 final review cross-process arbitration races", () => {
  it("A: evidence finalize and deadline cannot commit stored evidence together with auto-refund", async () => {
    const ctx = setupFileDb();
    const { deadline, evidenceOperationId } = disputedPostStart(ctx, "pending");
    ctx.db.close();

    const startAt = Date.now() + 2_000;
    const [finalize, deadlineRun] = await Promise.all([
      spawnRunner(ctx.dbPath, "finalize", evidenceOperationId, deadline - 1, deadline, startAt),
      spawnRunner(ctx.dbPath, "deadline", "deadline:t1", deadline - 1, deadline, startAt),
    ]);

    const db = openDb(ctx.dbPath);
    const evidenceRow = db.prepare("SELECT storage_status AS storageStatus FROM casino_table_evidence WHERE operation_id=?").get(evidenceOperationId) as { storageStatus: string };
    const dispute = db.prepare("SELECT status, resolved_at AS resolvedAt, resolution_kind AS resolutionKind FROM casino_table_disputes WHERE table_id='t1'").get() as {
      status: string;
      resolvedAt: number | null;
      resolutionKind: string | null;
    };
    const table = db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string };

    if (evidenceRow.storageStatus === "stored") {
      expect(finalize.ok).toBe(true);
      expect(dispute.resolvedAt).toBeNull();
      expect(dispute.status).toBe("awaiting_arbitration");
      expect(table.state).toBe("disputed");
      expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(10_000);
      expect(deadlineRun.ok).toBe(true);
    } else {
      expect(deadlineRun.ok).toBe(true);
      expect(dispute.resolutionKind).toBe("insufficient_evidence");
      expect(dispute.resolvedAt).not.toBeNull();
      expect(table.state).toBe("cancelled");
      expect(finalize.ok).toBe(false);
      expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:evidence-timeout:%'").get() as { n: number }).n).toBe(1);
    }
    expect(!(evidenceRow.storageStatus === "stored" && dispute.resolvedAt !== null)).toBe(true);
    db.close();
  }, 60_000);

  it("B: two manual arbitrations have one winner and move/release/refund/history exactly once", async () => {
    const ctx = setupFileDb();
    disputedPostStart(ctx, "stored");
    ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "judge", assignedBy: "owner", operationId: "assign:judge" });
    const beforeSum = chipSum(ctx.db);
    ctx.db.close();

    const startAt = Date.now() + 2_000;
    const results = await Promise.all([
      spawnRunner(ctx.dbPath, "ranked_result", "arb:one", 1_700_000_100, 1_700_259_200, startAt),
      spawnRunner(ctx.dbPath, "ranked_result", "arb:two", 1_700_000_100, 1_700_259_200, startAt),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const db = openDb(ctx.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_table_disputes WHERE table_id='t1' AND resolved_at IS NOT NULL").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string }).state).toBe("settled");
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(0);
    expect(db.prepare("SELECT * FROM casino_escrow WHERE session_id='t1'").all()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key IN ('ranked:dispute:t1:arb:one','ranked:dispute:t1:arb:two')").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx WHERE session_id='t1' AND reason='ranked table fault fee refund'").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_ranked_match_history WHERE table_id='t1'").get() as { n: number }).n).toBe(1);
    expect(db.prepare("SELECT * FROM casino_house_reservations WHERE key=?").get(rankedFeeReservationKey("t1"))).toBeUndefined();
    expect(chipSum(db)).toBe(beforeSum);
    db.close();
  }, 60_000);
});
''', encoding="utf-8")

Path("apps/bot/tests/casino-ranked-message-sync-final.test.ts").write_text(r'''import { describe, expect, it, vi } from "vitest";
import type { RankedDisputePublicStatus, RankedTableSnapshot } from "@meigokujo/core";
import {
  editBoundRankedTableMessage,
  renderRankedTable,
  retryPendingRankedTableMessages,
} from "../src/casino/ranked-table-ui.js";

function snapshot(state: RankedTableSnapshot["table"]["state"], result = true): RankedTableSnapshot {
  return {
    table: {
      tableId: "t1",
      state,
      gameKey: "gf",
      creatorId: "operator",
      operatorId: "operator",
      guildId: "guild",
      channelId: "channel",
      messageId: "message",
      createdAt: 1,
      updatedAt: 2,
      stateChangedAt: 2,
      startedAt: 2,
      deadlineAt: null,
      expiresAt: null,
      revision: 8,
      operationId: "create",
      requestFingerprint: "{}",
      failureReason: null,
      disputeReason: "disputed",
      recoveryError: null,
    },
    config: {
      baseAmount: 5_000,
      feePerUser: 150,
      participantCount: 2,
      profile: { key: "gf", participantCount: 2, rankDeltaBps: [10_000, -10_000] },
    },
    participants: [
      { tableId: "t1", userId: "alice", seat: 1, joinedAt: 1, operationId: "j:a", requestFingerprint: "{}", readyState: "ready", approvalState: "disputed", participantState: "active", readyOperationId: null, readyFingerprint: null, approvalOperationId: null, approvalFingerprint: null, declinedAt: null },
      { tableId: "t1", userId: "bob", seat: 2, joinedAt: 1, operationId: "j:b", requestFingerprint: "{}", readyState: "ready", approvalState: null, participantState: "active", readyOperationId: null, readyFingerprint: null, approvalOperationId: null, approvalFingerprint: null, declinedAt: null },
    ],
    result: result ? { orderedUserIds: ["alice", "bob"], hash: "abcdef0123456789", submittedBy: "judge", submittedAt: 3 } : null,
  };
}

function status(patch: Partial<RankedDisputePublicStatus> = {}): RankedDisputePublicStatus {
  return {
    tableId: "t1",
    evidenceDeadlineAt: 1_700_259_200,
    evidenceClosedAt: 1_700_259_200,
    preStart: false,
    refundAmounts: null,
    assignedArbitratorId: "judge",
    resolutionKind: "ranked_result",
    feeOutcome: "keep",
    recordStats: true,
    publicSummary: "短い公開理由",
    resolvedBy: "123456789",
    resolvedAt: 1_700_259_201,
    ...patch,
  };
}

function services(snap: RankedTableSnapshot, dispute: RankedDisputePublicStatus) {
  return {
    rankedTables: { snapshot: vi.fn(() => snap) },
    rankedDisputes: {
      publicStatus: vi.fn(() => dispute),
      listMessageSyncPending: vi.fn(() => [{ tableId: "t1", requestedAt: 1, attempts: 0, lastAttemptAt: null, lastError: null }]),
      markMessageSyncSucceeded: vi.fn(),
      markMessageSyncFailed: vi.fn(),
    },
    events: { log: vi.fn() },
  } as any;
}

describe("PR22 final review public receipts and durable Discord sync", () => {
  it("public ranked_result derives the final distribution from the canonical rank profile", () => {
    const payload = renderRankedTable(snapshot("settled"), status());
    const text = payload.embeds[0]!.data.description!;
    expect(text).toContain("1位 <@alice> — 10,000 Ld");
    expect(text).toContain("2位 <@bob> — 0 Ld");
    expect(text).toContain("場代: 保持（keep）");
    expect(text).toContain("理由: 短い公開理由");
    expect(text).toContain("裁定者: <@123456789>");
    expect(text).toContain("日時: <t:1700259201:f>");
  });

  it("public collateral refund contains per-participant actual refund amounts and Japanese fee outcome", () => {
    const payload = renderRankedTable(snapshot("cancelled", false), status({
      resolutionKind: "refund_collateral",
      feeOutcome: "keep",
      preStart: true,
      refundAmounts: [
        { userId: "alice", amount: 5_150 },
        { userId: "bob", amount: 5_150 },
      ],
    }));
    const text = payload.embeds[0]!.data.description!;
    expect(text).toContain("<@alice> — 5,150 Ld");
    expect(text).toContain("<@bob> — 5,150 Ld");
    expect(text).toContain("場代: 対局開始前のため未確定（預託分を全額返金）");
  });

  it("renderer never emits raw evidence fields", () => {
    const dispute = status() as RankedDisputePublicStatus & { privateChannelId: string; privateMessageId: string; payloadDigest: string; evidenceUrl: string };
    dispute.privateChannelId = "secret-channel";
    dispute.privateMessageId = "secret-message";
    dispute.payloadDigest = "secret-digest";
    dispute.evidenceUrl = "https://example.invalid/raw-evidence";
    const raw = JSON.stringify(renderRankedTable(snapshot("settled"), dispute));
    expect(raw).not.toContain("secret-channel");
    expect(raw).not.toContain("secret-message");
    expect(raw).not.toContain("secret-digest");
    expect(raw).not.toContain("example.invalid");
  });

  it("successful Discord edit clears pending only after edit succeeds", async () => {
    const snap = snapshot("settled");
    const dispute = status();
    const svc = services(snap, dispute);
    const edit = vi.fn(async () => undefined);
    const client = { channels: { cache: new Map([["channel", { messages: { fetch: vi.fn(async () => ({ edit })) } }]]), fetch: vi.fn() } } as any;

    await expect(editBoundRankedTableMessage(client, svc, "t1")).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(svc.rankedDisputes.markMessageSyncSucceeded).toHaveBeenCalledWith("t1");
    expect(svc.rankedDisputes.markMessageSyncFailed).not.toHaveBeenCalled();
  });

  it("failed Discord edit preserves pending and never rolls back the committed state", async () => {
    const snap = snapshot("settled");
    const dispute = status();
    const svc = services(snap, dispute);
    const error = new Error("transient Discord failure");
    const edit = vi.fn(async () => { throw error; });
    const client = { channels: { cache: new Map([["channel", { messages: { fetch: vi.fn(async () => ({ edit })) } }]]), fetch: vi.fn() } } as any;

    await expect(editBoundRankedTableMessage(client, svc, "t1")).resolves.toBe(false);
    expect(svc.rankedDisputes.markMessageSyncSucceeded).not.toHaveBeenCalled();
    expect(svc.rankedDisputes.markMessageSyncFailed).toHaveBeenCalledWith("t1", error);
    expect(svc.rankedTables.snapshot("t1").table.state).toBe("settled");
  });

  it("pending retry includes terminal tables without listLiveTables", async () => {
    const snap = snapshot("cancelled", false);
    const dispute = status({
      resolutionKind: "insufficient_evidence",
      refundAmounts: [
        { userId: "alice", amount: 5_000 },
        { userId: "bob", amount: 5_000 },
      ],
    });
    const svc = services(snap, dispute);
    const edit = vi.fn(async () => undefined);
    const client = { channels: { cache: new Map([["channel", { messages: { fetch: vi.fn(async () => ({ edit })) } }]]), fetch: vi.fn() } } as any;

    await expect(retryPendingRankedTableMessages(client, svc)).resolves.toEqual({ attempted: 1, synced: 1, failed: 0 });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(svc.rankedDisputes.markMessageSyncSucceeded).toHaveBeenCalledWith("t1");
  });
});
''', encoding="utf-8")
