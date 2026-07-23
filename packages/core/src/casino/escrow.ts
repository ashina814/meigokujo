import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherError, EtherExchange } from "./exchange.js";

/**
 * 賭場のエスクロー台帳。
 * 「賭け金を先取りして預り所に一時保管する」ゲーム（対人・競馬・丁半・PvPポーカー等）で、
 * 誰からいくら預かっているかを DB に記録する。
 *
 * ## 資金分離（重要）
 * 旧実装は預り金を `HOUSE_HOLDER` に置いていたため、ソロゲームの配当余力（テーブルリミット）を
 * 計算する `Casino.canAccept()` から見て「対人戦の預り金まで含めた house 残高」で受注してしまい、
 * 対人戦の預り金でソロ配当を払える構造になっていた。
 *
 * 現在は「セッションごとの専用保有者(escrow:session:<sid>)」に預ける。
 * - 胴元(house)の配当余力は house 残高だけを見る → 預り金は含めない
 * - 精算は必ずセッション保有者から動かす（マーケットも同様に session を切って使うこと）
 *
 * ## 起動時掃除
 * `sweepAll()` は次の3系統を返金対象にする:
 * 1. `casino_escrow` 台帳に残っている行 → 記録の source から返金
 * 2. 新方式の `escrow:session:*` 保有者に残っているエテル残高（台帳と乖離した孤児）
 * 3. 旧方式で house に混ざったまま台帳だけ残っている行（互換：source='house' の行）
 * これで「Bot再起動時も全額返金可能」を保証する。
 */

