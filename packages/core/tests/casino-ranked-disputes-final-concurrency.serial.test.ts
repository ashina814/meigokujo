import { spawn } from "node:child_process";
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
