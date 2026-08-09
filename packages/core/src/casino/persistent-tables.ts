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
  | "ERR_STALE_TABLE";

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
    return this.tableExists("casino_tables") && this.tableExists("casino_table_participants");
  }

  create(input: CreatePersistentTableInput): PersistentTableRow {
    const fingerprint = canonicalStringify({
      gameKey: input.gameKey,
      creatorId: input.creatorId,
      operatorId: input.operatorId,
      guildId: input.guildId ?? null,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      deadlineAt: input.deadlineAt ?? null,
      expiresAt: input.expiresAt ?? null,
    });
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const existing = this.findByOperation(input.operationId);
      if (existing) {
        if (existing.requestFingerprint === fingerprint) return existing;
        throw new PersistentTableError("ERR_OPERATION_CONFLICT", "operation_id was replayed with different table data", {
          operationId: input.operationId,
        });
      }
      const tableId = input.tableId ?? tableIdFromOperation(input.operationId);
      const now = this.now();
      if (this.userHasLiveTable(input.creatorId)) {
        throw new PersistentTableError("ERR_CREATOR_ALREADY_IN_LIVE_TABLE", "creator already belongs to a live table", {
          creatorId: input.creatorId,
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
            input.gameKey,
            input.creatorId,
            input.operatorId,
            input.guildId ?? null,
            input.channelId ?? null,
            input.messageId ?? null,
            now,
            now,
            now,
            input.deadlineAt ?? null,
            input.expiresAt ?? null,
            input.operationId,
            fingerprint,
          );
      } catch (e) {
        throw mapSqliteConflict(e, "table", tableId);
      }
      this.events.log("casino_table_created", {
        actor: input.operatorId,
        target: tableId,
        payload: { gameKey: input.gameKey, creatorId: input.creatorId },
      });
      return this.get(tableId)!;
    });
    return tx.immediate();
  }

  join(input: JoinPersistentTableInput): PersistentTableParticipantRow {
    const fingerprint = canonicalStringify({
      tableId: input.tableId,
      userId: input.userId,
      seat: input.seat,
    });
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const replay = this.findParticipantByOperation(input.operationId);
      if (replay) {
        if (replay.requestFingerprint === fingerprint) return replay;
        throw new PersistentTableError("ERR_OPERATION_CONFLICT", "operation_id was replayed with different participant data", {
          operationId: input.operationId,
        });
      }
      const table = this.get(input.tableId);
      if (!table) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId: input.tableId });
      assertKnownState(table.state);
      if (!PERSISTENT_TABLE_LIVE_STATES.has(table.state)) {
        throw new PersistentTableError("ERR_TABLE_NOT_LIVE", "persistent table is not joinable", { tableId: input.tableId, state: table.state });
      }
      const existing = this.findParticipant(input.tableId, input.userId);
      if (existing) {
        if (existing.seat === input.seat) return existing;
        throw new PersistentTableError("ERR_PARTICIPANT_ALREADY_JOINED", "user is already seated at this table", {
          tableId: input.tableId,
          userId: input.userId,
        });
      }
      if (this.userHasLiveTable(input.userId)) {
        throw new PersistentTableError("ERR_PARTICIPANT_ALREADY_IN_LIVE_TABLE", "user already belongs to another live table", {
          userId: input.userId,
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
          .run(input.tableId, input.userId, input.seat, now, input.operationId, fingerprint);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes("casino_table_participants.table_id, casino_table_participants.seat")) {
          throw new PersistentTableError("ERR_SEAT_TAKEN", "table seat is already occupied", {
            tableId: input.tableId,
            seat: input.seat,
          });
        }
        throw mapSqliteConflict(e, "participant", input.tableId);
      }
      this.events.log("casino_table_joined", {
        actor: input.userId,
        target: input.tableId,
        payload: { seat: input.seat },
      });
      return this.findParticipant(input.tableId, input.userId)!;
    });
    return tx.immediate();
  }

  transition(input: TransitionPersistentTableInput): PersistentTableRow {
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const current = this.get(input.tableId);
      if (!current) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId: input.tableId });
      assertKnownState(current.state);
      if (current.state !== input.from || current.revision !== input.expectedRevision) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision is stale", {
          tableId: input.tableId,
          expectedState: input.from,
          actualState: current.state,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        });
      }
      assertKnownState(input.to);
      const now = this.now();
      const startedAt = input.to === "playing" && current.startedAt === null ? now : current.startedAt;
      const changed = this.db
        .prepare(
          `UPDATE casino_tables
             SET state = ?, revision = revision + 1, updated_at = ?, state_changed_at = ?,
                 started_at = ?, failure_reason = CASE WHEN ? IS NULL THEN failure_reason ELSE ? END
           WHERE table_id = ? AND state = ? AND revision = ?`,
        )
        .run(input.to, now, now, startedAt, input.reason ?? null, input.reason ?? null, input.tableId, input.from, input.expectedRevision);
      if (changed.changes !== 1) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision changed during transition", {
          tableId: input.tableId,
        });
      }
      this.events.log("casino_table_state_changed", {
        actor: input.actor,
        target: input.tableId,
        payload: { from: input.from, to: input.to, revision: input.expectedRevision + 1, reason: input.reason ?? null },
      });
      return this.get(input.tableId)!;
    });
    return tx.immediate();
  }

  bindMessage(
    tableId: string,
    binding: { guildId: string; channelId: string; messageId: string },
    expectedRevision?: number,
  ): PersistentTableRow {
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const current = this.get(tableId);
      if (!current) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
      assertKnownState(current.state);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision is stale", {
          tableId,
          expectedRevision,
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
        .run(binding.guildId, binding.channelId, binding.messageId, now, tableId);
      this.events.log("casino_table_message_bound", { actor: "system:recovery", target: tableId, payload: binding });
      return this.get(tableId)!;
    });
    return tx.immediate();
  }

  markDisputedFromRecovery(tableId: string, expectedRevision: number, reason: string): PersistentTableRow {
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const current = this.get(tableId);
      if (!current) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
      assertKnownState(current.state);
      if (PERSISTENT_TABLE_TERMINAL_STATES.has(current.state)) return current;
      if (current.revision !== expectedRevision) {
        throw new PersistentTableError("ERR_STALE_TABLE", "persistent table revision is stale", {
          tableId,
          expectedRevision,
          actualRevision: current.revision,
        });
      }
      const now = this.now();
      this.db
        .prepare(
          `UPDATE casino_tables
             SET state = 'disputed', revision = revision + 1, updated_at = ?, state_changed_at = ?,
                 dispute_reason = ?, recovery_error = ?
           WHERE table_id = ? AND revision = ?`,
        )
        .run(now, now, reason, reason, tableId, expectedRevision);
      this.events.log("casino_table_recovery_disputed", {
        actor: "system:recovery",
        target: tableId,
        payload: { reason },
      });
      return this.get(tableId)!;
    });
    return tx.immediate();
  }

  listLiveTables(): PersistentTableRow[] {
    if (!this.hasSchema()) return [];
    this.assertSchemaUsable();
    const rows = this.db.prepare("SELECT * FROM casino_tables ORDER BY created_at, table_id").all() as Record<string, unknown>[];
    const mapped = rows.map(mapTableRow);
    for (const row of mapped) assertKnownState(row.state);
    return mapped.filter((row) => PERSISTENT_TABLE_LIVE_STATES.has(row.state));
  }

  liveEscrowHolders(): string[] {
    return this.listLiveTables().map((row) => escrowHolderFor(row.tableId));
  }

  listDueTables(now = this.now()): PersistentTableRow[] {
    if (!this.hasSchema()) return [];
    return this.listLiveTables().filter((row) => (row.deadlineAt !== null && row.deadlineAt <= now) || (row.expiresAt !== null && row.expiresAt <= now));
  }

  get(tableId: string): PersistentTableRow | null {
    if (!this.hasSchema()) return null;
    this.assertSchemaUsable();
    const row = this.db.prepare("SELECT * FROM casino_tables WHERE table_id = ?").get(tableId) as Record<string, unknown> | undefined;
    return row ? mapTableRow(row) : null;
  }

  participants(tableId: string): PersistentTableParticipantRow[] {
    if (!this.hasSchema()) return [];
    this.assertSchemaUsable();
    return (this.db
      .prepare("SELECT * FROM casino_table_participants WHERE table_id = ? ORDER BY seat, joined_at")
      .all(tableId) as Record<string, unknown>[]).map(mapParticipantRow);
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
  }

  private assertSchemaUsable(): void {
    if (!this.tableExists("casino_tables") || !this.tableExists("casino_table_participants")) {
      throw new PersistentTableError("ERR_PERSISTENT_TABLE_SCHEMA_INVALID", "persistent table schema is partially present");
    }
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

  private userHasLiveTable(userId: string): boolean {
    const liveStates = Array.from(PERSISTENT_TABLE_LIVE_STATES);
    const placeholders = liveStates.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT 1
           FROM casino_tables t
          WHERE t.state IN (${placeholders}) AND (
            t.creator_id = ? OR EXISTS (
              SELECT 1 FROM casino_table_participants p WHERE p.table_id = t.table_id AND p.user_id = ?
            )
          )
          LIMIT 1`,
      )
      .get(...liveStates, userId, userId);
    return !!row;
  }
}

function mapTableRow(row: Record<string, unknown>): PersistentTableRow {
  return {
    tableId: String(row.table_id),
    state: String(row.state) as PersistentTableState,
    gameKey: String(row.game_key),
    creatorId: String(row.creator_id),
    operatorId: String(row.operator_id),
    guildId: stringOrNull(row.guild_id),
    channelId: stringOrNull(row.channel_id),
    messageId: stringOrNull(row.message_id),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    stateChangedAt: numberValue(row.state_changed_at),
    startedAt: numberOrNull(row.started_at),
    deadlineAt: numberOrNull(row.deadline_at),
    expiresAt: numberOrNull(row.expires_at),
    revision: numberValue(row.revision),
    operationId: String(row.operation_id),
    requestFingerprint: String(row.request_fingerprint),
    failureReason: stringOrNull(row.failure_reason),
    disputeReason: stringOrNull(row.dispute_reason),
    recoveryError: stringOrNull(row.recovery_error),
  };
}

function mapParticipantRow(row: Record<string, unknown>): PersistentTableParticipantRow {
  return {
    tableId: String(row.table_id),
    userId: String(row.user_id),
    seat: numberValue(row.seat),
    joinedAt: numberValue(row.joined_at),
    operationId: String(row.operation_id),
    requestFingerprint: String(row.request_fingerprint),
    readyState: stringOrNull(row.ready_state),
    approvalState: stringOrNull(row.approval_state),
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

function stringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function numberValue(value: unknown): number {
  return Number(value);
}
