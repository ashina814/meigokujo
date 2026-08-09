import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { canonicalHash, canonicalStringify } from "./opening-canonical.js";
import type { ChipLedger } from "./chip-ledger.js";
import { escrowHolderFor, type Escrow } from "./escrow.js";
import type { CasinoMetrics } from "./metrics.js";
import type { CasinoChipFlow } from "./chip-flow.js";
import {
  PersistentTableError,
  type PersistentTableParticipantRow,
  type PersistentTableRow,
  type PersistentTables,
} from "./persistent-tables.js";

export interface GenericRankProfile {
  key: string;
  participantCount: number;
  rankDeltaBps: readonly number[];
}

export interface RankedTableTier {
  key: string;
  label: string;
  baseAmount: number;
}

export const RANKED_TABLE_TIERS: readonly RankedTableTier[] = [
  { key: "minarai", label: "見習卓", baseAmount: 500 },
  { key: "low", label: "低卓", baseAmount: 2_000 },
  { key: "middle", label: "中卓", baseAmount: 5_000 },
  { key: "high", label: "高卓", baseAmount: 10_000 },
  { key: "super_high", label: "超高卓", baseAmount: 30_000 },
  { key: "extreme", label: "極卓", baseAmount: 50_000 },
  { key: "meigoku", label: "冥獄卓", baseAmount: 100_000 },
] as const;

export const RANKED_PROFILES = {
  gf: { key: "gf", participantCount: 2, rankDeltaBps: [10_000, -10_000] },
  sanma: { key: "sanma", participantCount: 3, rankDeltaBps: [15_000, -5_000, -10_000] },
  yonma: { key: "yonma", participantCount: 4, rankDeltaBps: [10_000, 5_000, -5_000, -10_000] },
} as const satisfies Record<string, GenericRankProfile>;

export type RankedTableErrorCode =
  | "ERR_RANKED_BAD_PROFILE"
  | "ERR_RANKED_BAD_AMOUNT"
  | "ERR_RANKED_TABLE_NOT_CONFIGURED"
  | "ERR_RANKED_TABLE_NOT_JOINABLE"
  | "ERR_RANKED_TABLE_NOT_READY"
  | "ERR_RANKED_TABLE_NOT_PLAYING"
  | "ERR_RANKED_TABLE_NOT_APPROVING"
  | "ERR_RANKED_PARTICIPANT"
  | "ERR_RANKED_PARTICIPANT_DECLINED"
  | "ERR_RANKED_SEAT"
  | "ERR_RANKED_INSUFFICIENT_FUNDS"
  | "ERR_RANKED_OPERATION_CONFLICT"
  | "ERR_RANKED_RESULT_INVALID"
  | "ERR_RANKED_RESULT_STALE"
  | "ERR_RANKED_ESCROW_MISMATCH"
  | "ERR_RANKED_RECOVERY_FAILED";

export class RankedTableError extends Error {
  constructor(
    readonly code: RankedTableErrorCode,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RankedTableError";
  }
}

export interface RankedTableConfig {
  baseAmount: number;
  feePerUser: number;
  participantCount: number;
  profile: GenericRankProfile;
}

export interface RankedTableSnapshot {
  table: PersistentTableRow;
  config: RankedTableConfig;
  participants: PersistentTableParticipantRow[];
  result: RankedResultSnapshot | null;
}

export interface RankedResultSnapshot {
  orderedUserIds: string[];
  hash: string;
  submittedBy: string;
  submittedAt: number;
}

export interface CreateRankedTableInput {
  tableId?: string;
  gameKey: string;
  profile?: GenericRankProfile;
  tierKey?: string;
  baseAmount?: number;
  creatorId: string;
  operatorId: string;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  operationId: string;
}

export interface JoinRankedTableInput {
  tableId: string;
  userId: string;
  seat: number;
  operationId: string;
}

export interface ReadyRankedTableInput {
  tableId: string;
  userId: string;
  operationId: string;
}

export interface SubmitRankedResultInput {
  tableId: string;
  userId: string;
  orderedUserIds: readonly string[];
  operationId: string;
}

export interface ApproveRankedResultInput {
  tableId: string;
  userId: string;
  resultHash: string;
  operationId: string;
}

export interface RankedTablesOptions {
  now?: () => number;
  chipFlow?: CasinoChipFlow;
  isSoloSeatOccupied?: (userId: string) => boolean;
  afterFeeCommitForTesting?: (tableId: string) => void;
  afterPlayingUpdateForTesting?: (tableId: string) => void;
  afterAutoDepositForTesting?: (tableId: string, userId: string) => void;
  beforeSettlementTransferForTesting?: (index: number, dist: { to: string; amount: number }) => void;
}

interface RankedTableStorageRow {
  table_id: string;
  state: string;
  game_key: string;
  base_amount: number | null;
  fee_per_user: number | null;
  participant_count: number | null;
  rank_profile_json: string | null;
  result_json: string | null;
  result_hash: string | null;
  result_submitted_by: string | null;
  result_submitted_at: number | null;
  result_operation_id: string | null;
  fee_committed_at: number | null;
  revision: number;
}

const RECRUITING_DEADLINE_SEC = 30 * 60;
const RECRUITING_EXPIRES_SEC = 3 * 60 * 60;
const READY_DEADLINE_SEC = 10 * 60;
const PLAYING_DEADLINE_SEC = 24 * 60 * 60;
const APPROVAL_DEADLINE_SEC = 6 * 60 * 60;
const MAX_ID_LENGTH = 200;

