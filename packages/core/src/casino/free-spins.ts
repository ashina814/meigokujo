import type Database from "better-sqlite3";

/**
 * 獲得済みフリースピンの永続化（大型UPD PR3・レビュー指摘）。
 *
 * ## なぜ要るか
 *
 * スロットのフリースピンは「有料スピンの結果」で獲得し、演出を挟んでから回す。
 * 有料スピンと無料スピンは**別の資金グループ**なので、
 *
 * ```text
 * 1. 有料スピンがフリースピンを獲得
 * 2. 有料スピンの group が settled
 * 3. Bot 停止 / 再起動 / 例外 / 賭場停止
 * 4. 無料スピンを開始できない
 * ```
 *
 * となると、利用者の無料スピン権がプロセスの都合で消える。
 * 「無料スピンは無効・有料スピンぶんは有効」で終わらせるのは取りこぼしの解消ではない。
 *
 * そこで**有料スピンの確定と同じトランザクションの中で**、獲得した無料スピンを
 * 保留（pending）として DB に残す。以後この権利はプロセスの寿命と無関係になる。
 *
 * ## 結果は獲得時に確定させる
 *
 * リールは**獲得した時点で振って保存する**。再開時に振り直すと、
 * 「再起動したら出目が変わった」という説明のつかない挙動になる。
 * 保存済みのリールから評価するので、何度再開しても表示も配当も同じになる。
 *
 * ## 消えない条件
 *
 * - Bot 再起動後も pending のまま残り、起動時に再開できる
 * - 同じ無料スピンを何度処理しても払い出しは一度だけ（`runGroup` + status 遷移）
 * - 賭場停止中は資金グループが作れないので**権利を消さずに残る**
 * - 技術例外はトランザクションごと巻き戻るので pending に戻る
 */

export type FreeSpinStatus = "pending" | "processing" | "settled";

/**
 * 確定済みフリースピンJP請求の専用保有者。
 *
 * 卓の預託（`escrow:*`）ではなく、既に確定したシステム債務の引当金である。
 * 起動時の孤児掃除・隔離対象にせず、検算Cで pending 行の合計と照合する。
 */
export const FREE_SPIN_JACKPOT_CLAIMS_HOLDER = "sys:casino:free-spin-jp-claims";

export interface PendingFreeSpinAmuletEffect {
  kind: "none" | "win_bonus" | "loss_protection";
  amount: number;
}

export interface PendingFreeSpinRow {
  id: number;
  userId: string;
  /** 元の操作ID（Discord の interaction ID）。有料スピンと同じ値 */
  operationId: string;
  /** その操作の中で何回目の無料スピンか（現状は常に 1） */
  spinNo: number;
  bet: number;
  /** 獲得元の有料スピンの業務グループ鍵 */
  sourceGroup: string;
  status: FreeSpinStatus;
  /** 獲得時に確定させたリール（絵柄名）。再開しても出目が変わらない */
  reels: [string, string, string];
  rawPayout: number;
  amuletEffect: PendingFreeSpinAmuletEffect;
  amuletNote: string | null;
  payout: number;
  jackpotWon: boolean;
  jackpotClaim: number;
  totalClaim: number;
  createdAt: number;
  settledAt: number | null;
}

interface RawRow {
  id: number;
  user_id: string;
  operation_id: string;
  spin_no: number;
  bet: number;
  source_group: string;
  status: string;
  reels_json: string;
  raw_payout: number;
  amulet_effect_json: string;
  amulet_note: string | null;
  payout: number;
  jackpot_won: number;
  jackpot_claim: number;
  total_claim: number;
  created_at: number;
  settled_at: number | null;
}

const now = () => Math.floor(Date.now() / 1000);

