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
  /**
   * **起動時の復旧が完了しなかった**ことによる自動停止（PR7・レビュー指摘）。
   *
   * `integrity_halt` と分けてあるのは、直し方が違うから。
   * 検算NGは「全点検が通れば開けてよい」が、復旧未完了は
   * 「所有元を確認していない・孤児掃除をしていない・予約解放をしていない」状態なので、
   * A〜D がたまたま通っても開けてはいけない。**復旧をやり直して S12 まで通す**しかない。
   */
  "recovery_halt",
  /** 支配人が手で止めた */
  "manual_halt",
  /** 改修・メンテナンス */
  "maintenance",
  /** 正式開業初期化の最中（実装計画 R0〜R11） */
  "opening_reset",
] as const;
export type CasinoStatusValue = (typeof CASINO_STATUSES)[number];

/**
 * 人が意図して止めている状態。起動時に資金を動かさず、検算NGでも上書きしない
 * （上書きすると「なぜ止まっているか」が検算の話にすり替わる）。
 */
const HUMAN_HELD: ReadonlySet<CasinoStatusValue> = new Set<CasinoStatusValue>([
  "manual_halt",
  "maintenance",
  "opening_reset",
]);

/** 人が止めている状態か（起動時に掃除してよいかの判定に使う） */
export function isHumanHeld(status: CasinoStatusValue): boolean {
  return HUMAN_HELD.has(status);
}

/** 状態遷移の結果。断られた理由をそのまま運営へ見せる */
export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

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
  recovery_halt: "賭場は開店前の点検が終わっていない。マモンが片付けるまで待て。",
  manual_halt: "賭場は今日は閉めている。",
  maintenance: "賭場は改装中だ。",
  opening_reset: "賭場は開業準備中だ。",
};

const now = () => Math.floor(Date.now() / 1000);

/**
 * 正式開業初期化（PR12）の完了処理だけが持つ印。
 *
 * `index.ts` から**再エクスポートしない**ことで、apps/bot 側（＝運営卓の通常の再開導線）からは
 * 手に入らないようにしてある。`opening_reset` を解ける経路を R0〜R14 の一続きの処理に限るための鍵。
 */
