import type Database from "better-sqlite3";
import type { EventLog } from "../events/service.js";
import { CasinoChipAssets } from "./chip-assets.js";
import { ChipLedger } from "./chip-ledger.js";
import { MARKET_LIVE_STATUSES } from "./market.js";

const now = () => Math.floor(Date.now() / 1000);

export interface AutoDepositResult {
  required: number;
  freeBefore: number;
  deposited: number;
  freeAfter: number;
}

export interface RedeemResult {
  userId: string;
  redeemed: number;
  land: number;
  reason: string;
  skipped?: "active_ownership";
}

export interface InactiveRedeemResult {
  redeemed: RedeemResult[];
  skipped: string[];
  failed: Array<{ userId: string; amount: number; error: string }>;
}

export interface ExternalChipConfirmation {
  id: string;
  userId: string;
  operationKind: string;
  operationId: string;
  requiredLand: number;
  chipAmount: number;
  status: "pending" | "executing" | "completed" | "cancelled" | "expired";
  createdAt: number;
  expiresAt: number;
}

export type RefundSagaStatus = "draft" | "executing" | "completed" | "blocked" | "cancelled";

export interface RefundSagaTarget {
  userId: string;
  amount: number;
  status: "pending" | "completed" | "failed" | "blocked";
  groupKey: string;
  result?: RedeemResult;
  failure?: string;
}

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
  constructor(
    private readonly db: Database.Database,
    private readonly chips: ChipLedger,
    private readonly events: EventLog,
    private readonly assets: CasinoChipAssets = new CasinoChipAssets(db, chips),
  ) {
    this.assertSchema();
  }

  private assertSchema(): void {
    const required: Readonly<Record<string, readonly string[]>> = {
      casino_chip_activity: ["user_id", "last_active_at", "updated_at"],
      casino_chip_external_confirmations: [
        "id", "user_id", "operation_kind", "operation_id", "required_land", "chip_amount",
        "status", "created_at", "expires_at", "completed_at",
      ],
      casino_chip_refund_sagas: [
        "id", "scope", "requested_by", "target_user_id", "status", "target_count", "target_total",
        "created_at", "started_at", "completed_at", "failure_json",
      ],
      casino_chip_refund_saga_targets: [
        "saga_id", "user_id", "amount", "status", "group_key", "result_json", "failure", "completed_at",
      ],
    };
    for (const [table, columns] of Object.entries(required)) {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) throw new Error(`CasinoChipFlow schema incomplete: missing table ${table}`);
      const actual = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      const missing = columns.filter((column) => !actual.has(column));
      if (missing.length > 0) {
        throw new Error(`CasinoChipFlow schema incomplete: ${table}.${missing.join(",")}`);
      }
    }
  }

  private hasTable(table: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }

  touch(userId: string, at = now()): void {
    if (!userId) throw new Error("userId is required");
    if (!Number.isSafeInteger(at) || at < 0) throw new Error("invalid activity timestamp");
    this.db.prepare(
      `INSERT INTO casino_chip_activity (user_id, last_active_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_active_at=excluded.last_active_at, updated_at=excluded.updated_at`,
    ).run(userId, at, now());
  }

  lastActiveAt(userId: string): number | null {
    return (this.db.prepare("SELECT last_active_at FROM casino_chip_activity WHERE user_id=?").get(userId) as
      | { last_active_at: number }
      | undefined)?.last_active_at ?? null;
  }

  /** 不足分だけを同じチップ取引グループで預ける。 */
  ensureFreeChips(userId: string, required: number, operationId: string): AutoDepositResult {
    if (!Number.isSafeInteger(required) || required < 0) {
      throw new Error("required must be a non-negative integer");
    }
    return this.chips.runGroup(
      { groupKey: `chip:auto-deposit:${userId}:${operationId}`, kind: "deposit", actorId: `user:${userId}` },
      () => {
        const freeBefore = this.assets.freeChips(userId);
        const deposited = Math.max(0, required - freeBefore);
        if (deposited) {
          this.chips.deposit(userId, deposited, `chip:auto-deposit:${userId}:${operationId}`);
        }
        this.touch(userId);
        const freeAfter = this.assets.freeChips(userId);
        if (freeAfter < required) {
          throw new Error(`automatic deposit postcondition failed: required ${required}, actual ${freeAfter}`);
        }
        return { required, freeBefore, deposited, freeAfter };
      },
    );
  }

  /** 利用者の自由チップだけをLandへ全額返す。 */
  redeemFreeChips(userId: string, operationId: string, reason: string): RedeemResult {
    return this.chips.runGroup(
      { groupKey: `chip:free-redeem:${userId}:${operationId}`, kind: "redeem", actorId: `user:${userId}` },
      () => {
        if (this.hasActiveOwnership(userId)) {
          return { userId, redeemed: 0, land: 0, reason, skipped: "active_ownership" };
        }
        const redeemed = this.assets.freeChips(userId);
        if (redeemed) {
          this.chips.redeem(userId, redeemed, `chip:free-redeem:${userId}:${operationId}`);
        }
        this.touch(userId);
        this.events.log("casino_free_chips_redeemed", {
          actor: userId,
          payload: { redeemed, reason, operationId },
        });
        return { userId, redeemed, land: redeemed, reason };
      },
    );
  }

  /**
   * 確認画面や永続draftで固定した額だけを返す。
   * requireExact=true の場合、確認後に残高が増減していれば資金を一切動かさず stale とする。
   */
  redeemExactFreeChips(
    userId: string,
    amount: number,
    operationId: string,
    reason: string,
    requireExact = true,
  ): RedeemResult {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid redeem amount");
    return this.chips.runGroup(
      { groupKey: `chip:free-redeem:${userId}:${operationId}`, kind: "redeem", actorId: `user:${userId}` },
      () => {
        if (this.hasActiveOwnership(userId)) {
          throw new Error(`active ownership prevents free-chip redemption: ${userId}`);
        }
        const current = this.assets.freeChips(userId);
        if (requireExact && current !== amount) {
          throw new Error(`free chip balance changed after confirmation: expected ${amount}, actual ${current}`);
        }
        if (current < amount) {
          throw new Error(`insufficient free chips: required ${amount}, actual ${current}`);
        }
        if (amount) {
          this.chips.redeem(userId, amount, `chip:free-redeem:${userId}:${operationId}`);
        }
        this.touch(userId);
        this.events.log("casino_free_chips_redeemed", {
          actor: userId,
          payload: { redeemed: amount, reason, operationId },
        });
        return { userId, redeemed: amount, land: amount, reason };
      },
    );
  }

  leaveCasino(userId: string, operationId: string, reason = "賭場を出る"): RedeemResult {
    return this.redeemFreeChips(userId, operationId, reason);
  }

  redeemInactive(
    cutoffAt: number,
    operationPrefix = "inactive",
    gate: RefundSafetyGate = {},
  ): InactiveRedeemResult {
    if (!Number.isSafeInteger(cutoffAt) || cutoffAt < 0) throw new Error("invalid inactivity cutoff");
    const globalBlock = this.globalBlockReason(gate);
    if (globalBlock) {
      this.events.log("casino_free_chips_redeem_skipped", {
        actor: "system:casino-chip-flow",
        payload: { reason: globalBlock },
      });
      return { redeemed: [], skipped: [globalBlock], failed: [] };
    }
    return this.redeemRows(
      this.listFreeChipUsers("a.last_active_at <= ?", [cutoffAt]),
      operationPrefix,
      "10分無操作",
      cutoffAt,
      gate,
    );
  }

  /** 起動復旧用。利用者自由チップだけなのでsystem holderには触れない。 */
  redeemAllFreeChips(operationPrefix = "startup", gate: RefundSafetyGate = {}): InactiveRedeemResult {
    const globalBlock = this.globalBlockReason(gate);
    if (globalBlock) return { redeemed: [], skipped: [globalBlock], failed: [] };
    return this.redeemRows(this.listFreeChipUsers(), operationPrefix, "起動時自由チップ返還", undefined, gate);
  }

  previewFreeChipRedemption(userId?: string): {
    users: number;
    total: number;
    rows: Array<{ userId: string; amount: number }>;
  } {
    const rows = this.listFreeChipUsers()
      .map(({ userId: id, amount }) => ({ userId: id, amount }))
      .filter((row) => !userId || row.userId === userId);
    return { users: rows.length, total: rows.reduce((sum, row) => sum + row.amount, 0), rows };
  }

  /** 金銭を動かさず、対象者と返還額を固定した永続draftを作る。 */
  createRefundSaga(input: {
    id: string;
    requestedBy: string;
    scope: "user" | "all";
    userId?: string;
  }): RefundSaga {
    if (!input.id || !input.requestedBy || (input.scope === "user" && !input.userId)) {
      throw new Error("不正な緊急返還案");
    }
    const rows = this.previewFreeChipRedemption(input.scope === "user" ? input.userId : undefined).rows;
    const ts = now();
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO casino_chip_refund_sagas
         (id,scope,requested_by,target_user_id,status,target_count,target_total,created_at)
         VALUES (?,?,?,?, 'draft',?,?,?)`,
      ).run(
        input.id,
        input.scope,
        input.requestedBy,
        input.userId ?? null,
        rows.length,
        rows.reduce((sum, row) => sum + row.amount, 0),
        ts,
      );
      const insert = this.db.prepare(
        `INSERT INTO casino_chip_refund_saga_targets (saga_id,user_id,amount,status,group_key)
         VALUES (?,?,?,'pending',?)`,
      );
      for (const row of rows) {
        insert.run(
          input.id,
          row.userId,
          row.amount,
          `chip:free-redeem:${row.userId}:emergency:${input.id}:${row.userId}`,
        );
      }
    }).immediate();
    return this.refundSaga(input.id)!;
  }

  refundSaga(id: string): RefundSaga | undefined {
    const row = this.db.prepare("SELECT * FROM casino_chip_refund_sagas WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const targets = this.db.prepare(
      "SELECT * FROM casino_chip_refund_saga_targets WHERE saga_id=? ORDER BY user_id",
    ).all(id) as Array<Record<string, unknown>>;
    return {
      id: String(row.id),
      scope: row.scope as "user" | "all",
      requestedBy: String(row.requested_by),
      targetUserId: row.target_user_id == null ? null : String(row.target_user_id),
      status: row.status as RefundSagaStatus,
      targetCount: Number(row.target_count),
      targetTotal: Number(row.target_total),
      createdAt: Number(row.created_at),
      startedAt: row.started_at == null ? null : Number(row.started_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      failure: row.failure_json == null ? undefined : String(row.failure_json),
      targets: targets.map((target) => ({
        userId: String(target.user_id),
        amount: Number(target.amount),
        status: target.status as RefundSagaTarget["status"],
        groupKey: String(target.group_key),
        result: target.result_json ? JSON.parse(String(target.result_json)) as RedeemResult : undefined,
        failure: target.failure == null ? undefined : String(target.failure),
      })),
    };
  }

  cancelRefundSaga(id: string, requestedBy: string): boolean {
    return this.db.prepare(
      "UPDATE casino_chip_refund_sagas SET status='cancelled' WHERE id=? AND requested_by=? AND status='draft'",
    ).run(id, requestedBy).changes === 1;
  }

  /**
   * draft作成時の全残高がそのまま残っている場合だけ実行する。
   * 一件でもstaleなら、全利用者について一切の返還を始めない。
   */
  executeRefundSaga(id: string, actorId: string, gate: RefundSafetyGate = {}): RefundSaga {
    const saga = this.refundSaga(id);
    if (!saga || saga.requestedBy !== actorId) throw new Error("この緊急返還案は実行できません");
    if (saga.status === "cancelled") throw new Error("この緊急返還案は取り消されています");
    if (saga.status === "completed") return saga;

    const blocked = this.refundBlockReason(saga, gate) ?? this.sagaStaleReason(saga);
    if (blocked) {
      this.db.prepare(
        "UPDATE casino_chip_refund_sagas SET status='blocked',failure_json=? WHERE id=? AND status <> 'completed'",
      ).run(blocked, id);
      return this.refundSaga(id)!;
    }

    this.db.prepare(
      "UPDATE casino_chip_refund_sagas SET status='executing',started_at=COALESCE(started_at,?) WHERE id=? AND status IN ('draft','blocked','executing')",
    ).run(now(), id);

    for (const target of this.refundSaga(id)!.targets) {
      if (target.status === "completed") continue;
      try {
        const result = this.redeemExactFreeChips(
          target.userId,
          target.amount,
          `emergency:${id}:${target.userId}`,
          "緊急返還",
          true,
        );
        this.db.prepare(
          "UPDATE casino_chip_refund_saga_targets SET status='completed',result_json=?,completed_at=?,failure=NULL WHERE saga_id=? AND user_id=?",
        ).run(JSON.stringify(result), now(), id, target.userId);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        this.db.prepare(
          "UPDATE casino_chip_refund_saga_targets SET status='failed',failure=? WHERE saga_id=? AND user_id=?",
        ).run(failure, id, target.userId);
        this.events.log("casino_emergency_redeem_failed", {
          actor: actorId,
          payload: { sagaId: id, userId: target.userId, error: failure },
        });
        return this.refundSaga(id)!;
      }
    }

    const rows = this.refundSaga(id)!;
    const redeemedTotal = rows.targets.reduce((sum, target) => sum + (target.result?.redeemed ?? 0), 0);
    const incomplete = rows.targets.filter((target) => target.status !== "completed");
    if (incomplete.length === 0 && redeemedTotal === rows.targetTotal) {
      this.db.prepare(
        "UPDATE casino_chip_refund_sagas SET status='completed',completed_at=?,failure_json=NULL WHERE id=? AND status='executing'",
      ).run(now(), id);
      this.events.log("casino_emergency_redeem_completed", {
        actor: actorId,
        payload: { sagaId: id, targetCount: rows.targetCount, targetTotal: rows.targetTotal },
      });
    } else if (incomplete.length === 0) {
      this.db.prepare(
        "UPDATE casino_chip_refund_sagas SET status='blocked',failure_json=? WHERE id=?",
      ).run(`postflight total mismatch: expected ${rows.targetTotal}, actual ${redeemedTotal}`, id);
    }
    return this.refundSaga(id)!;
  }

  /** 域外Land不足の確認票。承認前には一切の資金を動かさない。 */
  createExternalConfirmation(input: {
    id: string;
    userId: string;
    operationKind: string;
    operationId: string;
    requiredLand: number;
    expiresAt: number;
    chipAmount?: number;
  }): ExternalChipConfirmation {
    if (this.hasActiveOwnership(input.userId)) {
      throw new Error("進行中の勝負または預託があるため、Landへ戻して続ける操作はできません");
    }
    const chipAmount = input.chipAmount ?? this.assets.freeChips(input.userId);
    if (
      !input.id
      || !input.userId
      || !input.operationKind
      || !input.operationId
      || !Number.isSafeInteger(input.requiredLand)
      || input.requiredLand <= 0
      || !Number.isSafeInteger(chipAmount)
      || chipAmount <= 0
      || input.expiresAt <= now()
    ) {
      throw new Error("不正な域外操作確認票");
    }
    this.db.prepare(
      `INSERT INTO casino_chip_external_confirmations
       (id,user_id,operation_kind,operation_id,required_land,chip_amount,status,created_at,expires_at)
       VALUES (?,?,?,?,?,?,'pending',?,?)`,
    ).run(
      input.id,
      input.userId,
      input.operationKind,
      input.operationId,
      input.requiredLand,
      chipAmount,
      now(),
      input.expiresAt,
    );
    return this.externalConfirmation(input.id)!;
  }

  externalConfirmation(id: string): ExternalChipConfirmation | undefined {
    const row = this.db.prepare(
      "SELECT * FROM casino_chip_external_confirmations WHERE id=?",
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      operationKind: String(row.operation_kind),
      operationId: String(row.operation_id),
      requiredLand: Number(row.required_land),
      chipAmount: Number(row.chip_amount),
      status: row.status as ExternalChipConfirmation["status"],
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  cancelExternalConfirmation(id: string, userId: string): boolean {
    return this.db.prepare(
      "UPDATE casino_chip_external_confirmations SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'",
    ).run(id, userId).changes === 1;
  }

  beginExternalConfirmation(id: string, userId: string, at = now()): ExternalChipConfirmation {
    const row = this.externalConfirmation(id);
    if (!row || row.userId !== userId || row.status !== "pending") {
      throw new Error("この確認票は実行できません");
    }
    if (row.expiresAt < at) {
      this.db.prepare(
        "UPDATE casino_chip_external_confirmations SET status='expired' WHERE id=? AND status='pending'",
      ).run(id);
      throw new Error("この確認票は期限切れです");
    }
    if (this.hasActiveOwnership(userId)) {
      throw new Error("進行中の勝負または預託があるため、この確認票は実行できません");
    }
    if (this.assets.freeChips(userId) !== row.chipAmount) {
      throw new Error("賭場の自由チップ残高が確認時から変わっています");
    }
    if (this.db.prepare(
      "UPDATE casino_chip_external_confirmations SET status='executing' WHERE id=? AND user_id=? AND status='pending'",
    ).run(id, userId).changes !== 1) {
      throw new Error("この確認票は既に処理されています");
    }
    return this.externalConfirmation(id)!;
  }

  completeExternalConfirmation(id: string, userId: string): boolean {
    return this.db.prepare(
      "UPDATE casino_chip_external_confirmations SET status='completed',completed_at=? WHERE id=? AND user_id=? AND status='executing'",
    ).run(now(), id, userId).changes === 1;
  }

  /**
   * 承認された額をLandへ戻し、保存済みoperationIdで元操作を冪等に一度だけ再実行する。
   * 返還groupと元操作の両方が安定キーを持つため、途中クラッシュ後も二重に資金を動かさない。
   */
  executeExternalConfirmation<T>(
    id: string,
    userId: string,
    body: (operationId: string) => T,
    at = now(),
  ): T {
    let row = this.externalConfirmation(id);
    if (
      !row
      || row.userId !== userId
      || row.status === "cancelled"
      || row.status === "completed"
      || row.status === "expired"
    ) {
      throw new Error("この確認票は実行できません");
    }
    if (row.status === "pending") row = this.beginExternalConfirmation(id, userId, at);
    if (row.status !== "executing") throw new Error("この確認票は実行できません");

    this.redeemExactFreeChips(
      userId,
      row.chipAmount,
      `external:${id}`,
      `賭場外操作を続けるための返還:${row.operationKind}`,
      true,
    );
    const result = body(row.operationId);
    if (!this.completeExternalConfirmation(id, userId)) {
      throw new Error("域外確認票を完了できませんでした");
    }
    return result;
  }

  private redeemRows(
    rows: Array<{ userId: string; amount: number; updatedAt: number }>,
    prefix: string,
    reason: string,
    cutoffAt?: number,
    gate: RefundSafetyGate = {},
  ): InactiveRedeemResult {
    const result: InactiveRedeemResult = { redeemed: [], skipped: [], failed: [] };
    for (const row of rows) {
      try {
        const active = gate.activeGameUsers?.([row.userId]) ?? [];
        if (active.includes(row.userId) || this.hasActiveOwnership(row.userId)) {
          result.skipped.push(row.userId);
          continue;
        }
        if (this.globalBlockReason(gate)) {
          result.skipped.push(row.userId);
          continue;
        }
        if (cutoffAt != null && (this.lastActiveAt(row.userId) ?? 0) > cutoffAt) {
          result.skipped.push(row.userId);
          continue;
        }
        result.redeemed.push(
          this.redeemFreeChips(
            row.userId,
            `${prefix}:${row.userId}:${row.amount}:${row.updatedAt}${cutoffAt == null ? "" : `:${cutoffAt}`}`,
            reason,
          ),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const amount = this.assets.freeChips(row.userId);
        result.failed.push({ userId: row.userId, amount, error: detail });
        this.events.log("casino_free_chips_redeem_failed", {
          actor: "system:casino-chip-flow",
          payload: { userId: row.userId, amount, reason, error: detail },
        });
      }
    }
    return result;
  }

  private listFreeChipUsers(
    where = "1 = 1",
    params: unknown[] = [],
  ): Array<{ userId: string; amount: number; updatedAt: number }> {
    return this.db.prepare(
      `SELECT e.user_id AS userId, e.amount AS amount, e.updated_at AS updatedAt FROM ether_balances e
       JOIN accounts u ON u.id = 'user:' || e.user_id AND u.kind = 'user'
       LEFT JOIN casino_chip_activity a ON a.user_id = e.user_id
       WHERE e.amount > 0 AND ${where} ORDER BY e.user_id`,
    ).all(...params) as Array<{ userId: string; amount: number; updatedAt: number }>;
  }

  /**
   * プロセス内の席だけでなく、再起動をまたぐ予約・エスクロー・板の所有記録も確認する。
   * 呼出側がactiveGameUsersを渡し忘れても、資金の所有元が残る利用者を自動返還しない。
   */
  private hasActiveOwnership(userId: string): boolean {
    if (this.hasTable("casino_house_reservations")) {
      const reservation = this.db.prepare(
        "SELECT 1 FROM casino_house_reservations WHERE user_id=? LIMIT 1",
      ).get(userId);
      if (reservation) return true;
    }
    if (this.hasTable("casino_escrow")) {
      const escrow = this.db.prepare(
        "SELECT 1 FROM casino_escrow WHERE user_id=? LIMIT 1",
      ).get(userId);
      if (escrow) return true;
    }
    if (this.hasTable("casino_market_bets") && this.hasTable("casino_markets")) {
      const market = this.db.prepare(
        `SELECT 1
           FROM casino_market_bets b
           JOIN casino_markets m ON m.id=b.market_id
          WHERE b.user_id=?
            AND m.status IN (${MARKET_LIVE_STATUSES.map(() => "?").join(",")})
          LIMIT 1`,
      ).get(userId, ...MARKET_LIVE_STATUSES);
      if (market) return true;
    }
    if (this.hasTable("casino_pending_free_spins")) {
      const pending = this.db
        .prepare("SELECT 1 FROM casino_pending_free_spins WHERE user_id = ? AND status != 'settled' LIMIT 1")
        .get(userId);
      if (pending) return true;
    }
    return false;
  }

  private globalBlockReason(gate: RefundSafetyGate): string | null {
    if (this.chips.chipTx.isActive() || gate.processingGroup?.()) return "chip_group_active";
    if (gate.integrityBlocked?.()) return "integrity_blocked";
    return null;
  }

  private sagaStaleReason(saga: RefundSaga): string | null {
    for (const target of saga.targets) {
      if (target.status === "completed") continue;
      const settledGroup = this.hasTable("casino_tx_groups")
        ? this.db.prepare("SELECT 1 FROM casino_tx_groups WHERE group_key=? AND status='settled'").get(target.groupKey)
        : undefined;
      if (settledGroup) continue;
      const actual = this.assets.freeChips(target.userId);
      if (actual !== target.amount) {
        return `返還案作成後に残高が変化しました: ${target.userId} expected=${target.amount} actual=${actual}`;
      }
    }
    return null;
  }

  private refundBlockReason(saga: RefundSaga, gate: RefundSafetyGate): string | null {
    const global = this.globalBlockReason(gate);
    if (global === "chip_group_active") return "金銭処理中のため緊急返還を停止しました";
    if (global === "integrity_blocked") return "検算停止中のため緊急返還を停止しました";
    const active = new Set(gate.activeGameUsers?.(saga.targets.map((target) => target.userId)) ?? []);
    for (const target of saga.targets) {
      if (this.hasActiveOwnership(target.userId)) active.add(target.userId);
    }
    if (active.size > 0) {
      return `進行中ゲームの利用者がいるため緊急返還を停止しました: ${[...active].join(",")}`;
    }
    return null;
  }
}
