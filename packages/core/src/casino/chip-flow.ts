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

/**
 * 返還しなかった理由。`userId: null` は全体停止（誰も処理していない）。
 * 種類・理由・残高を構造化して残さないと、「未返還のまま open した」ことを
 * 後から検証できない（監査項目3・8）。
 */
export interface RedeemSkip {
  userId: string | null;
  amount: number;
  reason:
    | "active_ownership"
    | "recent_activity"
    | "chip_group_active"
    | "integrity_blocked"
    | "opening_not_formal";
}

export interface InactiveRedeemResult {
  redeemed: RedeemResult[];
  skipped: RedeemSkip[];
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

export interface CasinoChipFlowOptions {
  /**
   * プロセス内の着席（ソロゲーム進行中）。core からは見えないので Bot 側が渡す。
   *
   * 監査ブロッカー（項目11）: ショップの域外確認票は core の
   * {@link CasinoChipFlow.hasActiveOwnership} しか見ておらず、`casino_escrow` にも
   * 板にも現れない「進行中のソロゲーム」を素通ししていた。ゲーム中に自由チップを
   * Land へ戻すと、その手の精算原資が消える。所有判定の正本をここへ集約し、
   * 返還・確認票・緊急返還のすべてが同じ集合を見るようにする。
   */
  isSeatOccupied?: (userId: string) => boolean;
}

/**
 * 進行中の所有があるので資金を動かせない（監査ブロッカーA）。
 *
 * **グループの中から投げる**ことに意味がある。skip を戻り値で返すと
 * `runGroup` が 0 円のグループを settled として保存し、以後その operationId は
 * 所有が解けたあとの再試行でも永久に「返還済み（0円）」を replay してしまう。
 * 例外なら同じトランザクションでグループごと巻き戻るので、再試行できる。
 */
export class ActiveOwnershipError extends Error {
  readonly code = "ERR_ACTIVE_OWNERSHIP";
  constructor(readonly userId: string) {
    super(`active ownership prevents free-chip redemption: ${userId}`);
    this.name = "ActiveOwnershipError";
  }
}

const REFUND_SAGA_STATUSES: ReadonlySet<string> = new Set([
  "draft", "executing", "completed", "blocked", "cancelled",
]);
const REFUND_TARGET_STATUSES: ReadonlySet<string> = new Set(["pending", "completed", "failed", "blocked"]);
const CONFIRMATION_STATUSES: ReadonlySet<string> = new Set([
  "pending", "executing", "completed", "cancelled", "expired",
]);

/**
 * DB 由来の数値を必ず safe integer として読む（監査項目12・15）。
 * `Number()` で黙って変換すると、破損した行の `NaN` や 1e30 がそのまま
 * 返還額・合計検算へ流れ込む。分からない値は fail-closed にする。
 */
function dbInt(value: unknown, field: string, opts: { min?: number } = {}): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`corrupt ${field}: ${String(value)}`);
  if (opts.min != null && parsed < opts.min) throw new Error(`corrupt ${field}: ${String(value)}`);
  return parsed;
}

function dbEnum<T extends string>(value: unknown, allowed: ReadonlySet<string>, field: string): T {
  const text = String(value);
  if (!allowed.has(text)) throw new Error(`corrupt ${field}: ${text}`);
  return text as T;
}

