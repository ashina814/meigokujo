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
  recoverCasinoAsync,
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

function createRiskLimitSchemaWithRows(db: ReturnType<typeof openDb>): void {
  db.exec(`
    CREATE TABLE casino_daily_risk_days (
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      day_start_at INTEGER NOT NULL,
      opening_holdings INTEGER NOT NULL,
      limit_bps INTEGER NOT NULL,
      loss_cap INTEGER NOT NULL,
      net_signed INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, day_key)
    );
    CREATE TABLE casino_daily_risk_events (
      event_key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      net_signed INTEGER NOT NULL,
      payload_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE casino_solo_risk_starts (
      operation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      game TEXT NOT NULL,
      bet INTEGER NOT NULL,
      max_player_loss INTEGER NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE casino_ranked_open_history (
      operation_id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL UNIQUE,
      tier_key TEXT NOT NULL,
      base_amount INTEGER NOT NULL,
      authority TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO casino_daily_risk_days VALUES ('alice', '1', 86400, 10000, 3000, 3000, -100, 1, 1);
    INSERT INTO casino_daily_risk_events VALUES ('e1', 'alice', '1', 'solo_result', 'op1', 'op1', -100, '{}', 1);
    INSERT INTO casino_solo_risk_starts VALUES ('op1', 'alice', '1', 'slots', 100, 100, '{}', 1);
    INSERT INTO casino_ranked_open_history VALUES ('create:t', 't', 'middle', 5000, 'employee', '{}', 1);
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
    expect(ctx.persistentTables.create({
      tableId: "t2",
      gameKey: "poker",
      creatorId: "alice",
      operatorId: "alice",
      operationId: "op:create-other",
    }).tableId).toBe("t2");

    const seat = ctx.persistentTables.join({ tableId: "t1", userId: "bob", seat: 1, operationId: "op:join" });
    expect(seat.seat).toBe(1);
    expect(() => ctx.persistentTables.join({ tableId: "t1", userId: "carol", seat: 1, operationId: "op:seat-taken" })).toThrow(PersistentTableError);

    expect(() => ctx.persistentTables.create({
      tableId: "t3",
      gameKey: "poker",
      creatorId: "bob",
      operatorId: "alice",
      operationId: "op:create-participant-blocked",
    })).toThrow(PersistentTableError);

    const playing = ctx.persistentTables.transition({
      tableId: "t1",
      from: "recruiting",
      to: "ready_check",
      expectedRevision: 0,
      actor: "alice",
    });
    expect(playing.state).toBe("ready_check");
    expect(playing.revision).toBe(1);
    expect(() => ctx.persistentTables.transition({
      tableId: "t1",
      from: "recruiting",
      to: "cancelled",
      expectedRevision: 0,
      actor: "alice",
    })).toThrow(PersistentTableError);
    expect(new PersistentTables(ctx.db, ctx.events).get("t1")!.state).toBe("ready_check");
  });

  it("classifies partial or corrupt schemas as invalid while both absent means no live tables", () => {
    const ctx = setup(true);
    expect(ctx.persistentTables.liveEscrowHolders()).toEqual([]);

    ctx.db.exec("CREATE TABLE casino_tables (table_id TEXT PRIMARY KEY)");
    expect(() => ctx.persistentTables.liveEscrowHolders()).toThrow(PersistentTableError);

    const ctx2 = setup(true);
    ctx2.db.exec("CREATE TABLE casino_table_participants (table_id TEXT)");
    expect(() => ctx2.persistentTables.listLiveTables()).toThrow(PersistentTableError);

    const ctx3 = setup(true);
    ctx3.db.exec(`
      CREATE TABLE casino_tables (
        table_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        creator_id TEXT NOT NULL
      );
      CREATE TABLE casino_table_participants (
        table_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        seat INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        ready_state TEXT,
        approval_state TEXT
      );
    `);
    expect(() => ctx3.persistentTables.listLiveTables()).toThrow(PersistentTableError);
  });

  it("returns empty instead of throwing for every read path when the schema is absent", () => {
    // 卓スキーマ未作成のDBでも読み取り系は例外を投げず「無い」と答える。
    // liveTableForParticipant だけこのガードが抜けていて本番で例外になり、
    // リポジトリへ戻っていないホットフィックスが本番に残っていた。
    // 読み取り経路をまとめて押さえ、1つでも抜けたらここで落とす。
    const ctx = setup(true);
    const pt = ctx.persistentTables;
    expect(pt.liveEscrowHolders()).toEqual([]);
    expect(pt.listLiveTables()).toEqual([]);
    expect(pt.listRecentTables()).toEqual([]);
    expect(pt.listDueTables()).toEqual([]);
    expect(pt.get("t1")).toBeNull();
    expect(pt.participants("t1")).toEqual([]);
    expect(pt.liveTableForParticipant("alice")).toBeNull();
    // 参加チェックはソロ卓に着く前の常時経路なので、ここが投げると賭場全体が止まる
    expect(pt.participantHasLiveTable("alice")).toBe(false);
  });

  it("fails closed on malformed rows without deriving escrow holders from bad ids", () => {
    const ctx = setup(true);
    createPersistentSchemaWithRows(ctx.db);
    ctx.db.prepare("UPDATE casino_tables SET table_id = '' WHERE table_id = 'legacy-table'").run();
    expect(() => ctx.persistentTables.liveEscrowHolders()).toThrow(PersistentTableError);
  });

  it("uses resolved tableId in create idempotency fingerprints", () => {
    const ctx = setup(true);
    const first = ctx.persistentTables.create({ tableId: "t1", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:same" });
    expect(ctx.persistentTables.create({ tableId: "t1", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:same" })).toEqual(first);
    expect(() =>
      ctx.persistentTables.create({ tableId: "t2", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:same" }),
    ).toThrow(PersistentTableError);
    expect(() =>
      ctx.persistentTables.create({ tableId: "t1", gameKey: "chinchiro", creatorId: "alice", operatorId: "alice", operationId: "op:same" }),
    ).toThrow(PersistentTableError);
  });

  it("allows new joins only while recruiting but preserves successful join replays", () => {
    const ctx = setup(true);
    ctx.persistentTables.create({ tableId: "t-recruiting", gameKey: "poker", creatorId: "owner1", operatorId: "owner1", operationId: "op:create:recruiting" });
    const replayable = ctx.persistentTables.join({ tableId: "t-recruiting", userId: "alice", seat: 1, operationId: "op:join:alice" });
    expect(replayable.seat).toBe(1);

    const ready = ctx.persistentTables.transition({
      tableId: "t-recruiting",
      from: "recruiting",
      to: "ready_check",
      expectedRevision: 0,
      actor: "owner1",
    });
    const playing = ctx.persistentTables.transition({
      tableId: "t-recruiting",
      from: "ready_check",
      to: "playing",
      expectedRevision: ready.revision,
      actor: "owner1",
    });
    expect(ctx.persistentTables.join({ tableId: "t-recruiting", userId: "alice", seat: 1, operationId: "op:join:alice" })).toEqual(replayable);
    expect(() => ctx.persistentTables.join({ tableId: "t-recruiting", userId: "bob", seat: 2, operationId: "op:join:bob" })).toThrow(PersistentTableError);

    const pending = ctx.persistentTables.transition({
      tableId: "t-recruiting",
      from: "playing",
      to: "pending_approval",
      expectedRevision: playing.revision,
      actor: "owner1",
    });
    expect(() => ctx.persistentTables.join({ tableId: "t-recruiting", userId: "carol", seat: 3, operationId: "op:join:carol" })).toThrow(PersistentTableError);

    ctx.persistentTables.create({ tableId: "t-ready", gameKey: "poker", creatorId: "owner2", operatorId: "owner2", operationId: "op:create:ready" });
    ctx.persistentTables.transition({ tableId: "t-ready", from: "recruiting", to: "ready_check", expectedRevision: 0, actor: "owner2" });
    expect(() => ctx.persistentTables.join({ tableId: "t-ready", userId: "dave", seat: 1, operationId: "op:join:dave" })).toThrow(PersistentTableError);

    ctx.persistentTables.create({ tableId: "t-disputed", gameKey: "poker", creatorId: "owner3", operatorId: "owner3", operationId: "op:create:disputed" });
    ctx.persistentTables.transition({ tableId: "t-disputed", from: "recruiting", to: "disputed", expectedRevision: 0, actor: "owner3" });
    expect(() => ctx.persistentTables.join({ tableId: "t-disputed", userId: "erin", seat: 1, operationId: "op:join:erin" })).toThrow(PersistentTableError);

    ctx.persistentTables.create({ tableId: "t-cancelled", gameKey: "poker", creatorId: "owner4", operatorId: "owner4", operationId: "op:create:cancelled" });
    ctx.persistentTables.transition({ tableId: "t-cancelled", from: "recruiting", to: "cancelled", expectedRevision: 0, actor: "owner4" });
    expect(() => ctx.persistentTables.join({ tableId: "t-cancelled", userId: "frank", seat: 1, operationId: "op:join:frank" })).toThrow(PersistentTableError);

    ctx.persistentTables.create({ tableId: "t-settled", gameKey: "poker", creatorId: "owner5", operatorId: "owner5", operationId: "op:create:settled" });
    const settledReady = ctx.persistentTables.transition({ tableId: "t-settled", from: "recruiting", to: "ready_check", expectedRevision: 0, actor: "owner5" });
    const settledPlaying = ctx.persistentTables.transition({ tableId: "t-settled", from: "ready_check", to: "playing", expectedRevision: settledReady.revision, actor: "owner5" });
    const settledPending = ctx.persistentTables.transition({ tableId: "t-settled", from: "playing", to: "pending_approval", expectedRevision: settledPlaying.revision, actor: "owner5" });
    ctx.persistentTables.transition({ tableId: "t-settled", from: "pending_approval", to: "settled", expectedRevision: settledPending.revision, actor: "owner5" });
    expect(() => ctx.persistentTables.join({ tableId: "t-settled", userId: "grace", seat: 1, operationId: "op:join:grace" })).toThrow(PersistentTableError);

    expect(pending.state).toBe("pending_approval");
  });

  it("enforces the table transition graph and stale revisions", () => {
    const ctx = setup(true);
    ctx.persistentTables.create({ tableId: "t1", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:t1" });
    const ready = ctx.persistentTables.transition({ tableId: "t1", from: "recruiting", to: "ready_check", expectedRevision: 0, actor: "alice" });
    expect(ready.state).toBe("ready_check");
    expect(ctx.persistentTables.transition({ tableId: "t1", from: "ready_check", to: "ready_check", expectedRevision: 1, actor: "alice" }).revision).toBe(1);
    const playing = ctx.persistentTables.transition({ tableId: "t1", from: "ready_check", to: "playing", expectedRevision: 1, actor: "alice" });
    expect(playing.revision).toBe(2);
    expect(() => ctx.persistentTables.transition({ tableId: "t1", from: "playing", to: "recruiting", expectedRevision: 2, actor: "alice" })).toThrow(PersistentTableError);
    expect(() => ctx.persistentTables.transition({ tableId: "t1", from: "playing", to: "pending_approval", expectedRevision: 1, actor: "alice" })).toThrow(PersistentTableError);
    const pending = ctx.persistentTables.transition({ tableId: "t1", from: "playing", to: "pending_approval", expectedRevision: 2, actor: "alice" });
    expect(() => ctx.persistentTables.transition({ tableId: "t1", from: "pending_approval", to: "playing", expectedRevision: pending.revision, actor: "alice" })).toThrow(PersistentTableError);
    const disputedCtx = setup(true);
    disputedCtx.persistentTables.create({ tableId: "t2", gameKey: "poker", creatorId: "alice", operatorId: "alice", operationId: "op:t2" });
    const ready2 = disputedCtx.persistentTables.transition({ tableId: "t2", from: "recruiting", to: "ready_check", expectedRevision: 0, actor: "alice" });
    const playing2 = disputedCtx.persistentTables.transition({ tableId: "t2", from: "ready_check", to: "playing", expectedRevision: ready2.revision, actor: "alice" });
    const pending2 = disputedCtx.persistentTables.transition({ tableId: "t2", from: "playing", to: "pending_approval", expectedRevision: playing2.revision, actor: "alice" });
    expect(disputedCtx.persistentTables.transition({ tableId: "t2", from: "pending_approval", to: "disputed", expectedRevision: pending2.revision, actor: "alice" }).state).toBe("disputed");
    const settled = ctx.persistentTables.transition({ tableId: "t1", from: "pending_approval", to: "settled", expectedRevision: pending.revision, actor: "alice" });
    expect(() => ctx.persistentTables.transition({ tableId: "t1", from: "settled", to: "playing", expectedRevision: settled.revision, actor: "alice" })).toThrow(PersistentTableError);
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

  it("classifies PR23 risk-limit tables as resettable metadata and still blocks truly unknown casino tables", async () => {
    for (const table of ["casino_daily_risk_days", "casino_daily_risk_events", "casino_solo_risk_starts", "casino_ranked_open_history"]) {
      expect(classificationFor(table)?.kind).toBe("optional_feature");
      expect(classificationFor(table)?.resetPhase).toBe("R6");
      expect(classificationFor(table)?.preserve).toBe(false);
    }

    const ctx = setupOpening();
    seedLegacy(ctx);
    createRiskLimitSchemaWithRows(ctx.db);
    configureOpeningReset(ctx);

    const preflight = ctx.planner.dryRun();
    expect(preflight.unknownTables).not.toContain("casino_daily_risk_days");
    expect(preflight.unknownTables).not.toContain("casino_daily_risk_events");
    expect(preflight.unknownTables).not.toContain("casino_solo_risk_starts");
    expect(preflight.unknownTables).not.toContain("casino_ranked_open_history");
    expect(preflight.blockers).toEqual([]);
    expect(preflight.protectedFindings.some((f) => f.sourceTable.startsWith("casino_daily_risk_") || f.sourceTable === "casino_solo_risk_starts" || f.sourceTable === "casino_ranked_open_history")).toBe(false);

    const result = await ctx.reset.apply({ actorId: "admin", backup: backupAdapter(), external: new FakeOpeningExternalAdapter() });
    expect(result.status).toBe("completed");
    expect(result.postflight.ok).toBe(true);
    for (const table of ["casino_daily_risk_days", "casino_daily_risk_events", "casino_solo_risk_starts", "casino_ranked_open_history"]) {
      expect((ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }

    ctx.db.exec("CREATE TABLE casino_unknown_for_pr23 (id INTEGER)");
    const blocked = ctx.planner.dryRun();
    expect(blocked.unknownTables).toContain("casino_unknown_for_pr23");
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
  it("turns partial persistent-table schema into source_failed without moving escrow or user funds", () => {
    const ctx = setup(true);
    seedUser(ctx, "alice", 10_000);
    ctx.db.exec("CREATE TABLE casino_tables (table_id TEXT PRIMARY KEY)");
    ctx.escrow.hold("t-live", "alice", 2_000, "poker", "op:partial-hold");
    const beforeEscrow = ctx.escrow.poolOf("t-live");
    const beforeAliceChips = ctx.chips.balanceOf("alice");
    const beforeAliceLand = ctx.ledger.balanceOf("user:alice");
    const beforeHolderChips = ctx.chips.balanceOf(escrowHolderFor("t-live"));
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

    expect(result.outcome).toBe("source_failed");
    expect(ctx.escrow.poolOf("t-live")).toBe(beforeEscrow);
    expect(ctx.chips.balanceOf("alice")).toBe(beforeAliceChips);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(beforeAliceLand);
    expect(ctx.chips.balanceOf(escrowHolderFor("t-live"))).toBe(beforeHolderChips);
  });

  it("awaits S11 after S10 while casino is still closed and skips S11 for held statuses", async () => {
    const ctx = setup(true);
    let statusDuringS11 = "";
    const result = await recoverCasinoAsync({
      db: ctx.db,
      status: ctx.status,
      integrity: ctx.integrity,
      chipTx: ctx.chipTx,
      escrow: ctx.escrow,
      reservations: ctx.reservations,
      registry: new RecoveryRegistry(),
      events: ctx.events,
      chipFlow: ctx.chipFlow,
      persistentTableRestore: async () => {
        statusDuringS11 = ctx.status.current().status;
        return { restored: 0, replaced: 0, disputed: 0, failed: [] };
      },
    });
    expect(statusDuringS11).toBe("startup_check");
    expect(result.outcome).toBe("opened");
    expect(result.steps.indexOf("S10:自由チップ返還")).toBeLessThan(result.steps.indexOf("S11:persistent_table_restore"));
    expect(result.steps.indexOf("S11:persistent_table_restore")).toBeLessThan(result.steps.indexOf("S12:後検"));

    const held = setup(true);
    held.status.haltManually("maintenance", "operator");
    let called = false;
    const heldResult = await recoverCasinoAsync({
      db: held.db,
      status: held.status,
      integrity: held.integrity,
      chipTx: held.chipTx,
      escrow: held.escrow,
      reservations: held.reservations,
      registry: new RecoveryRegistry(),
      events: held.events,
      chipFlow: held.chipFlow,
      persistentTableRestore: async () => {
        called = true;
        return { restored: 0, replaced: 0, disputed: 0, failed: [] };
      },
    });
    expect(heldResult.outcome).toBe("held");
    expect(called).toBe(false);
  });

  it("keeps S11 rejected providers fail-closed before S12", async () => {
    const ctx = setup(true);
    const result = await recoverCasinoAsync({
      db: ctx.db,
      status: ctx.status,
      integrity: ctx.integrity,
      chipTx: ctx.chipTx,
      escrow: ctx.escrow,
      reservations: ctx.reservations,
      registry: new RecoveryRegistry(),
      events: ctx.events,
      chipFlow: ctx.chipFlow,
      persistentTableRestore: async () => {
        throw new Error("schema read failed");
      },
    });
    expect(result.outcome).toBe("source_failed");
    expect(result.reason).toContain("schema read failed");
    expect(result.steps).toContain("S11:persistent_table_restore");
    expect(result.steps).not.toContain("S12:再開");
  });
});
