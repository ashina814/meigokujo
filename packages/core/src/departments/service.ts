import type Database from "better-sqlite3";
import { Ledger, type TransferResult } from "../ledger/service.js";

/**
 * 部署口座（経済設計.md §5）。旧「業務用」残高の後継。
 * `sys:dept:<部署名>` の system 勘定にして、個人残高と業務資金を分離する。
 * 台帳のシステム勘定をそのまま使うので不変条件（非負・追記専用・検算）に自動的に含まれる。
 * 担当者が替わっても口座はそのまま——引き継ぎは role_id の付け替えだけ。
 */

export type DepartmentErrorCode =
  | "ERR_DEPT_BAD_KEY"
  | "ERR_DEPT_NOT_FOUND"
  | "ERR_DEPT_HAS_BALANCE";

export class DepartmentError extends Error {
  constructor(
    readonly code: DepartmentErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "DepartmentError";
  }
}

export interface DepartmentRow {
  key: string;
  name: string;
  role_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DepartmentBalance extends DepartmentRow {
  account_id: string;
  balance: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** 部署キー → 台帳の口座ID */
export const deptAccount = (key: string): string => `sys:dept:${key}`;

interface DeptTxArgs {
  key: string;
  amount: number;
  actor: string;
  idempotencyKey: string;
  reason?: string;
  /** 高額承認（#決裁）を通した場合の承認者 */
  approvedBy?: string;
}

export class Departments {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
  ) {}

  /** 部署を登録／更新（同じキーなら名前・ロールを差し替え）。口座も同時に用意する */
  upsert(key: string, name: string, roleId: string | null): DepartmentRow {
    const k = key.trim();
    // 口座IDが sys:dept:<key> になるので ':' は禁止。空も不可
    if (!k || k.includes(":") || k.length > 40) {
      throw new DepartmentError("ERR_DEPT_BAD_KEY", { key });
    }
    this.ledger.ensureAccount(deptAccount(k), "system");
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO departments (key, name, role_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, role_id = excluded.role_id, updated_at = excluded.updated_at`,
      )
      .run(k, name.trim() || k, roleId, ts, ts);
    return this.get(k)!;
  }

  get(key: string): DepartmentRow | undefined {
    return this.db.prepare("SELECT * FROM departments WHERE key = ?").get(key) as
      | DepartmentRow
      | undefined;
  }

  private require(key: string): DepartmentRow {
    const row = this.get(key);
    if (!row) throw new DepartmentError("ERR_DEPT_NOT_FOUND", { key });
    return row;
  }

  list(): DepartmentRow[] {
    return this.db.prepare("SELECT * FROM departments ORDER BY name").all() as DepartmentRow[];
  }

  balanceOf(key: string): number {
    return this.ledger.balanceOf(deptAccount(key));
  }

  listWithBalance(): DepartmentBalance[] {
    return this.list().map((d) => ({
      ...d,
      account_id: deptAccount(d.key),
      balance: this.ledger.balanceOf(deptAccount(d.key)),
    }));
  }

  /** 部署を削除。残高が残っていると消せない（先に出金・回収させる） */
  remove(key: string): void {
    this.require(key);
    if (this.balanceOf(key) !== 0) {
      throw new DepartmentError("ERR_DEPT_HAS_BALANCE", { key, balance: this.balanceOf(key) });
    }
    this.db.prepare("DELETE FROM departments WHERE key = ?").run(key);
  }

  /** そのユーザーがこの部署を操作できるか（担当ロール保持者。運営判定はbot側で別途） */
  canOperate(key: string, memberRoleIds: readonly string[]): boolean {
    const dept = this.get(key);
    if (!dept?.role_id) return false;
    return memberRoleIds.includes(dept.role_id);
  }

  /** 住人 → 部署（原資積み立て・売上入金） */
  deposit(fromUserId: string, args: DeptTxArgs): TransferResult {
    this.require(args.key);
    return this.ledger.transfer({
      from: `user:${fromUserId}`,
      to: deptAccount(args.key),
      amount: args.amount,
      type: "dept_in",
      actor: args.actor,
      idempotencyKey: args.idempotencyKey,
      reason: args.reason,
      refType: "dept",
      refId: args.key,
      approvedBy: args.approvedBy,
    });
  }

  /** 部署 → 住人（払い戻し・釣り銭・賞金） */
  withdraw(toUserId: string, args: DeptTxArgs): TransferResult {
    this.require(args.key);
    return this.ledger.transfer({
      from: deptAccount(args.key),
      to: `user:${toUserId}`,
      amount: args.amount,
      type: "dept_out",
      actor: args.actor,
      idempotencyKey: args.idempotencyKey,
      reason: args.reason,
      refType: "dept",
      refId: args.key,
      approvedBy: args.approvedBy,
    });
  }

  /** 部署 → 従業員（歩合分配）。withdraw と分けて type=commission で監査に残す */
  payCommission(toUserId: string, args: DeptTxArgs): TransferResult {
    this.require(args.key);
    return this.ledger.transfer({
      from: deptAccount(args.key),
      to: `user:${toUserId}`,
      amount: args.amount,
      type: "commission",
      actor: args.actor,
      idempotencyKey: args.idempotencyKey,
      reason: args.reason,
      refType: "dept",
      refId: args.key,
      approvedBy: args.approvedBy,
    });
  }
}