export const OPENING_RESET_SEAL: unique symbol = Symbol("casino.openingReset");
export type OpeningResetSeal = typeof OPENING_RESET_SEAL;

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
   *
   * **private にしてある**。`set("open")` を誰でも呼べると、検算NGで止めた賭場を
   * 「メンテ終了」の導線から開けてしまう。開ける経路は下の遷移メソッドに限定する。
   * @returns 実際に変わったか（同じ状態への再設定は履歴を増やさない）
   */
  private set(status: CasinoStatusValue, reason: string, changedBy: string): boolean {
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
    // `recovery_halt` からは入れる。**復旧のやり直しだけが唯一の出口**なので、
    // ここを塞ぐと二度と開けられなくなる（PR7）
    if (cur.status !== "open" && cur.status !== "startup_check" && cur.status !== "recovery_halt") return false;
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

  /** 検算NGによる自動停止。人が止めている状態は上書きしない（そちらの理由を消さない） */
  haltForIntegrity(reason: string, changedBy = "system:integrity"): boolean {
    const cur = this.current();
    if (HUMAN_HELD.has(cur.status)) return false;
    // `recovery_halt` は「S4〜S12 が未完了」という復旧義務そのものを表す。
    // 復旧をやり直したときの S2/S3 で検算NGを見つけても、通常の integrity_halt に
    // すり替えると、帳簿を直しただけで通常の再点検から開けられてしまう。
    // 停止理由へ検算結果を追記しつつ、復旧を S12 まで通す義務は保持する。
    if (cur.status === "recovery_halt") {
      this.set("recovery_halt", `${cur.reason}\n検算NG: ${reason}`, changedBy);
      return true;
    }
    this.set("integrity_halt", reason, changedBy);
    return true;
  }

  /**
   * **起動時の復旧が完了しなかった**ことによる自動停止（PR7・レビュー指摘）。
   *
   * `integrity_halt` と分けるのは、通常の「再点検して開ける」導線から開けさせないため。
   * 所有元を確認できていない状態では、A〜D がたまたま通っても
   * 「生存中の預託が分からない・孤児掃除も予約解放もしていない」ままなので開けてはいけない。
   * 出口は `recoverCasino()` をもう一度通して S12 まで到達することだけ。
   */
  haltForRecovery(reason: string, changedBy = "system:recovery"): boolean {
    const cur = this.current();
    if (HUMAN_HELD.has(cur.status)) return false;
    this.set("recovery_halt", reason, changedBy);
    return true;
  }

  // ── 停止の入口（どの状態からでも止められる） ──────────────

  /** 支配人が手で止める */
  haltManually(reason: string, changedBy: string): void {
    this.set("manual_halt", reason, changedBy);
  }

  /** 改装に入る */
  beginMaintenance(reason: string, changedBy: string): void {
    this.set("maintenance", reason, changedBy);
  }

  /** 正式開業初期化に入る（実装計画 R0） */
  beginOpeningReset(reason: string, changedBy: string): void {
    this.set("opening_reset", reason, changedBy);
  }

  // ── 開ける経路（状態ごとに1本ずつ） ─────────────────────

  /**
   * 手動停止からの通常再開。**手動停止のときだけ**通る。
   * 検算NGで止まっている賭場をここから開けることはできない。
   */
  reopenFromManualHalt(reason: string, changedBy: string): TransitionResult {
    return this.reopen("manual_halt", reason, changedBy);
  }

  /**
   * 検算停止からの再開。**全点検を通ったことを呼び出し側が保証する**
   * （`integrityOk=false` なら開けない）。
   */
  reopenAfterIntegrity(reason: string, changedBy: string, integrityOk: boolean): TransitionResult {
    if (!integrityOk) return { ok: false, reason: "検算が通っていないので開けられない" };
    // `recovery_halt` はここを通らない（`reopen` が from 不一致で断る）。
    // 復旧未完了は「A〜D が通ったから開けてよい」種類の停止ではないので、
    // 運営卓の「再点検」ではなく「復旧を再実行」から S4〜S12 をやり直す（PR7）
    return this.reopen("integrity_halt", reason, changedBy);
  }

  /** 改装の終了。**改装中のときだけ**通る */
  endMaintenance(reason: string, changedBy: string): TransitionResult {
    return this.reopen("maintenance", reason, changedBy);
  }

  /**
   * 正式開業初期化の完了（実装計画 R14）。**開業準備中のときだけ**通る。
   *
   * 正本では正式開業初期化は R0 停止 → R1〜R11 初期化 → R12 同一トランザクション内の検算 →
   * R13 成功時のみ COMMIT → R14 open、という**一続きの処理**である。全点検A〜Dが通っただけで
   * 運営卓の通常の再開導線から解除できてはいけないので、第3引数に
   * {@link OPENING_RESET_SEAL} を要求する。この印は core の内部（PR12 の正式開業初期化）だけが
   * 持ち、パッケージの公開エクスポート（index.ts）には出していない。
   * したがって apps/bot から通常の再開操作でこの経路を通ることはできない。
   */
  finishOpeningReset(reason: string, changedBy: string, seal: OpeningResetSeal): TransitionResult {
    if (seal !== OPENING_RESET_SEAL) {
      return { ok: false, reason: "開業準備中は、正式開業初期化の完了処理からしか開けられない" };
    }
    return this.reopen("opening_reset", reason, changedBy);
  }

  private reopen(from: CasinoStatusValue, reason: string, changedBy: string): TransitionResult {
    const cur = this.current();
    if (cur.status === "open") return { ok: true, reason: "すでに営業中" };
    if (cur.status !== from) {
      return { ok: false, reason: `いまは ${cur.status} なので、この経路（${from} からの再開）では開けられない` };
    }
    this.set("open", reason, changedBy);
    return { ok: true };
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
