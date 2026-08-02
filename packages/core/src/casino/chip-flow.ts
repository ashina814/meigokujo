import type Database from "better-sqlite3";
import type { EventLog } from "../events/service.js";
import { ChipLedger } from "./chip-ledger.js";

const now = () => Math.floor(Date.now() / 1000);

export interface AutoDepositResult { required: number; freeBefore: number; deposited: number; freeAfter: number; }
export interface RedeemResult { userId: string; redeemed: number; land: number; reason: string; }
export interface InactiveRedeemResult {
  redeemed: RedeemResult[];
  skipped: string[];
  failed: Array<{ userId: string; amount: number; error: string }>;
}
export interface ExternalChipConfirmation { id: string; userId: string; operationKind: string; operationId: string; requiredLand: number; status: "pending" | "executing" | "completed" | "cancelled" | "expired"; createdAt: number; expiresAt: number; }
export type RefundSagaStatus = "draft" | "executing" | "completed" | "blocked" | "cancelled";
export interface RefundSagaTarget { userId: string; amount: number; status: "pending" | "completed" | "failed" | "blocked"; groupKey: string; result?: RedeemResult; failure?: string; }
export interface RefundSaga {
  id: string;
  scope: "user" | "all";
  requestedBy: string;
  targetUserId: string | null;
  status: RefundSagaStatus;
  targetCount: number;
  targetTotal: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  failure?: string;
  targets: RefundSagaTarget[];
}
/** 資金を返す前に確認しなければならない、プロセス外の進行状態。 */
export interface RefundSafetyGate {
  activeGameUsers?: (userIds: readonly string[]) => string[];
  processingGroup?: () => boolean;
  integrityBlocked?: () => boolean;
}

/**
 * PR10 の自由チップ出入金の唯一の入口。
 * accounts.kind=user と結合しているため、escrow・胴元・JP・quarantine・
 * sys:casino:free-spin-jp-claims を返還対象に取り込めない。
 */
export class CasinoChipFlow {
  constructor(private readonly db: Database.Database, private readonly chips: ChipLedger, private readonly events: EventLog) {}

  touch(userId: string, at = now()): void {
    if (!userId) throw new Error("userId is required");
    this.db.prepare(
      `INSERT INTO casino_chip_activity (user_id, last_active_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_active_at=excluded.last_active_at, updated_at=excluded.updated_at`,
    ).run(userId, at, now());
  }

  lastActiveAt(userId: string): number | null {
    return (this.db.prepare("SELECT last_active_at FROM casino_chip_activity WHERE user_id=?").get(userId) as { last_active_at: number } | undefined)?.last_active_at ?? null;
  }

  /** 不足分だけを同じチップ取引グループで預ける。 */
  ensureFreeChips(userId: string, required: number, operationId: string): AutoDepositResult {
    if (!Number.isSafeInteger(required) || required < 0) throw new Error("required must be a non-negative integer");
    return this.chips.runGroup({ groupKey: `chip:auto-deposit:${userId}:${operationId}`, kind: "auto_deposit", actorId: userId }, () => {
      const freeBefore = this.chips.freeChips(userId);
      const deposited = Math.max(0, required - freeBefore);
      if (deposited) this.chips.deposit(userId, deposited, `chip:auto-deposit:${userId}:${operationId}:land`);
      this.touch(userId);
      return { required, freeBefore, deposited, freeAfter: this.chips.freeChips(userId) };
    });
  }

  /** 利用者の自由チップだけをLandへ返す。 */
  redeemFreeChips(userId: string, operationId: string, reason: string): RedeemResult {
    return this.chips.runGroup({ groupKey: `chip:free-redeem:${userId}:${operationId}`, kind: "free_redeem", actorId: userId }, () => {
      const redeemed = this.chips.freeChips(userId);
      if (redeemed) this.chips.redeem(userId, redeemed, `chip:free-redeem:${userId}:${operationId}:land`);
      this.touch(userId);
      this.events.log("casino_free_chips_redeemed", { actor: userId, payload: { redeemed, reason, operationId } });
      return { userId, redeemed, land: redeemed, reason };
    });
  }

