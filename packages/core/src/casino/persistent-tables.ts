import type Database from "better-sqlite3";
import type { EventLog } from "../events/service.js";
import { canonicalStringify } from "./opening-canonical.js";
import { escrowHolderFor } from "./escrow.js";
import type { OpeningPhase } from "./chip-tx.js";

export const PERSISTENT_TABLE_STATES = [
  "recruiting",
  "ready_check",
  "playing",
  "pending_approval",
  "settled",
  "disputed",
  "cancelled",
  "cancelled_by_admin",
  "cancelled_fault",
] as const;

export type PersistentTableState = (typeof PERSISTENT_TABLE_STATES)[number];

export const PERSISTENT_TABLE_LIVE_STATES: ReadonlySet<PersistentTableState> = new Set([
  "recruiting",
  "ready_check",
  "playing",
  "pending_approval",
  "disputed",
]);

export const PERSISTENT_TABLE_TERMINAL_STATES: ReadonlySet<PersistentTableState> = new Set([
  "settled",
  "cancelled",
  "cancelled_by_admin",
  "cancelled_fault",
]);

const ALL_STATES = new Set<string>(PERSISTENT_TABLE_STATES);
const MAX_ID_LENGTH = 200;
const MAX_GAME_KEY_LENGTH = 80;
const MAX_REASON_LENGTH = 500;

const REQUIRED_TABLE_COLUMNS = [
  "table_id",
  "state",
  "game_key",
  "creator_id",
  "operator_id",
  "guild_id",
  "channel_id",
  "message_id",
  "created_at",
  "updated_at",
  "state_changed_at",
  "started_at",
  "deadline_at",
  "expires_at",
  "revision",
  "operation_id",
  "request_fingerprint",
  "failure_reason",
  "dispute_reason",
  "recovery_error",
] as const;

const REQUIRED_PARTICIPANT_COLUMNS = [
  "table_id",
  "user_id",
  "seat",
  "joined_at",
  "operation_id",
  "request_fingerprint",
  "ready_state",
  "approval_state",
] as const;

type PersistentTableSchemaState = "none" | "complete" | "invalid";

export const ALLOWED_TABLE_TRANSITIONS: Readonly<Record<PersistentTableState, readonly PersistentTableState[]>> = {
  recruiting: ["recruiting", "ready_check", "cancelled", "cancelled_by_admin", "cancelled_fault", "disputed"],
  ready_check: ["ready_check", "recruiting", "playing", "cancelled", "cancelled_by_admin", "cancelled_fault", "disputed"],
  playing: ["playing", "pending_approval", "cancelled_by_admin", "cancelled_fault", "disputed"],
  pending_approval: ["pending_approval", "settled", "playing", "cancelled_by_admin", "cancelled_fault", "disputed"],
  disputed: ["disputed", "settled", "cancelled_by_admin", "cancelled_fault"],
  settled: ["settled"],
  cancelled: ["cancelled"],
  cancelled_by_admin: ["cancelled_by_admin"],
  cancelled_fault: ["cancelled_fault"],
};

export type PersistentTableErrorCode =
  | "ERR_CASINO_OPENING_NOT_COMPLETE"
  | "ERR_PERSISTENT_TABLE_SCHEMA_INVALID"
  | "ERR_OPERATION_CONFLICT"
  | "ERR_TABLE_NOT_FOUND"
  | "ERR_TABLE_NOT_LIVE"
  | "ERR_TABLE_STATE_INVALID"
  | "ERR_CREATOR_ALREADY_IN_LIVE_TABLE"
  | "ERR_PARTICIPANT_ALREADY_IN_LIVE_TABLE"
  | "ERR_PARTICIPANT_ALREADY_JOINED"
  | "ERR_SEAT_TAKEN"
  | "ERR_STALE_TABLE"
  | "ERR_INVALID_TABLE_TRANSITION";

export class PersistentTableError extends Error {
  constructor(
    readonly code: PersistentTableErrorCode,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PersistentTableError";
  }
}

export interface PersistentTablesOptions {
  openingPhase?: () => OpeningPhase;
  now?: () => number;
}

