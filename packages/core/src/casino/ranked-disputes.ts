import type Database from "better-sqlite3";
import type { EventLog } from "../events/service.js";
import { canonicalHash, canonicalStringify } from "./opening-canonical.js";
import { HOUSE_HOLDER, type ChipLedger } from "./chip-ledger.js";
import type { OpeningPhase } from "./chip-tx.js";
import { escrowHolderFor, type Escrow } from "./escrow.js";
import {
  PersistentTableError,
  type PersistentTableParticipantRow,
  type PersistentTableRow,
  type PersistentTableState,
  type PersistentTables,
} from "./persistent-tables.js";
import {
  RankedTableError,
  rankedReceipts,
  validateRankProfile,
  type GenericRankProfile,
  type RankedTableConfig,
} from "./ranked-tables.js";
import { HouseReservations } from "./reservations.js";
import { rankedFeeReservationKey, RANKED_FEE_RESERVATION_SCOPE } from "./ranked-fee-reservation.js";

export const RANKED_EVIDENCE_WINDOW_SEC = 72 * 60 * 60;

export const RANKED_MAIN_EVIDENCE_KINDS = ["screenshot", "history_url", "replay_id"] as const;
export const RANKED_SUPPORTING_EVIDENCE_KINDS = ["third_party_testimony", "table_vc_record"] as const;
export type RankedEvidenceKind = (typeof RANKED_MAIN_EVIDENCE_KINDS)[number] | (typeof RANKED_SUPPORTING_EVIDENCE_KINDS)[number];
export type RankedEvidenceClass = "main" | "supporting";
export type RankedEvidenceStorageStatus = "pending" | "stored" | "failed";
export type RankedResolutionKind = "ranked_result" | "refund_collateral" | "insufficient_evidence";
export type RankedFeeOutcome = "keep" | "fault_refund";

export type RankedDisputeErrorCode =
  | "ERR_DISPUTE_SCHEMA_INVALID"
  | "ERR_DISPUTE_NOT_FOUND"
  | "ERR_DISPUTE_NOT_OPEN"
  | "ERR_DISPUTE_DEADLINE_CLOSED"
  | "ERR_DISPUTE_EVIDENCE_INVALID"
  | "ERR_DISPUTE_EVIDENCE_CONFLICT"
  | "ERR_DISPUTE_ARBITRATOR_CONFLICT"
  | "ERR_DISPUTE_ARBITRATOR_REQUIRED"
  | "ERR_DISPUTE_RESOLUTION_CONFLICT"
  | "ERR_DISPUTE_INSUFFICIENT_EVIDENCE"
  | "ERR_DISPUTE_FEE_RESERVATION"
  | "ERR_DISPUTE_ESCROW_MISMATCH";

export class RankedDisputeError extends Error {
  constructor(
    readonly code: RankedDisputeErrorCode,
    message: string,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RankedDisputeError";
  }
}

export interface RankedDisputePublicStatus {
  tableId: string;
  evidenceDeadlineAt: number;
  evidenceClosedAt: number | null;
  assignedArbitratorId: string | null;
  resolutionKind: RankedResolutionKind | null;
  feeOutcome: RankedFeeOutcome | null;
  recordStats: boolean | null;
  publicSummary: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

export interface SubmitRankedEvidenceInput {
  tableId: string;
  submitterId: string;
  evidenceKind: RankedEvidenceKind;
  operationId: string;
  privateChannelId: string;
  privateMessageId: string;
  payloadDigest: string;
  attachmentName?: string | null;
  storageStatus?: RankedEvidenceStorageStatus;
}

export interface BeginRankedEvidenceSubmissionInput {
  tableId: string;
  submitterId: string;
  evidenceKind: RankedEvidenceKind;
  operationId: string;
  payloadDigest: string;
  attachmentName?: string | null;
}

export interface FinalizeRankedEvidenceStoredInput {
  operationId: string;
  privateChannelId: string;
  privateMessageId: string;
  metadata?: Record<string, unknown> | null;
}

export interface AssignRankedArbitratorInput {
  tableId: string;
  arbitratorId: string;
  assignedBy: string;
  operationId: string;
}

export interface ResolveRankedResultInput {
  tableId: string;
  actorId: string;
  orderedUserIds: readonly string[];
  feeOutcome: RankedFeeOutcome;
  recordStats: boolean;
  publicSummary: string;
  operationId: string;
}

export interface ResolveCollateralRefundInput {
  tableId: string;
  actorId: string;
  feeOutcome: RankedFeeOutcome;
  publicSummary: string;
  operationId: string;
}

interface RankedStorageRow {
  table_id: string;
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

interface DisputeRow {
  table_id: string;
  opened_at: number;
  trigger_reason: string;
  evidence_deadline_at: number;
  evidence_closed_at: number | null;
  assigned_arbitrator_id: string | null;
  assigned_by: string | null;
  assigned_at: number | null;
  assignment_operation_id: string | null;
  assignment_fingerprint: string | null;
  resolution_kind: RankedResolutionKind | null;
  fee_outcome: RankedFeeOutcome | null;
  record_stats: number | null;
  public_summary: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  resolution_operation_id: string | null;
  resolution_fingerprint: string | null;
  original_result_json: string | null;
  original_result_hash: string | null;
  original_result_submitted_by: string | null;
  original_result_submitted_at: number | null;
  phase: string | null;
  status: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  table_id: string;
  submitter_id: string;
  evidence_class: RankedEvidenceClass;
  evidence_kind: RankedEvidenceKind;
  private_channel_id: string | null;
  private_message_id: string | null;
  attachment_name: string | null;
  payload_digest: string;
  created_at: number;
  operation_id: string;
  fingerprint: string;
  storage_status: RankedEvidenceStorageStatus;
  metadata_json: string | null;
}

export interface RankedDisputesOptions {
  now?: () => number;
  onPlayerNet?: (userId: string, net: number) => void;
  openingPhase?: () => OpeningPhase;
}

export class RankedDisputes {
  private readonly now: () => number;
  private readonly onPlayerNet: (userId: string, net: number) => void;
  private readonly openingPhase: () => OpeningPhase;

