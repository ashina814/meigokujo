import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import type { LedgerError } from "../ledger/errors.js";
import type { ParsedDump } from "./parse.js";

export type MigrationErrorCode = "ERR_ROW_NOT_FOUND" | "ERR_NO_USER" | "ERR_BAD_STATUS";

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code} ${JSON.stringify(details)}`);
    this.name = "MigrationError";
  }
}

export type StagingStatus =
  | "auto" // 一意に照合できた・キャップ以下 → そのまま実行対象
  | "ambiguous" // 同名が複数（ダンプ内 or メンバー内）→ /移行 割当 が必要
  | "over_cap" // キャップ超過 → /移行 承認 が必要（運営協議の結果を反映）
  | "unmatched" // 該当メンバーが見つからない → /移行 割当 が必要
  | "ready" // 手動割当/承認済み → 実行対象
  | "done" // opening 発行済み
  | "excluded"; // 移行しない（退去者・管理者残高など）

export interface StagingRow {
  rank: number;
  display_name: string;
  amount: number;
  status: StagingStatus;
  user_id: string | null;
  note: string | null;
}

export interface MemberNameInfo {
  userId: string;
  /** 表示名・ユーザー名・グローバル名など、照合に使える名前すべて */
  names: string[];
}

export interface ImportSummary {
  staged: number;
  auto: number;
  ambiguous: number;
  overCap: number;
  unmatched: number;
  issues: number;
  totalAmount: number;
}

export interface MigrationReport {
  succeeded: number;
  skippedAsPaid: number;
  failed: Array<{ rank: number; userId: string; code: string }>;
  totalIssued: number;
  remaining: number; // 未処理（ambiguous/over_cap/unmatched）の残り件数
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * 旧残高のダンプ一括移行（経済設計.md §9）。
 * 取込のたびにステージングを作り直す。二重支給は台帳の冪等キー
 * opening:user:<id> が防ぐため、再取込・再実行はいつでも安全。
 */
export class Migration {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
  ) {}

  import(dump: ParsedDump, members: MemberNameInfo[], cap: number): ImportSummary {
    // 名前 → 候補ユーザーID群 の索引
    const index = new Map<string, Set<string>>();
    for (const m of members) {
      for (const name of m.names) {
        const key = name.trim();
        if (!key) continue;
        if (!index.has(key)) index.set(key, new Set());
        index.get(key)!.add(m.userId);
      }
    }
    const dupNames = new Set(dump.duplicateNames);

    const ts = now();
    const insert = this.db.prepare(
      `INSERT INTO migration_staging (rank, display_name, amount, status, user_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const summary: ImportSummary = {
      staged: 0,
      auto: 0,
      ambiguous: 0,
      overCap: 0,
      unmatched: 0,
      issues: dump.issues.length,
      totalAmount: dump.totalAmount,
    };

    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM migration_staging").run();
      for (const e of dump.entries) {
        const candidates = index.get(e.displayName) ?? new Set<string>();
        let status: StagingStatus;
        let userId: string | null = null;
        let note: string | null = null;

        if (dupNames.has(e.displayName)) {
          status = "ambiguous";
          note = "ダンプ内に同名が複数";
        } else if (candidates.size === 0) {
          status = "unmatched";
        } else if (candidates.size > 1) {
          status = "ambiguous";
          note = "同名のメンバーが複数";
        } else {
          userId = [...candidates][0]!;
          status = e.total > cap ? "over_cap" : "auto";
        }
        insert.run(e.rank, e.displayName, e.total, status, userId, note, ts, ts);
        summary.staged += 1;
        if (status === "auto") summary.auto += 1;
        else if (status === "ambiguous") summary.ambiguous += 1;
        else if (status === "over_cap") summary.overCap += 1;
        else summary.unmatched += 1;
      }
    });
    run();
    return summary;
  }

  list(status?: StagingStatus): StagingRow[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM migration_staging WHERE status = ? ORDER BY rank")
        .all(status) as StagingRow[];
    }
    return this.db.prepare("SELECT * FROM migration_staging ORDER BY rank").all() as StagingRow[];
  }

  counts(): Record<StagingStatus, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM migration_staging GROUP BY status")
      .all() as Array<{ status: StagingStatus; c: number }>;
    const base: Record<StagingStatus, number> = {
      auto: 0, ambiguous: 0, over_cap: 0, unmatched: 0, ready: 0, done: 0, excluded: 0,
    };
    for (const r of rows) base[r.status] = r.c;
    return base;
  }

  private getRow(rank: number): StagingRow {
    const row = this.db.prepare("SELECT * FROM migration_staging WHERE rank = ?").get(rank) as
      | StagingRow
      | undefined;
    if (!row) throw new MigrationError("ERR_ROW_NOT_FOUND", { rank });
    return row;
  }

  /** 同名衝突・未照合の行に手動でユーザーを割り当てる（割当＝運営の明示判断なので ready 直行） */
  assign(rank: number, userId: string, actor: string): StagingRow {
    const row = this.getRow(rank);
    if (row.status === "done") throw new MigrationError("ERR_BAD_STATUS", { rank, status: row.status });
    this.db
      .prepare("UPDATE migration_staging SET user_id = ?, status = 'ready', note = ?, updated_at = ? WHERE rank = ?")
      .run(userId, `手動割当 by ${actor}`, now(), rank);
    return this.getRow(rank);
  }

  /** キャップ超過を運営判断で通す */
  approve(rank: number, actor: string): StagingRow {
    const row = this.getRow(rank);
    if (row.status !== "over_cap") {
      throw new MigrationError("ERR_BAD_STATUS", { rank, status: row.status, expected: "over_cap" });
    }
    if (!row.user_id) throw new MigrationError("ERR_NO_USER", { rank });
    this.db
      .prepare("UPDATE migration_staging SET status = 'ready', note = ?, updated_at = ? WHERE rank = ?")
      .run(`キャップ超過を承認 by ${actor}`, now(), rank);
    return this.getRow(rank);
  }

  exclude(rank: number, actor: string, reason?: string): StagingRow {
    const row = this.getRow(rank);
    if (row.status === "done") throw new MigrationError("ERR_BAD_STATUS", { rank, status: row.status });
    this.db
      .prepare("UPDATE migration_staging SET status = 'excluded', note = ?, updated_at = ? WHERE rank = ?")
      .run(reason ?? `除外 by ${actor}`, now(), rank);
    return this.getRow(rank);
  }

  /** auto + ready を opening 発行する。冪等なので何度実行しても安全 */
  execute(actor: string): MigrationReport {
    const targets = this.db
      .prepare("SELECT * FROM migration_staging WHERE status IN ('auto','ready') ORDER BY rank")
      .all() as StagingRow[];

    const report: MigrationReport = { succeeded: 0, skippedAsPaid: 0, failed: [], totalIssued: 0, remaining: 0 };
    const mark = this.db.prepare("UPDATE migration_staging SET status = 'done', updated_at = ? WHERE rank = ?");

    for (const row of targets) {
      if (!row.user_id) continue; // auto/ready は必ず user_id を持つはずだが防御
      const accountId = `user:${row.user_id}`;
      this.ledger.ensureAccount(accountId, "user");
      try {
        const result = this.ledger.transfer({
          from: TREASURY,
          to: accountId,
          amount: row.amount,
          type: "opening",
          actor,
          reason: `旧ボット残高移行（${row.display_name}）`,
          refType: "migration",
          refId: String(row.rank),
          idempotencyKey: `opening:user:${row.user_id}`,
          approvedBy: actor, // 移行は運営の一括承認操作
        });
        if (result.duplicate) report.skippedAsPaid += 1;
        else {
          report.succeeded += 1;
          report.totalIssued += row.amount;
        }
        mark.run(now(), row.rank);
      } catch (e) {
        const err = e as LedgerError;
        report.failed.push({ rank: row.rank, userId: row.user_id, code: err.code ?? "ERR_UNKNOWN" });
      }
    }

    const c = this.counts();
    report.remaining = c.ambiguous + c.over_cap + c.unmatched;
    return report;
  }
}