export function validateRankProfile(profile: GenericRankProfile, baseAmount: number): RankedTableConfig {
  const key = requiredString(profile.key, "profile.key", 80);
  const participantCount = safePositiveInt(profile.participantCount, "participantCount");
  if (participantCount < 2) throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank profile requires at least two participants");
  if (!Array.isArray(profile.rankDeltaBps) || profile.rankDeltaBps.length !== participantCount) {
    throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank profile vector length does not match participant count", {
      participantCount,
      vectorLength: profile.rankDeltaBps.length,
    });
  }
  const safeBaseAmount = validateBaseAmount(baseAmount);
  let sumDelta = 0;
  const rankDeltaBps = profile.rankDeltaBps.map((value, index) => {
    if (!Number.isSafeInteger(value)) throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank delta is not a safe integer", { index, value });
    sumDelta = checkedAdd(sumDelta, value, "deltaBps");
    const product = safeBaseAmount * value;
    if (!Number.isSafeInteger(product) || product % 10_000 !== 0) {
      throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank delta does not produce integer Land", {
        index,
        baseAmount: safeBaseAmount,
        value,
      });
    }
    return value;
  });
  if (sumDelta !== 0) throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank deltas must sum to zero", { sumDelta });
  const receipts = rankDeltaBps.map((bps, index) => {
    const delta = (safeBaseAmount * bps) / 10_000;
    const receipt = checkedAdd(safeBaseAmount, delta, "receipt");
    if (receipt < 0) throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank receipt is negative", { index, receipt });
    return receipt;
  });
  const receiptTotal = receipts.reduce((sum, receipt) => checkedAdd(sum, receipt, "receiptTotal"), 0);
  const expectedTotal = safeBaseAmount * participantCount;
  if (!Number.isSafeInteger(expectedTotal) || receiptTotal !== expectedTotal) {
    throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank receipts do not conserve the pool", { receiptTotal, expectedTotal });
  }
  const feePerUser = feeForBaseAmount(safeBaseAmount);
  return {
    baseAmount: safeBaseAmount,
    feePerUser,
    participantCount,
    profile: { key, participantCount, rankDeltaBps },
  };
}

export function rankedReceipts(profile: GenericRankProfile, baseAmount: number): number[] {
  const config = validateRankProfile(profile, baseAmount);
  return config.profile.rankDeltaBps.map((bps) => config.baseAmount + (config.baseAmount * bps) / 10_000);
}

export function feeForBaseAmount(baseAmount: number): number {
  const safe = validateBaseAmount(baseAmount);
  const fee = (safe * 3) / 100;
  if (!Number.isSafeInteger(fee) || fee <= 0) throw new RankedTableError("ERR_RANKED_BAD_AMOUNT", "ranked table fee is invalid", { baseAmount });
  return fee;
}

