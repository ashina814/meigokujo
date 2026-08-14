import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import type { SoulStatus } from "../rank/sync.js";

/**
 * サブ垢。
 *
 * ```
 * 申請（サブ垢のID入力） → 運営が本人確認して承認 → 本人が80,000Ld支払い → 有効化
 * ```
 *
 * ## 先払いに戻さない
 *
 * 旧仕様は「先に払ってから人が処理」だった。通らなかったときに返金の仕事が生まれるので、
 * **申請でも承認でも Land を動かさない。** 支払いは承認のあとの本人の操作だけ。
 *
 * ## この表が main ↔ alt の正本
 *
 * 旧商品の購入履歴には「買った」という事実しか無く、**どのアカウントがサブ垢かの記録が
 * 一切無い**。だから対応はここに持ち、購入履歴から推測しない。
 *
 * ## サブ垢は「新しい入城者」ではない
 *
 * 入城処理（`ghostify`）は初期発行・評価期間の開始・招待実績の確定までやる。サブ垢に
 * これを流すと、同じ人が二重に初期発行を受け、評価期間まで生える。**流用しない。**
 * サブ垢に与えるのは本体と同じ階級ロールだけで、階級は本体に追従させる。
 */

/**
 * サブ垢を持てる階級（魔人以上）。
 *
 * **判定は Discord のロールではなく `souls.status` を正本にする。** ロールを見ると、
 * 迷霊なのに階級ロールが残っている人が要件を素通りする。実際、旧商品#4は要件そのものが
 * 未設定で、迷霊のまま購入が成立した事例が出た。
 */
export const SUB_ACCOUNT_ELIGIBLE_RANKS: readonly SoulStatus[] = ["majin", "kenma", "mazoku"];

export function isEligibleMainRank(status: SoulStatus | null | undefined): boolean {
  return status !== null && status !== undefined && SUB_ACCOUNT_ELIGIBLE_RANKS.includes(status);
}

export type SubAccountStatus = "pending" | "approved" | "active" | "returned" | "rejected" | "cancelled";
export type SubAccountRankOperationKind = "sync" | "deactivate";

/** 進行中とみなす状態。ここに居る間は同じ相手を重ねて登録できない */
export const SUB_ACCOUNT_OPEN_STATUSES: readonly SubAccountStatus[] = ["pending", "approved", "active"];

export interface SubAccountRow {
  id: number;
  main_user_id: string;
  alt_user_id: string;
  status: SubAccountStatus;
  purchase_id: number | null;
  approved_by: string | null;
  approved_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  decide_reason: string | null;
  activated_at: number | null;
  /** 人が旧契約の main/alt を突き合わせて引き継いだ時刻。解除後も未引き継ぎ判定に使う。 */
  legacy_imported_at: number | null;
  activation_rank_baseline: string | null;
  activation_rank_settled_at: number | null;
  created_at: number;
  updated_at: number;
}

/** 承認したまま支払われない申請を畳むまでの日数 */
export const SUB_ACCOUNT_PAYMENT_GRACE_DAYS = 7;

const DAY = 86_400;
const now = (): number => Math.floor(Date.now() / 1000);

export type SubAccountErrorCode =
  | "ERR_NOT_FOUND"
  | "ERR_NOT_OWNER"
  | "ERR_BAD_STATUS"
  /** 自分自身をサブ垢にはできない */
  | "ERR_SELF"
  /** そのサブ垢は既に誰かのサブ垢 */
  | "ERR_ALT_TAKEN"
  /** そのサブ垢は既に本体として登録されている */
  | "ERR_ALT_IS_MAIN"
  /** 申請者自身が誰かのサブ垢 */
  | "ERR_MAIN_IS_ALT"
  /** 本体が魔人未満 */
  | "ERR_RANK_TOO_LOW";

export class SubAccountError extends Error {
  constructor(readonly code: SubAccountErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "SubAccountError";
  }
}

export class SubAccounts {
  constructor(
    private readonly db: Database.Database,
    private readonly events: EventLog,
  ) {}

  get(id: number): SubAccountRow | null {
    return (this.db.prepare("SELECT * FROM sub_accounts WHERE id = ?").get(id) as SubAccountRow) ?? null;
  }

  listByStatus(status: SubAccountStatus, limit = 50, offset = 0): SubAccountRow[] {
    return this.db
      .prepare("SELECT * FROM sub_accounts WHERE status = ? ORDER BY created_at, id LIMIT ? OFFSET ?")
      .all(status, limit, offset) as SubAccountRow[];
  }