  leaveCasino(userId: string, operationId: string, reason = "賭場を出る"): RedeemResult {
    return this.redeemFreeChips(userId, operationId, reason);
  }

  redeemInactive(cutoffAt: number, operationPrefix = "inactive"): InactiveRedeemResult {
    if (this.chips.chipTx.isActive()) {
      this.events.log("casino_free_chips_redeem_skipped", { actor: "system:casino-chip-flow", payload: { reason: "chip_group_active" } });
      return { redeemed: [], skipped: ["chip_group_active"], failed: [] };
    }
    return this.redeemRows(this.listFreeChipUsers("a.last_active_at <= ?", [cutoffAt]), operationPrefix, "10分無操作", cutoffAt);
  }

  /** 起動復旧用。利用者自由チップだけなのでsystem holderには触れない。 */
  redeemAllFreeChips(operationPrefix = "startup"): InactiveRedeemResult {
    return this.redeemRows(this.listFreeChipUsers(), operationPrefix, "起動時自由チップ返還");
  }

  previewFreeChipRedemption(userId?: string): { users: number; total: number; rows: Array<{ userId: string; amount: number }> } {
    const rows = this.listFreeChipUsers().map(({ userId }) => ({ userId, amount: this.chips.freeChips(userId) })).filter((r) => !userId || r.userId === userId);
    return { users: rows.length, total: rows.reduce((s, r) => s + r.amount, 0), rows };
  }