export interface PersistentTableRow {
  tableId: string;
  state: PersistentTableState;
  gameKey: string;
  creatorId: string;
  operatorId: string;
  guildId: string | null;
  channelId: string | null;
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
  stateChangedAt: number;
  startedAt: number | null;
  deadlineAt: number | null;
  expiresAt: number | null;
  revision: number;
  operationId: string;
  requestFingerprint: string;
  failureReason: string | null;
  disputeReason: string | null;
  recoveryError: string | null;
}

export interface PersistentTableParticipantRow {
  tableId: string;
  userId: string;
  seat: number;
  joinedAt: number;
  operationId: string;
  requestFingerprint: string;
  readyState: string | null;
  approvalState: string | null;
}

export interface CreatePersistentTableInput {
  tableId?: string;
  gameKey: string;
  creatorId: string;
  operatorId: string;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  operationId: string;
  deadlineAt?: number | null;
  expiresAt?: number | null;
}

export interface JoinPersistentTableInput {
  tableId: string;
  userId: string;
  seat: number;
  operationId: string;
}

export interface TransitionPersistentTableInput {
  tableId: string;
  from: PersistentTableState;
  to: PersistentTableState;
  expectedRevision: number;
  actor: string;
  reason?: string | null;
}

export class PersistentTables {
  private readonly now: () => number;
  private readonly openingPhase: () => OpeningPhase;

  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
    options: PersistentTablesOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.openingPhase = options.openingPhase ?? (() => "formal");
  }

  hasSchema(): boolean {
    return this.schemaState() === "complete";
  }

  create(input: CreatePersistentTableInput): PersistentTableRow {
    const operationId = requiredString(input.operationId, "operation_id");
    const tableId = requiredString(input.tableId ?? tableIdFromOperation(operationId), "table_id");
    const gameKey = requiredString(input.gameKey, "game_key", MAX_GAME_KEY_LENGTH);
    const creatorId = requiredString(input.creatorId, "creator_id");
    const operatorId = requiredString(input.operatorId, "operator_id");
    const guildId = optionalString(input.guildId ?? null, "guild_id");
    const channelId = optionalString(input.channelId ?? null, "channel_id");
    const messageId = optionalString(input.messageId ?? null, "message_id");
    const deadlineAt = nullableNonnegativeInt(input.deadlineAt ?? null, "deadline_at");
    const expiresAt = nullableNonnegativeInt(input.expiresAt ?? null, "expires_at");
    const fingerprint = canonicalStringify({
      tableId,
      gameKey,
      creatorId,
      operatorId,
      guildId,
      channelId,
      messageId,
      deadlineAt,
      expiresAt,
    });
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const existing = this.findByOperation(operationId);
      if (existing) {
        if (existing.requestFingerprint === fingerprint) return existing;
        throw new PersistentTableError("ERR_OPERATION_CONFLICT", "operation_id was replayed with different table data", {
          operationId,
        });
      }
      const now = this.now();
      if (this.participantHasLiveTable(creatorId)) {
        throw new PersistentTableError("ERR_CREATOR_ALREADY_IN_LIVE_TABLE", "creator already belongs to a live table", {
          creatorId,
        });
      }
      try {
        this.db
          .prepare(
            `INSERT INTO casino_tables (
              table_id, state, game_key, creator_id, operator_id, guild_id, channel_id, message_id,
              created_at, updated_at, state_changed_at, started_at, deadline_at, expires_at,
              revision, operation_id, request_fingerprint, failure_reason, dispute_reason, recovery_error
            ) VALUES (?, 'recruiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, NULL, NULL, NULL)`,
          )
          .run(
            tableId,
            gameKey,
            creatorId,
            operatorId,
            guildId,
            channelId,
            messageId,
            now,
            now,
            now,
            deadlineAt,
            expiresAt,
            operationId,
            fingerprint,
          );
      } catch (e) {
        throw mapSqliteConflict(e, "table", tableId);
      }
      this.events.log("casino_table_created", {
        actor: operatorId,
        target: tableId,
        payload: { gameKey, creatorId },
      });
      return this.get(tableId)!;
    });
    return tx.immediate();
  }

  join(input: JoinPersistentTableInput): PersistentTableParticipantRow {
    const tableId = requiredString(input.tableId, "table_id");
    const userId = requiredString(input.userId, "user_id");
    const seat = positiveInt(input.seat, "seat");
    const operationId = requiredString(input.operationId, "operation_id");
    const fingerprint = canonicalStringify({
      tableId,
      userId,
      seat,
    });
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const replay = this.findParticipantByOperation(operationId);
      if (replay) {
        if (replay.requestFingerprint === fingerprint) return replay;
        throw new PersistentTableError("ERR_OPERATION_CONFLICT", "operation_id was replayed with different participant data", {
          operationId,
        });
      }
      const table = this.get(tableId);
      if (!table) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
      assertKnownState(table.state);
      if (!PERSISTENT_TABLE_LIVE_STATES.has(table.state)) {
        throw new PersistentTableError("ERR_TABLE_NOT_LIVE", "persistent table is not joinable", { tableId, state: table.state });
      }
      const existing = this.findParticipant(tableId, userId);
      if (existing) {
        if (existing.seat === seat) return existing;
        throw new PersistentTableError("ERR_PARTICIPANT_ALREADY_JOINED", "user is already seated at this table", {
          tableId,
          userId,
        });
      }
      if (this.participantHasLiveTable(userId)) {
        throw new PersistentTableError("ERR_PARTICIPANT_ALREADY_IN_LIVE_TABLE", "user already belongs to another live table", {
          userId,
        });
      }
      const now = this.now();
      try {
        this.db
          .prepare(
            `INSERT INTO casino_table_participants (
              table_id, user_id, seat, joined_at, operation_id, request_fingerprint, ready_state, approval_state
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
          )
          .run(tableId, userId, seat, now, operationId, fingerprint);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes("casino_table_participants.table_id, casino_table_participants.seat")) {
          throw new PersistentTableError("ERR_SEAT_TAKEN", "table seat is already occupied", {
            tableId,
            seat,
          });
        }
        throw mapSqliteConflict(e, "participant", tableId);
      }
      this.events.log("casino_table_joined", {
        actor: userId,
        target: tableId,
        payload: { seat },
      });
      return this.findParticipant(tableId, userId)!;
    });
    return tx.immediate();
  }

  transition(input: TransitionPersistentTableInput): PersistentTableRow {
    const tableId = requiredString(input.tableId, "table_id");
    const from = input.from;
    const to = input.to;
    assertKnownState(from);
    assertKnownState(to);
    const expectedRevision = requiredNonnegativeInt(input.expectedRevision, "expected_revision");
    const actor = requiredString(input.actor, "actor");
    const reason = optionalString(input.reason ?? null, "reason", MAX_REASON_LENGTH);
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const current = this.get(tableId);
      if (!current) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
      assertKnownState(current.state);
      if (current.state !== from || current.revision !== expectedRevision) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision is stale", {
          tableId,
          expectedState: from,
          actualState: current.state,
          expectedRevision,
          actualRevision: current.revision,
        });
      }
      if (!ALLOWED_TABLE_TRANSITIONS[current.state].includes(to)) {
        throw new PersistentTableError("ERR_INVALID_TABLE_TRANSITION", "persistent table transition is not allowed", {
          tableId,
          from: current.state,
          to,
        });
      }
      if (to === current.state) return current;
      const now = this.now();
      const startedAt = to === "playing" && current.startedAt === null ? now : current.startedAt;
      const changed = this.db
        .prepare(
          `UPDATE casino_tables
             SET state = ?, revision = revision + 1, updated_at = ?, state_changed_at = ?,
                 started_at = ?, failure_reason = CASE WHEN ? IS NULL THEN failure_reason ELSE ? END
           WHERE table_id = ? AND state = ? AND revision = ?`,
        )
        .run(to, now, now, startedAt, reason, reason, tableId, from, expectedRevision);
      if (changed.changes !== 1) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision changed during transition", {
          tableId,
        });
      }
      this.events.log("casino_table_state_changed", {
        actor,
        target: tableId,
        payload: { from, to, revision: expectedRevision + 1, reason },
      });
      return this.get(tableId)!;
    });
    return tx.immediate();
  }

  bindMessage(
    tableId: string,
    binding: { guildId: string; channelId: string; messageId: string },
    expectedRevision?: number,
  ): PersistentTableRow {
    const safeTableId = requiredString(tableId, "table_id");
    const safeBinding = {
      guildId: requiredString(binding.guildId, "guild_id"),
      channelId: requiredString(binding.channelId, "channel_id"),
      messageId: requiredString(binding.messageId, "message_id"),
    };
    const safeExpectedRevision = expectedRevision === undefined ? undefined : requiredNonnegativeInt(expectedRevision, "expected_revision");
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const current = this.get(safeTableId);
      if (!current) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId: safeTableId });
      assertKnownState(current.state);
      if (safeExpectedRevision !== undefined && current.revision !== safeExpectedRevision) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision is stale", {
          tableId: safeTableId,
          expectedRevision: safeExpectedRevision,
          actualRevision: current.revision,
        });
      }
      const now = this.now();
      this.db
        .prepare(
          `UPDATE casino_tables
             SET guild_id = ?, channel_id = ?, message_id = ?, updated_at = ?, revision = revision + 1, recovery_error = NULL
           WHERE table_id = ?`,
        )
        .run(safeBinding.guildId, safeBinding.channelId, safeBinding.messageId, now, safeTableId);
      this.events.log("casino_table_message_bound", { actor: "system:recovery", target: safeTableId, payload: safeBinding });
      return this.get(safeTableId)!;
    });
    return tx.immediate();
  }

  markDisputedFromRecovery(tableId: string, expectedRevision: number, reason: string): PersistentTableRow {
    const safeTableId = requiredString(tableId, "table_id");
    const safeExpectedRevision = requiredNonnegativeInt(expectedRevision, "expected_revision");
    const safeReason = requiredString(reason, "reason", MAX_REASON_LENGTH);
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const current = this.get(safeTableId);
      if (!current) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId: safeTableId });
      assertKnownState(current.state);
      if (PERSISTENT_TABLE_TERMINAL_STATES.has(current.state)) return current;
      if (current.revision !== safeExpectedRevision) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision is stale", {
          tableId: safeTableId,
          expectedRevision: safeExpectedRevision,
          actualRevision: current.revision,
        });
      }
      if (current.state === "disputed") return current;
      const now = this.now();
      this.db
        .prepare(
          `UPDATE casino_tables
             SET state = 'disputed', revision = revision + 1, updated_at = ?, state_changed_at = ?,
                 dispute_reason = ?, recovery_error = ?
           WHERE table_id = ? AND revision = ?`,
        )
        .run(now, now, safeReason, safeReason, safeTableId, safeExpectedRevision);
      this.events.log("casino_table_recovery_disputed", {
        actor: "system:recovery",
        target: safeTableId,
        payload: { reason: safeReason },
      });
      return this.get(safeTableId)!;
    });
    return tx.immediate();
  }

  listLiveTables(): PersistentTableRow[] {
    if (this.schemaStateOrThrow() === "none") return [];
    const rows = this.db.prepare("SELECT * FROM casino_tables ORDER BY created_at, table_id").all() as Record<string, unknown>[];
    const mapped = rows.map(mapTableRow);
    for (const row of mapped) assertKnownState(row.state);
    return mapped.filter((row) => PERSISTENT_TABLE_LIVE_STATES.has(row.state));
  }

  liveEscrowHolders(): string[] {
    return this.listLiveTables().map((row) => escrowHolderFor(row.tableId));
  }

  listDueTables(now = this.now()): PersistentTableRow[] {
    if (this.schemaStateOrThrow() === "none") return [];
    return this.listLiveTables().filter((row) => (row.deadlineAt !== null && row.deadlineAt <= now) || (row.expiresAt !== null && row.expiresAt <= now));
  }

  get(tableId: string): PersistentTableRow | null {
    if (this.schemaStateOrThrow() === "none") return null;
    const safeTableId = requiredString(tableId, "table_id");
    const row = this.db.prepare("SELECT * FROM casino_tables WHERE table_id = ?").get(safeTableId) as Record<string, unknown> | undefined;
    return row ? mapTableRow(row) : null;
  }

  participants(tableId: string): PersistentTableParticipantRow[] {
    if (this.schemaStateOrThrow() === "none") return [];
    const safeTableId = requiredString(tableId, "table_id");
    return (this.db
      .prepare("SELECT * FROM casino_table_participants WHERE table_id = ? ORDER BY seat, joined_at")
      .all(safeTableId) as Record<string, unknown>[]).map(mapParticipantRow);
  }

  private ensureSchemaForFormal(): void {
    const phase = this.openingPhase();
    if (phase !== "formal") {
      throw new PersistentTableError("ERR_CASINO_OPENING_NOT_COMPLETE", "persistent casino tables are only writable after formal opening", {
        phase,
      });
    }
    this.ensureSchema();
  }

  private ensureSchema(): void {
    const state = this.schemaState();
    if (state === "invalid") this.throwInvalidSchema("persistent table schema is partially present or missing required columns");
    if (state === "complete") return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_tables (
        table_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('recruiting','ready_check','playing','pending_approval','settled','disputed','cancelled','cancelled_by_admin','cancelled_fault')),
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
      CREATE INDEX IF NOT EXISTS idx_casino_tables_state ON casino_tables(state);
      CREATE INDEX IF NOT EXISTS idx_casino_tables_deadline ON casino_tables(deadline_at, expires_at);
      CREATE TABLE IF NOT EXISTS casino_table_participants (
        table_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        seat INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        ready_state TEXT,
        approval_state TEXT,
        PRIMARY KEY (table_id, user_id),
        UNIQUE (table_id, seat),
        FOREIGN KEY (table_id) REFERENCES casino_tables(table_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_casino_table_participants_user ON casino_table_participants(user_id);
    `);
    this.assertSchemaUsable();
  }

  private assertSchemaUsable(): void {
    if (this.schemaState() !== "complete") this.throwInvalidSchema("persistent table schema is partially present or missing required columns");
  }

  private schemaStateOrThrow(): PersistentTableSchemaState {
    const state = this.schemaState();
    if (state === "invalid") this.throwInvalidSchema("persistent table schema is partially present or missing required columns");
    return state;
  }

  private schemaState(): PersistentTableSchemaState {
    const hasTables = this.tableExists("casino_tables");
    const hasParticipants = this.tableExists("casino_table_participants");
    if (!hasTables && !hasParticipants) return "none";
    if (!hasTables || !hasParticipants) return "invalid";
    if (!this.hasRequiredColumns("casino_tables", REQUIRED_TABLE_COLUMNS)) return "invalid";
    if (!this.hasRequiredColumns("casino_table_participants", REQUIRED_PARTICIPANT_COLUMNS)) return "invalid";
    return "complete";
  }

  private hasRequiredColumns(table: "casino_tables" | "casino_table_participants", columns: readonly string[]): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    const present = new Set(rows.map((row) => String(row.name)));
    return columns.every((column) => present.has(column));
  }

  private throwInvalidSchema(message: string): never {
    throw new PersistentTableError("ERR_PERSISTENT_TABLE_SCHEMA_INVALID", message);
  }

  private tableExists(table: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    return !!row;
  }

  private findByOperation(operationId: string): PersistentTableRow | null {
    const row = this.db.prepare("SELECT * FROM casino_tables WHERE operation_id = ?").get(operationId) as Record<string, unknown> | undefined;
    return row ? mapTableRow(row) : null;
  }

  private findParticipant(tableId: string, userId: string): PersistentTableParticipantRow | null {
    const row = this.db
      .prepare("SELECT * FROM casino_table_participants WHERE table_id = ? AND user_id = ?")
      .get(tableId, userId) as Record<string, unknown> | undefined;
    return row ? mapParticipantRow(row) : null;
  }

  private findParticipantByOperation(operationId: string): PersistentTableParticipantRow | null {
    const row = this.db
      .prepare("SELECT * FROM casino_table_participants WHERE operation_id = ?")
      .get(operationId) as Record<string, unknown> | undefined;
    return row ? mapParticipantRow(row) : null;
  }

  private participantHasLiveTable(userId: string): boolean {
    const liveStates = Array.from(PERSISTENT_TABLE_LIVE_STATES);
    const placeholders = liveStates.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT 1
           FROM casino_tables t
          WHERE t.state IN (${placeholders}) AND EXISTS (
            SELECT 1 FROM casino_table_participants p WHERE p.table_id = t.table_id AND p.user_id = ?
          )
          LIMIT 1`,
      )
      .get(...liveStates, userId);
    return !!row;
  }
}

function mapTableRow(row: Record<string, unknown>): PersistentTableRow {
  const state = requiredString(row.state, "state", 40);
  assertKnownState(state);
  return {
    tableId: requiredString(row.table_id, "table_id"),
    state,
    gameKey: requiredString(row.game_key, "game_key", MAX_GAME_KEY_LENGTH),
    creatorId: requiredString(row.creator_id, "creator_id"),
    operatorId: requiredString(row.operator_id, "operator_id"),
    guildId: optionalString(row.guild_id, "guild_id"),
    channelId: optionalString(row.channel_id, "channel_id"),
    messageId: optionalString(row.message_id, "message_id"),
    createdAt: requiredNonnegativeInt(row.created_at, "created_at"),
    updatedAt: requiredNonnegativeInt(row.updated_at, "updated_at"),
    stateChangedAt: requiredNonnegativeInt(row.state_changed_at, "state_changed_at"),
    startedAt: nullableNonnegativeInt(row.started_at, "started_at"),
    deadlineAt: nullableNonnegativeInt(row.deadline_at, "deadline_at"),
    expiresAt: nullableNonnegativeInt(row.expires_at, "expires_at"),
    revision: requiredNonnegativeInt(row.revision, "revision"),
    operationId: requiredString(row.operation_id, "operation_id"),
    requestFingerprint: requiredString(row.request_fingerprint, "request_fingerprint"),
    failureReason: optionalString(row.failure_reason, "failure_reason", MAX_REASON_LENGTH),
    disputeReason: optionalString(row.dispute_reason, "dispute_reason", MAX_REASON_LENGTH),
    recoveryError: optionalString(row.recovery_error, "recovery_error", MAX_REASON_LENGTH),
  };
}

function mapParticipantRow(row: Record<string, unknown>): PersistentTableParticipantRow {
  return {
    tableId: requiredString(row.table_id, "table_id"),
    userId: requiredString(row.user_id, "user_id"),
    seat: positiveInt(row.seat, "seat"),
    joinedAt: requiredNonnegativeInt(row.joined_at, "joined_at"),
    operationId: requiredString(row.operation_id, "operation_id"),
    requestFingerprint: requiredString(row.request_fingerprint, "request_fingerprint"),
    readyState: optionalString(row.ready_state, "ready_state"),
    approvalState: optionalString(row.approval_state, "approval_state"),
  };
}

function assertKnownState(state: string): asserts state is PersistentTableState {
  if (!ALL_STATES.has(state)) {
    throw new PersistentTableError("ERR_TABLE_STATE_INVALID", "persistent table has unknown state", { state });
  }
}

function tableIdFromOperation(operationId: string): string {
  const clean = operationId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `pt_${clean || "op"}`;
}

function mapSqliteConflict(e: unknown, subject: string, id: string): never {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("UNIQUE") || message.includes("PRIMARY")) {
    throw new PersistentTableError("ERR_OPERATION_CONFLICT", `${subject} write conflicts with an existing row`, { id, cause: message });
  }
  throw e;
}

function requiredString(value: unknown, field: string, maxLength = MAX_ID_LENGTH): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new PersistentTableError("ERR_PERSISTENT_TABLE_SCHEMA_INVALID", "persistent table field is invalid", {
      field,
      valueType: typeof value,
    });
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength = MAX_ID_LENGTH): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field, maxLength);
}

function requiredNonnegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PersistentTableError("ERR_PERSISTENT_TABLE_SCHEMA_INVALID", "persistent table integer field is invalid", {
      field,
      value,
    });
  }
  return value;
}

function nullableNonnegativeInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requiredNonnegativeInt(value, field);
}

function positiveInt(value: unknown, field: string): number {
  const parsed = requiredNonnegativeInt(value, field);
  if (parsed <= 0) {
    throw new PersistentTableError("ERR_PERSISTENT_TABLE_SCHEMA_INVALID", "persistent table positive integer field is invalid", {
      field,
      value,
    });
  }
  return parsed;
}
