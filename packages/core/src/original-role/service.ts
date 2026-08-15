import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";

/**
 * オリジナルロール。
 *
 * ```
 * 申請 → 運営が承認 → 本人が支払い → Botがロール作成・付与 → 30日契約
 *                                              更新 → +30日（スタッフ不要）
 * ```
 *
 * ## 支払いは承認のあとだけ
 *
 * 申請の時点では Land を一切動かさない。運営が通すか分からないものに先に払わせると、
 * 却下のたびに返金の仕事が生まれる。
 *
 * ## 誰のどのロールかは、この表だけが正本
 *
 * 旧商品の購入履歴には「買った」という事実しか無く、**どのロールを作ったかの記録が無い**。
 * 購入から推測すると、別人のロールを剥奪する事故になる。引き継ぎは人が明示的に登録する。
 */

export type OriginalRoleStatus =
  | "pending"
  | "approved"
  | "active"
  | "expired"
  | "returned"
  | "rejected"
  | "cancelled";

export interface OriginalRoleRow {
  id: number;
  user_id: string;
  role_id: string | null;
  name: string;
  color: number | null;
  status: OriginalRoleStatus;
  expires_at: number | null;
  approved_by: string | null;
  approved_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  decide_reason: string | null;
  purchase_id: number | null;
  notified_expiry_at: number | null;
  role_removed_at: number | null;
  role_creation_started_at: number | null;
  created_at: number;
  updated_at: number;
}

/** 契約の長さ。更新1回でこの日数ぶん伸びる */
export const ORIGINAL_ROLE_TERM_DAYS = 30;
/** 承認したまま支払われない申請を畳むまでの日数 */
export const ORIGINAL_ROLE_PAYMENT_GRACE_DAYS = 7;
/** 期限の何日前に本人へ知らせるか */
export const ORIGINAL_ROLE_NOTICE_DAYS = 3;

const DAY = 86_400;
const now = (): number => Math.floor(Date.now() / 1000);

export type OriginalRoleErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_NOT_OWNER"
  | "ERR_BAD_STATUS"
  | "ERR_NAME_TAKEN"
  | "ERR_ROLE_TAKEN"
  | "ERR_EXPIRED";

export class OriginalRoleError extends Error {
  constructor(readonly code: OriginalRoleErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "OriginalRoleError";
  }
}

/**
 * 期限を伸ばす。**残り期間を損しない。**
 * 期限前に更新しても切り捨てず、切れた後なら今から数え直す。
 */
export function extendedExpiry(current: number | null, days: number, from: number = now()): number {
  return Math.max(current ?? 0, from) + days * DAY;
}

