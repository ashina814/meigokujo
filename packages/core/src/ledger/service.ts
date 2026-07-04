import type Database from "better-sqlite3";
import { LedgerError } from "./errors.js";
import { getTxType, type AccountKind } from "./registry.js";

export const TREASURY = "sys:treasury";

export interface AccountRow {
  id: string;
  kind: AccountKind;
  status: "active" | "frozen";
  created_at: number;
}

export interface TxRow {
  id: number;
  idempotency_key: string;
  from_account: string;
  to_account: string;
  amount: number;
  type: string;
  reason: string | null;
  ref_type: string | null;
  ref_id: string | null;
  actor_id: string;
  approved_by: string | null;
  reversal_of: number | null;
  created_at: number;
}

export interface TransferRequest {
  from: string;
  to: string;
  amount: number;
  type: string;
  actor: string;
  idempotencyKey: string;
  reason?: string;
  refType?: string;
  refId?: string;
  /** 高額承認（#決裁）を通した場合の承認者。閾値超はこれが無いと ERR_NEEDS_APPROVAL */
  approvedBy?: string;
}

export interface TransferResult {
  tx: TxRow;
  /** 冪等キー衝突＝処理済みだった場合 true（エラーではなく成功扱いで返す） */
  duplicate: boolean;
}

export interface LedgerOptions {
  /** これを超える取引は approvedBy 必須（既定 1,000,000 Ld）。関数を渡すと毎回評価＝設定変更が即反映 */
  approvalThreshold?: number | (() => number);
  /** 1取引の絶対上限（誤入力・暴走ガード） */
  maxAmount?: number;
  /** 未成年判定。魂台帳と接続する（未接続なら全員成人扱い） */
  isMinor?: (accountId: string) => boolean;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Land 経済の唯一の真実源（経済設計.md）。
 * 不変条件: 残高直接書き換えAPIなし / 追記専用 / ユーザー口座は非負（国庫のみ負を許す）/
 * 全取引に actor / 冪等 / 通知は outbox 分離。
 */
export class Ledger {
  private readonly approvalThresholdOpt: number | (() => number);
  private readonly maxAmount: number;
  private readonly isMinor: (accountId: string) => boolean;

  constructor(
    private readonly db: Database.Database,
    options: LedgerOptions = {},
  ) {
    this.approvalThresholdOpt = options.approvalThreshold ?? 1_000_000;
    this.maxAmount = options.maxAmount ?? 100_000_000;
    this.isMinor = options.isMinor ?? (() => false);
    this.ensureAccount(TREASURY, "system");
  }

  private get approvalThreshold(): number {
    return typeof this.approvalThresholdOpt === "function"
      ? this.approvalThresholdOpt()
      : this.approvalThresholdOpt;
  }

  ensureAccount(id: string, kind: AccountKind): void {
    this.db
      .prepare(
        "INSERT INTO accounts (id, kind, status, created_at) VALUES (?, ?, 'active', ?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, kind, now());
  }

  getAccount(id: string): AccountRow | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  }

  setAccountStatus(id: string, status: "active" | "frozen"): void {
    const changed = this.db.prepare("UPDATE accounts SET status = ? WHERE id = ?").run(status, id);
    if (changed.changes === 0) throw new LedgerError("ERR_ACCOUNT_NOT_FOUND", { accountId: id });
  }

  balanceOf(accountId: string): number {
    const row = this.db.prepare("SELECT amount FROM balances WHERE account_id = ?").get(accountId) as
      | { amount: number }
      | undefined;
    return row?.amount ?? 0;
  }

  getTx(id: number): TxRow | undefined {
    return this.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as TxRow | undefined;
  }

  findByIdempotencyKey(key: string): TxRow | undefined {
    return this.db.prepare("SELECT * FROM transactions WHERE idempotency_key = ?").get(key) as
      | TxRow
      | undefined;
  }