  countByStatus(status: SubAccountStatus): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sub_accounts WHERE status = ?").get(status) as { c: number }).c;
  }

  /** その人が出している申請・持っているサブ垢（既定では進行中だけ） */
  listByMain(mainUserId: string, statuses: readonly SubAccountStatus[] = SUB_ACCOUNT_OPEN_STATUSES): SubAccountRow[] {
    const marks = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM sub_accounts WHERE main_user_id = ? AND status IN (${marks}) ORDER BY id`)
      .all(mainUserId, ...statuses) as SubAccountRow[];
  }

  /** 有効なサブ垢すべて（階級の追従に使う） */
  listActive(limit = 500): SubAccountRow[] {
    return this.db
      .prepare("SELECT * FROM sub_accounts WHERE status = 'active' ORDER BY id LIMIT ?")
      .all(limit) as SubAccountRow[];
  }

  /** 旧契約の組み合わせを人が一度でも明示登録したか。解除済みも履歴として含む。 */
  hasLegacyImport(mainUserId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM sub_accounts WHERE main_user_id = ? AND legacy_imported_at IS NOT NULL LIMIT 1")
        .get(mainUserId),
    );
  }

  /**
   * Discord階級操作の短期leaseを取る。
   *
   * scheduler同期と運営解除は同じ契約へ同時に副作用を出してはいけない。DBの
   * immediate transactionでclaimを直列化し、古い一覧を読んだschedulerもここで止める。
   * クラッシュでleaseが残っても期限後に再取得でき、activeなら同期へ収束する。
   */
  claimRankOperation(
    id: number,
    kind: SubAccountRankOperationKind,
    token: string,
    leaseSeconds = 300,
  ): boolean {
    const run = this.db.transaction(() => {
      const ts = now();
      this.db
        .prepare("DELETE FROM sub_account_rank_operations WHERE sub_account_id = ? AND expires_at <= ?")
        .run(id, ts);
      const active = this.db
        .prepare("SELECT 1 FROM sub_accounts WHERE id = ? AND status = 'active'")
        .get(id);
      if (!active) return false;
      return (
        this.db
          .prepare(
            `INSERT OR IGNORE INTO sub_account_rank_operations
               (sub_account_id, kind, token, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, kind, token, ts + leaseSeconds, ts).changes === 1
      );
    });
    return run.immediate();
  }

  /** 自分が持つleaseだけを解放する。他の処理のleaseは触らない。 */
  releaseRankOperation(id: number, token: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM sub_account_rank_operations WHERE sub_account_id = ? AND token = ?")
        .run(id, token).changes === 1
    );
  }

  /** Discord変更の直前に所有権を再確認し、実行中のleaseを延長する。 */
  renewRankOperation(id: number, token: string, leaseSeconds = 300): boolean {
    const ts = now();
    return (
      this.db
        .prepare(
          `UPDATE sub_account_rank_operations
              SET expires_at = ?
            WHERE sub_account_id = ? AND token = ?
              AND EXISTS (SELECT 1 FROM sub_accounts WHERE id = ? AND status = 'active')`,
        )
        .run(ts + leaseSeconds, id, token, id).changes === 1
    );
  }

  /** そのアカウントが誰かのサブ垢なら、その組み合わせ */
  findByAlt(altUserId: string): SubAccountRow | null {
    const marks = SUB_ACCOUNT_OPEN_STATUSES.map(() => "?").join(",");
    return (
      (this.db
        .prepare(`SELECT * FROM sub_accounts WHERE alt_user_id = ? AND status IN (${marks}) ORDER BY id LIMIT 1`)
        .get(altUserId, ...SUB_ACCOUNT_OPEN_STATUSES) as SubAccountRow) ?? null
    );
  }

  /**
   * 登録してよい組み合わせか。**申請でも引き継ぎでも同じ判定を通す。**
   *
   * ここを通さないと、1つのサブ垢が2人の本体にぶら下がったり、本体とサブ垢が
   * 循環したりする。階級の追従がどちらを見ればいいか決まらなくなる。
   */
  assertPairAllowed(mainUserId: string, altUserId: string): void {
    if (mainUserId === altUserId) throw new SubAccountError("ERR_SELF", { mainUserId });
    const marks = SUB_ACCOUNT_OPEN_STATUSES.map(() => "?").join(",");
    const openAlt = this.db
      .prepare(`SELECT * FROM sub_accounts WHERE alt_user_id = ? AND status IN (${marks})`)
      .all(altUserId, ...SUB_ACCOUNT_OPEN_STATUSES) as SubAccountRow[];
    if (openAlt.length > 0) {
      throw new SubAccountError("ERR_ALT_TAKEN", { altUserId, mainUserId: openAlt[0]!.main_user_id });
    }
    const altIsMain = this.db
      .prepare(`SELECT id FROM sub_accounts WHERE main_user_id = ? AND status IN (${marks}) LIMIT 1`)
      .get(altUserId, ...SUB_ACCOUNT_OPEN_STATUSES);
    if (altIsMain) throw new SubAccountError("ERR_ALT_IS_MAIN", { altUserId });
    const mainIsAlt = this.db
      .prepare(`SELECT id FROM sub_accounts WHERE alt_user_id = ? AND status IN (${marks}) LIMIT 1`)
      .get(mainUserId, ...SUB_ACCOUNT_OPEN_STATUSES);
    if (mainIsAlt) throw new SubAccountError("ERR_MAIN_IS_ALT", { mainUserId });
  }

  // ---- 申請と審査 ----

  /**
   * 本体が今もサブ垢を持てる階級か。**申請・承認・支払い直前のすべてで通す。**
   *
   * 承認のあとに降格していることがある。押せるボタンが出ているかではなく、
   * その時点の階級を毎回見る。
   */
  assertEligibleRank(mainStatus: SoulStatus | null | undefined, mainUserId: string): void {
    if (!isEligibleMainRank(mainStatus)) {
      throw new SubAccountError("ERR_RANK_TOO_LOW", { mainUserId, status: mainStatus ?? null });
    }
  }

  /** 申請する。**Land は動かさない。** */
  apply(input: { mainUserId: string; altUserId: string; mainStatus: SoulStatus | null; actor: string }): SubAccountRow {
    const run = this.db.transaction(() => {
      this.assertEligibleRank(input.mainStatus, input.mainUserId);
      this.assertPairAllowed(input.mainUserId, input.altUserId);
      const ts = now();
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO sub_accounts (main_user_id, alt_user_id, status, created_at, updated_at)
             VALUES (?,?, 'pending', ?, ?)`,
          )
          .run(input.mainUserId, input.altUserId, ts, ts).lastInsertRowid,
      );
      this.events.log("sub_account_applied", {
        actor: input.actor,
        target: input.mainUserId,
        payload: { id, altUserId: input.altUserId },
      });
      return this.get(id)!;
    });
    return run.immediate();
  }

  /** 承認する。ここでもまだ課金しない（支払いは本人の操作） */
  approve(id: number, actor: string, mainStatus: SoulStatus | null): SubAccountRow {
    const row = this.get(id);
    if (!row) throw new SubAccountError("ERR_NOT_FOUND", { id });
    this.assertEligibleRank(mainStatus, row.main_user_id);
    const ts = now();
    const changed = this.db
      .prepare(
        "UPDATE sub_accounts SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(actor, ts, ts, id).changes;
    if (changed !== 1) throw new SubAccountError("ERR_BAD_STATUS", { id, expected: "pending" });
    this.events.log("sub_account_approved", { actor, target: this.get(id)!.main_user_id, payload: { id } });
    return this.get(id)!;
  }

  /** 差し戻す（直して出し直してもらう）／却下する。どちらも**理由を必ず残す** */
  decide(id: number, decision: "returned" | "rejected", reason: string, actor: string): SubAccountRow {
    const ts = now();
    const changed = this.db
      .prepare(
        `UPDATE sub_accounts SET status = ?, decided_by = ?, decided_at = ?, decide_reason = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending','approved')`,
      )
      .run(decision, actor, ts, reason.slice(0, 500), ts, id).changes;
    if (changed !== 1) throw new SubAccountError("ERR_BAD_STATUS", { id });
    this.events.log(decision === "returned" ? "sub_account_returned" : "sub_account_rejected", {
      actor,
      target: this.get(id)!.main_user_id,
      payload: { id, reason },
    });
    return this.get(id)!;
  }

  /**
   * 支払い前の確認。承認済みで、本人のもので、**今も魔人以上か**。
   * ここが最後の関門なので、承認後に降格していれば 1 Ld も引かずに止める。
   */
  assertPayable(id: number, mainUserId: string, mainStatus: SoulStatus | null): SubAccountRow {
    const row = this.get(id);
    if (!row) throw new SubAccountError("ERR_NOT_FOUND", { id });
    if (row.main_user_id !== mainUserId) throw new SubAccountError("ERR_NOT_OWNER", { id });
    if (row.status !== "approved") throw new SubAccountError("ERR_BAD_STATUS", { id, status: row.status });
    this.assertEligibleRank(mainStatus, row.main_user_id);
    return row;
  }

  // ---- 有効化の巻き戻し基準 ----

  /**
   * 有効化を始める前の階級ロール集合を残す。**Discord を変更する前に呼ぶ。**
   *
   * ここに残さないと、剥がした直後に落ちたときに「元は何を持っていたか」が
   * プロセスと一緒に消える。再起動後の再試行が新しく取り直すと、剥がしたあとの
   * 状態を「開始前」と誤認し、返金したうえで元の階級を消したままにしてしまう。
   *
   * **一度書いたら上書きしない。** 再試行は最初の基準を使い続ける。
   *
   * @returns 実際に使う基準（既に保存済みならそちら）
   */
  saveActivationBaseline(id: number, roles: readonly string[]): string[] {
    this.db
      .prepare(
        "UPDATE sub_accounts SET activation_rank_baseline = ?, updated_at = ? WHERE id = ? AND activation_rank_baseline IS NULL",
      )
      .run(JSON.stringify([...roles]), now(), id);
    return this.activationBaseline(id) ?? [...roles];
  }

  /** 保存済みの巻き戻し基準（無ければ null）。**推測で生やさない** */
  activationBaseline(id: number): string[] | null {
    const row = this.get(id);
    if (!row?.activation_rank_baseline) return null;
    try {
      const parsed = JSON.parse(row.activation_rank_baseline) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
    } catch {
      return null;
    }
  }

  /**
   * 有効化する。**Discord 側のロール付与が済んでから呼ぶ。**
   * `approved` からの条件付き更新なので、同じ承認から2回有効化されない。
   */
  activate(input: { id: number; purchaseId: number; actor: string }): boolean {
    const ts = now();
    const changed = this.db
      .prepare(
        `UPDATE sub_accounts
            SET status = 'active', purchase_id = ?, activated_at = ?, updated_at = ?,
                activation_rank_settled_at = ?
          WHERE id = ? AND status = 'approved'`,
      )
      .run(input.purchaseId, ts, ts, ts, input.id).changes;
    if (changed !== 1) return false;
    const row = this.get(input.id)!;
    this.events.log("sub_account_activated", {
      actor: input.actor,
      target: row.main_user_id,
      payload: { id: row.id, altUserId: row.alt_user_id, purchaseId: input.purchaseId },
    });
    return true;
  }

  // ---- 支払われないまま残った承認 ----

  listUnpaidApprovals(limit = 50): SubAccountRow[] {
    return this.db
      .prepare(
        "SELECT * FROM sub_accounts WHERE status = 'approved' AND approved_at IS NOT NULL AND approved_at <= ? ORDER BY approved_at LIMIT ?",
      )
      .all(now() - SUB_ACCOUNT_PAYMENT_GRACE_DAYS * DAY, limit) as SubAccountRow[];
  }

  cancelUnpaid(id: number, actor: string): boolean {
    const changed = this.db
      .prepare("UPDATE sub_accounts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'approved'")
      .run(now(), id).changes;
    if (changed !== 1) return false;
    this.events.log("sub_account_cancelled_unpaid", { actor, target: this.get(id)!.main_user_id, payload: { id } });
    return true;
  }

  // ---- 旧契約の引き継ぎ ----

  /**
   * 旧商品で処理済みの組み合わせを、人が明示的に登録する。
   * **購入履歴から main ↔ alt は引けない**（記録が無い）ので、必ず人が突き合わせる。
   */
  importExisting(input: { mainUserId: string; altUserId: string; actor: string }): SubAccountRow {
    const run = this.db.transaction(() => {
      this.assertPairAllowed(input.mainUserId, input.altUserId);
      const ts = now();
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO sub_accounts
               (main_user_id, alt_user_id, status, approved_by, approved_at, activated_at,
                legacy_imported_at, created_at, updated_at)
             VALUES (?,?, 'active', ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.mainUserId, input.altUserId, input.actor, ts, ts, ts, ts, ts).lastInsertRowid,
      );
      this.events.log("sub_account_imported", {
        actor: input.actor,
        target: input.mainUserId,
        payload: { id, altUserId: input.altUserId },
      });
      return this.get(id)!;
    });
    return run.immediate();
  }

  /**
   * 解除を確定する。Discord階級ロール0件の確認を終えたdeactivate lease所有者だけが呼べる。
   * status更新とlease解放・eventを同じtransactionに入れ、DBだけ先に解除しない。
   */
  deactivate(id: number, actor: string, reason: string, operationToken: string): boolean {
    const run = this.db.transaction(() => {
      const owned = this.db
        .prepare(
          `SELECT 1 FROM sub_account_rank_operations
            WHERE sub_account_id = ? AND kind = 'deactivate' AND token = ?`,
        )
        .get(id, operationToken);
      if (!owned) return false;
      const changed = this.db
        .prepare("UPDATE sub_accounts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'")
        .run(now(), id).changes;
      if (changed !== 1) return false;
      const row = this.get(id)!;
      this.db
        .prepare("DELETE FROM sub_account_rank_operations WHERE sub_account_id = ? AND token = ?")
        .run(id, operationToken);
      this.events.log("sub_account_deactivated", {
        actor,
        target: row.main_user_id,
        payload: { id, altUserId: row.alt_user_id, purchaseId: row.purchase_id, reason },
      });
      return true;
    });
    return run.immediate();
  }
}