export interface EscrowRow {
  session_id: string;
  user_id: string;
  amount: number;
  game: string;
  /** 資金の実際の置き場（保有者ID）。新方式は "escrow:session:<sid>"、旧行は "house" */
  source: string;
  created_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** セッションIDから専用保有者のIDを作る。他モジュールも同じ命名規則で作ること */
export const escrowHolderFor = (sessionId: string): string => `escrow:session:${sessionId}`;

/**
 * 孤児エスクローの隔離用保有者ID。
 * 台帳（casino_escrow）に対応記録がない預り所残高は、ここに移して人手確認を待つ。
 * house とは別で、`Casino.houseBalance()` にも `canAccept()` にも含まれない。
 * 運営が原因調査後に手動で返金 or 帳消しできる（返金先が判明したら `ether.transfer` で個別対応）。
 */
export const ESCROW_QUARANTINE = "sys:escrow:quarantine";

/** 保有者IDがエスクロー保有者かの判定（Ledger 側の除外にも使える） */
export const isEscrowHolder = (holderId: string): boolean =>
  holderId.startsWith("escrow:") || holderId === ESCROW_QUARANTINE || holderId === "house_escrow_legacy";

export class Escrow {
  constructor(
    private readonly db: Database.Database,
    private readonly ether: EtherExchange,
    private readonly events: EventLog,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_escrow (
        session_id TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        amount     INTEGER NOT NULL CHECK(amount > 0),
        game       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      );
    `);
    // 既存DBに source 列が無ければ足す。旧行は "house" 扱い（sweepAll で house から返金）。
    this.addColumnIfMissing("casino_escrow", "source", "TEXT NOT NULL DEFAULT 'house'");
  }

  private addColumnIfMissing(table: string, column: string, spec: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  }

  /**
   * user から amount を徴収してセッション専用保有者に預け、台帳に記録する。
   * 同一セッション・同一ユーザーの2回目以降は加算（丁半の増額など）。
   * 残高不足なら false（何も動かさない）。
   */
  hold(sessionId: string, userId: string, amount: number, game: string): boolean {
    if (!Number.isInteger(amount) || amount <= 0) return false;
    if (this.ether.balanceOf(userId) < amount) return false;
    const holder = escrowHolderFor(sessionId);
    try {
      this.db.transaction(() => {
        this.ether.transfer(userId, holder, amount);
        this.db
          .prepare(
            `INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, user_id) DO UPDATE SET amount = amount + excluded.amount, source = excluded.source`,
          )
          .run(sessionId, userId, amount, game, holder, now());
      })();
      return true;
    } catch (e) {
      if (e instanceof EtherError) return false;
      throw e;
    }
  }

  /** セッションの預かり記録（返金額の確認用） */
  list(sessionId: string): EscrowRow[] {
    return this.db.prepare("SELECT * FROM casino_escrow WHERE session_id = ?").all(sessionId) as EscrowRow[];
  }

  /**
   * セッションの預り総額（＝現在の保有者残高になっているはず）。
   * 精算コードで「勝者/胴元/JPへ幾ら配るか」を計算する材料に使う。
   */
  poolOf(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_escrow WHERE session_id = ?")
      .get(sessionId) as { s: number };
    return row.s;
  }

  /** セッション専用保有者のID（呼び出し側が精算時に使う）。命名を1箇所に閉じ込めるため */
  holderId(sessionId: string): string {
    return escrowHolderFor(sessionId);
  }

  /**
   * 精算配分: 保有者から任意の宛先に額を移す（呼び出し側は帳簿上の精算計算に責任を持つ）。
   * 残高不足なら例外。呼び出し側で poolOf() を守れば起きない。
   */
  payout(sessionId: string, toHolderId: string, amount: number): void {
    if (amount <= 0) return;
    this.ether.transfer(this.holderId(sessionId), toHolderId, amount);
  }

  /**
   * 正常精算した: 記録だけ消す（金は payout / 呼び出し側が動かした後）。
   * 呼び出し前に保有者残高が 0 になっていること（精算不完全の検出は verify() 側で）。
   */
  clear(sessionId: string): void {
    this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sessionId);
  }

  /** セッションの全員に預かり額を返金して記録を消す。返金した人数を返す */
  refund(sessionId: string): number {
    return this.db.transaction((): number => {
      const rows = this.list(sessionId);
      for (const r of rows) {
        // 保有者から返す（旧行は source='house' → house から返金 = 旧挙動互換）
        this.ether.transfer(r.source, r.user_id, r.amount);
      }
      this.clear(sessionId);
      return rows.length;
    })();
  }

  /** 1人だけ返金して記録を消す（ロビー離脱）。記録が無ければ false */
  refundOne(sessionId: string, userId: string): boolean {
    return this.db.transaction((): boolean => {
      const row = this.db
        .prepare("SELECT * FROM casino_escrow WHERE session_id = ? AND user_id = ?")
        .get(sessionId, userId) as EscrowRow | undefined;
      if (!row) return false;
      this.ether.transfer(row.source, userId, row.amount);
      this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ? AND user_id = ?").run(sessionId, userId);
      return true;
    })();
  }

  /**
   * 起動時掃除:
   * 1. 台帳(casino_escrow) に記録がある行 → 記録された `source` から本人に返金
   * 2. 台帳に記録がないのに session 保有者に残っているエテル(孤児残高)
   *    → 隔離口座 `sys:escrow:quarantine` に移す（house には送らない）
   *
   * 孤児残高は「誰の預り金か特定できない」状態。原因は Bot が精算途中で死んだ・帳簿と保有者が
   * 分離運用された・手動介入で片方だけ動いた、など。自動で house 売上化すると
   * 「バグで消えた預り金が売上に化ける」ので、必ず人手確認を通す。
   *
   * 各孤児は event log `casino_escrow_orphan` に holder / amount / 時刻を記録するので、
   * 運営はイベントログを見て個別に返金指示または帳消しを判断できる。
   */
  sweepAll(actor: string): {
    sessions: number;
    users: number;
    total: number;
    orphans: number;
    orphanTotal: number;
  } {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM casino_escrow").all() as EscrowRow[];
      const sessions = new Set(rows.map((r) => r.session_id)).size;
      let total = 0;
      for (const r of rows) {
        this.ether.transfer(r.source, r.user_id, r.amount);
        total += r.amount;
      }
      this.db.prepare("DELETE FROM casino_escrow").run();

      // 孤児残高（記録が無いのに session 保有者に残っているエテル）→ 隔離口座に集約
      this.ether.ensureHolder(ESCROW_QUARANTINE);
      const orphanHolders = this.db
        .prepare(
          "SELECT user_id, amount FROM ether_balances WHERE user_id LIKE 'escrow:session:%' AND amount > 0",
        )
        .all() as Array<{ user_id: string; amount: number }>;
      let orphanTotal = 0;
      const detectedAt = Math.floor(Date.now() / 1000);
      for (const h of orphanHolders) {
        const bal = this.ether.balanceOf(h.user_id);
        if (bal > 0) {
          this.ether.transfer(h.user_id, ESCROW_QUARANTINE, bal);
          orphanTotal += bal;
          // 個別のイベントログ（監査用）: holder ID / 金額 / 検出時刻
          this.events.log("casino_escrow_orphan", {
            actor,
            payload: {
              holder: h.user_id,
              amount: bal,
              detectedAt,
              quarantinedTo: ESCROW_QUARANTINE,
            },
          });
          // 運営ログにも警告（stdout に流し、収集基盤で拾えるように）
          // eslint-disable-next-line no-console
          console.warn(
            `[escrow] 孤児残高を隔離: holder=${h.user_id} amount=${bal} → ${ESCROW_QUARANTINE}（要調査）`,
          );
        }
      }

      if (rows.length > 0 || orphanHolders.length > 0) {
        this.events.log("casino_escrow_sweep", {
          actor,
          payload: {
            sessions,
            users: rows.length,
            total,
            orphans: orphanHolders.length,
            orphanTotal,
          },
        });
      }
      return {
        sessions,
        users: rows.length,
        total,
        orphans: orphanHolders.length,
        orphanTotal,
      };
    })();
  }

  /** 隔離口座の現在残高（運営 UI・監査用） */
  quarantineBalance(): number {
    return this.ether.balanceOf(ESCROW_QUARANTINE);
  }

  /**
   * 隔離口座から個別返金 or 帳消しをする（運営操作専用）。
   * 「原因調査で預入者が判明した」ときはユーザーへ、「原因不明で売上計上する」ときは house へ。
   */
  releaseFromQuarantine(destHolderId: string, amount: number, actor: string, reason: string): void {
    if (amount <= 0) return;
    this.ether.transfer(ESCROW_QUARANTINE, destHolderId, amount);
    this.events.log("casino_escrow_quarantine_release", {
      actor,
      payload: { dest: destHolderId, amount, reason },
    });
  }

  /**
   * 「保有者残高 == 帳簿の預り総額」を検証。テスト・監査で使う。
   * 差分があれば mismatches に列挙する。
   */
  verify(): { ok: boolean; mismatches: Array<{ sessionId: string; expected: number; actual: number }> } {
    const rows = this.db
      .prepare("SELECT session_id, SUM(amount) AS s FROM casino_escrow GROUP BY session_id")
      .all() as Array<{ session_id: string; s: number }>;
    const mismatches: Array<{ sessionId: string; expected: number; actual: number }> = [];
    for (const r of rows) {
      const holder = escrowHolderFor(r.session_id);
      const actual = this.ether.balanceOf(holder);
      if (actual !== r.s) mismatches.push({ sessionId: r.session_id, expected: r.s, actual });
    }
    return { ok: mismatches.length === 0, mismatches };
  }
}
