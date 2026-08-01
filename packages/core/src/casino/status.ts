import type Database from "better-sqlite3";

/**
 * 賭場の稼働状態（大型UPD PR2）。
 *
 * 「止まっている」を1つの真偽値で持つと、**なぜ止まったか**と**誰が開けてよいか**が消える。
 * 検算が落ちて自動で止まったのか、支配人が意図して閉めたのか、開業初期化の最中なのかで、
 * 再起動したときの正しい振る舞いが違う。そこで状態は理由・実行者・時刻とセットでしか作れず、
 * **自動で解除されるのは `startup_check` だけ**にしてある。
 */

export const CASINO_STATUSES = [
  /** 通常営業 */
  "open",
  /** 起動時の点検中。点検が通れば自動で open へ戻る（唯一の自動解除） */
  "startup_check",
  /** 検算NGによる自動停止。解除は支配人の明示操作のみ */
  "integrity_halt",
  /** 支配人が手で止めた */
  "manual_halt",
  /** 改修・メンテナンス */
  "maintenance",
  /** 正式開業初期化の最中（実装計画 R0〜R11） */
  "opening_reset",
] as const;
export type CasinoStatusValue = (typeof CASINO_STATUSES)[number];

/** 再起動で自動解除してよい状態（点検中だけ） */
const AUTO_CLEARABLE: ReadonlySet<CasinoStatusValue> = new Set<CasinoStatusValue>(["startup_check"]);

export interface CasinoStatusRow {
  status: CasinoStatusValue;
  reason: string;
  changedBy: string;
  changedAt: number;
}

/** 遊べない状態のときに利用者へ出す文面 */
const DENY_MESSAGE: Record<Exclude<CasinoStatusValue, "open">, string> = {
  startup_check: "賭場は帳簿を点検中だ。少し待て。",
  integrity_halt: "賭場は帳簿の食い違いで閉めている。マモンが数え直すまで待て。",
  manual_halt: "賭場は今日は閉めている。",
  maintenance: "賭場は改装中だ。",
  opening_reset: "賭場は開業準備中だ。",
};

const now = () => Math.floor(Date.now() / 1000);

export class CasinoStatus {
  constructor(private readonly db: Database.Database) {
    // 初期値は open。行が無い＝まだ一度も止めていない
    this.db
      .prepare(
        `INSERT INTO casino_status (id, status, reason, changed_by, changed_at) VALUES (1, 'open', '初期状態', 'system', ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(now());
  }

  current(): CasinoStatusRow {
    const row = this.db.prepare("SELECT * FROM casino_status WHERE id = 1").get() as
      | { status: string; reason: string; changed_by: string; changed_at: number }
      | undefined;
    if (!row) return { status: "open", reason: "初期状態", changedBy: "system", changedAt: 0 };
    return {
      status: (CASINO_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as CasinoStatusValue)
        : // 未知の値は fail-closed（開いていると誤認して資金を動かさない）
          "manual_halt",
      reason: row.reason,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
    };
  }

  /** 遊べるか（＝チップを動かす操作を受け付けてよいか） */
  isOpen(): boolean {
    return this.current().status === "open";
  }

  /** 遊べないときの理由文。開いているなら null */
  denyMessage(): string | null {
    const cur = this.current();
    if (cur.status === "open") return null;
    const base = DENY_MESSAGE[cur.status];
    return cur.reason ? `${base}\n（理由: ${cur.reason}）` : base;
  }

  /**
   * 状態を変える。履歴と監査ログを必ず伴う（理由・実行者の無い変更は作れない）。
   * @returns 実際に変わったか（同じ状態への再設定は履歴を増やさない）
   */
  set(status: CasinoStatusValue, reason: string, changedBy: string): boolean {
    if (!reason.trim()) throw new Error("CasinoStatus.set: reason は必須");
    if (!changedBy.trim()) throw new Error("CasinoStatus.set: changedBy は必須");
    const before = this.current();
    if (before.status === status && before.reason === reason) return false;
    const ts = now();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE casino_status SET status = ?, reason = ?, changed_by = ?, changed_at = ? WHERE id = 1")
        .run(status, reason.trim(), changedBy, ts);
      this.db
        .prepare(
          "INSERT INTO casino_status_history (status, reason, changed_by, changed_at) VALUES (?, ?, ?, ?)",
        )
        .run(status, reason.trim(), changedBy, ts);
      // 監査チャンネルへの個別通知（仕様書8.3「賭場の自動停止・再開」）
      this.db
        .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('audit_log', ?, ?)")
        .run(
          JSON.stringify({
            event: "casino_status_changed",
            from: before.status,
            to: status,
            reason: reason.trim(),
            actor: changedBy,
          }),
          ts,
        );
    })();
    return true;
  }

  /**
   * 起動時の点検を始める。すでに人が止めている状態（manual_halt / maintenance /
   * integrity_halt / opening_reset）は**上書きしない**（再起動で勝手に開かないため）。
   * @returns 点検状態に入ったか
   */
  beginStartupCheck(changedBy = "system:startup"): boolean {
    const cur = this.current();
    if (cur.status !== "open" && cur.status !== "startup_check") return false;
    this.set("startup_check", "起動時の点検", changedBy);
    return true;
  }

  /**
   * 起動時の点検を終える。**点検中のときだけ** open へ戻す。
   * 人が止めた状態は触らない（自動解除されるのは startup_check だけ）。
   */
  finishStartupCheck(changedBy = "system:startup"): boolean {
    if (this.current().status !== "startup_check") return false;
    this.set("open", "起動時の点検を通過", changedBy);
    return true;
  }

  /** 検算NGによる自動停止 */
  haltForIntegrity(reason: string, changedBy = "system:integrity"): void {
    this.set("integrity_halt", reason, changedBy);
  }

  /** 直近の状態変更（新しい順） */
  history(limit = 20): CasinoStatusRow[] {
    const rows = this.db
      .prepare("SELECT status, reason, changed_by, changed_at FROM casino_status_history ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{ status: string; reason: string; changed_by: string; changed_at: number }>;
    return rows.map((r) => ({
      status: r.status as CasinoStatusValue,
      reason: r.reason,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }));
  }
}
