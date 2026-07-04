import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import type { LedgerError } from "../ledger/errors.js";

/**
 * 財政バッチ（経済設計.md §4）: 冥府税（高額残高への課税＝回収）と魂の年金（長期給付）。
 * 給与と同じ draft → approved（#決裁）→ executed の3段階。可逆性要件のためプレビュー承認必須。
 *   冥府税: 住人 → 国庫（tax）。閾値超の超過分に税率をかける（実質累進）。
 *   年金:   国庫 → 住人（pension）。在城日数が下限を超えた魂へ定額。
 */

export type FiscalKind = "tax" | "pension";
export type FiscalStatus = "draft" | "approved" | "executed" | "cancelled";

export type FiscalErrorCode = "ERR_RUN_NOT_FOUND" | "ERR_INVALID_STATUS" | "ERR_EMPTY_PLAN";

export class FiscalError extends Error {
  constructor(
    readonly code: FiscalErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "FiscalError";
  }
}

export interface FiscalPlanItem {
  userId: string;
  amount: number;
  detail: string; // 内訳（残高や在城日数）
}

export interface FiscalPlan {
  kind: FiscalKind;
  period: string;
  params: Record<string, number>;
  items: FiscalPlanItem[];
  total: number;
}

export interface FiscalRunRow {
  id: number;
  kind: FiscalKind;
  period: string;
  status: FiscalStatus;
  plan_json: string;
  report_json: string | null;
  created_by: string;
  approved_by: string | null;
  executed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface FiscalReport {
  succeeded: number;
  skippedAsDone: number;
  failed: Array<{ userId: string; code: string }>;
  total: number;
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

export class Fiscal {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
  ) {}

  // ---- 課税・給付案の生成 ----

  /** 冥府税の案: 残高が threshold を超える住人に、超過分×rateBps を課す */
  generateTaxDraft(period: string, params: { threshold: number; rateBps: number }, actor: string): FiscalRunRow {
    const items: FiscalPlanItem[] = [];
    for (const { userId, balance } of this.ledger.userBalancesAbove(params.threshold)) {
      const tax = Math.floor(((balance - params.threshold) * params.rateBps) / 10_000);
      if (tax > 0) items.push({ userId, amount: tax, detail: `残高 ${balance.toLocaleString()}` });
    }
    return this.saveDraft("tax", period, { threshold: params.threshold, rateBps: params.rateBps }, items, actor);
  }

  /** 年金の案: 在城（ghost_at 起算）が minDays を超えた魂へ定額 amount */
  generatePensionDraft(period: string, params: { minDays: number; amount: number }, actor: string): FiscalRunRow {
    const cutoff = now() - params.minDays * DAY;
    const rows = this.db
      .prepare(
        `SELECT user_id, ghost_at FROM souls
         WHERE ghost_at IS NOT NULL AND ghost_at <= ? AND status IN ('ghost','majin','mazoku')
         ORDER BY ghost_at ASC`,
      )
      .all(cutoff) as Array<{ user_id: string; ghost_at: number }>;
    const items: FiscalPlanItem[] = rows.map((r) => ({
      userId: r.user_id,
      amount: params.amount,
      detail: `在城 ${Math.floor((now() - r.ghost_at) / DAY)}日`,
    }));
    return this.saveDraft("pension", period, { minDays: params.minDays, amount: params.amount }, items, actor);
  }

  private saveDraft(kind: FiscalKind, period: string, params: Record<string, number>, items: FiscalPlanItem[], actor: string): FiscalRunRow {
    if (items.length === 0) throw new FiscalError("ERR_EMPTY_PLAN", { kind, period });
    const plan: FiscalPlan = { kind, period, params, items, total: items.reduce((s, i) => s + i.amount, 0) };
    const ts = now();
    const existing = this.getByKindPeriod(kind, period);
    if (existing) {
      if (existing.status !== "draft") throw new FiscalError("ERR_INVALID_STATUS", { kind, period, status: existing.status });
      this.db.prepare("UPDATE fiscal_runs SET plan_json = ?, created_by = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(plan), actor, ts, existing.id);
      return this.get(existing.id);
    }
    const info = this.db
      .prepare(`INSERT INTO fiscal_runs (kind, period, status, plan_json, created_by, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)`)
      .run(kind, period, JSON.stringify(plan), actor, ts, ts);
    return this.get(Number(info.lastInsertRowid));
  }

  // ---- 参照・状態遷移 ----

  get(id: number): FiscalRunRow {
    const row = this.db.prepare("SELECT * FROM fiscal_runs WHERE id = ?").get(id) as FiscalRunRow | undefined;
    if (!row) throw new FiscalError("ERR_RUN_NOT_FOUND", { id });
    return row;
  }
  getByKindPeriod(kind: FiscalKind, period: string): FiscalRunRow | undefined {
    return this.db.prepare("SELECT * FROM fiscal_runs WHERE kind = ? AND period = ?").get(kind, period) as FiscalRunRow | undefined;
  }
  planOf(run: FiscalRunRow): FiscalPlan {
    return JSON.parse(run.plan_json) as FiscalPlan;
  }

  approve(id: number, actor: string): FiscalRunRow {
    const run = this.get(id);
    if (run.status !== "draft") throw new FiscalError("ERR_INVALID_STATUS", { id, status: run.status });
    this.db.prepare("UPDATE fiscal_runs SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?").run(actor, now(), id);
    return this.get(id);
  }
  cancel(id: number, actor: string): FiscalRunRow {
    const run = this.get(id);
    if (run.status === "executed") throw new FiscalError("ERR_INVALID_STATUS", { id, status: run.status });
    const ts = now();
    this.db.prepare("UPDATE fiscal_runs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(ts, id);
    this.db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)").run(JSON.stringify({ event: "fiscal_cancelled", runId: id, actor }), ts);
    return this.get(id);
  }

  /** 承認済みの案を実行。1人=1取引・冪等。部分失敗はスキップしてレポートに残す */
  execute(id: number, actor: string): FiscalReport {
    const run = this.get(id);
    if (run.status !== "approved" && run.status !== "executed") throw new FiscalError("ERR_INVALID_STATUS", { id, status: run.status });
    const plan = this.planOf(run);
    const isTax = plan.kind === "tax";
    const report: FiscalReport = { succeeded: 0, skippedAsDone: 0, failed: [], total: 0 };

    for (const item of plan.items) {
      const account = `user:${item.userId}`;
      this.ledger.ensureAccount(account, "user");
      try {
        const result = this.ledger.transfer({
          from: isTax ? account : TREASURY,
          to: isTax ? TREASURY : account,
          amount: item.amount,
          type: isTax ? "tax" : "pension",
          actor,
          reason: `${plan.period} ${isTax ? "冥府税" : "魂の年金"}`,
          refType: "fiscal_run",
          refId: String(run.id),
          idempotencyKey: `${plan.kind}:${plan.period}:user:${item.userId}`,
          approvedBy: run.approved_by ?? actor,
        });
        if (result.duplicate) report.skippedAsDone += 1;
        else {
          report.succeeded += 1;
          report.total += item.amount;
        }
      } catch (e) {
        report.failed.push({ userId: item.userId, code: (e as LedgerError).code ?? "ERR_UNKNOWN" });
      }
    }

    const ts = now();
    this.db.prepare("UPDATE fiscal_runs SET status = 'executed', report_json = ?, executed_at = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(report), ts, ts, id);
    this.db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)").run(JSON.stringify({ event: "fiscal_executed", runId: id, actor, report }), ts);
    return report;
  }
}
