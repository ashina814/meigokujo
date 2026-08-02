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
}