export class RankedTables {
  private readonly now: () => number;
  private readonly isSoloSeatOccupied: (userId: string) => boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly chips: ChipLedger,
    private readonly escrow: Escrow,
    private readonly persistentTables: PersistentTables,
    private readonly events: EventLog,
    private readonly metrics?: CasinoMetrics,
    private readonly options: RankedTablesOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.isSoloSeatOccupied = options.isSoloSeatOccupied ?? (() => false);
  }

  create(input: CreateRankedTableInput): RankedTableSnapshot {
    const profile = profileForGame(input.gameKey, input.profile);
    const baseAmount = input.baseAmount ?? tierByKey(input.tierKey ?? "middle").baseAmount;
    const config = validateRankProfile(profile, baseAmount);
    const operationId = requiredString(input.operationId, "operationId");
    const requestedConfig = canonicalStringify({
      gameKey: input.gameKey,
      profile: config.profile,
      baseAmount: config.baseAmount,
    });
    const tx = this.db.transaction(() => {
      const table = this.persistentTables.create({
        tableId: input.tableId,
        gameKey: input.gameKey,
        creatorId: input.creatorId,
        operatorId: input.operatorId,
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        operationId,
        deadlineAt: this.now() + RECRUITING_DEADLINE_SEC,
        expiresAt: this.now() + RECRUITING_EXPIRES_SEC,
      });
      const stored = this.readStorage(table.tableId);
      if (!stored) throw new RankedTableError("ERR_RANKED_TABLE_NOT_CONFIGURED", "ranked table was not created", { tableId: table.tableId });
      if (stored.rank_profile_json !== null) {
        if (this.storedConfigFingerprint(stored) !== requestedConfig) {
          throw new RankedTableError("ERR_RANKED_OPERATION_CONFLICT", "ranked table create operation was replayed with different config", {
            tableId: table.tableId,
          });
        }
        return this.snapshot(table.tableId);
      }
      this.db
        .prepare(
          `UPDATE casino_tables
             SET base_amount=?, fee_per_user=?, participant_count=?, rank_profile_json=?, updated_at=?
           WHERE table_id=?`,
        )
        .run(config.baseAmount, config.feePerUser, config.participantCount, canonicalStringify(config.profile), this.now(), table.tableId);
      this.metrics?.record({
        eventKey: `table_open:${table.tableId}:${operationId}`,
        eventType: "table_open",
        game: input.gameKey,
        operationId,
        amount: config.baseAmount,
        payload: { tableId: table.tableId, profile: config.profile.key, baseAmount: config.baseAmount },
        occurredAt: this.now(),
      });
      return this.snapshot(table.tableId);
    });
    return tx.immediate();
  }

  join(input: JoinRankedTableInput): RankedTableSnapshot {
    const safeInput = {
      tableId: requiredString(input.tableId, "tableId"),
      userId: requiredString(input.userId, "userId"),
      seat: safePositiveInt(input.seat, "seat"),
      operationId: requiredString(input.operationId, "operationId"),
    };
    const fingerprint = canonicalStringify(safeInput);
    const result = this.chips.runGroup(
      { groupKey: `ranked:join:${safeInput.tableId}:${safeInput.userId}:${safeInput.operationId}`, kind: "table_hold", actorId: safeInput.userId },
      () => {
        const table = this.requiredTable(safeInput.tableId);
        const config = this.configFor(table);
        if (table.state !== "recruiting") {
          throw new RankedTableError("ERR_RANKED_TABLE_NOT_JOINABLE", "ranked table is not recruiting", { tableId: table.tableId, state: table.state });
        }
        if (safeInput.seat > config.participantCount) throw new RankedTableError("ERR_RANKED_SEAT", "seat is outside ranked table capacity");
        if (this.isSoloSeatOccupied(safeInput.userId)) {
          throw new RankedTableError("ERR_RANKED_PARTICIPANT", "participant is already occupying a solo-game seat", { userId: safeInput.userId });
        }
        const all = this.participants(table.tableId);
        if (all.some((p) => p.userId === safeInput.userId && p.participantState === "declined")) {
          throw new RankedTableError("ERR_RANKED_PARTICIPANT_DECLINED", "declined participant cannot be silently rejoined", {
            tableId: table.tableId,
            userId: safeInput.userId,
          });
        }
        const active = all.filter(isActiveParticipant);
        if (active.length >= config.participantCount) throw new RankedTableError("ERR_RANKED_TABLE_NOT_JOINABLE", "ranked table is full");
        if (active.some((p) => p.seat === safeInput.seat)) throw new RankedTableError("ERR_RANKED_SEAT", "ranked table seat is taken");
        const holdAmount = checkedAdd(config.baseAmount, config.feePerUser, "joinHold");
        try {
          this.options.chipFlow?.ensureFreeChips(safeInput.userId, holdAmount, chipFlowOperationId("ranked-join", safeInput));
        } catch (e) {
          throw new RankedTableError("ERR_RANKED_INSUFFICIENT_FUNDS", "participant does not have enough Land or chips", {
            userId: safeInput.userId,
            amount: holdAmount,
            cause: e instanceof Error ? e.message : String(e),
          });
        }
        this.options.afterAutoDepositForTesting?.(table.tableId, safeInput.userId);
        if (!this.escrow.hold(table.tableId, safeInput.userId, holdAmount, table.gameKey, safeInput.operationId)) {
          throw new RankedTableError("ERR_RANKED_INSUFFICIENT_FUNDS", "participant does not have enough chips", {
            userId: safeInput.userId,
            amount: holdAmount,
          });
        }
        this.persistentTables.join(safeInput);
        this.db
          .prepare("UPDATE casino_table_participants SET participant_state='active' WHERE table_id=? AND user_id=?")
          .run(table.tableId, safeInput.userId);
        const joinedActive = this.activeParticipants(table.tableId);
        if (joinedActive.length === config.participantCount) {
          const current = this.requiredTable(table.tableId);
          this.persistentTables.transition({
            tableId: table.tableId,
            from: "recruiting",
            to: "ready_check",
            expectedRevision: current.revision,
            actor: safeInput.userId,
            reason: "ranked table capacity reached",
          });
          this.db
            .prepare("UPDATE casino_tables SET deadline_at=?, expires_at=NULL, updated_at=? WHERE table_id=?")
            .run(this.now() + READY_DEADLINE_SEC, this.now(), table.tableId);
        }
        this.metrics?.record({
          eventKey: `table_join:${table.tableId}:${safeInput.userId}:${safeInput.operationId}`,
          eventType: "table_join",
          userId: safeInput.userId,
          game: table.gameKey,
          operationId: safeInput.operationId,
          amount: holdAmount,
          payload: { tableId: table.tableId, seat: safeInput.seat },
          occurredAt: this.now(),
        });
        return { fingerprint, tableId: table.tableId };
      },
    );
    if (result.fingerprint !== fingerprint) throw new RankedTableError("ERR_RANKED_OPERATION_CONFLICT", "ranked join operation replay conflict");
    return this.snapshot(result.tableId);
  }

  ready(input: ReadyRankedTableInput): RankedTableSnapshot {
    const safeInput = {
      tableId: requiredString(input.tableId, "tableId"),
      userId: requiredString(input.userId, "userId"),
      operationId: requiredString(input.operationId, "operationId"),
    };
    const fingerprint = canonicalStringify(safeInput);
    const tx = this.db.transaction(() => {
      const replay = this.participantByReadyOperation(safeInput.operationId);
      if (replay) {
        if (replay.ready_fingerprint !== fingerprint) {
          throw new RankedTableError("ERR_RANKED_OPERATION_CONFLICT", "ready operation replay conflict");
        }
        return this.snapshot(replay.table_id);
      }
      const table = this.requiredTable(safeInput.tableId);
      const config = this.configFor(table);
      if (table.state !== "ready_check") {
        throw new RankedTableError("ERR_RANKED_TABLE_NOT_READY", "ranked table is not in ready_check", { state: table.state });
      }
      const participant = this.requireActiveParticipant(table.tableId, safeInput.userId);
      if (participant.readyState === "ready") return this.snapshot(table.tableId);
      this.db
        .prepare(
          `UPDATE casino_table_participants
             SET ready_state='ready', ready_operation_id=?, ready_fingerprint=?
           WHERE table_id=? AND user_id=? AND COALESCE(participant_state, 'active') != 'declined'`,
        )
        .run(safeInput.operationId, fingerprint, table.tableId, safeInput.userId);
      const active = this.activeParticipants(table.tableId);
      if (active.length !== config.participantCount) {
        throw new RankedTableError("ERR_RANKED_TABLE_NOT_READY", "ranked table participant count changed before ready");
      }
      if (active.every((p) => p.readyState === "ready")) {
        const userIds = active.map((p) => p.userId);
        const committed = this.escrow.commitTableFees({
          sessionId: table.tableId,
          userIds,
          stakeAmount: config.baseAmount,
          feePerUser: config.feePerUser,
          game: table.gameKey,
          operationId: `ready:${safeInput.operationId}`,
          actor: safeInput.userId,
        });
        this.options.afterFeeCommitForTesting?.(table.tableId);
        const changed = this.db
          .prepare(
            `UPDATE casino_tables
               SET state='playing', revision=revision+1, updated_at=?, state_changed_at=?,
                   started_at=COALESCE(started_at, ?), deadline_at=?, fee_committed_at=?
             WHERE table_id=? AND state='ready_check' AND revision=?`,
          )
          .run(this.now(), this.now(), this.now(), this.now() + PLAYING_DEADLINE_SEC, this.now(), table.tableId, table.revision).changes;
        if (changed !== 1) throw new PersistentTableError("ERR_STALE_TABLE", "ranked table changed during ready start");
        this.options.afterPlayingUpdateForTesting?.(table.tableId);
        this.metrics?.record({
          eventKey: `table_start:${table.tableId}`,
          eventType: "table_start",
          game: table.gameKey,
          operationId: safeInput.operationId,
          amount: committed.totalFee,
          payload: { tableId: table.tableId, feePerUser: config.feePerUser, participants: committed.participants },
          occurredAt: this.now(),
        });
        this.events.log("casino_ranked_table_started", {
          actor: safeInput.userId,
          target: table.tableId,
          payload: { totalFee: committed.totalFee, participants: committed.participants },
        });
      }
      return this.snapshot(table.tableId);
    });
    return tx.immediate();
  }

  decline(input: ReadyRankedTableInput): RankedTableSnapshot {
    const safeInput = {
      tableId: requiredString(input.tableId, "tableId"),
      userId: requiredString(input.userId, "userId"),
      operationId: requiredString(input.operationId, "operationId"),
    };
    const fingerprint = canonicalStringify(safeInput);
    const tx = this.db.transaction(() => {
      const replay = this.participantByDeclineOperation(safeInput.operationId);
      if (replay) {
        if (replay.decline_fingerprint !== fingerprint) {
          throw new RankedTableError("ERR_RANKED_OPERATION_CONFLICT", "decline operation replay conflict");
        }
        return this.snapshot(replay.table_id);
      }
      const table = this.requiredTable(safeInput.tableId);
      if (table.state !== "ready_check") throw new RankedTableError("ERR_RANKED_TABLE_NOT_READY", "ranked table is not in ready_check");
      this.requireActiveParticipant(table.tableId, safeInput.userId);
      this.escrow.refundOne(table.tableId, safeInput.userId, `decline:${safeInput.operationId}`);
      this.db
        .prepare(
          `UPDATE casino_table_participants
             SET participant_state='declined', ready_state=NULL, approval_state=NULL,
                 decline_operation_id=?, decline_fingerprint=?, declined_at=?
           WHERE table_id=? AND user_id=?`,
        )
        .run(safeInput.operationId, fingerprint, this.now(), table.tableId, safeInput.userId);
      this.db.prepare("UPDATE casino_table_participants SET ready_state=NULL WHERE table_id=? AND COALESCE(participant_state, 'active') != 'declined'").run(table.tableId);
      this.persistentTables.transition({
        tableId: table.tableId,
        from: "ready_check",
        to: "recruiting",
        expectedRevision: table.revision,
        actor: safeInput.userId,
        reason: "ranked participant declined during ready_check",
      });
      this.db
        .prepare("UPDATE casino_tables SET deadline_at=?, expires_at=?, updated_at=? WHERE table_id=?")
        .run(this.now() + RECRUITING_DEADLINE_SEC, table.createdAt + RECRUITING_EXPIRES_SEC, this.now(), table.tableId);
      return this.snapshot(table.tableId);
    });
    return tx.immediate();
  }

  submitResult(input: SubmitRankedResultInput): RankedTableSnapshot {
    const safeInput = {
      tableId: requiredString(input.tableId, "tableId"),
      userId: requiredString(input.userId, "userId"),
      orderedUserIds: input.orderedUserIds.map((id) => requiredString(id, "orderedUserIds")),
      operationId: requiredString(input.operationId, "operationId"),
    };
    const tx = this.db.transaction(() => {
      const existing = this.readStorage(safeInput.tableId);
      if (existing?.result_operation_id === safeInput.operationId) {
        const currentHash = existing.result_hash;
        const replayHash = resultHash(safeInput.orderedUserIds);
        if (currentHash !== replayHash) throw new RankedTableError("ERR_RANKED_OPERATION_CONFLICT", "result operation replay conflict");
        return this.snapshot(safeInput.tableId);
      }
      const table = this.requiredTable(safeInput.tableId);
      const config = this.configFor(table);
      if (table.state !== "playing") throw new RankedTableError("ERR_RANKED_TABLE_NOT_PLAYING", "ranked table is not playing", { state: table.state });
      this.requireActiveParticipant(table.tableId, safeInput.userId);
      this.validateRanking(table.tableId, config, safeInput.orderedUserIds);
      const json = canonicalStringify({ orderedUserIds: safeInput.orderedUserIds });
      const hash = resultHash(safeInput.orderedUserIds);
      const changed = this.db
        .prepare(
          `UPDATE casino_tables
             SET state='pending_approval', revision=revision+1, updated_at=?, state_changed_at=?,
                 deadline_at=?, result_json=?, result_hash=?, result_submitted_by=?, result_submitted_at=?, result_operation_id=?
           WHERE table_id=? AND state='playing' AND revision=?`,
        )
        .run(
          this.now(),
          this.now(),
          this.now() + APPROVAL_DEADLINE_SEC,
          json,
          hash,
          safeInput.userId,
          this.now(),
          safeInput.operationId,
          table.tableId,
          table.revision,
        ).changes;
      if (changed !== 1) throw new PersistentTableError("ERR_STALE_TABLE", "ranked table changed during result submit");
      this.db.prepare("UPDATE casino_table_participants SET approval_state=NULL, approval_operation_id=NULL, approval_fingerprint=NULL WHERE table_id=?").run(table.tableId);
      this.events.log("casino_ranked_result_submitted", {
        actor: safeInput.userId,
        target: table.tableId,
        payload: { resultHash: hash },
      });
      return this.snapshot(table.tableId);
    });
    return tx.immediate();
  }

  approve(input: ApproveRankedResultInput): RankedTableSnapshot {
    return this.approvalAction(input, "approved");
  }

  dispute(input: ApproveRankedResultInput): RankedTableSnapshot {
    return this.approvalAction(input, "disputed");
  }

  processDueTables(now = this.now()): { processed: number; refunded: number; disputed: number } {
    let processed = 0;
    let refunded = 0;
    let disputed = 0;
    for (const table of this.persistentTables.listDueTables(now)) {
      const tx = this.db.transaction(() => {
        const current = this.requiredTable(table.tableId);
        const deadlineDue = current.deadlineAt !== null && current.deadlineAt <= now;
        const expiresDue = current.state === "recruiting" && current.expiresAt !== null && current.expiresAt <= now;
        if (!deadlineDue && !expiresDue) return;
        if (current.state === "recruiting") {
          const active = this.activeParticipants(current.tableId);
          refunded += this.escrow.refundMany(current.tableId, active.map((p) => p.userId), `timeout:recruiting:${current.revision}`);
          this.persistentTables.transition({
            tableId: current.tableId,
            from: "recruiting",
            to: "cancelled",
            expectedRevision: current.revision,
            actor: "system:ranked-timeout",
            reason: "ranked recruiting timeout",
          });
          processed++;
          return;
        }
        if (current.state === "ready_check") {
          const active = this.activeParticipants(current.tableId);
          const unready = active.filter((p) => p.readyState !== "ready");
          refunded += this.escrow.refundMany(current.tableId, unready.map((p) => p.userId), `timeout:ready:${current.revision}`);
          for (const p of unready) {
            this.db
              .prepare("UPDATE casino_table_participants SET participant_state='declined', declined_at=? WHERE table_id=? AND user_id=?")
              .run(now, current.tableId, p.userId);
          }
          this.db.prepare("UPDATE casino_table_participants SET ready_state=NULL WHERE table_id=? AND COALESCE(participant_state, 'active') != 'declined'").run(current.tableId);
          this.persistentTables.transition({
            tableId: current.tableId,
            from: "ready_check",
            to: "recruiting",
            expectedRevision: current.revision,
            actor: "system:ranked-timeout",
            reason: "ranked ready timeout",
          });
          this.db
            .prepare("UPDATE casino_tables SET deadline_at=?, expires_at=?, updated_at=? WHERE table_id=?")
            .run(now + RECRUITING_DEADLINE_SEC, current.createdAt + RECRUITING_EXPIRES_SEC, now, current.tableId);
          processed++;
          return;
        }
        if (current.state === "playing" || current.state === "pending_approval") {
          this.markDisputed(current, `ranked ${current.state} timeout`);
          disputed++;
          processed++;
        }
      });
      try {
        tx.immediate();
      } catch (e) {
        this.events.log("casino_ranked_timeout_failed", {
          actor: "system:ranked-timeout",
          target: table.tableId,
          payload: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
    return { processed, refunded, disputed };
  }

  snapshot(tableId: string): RankedTableSnapshot {
    const table = this.requiredTable(tableId);
    const result = this.resultFor(table);
    this.assertResultState(table, result);
    return {
      table,
      config: this.configFor(table),
      participants: this.participants(tableId),
      result,
    };
  }

  private approvalAction(input: ApproveRankedResultInput, action: "approved" | "disputed"): RankedTableSnapshot {
    const safeInput = {
      tableId: requiredString(input.tableId, "tableId"),
      userId: requiredString(input.userId, "userId"),
      resultHash: requiredString(input.resultHash, "resultHash"),
      operationId: requiredString(input.operationId, "operationId"),
    };
    const fingerprint = canonicalStringify({ ...safeInput, action });
    const tx = this.db.transaction(() => {
      const replay = this.participantByApprovalOperation(safeInput.operationId);
      if (replay) {
        if (replay.approval_fingerprint !== fingerprint) {
          throw new RankedTableError("ERR_RANKED_OPERATION_CONFLICT", "approval operation replay conflict");
        }
        return this.snapshot(replay.table_id);
      }
      const table = this.requiredTable(safeInput.tableId);
      if (table.state !== "pending_approval") {
        throw new RankedTableError("ERR_RANKED_TABLE_NOT_APPROVING", "ranked table is not pending approval", { state: table.state });
      }
      const storage = this.requiredStorage(table.tableId);
      if (storage.result_hash !== safeInput.resultHash) {
        throw new RankedTableError("ERR_RANKED_RESULT_STALE", "approval result hash is stale", {
          requested: safeInput.resultHash,
          current: storage.result_hash,
        });
      }
      this.requireActiveParticipant(table.tableId, safeInput.userId);
      if (action === "disputed") {
        this.db
          .prepare(
            `UPDATE casino_table_participants
               SET approval_state='disputed', approval_operation_id=?, approval_fingerprint=?
             WHERE table_id=? AND user_id=?`,
          )
          .run(safeInput.operationId, fingerprint, table.tableId, safeInput.userId);
        this.markDisputed(table, "participant disputed ranked result");
        return this.snapshot(table.tableId);
      }
      const participant = this.requireActiveParticipant(table.tableId, safeInput.userId);
      if (participant.approvalState !== "approved") {
        this.db
          .prepare(
            `UPDATE casino_table_participants
               SET approval_state='approved', approval_operation_id=?, approval_fingerprint=?
             WHERE table_id=? AND user_id=?`,
          )
          .run(safeInput.operationId, fingerprint, table.tableId, safeInput.userId);
      }
      const active = this.activeParticipants(table.tableId);
      if (active.every((p) => p.approvalState === "approved")) {
        try {
          this.settleApproved(table, safeInput.userId);
        } catch (e) {
          if (!isSettlementCorruption(e)) throw e;
          this.markDisputed(table, e instanceof Error ? e.message : "ranked settlement consistency check failed");
        }
      }
      return this.snapshot(table.tableId);
    });
    return tx.immediate();
  }

  private settleApproved(table: PersistentTableRow, actor: string): void {
    const config = this.configFor(table);
    const result = this.resultFor(table);
    if (!result) throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked result is missing");
    this.validateRanking(table.tableId, config, result.orderedUserIds);
    const distributions = this.distributions(config, result.orderedUserIds);
    this.assertEscrowBeforeSettlement(table.tableId, config, distributions);
    this.escrow.settle(table.tableId, distributions, actor, "順位卓の精算", this.options.beforeSettlementTransferForTesting);
    const changed = this.db
      .prepare(
        `UPDATE casino_tables
           SET state='settled', revision=revision+1, updated_at=?, state_changed_at=?, deadline_at=NULL
         WHERE table_id=? AND state='pending_approval' AND revision=?`,
      )
      .run(this.now(), this.now(), table.tableId, table.revision).changes;
    if (changed !== 1) throw new PersistentTableError("ERR_STALE_TABLE", "ranked table changed during settlement");
    this.metrics?.record({
      eventKey: `table_settle:${table.tableId}`,
      eventType: "table_settle",
      game: table.gameKey,
      operationId: result.hash,
      amount: config.baseAmount * config.participantCount,
      payload: { tableId: table.tableId, resultHash: result.hash },
      occurredAt: this.now(),
    });
    this.events.log("casino_ranked_table_settled", { actor, target: table.tableId, payload: { resultHash: result.hash } });
  }

  private markDisputed(table: PersistentTableRow, reason: string): void {
    this.persistentTables.transition({
      tableId: table.tableId,
      from: table.state,
      to: "disputed",
      expectedRevision: table.revision,
      actor: "system:ranked-table",
      reason,
    });
    this.db.prepare("UPDATE casino_tables SET dispute_reason=?, deadline_at=? WHERE table_id=?").run(reason, this.now() + 72 * 60 * 60, table.tableId);
    this.metrics?.record({
      eventKey: `table_dispute:${table.tableId}:${table.revision + 1}`,
      eventType: "table_dispute",
      game: table.gameKey,
      payload: { tableId: table.tableId, reason },
      occurredAt: this.now(),
    });
  }

  private distributions(config: RankedTableConfig, orderedUserIds: readonly string[]): Array<{ to: string; amount: number; reason: string }> {
    const receipts = rankedReceipts(config.profile, config.baseAmount);
    return orderedUserIds.map((userId, index) => ({ to: userId, amount: receipts[index]!, reason: "順位卓の配分" }));
  }

  private assertEscrowBeforeSettlement(
    tableId: string,
    config: RankedTableConfig,
    distributions: ReadonlyArray<{ to: string; amount: number }>,
  ): void {
    const expected = config.baseAmount * config.participantCount;
    const ledger = this.escrow.poolOf(tableId);
    const holder = this.chips.balanceOf(escrowHolderFor(tableId));
    const total = distributions.reduce((sum, d) => checkedAdd(sum, d.amount, "distributionTotal"), 0);
    if (ledger !== expected || holder !== expected || total !== expected) {
      throw new RankedTableError("ERR_RANKED_ESCROW_MISMATCH", "ranked table escrow does not match settlement distribution", {
        tableId,
        ledger,
        holder,
        total,
        expected,
      });
    }
  }

  private validateRanking(tableId: string, config: RankedTableConfig, orderedUserIds: readonly string[]): void {
    if (orderedUserIds.length !== config.participantCount) {
      throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked result has wrong participant count", { tableId });
    }
    const active = this.activeParticipants(tableId).map((p) => p.userId);
    const expected = new Set(active);
    const seen = new Set<string>();
    for (const userId of orderedUserIds) {
      if (seen.has(userId)) throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked result contains duplicate participant", { userId });
      if (!expected.has(userId)) throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked result contains outsider", { userId });
      seen.add(userId);
    }
    if (seen.size !== expected.size || active.some((userId) => !seen.has(userId))) {
      throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked result is missing participant", { tableId });
    }
  }

  private requiredTable(tableId: string): PersistentTableRow {
    const table = this.persistentTables.get(tableId);
    if (!table) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
    return table;
  }

  private configFor(table: PersistentTableRow): RankedTableConfig {
    const storage = this.requiredStorage(table.tableId);
    if (storage.base_amount == null || storage.fee_per_user == null || storage.participant_count == null || storage.rank_profile_json == null) {
      throw new RankedTableError("ERR_RANKED_TABLE_NOT_CONFIGURED", "persistent table is missing ranked configuration", { tableId: table.tableId });
    }
    const profile = parseProfile(storage.rank_profile_json);
    const config = validateRankProfile(profile, storage.base_amount);
    if (config.feePerUser !== storage.fee_per_user || config.participantCount !== storage.participant_count) {
      throw new RankedTableError("ERR_RANKED_TABLE_NOT_CONFIGURED", "ranked table stored config is inconsistent", { tableId: table.tableId });
    }
    return config;
  }

  private resultFor(table: PersistentTableRow): RankedResultSnapshot | null {
    const storage = this.requiredStorage(table.tableId);
    const resultJson = storage.result_json;
    const resultHashValue = storage.result_hash;
    const submittedBy = storage.result_submitted_by;
    const submittedAt = storage.result_submitted_at;
    const operationId = storage.result_operation_id;
    if (resultJson == null && resultHashValue == null && submittedBy == null && submittedAt == null && operationId == null) return null;
    if (resultJson == null || resultHashValue == null || submittedBy == null || submittedAt == null || operationId == null) {
      throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "stored ranked result is partial", { tableId: table.tableId, state: table.state });
    }
    const parsed = parseResult(resultJson);
    const hash = resultHash(parsed.orderedUserIds);
    if (hash !== resultHashValue) throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "stored ranked result hash is corrupt", { tableId: table.tableId });
    if (!Number.isSafeInteger(submittedAt) || submittedAt < 0) {
      throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "stored ranked result submitted_at is corrupt", { tableId: table.tableId });
    }
    requiredString(operationId, "result_operation_id");
    return {
      orderedUserIds: parsed.orderedUserIds,
      hash,
      submittedBy,
      submittedAt,
    };
  }

  private assertResultState(table: PersistentTableRow, result: RankedResultSnapshot | null): void {
    if ((table.state === "pending_approval" || table.state === "settled") && !result) {
      throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked table state requires a stored result", { tableId: table.tableId, state: table.state });
    }
    if ((table.state === "recruiting" || table.state === "ready_check" || table.state === "playing") && result) {
      throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked table state must not have a stored result", { tableId: table.tableId, state: table.state });
    }
  }

  private requiredStorage(tableId: string): RankedTableStorageRow {
    const row = this.readStorage(tableId);
    if (!row) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
    return row;
  }

  private readStorage(tableId: string): RankedTableStorageRow | null {
    const row = this.db.prepare("SELECT * FROM casino_tables WHERE table_id=?").get(tableId) as RankedTableStorageRow | undefined;
    return row ?? null;
  }

  private storedConfigFingerprint(row: RankedTableStorageRow): string {
    return canonicalStringify({
      gameKey: row.game_key,
      profile: parseProfile(row.rank_profile_json),
      baseAmount: row.base_amount,
    });
  }

  private participants(tableId: string): PersistentTableParticipantRow[] {
    return this.persistentTables.participants(tableId);
  }

  private activeParticipants(tableId: string): PersistentTableParticipantRow[] {
    return this.participants(tableId).filter(isActiveParticipant);
  }

  private requireActiveParticipant(tableId: string, userId: string): PersistentTableParticipantRow {
    const participant = this.activeParticipants(tableId).find((p) => p.userId === userId);
    if (!participant) throw new RankedTableError("ERR_RANKED_PARTICIPANT", "actor is not an active ranked table participant", { tableId, userId });
    return participant;
  }

  private participantByReadyOperation(operationId: string): { table_id: string; ready_fingerprint: string | null } | null {
    return (this.db
      .prepare("SELECT table_id, ready_fingerprint FROM casino_table_participants WHERE ready_operation_id=?")
      .get(operationId) as { table_id: string; ready_fingerprint: string | null } | undefined) ?? null;
  }

  private participantByApprovalOperation(operationId: string): { table_id: string; approval_fingerprint: string | null } | null {
    return (this.db
      .prepare("SELECT table_id, approval_fingerprint FROM casino_table_participants WHERE approval_operation_id=?")
      .get(operationId) as { table_id: string; approval_fingerprint: string | null } | undefined) ?? null;
  }

  private participantByDeclineOperation(operationId: string): { table_id: string; decline_fingerprint: string | null } | null {
    return (this.db
      .prepare("SELECT table_id, decline_fingerprint FROM casino_table_participants WHERE decline_operation_id=?")
      .get(operationId) as { table_id: string; decline_fingerprint: string | null } | undefined) ?? null;
  }
}