export class OriginalRoles {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
  ) {}

  get(id: number): OriginalRoleRow | null {
    return (this.db.prepare("SELECT * FROM original_roles WHERE id = ?").get(id) as OriginalRoleRow) ?? null;
  }

  /** その人の契約（既定では生きているものだけ） */
  listByUser(userId: string, opts: { statuses?: readonly OriginalRoleStatus[] } = {}): OriginalRoleRow[] {
    const statuses = opts.statuses ?? (["pending", "approved", "active"] as const);
    const marks = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM original_roles WHERE user_id = ? AND status IN (${marks}) ORDER BY id`)
      .all(userId, ...statuses) as OriginalRoleRow[];
  }

  listByStatus(status: OriginalRoleStatus, limit = 50): OriginalRoleRow[] {
    return this.db
      .prepare("SELECT * FROM original_roles WHERE status = ? ORDER BY created_at LIMIT ?")
      .all(status, limit) as OriginalRoleRow[];
  }

  countByStatus(status: OriginalRoleStatus): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM original_roles WHERE status = ?").get(status) as { c: number }).c;
  }

  // ---- 申請と審査 ----

  /** 申請する。**Land は動かさない。** */
  apply(input: { userId: string; name: string; color: number | null; actor: string }): OriginalRoleRow {
    const ts = now();
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO original_roles (user_id, name, color, status, created_at, updated_at)
           VALUES (?,?,?, 'pending', ?, ?)`,
        )
        .run(input.userId, input.name, input.color, ts, ts).lastInsertRowid,
    );
    this.events.log("original_role_applied", {
      actor: input.actor,
      target: input.userId,
      payload: { id, name: input.name, color: input.color },
    });
    return this.get(id)!;
  }

  /** 承認する。ここでもまだ課金しない（支払いは本人の操作） */
  approve(id: number, actor: string): OriginalRoleRow {
    const ts = now();
    const changed = this.db
      .prepare(
        "UPDATE original_roles SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(actor, ts, ts, id).changes;
    if (changed !== 1) throw new OriginalRoleError("ERR_BAD_STATUS", { id, expected: "pending" });
    this.events.log("original_role_approved", { actor, target: this.get(id)!.user_id, payload: { id } });
    return this.get(id)!;
  }

  /**
   * 差し戻す（直して出し直してもらう）／却下する。
   * どちらも**理由を必ず残す**。本人へ何を伝えるかが変わる。
   */
  decide(id: number, decision: "returned" | "rejected", reason: string, actor: string): OriginalRoleRow {
    const ts = now();
    const changed = this.db
      .prepare(
        `UPDATE original_roles SET status = ?, decided_by = ?, decided_at = ?, decide_reason = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending','approved')`,
      )
      .run(decision, actor, ts, reason.slice(0, 500), ts, id).changes;
    if (changed !== 1) throw new OriginalRoleError("ERR_BAD_STATUS", { id });
    this.events.log(decision === "returned" ? "original_role_returned" : "original_role_rejected", {
      actor,
      target: this.get(id)!.user_id,
      payload: { id, reason },
    });
    return this.get(id)!;
  }

  /** 支払い前の確認。承認済みで、本人のものか */
  assertPayable(id: number, userId: string): OriginalRoleRow {
    const row = this.get(id);
    if (!row) throw new OriginalRoleError("ERR_NOT_FOUND", { id });
    if (row.user_id !== userId) throw new OriginalRoleError("ERR_NOT_OWNER", { id });
    if (row.status !== "approved") throw new OriginalRoleError("ERR_BAD_STATUS", { id, status: row.status });
    return row;
  }

  /**
   * ロールを作り終えたので契約を開始する。**Discord 側が済んでから呼ぶ。**
   * 同じ申請から2つの契約を作らないよう、`approved` からの条件付き更新で1回だけ通す。
   */
  activate(input: { id: number; roleId: string; purchaseId: number; actor: string }): boolean {
    const ts = now();
    const changed = this.db
      .prepare(
        `UPDATE original_roles
            SET status = 'active', role_id = ?, purchase_id = ?, expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'approved'`,
      )
      .run(input.roleId, input.purchaseId, ts + ORIGINAL_ROLE_TERM_DAYS * DAY, ts, input.id).changes;
    if (changed !== 1) return false;
    this.events.log("original_role_activated", {
      actor: input.actor,
      target: this.get(input.id)!.user_id,
      payload: { id: input.id, roleId: input.roleId, purchaseId: input.purchaseId },
    });
    return true;
  }

  // ---- 更新 ----

  /**
   * 更新する。**課金と期限延長を同じ取引で確定する。**
   *
   * 新規作成は Discord へロールを作る工程があるので購入行と配送状態で追うが、
   * 更新は DB の中で閉じる。途中で落ちて「払ったのに伸びていない」が起きない。
   */
  renew(input: {
    id: number;
    userId: string;
    price: number;
    actor: string;
    /** 確認画面ごとの鍵。**永続的に消費する**ので、同じ画面を何度押しても1回しか動かない */
    operationId: string;
  }): OriginalRoleRow {
    const run = this.db.transaction(() => {
      // 既に消費済みの確認なら、何もせず今の状態を返す（二重課金・二重延長を止める）
      const consumed = this.db
        .prepare("SELECT original_role_id FROM original_role_renewals WHERE operation_id = ?")
        .get(input.operationId) as { original_role_id: number } | undefined;
      if (consumed) return this.get(consumed.original_role_id)!;

      const row = this.get(input.id);
      if (!row) throw new OriginalRoleError("ERR_NOT_FOUND", { id: input.id });
      if (row.user_id !== input.userId) throw new OriginalRoleError("ERR_NOT_OWNER", { id: input.id });
      if (row.status !== "active") throw new OriginalRoleError("ERR_BAD_STATUS", { id: input.id, status: row.status });
      // **期限を過ぎたものは更新で戻せない。** ロールは既に外れている（か、これから外れる）ので、
      // 期限だけ伸ばすと「ロールが無いのに契約中」になる。作り直しからやってもらう
      if (row.expires_at !== null && row.expires_at <= now()) {
        throw new OriginalRoleError("ERR_EXPIRED", { id: input.id, expiresAt: row.expires_at });
      }
      const ts = now();
      this.db
        .prepare(
          "INSERT INTO original_role_renewals (operation_id, original_role_id, user_id, price, created_at) VALUES (?,?,?,?,?)",
        )
        .run(input.operationId, row.id, input.userId, input.price, ts);
      const account = `user:${input.userId}`;
      this.ledger.transfer({
        from: account,
        to: TREASURY,
        amount: input.price,
        type: "tip_burn",
        actor: input.actor,
        reason: `オリジナルロール更新: ${row.name}`,
        refType: "original_role",
        refId: String(row.id),
        idempotencyKey: `original_role:renew:${input.operationId}`,
      });
      this.db
        .prepare(
          "UPDATE original_roles SET status = 'active', expires_at = ?, notified_expiry_at = NULL, role_removed_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(extendedExpiry(row.expires_at, ORIGINAL_ROLE_TERM_DAYS, ts), ts, row.id);
      this.events.log("original_role_renewed", {
        actor: input.actor,
        target: input.userId,
        payload: { id: row.id, price: input.price, operationId: input.operationId, expiresAt: this.get(row.id)!.expires_at },
      });
      return this.get(row.id)!;
    });
    return run.immediate();
  }

  // ---- 作成中の取り違えを防ぐ ----

  /**
   * Discord へロールを作りにいく直前に印を置く。
   *
   * 作成が返る前に落ちると「作ったかどうか」が分からなくなる。印があれば、
   * 再試行は**まず既にあるロールを探す**（同じ名前のロールを2個作らないため）。
   */
  markRoleCreationStarted(id: number): void {
    this.db
      .prepare("UPDATE original_roles SET role_creation_started_at = ?, updated_at = ? WHERE id = ?")
      .run(now(), now(), id);
  }

  /** 作成したロールを**付与より先に**書き留める（窓を最小にする） */
  attachRole(id: number, roleId: string, actor: string): void {
    this.db.prepare("UPDATE original_roles SET role_id = ?, updated_at = ? WHERE id = ?").run(roleId, now(), id);
    this.events.log("original_role_role_attached", { actor, payload: { id, roleId } });
  }

  /** そのロールが既に別の契約で使われているか */
  roleTaken(roleId: string, exceptId?: number): boolean {
    const row = this.db.prepare("SELECT id FROM original_roles WHERE role_id = ?").get(roleId) as
      | { id: number }
      | undefined;
    return row !== undefined && row.id !== exceptId;
  }

  // ---- 期限まわり（巡回から呼ぶ）----

  /** 期限が近い契約。**まだ知らせていないものだけ**返す */
  listExpiringSoon(days = ORIGINAL_ROLE_NOTICE_DAYS): OriginalRoleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM original_roles
          WHERE status = 'active' AND notified_expiry_at IS NULL
            AND expires_at IS NOT NULL AND expires_at <= ? AND expires_at > ?`,
      )
      .all(now() + days * DAY, now()) as OriginalRoleRow[];
  }

  markExpiryNotified(id: number): void {
    this.db.prepare("UPDATE original_roles SET notified_expiry_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  }

  /** 期限が過ぎた契約（ロールの剥奪がまだ済んでいないもの） */
  listExpired(): OriginalRoleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM original_roles
          WHERE status IN ('active','expired') AND role_removed_at IS NULL
            AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(now()) as OriginalRoleRow[];
  }

  /** 期限切れにする（剥奪の成否は別に記録し、失敗したら次の巡回で拾い直す） */
  markExpired(id: number, actor: string, roleRemoved: boolean): void {
    const ts = now();
    this.db
      .prepare("UPDATE original_roles SET status = 'expired', role_removed_at = ?, updated_at = ? WHERE id = ?")
      .run(roleRemoved ? ts : null, ts, id);
    if (roleRemoved) this.events.log("original_role_expired", { actor, target: this.get(id)!.user_id, payload: { id } });
  }

  /** 承認したまま支払われずに期限が来た申請 */
  listUnpaidApprovals(graceDays = ORIGINAL_ROLE_PAYMENT_GRACE_DAYS): OriginalRoleRow[] {
    return this.db
      .prepare(
        "SELECT * FROM original_roles WHERE status = 'approved' AND approved_at IS NOT NULL AND approved_at <= ?",
      )
      .all(now() - graceDays * DAY) as OriginalRoleRow[];
  }

  cancelUnpaid(id: number, actor: string): boolean {
    const ts = now();
    const changed = this.db
      .prepare(
        "UPDATE original_roles SET status = 'cancelled', decided_by = ?, decided_at = ?, decide_reason = ?, updated_at = ? WHERE id = ? AND status = 'approved'",
      )
      .run(actor, ts, "承認から支払いがないまま期限が過ぎました", ts, id).changes;
    if (changed !== 1) return false;
    this.events.log("original_role_payment_expired", { actor, target: this.get(id)!.user_id, payload: { id } });
    return true;
  }

  // ---- 旧契約の引き継ぎ ----

  /**
   * 制度の前から持っている人の契約を、人が明示的に登録する。
   *
   * **購入履歴から推測しない。** 旧商品には「どのロールを作ったか」の記録が無く、
   * 推測すると別人のロールを剥奪する事故になる。同じロールは二度登録できない。
   */
  importExisting(input: {
    userId: string;
    roleId: string;
    name: string;
    expiresAt: number | null;
    actor: string;
  }): OriginalRoleRow {
    const existing = this.db.prepare("SELECT * FROM original_roles WHERE role_id = ?").get(input.roleId) as
      | OriginalRoleRow
      | undefined;
    if (existing) throw new OriginalRoleError("ERR_ROLE_TAKEN", { roleId: input.roleId, id: existing.id });
    const ts = now();
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO original_roles (user_id, role_id, name, color, status, expires_at, approved_by, approved_at, created_at, updated_at)
           VALUES (?,?,?,NULL,'active',?,?,?,?,?)`,
        )
        .run(input.userId, input.roleId, input.name, input.expiresAt, input.actor, ts, ts, ts).lastInsertRowid,
    );
    this.events.log("original_role_imported", {
      actor: input.actor,
      target: input.userId,
      payload: { id, roleId: input.roleId, name: input.name, expiresAt: input.expiresAt },
    });
    return this.get(id)!;
  }
}