  constructor(
    private readonly db: Database.Database,
    private readonly chips: ChipLedger,
    private readonly escrow: Escrow,
    private readonly persistentTables: PersistentTables,
    private readonly reservations: HouseReservations,
    private readonly events: EventLog,
    options: RankedDisputesOptions = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.onPlayerNet = options.onPlayerNet ?? (() => undefined);
    this.openingPhase = options.openingPhase ?? (() => "formal");
  }

  ensureSchemaForTesting(): void {
    this.ensureSchema();
  }

  openForTable(table: PersistentTableRow, reason: string): RankedDisputePublicStatus {
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const storage = this.requiredStorage(table.tableId);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO casino_table_disputes (
             table_id, opened_at, trigger_reason, evidence_deadline_at,
             original_result_json, original_result_hash, original_result_submitted_by, original_result_submitted_at,
             phase, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 'collecting_evidence')
           ON CONFLICT(table_id) DO UPDATE SET
             trigger_reason=excluded.trigger_reason,
             evidence_deadline_at=COALESCE(casino_table_disputes.evidence_deadline_at, excluded.evidence_deadline_at),
             original_result_json=COALESCE(casino_table_disputes.original_result_json, excluded.original_result_json),
             original_result_hash=COALESCE(casino_table_disputes.original_result_hash, excluded.original_result_hash),
             original_result_submitted_by=COALESCE(casino_table_disputes.original_result_submitted_by, excluded.original_result_submitted_by),
             original_result_submitted_at=COALESCE(casino_table_disputes.original_result_submitted_at, excluded.original_result_submitted_at)`,
        )
        .run(
          table.tableId,
          now,
          truncate(reason, 500),
          now + RANKED_EVIDENCE_WINDOW_SEC,
          storage.result_json,
          storage.result_hash,
          storage.result_submitted_by,
          storage.result_submitted_at,
        );
      return this.publicStatus(table.tableId)!;
    });
    return this.db.inTransaction ? tx() : tx.immediate();
  }

  submitEvidence(input: SubmitRankedEvidenceInput): { evidenceId: string; status: RankedEvidenceStorageStatus } {
    const begun = this.beginEvidenceSubmission({
      tableId: input.tableId,
      submitterId: input.submitterId,
      evidenceKind: input.evidenceKind,
      operationId: input.operationId,
      payloadDigest: input.payloadDigest,
      attachmentName: input.attachmentName ?? null,
    });
    const storageStatus = input.storageStatus ?? "stored";
    if (storageStatus === "failed") return this.markEvidenceFailed(input.operationId);
    if (storageStatus === "pending") return begun;
    return this.finalizeEvidenceStored({
      operationId: input.operationId,
      privateChannelId: input.privateChannelId,
      privateMessageId: input.privateMessageId,
      metadata: null,
    });
  }

  beginEvidenceSubmission(input: BeginRankedEvidenceSubmissionInput): { evidenceId: string; status: RankedEvidenceStorageStatus } {
    const safe = {
      tableId: requiredString(input.tableId, "tableId"),
      submitterId: requiredString(input.submitterId, "submitterId"),
      evidenceKind: evidenceKind(input.evidenceKind),
      operationId: requiredString(input.operationId, "operationId"),
      payloadDigest: requiredString(input.payloadDigest, "payloadDigest", 256),
      attachmentName: optionalString(input.attachmentName ?? null, "attachmentName", 200),
    };
    const klass = evidenceClass(safe.evidenceKind);
    const fingerprint = canonicalStringify({ ...safe, evidenceClass: klass });
    const evidenceId = `ev_${canonicalHash({ tableId: safe.tableId, operationId: safe.operationId }).slice(0, 24)}`;
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const replay = this.db.prepare("SELECT evidence_id, fingerprint, storage_status FROM casino_table_evidence WHERE operation_id=?").get(safe.operationId) as
        | { evidence_id: string; fingerprint: string; storage_status: RankedEvidenceStorageStatus }
        | undefined;
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new RankedDisputeError("ERR_DISPUTE_EVIDENCE_CONFLICT", "evidence operation replay conflict");
        return { evidenceId: replay.evidence_id, status: replay.storage_status };
      }
      const table = this.requireTable(safe.tableId);
      if (table.state !== "disputed") throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "table is not disputed", { tableId: safe.tableId, state: table.state });
      const dispute = this.requireDispute(safe.tableId);
      if (dispute.resolved_at !== null) throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "dispute is already resolved", { tableId: safe.tableId });
      if (dispute.evidence_closed_at !== null || dispute.evidence_deadline_at <= this.now()) {
        throw new RankedDisputeError("ERR_DISPUTE_DEADLINE_CLOSED", "evidence deadline is closed", { tableId: safe.tableId });
      }
      const active = this.activeParticipants(safe.tableId).map((p) => p.userId);
      if (safe.evidenceKind === "third_party_testimony" && active.includes(safe.submitterId)) {
        throw new RankedDisputeError("ERR_DISPUTE_EVIDENCE_INVALID", "participants cannot submit third-party testimony", { submitterId: safe.submitterId });
      }
      this.db
        .prepare(
          `INSERT INTO casino_table_evidence (
             evidence_id, table_id, submitter_id, evidence_class, evidence_kind,
             private_channel_id, private_message_id, attachment_name, payload_digest,
             created_at, operation_id, fingerprint, storage_status, metadata_json
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'pending', NULL)`,
        )
        .run(
          evidenceId,
          safe.tableId,
          safe.submitterId,
          klass,
          safe.evidenceKind,
          safe.attachmentName,
          safe.payloadDigest,
          this.now(),
          safe.operationId,
          fingerprint,
        );
      this.events.log("casino_ranked_evidence_submitted", {
        actor: safe.submitterId,
        target: safe.tableId,
        payload: { evidenceId, evidenceKind: safe.evidenceKind, evidenceClass: klass, storageStatus: "pending" },
      });
      return { evidenceId, status: "pending" as const };
    });
    return this.db.inTransaction ? tx() : tx.immediate();
  }

  finalizeEvidenceStored(input: FinalizeRankedEvidenceStoredInput): { evidenceId: string; status: RankedEvidenceStorageStatus } {
    const safe = {
      operationId: requiredString(input.operationId, "operationId"),
      privateChannelId: requiredString(input.privateChannelId, "privateChannelId"),
      privateMessageId: requiredString(input.privateMessageId, "privateMessageId"),
      metadataJson: input.metadata == null ? null : canonicalStringify(input.metadata),
    };
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const row = this.db.prepare("SELECT * FROM casino_table_evidence WHERE operation_id=?").get(safe.operationId) as EvidenceRow | undefined;
      if (!row) throw new RankedDisputeError("ERR_DISPUTE_NOT_FOUND", "evidence operation was not begun", { operationId: safe.operationId });
      const table = this.requireTable(row.table_id);
      if (table.state !== "disputed") throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "table is not disputed", { tableId: row.table_id, state: table.state });
      const dispute = this.requireDispute(row.table_id);
      if (dispute.resolved_at !== null) throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "dispute is already resolved", { tableId: row.table_id });
      if (dispute.evidence_closed_at !== null || dispute.evidence_deadline_at <= this.now()) {
        throw new RankedDisputeError("ERR_DISPUTE_DEADLINE_CLOSED", "evidence deadline is closed", { tableId: row.table_id });
      }
      if (row.storage_status === "stored") {
        if (row.private_channel_id !== safe.privateChannelId || row.private_message_id !== safe.privateMessageId) {
          throw new RankedDisputeError("ERR_DISPUTE_EVIDENCE_CONFLICT", "stored evidence replay conflict", { operationId: safe.operationId });
        }
        return { evidenceId: row.evidence_id, status: row.storage_status };
      }
      const changed = this.db
        .prepare(
          `UPDATE casino_table_evidence
             SET private_channel_id=?, private_message_id=?, metadata_json=?, storage_status='stored'
           WHERE operation_id=? AND storage_status IN ('pending','failed')`,
        )
        .run(safe.privateChannelId, safe.privateMessageId, safe.metadataJson, safe.operationId).changes;
      if (changed !== 1) throw new RankedDisputeError("ERR_DISPUTE_EVIDENCE_CONFLICT", "evidence finalize race", { operationId: safe.operationId });
      return { evidenceId: row.evidence_id, status: "stored" as const };
    });
    return this.db.inTransaction ? tx() : tx.immediate();
  }

  markEvidenceFailed(operationId: string): { evidenceId: string; status: RankedEvidenceStorageStatus } {
    const safeOperationId = requiredString(operationId, "operationId");
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const row = this.db.prepare("SELECT evidence_id, storage_status FROM casino_table_evidence WHERE operation_id=?").get(safeOperationId) as
        | { evidence_id: string; storage_status: RankedEvidenceStorageStatus }
        | undefined;
      if (!row) throw new RankedDisputeError("ERR_DISPUTE_NOT_FOUND", "evidence operation was not begun", { operationId: safeOperationId });
      if (row.storage_status !== "stored") {
        this.db.prepare("UPDATE casino_table_evidence SET storage_status='failed' WHERE operation_id=? AND storage_status!='stored'").run(safeOperationId);
      }
      const current = this.db.prepare("SELECT evidence_id, storage_status FROM casino_table_evidence WHERE operation_id=?").get(safeOperationId) as {
        evidence_id: string;
        storage_status: RankedEvidenceStorageStatus;
      };
      return { evidenceId: current.evidence_id, status: current.storage_status };
    });
    return this.db.inTransaction ? tx() : tx.immediate();
  }

  assignArbitrator(input: AssignRankedArbitratorInput): RankedDisputePublicStatus {
    const safe = {
      tableId: requiredString(input.tableId, "tableId"),
      arbitratorId: requiredString(input.arbitratorId, "arbitratorId"),
      assignedBy: requiredString(input.assignedBy, "assignedBy"),
      operationId: requiredString(input.operationId, "operationId"),
    };
    const fingerprint = canonicalStringify(safe);
    const tx = this.db.transaction(() => {
      this.ensureSchemaForFormal();
      const replay = this.db.prepare("SELECT fingerprint FROM casino_table_dispute_assignments WHERE operation_id=?").get(safe.operationId) as
        | { fingerprint: string }
        | undefined;
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new RankedDisputeError("ERR_DISPUTE_EVIDENCE_CONFLICT", "assignment operation replay conflict");
        return this.publicStatus(safe.tableId)!;
      }
      const dispute = this.requireDispute(safe.tableId);
      if (dispute.resolved_at !== null) throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "dispute is already resolved", { tableId: safe.tableId });
      const table = this.requireTable(safe.tableId);
      if (table.state !== "disputed") throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "table is not disputed", { tableId: safe.tableId, state: table.state });
      if (this.activeParticipants(safe.tableId).some((p) => p.userId === safe.arbitratorId)) {
        throw new RankedDisputeError("ERR_DISPUTE_ARBITRATOR_CONFLICT", "arbitrator is a table participant", { tableId: safe.tableId });
      }
      this.db
        .prepare(
          `INSERT INTO casino_table_dispute_assignments
             (operation_id, table_id, arbitrator_id, assigned_by, assigned_at, fingerprint)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(safe.operationId, safe.tableId, safe.arbitratorId, safe.assignedBy, this.now(), fingerprint);
      const changed = this.db
        .prepare(
          `UPDATE casino_table_disputes
             SET assigned_arbitrator_id=?, assigned_by=?, assigned_at=?, assignment_operation_id=?, assignment_fingerprint=?
           WHERE table_id=? AND resolved_at IS NULL`,
        )
        .run(safe.arbitratorId, safe.assignedBy, this.now(), safe.operationId, fingerprint, safe.tableId).changes;
      if (changed !== 1) throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "assignment race", { tableId: safe.tableId });
      this.events.log("casino_ranked_arbitrator_assigned", {
        actor: safe.assignedBy,
        target: safe.tableId,
        payload: { arbitratorId: safe.arbitratorId },
      });
      return this.publicStatus(safe.tableId)!;
    });
    return this.db.inTransaction ? tx() : tx.immediate();
  }

  resolveRankedResult(input: ResolveRankedResultInput): RankedDisputePublicStatus {
    const safe = {
      tableId: requiredString(input.tableId, "tableId"),
      actorId: requiredString(input.actorId, "actorId"),
      orderedUserIds: input.orderedUserIds.map((id) => requiredString(id, "orderedUserIds")),
      feeOutcome: feeOutcome(input.feeOutcome),
      recordStats: Boolean(input.recordStats),
      publicSummary: publicSummary(input.publicSummary),
      operationId: requiredString(input.operationId, "operationId"),
    };
    return this.resolveWithFingerprint("ranked_result", safe.operationId, safe.actorId, safe.tableId, canonicalStringify(safe), () => {
      this.assertAssignedArbitrator(safe.tableId, safe.actorId);
      if (!this.hasStoredMainEvidence(safe.tableId)) throw new RankedDisputeError("ERR_DISPUTE_INSUFFICIENT_EVIDENCE", "ranked result arbitration requires stored main evidence");
      const table = this.requireTable(safe.tableId);
      if (table.state !== "disputed") throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "table is not disputed", { state: table.state });
      const config = this.configFor(safe.tableId);
      this.validateRanking(safe.tableId, config, safe.orderedUserIds);
      const distributions = this.distributions(config, safe.orderedUserIds);
      this.assertEscrow(safe.tableId, config, distributions);
      const resultJson = canonicalStringify({ orderedUserIds: safe.orderedUserIds });
      const resultHash = canonicalHash({ orderedUserIds: safe.orderedUserIds });
      this.escrow.settle(safe.tableId, distributions, safe.actorId, "ranked arbitration settlement");
      this.applyFeeOutcome(safe.tableId, table.gameKey, config, safe.feeOutcome, safe.actorId);
      this.db
        .prepare(
          `UPDATE casino_tables
             SET result_json=?, result_hash=?, result_submitted_by=?, result_submitted_at=?, result_operation_id=?
           WHERE table_id=?`,
        )
        .run(resultJson, resultHash, safe.actorId, this.now(), `arbitration:${safe.operationId}`, safe.tableId);
      this.persistentTables.transition({
        tableId: safe.tableId,
        from: "disputed",
        to: "settled",
        expectedRevision: table.revision,
        actor: safe.actorId,
        reason: "ranked arbitration",
      });
      if (safe.recordStats) this.recordMatchHistory(safe.tableId, table.gameKey, config, resultJson, resultHash, "arbitration");
      this.saveResolution(safe.tableId, "ranked_result", safe.feeOutcome, safe.recordStats, safe.publicSummary, safe.actorId, safe.operationId, canonicalStringify(safe));
    });
  }

  resolveCollateralRefund(input: ResolveCollateralRefundInput): RankedDisputePublicStatus {
    const safe = {
      tableId: requiredString(input.tableId, "tableId"),
      actorId: requiredString(input.actorId, "actorId"),
      feeOutcome: feeOutcome(input.feeOutcome),
      publicSummary: publicSummary(input.publicSummary),
      operationId: requiredString(input.operationId, "operationId"),
    };
    return this.resolveWithFingerprint("refund_collateral", safe.operationId, safe.actorId, safe.tableId, canonicalStringify(safe), () => {
      this.assertAssignedArbitrator(safe.tableId, safe.actorId);
      const table = this.requireTable(safe.tableId);
      if (table.state !== "disputed") throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "table is not disputed", { state: table.state });
      this.refundCollateralAndFinalize(table, safe.actorId, safe.feeOutcome, safe.feeOutcome === "fault_refund" ? "cancelled_fault" : "cancelled_by_admin", "refund_collateral", safe.publicSummary, safe.operationId, canonicalStringify(safe));
    });
  }

  processEvidenceDeadlines(now = this.now()): { closed: number; autoRefunded: number; failed: number } {
    if (!this.hasSchema()) return { closed: 0, autoRefunded: 0, failed: 0 };
    const rows = this.db
      .prepare(
        `SELECT table_id FROM casino_table_disputes
          WHERE resolved_at IS NULL AND evidence_closed_at IS NULL AND evidence_deadline_at <= ?
          ORDER BY evidence_deadline_at, table_id`,
      )
      .all(now) as Array<{ table_id: string }>;
    let closed = 0;
    let autoRefunded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const closeTx = this.db.transaction((): "closed" | "needs_refund" | "skip" => {
          this.ensureSchemaForFormal();
          const table = this.requireTable(row.table_id);
          if (table.state !== "disputed") return "skip";
          const dispute = this.requireDispute(row.table_id);
          if (dispute.resolved_at !== null || dispute.evidence_closed_at !== null || dispute.evidence_deadline_at > now) return "skip";
          if (!this.hasStoredMainEvidence(row.table_id)) return "needs_refund";
          const changed = this.db
            .prepare(
              `UPDATE casino_table_disputes
                 SET evidence_closed_at=?, status='awaiting_arbitration'
               WHERE table_id=? AND resolved_at IS NULL AND evidence_closed_at IS NULL`,
            )
            .run(now, row.table_id).changes;
          if (changed !== 1) throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "evidence close race", { tableId: row.table_id });
          this.db.prepare("UPDATE casino_tables SET deadline_at=NULL, updated_at=? WHERE table_id=? AND state='disputed'").run(now, row.table_id);
          return "closed";
        });
        const closeResult = this.db.inTransaction ? closeTx() : closeTx.immediate();
        if (closeResult === "closed") {
          closed++;
          continue;
        }
        if (closeResult === "skip") continue;
        const dispute = this.requireDispute(row.table_id);
        const op = `evidence-timeout:${row.table_id}:${dispute.evidence_deadline_at}`;
        const fingerprint = canonicalStringify({ tableId: row.table_id, op, kind: "insufficient_evidence" });
        this.resolveWithFingerprint("insufficient_evidence", op, "system:ranked-evidence-timeout", row.table_id, fingerprint, () => {
          const current = this.requireTable(row.table_id);
          const currentDispute = this.requireDispute(row.table_id);
          if (current.state !== "disputed" || currentDispute.resolved_at !== null || currentDispute.evidence_closed_at !== null || currentDispute.evidence_deadline_at > now) {
            throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "deadline resolution race", { tableId: row.table_id });
          }
          if (this.hasStoredMainEvidence(row.table_id)) {
            throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "stored main evidence won the deadline race", { tableId: row.table_id });
          }
          this.refundCollateralAndFinalize(current, "system:ranked-evidence-timeout", "keep", "cancelled", "insufficient_evidence", "insufficient evidence", op, fingerprint);
        });
        autoRefunded++;
      } catch (e) {
        failed++;
        this.events.log("casino_ranked_dispute_deadline_failed", {
          actor: "system:ranked-evidence-timeout",
          target: row.table_id,
          payload: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    }
    return { closed, autoRefunded, failed };
  }

  publicStatus(tableId: string): RankedDisputePublicStatus | null {
    if (!this.hasSchema()) return null;
    const row = this.readDispute(tableId);
    if (!row) return null;
    return {
      tableId: row.table_id,
      evidenceDeadlineAt: row.evidence_deadline_at,
      evidenceClosedAt: row.evidence_closed_at,
      assignedArbitratorId: row.assigned_arbitrator_id,
      resolutionKind: row.resolution_kind,
      feeOutcome: row.fee_outcome,
      recordStats: row.record_stats === null ? null : row.record_stats === 1,
      publicSummary: row.public_summary,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
    };
  }

  recordUnanimousMatch(tableId: string, gameKey: string, config: RankedTableConfig, orderedUserIds: readonly string[]): void {
    this.ensureSchemaForFormal();
    const resultJson = canonicalStringify({ orderedUserIds });
    this.recordMatchHistory(tableId, gameKey, config, resultJson, canonicalHash({ orderedUserIds }), "unanimous");
  }

  private resolveWithFingerprint(kind: RankedResolutionKind, operationId: string, actor: string, tableId: string, fingerprint: string, body: () => void): RankedDisputePublicStatus {
    this.ensureSchemaForFormal();
    const existing = this.readDispute(tableId);
    if (existing?.resolution_operation_id === operationId) {
      if (existing.resolution_fingerprint !== fingerprint) throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "resolution operation replay conflict");
      return this.publicStatus(tableId)!;
    }
    const groupKind = fingerprint.includes('"feeOutcome":"fault_refund"') ? "table_fee_refund" : "table_settle";
    return this.chips.runGroup({ groupKey: `ranked:dispute:${tableId}:${operationId}`, kind: groupKind, actorId: actor }, () => {
      body();
      const resolved = this.requireDispute(tableId);
      if (resolved.resolution_kind !== kind || resolved.resolution_operation_id !== operationId) {
        throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "resolution did not persist");
      }
      return this.publicStatus(tableId)!;
    });
  }

  private refundCollateralAndFinalize(
    table: PersistentTableRow,
    actor: string,
    outcome: RankedFeeOutcome,
    terminal: PersistentTableState,
    kind: RankedResolutionKind,
    summary: string,
    operationId: string,
    fingerprint: string,
  ): void {
    if (this.isPreStartDispute(table)) {
      this.refundPreStartEscrow(table, actor, operationId);
      this.persistentTables.transition({
        tableId: table.tableId,
        from: "disputed",
        to: terminal,
        expectedRevision: table.revision,
        actor,
        reason: kind === "insufficient_evidence" ? "insufficient evidence" : "ranked pre-start collateral refund",
      });
      this.saveResolution(table.tableId, kind, "keep", false, summary, actor, operationId, fingerprint);
      return;
    }
    const config = this.configFor(table.tableId);
    const participants = this.activeParticipants(table.tableId).map((p) => p.userId);
    const distributions = participants.map((userId) => ({ to: userId, amount: config.baseAmount, reason: "ranked collateral refund" }));
    this.assertEscrow(table.tableId, config, distributions);
    this.escrow.settle(table.tableId, distributions, actor, "ranked collateral refund");
    this.applyFeeOutcome(table.tableId, table.gameKey, config, outcome, actor);
    this.persistentTables.transition({
      tableId: table.tableId,
      from: "disputed",
      to: terminal,
      expectedRevision: table.revision,
      actor,
      reason: kind === "insufficient_evidence" ? "insufficient evidence" : "ranked arbitration collateral refund",
    });
    this.saveResolution(table.tableId, kind, outcome, false, summary, actor, operationId, fingerprint);
  }

  private isPreStartDispute(table: PersistentTableRow): boolean {
    const storage = this.requiredStorage(table.tableId);
    return table.startedAt === null || storage.fee_committed_at === null;
  }

  private refundPreStartEscrow(table: PersistentTableRow, actor: string, operationId: string): void {
    const active = this.activeParticipants(table.tableId).map((p) => p.userId);
    const activeSet = new Set(active);
    const rows = this.escrow.list(table.tableId);
    if (rows.length !== active.length) {
      throw new RankedDisputeError("ERR_DISPUTE_ESCROW_MISMATCH", "pre-start escrow participant count mismatch", {
        tableId: table.tableId,
        rows: rows.length,
        active: active.length,
      });
    }
    const holder = escrowHolderFor(table.tableId);
    let total = 0;
    for (const row of rows) {
      if (!activeSet.has(row.user_id) || row.source !== holder || row.game !== table.gameKey || !Number.isSafeInteger(row.amount) || row.amount <= 0) {
        throw new RankedDisputeError("ERR_DISPUTE_ESCROW_MISMATCH", "pre-start escrow row mismatch", { tableId: table.tableId, row });
      }
      total += row.amount;
      if (!Number.isSafeInteger(total)) throw new RankedDisputeError("ERR_DISPUTE_ESCROW_MISMATCH", "pre-start escrow overflow", { tableId: table.tableId });
    }
    if (this.chips.balanceOf(holder) !== total) {
      throw new RankedDisputeError("ERR_DISPUTE_ESCROW_MISMATCH", "pre-start escrow holder mismatch", { tableId: table.tableId, total });
    }
    this.escrow.refundMany(table.tableId, active, `pre-start-dispute:${operationId}`);
    this.events.log("casino_ranked_pre_start_dispute_refunded", { actor, target: table.tableId, payload: { participants: active.length, total } });
  }

  private applyFeeOutcome(tableId: string, game: string, config: RankedTableConfig, outcome: RankedFeeOutcome, actor: string): void {
    const key = rankedFeeReservationKey(tableId);
    const expected = config.feePerUser * config.participantCount;
    const reservation = this.reservations.get(key);
    if (!reservation || reservation.amount !== expected || reservation.scope !== RANKED_FEE_RESERVATION_SCOPE || reservation.userId !== `table:${tableId}`) {
      throw new RankedDisputeError("ERR_DISPUTE_FEE_RESERVATION", "ranked fee reservation is missing or corrupt", { tableId, expected, reservation });
    }
    if (outcome === "fault_refund") {
      if (this.chips.balanceOf(HOUSE_HOLDER) < expected) {
        throw new RankedDisputeError("ERR_DISPUTE_FEE_RESERVATION", "house cannot cover ranked fee refund", { tableId, expected });
      }
      for (const userId of this.activeParticipants(tableId).map((p) => p.userId)) {
        this.chips.transfer(HOUSE_HOLDER, userId, config.feePerUser, { reason: "ranked table fault fee refund", game, sessionId: tableId });
        this.onPlayerNet(userId, config.feePerUser);
      }
    }
    this.reservations.release(key);
  }

  private saveResolution(
    tableId: string,
    kind: RankedResolutionKind,
    outcome: RankedFeeOutcome,
    recordStats: boolean,
    summary: string,
    actor: string,
    operationId: string,
    fingerprint: string,
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE casino_table_disputes
           SET resolution_kind=?, fee_outcome=?, record_stats=?, public_summary=?,
               resolved_by=?, resolved_at=?, resolution_operation_id=?, resolution_fingerprint=?,
               evidence_closed_at=COALESCE(evidence_closed_at, ?), phase='resolved', status=?
         WHERE table_id=? AND resolved_at IS NULL`,
      )
      .run(kind, outcome, recordStats ? 1 : 0, summary, actor, this.now(), operationId, fingerprint, this.now(), kind, tableId).changes;
    if (changed !== 1) throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "dispute resolution race", { tableId });
    this.db.prepare("UPDATE casino_tables SET deadline_at=NULL, updated_at=? WHERE table_id=?").run(this.now(), tableId);
    this.events.log("casino_ranked_dispute_resolved", {
      actor,
      target: tableId,
      payload: { resolutionKind: kind, feeOutcome: outcome, recordStats },
    });
  }

  private assertAssignedArbitrator(tableId: string, actor: string): void {
    const dispute = this.requireDispute(tableId);
    if (dispute.assigned_arbitrator_id !== actor) {
      throw new RankedDisputeError("ERR_DISPUTE_ARBITRATOR_REQUIRED", "only the assigned arbitrator can resolve the dispute", { tableId });
    }
    if (this.activeParticipants(tableId).some((p) => p.userId === actor)) {
      throw new RankedDisputeError("ERR_DISPUTE_ARBITRATOR_CONFLICT", "arbitrator is a table participant", { tableId });
    }
  }

  private hasStoredMainEvidence(tableId: string): boolean {
    if (!this.hasSchema()) return false;
    const row = this.db
      .prepare("SELECT 1 FROM casino_table_evidence WHERE table_id=? AND evidence_class='main' AND storage_status='stored' LIMIT 1")
      .get(tableId);
    return !!row;
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

  private distributions(config: RankedTableConfig, orderedUserIds: readonly string[]): Array<{ to: string; amount: number; reason: string }> {
    const receipts = rankedReceipts(config.profile, config.baseAmount);
    return orderedUserIds.map((userId, index) => ({ to: userId, amount: receipts[index]!, reason: "ranked arbitration distribution" }));
  }

  private assertEscrow(tableId: string, config: RankedTableConfig, distributions: ReadonlyArray<{ to: string; amount: number }>): void {
    const expected = config.baseAmount * config.participantCount;
    const ledger = this.escrow.poolOf(tableId);
    const holder = this.chips.balanceOf(escrowHolderFor(tableId));
    const total = distributions.reduce((sum, d) => sum + d.amount, 0);
    if (ledger !== expected || holder !== expected || total !== expected) {
      throw new RankedDisputeError("ERR_DISPUTE_ESCROW_MISMATCH", "ranked dispute escrow mismatch", { tableId, ledger, holder, total, expected });
    }
  }

  private configFor(tableId: string): RankedTableConfig {
    const storage = this.requiredStorage(tableId);
    if (storage.base_amount == null || storage.fee_per_user == null || storage.participant_count == null || storage.rank_profile_json == null) {
      throw new RankedTableError("ERR_RANKED_TABLE_NOT_CONFIGURED", "persistent table is missing ranked configuration", { tableId });
    }
    const parsed = JSON.parse(storage.rank_profile_json) as GenericRankProfile;
    const config = validateRankProfile(parsed, storage.base_amount);
    if (config.feePerUser !== storage.fee_per_user || config.participantCount !== storage.participant_count) {
      throw new RankedTableError("ERR_RANKED_TABLE_NOT_CONFIGURED", "ranked table stored config is inconsistent", { tableId });
    }
    return config;
  }

  private recordMatchHistory(tableId: string, gameKey: string, config: RankedTableConfig, resultJson: string, resultHash: string, source: "unanimous" | "arbitration"): void {
    this.ensureSchemaForFormal();
    this.db
      .prepare(
        `INSERT INTO casino_ranked_match_history
           (table_id, game_key, base_amount, final_result_json, final_result_hash, source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(table_id) DO NOTHING`,
      )
      .run(tableId, gameKey, config.baseAmount, resultJson, resultHash, source, this.now());
  }

  private requireTable(tableId: string): PersistentTableRow {
    const table = this.persistentTables.get(tableId);
    if (!table) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
    return table;
  }

  private activeParticipants(tableId: string): PersistentTableParticipantRow[] {
    return this.persistentTables.participants(tableId).filter((p) => p.participantState !== "declined");
  }

  private requiredStorage(tableId: string): RankedStorageRow {
    const row = this.db.prepare("SELECT * FROM casino_tables WHERE table_id=?").get(tableId) as RankedStorageRow | undefined;
    if (!row) throw new PersistentTableError("ERR_TABLE_NOT_FOUND", "persistent table does not exist", { tableId });
    return row;
  }

  private requireDispute(tableId: string): DisputeRow {
    const row = this.readDispute(tableId);
    if (!row) throw new RankedDisputeError("ERR_DISPUTE_NOT_FOUND", "ranked dispute does not exist", { tableId });
    return row;
  }

  private readDispute(tableId: string): DisputeRow | null {
    if (!this.hasSchema()) return null;
    return (this.db.prepare("SELECT * FROM casino_table_disputes WHERE table_id=?").get(tableId) as DisputeRow | undefined) ?? null;
  }

  private ensureSchema(): void {
    const state = this.schemaState();
    if (state === "invalid") throw new RankedDisputeError("ERR_DISPUTE_SCHEMA_INVALID", "ranked dispute schema is partially present or missing required columns");
    if (state === "complete") {
      this.migrateSchema();
      return;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_table_disputes (
        table_id TEXT PRIMARY KEY,
        opened_at INTEGER NOT NULL,
        trigger_reason TEXT NOT NULL,
        evidence_deadline_at INTEGER NOT NULL,
        evidence_closed_at INTEGER,
        assigned_arbitrator_id TEXT,
        assigned_by TEXT,
        assigned_at INTEGER,
        assignment_operation_id TEXT UNIQUE,
        assignment_fingerprint TEXT,
        resolution_kind TEXT CHECK(resolution_kind IN ('ranked_result','refund_collateral','insufficient_evidence')),
        fee_outcome TEXT CHECK(fee_outcome IN ('keep','fault_refund')),
        record_stats INTEGER CHECK(record_stats IN (0,1)),
        public_summary TEXT,
        resolved_by TEXT,
        resolved_at INTEGER,
        resolution_operation_id TEXT UNIQUE,
        resolution_fingerprint TEXT,
        original_result_json TEXT,
        original_result_hash TEXT,
        original_result_submitted_by TEXT,
        original_result_submitted_at INTEGER,
        phase TEXT,
        status TEXT,
        FOREIGN KEY(table_id) REFERENCES casino_tables(table_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS casino_table_dispute_assignments (
        operation_id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL,
        arbitrator_id TEXT NOT NULL,
        assigned_by TEXT NOT NULL,
        assigned_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        FOREIGN KEY(table_id) REFERENCES casino_table_disputes(table_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_casino_table_dispute_assignments_table
        ON casino_table_dispute_assignments(table_id, assigned_at);
      CREATE TABLE IF NOT EXISTS casino_table_evidence (
        evidence_id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL,
        submitter_id TEXT NOT NULL,
        evidence_class TEXT NOT NULL CHECK(evidence_class IN ('main','supporting')),
        evidence_kind TEXT NOT NULL,
        private_channel_id TEXT,
        private_message_id TEXT,
        attachment_name TEXT,
        payload_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        storage_status TEXT NOT NULL CHECK(storage_status IN ('pending','stored','failed')),
        metadata_json TEXT,
        FOREIGN KEY(table_id) REFERENCES casino_table_disputes(table_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_casino_table_evidence_table ON casino_table_evidence(table_id, evidence_class, storage_status);
    `);
    this.ensureMatchHistorySchema();
  }

  private ensureSchemaForFormal(): void {
    const phase = this.openingPhase();
    if (phase !== "formal") {
      throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "ranked disputes are only writable after formal opening", { phase });
    }
    this.ensureSchema();
  }

  private ensureMatchHistorySchemaForFormal(): void {
    const phase = this.openingPhase();
    if (phase !== "formal") {
      throw new RankedDisputeError("ERR_DISPUTE_NOT_OPEN", "ranked match history is only writable after formal opening", { phase });
    }
    this.ensureMatchHistorySchema();
  }

  private ensureMatchHistorySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_ranked_match_history (
        table_id TEXT PRIMARY KEY,
        game_key TEXT NOT NULL,
        base_amount INTEGER NOT NULL,
        final_result_json TEXT NOT NULL,
        final_result_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('unanimous','arbitration')),
        recorded_at INTEGER NOT NULL
      );
    `);
  }

  private hasSchema(): boolean {
    const state = this.schemaState();
    if (state === "none") return false;
    if (state === "complete") return true;
    throw new RankedDisputeError("ERR_DISPUTE_SCHEMA_INVALID", "ranked dispute schema is partially present");
  }

  private schemaState(): "none" | "complete" | "invalid" {
    const tables = ["casino_table_disputes", "casino_table_evidence", "casino_ranked_match_history", "casino_table_dispute_assignments"];
    const exists = tables.map((table) => tableExists(this.db, table));
    if (exists.every((value) => !value)) return "none";
    if (!exists.every(Boolean)) return "invalid";
    const required: Record<string, string[]> = {
      casino_table_disputes: ["table_id", "evidence_deadline_at", "evidence_closed_at", "resolved_at", "resolution_operation_id"],
      casino_table_evidence: ["evidence_id", "table_id", "operation_id", "fingerprint", "storage_status", "private_channel_id", "private_message_id"],
      casino_ranked_match_history: ["table_id", "final_result_json", "final_result_hash", "source"],
      casino_table_dispute_assignments: ["operation_id", "table_id", "arbitrator_id", "assigned_by", "fingerprint"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const present = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
      if (columns.some((column) => !present.has(column))) return "invalid";
    }
    return "complete";
  }

  private migrateSchema(): void {
    this.addColumnIfMissing("casino_table_evidence", "metadata_json", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, spec: string): void {
    const columns = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  }
}

function evidenceKind(kind: string): RankedEvidenceKind {
  if ((RANKED_MAIN_EVIDENCE_KINDS as readonly string[]).includes(kind) || (RANKED_SUPPORTING_EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    return kind as RankedEvidenceKind;
  }
  throw new RankedDisputeError("ERR_DISPUTE_EVIDENCE_INVALID", "unknown evidence kind", { kind });
}

function evidenceClass(kind: RankedEvidenceKind): RankedEvidenceClass {
  return (RANKED_MAIN_EVIDENCE_KINDS as readonly string[]).includes(kind) ? "main" : "supporting";
}

function feeOutcome(outcome: string): RankedFeeOutcome {
  if (outcome === "keep" || outcome === "fault_refund") return outcome;
  throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "unknown fee outcome", { outcome });
}

function publicSummary(summary: string): string {
  const trimmed = requiredString(summary, "publicSummary", 300).trim();
  if (!trimmed) throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "public summary is required");
  if (/https?:\/\//i.test(trimmed) || /discord(?:app)?\.com\/attachments/i.test(trimmed) || /\breplay[_ -]?id\b/i.test(trimmed)) {
    throw new RankedDisputeError("ERR_DISPUTE_RESOLUTION_CONFLICT", "public summary must not contain raw evidence, URLs, or replay IDs");
  }
  return trimmed;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function requiredString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new RankedDisputeError("ERR_DISPUTE_EVIDENCE_INVALID", "string field is invalid", { field });
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength = 200): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field, maxLength);
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