/** 保存済みの返還結果。壊れた JSON は「返還済み」と読めないので fail-closed にする。 */
function parseTargetResult(value: unknown): RedeemResult | undefined {
  if (value == null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("corrupt saga_target.result_json");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("corrupt saga_target.result_json");
  const record = parsed as Record<string, unknown>;
  return {
    userId: String(record.userId),
    redeemed: dbInt(record.redeemed, "saga_target.result.redeemed", { min: 0 }),
    land: dbInt(record.land, "saga_target.result.land", { min: 0 }),
    reason: String(record.reason ?? ""),
    skipped: record.skipped === "active_ownership" ? "active_ownership" : undefined,
  };
}

/** 鍵に混ぜる識別子。区切り文字の注入で別操作の鍵と衝突させない（監査項目15）。 */
function assertOperationId(value: string, field: string): void {
  if (!value || value.trim() === "") throw new Error(`${field} is required`);
  if (value.includes(":")) throw new Error(`${field} must not contain ':'`);
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
    private readonly options: CasinoChipFlowOptions = {},
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
    assertOperationId(userId, "userId");
    assertOperationId(operationId, "operationId");
    const stored = this.chips.runGroup(
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
    // 保存済みの結果を返した場合（＝2度目）、当時の required と違うなら
    // **別の業務操作が同じ operationId を使っている**（監査項目6）。
    // そのまま返すと、呼出側は満たされていない額を「預入済み」と信じて拘束へ進む。
    if (stored.required !== required) {
      throw new Error(
        `chip auto-deposit operation conflict: ${operationId} stored required ${stored.required}, requested ${required}`,
      );
    }
    return stored;
  }

  /**
   * 利用者の自由チップだけをLandへ全額返す。
   *
   * 進行中の所有がある場合は**グループを作らずに** skip を返す。0円グループを
   * settled にすると、所有が解けたあとの再試行が永久に replay されてしまう（監査ブロッカーA）。
   */
  redeemFreeChips(userId: string, operationId: string, reason: string): RedeemResult {
    const groupKey = `chip:free-redeem:${userId}:${operationId}`;
    const skip = (): RedeemResult => ({ userId, redeemed: 0, land: 0, reason, skipped: "active_ownership" });
    // 既に確定済みの操作は replay させる（所有が生まれていても結果は変わらない）
    if (!this.chips.chipTx.hasGroup(groupKey) && this.hasActiveOwnership(userId)) return skip();
    try {
      return this.chips.runGroup(
        { groupKey, kind: "redeem", actorId: `user:${userId}` },
        () => {
          // 外側の確認からここまでの間に所有が生まれた場合（競合）。
          // 例外にしてグループごと巻き戻し、再試行できる状態を残す
          if (this.hasActiveOwnership(userId)) throw new ActiveOwnershipError(userId);
          const redeemed = this.assets.freeChips(userId);
          if (redeemed) {
            this.chips.redeem(userId, redeemed, groupKey);
          }
          this.touch(userId);
          this.events.log("casino_free_chips_redeemed", {
            actor: userId,
            payload: { redeemed, reason, operationId },
          });
          return { userId, redeemed, land: redeemed, reason };
        },
      );
    } catch (error) {
      if (error instanceof ActiveOwnershipError) return skip();
      throw error;
    }
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
        if (this.hasActiveOwnership(userId)) throw new ActiveOwnershipError(userId);
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
      return { redeemed: [], skipped: [{ userId: null, amount: 0, reason: globalBlock }], failed: [] };
    }
    return this.redeemRows(
      this.listFreeChipUsers("COALESCE(a.last_active_at, e.updated_at) <= ?", [cutoffAt]),
      operationPrefix,
      "10分無操作",
      cutoffAt,
      gate,
    );
  }

  /** 起動復旧用。利用者自由チップだけなのでsystem holderには触れない。 */
  redeemAllFreeChips(operationPrefix = "startup", gate: RefundSafetyGate = {}): InactiveRedeemResult {
    const globalBlock = this.globalBlockReason(gate);
    if (globalBlock) {
      return { redeemed: [], skipped: [{ userId: null, amount: 0, reason: globalBlock }], failed: [] };
    }
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
    // DB 由来の値は必ず検証してから使う。未知 status・NaN・負数・不正 JSON を
    // 素通しすると、状態機械の外にいる saga がそのまま資金を動かす（監査項目12・15）
    return {
      id: String(row.id),
      scope: dbEnum<"user" | "all">(row.scope, new Set(["user", "all"]), "saga.scope"),
      requestedBy: String(row.requested_by),
      targetUserId: row.target_user_id == null ? null : String(row.target_user_id),
      status: dbEnum<RefundSagaStatus>(row.status, REFUND_SAGA_STATUSES, "saga.status"),
      targetCount: dbInt(row.target_count, "saga.target_count", { min: 0 }),
      targetTotal: dbInt(row.target_total, "saga.target_total", { min: 0 }),
      createdAt: dbInt(row.created_at, "saga.created_at", { min: 0 }),
      startedAt: row.started_at == null ? null : dbInt(row.started_at, "saga.started_at", { min: 0 }),
      completedAt: row.completed_at == null ? null : dbInt(row.completed_at, "saga.completed_at", { min: 0 }),
      failure: row.failure_json == null ? undefined : String(row.failure_json),
      targets: targets.map((target) => ({
        userId: String(target.user_id),
        amount: dbInt(target.amount, "saga_target.amount", { min: 0 }),
        status: dbEnum<RefundSagaTarget["status"]>(target.status, REFUND_TARGET_STATUSES, "saga_target.status"),
        groupKey: String(target.group_key),
        result: parseTargetResult(target.result_json),
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

    // 実行権はここでしか取れない。UPDATE の件数を見ないと、状態機械の外にいる
    // saga（未知 status・cancelled 直後など）でも下のループが資金を動かす（監査項目12）
    const claimed = this.db.prepare(
      "UPDATE casino_chip_refund_sagas SET status='executing',started_at=COALESCE(started_at,?) WHERE id=? AND status IN ('draft','blocked','executing')",
    ).run(now(), id).changes;
    if (claimed !== 1) throw new Error("この緊急返還案は実行できる状態ではありません");

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
    // 返還しても足りないなら確認票を出さない（監査項目13）。出してしまうと
    // 「押す → 自由チップは Land へ出る → 元操作は残高不足で失敗」となり、
    // 賭場から資金だけ引き上げて何も買えない状態が残る。
    if (chipAmount < input.requiredLand) {
      throw new Error(
        `自由チップを返しても不足します（不足 ${input.requiredLand} / 返還可能 ${chipAmount}）`,
      );
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
    const status = dbEnum<ExternalChipConfirmation["status"]>(
      row.status, CONFIRMATION_STATUSES, "confirmation.status",
    );
    const chipAmount = dbInt(row.chip_amount, "confirmation.chip_amount", { min: 0 });
    // 旧DBへ `chip_amount INTEGER NOT NULL DEFAULT 0` を後付けした行が残ることがある。
    // 額 0 の確認票を「正常な pending」として扱うと、返還も検算もしないまま
    // 元操作だけが走る。生きている状態の 0 円票は明示的に検算不能とする（監査項目14）。
    if (chipAmount <= 0 && (status === "pending" || status === "executing")) {
      throw new Error(`confirmation.chip_amount is not verifiable: ${String(row.id)}`);
    }
    return {
      id: String(row.id),
      userId: String(row.user_id),
      operationKind: String(row.operation_kind),
      operationId: String(row.operation_id),
      requiredLand: dbInt(row.required_land, "confirmation.required_land", { min: 0 }),
      chipAmount,
      status,
      createdAt: dbInt(row.created_at, "confirmation.created_at", { min: 0 }),
      expiresAt: dbInt(row.expires_at, "confirmation.expires_at", { min: 0 }),
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

  /**
   * 期限切れの確認票を回収する（監査項目13）。
   *
   * `pending` は資金が動いていないので `expired` にするだけでよい。
   * `executing` は**返還だけが済んで元操作が終わっていない**状態なので、
   * 期限内は再実行で続きから再開できるように残し、期限を過ぎたものだけを
   * 終端へ落とす。資金は既に Land 側にあり、失われていない。
   * 放置すると UI からも `cancel` からも触れない行が永久に残る。
   */
  expireStaleConfirmations(at = now()): { pending: number; executing: number } {
    const pending = this.db.prepare(
      "UPDATE casino_chip_external_confirmations SET status='expired' WHERE status='pending' AND expires_at < ?",
    ).run(at).changes;
    const executing = this.db.prepare(
      "UPDATE casino_chip_external_confirmations SET status='expired',completed_at=? WHERE status='executing' AND expires_at < ?",
    ).run(at, at).changes;
    if (executing > 0) {
      try {
        this.events.log("casino_external_confirmation_stranded", {
          actor: "system:casino-chip-flow",
          payload: { count: executing, note: "返還済み・元操作未完了のまま期限切れ（資金はLand側）" },
        });
      } catch {
        // 記録の失敗で状態遷移そのものを巻き戻さない
      }
    }
    return { pending, executing };
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
    // 元操作が失敗しても executing のまま**残す**。返還グループも元操作も安定キーなので、
    // 同じ確認票をもう一度実行すれば資金を二重に動かさず続きから再開できる（監査項目13）。
    // 放置されたまま残らないよう、期限を過ぎた executing は
    // {@link expireStaleConfirmations} が回収する。
    const result = body(row.operationId);
    if (!this.completeExternalConfirmation(id, userId)) {
      throw new Error("域外確認票を完了できませんでした");
    }
    return result;
  }

  private redeemRows(
    rows: Array<{ userId: string; amount: number; generation: number }>,
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
          result.skipped.push({ userId: row.userId, amount: row.amount, reason: "active_ownership" });
          continue;
        }
        const blocked = this.globalBlockReason(gate);
        if (blocked) {
          result.skipped.push({ userId: row.userId, amount: row.amount, reason: blocked });
          continue;
        }
        if (cutoffAt != null && (this.lastActiveAt(row.userId) ?? 0) > cutoffAt) {
          result.skipped.push({ userId: row.userId, amount: row.amount, reason: "recent_activity" });
          continue;
        }
        const outcome = this.redeemFreeChips(
          row.userId,
          `${prefix}:${row.userId}:${row.amount}:${row.generation}${cutoffAt == null ? "" : `:${cutoffAt}`}`,
          reason,
        );
        // 資金が動いていない skip を「返還済み」へ混ぜない（監査ブロッカーA）。
        // ここを取り違えると S10 が未返還の利用者を抱えたまま成功扱いで open する。
        if (outcome.skipped) {
          result.skipped.push({ userId: row.userId, amount: row.amount, reason: "active_ownership" });
        } else {
          result.redeemed.push(outcome);
        }
      } catch (error) {
        // 監査記録そのものが例外を外へ漏らすと、1人の破損でループ全体が抜けて
        // 後続の利用者が永久に処理されない（監査ブロッカーB）。
        // 額は候補取得時に固定したものを使い、破損した残高の再読込へは依存しない。
        const detail = error instanceof Error ? error.message : String(error);
        result.failed.push({ userId: row.userId, amount: row.amount, error: detail });
        try {
          this.events.log("casino_free_chips_redeem_failed", {
            actor: "system:casino-chip-flow",
            payload: { userId: row.userId, amount: row.amount, reason, error: detail },
          });
        } catch {
          // event 記録の失敗で資金処理の結果（failed 一覧）を失わせない
        }
      }
    }
    return result;
  }

  /**
   * 返還候補。`accounts.kind='user'` と結合しているので、escrow・胴元・JP・
   * quarantine・system holder・孤児残高は構造的に候補へ入らない。
   *
   * ## 冪等キーには時刻ではなく取引世代を使う（監査項目7）
   *
   * 以前は `ether_balances.updated_at`（**秒精度**）を鍵に混ぜていた。
   * 「100 Ld 返還 → 同じ秒に 100 Ld 再預入 → もう一度 100 Ld 返還」が
   * 同一キーになり、2回目の返還が replay されて資金が動かないまま
   * 「返還済み」と報告されうる。`casino_tx.id` は AUTOINCREMENT なので、
   * その利用者に触れた最後の取引 ID を**単調な残高世代**として使う。
   *
   * `last_active_at` は `COALESCE` で残高更新時刻へ落とす。activity 行が無い
   * 利用者（PR10 以前からの残高保有者など）が無操作返還の対象から
   * 永久に外れる穴を塞ぐ（監査項目9）。
   */
  private listFreeChipUsers(
    where = "1 = 1",
    params: unknown[] = [],
  ): Array<{ userId: string; amount: number; generation: number }> {
    return this.db.prepare(
      `SELECT e.user_id AS userId, e.amount AS amount,
              COALESCE((SELECT MAX(t.id) FROM casino_tx t
                         WHERE t.from_holder = e.user_id OR t.to_holder = e.user_id), 0) AS generation
         FROM ether_balances e
         JOIN accounts u ON u.id = 'user:' || e.user_id AND u.kind = 'user'
         LEFT JOIN casino_chip_activity a ON a.user_id = e.user_id
        WHERE e.amount > 0 AND ${where} ORDER BY e.user_id`,
    ).all(...params) as Array<{ userId: string; amount: number; generation: number }>;
  }

  /**
   * プロセス内の席だけでなく、再起動をまたぐ予約・エスクロー・板の所有記録も確認する。
   * 呼出側がactiveGameUsersを渡し忘れても、資金の所有元が残る利用者を自動返還しない。
   */
  private hasActiveOwnership(userId: string): boolean {
    // プロセス内の着席（ソロゲーム進行中）。DB のどの表にも現れないので、
    // ここで見ないとゲーム中に自由チップを Land へ戻せてしまう（監査ブロッカー・項目11）
    if (this.options.isSeatOccupied?.(userId)) return true;
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

  private globalBlockReason(gate: RefundSafetyGate): "chip_group_active" | "integrity_blocked" | null {
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