  history(accountId: string, opts: { limit?: number; offset?: number } = {}): TxRow[] {
    const limit = Math.min(opts.limit ?? 20, 100);
    const offset = opts.offset ?? 0;
    return this.db
      .prepare(
        `SELECT * FROM transactions
         WHERE from_account = ? OR to_account = ?
         ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(accountId, accountId, limit, offset) as TxRow[];
  }

  transfer(req: TransferRequest): TransferResult {
    // 冪等: 同じキーは2度実行されない。既存取引を成功として返す
    const existing = this.findByIdempotencyKey(req.idempotencyKey);
    if (existing) return { tx: existing, duplicate: true };

    if (!Number.isSafeInteger(req.amount) || req.amount <= 0) {
      throw new LedgerError("ERR_INVALID_AMOUNT", { amount: req.amount });
    }
    if (req.amount > this.maxAmount) {
      throw new LedgerError("ERR_INVALID_AMOUNT", { amount: req.amount, max: this.maxAmount });
    }
    if (req.from === req.to) {
      throw new LedgerError("ERR_SELF_TRANSFER", { account: req.from });
    }

    const policy = getTxType(req.type);
    const from = this.getAccount(req.from);
    const to = this.getAccount(req.to);
    if (!from) throw new LedgerError("ERR_ACCOUNT_NOT_FOUND", { accountId: req.from });
    if (!to) throw new LedgerError("ERR_ACCOUNT_NOT_FOUND", { accountId: req.to });
    if (!policy.fromKinds.includes(from.kind)) {
      throw new LedgerError("ERR_KIND_MISMATCH", { side: "from", type: req.type, kind: from.kind });
    }
    if (!policy.toKinds.includes(to.kind)) {
      throw new LedgerError("ERR_KIND_MISMATCH", { side: "to", type: req.type, kind: to.kind });
    }
    if (from.status !== "active") throw new LedgerError("ERR_FROZEN", { accountId: from.id });
    if (to.status !== "active") throw new LedgerError("ERR_FROZEN", { accountId: to.id });

    if (policy.minorBlocked) {
      const minorParty = [from, to].find((a) => a.kind === "user" && this.isMinor(a.id));
      if (minorParty) {
        throw new LedgerError("ERR_MINOR_BLOCKED", { type: req.type, accountId: minorParty.id });
      }
    }

    if (req.amount > this.approvalThreshold && !req.approvedBy) {
      throw new LedgerError("ERR_NEEDS_APPROVAL", {
        amount: req.amount,
        threshold: this.approvalThreshold,
      });
    }

    const run = this.db.transaction((): TxRow => {
      // 残高チェックと更新を同一トランザクションで行う（競合の構造的排除）
      const fromBalance = this.balanceOf(req.from);
      if (from.kind !== "system" || from.id !== TREASURY) {
        // 負残高を許すのは国庫だけ。エスクロー含む他の口座はすべて非負
        if (fromBalance < req.amount) {
          throw new LedgerError("ERR_INSUFFICIENT", {
            accountId: req.from,
            balance: fromBalance,
            required: req.amount,
          });
        }
      }

      const ts = now();
      const inserted = this.db
        .prepare(
          `INSERT INTO transactions
             (idempotency_key, from_account, to_account, amount, type, reason,
              ref_type, ref_id, actor_id, approved_by, reversal_of, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.idempotencyKey,
          req.from,
          req.to,
          req.amount,
          req.type,
          req.reason ?? null,
          req.refType ?? null,
          req.refId ?? null,
          req.actor,
          req.approvedBy ?? null,
          (req as { reversalOf?: number }).reversalOf ?? null,
          ts,
        );

      this.applyBalance(req.from, -req.amount, ts);
      this.applyBalance(req.to, req.amount, ts);

      const tx = this.getTx(Number(inserted.lastInsertRowid));
      if (!tx) throw new LedgerError("ERR_TX_NOT_FOUND", { id: inserted.lastInsertRowid });

      // 通知は金銭処理と分離: 同一コミットで outbox に積み、配送は別ループ（経済設計.md §7）
      this.enqueueOutbox("audit_log", tx, ts);
      if (policy.publicLog) this.enqueueOutbox("public_log", tx, ts);
      return tx;
    });

    return { tx: run(), duplicate: false };
  }

  /**
   * 巻き戻し＝逆方向の新規取引。元の取引は消えない（経済設計.md §6）。
   * 相手が使い切っていて残高不足なら失敗させる（自動の部分回収はしない）。
   */
  reverse(txId: number, actor: string, reason: string): TransferResult {
    const original = this.getTx(txId);
    if (!original) throw new LedgerError("ERR_TX_NOT_FOUND", { id: txId });
    if (original.reversal_of !== null) {
      throw new LedgerError("ERR_REVERSAL_OF_REVERSAL", { id: txId });
    }
    const already = this.db
      .prepare("SELECT id FROM transactions WHERE reversal_of = ?")
      .get(txId) as { id: number } | undefined;
    if (already) throw new LedgerError("ERR_ALREADY_REVERSED", { id: txId, reversalId: already.id });

    const req: TransferRequest & { reversalOf: number } = {
      from: original.to_account,
      to: original.from_account,
      amount: original.amount,
      type: original.type,
      actor,
      reason,
      refType: "reversal",
      refId: String(txId),
      idempotencyKey: `reverse:${txId}`,
      approvedBy: actor, // 巻き戻しは運営操作なので承認閾値を承認者=実行者で通す
      reversalOf: txId,
    };
    return this.transfer(req);
  }