function fixedProfileFor(gameKey: string): GenericRankProfile {
  if (gameKey === "gf") return RANKED_PROFILES.gf;
  if (gameKey === "sanma") return RANKED_PROFILES.sanma;
  if (gameKey === "yonma") return RANKED_PROFILES.yonma;
  throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "generic ranked table requires an explicit trusted profile", { gameKey });
}

function profileForGame(gameKey: string, explicit?: GenericRankProfile): GenericRankProfile {
  const fixed = gameKey === "gf" || gameKey === "sanma" || gameKey === "yonma" ? fixedProfileFor(gameKey) : null;
  if (!fixed) {
    if (!explicit) throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "generic ranked table requires an explicit trusted profile", { gameKey });
    return explicit;
  }
  if (!explicit) return fixed;
  if (canonicalStringify(explicit) !== canonicalStringify(fixed)) {
    throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "fixed ranked game cannot override its canonical profile", { gameKey });
  }
  return fixed;
}

function chipFlowOperationId(prefix: string, input: { tableId: string; userId: string; operationId: string }): string {
  const raw = `${prefix}-${input.tableId}-${input.userId}-${input.operationId}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
}

function isSettlementCorruption(error: unknown): boolean {
  if (!(error instanceof RankedTableError)) return false;
  return (
    error.code === "ERR_RANKED_ESCROW_MISMATCH" ||
    error.code === "ERR_RANKED_RESULT_INVALID" ||
    error.code === "ERR_RANKED_TABLE_NOT_CONFIGURED" ||
    error.code === "ERR_RANKED_BAD_PROFILE"
  );
}

function tierByKey(key: string): RankedTableTier {
  const tier = RANKED_TABLE_TIERS.find((row) => row.key === key);
  if (!tier) throw new RankedTableError("ERR_RANKED_BAD_AMOUNT", "unknown ranked table tier", { key });
  return tier;
}

function validateBaseAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value % 100 !== 0) {
    throw new RankedTableError("ERR_RANKED_BAD_AMOUNT", "base amount must be a positive 100-Land multiple", { value });
  }
  return value;
}

function parseProfile(json: string | null): GenericRankProfile {
  if (json == null) throw new RankedTableError("ERR_RANKED_TABLE_NOT_CONFIGURED", "rank profile is missing");
  try {
    const parsed = JSON.parse(json) as GenericRankProfile;
    return {
      key: requiredString(parsed.key, "profile.key", 80),
      participantCount: safePositiveInt(parsed.participantCount, "profile.participantCount"),
      rankDeltaBps: parsed.rankDeltaBps,
    };
  } catch (error) {
    if (error instanceof RankedTableError) throw error;
    throw new RankedTableError("ERR_RANKED_BAD_PROFILE", "rank profile JSON is invalid");
  }
}

function parseResult(json: string): { orderedUserIds: string[] } {
  try {
    const parsed = JSON.parse(json) as { orderedUserIds?: unknown };
    if (!Array.isArray(parsed.orderedUserIds)) throw new Error("bad orderedUserIds");
    return { orderedUserIds: parsed.orderedUserIds.map((id) => requiredString(id, "orderedUserIds")) };
  } catch (error) {
    if (error instanceof RankedTableError) throw error;
    throw new RankedTableError("ERR_RANKED_RESULT_INVALID", "ranked result JSON is invalid");
  }
}

function resultHash(orderedUserIds: readonly string[]): string {
  return canonicalHash({ orderedUserIds });
}

function isActiveParticipant(participant: PersistentTableParticipantRow): boolean {
  return participant.participantState !== "declined";
}

function requiredString(value: unknown, field: string, maxLength = MAX_ID_LENGTH): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new RankedTableError("ERR_RANKED_OPERATION_CONFLICT", "ranked table string field is invalid", { field });
  }
  return value;
}

function safePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RankedTableError("ERR_RANKED_BAD_AMOUNT", "ranked table integer field is invalid", { field, value });
  }
  return value;
}

function checkedAdd(a: number, b: number, field: string): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) {
    throw new RankedTableError("ERR_RANKED_BAD_AMOUNT", "ranked table arithmetic overflow", { field, a, b });
  }
  return a + b;
}

export const rankedTableInternalsForTesting = {
  resultHash,
};