function toRow(r: RawRow): PendingFreeSpinRow {
  const reels = JSON.parse(r.reels_json) as [string, string, string];
  return {
    id: r.id,
    userId: r.user_id,
    operationId: r.operation_id,
    spinNo: r.spin_no,
    bet: r.bet,
    sourceGroup: r.source_group,
    status: r.status as FreeSpinStatus,
    reels,
    rawPayout: r.raw_payout,
    amuletEffect: JSON.parse(r.amulet_effect_json) as PendingFreeSpinAmuletEffect,
    amuletNote: r.amulet_note,
    payout: r.payout,
    jackpotWon: r.jackpot_won === 1,
    jackpotClaim: r.jackpot_claim,
    totalClaim: r.total_claim,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}

export class FreeSpins {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_pending_free_spins (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      TEXT    NOT NULL,
        operation_id TEXT    NOT NULL,
        spin_no      INTEGER NOT NULL CHECK(spin_no > 0),
        bet          INTEGER NOT NULL CHECK(bet > 0),
        source_group TEXT    NOT NULL,
        status       TEXT    NOT NULL CHECK(status IN ('pending','processing','settled')),
        reels_json   TEXT    NOT NULL,
        raw_payout   INTEGER NOT NULL DEFAULT 0,
        amulet_effect_json TEXT NOT NULL DEFAULT '{"kind":"none","amount":0}',
        amulet_note  TEXT,
        payout       INTEGER NOT NULL DEFAULT 0,
        jackpot_won  INTEGER NOT NULL DEFAULT 0 CHECK(jackpot_won IN (0,1)),
        jackpot_claim INTEGER NOT NULL DEFAULT 0,
        total_claim  INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        settled_at   INTEGER,
        UNIQUE (user_id, operation_id, spin_no)
      );
      CREATE INDEX IF NOT EXISTS idx_casino_free_spins_pending
        ON casino_pending_free_spins(status, created_at);
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(casino_pending_free_spins)").all() as Array<{ name: string }>).map((r) => r.name));
    const add = (name: string, ddl: string) => {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE casino_pending_free_spins ADD COLUMN ${ddl}`);
    };
    add("raw_payout", "raw_payout INTEGER NOT NULL DEFAULT 0");
    add("amulet_effect_json", "amulet_effect_json TEXT NOT NULL DEFAULT '{\"kind\":\"none\",\"amount\":0}'");
    add("amulet_note", "amulet_note TEXT");
    add("payout", "payout INTEGER NOT NULL DEFAULT 0");
    add("jackpot_won", "jackpot_won INTEGER NOT NULL DEFAULT 0");
    add("jackpot_claim", "jackpot_claim INTEGER NOT NULL DEFAULT 0");
    add("total_claim", "total_claim INTEGER NOT NULL DEFAULT 0");
  }

  /**
   * 無料スピン権を保留として記録する。
   *
   * **必ず有料スピンの資金グループの中から呼ぶ。** 外で呼ぶと
   * 「有料スピンは巻き戻ったのに権利だけ残る」「権利だけ落ちる」が起きる。
   * 同じ (user, operation, spinNo) が既にあれば、その行をそのまま返す（冪等）。
   */
  grant(input: {
    userId: string;
    operationId: string;
    spinNo: number;
    bet: number;
    sourceGroup: string;
    reels: readonly [string, string, string];
    rawPayout: number;
    amuletEffect: PendingFreeSpinAmuletEffect;
    amuletNote?: string;
    payout: number;
    jackpotWon: boolean;
    jackpotClaim: number;
    totalClaim: number;
  }): PendingFreeSpinRow {
    const existing = this.find(input.userId, input.operationId, input.spinNo);
    if (existing) return existing;
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO casino_pending_free_spins
           (user_id, operation_id, spin_no, bet, source_group, status, reels_json,
            raw_payout, amulet_effect_json, amulet_note, payout, jackpot_won, jackpot_claim, total_claim, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.userId, input.operationId, input.spinNo, input.bet, input.sourceGroup, JSON.stringify(input.reels),
        input.rawPayout, JSON.stringify(input.amuletEffect), input.amuletNote ?? null, input.payout,
        input.jackpotWon ? 1 : 0, input.jackpotClaim, input.totalClaim, ts,
      );
    return this.find(input.userId, input.operationId, input.spinNo)!;
  }

  get(id: number): PendingFreeSpinRow | undefined {
    const r = this.db.prepare("SELECT * FROM casino_pending_free_spins WHERE id = ?").get(id) as RawRow | undefined;
    return r ? toRow(r) : undefined;
  }

  find(userId: string, operationId: string, spinNo: number): PendingFreeSpinRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM casino_pending_free_spins WHERE user_id = ? AND operation_id = ? AND spin_no = ?")
      .get(userId, operationId, spinNo) as RawRow | undefined;
    return r ? toRow(r) : undefined;
  }

  /** まだ払っていない無料スピン（古い順）。`userId` を渡すとその人だけ */
  listPending(userId?: string): PendingFreeSpinRow[] {
    const rows = (
      userId
        ? this.db
            .prepare(
              "SELECT * FROM casino_pending_free_spins WHERE status != 'settled' AND user_id = ? ORDER BY id ASC",
            )
            .all(userId)
        : this.db.prepare("SELECT * FROM casino_pending_free_spins WHERE status != 'settled' ORDER BY id ASC").all()
    ) as RawRow[];
    return rows.map(toRow);
  }

  /**
   * 払い出しに入る印。**払い出しと同じ資金グループの中から呼ぶ。**
   *
   * 例外やロールバックが起きればこの印も一緒に巻き戻るので、権利は pending に戻る。
   * 単一トランザクションで完結する現在の実装では見えない中間状態だが、
   * 「途中で落ちた行が settled のまま残らない」ことを状態として明示しておく。
   *
   * @returns 印を付けられたか（すでに settled なら false = 払ってはいけない）
   */
  beginProcessing(id: number): boolean {
    const info = this.db
      .prepare("UPDATE casino_pending_free_spins SET status = 'processing' WHERE id = ? AND status != 'settled'")
      .run(id);
    return info.changes > 0;
  }

  /**
   * 払い出し完了。**払い出しと同じ資金グループの中から呼ぶ**（払う前に settled にしない）。
   * @returns 実際に settled へ移したか（すでに settled なら false）
   */
  markSettled(id: number): boolean {
    const info = this.db
      .prepare("UPDATE casino_pending_free_spins SET status = 'settled', settled_at = ? WHERE id = ? AND status != 'settled'")
      .run(now(), id);
    return info.changes > 0;
  }

  /**
   * この無料スピンの払い出しの業務グループ鍵。
   *
   * 行の identity（利用者・操作ID・何回目か）だけで決まるので、
   * 再起動をまたいでも同じ鍵になる ＝ `runChipGroup` の冪等性がそのまま二重払い防止になる。
   */
  payoutGroupKey(row: PendingFreeSpinRow): string {
    return `slots:spin:${row.userId}:${row.operationId}:free:${row.spinNo}`;
  }

  jackpotClaimHolder(_row?: PendingFreeSpinRow): string {
    return FREE_SPIN_JACKPOT_CLAIMS_HOLDER;
  }

  /** 保留件数（運営ダッシュボード・起動ログ用） */
  pendingCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM casino_pending_free_spins WHERE status != 'settled'").get() as {
        n: number;
      }
    ).n;
  }
}
