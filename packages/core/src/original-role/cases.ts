import type Database from "better-sqlite3";
import type { EventLog } from "../events/service.js";
import type { OriginalRoleRow } from "./service.js";
import { Settings } from "../settings/service.js";

export const ORIGINAL_ROLE_TICKET_PANEL_ID = "original_role";
export const ORIGINAL_ROLE_NEW_BASELINE_LAND = 750_000;
export const ORIGINAL_ROLE_CONTINUATION_BASELINE_LAND = 250_000;

export type OriginalRoleInvoiceKind = "new" | "continuation" | "restart" | "exception";
export type OriginalRoleInvoiceStatus = "pending" | "paid" | "cancelled";

export interface OriginalRoleCaseRow {
  id: number;
  ticket_thread_id: string;
  user_id: string;
  original_role_id: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface OriginalRoleInvoiceRow {
  id: number;
  case_id: number;
  user_id: string;
  kind: OriginalRoleInvoiceKind;
  amount: number;
  reason: string | null;
  status: OriginalRoleInvoiceStatus;
  issued_by: string;
  issued_at: number;
  paid_by: string | null;
  paid_at: number | null;
  purchase_id: number | null;
  transaction_id: number | null;
  cancelled_by: string | null;
  cancelled_at: number | null;
}

export type OriginalRoleCaseErrorCode =
  | "ERR_CASE_NOT_FOUND"
  | "ERR_TICKET_NOT_ORIGINAL_ROLE"
  | "ERR_TICKET_OWNER_MISMATCH"
  | "ERR_CASE_ALREADY_LINKED"
  | "ERR_ROLE_NOT_LINKABLE"
  | "ERR_PENDING_INVOICE_EXISTS"
  | "ERR_INVOICE_NOT_FOUND"
  | "ERR_INVOICE_NOT_PENDING"
  | "ERR_INVOICE_OWNER_MISMATCH"
  | "ERR_INVALID_INVOICE_AMOUNT"
  | "ERR_INVOICE_NEEDS_APPROVAL"
  | "ERR_EXCEPTION_REASON_REQUIRED";

export class OriginalRoleCaseError extends Error {
  constructor(readonly code: OriginalRoleCaseErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "OriginalRoleCaseError";
  }
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * オリジナルロールの「カルテ」と請求の正本。
 *
 * original_roles は既存契約・実Discordロールの互換台帳として残し、
 * このクラスは「どの専用チケットで対応しているか」「スタッフが何の意味で
 * いくら請求したか」を別に保存する。金額から請求種別を推測しない。
 */
export class OriginalRoleCases {
  private readonly settings: Settings;

  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
  ) {
    this.settings = new Settings(db);
  }

  get(id: number): OriginalRoleCaseRow | undefined {
    return this.db.prepare("SELECT * FROM original_role_cases WHERE id = ?").get(id) as OriginalRoleCaseRow | undefined;
  }

  byTicket(threadId: string): OriginalRoleCaseRow | undefined {
    return this.db.prepare("SELECT * FROM original_role_cases WHERE ticket_thread_id = ?").get(threadId) as OriginalRoleCaseRow | undefined;
  }

  listByUser(userId: string): OriginalRoleCaseRow[] {
    return this.db.prepare("SELECT * FROM original_role_cases WHERE user_id = ? ORDER BY id").all(userId) as OriginalRoleCaseRow[];
  }

