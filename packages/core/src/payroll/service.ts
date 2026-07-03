import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import type { LedgerError } from "../ledger/errors.js";

export type PayrollErrorCode =
  | "ERR_INVALID_PERIOD"
  | "ERR_RUN_NOT_FOUND"
  | "ERR_INVALID_STATUS"
  | "ERR_INVALID_AMOUNT"
  | "ERR_EMPTY_PLAN";

export class PayrollError extends Error {
  constructor(
    readonly code: PayrollErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code} ${JSON.stringify(details)}`);
    this.name = "PayrollError";
  }
}

export interface SalaryRow {
  role_id: string;
  label: string;
  amount: number;
  updated_at: number;
}

export interface PlanBreakdown {
  roleId: string;
  label: string;
  amount: number;
}

export interface PlanItem {
  userId: string;
  breakdown: PlanBreakdown[];
  total: number;
}

export interface PayoutPlan {
  period: string;
  items: PlanItem[];
  totalPayout: number;
}

export type RunStatus = "draft" | "approved" | "executed" | "cancelled";

export interface PayoutRunRow {
  id: number;
  period: string;
  status: RunStatus;
  plan_json: string;
  report_json: string | null;
  created_by: string;
  approved_by: string | null;
  executed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemberRoles {
  userId: string;
  roleIds: string[];
}

export interface ExecutionReport {
  succeeded: number;
  skippedAsPaid: number;
  failed: Array<{ userId: string; code: string; details: Record<string, unknown> }>;
  totalPaid: number;
}

const now = () => Math.floor(Date.now() / 1000);
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 給与バッチ（経済設計.md §5）。
 * draft（計画スナップショット）→ approved（#決裁）→ executed の3段階。
 * 実行は1人ずつ冪等キー salary:<period>:user:<id> なので、途中で落ちても再実行すれば
 * 支給済みは自動スキップされ未支給分だけ実行される。
 */
export class Payroll {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
  ) {}

  // ---- 給料表（salary_table）----

  setSalary(roleId: string, label: string, amount: number, actor: string): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new PayrollError("ERR_INVALID_AMOUNT", { roleId, amount });
    }
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO salary_table (role_id, label, amount, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(role_id) DO UPDATE SET label = excluded.label, amount = excluded.amount, updated_at = excluded.updated_at`,
      )
      .run(roleId, label, amount, ts);
    this.db
      .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)")
      .run(JSON.stringify({ event: "salary_table_set", roleId, label, amount, actor }), ts);
  }

  removeSalary(roleId: string, actor: string): void {
    const ts = now();
    this.db.prepare("DELETE FROM salary_table WHERE role_id = ?").run(roleId);
    this.db
      .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)")
      .run(JSON.stringify({ event: "salary_table_remove", roleId, actor }), ts);
  }

  listSalaries(): SalaryRow[] {
    return this.db
      .prepare("SELECT * FROM salary_table ORDER BY amount DESC, role_id ASC")
      .all() as SalaryRow[];
  }

  // ---- 支給案（payout_runs）----

  /**
   * 支給計画を生成して plan_json に固定する。
   * members はアプリ層（Discord）から渡されるロール一覧。複数ロールは全額重複（決定事項）。
   * 同じ period の draft があれば作り直す。approved 以降なら拒否。
   */
  generateDraft(period: string, members: MemberRoles[], actor: string): PayoutRunRow {
    if (!PERIOD_RE.test(period)) throw new PayrollError("ERR_INVALID_PERIOD", { period });

    const salaries = new Map(this.listSalaries().map((s) => [s.role_id, s]));
    const items: PlanItem[] = [];
    for (const member of members) {
      const breakdown: PlanBreakdown[] = [];
      for (const roleId of member.roleIds) {
        const s = salaries.get(roleId);
        if (s && s.amount > 0) breakdown.push({ roleId: s.role_id, label: s.label, amount: s.amount });
      }
      if (breakdown.length === 0) continue;
      items.push({
        userId: member.userId,
        breakdown,
        total: breakdown.reduce((sum, b) => sum + b.amount, 0),
      });
    }
    if (items.length === 0) throw new PayrollError("ERR_EMPTY_PLAN", { period });

    const plan: PayoutPlan = {
      period,
      items,
      totalPayout: items.reduce((sum, i) => sum + i.total, 0),
    };

    const existing = this.getRunByPeriod(period);
    const ts = now();
    if (existing) {
      if (existing.status !== "draft") {
        throw new PayrollError("ERR_INVALID_STATUS", { period, status: existing.status });
      }
      this.db
        .prepare("UPDATE payout_runs SET plan_json = ?, created_by = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(plan), actor, ts, existing.id);
      return this.getRun(existing.id);
    }

    const inserted = this.db
      .prepare(
        `INSERT INTO payout_runs (period, status, plan_json, created_by, created_at, updated_at)
         VALUES (?, 'draft', ?, ?, ?, ?)`,
      )
      .run(period, JSON.stringify(plan), actor, ts, ts);
    return this.getRun(Number(inserted.lastInsertRowid));
  }

  getRun(id: number): PayoutRunRow {
    const row = this.db.prepare("SELECT * FROM payout_runs WHERE id = ?").get(id) as
      | PayoutRunRow
      | undefined;
    if (!row) throw new PayrollError("ERR_RUN_NOT_FOUND", { id });
    return row;
  }

  getRunByPeriod(period: string): PayoutRunRow | undefined {
    return this.db.prepare("SELECT * FROM payout_runs WHERE period = ?").get(period) as
      | PayoutRunRow
      | undefined;
  }

  planOf(run: PayoutRunRow): PayoutPlan {
    return JSON.parse(run.plan_json) as PayoutPlan;
  }

  approve(id: number, actor: string): PayoutRunRow {
    const run = this.getRun(id);
    if (run.status !== "draft") {
      throw new PayrollError("ERR_INVALID_STATUS", { id, status: run.status, expected: "draft" });
    }
    this.db
      .prepare("UPDATE payout_runs SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?")
      .run(actor, now(), id);
    return this.getRun(id);
  }

  cancel(id: number, actor: string): PayoutRunRow {
    const run = this.getRun(id);
    if (run.status === "executed") {
      throw new PayrollError("ERR_INVALID_STATUS", { id, status: run.status });
    }
    const ts = now();
    this.db
      .prepare("UPDATE payout_runs SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(ts, id);
    this.db
      .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)")
      .run(JSON.stringify({ event: "payout_cancelled", runId: id, actor }), ts);
    return this.getRun(id);
  }

  /**
   * 承認済みの支給案を実行する。1人=1取引・冪等。
   * 部分失敗（凍結口座など）はスキップして続行し、レポートに残す。
   * executed 済みへの再実行も安全（支給済みは skippedAsPaid になる）。
   */
  execute(id: number, actor: string): ExecutionReport {
    const run = this.getRun(id);
    if (run.status !== "approved" && run.status !== "executed") {
      throw new PayrollError("ERR_INVALID_STATUS", { id, status: run.status, expected: "approved" });
    }
    const plan = this.planOf(run);

    const report: ExecutionReport = { succeeded: 0, skippedAsPaid: 0, failed: [], totalPaid: 0 };
    for (const item of plan.items) {
      const accountId = `user:${item.userId}`;
      this.ledger.ensureAccount(accountId, "user");
      try {
        const result = this.ledger.transfer({
          from: TREASURY,
          to: accountId,
          amount: item.total,
          type: "salary",
          actor,
          reason: `${plan.period} 給与`,
          refType: "payout_run",
          refId: String(run.id),
          idempotencyKey: `salary:${plan.period}:user:${item.userId}`,
          // 支給案自体が承認済みなので、高額承認は run の承認者で通す（経済設計.md §4）
          approvedBy: run.approved_by ?? actor,
        });
        if (result.duplicate) {
          report.skippedAsPaid += 1;
        } else {
          report.succeeded += 1;
          report.totalPaid += item.total;
        }
      } catch (e) {
        const err = e as LedgerError;
        report.failed.push({
          userId: item.userId,
          code: err.code ?? "ERR_UNKNOWN",
          details: err.details ?? {},
        });
      }
    }

    const ts = now();
    this.db
      .prepare(
        "UPDATE payout_runs SET status = 'executed', report_json = ?, executed_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(report), ts, ts, id);
    this.db
      .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)")
      .run(JSON.stringify({ event: "payout_executed", runId: id, actor, report }), ts);
    return report;
  }
}
