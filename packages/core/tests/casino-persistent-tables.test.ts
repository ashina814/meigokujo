import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  CasinoStatus,
  ChipLedger,
  ChipTx,
  Departments,
  ETHER_ESCROW,
  Escrow,
  EventLog,
  FakeOpeningExternalAdapter,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  OpeningPlanner,
  OpeningReset,
  PersistentTableError,
  PersistentTables,
  RecoveryRegistry,
  Settings,
  TREASURY,
  classificationFor,
  deptAccount,
  escrowHolderFor,
  openDb,
  recoverCasino,
  registerDefaultTxTypes,
  writeCasinoOpeningConfig,
} from "../src/index.js";
import { TestFilesystemOpeningBackupAdapter } from "../src/casino/opening-backup.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(openFormal = true) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  if (openFormal) openFormally(chipTx, ledger);
  const escrow = new Escrow(db, chips, events);
  const chipAssets = new CasinoChipAssets(db, chips);
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, chipAssets);
  const status = new CasinoStatus(db);
  const reservations = new HouseReservations(db, chips, events);
  const settings = new Settings(db);
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => 1_700_000_000 });
  return { db, ledger, events, chipTx, chips, escrow, chipAssets, chipFlow, integrity, status, reservations, settings, persistentTables };
}

function setupOpening() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  const chipAssets = new CasinoChipAssets(db, chips);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, chipAssets);
  const status = new CasinoStatus(db);
  const settings = new Settings(db);
  const departments = new Departments(db, ledger);
  const planner = new OpeningPlanner({ db, ledger, chips, chipAssets, integrity, status, settings, departments });
  const reset = new OpeningReset({ db, ledger, chips, chipAssets, integrity, status, settings, departments });
  return { db, ledger, events, chipTx, chips, escrow, chipAssets, integrity, status, settings, departments, planner, reset };
}

function seedUser(ctx: ReturnType<typeof setup>, userId: string, amount = 10_000): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "t", idempotencyKey: `seed:${userId}` });
  ctx.chips.deposit(userId, amount, `deposit:${userId}`);
}

function seedLegacy(ctx: ReturnType<typeof setupOpening>): void {
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY,
    to: deptAccount("賭博場"),
    amount: 100_000,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: "seed:dept",
  });
  ctx.ledger.transfer({
    from: deptAccount("賭博場"),
    to: ETHER_ESCROW,
    amount: 30_000,
    type: "ether_house_fund",
    actor: "system:ether",
    approvedBy: "system:ether",
    idempotencyKey: "seed:legacy-house",
  });
  ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(HOUSE_HOLDER, 30_000);
  ctx.chipTx.captureLegacyOpening({ poolLand: ctx.ledger.balanceOf(ETHER_ESCROW), fromLedgerTxId: ctx.ledger.lastTransactionId() });
  ctx.departments.upsert("賭博場", "賭博場", null);
}

function configureOpeningReset(ctx: ReturnType<typeof setupOpening>, actorId = "admin"): void {
  writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, actorId);
  ctx.status.beginOpeningReset("test opening reset", actorId);
  const plan = ctx.planner.dryRun();
  const execution = ctx.reset.executionStore.acquire(plan.planHash, actorId, plan.snapshot.configuration).execution;
  ctx.status.bindOpeningExecutionOwner(execution.id, actorId);
}

function createPersistentSchemaWithRows(db: ReturnType<typeof openDb>): void {
  db.exec(`
    CREATE TABLE casino_tables (
      table_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      game_key TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      guild_id TEXT,
      channel_id TEXT,
      message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      state_changed_at INTEGER NOT NULL,
      started_at INTEGER,
      deadline_at INTEGER,
      expires_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 0,
      operation_id TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      failure_reason TEXT,
      dispute_reason TEXT,
      recovery_error TEXT
    );
    CREATE TABLE casino_table_participants (
      table_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      joined_at INTEGER NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      ready_state TEXT,
      approval_state TEXT,
      PRIMARY KEY (table_id, user_id),
      UNIQUE (table_id, seat)
    );
    INSERT INTO casino_tables (table_id, state, game_key, creator_id, operator_id, created_at, updated_at, state_changed_at, operation_id, request_fingerprint)
      VALUES ('legacy-table', 'recruiting', 'poker', 'alice', 'alice', 1, 1, 1, 'op-table', '{}');
    INSERT INTO casino_table_participants (table_id, user_id, seat, joined_at, operation_id, request_fingerprint)
      VALUES ('legacy-table', 'bob', 1, 1, 'op-seat', '{}');
  `);
}

function backupAdapter(): TestFilesystemOpeningBackupAdapter {
  const dir = mkdtempSync(join(tmpdir(), "pr20-persistent-tables-"));
  tempDirs.push(dir);
  return new TestFilesystemOpeningBackupAdapter(dir);
}