  ensureCase(threadId: string, userId: string, actor: string): OriginalRoleCaseRow {
    const existing = this.byTicket(threadId);
    if (existing) {
      if (existing.user_id !== userId) throw new OriginalRoleCaseError("ERR_TICKET_OWNER_MISMATCH");
      return existing;
    }
    const ticket = this.db.prepare("SELECT user_id, panel_id FROM tickets WHERE thread_id = ?").get(threadId) as
      | { user_id: string; panel_id: string | null }
      | undefined;
    if (!ticket || ticket.panel_id !== ORIGINAL_ROLE_TICKET_PANEL_ID) {
      throw new OriginalRoleCaseError("ERR_TICKET_NOT_ORIGINAL_ROLE", { threadId });
    }
    if (ticket.user_id !== userId) throw new OriginalRoleCaseError("ERR_TICKET_OWNER_MISMATCH", { threadId, userId });
    const ts = now();
    const info = this.db.prepare(
      `INSERT INTO original_role_cases
       (ticket_thread_id, user_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(threadId, userId, actor, ts, ts);
    const row = this.get(Number(info.lastInsertRowid))!;
    this.events.log("original_role_case_created", { actor, target: userId, payload: { caseId: row.id, threadId } });
    return row;
  }

  linkedOriginalRole(caseId: number): OriginalRoleRow | undefined {
    return this.db.prepare(
      `SELECT r.* FROM original_roles r
       JOIN original_role_cases c ON c.original_role_id = r.id
       WHERE c.id = ?`,
    ).get(caseId) as OriginalRoleRow | undefined;
  }

  linkableOriginalRoles(userId: string): OriginalRoleRow[] {
    return this.db.prepare(
      `SELECT r.* FROM original_roles r
       LEFT JOIN original_role_cases c ON c.original_role_id = r.id
       WHERE r.user_id = ?
         AND c.id IS NULL
         AND r.status IN ('active','expired')
       ORDER BY r.id`,
    ).all(userId) as OriginalRoleRow[];
  }

  linkOriginalRole(caseId: number, originalRoleId: number, actor: string): OriginalRoleCaseRow {
    const serviceCase = this.get(caseId);
    if (!serviceCase) throw new OriginalRoleCaseError("ERR_CASE_NOT_FOUND", { caseId });
    if (serviceCase.original_role_id !== null) throw new OriginalRoleCaseError("ERR_CASE_ALREADY_LINKED", { caseId });
    const role = this.db.prepare("SELECT * FROM original_roles WHERE id = ?").get(originalRoleId) as OriginalRoleRow | undefined;
    if (!role || role.user_id !== serviceCase.user_id || !["active", "expired"].includes(role.status)) {
      throw new OriginalRoleCaseError("ERR_ROLE_NOT_LINKABLE", { caseId, originalRoleId });
    }
    try {
      const changed = this.db.prepare(
        "UPDATE original_role_cases SET original_role_id = ?, updated_at = ? WHERE id = ? AND original_role_id IS NULL",
      ).run(originalRoleId, now(), caseId);
      if (changed.changes !== 1) throw new OriginalRoleCaseError("ERR_CASE_ALREADY_LINKED", { caseId });
    } catch (error) {
      if (error instanceof OriginalRoleCaseError) throw error;
      throw new OriginalRoleCaseError("ERR_ROLE_NOT_LINKABLE", { caseId, originalRoleId });
    }
    this.events.log("original_role_case_linked", {
      actor,
      target: serviceCase.user_id,
      payload: { caseId, originalRoleId, roleId: role.role_id },
    });
    return this.get(caseId)!;
  }

  invoice(id: number): OriginalRoleInvoiceRow | undefined {
    return this.db.prepare("SELECT * FROM original_role_invoices WHERE id = ?").get(id) as OriginalRoleInvoiceRow | undefined;
  }

  invoicesForCase(caseId: number): OriginalRoleInvoiceRow[] {
    return this.db.prepare("SELECT * FROM original_role_invoices WHERE case_id = ? ORDER BY id").all(caseId) as OriginalRoleInvoiceRow[];
  }

  pendingInvoiceByCase(caseId: number): OriginalRoleInvoiceRow | undefined {
    return this.db.prepare("SELECT * FROM original_role_invoices WHERE case_id = ? AND status = 'pending'").get(caseId) as OriginalRoleInvoiceRow | undefined;
  }

  pendingInvoiceByTicket(threadId: string): OriginalRoleInvoiceRow | undefined {
    return this.db.prepare(
      `SELECT i.* FROM original_role_invoices i
       JOIN original_role_cases c ON c.id = i.case_id
       WHERE c.ticket_thread_id = ? AND i.status = 'pending'`,
    ).get(threadId) as OriginalRoleInvoiceRow | undefined;
  }

  issueInvoice(input: {
    threadId: string;
    kind: OriginalRoleInvoiceKind;
    amount: number;
    reason?: string | null;
    actor: string;
  }): OriginalRoleInvoiceRow {
    const serviceCase = this.byTicket(input.threadId);
    if (!serviceCase) throw new OriginalRoleCaseError("ERR_CASE_NOT_FOUND", { threadId: input.threadId });
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
      throw new OriginalRoleCaseError("ERR_INVALID_INVOICE_AMOUNT", { amount: input.amount });
    }
    const reason = input.reason?.trim() || null;
    if (input.kind === "exception" && !reason) throw new OriginalRoleCaseError("ERR_EXCEPTION_REASON_REQUIRED");
    const approvalThreshold = this.settings.getNumber("approval_threshold");
    // Ledger.transfer と同じ境界: threshold ちょうどは承認不要、超過だけ承認必須。
    // この請求フローには approvedBy を渡す経路を作らないため、支払不能なpending invoiceを先に作らない。
    if (input.amount > approvalThreshold) {
      throw new OriginalRoleCaseError("ERR_INVOICE_NEEDS_APPROVAL", {
        amount: input.amount,
        threshold: approvalThreshold,
      });
    }
    if (this.pendingInvoiceByCase(serviceCase.id)) {
      throw new OriginalRoleCaseError("ERR_PENDING_INVOICE_EXISTS", { caseId: serviceCase.id });
    }
    const ts = now();
    let info;
    try {
      info = this.db.prepare(
        `INSERT INTO original_role_invoices
         (case_id, user_id, kind, amount, reason, status, issued_by, issued_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(serviceCase.id, serviceCase.user_id, input.kind, input.amount, reason, input.actor, ts);
    } catch {
      throw new OriginalRoleCaseError("ERR_PENDING_INVOICE_EXISTS", { caseId: serviceCase.id });
    }
    const invoice = this.invoice(Number(info.lastInsertRowid))!;
    this.events.log("original_role_invoice_issued", {
      actor: input.actor,
      target: serviceCase.user_id,
      payload: { caseId: serviceCase.id, invoiceId: invoice.id, kind: invoice.kind, amount: invoice.amount, reason },
    });
    return invoice;
  }

  assertPayable(invoiceId: number, userId: string): OriginalRoleInvoiceRow {
    const invoice = this.invoice(invoiceId);
    if (!invoice) throw new OriginalRoleCaseError("ERR_INVOICE_NOT_FOUND", { invoiceId });
    if (invoice.user_id !== userId) throw new OriginalRoleCaseError("ERR_INVOICE_OWNER_MISMATCH", { invoiceId, userId });
    if (invoice.status !== "pending") throw new OriginalRoleCaseError("ERR_INVOICE_NOT_PENDING", { invoiceId, status: invoice.status });
    return invoice;
  }

  cancelInvoice(invoiceId: number, actor: string): OriginalRoleInvoiceRow {
    const invoice = this.invoice(invoiceId);
    if (!invoice) throw new OriginalRoleCaseError("ERR_INVOICE_NOT_FOUND", { invoiceId });
    if (invoice.status !== "pending") throw new OriginalRoleCaseError("ERR_INVOICE_NOT_PENDING", { invoiceId, status: invoice.status });
    const ts = now();
    this.db.prepare(
      `UPDATE original_role_invoices
       SET status='cancelled', cancelled_by=?, cancelled_at=?
       WHERE id=? AND status='pending'`,
    ).run(actor, ts, invoiceId);
    this.events.log("original_role_invoice_cancelled", {
      actor,
      target: invoice.user_id,
      payload: { invoiceId, caseId: invoice.case_id, kind: invoice.kind, amount: invoice.amount },
    });
    return this.invoice(invoiceId)!;
  }
}