  /**
   * 支配人/管理者用の緊急返還案を作る。ここでは金銭を動かさず、対象・額を固定して提示する。
   * `all` は作成時点の自由チップ保有者だけを対象にするので、確認後に新規入金した利用者を
   * 誤って巻き込まない。実行時に残高が増減していても、返還APIはその時点の自由チップだけを
   * 冪等に返す（エスクロー・system holderは常に対象外）。
   */
  createRefundSaga(input: { id: string; requestedBy: string; scope: "user" | "all"; userId?: string }): RefundSaga {
    if (!input.id || !input.requestedBy || (input.scope === "user" && !input.userId)) throw new Error("不正な緊急返還案");
    const rows = this.previewFreeChipRedemption(input.scope === "user" ? input.userId : undefined).rows;
    const ts = now();
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO casino_chip_refund_sagas
         (id,scope,requested_by,target_user_id,status,target_count,target_total,created_at)
         VALUES (?,?,?,?, 'draft',?,?,?)`,
      ).run(input.id, input.scope, input.requestedBy, input.userId ?? null, rows.length, rows.reduce((n, r) => n + r.amount, 0), ts);
      const insert = this.db.prepare(
        `INSERT INTO casino_chip_refund_saga_targets (saga_id,user_id,amount,status,group_key)
         VALUES (?,?,?,'pending',?)`,
      );
      for (const row of rows) insert.run(input.id, row.userId, row.amount, `chip:free-redeem:${row.userId}:emergency:${input.id}:${row.userId}`);
    });
    tx.immediate();
    return this.refundSaga(input.id)!;
  }

  refundSaga(id: string): RefundSaga | undefined {
    const row = this.db.prepare("SELECT * FROM casino_chip_refund_sagas WHERE id=?").get(id) as any;
    if (!row) return undefined;
    const targets = this.db.prepare("SELECT * FROM casino_chip_refund_saga_targets WHERE saga_id=? ORDER BY user_id").all(id) as any[];
    return {
      id: row.id, scope: row.scope, requestedBy: row.requested_by, targetUserId: row.target_user_id,
      status: row.status, targetCount: row.target_count, targetTotal: row.target_total, createdAt: row.created_at,
      startedAt: row.started_at ?? null, completedAt: row.completed_at ?? null,
      failure: row.failure_json ? String(row.failure_json) : undefined,
      targets: targets.map((t) => ({
        userId: t.user_id, amount: t.amount, status: t.status, groupKey: t.group_key,
        result: t.result_json ? JSON.parse(t.result_json) as RedeemResult : undefined, failure: t.failure ?? undefined,
      })),
    };
  }

  cancelRefundSaga(id: string, requestedBy: string): boolean {
    return this.db.prepare(
      "UPDATE casino_chip_refund_sagas SET status='cancelled' WHERE id=? AND requested_by=? AND status='draft'",
    ).run(id, requestedBy).changes === 1;
  }

  /**
   * 固定済みの案を実行/再開する。安全ゲートに掛かったら一切返還せず `blocked` にする。
   * 各対象は安定したgroup keyを使うため、DB commit後・saga完了記録前のクラッシュでも
   * 次回は保存済みgroupの結果を読み、二重返還なしで `completed` まで進める。
   */
  executeRefundSaga(id: string, actorId: string, gate: RefundSafetyGate = {}): RefundSaga {
    const saga = this.refundSaga(id);
    if (!saga || saga.requestedBy !== actorId) throw new Error("この緊急返還案は実行できません");
    if (saga.status === "cancelled") throw new Error("この緊急返還案は取り消されています");
    if (saga.status === "completed") return saga;
    const blocked = this.refundBlockReason(saga, gate);
    if (blocked) {
      this.db.prepare("UPDATE casino_chip_refund_sagas SET status='blocked',failure_json=? WHERE id=?").run(blocked, id);
      return this.refundSaga(id)!;
    }
    this.db.prepare(
      "UPDATE casino_chip_refund_sagas SET status='executing',started_at=COALESCE(started_at,?) WHERE id=? AND status IN ('draft','blocked','executing')",
    ).run(now(), id);
    for (const target of this.refundSaga(id)!.targets) {
      if (target.status === "completed") continue;
      try {
        const result = this.redeemFreeChips(target.userId, `emergency:${id}:${target.userId}`, "緊急返還");
        this.db.prepare(
          "UPDATE casino_chip_refund_saga_targets SET status='completed',result_json=?,completed_at=?,failure=NULL WHERE saga_id=? AND user_id=?",
        ).run(JSON.stringify(result), now(), id, target.userId);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        this.db.prepare("UPDATE casino_chip_refund_saga_targets SET status='failed',failure=? WHERE saga_id=? AND user_id=?").run(failure, id, target.userId);
        this.events.log("casino_emergency_redeem_failed", { actor: actorId, payload: { sagaId: id, userId: target.userId, error: failure } });
      }
    }
    const incomplete = this.db.prepare("SELECT COUNT(*) AS n FROM casino_chip_refund_saga_targets WHERE saga_id=? AND status <> 'completed'").get(id) as { n: number };
    if (incomplete.n === 0) {
      this.db.prepare("UPDATE casino_chip_refund_sagas SET status='completed',completed_at=?,failure_json=NULL WHERE id=?").run(now(), id);
      this.events.log("casino_emergency_redeem_completed", { actor: actorId, payload: { sagaId: id, targetCount: saga.targetCount, targetTotal: saga.targetTotal } });
    }
    return this.refundSaga(id)!;
  }

  /** 域外Land不足の確認票。承認前には一切の資金を動かさない。 */
  createExternalConfirmation(input: { id: string; userId: string; operationKind: string; operationId: string; requiredLand: number; expiresAt: number }): ExternalChipConfirmation {
    if (!input.id || !input.userId || !input.operationKind || !input.operationId || !Number.isSafeInteger(input.requiredLand) || input.requiredLand <= 0 || input.expiresAt <= now()) throw new Error("不正な域外操作確認票");
    this.db.prepare(`INSERT INTO casino_chip_external_confirmations (id,user_id,operation_kind,operation_id,required_land,status,created_at,expires_at) VALUES (?,?,?,?,?,'pending',?,?)`).run(input.id, input.userId, input.operationKind, input.operationId, input.requiredLand, now(), input.expiresAt);
    return this.externalConfirmation(input.id)!;
  }
  externalConfirmation(id: string): ExternalChipConfirmation | undefined {
    const r = this.db.prepare("SELECT * FROM casino_chip_external_confirmations WHERE id=?").get(id) as any;
    return r && { id: r.id, userId: r.user_id, operationKind: r.operation_kind, operationId: r.operation_id, requiredLand: r.required_land, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at };
  }
  cancelExternalConfirmation(id: string, userId: string): boolean {
    return this.db.prepare("UPDATE casino_chip_external_confirmations SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'").run(id, userId).changes === 1;
  }
  /** 実行権を原子的に取得する。caller はこの後に同じoperation idを一度だけ再実行する。 */
  beginExternalConfirmation(id: string, userId: string, at = now()): ExternalChipConfirmation {
    const row = this.externalConfirmation(id); if (!row || row.userId !== userId || row.status !== "pending") throw new Error("この確認票は実行できません");
    if (row.expiresAt < at) { this.db.prepare("UPDATE casino_chip_external_confirmations SET status='expired' WHERE id=? AND status='pending'").run(id); throw new Error("この確認票は期限切れです"); }
    if (this.db.prepare("UPDATE casino_chip_external_confirmations SET status='executing' WHERE id=? AND user_id=? AND status='pending'").run(id, userId).changes !== 1) throw new Error("この確認票は既に処理されています");
    return this.externalConfirmation(id)!;
  }
  completeExternalConfirmation(id: string, userId: string): boolean {
    return this.db.prepare("UPDATE casino_chip_external_confirmations SET status='completed',completed_at=? WHERE id=? AND user_id=? AND status='executing'").run(now(), id, userId).changes === 1;
  }

  /**
   * 域外確認後に、保存済みの operationId で元の操作を一度だけ再実行するための入口。
   * callback は operationId を冪等キーとして扱う必要がある。途中クラッシュ時は executing
   * の同一本人だけが再開でき、他人・古いボタン・完了後の再押下はすべて拒否する。
   */
  executeExternalConfirmation<T>(id: string, userId: string, body: (operationId: string) => T, at = now()): T {
    let row = this.externalConfirmation(id);
    if (!row || row.userId !== userId || row.status === "cancelled" || row.status === "completed" || row.status === "expired") {
      throw new Error("この確認票は実行できません");
    }
    if (row.status === "pending") row = this.beginExternalConfirmation(id, userId, at);
    if (row.status !== "executing") throw new Error("この確認票は実行できません");
    const result = body(row.operationId);
    this.completeExternalConfirmation(id, userId);
    return result;
  }

  private redeemRows(rows: Array<{ userId: string }>, prefix: string, reason: string, cutoffAt?: number): InactiveRedeemResult {
    const result: InactiveRedeemResult = { redeemed: [], skipped: [], failed: [] };
    for (const row of rows) {
      try {
        if (cutoffAt != null && (this.lastActiveAt(row.userId) ?? 0) > cutoffAt) { result.skipped.push(row.userId); continue; }
        result.redeemed.push(this.redeemFreeChips(row.userId, `${prefix}:${row.userId}${cutoffAt == null ? "" : `:${cutoffAt}`}`, reason));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const amount = this.chips.freeChips(row.userId);
        result.failed.push({ userId: row.userId, amount, error: detail });
        this.events.log("casino_free_chips_redeem_failed", { actor: "system:casino-chip-flow", payload: { userId: row.userId, amount, reason, error: detail } });
      }
    }
    return result;
  }

  private listFreeChipUsers(where = "1 = 1", params: unknown[] = []): Array<{ userId: string }> {
    return this.db.prepare(
      `SELECT e.user_id AS userId FROM ether_balances e
       JOIN accounts u ON u.id = 'user:' || e.user_id AND u.kind = 'user'
       LEFT JOIN casino_chip_activity a ON a.user_id = e.user_id
       WHERE e.amount > 0 AND ${where} ORDER BY e.user_id`,
    ).all(...params) as Array<{ userId: string }>;
  }

  private refundBlockReason(saga: RefundSaga, gate: RefundSafetyGate): string | null {
    if (this.chips.chipTx.isActive() || gate.processingGroup?.()) return "金銭処理中のため緊急返還を停止しました";
    if (gate.integrityBlocked?.()) return "検算停止中のため緊急返還を停止しました";
    const active = gate.activeGameUsers?.(saga.targets.map((t) => t.userId)) ?? [];
    if (active.length > 0) return `進行中ゲームの利用者がいるため緊急返還を停止しました: ${active.join(",")}`;
    return null;
  }
}