describe("PersistentTables", () => {
  it("constructor does not create schema and pre-reset writes fail closed", () => {
    const ctx = setup(false);
    expect(ctx.persistentTables.hasSchema()).toBe(false);
    expect(ctx.persistentTables.liveEscrowHolders()).toEqual([]);
    expect(() =>
      ctx.persistentTables.create({ tableId: "t1", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:create" }),
    ).toThrow(PersistentTableError);
    expect(ctx.persistentTables.hasSchema()).toBe(false);
  });

  it("persists tables/participants with idempotency, live-seat exclusivity, and CAS transitions", () => {
    const ctx = setup(true);
    const table = ctx.persistentTables.create({
      tableId: "t1",
      gameKey: "poker",
      creatorId: "alice",
      operatorId: "alice",
      guildId: "g",
      channelId: "c",
      messageId: "m",
      operationId: "op:create",
      deadlineAt: 1_700_000_100,
    });
    expect(table.state).toBe("recruiting");
    expect(ctx.persistentTables.create({
      tableId: "t1",
      gameKey: "poker",
      creatorId: "alice",
      operatorId: "alice",
      guildId: "g",
      channelId: "c",
      messageId: "m",
      operationId: "op:create",
      deadlineAt: 1_700_000_100,
    }).tableId).toBe("t1");
    expect(() => ctx.persistentTables.create({
      tableId: "t2",
      gameKey: "poker",
      creatorId: "alice",
      operatorId: "alice",
      operationId: "op:create-other",
    })).toThrow(PersistentTableError);

    const seat = ctx.persistentTables.join({ tableId: "t1", userId: "bob", seat: 1, operationId: "op:join" });
    expect(seat.seat).toBe(1);
    expect(() => ctx.persistentTables.join({ tableId: "t1", userId: "carol", seat: 1, operationId: "op:seat-taken" })).toThrow(PersistentTableError);

    const playing = ctx.persistentTables.transition({
      tableId: "t1",
      from: "recruiting",
      to: "playing",
      expectedRevision: 0,
      actor: "alice",
    });
    expect(playing.state).toBe("playing");
    expect(playing.revision).toBe(1);
    expect(() => ctx.persistentTables.transition({
      tableId: "t1",
      from: "recruiting",
      to: "cancelled",
      expectedRevision: 0,
      actor: "alice",
    })).toThrow(PersistentTableError);
    expect(new PersistentTables(ctx.db, ctx.events).get("t1")!.state).toBe("playing");
  });

  it("declares live escrow holders and fails closed on corrupt states", () => {
    const ctx = setup(true);
    ctx.persistentTables.create({ tableId: "t-live", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:live" });
    expect(ctx.persistentTables.liveEscrowHolders()).toEqual([escrowHolderFor("t-live")]);
    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare("UPDATE casino_tables SET state = 'alien_state' WHERE table_id = 't-live'").run();
    ctx.db.pragma("ignore_check_constraints = OFF");
    expect(() => ctx.persistentTables.liveEscrowHolders()).toThrow(PersistentTableError);
  });
});

describe("PersistentTables opening and recovery integration", () => {
  it("classifies PR20 tables, does not make them protected assets, resets rows in R6, and still blocks truly unknown casino tables", async () => {
    expect(classificationFor("casino_tables")?.resetPhase).toBe("R6");
    expect(classificationFor("casino_table_participants")?.resetPhase).toBe("R6");

    const ctx = setupOpening();
    seedLegacy(ctx);
    createPersistentSchemaWithRows(ctx.db);
    configureOpeningReset(ctx);

    const preflight = ctx.planner.dryRun();
    expect(preflight.unknownTables).not.toContain("casino_tables");
    expect(preflight.unknownTables).not.toContain("casino_table_participants");
    expect(preflight.blockers).toEqual([]);
    expect(preflight.protectedFindings.some((f) => f.sourceTable === "casino_tables" || f.sourceTable === "casino_table_participants")).toBe(false);

    const result = await ctx.reset.apply({ actorId: "admin", backup: backupAdapter(), external: new FakeOpeningExternalAdapter() });
    expect(result.status).toBe("completed");
    expect(result.postflight.ok).toBe(true);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tables").get() as { n: number }).n).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_table_participants").get() as { n: number }).n).toBe(0);

    ctx.db.exec("CREATE TABLE casino_truly_unknown_for_pr20 (id INTEGER)");
    const blocked = ctx.planner.dryRun();
    expect(blocked.unknownTables).toContain("casino_truly_unknown_for_pr20");
    expect(blocked.blockers.some((b) => b.code === "unknown_table")).toBe(true);
  });

  it("keeps persistent table escrow during startup recovery and does not mention concrete table names in recovery.ts", () => {
    const ctx = setup(true);
    seedUser(ctx, "alice");
    seedUser(ctx, "bob");
    ctx.persistentTables.create({ tableId: "t-live", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:t" });
    ctx.escrow.hold("t-live", "alice", 2_000, "poker", "op:hold-live");
    ctx.escrow.hold("orphan", "bob", 1_000, "poker", "op:hold-orphan");
    const registry = new RecoveryRegistry();
    registry.register({ type: "table", listLiveEscrowHolders: () => ctx.persistentTables.liveEscrowHolders() });

    const result = recoverCasino({
      db: ctx.db,
      status: ctx.status,
      integrity: ctx.integrity,
      chipTx: ctx.chipTx,
      escrow: ctx.escrow,
      reservations: ctx.reservations,
      registry,
      events: ctx.events,
      chipFlow: ctx.chipFlow,
      persistentTableRestore: { restored: 0, replaced: 0, disputed: 0, failed: [] },
    });
    expect(result.outcome).toBe("opened");
    expect(ctx.escrow.poolOf("t-live")).toBe(2_000);
    expect(ctx.escrow.list("orphan")).toEqual([]);
  });

  it("halts before S12 when S11 table message restore reports failures", () => {
    const ctx = setup(true);
    const registry = new RecoveryRegistry();
    const result = recoverCasino({
      db: ctx.db,
      status: ctx.status,
      integrity: ctx.integrity,
      chipTx: ctx.chipTx,
      escrow: ctx.escrow,
      reservations: ctx.reservations,
      registry,
      events: ctx.events,
      chipFlow: ctx.chipFlow,
      persistentTableRestore: { restored: 0, replaced: 0, disputed: 0, failed: [{ tableId: "t1", error: "Discord API unavailable" }] },
    });
    expect(result.outcome).toBe("source_failed");
    expect(result.steps).toContain("S11:persistent_table_restore");
    expect(result.steps).not.toContain("S12:再開");
    expect(ctx.status.current().status).toBe("recovery_halt");
  });
});
