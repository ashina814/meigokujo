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
  Ledger,
  HouseReservations,
  PersistentTables,
  RankedDisputes,
  RankedTables,
  TREASURY,
  escrowHolderFor,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "ranked-ready-runner.ts");
const APPROVAL_RUNNER = join(HERE, "helpers", "ranked-approval-runner.ts");
const DISPUTE_RUNNER = join(HERE, "helpers", "ranked-dispute-runner.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ReadyRunnerResult {
  ok: boolean;
  state?: string;
  revision?: number;
  code?: string;
  error?: string;
}

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-ranked-ready-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(1_700_000_000);
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
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, { now: () => 1_700_000_000, reservations, disputes });
  return { dbPath, db, ledger, chips, rankedTables, reservations, disputes };
}

function seedUser(ctx: ReturnType<typeof setupFileDb>, userId: string, amount = 30_000): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${userId}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}`);
}

function spawnReadyRunner(dbPath: string, userId: string, startAt: number): Promise<ReadyRunnerResult> {
  return new Promise<ReadyRunnerResult>((resolve, reject) => {
    const input = JSON.stringify({ dbPath, tableId: "t1", userId, operationId: `ready:${userId}`, startAt });
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, input], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line) as ReadyRunnerResult);
    });
  });
}

function spawnApprovalRunner(dbPath: string, userId: string, resultHash: string, startAt: number): Promise<ReadyRunnerResult> {
  return new Promise<ReadyRunnerResult>((resolve, reject) => {
    const input = JSON.stringify({ dbPath, tableId: "t1", userId, resultHash, operationId: `approve:${userId}`, startAt });
    const child = spawn(process.execPath, ["--import", "tsx", APPROVAL_RUNNER, input], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line) as ReadyRunnerResult);
    });
  });
}

function spawnDisputeRunner(
  dbPath: string,
  operation: "deadline" | "refund",
  operationId: string,
  startAt: number,
): Promise<ReadyRunnerResult & { result?: { closed: number; autoRefunded: number; failed: number }; resolutionKind?: string }> {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({
      dbPath,
      tableId: "t1",
      operation,
      operationId,
      actor: "judge",
      now: 1_700_259_200,
      startAt,
    });
    const child = spawn(process.execPath, ["--import", "tsx", DISPUTE_RUNNER, input], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line) as ReadyRunnerResult & { result?: { closed: number; autoRefunded: number; failed: number }; resolutionKind?: string });
    });
  });
}

describe("PR21 ranked table cross-process readiness", () => {
  it("commits the table fee exactly once when the final ready races from another process", async () => {
    const ctx = setupFileDb();
    ctx.rankedTables.create({ tableId: "t1", gameKey: "gf", baseAmount: 5_000, creatorId: "operator", operatorId: "operator", operationId: "create:t1" });
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.db.close();

    const startAt = Date.now() + 2_000;
    const results = await Promise.all([
      spawnReadyRunner(ctx.dbPath, "alice", startAt),
      spawnReadyRunner(ctx.dbPath, "bob", startAt),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.some((result) => result.state === "playing")).toBe(true);

    const db = openDb(ctx.dbPath);
    expect((db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string }).state).toBe("playing");
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(HOUSE_HOLDER) as { amount: number }).amount).toBe(300);
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(10_000);
    expect(
      db.prepare("SELECT amount FROM casino_escrow WHERE session_id='t1' ORDER BY user_id").all().map((row) => (row as { amount: number }).amount),
    ).toEqual([5_000, 5_000]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE kind='table_start'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_type='table_start'").get() as { n: number }).n).toBe(1);
    db.close();
  }, 60_000);

  it("settles exactly once when the final approvals race from separate processes", async () => {
    const ctx = setupFileDb();
    ctx.rankedTables.create({ tableId: "t1", gameKey: "gf", baseAmount: 5_000, creatorId: "operator", operatorId: "operator", operationId: "create:t1" });
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    const resultHash = submitted.result!.hash;
    ctx.db.close();

    const startAt = Date.now() + 2_000;
    const results = await Promise.all([
      spawnApprovalRunner(ctx.dbPath, "alice", resultHash, startAt),
      spawnApprovalRunner(ctx.dbPath, "bob", resultHash, startAt),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.some((result) => result.state === "settled")).toBe(true);

    const db = openDb(ctx.dbPath);
    expect((db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string }).state).toBe("settled");
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(0);
    expect(db.prepare("SELECT * FROM casino_escrow WHERE session_id='t1'").all()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE kind='table_settle'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_metric_events WHERE event_type='table_settle'").get() as { n: number }).n).toBe(1);
    db.close();
  }, 60_000);

  it("keeps dispute resolution atomic when evidence timeout races manual arbitration across processes", async () => {
    const ctx = setupFileDb();
    ctx.rankedTables.create({ tableId: "t1", gameKey: "gf", baseAmount: 5_000, creatorId: "operator", operatorId: "operator", operationId: "create:t1" });
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
    ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
    ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
    const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
    ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
    ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "judge", assignedBy: "owner", operationId: "assign:judge" });
    ctx.db.close();

    const startAt = Date.now() + 2_000;
    const results = await Promise.all([
      spawnDisputeRunner(ctx.dbPath, "deadline", "deadline:t1", startAt),
      spawnDisputeRunner(ctx.dbPath, "refund", "manual-refund:t1", startAt),
    ]);

    expect(results.some((result) => result.ok)).toBe(true);

    const db = openDb(ctx.dbPath);
    expect(["cancelled", "cancelled_by_admin"]).toContain((db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string }).state);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_table_disputes WHERE table_id='t1' AND resolved_at IS NOT NULL").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(0);
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(HOUSE_HOLDER) as { amount: number }).amount).toBe(300);
    expect(db.prepare("SELECT * FROM casino_escrow WHERE session_id='t1'").all()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:%'").get() as { n: number }).n).toBe(1);
    db.close();
  }, 60_000);
});
