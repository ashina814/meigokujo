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

  /**
   * 原子的精算（推奨エントリポイント）。
   *
   * 対象: PvP / 競馬 / その他 escrow.hold() で預けた資金の分配全般。
   * 動作: エスクロー残高 == 分配合計 を検証し、単一 SQLite トランザクション内で
   *   1) 全 distribution.to へ ether を送金
   *   2) casino_escrow の当該セッションを削除
   *   3) events に settle 記録を残す
   * 途中の任意の送金で例外が発生すれば全ロールバック（保有者残高・帳簿ともに元の状態に戻る）。
   *
   * オプション `_beforeStep` はテスト専用のフック: 各送金の直前に呼ばれ、例外を投げると
   * その送金は失敗し、トランザクション全体が巻き戻る。プロダクション呼び出しは省略する。
   */
  settle(
    sessionId: string,
    distributions: ReadonlyArray<{ to: string; amount: number; reason?: string }>,
    actor: string,
    reason: string,
    _beforeStep?: (index: number, dist: { to: string; amount: number }) => void,
  ): { paid: number; sessionId: string } {
    const holder = this.holderId(sessionId);

    // 検証は「正数フィルタの前」に全件を検査する。
    // 先に filter(d.amount > 0) してしまうと、負数・NaN・Infinity・小数・空宛先が
    // 黙って捨てられて素通りしてしまう（filter が false になり配列から消える）。
    for (const d of distributions) {
      if (
        !d.to ||
        typeof d.to !== "string" ||
        !Number.isFinite(d.amount) ||
        !Number.isInteger(d.amount) ||
        d.amount < 0
      ) {
        throw new Error(`Escrow.settle: bad distribution ${JSON.stringify(d)}`);
      }
    }

    const positive = distributions.filter((d) => d.amount > 0);
    const total = positive.reduce((s, d) => s + d.amount, 0);

    const pool = this.ether.balanceOf(holder);
    if (total !== pool) {
      throw new Error(
        `Escrow.settle: distribution total ${total} != escrow pool ${pool} for session ${sessionId}`,
      );
    }

    return this.db.transaction(() => {
      for (let i = 0; i < positive.length; i++) {
        const d = positive[i]!;
        _beforeStep?.(i, d);
        this.ether.transfer(holder, d.to, d.amount);
      }
      // 帳簿削除は最後（送金が全部通ってから）
      this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sessionId);
      this.events.log("casino_escrow_settle", {
        actor,
        payload: {
          sessionId,
          reason,
          total,
          distributions: positive.map((d) => ({ to: d.to, amount: d.amount, reason: d.reason })),
        },
      });
      return { paid: total, sessionId };
    })();
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
   * 起動時掃除（セッション単位で分離処理）。
   *
   * 1. 台帳(casino_escrow) をセッションごとに独立トランザクションで返金する。
   *    各セッションで「帳簿合計 == source 残高」を検証し、一致するものだけ返金する。
   *    不一致セッションは:
   *      - 帳簿を削除しない
   *      - 残高を勝手に house から補填しない
   *      - イベントログ / 運営ログに残す
   *      - 他の正常セッションの返金は続行する
   *    → 1セッションの破損で Bot 全体が起動不能にならない（market の refundAllPending と同思想）。
   *
   * 2. 台帳に記録がないのに escrow 保有者に残っているエテル(孤児残高)
   *    → 隔離口座 `sys:escrow:quarantine` に移す（house には送らない）。
   *    失敗セッションは帳簿が残るので孤児扱いされない（下の除外ロジック参照）。
   *
   * @returns 返金・孤児・失敗の内訳
   */
  sweepAll(actor: string): {
    totalSessions: number;
    refundedSessions: number;
    refundedUsers: number;
    refundedTotal: number;
    failed: Array<{ sessionId: string; expected: number; actual: number; error: string }>;
    orphans: number;
    orphanTotal: number;
  } {
    const allRows = this.db.prepare("SELECT * FROM casino_escrow").all() as EscrowRow[];
    const bySession = new Map<string, EscrowRow[]>();
    for (const r of allRows) {
      const arr = bySession.get(r.session_id) ?? [];
      arr.push(r);
      bySession.set(r.session_id, arr);
    }

    let refundedSessions = 0;
    let refundedUsers = 0;
    let refundedTotal = 0;
    const failed: Array<{ sessionId: string; expected: number; actual: number; error: string }> = [];

    for (const [sid, rows] of bySession) {
      const expected = rows.reduce((s, r) => s + r.amount, 0);
      const holder = escrowHolderFor(sid);
      try {
        this.db.transaction(() => {
          // 新方式（source が session 専用保有者）は「保有者残高 == 帳簿合計」を厳格検証。
          // legacy（source='house'）は house が混在勘定なので個別検証できず、そのまま house から返金。
          const sources = new Set(rows.map((r) => r.source));
          const isNewStyle = sources.size === 1 && [...sources][0] === holder;
          if (isNewStyle) {
            const actual = this.ether.balanceOf(holder);
            if (actual !== expected) {
              throw new Error(`escrow mismatch: ledger=${expected} holder=${actual}`);
            }
          }
          for (const r of rows) this.ether.transfer(r.source, r.user_id, r.amount);
          this.db.prepare("DELETE FROM casino_escrow WHERE session_id = ?").run(sid);
        })();
        refundedSessions++;
        refundedUsers += rows.length;
        refundedTotal += expected;
      } catch (e) {
        const actual = this.ether.balanceOf(holder);
        const error = (e as Error).message;
        failed.push({ sessionId: sid, expected, actual, error });
        this.events.log("casino_escrow_sweep_failed", {
          actor,
          payload: { sessionId: sid, expected, actual, error },
        });
        // eslint-disable-next-line no-console
        console.warn(
          `[escrow] セッション ${sid} の返金失敗（帳簿=${expected} 保有者=${actual}）: ${error}。帳簿は残し house 補填もしない。要調査`,
        );
      }
    }

    // ── 孤児残高（記録が無いのに escrow 保有者に残っているエテル）→ 隔離口座に集約 ──
    this.ether.ensureHolder(ESCROW_QUARANTINE);
    // 失敗セッションは帳簿が残っているので activeSessions に含まれ、孤児扱いされない
    const activeSessions = new Set(
      (this.db.prepare("SELECT DISTINCT session_id FROM casino_escrow").all() as Array<{ session_id: string }>).map(
        (r) => r.session_id,
      ),
    );
    let activeMarkets = new Set<string>();
    try {
      // frozen も「有効な帳簿がある」扱いにする（孤児として自動隔離せず、調査完了まで
      // 市場専用 holder にエスクローを保持する。所有者情報は casino_market_bets に残っている）。
      activeMarkets = new Set(
        (
          this.db
            .prepare("SELECT id FROM casino_markets WHERE status IN ('open','closed','reported','disputed','frozen')")
            .all() as Array<{ id: number }>
        ).map((r) => String(r.id)),
      );
    } catch {
      /* markets テーブル未作成の環境（テスト最小構成）は空扱い */
    }
    const allEscrowHolders = this.db
      .prepare(
        "SELECT user_id, amount FROM ether_balances WHERE user_id LIKE 'escrow:%' AND user_id != ? AND amount > 0",
      )
      .all(ESCROW_QUARANTINE) as Array<{ user_id: string; amount: number }>;
    const orphanHolders = allEscrowHolders.filter((h) => {
      if (h.user_id.startsWith("escrow:session:")) {
        const sid = h.user_id.slice("escrow:session:".length);
        return !activeSessions.has(sid); // 帳簿が消えている = 孤児（失敗セッションは残るので除外）
      }
      if (h.user_id.startsWith("escrow:market:")) {
        const mid = h.user_id.slice("escrow:market:".length);
        return !activeMarkets.has(mid); // 板が精算済み/void 済みなのに残高が残っている = 孤児
      }
      return true; // 未知の escrow:* も孤児として隔離
    });
    let orphanTotal = 0;
    const detectedAt = Math.floor(Date.now() / 1000);
    for (const h of orphanHolders) {
      const bal = this.ether.balanceOf(h.user_id);
      if (bal > 0) {
        // 孤児1件ずつ独立トランザクションで隔離（1件失敗が他を止めない）
        try {
          this.db.transaction(() => {
            this.ether.transfer(h.user_id, ESCROW_QUARANTINE, bal);
          })();
          orphanTotal += bal;
          this.events.log("casino_escrow_orphan", {
            actor,
            payload: { holder: h.user_id, amount: bal, detectedAt, quarantinedTo: ESCROW_QUARANTINE },
          });
          // eslint-disable-next-line no-console
          console.warn(
            `[escrow] 孤児残高を隔離: holder=${h.user_id} amount=${bal} → ${ESCROW_QUARANTINE}（要調査）`,
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[escrow] 孤児残高の隔離に失敗: holder=${h.user_id} ${(e as Error).message}`);
        }
      }
    }

    if (allRows.length > 0 || orphanHolders.length > 0 || failed.length > 0) {
      this.events.log("casino_escrow_sweep", {
        actor,
        payload: {
          totalSessions: bySession.size,
          refundedSessions,
          refundedUsers,
          refundedTotal,
          failed: failed.length,
          orphans: orphanHolders.length,
          orphanTotal,
        },
      });
    }
    return {
      totalSessions: bySession.size,
      refundedSessions,
      refundedUsers,
      refundedTotal,
      failed,
      orphans: orphanHolders.length,
      orphanTotal,
    };
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