  /**
   * 検算: transactions から全残高を再計算して balances と突合し、
   * 恒等式「Σ(全口座残高) = 0」も確認する（経済設計.md §8）。
   */
  verifyIntegrity(): { ok: boolean; mismatches: Array<{ accountId: string; cached: number; computed: number }> } {
    const computed = new Map<string, number>();
    const rows = this.db
      .prepare("SELECT from_account, to_account, amount FROM transactions")
      .all() as Array<{ from_account: string; to_account: string; amount: number }>;
    for (const r of rows) {
      computed.set(r.from_account, (computed.get(r.from_account) ?? 0) - r.amount);
      computed.set(r.to_account, (computed.get(r.to_account) ?? 0) + r.amount);
    }

    const mismatches: Array<{ accountId: string; cached: number; computed: number }> = [];
    const cachedRows = this.db.prepare("SELECT account_id, amount FROM balances").all() as Array<{
      account_id: string;
      amount: number;
    }>;
    const cachedMap = new Map(cachedRows.map((r) => [r.account_id, r.amount]));

    const allAccounts = new Set([...computed.keys(), ...cachedMap.keys()]);
    let total = 0;
    for (const id of allAccounts) {
      const c = computed.get(id) ?? 0;
      const cached = cachedMap.get(id) ?? 0;
      total += c;
      if (c !== cached) mismatches.push({ accountId: id, cached, computed: c });
    }
    if (total !== 0) {
      mismatches.push({ accountId: "__identity__", cached: 0, computed: total });
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  /** 通貨発行残高 = 国庫残高の符号反転（経済設計.md §2） */
  moneySupply(): number {
    return -this.balanceOf(TREASURY) || 0; // 「-0」表示を防ぐ
  }

  /** 期間内の発行量（国庫→住人）・回収量（住人→国庫）。計器盤の経済指標用 */
  flowBetween(fromTs: number, toTs: number): { issued: number; collected: number; net: number } {
    const issued = (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE from_account = ? AND created_at >= ? AND created_at < ?",
        )
        .get(TREASURY, fromTs, toTs) as { s: number }
    ).s;
    const collected = (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE to_account = ? AND created_at >= ? AND created_at < ?",
        )
        .get(TREASURY, fromTs, toTs) as { s: number }
    ).s;
    return { issued, collected, net: issued - collected };
  }

  /** エスクロー・部署などシステム勘定に眠っている総額（国庫を除く） */
  escrowTotal(): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(amount),0) AS s FROM balances WHERE account_id LIKE 'sys:%' AND account_id != ?",
        )
        .get(TREASURY) as { s: number }
    ).s;
  }

  pendingOutbox(limit = 50): Array<{ id: number; kind: string; payload: string; attempts: number }> {
    // 10回失敗したエントリは配送を諦める（詰まり防止。データは残るので手動で追える）
    return this.db
      .prepare(
        "SELECT id, kind, payload, attempts FROM outbox WHERE delivered_at IS NULL AND attempts < 10 ORDER BY id LIMIT ?",
      )
      .all(limit) as Array<{ id: number; kind: string; payload: string; attempts: number }>;
  }

  markOutboxDelivered(id: number): void {
    this.db.prepare("UPDATE outbox SET delivered_at = ? WHERE id = ?").run(now(), id);
  }

  incrementOutboxAttempts(id: number): void {
    this.db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  private applyBalance(accountId: string, delta: number, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO balances (account_id, amount, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET amount = amount + excluded.amount, updated_at = excluded.updated_at`,
      )
      .run(accountId, delta, ts);
  }

  private enqueueOutbox(kind: string, tx: TxRow, ts: number): void {
    this.db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)").run(
      kind,
      JSON.stringify({
        txId: tx.id,
        type: tx.type,
        from: tx.from_account,
        to: tx.to_account,
        amount: tx.amount,
        reason: tx.reason,
        actor: tx.actor_id,
        refType: tx.ref_type,
        refId: tx.ref_id,
      }),
      ts,
    );
  }
}
