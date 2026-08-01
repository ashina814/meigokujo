import type Database from "better-sqlite3";

/**
 * 賭場チップの取引監査基盤（大型UPD PR1）。
 *
 * チップ残高（`ether_balances`）は現在値しか持たないため、いくら動いたのか・なぜ動いたのかを
 * 後から追えない。ここでは「業務操作の単位（group）」と「その中の1移動（tx）」を追記し、
 * **開始残高 + 全取引 = 現在残高** を再現できる状態にする。
 *
 * 二つの規律で守る:
 * - 金銭操作は必ず `runGroup()` の中で行う（グループの無いチップ移動は記録できない＝例外）
 * - チップ移動には必ず理由を付ける（理由の無い取引を作らない）
 */

export const CHIP_OPENING_VERSION_KEY = "casino:opening_version";
/** 開始残高を取った時点の最終取引ID。これより後の取引だけを再現に使う */
export const CHIP_OPENING_FROM_TX_KEY = "casino:opening_from_tx_id";
/** PR1導入時に現在のチップ残高を保存する版。正式開業初期化で opening_v1 へ切り替える */
export const LEGACY_OPENING_VERSION = "legacy_pre_reset";

/** Land台帳と連動するか（deposit/redeem は必ず Land 取引IDを持つ） */
export type ChipTxKind = "internal_transfer" | "deposit" | "redeem";

export interface ChipMove {
  txKind: ChipTxKind;
  /** internal_transfer / redeem では必須。deposit は発行なので null */
  from?: string | null;
  /** internal_transfer / deposit では必須。redeem は消却なので null */
  to?: string | null;
  amount: number;
  reason: string;
  game?: string | null;
  sessionId?: string | null;
  /** deposit / redeem で必須。対応する Land 取引の id */
  ledgerTxId?: number | null;
}

export interface ChipGroupInput {
  /** 業務操作の冪等キー。同じキーで二度呼んでも資金は一度しか動かない */
  groupKey: string;
  /** solo_game / table_settle / deposit など（仕様書5.1） */
  kind: string;
  actorId: string;
}

export interface ChipGroupRow {
  group_key: string;
  kind: string;
  status: "settled" | "failed";
  actor_id: string;
  result_json: string | null;
  created_at: number;
  settled_at: number | null;
}

export interface ChipTxRow {
  id: number;
  group_key: string;
  seq: number;
  tx_kind: ChipTxKind;
  from_holder: string | null;
  to_holder: string | null;
  amount: number;
  reason: string;
  game: string | null;
  session_id: string | null;
  actor_id: string;
  ledger_tx_id: number | null;
  created_at: number;
}

export interface ChipBalanceMismatch {
  holder: string;
  /** 開始残高 + 取引から再現した残高 */
  expected: number;
  /** `ether_balances` の実残高 */
  actual: number;
}

export type ChipTxErrorCode =
  | "ERR_NO_GROUP"
  | "ERR_BAD_AMOUNT"
  | "ERR_EMPTY_REASON"
  | "ERR_HOLDER_REQUIRED"
  | "ERR_LEDGER_REF_REQUIRED";

export class ChipTxError extends Error {
  constructor(
    readonly code: ChipTxErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ChipTxError";
  }
}

interface ActiveGroup {
  groupKey: string;
  kind: string;
  actorId: string;
  /** 入れ子で入ってきた回数。外側が閉じるまで active を保つ */
  depth: number;
  /** このグループで記録した明細数（seq の採番）。毎回 MAX(seq) を引かない */
  seq: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class ChipTx {
  /**
   * 実行中のグループ。better-sqlite3 は同期なので、グループ本体の実行中に
   * 別の業務操作が割り込むことはない（await を挟む処理は runGroup の外で行う）。
   */
  private active: ActiveGroup | null = null;

  /**
   * プリペアドステートメントは使い回す。1ゲームごとに数件の追記が入るので、
   * 毎回コンパイルすると賭場全体の処理時間に効いてくる。
   */
  private readonly stmt: {
    insertGroup: Database.Statement;
    finishGroup: Database.Statement;
    getGroup: Database.Statement;
    insertTx: Database.Statement;
    getTx: Database.Statement;
  };

  constructor(private readonly db: Database.Database) {
    this.stmt = {
      insertGroup: db.prepare(
        `INSERT INTO casino_tx_groups (group_key, kind, status, actor_id, created_at) VALUES (?, ?, 'settled', ?, ?)`,
      ),
      finishGroup: db.prepare("UPDATE casino_tx_groups SET result_json = ?, settled_at = ? WHERE group_key = ?"),
      getGroup: db.prepare("SELECT * FROM casino_tx_groups WHERE group_key = ?"),
      insertTx: db.prepare(
        `INSERT INTO casino_tx
           (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, game, session_id, actor_id, ledger_tx_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getTx: db.prepare("SELECT * FROM casino_tx WHERE id = ?"),
    };
  }

  /**
   * 業務操作を1つのDBトランザクションで実行する（仕様書5.5）。
   *
   * - `groupKey` を INSERT できた側だけが本体を実行する
   * - すでに処理済みなら**資金を動かさず**保存済みの結果を返す
   * - 例外は行ごとロールバックする（グループも明細も残さない＝再実行できる）
   *
   * すでに別のグループが実行中なら、そのグループに**合流**する（入れ子でグループを
   * 作らない）。上位で1つの業務操作として括られている場合に、内側の部品が独自の
   * トランザクションや冪等キーを作って二重管理になるのを避ける。
   */
  runGroup<T>(input: ChipGroupInput, body: () => T): T {
    if (this.active) {
      this.active.depth++;
      try {
        return body();
      } finally {
        this.active.depth--;
      }
    }

    const existing = this.getGroup(input.groupKey);
    if (existing) return this.decodeResult<T>(existing);

    const tx = this.db.transaction((): T => {
      const ts = now();
      this.stmt.insertGroup.run(input.groupKey, input.kind, input.actorId, ts);
      this.active = { ...input, depth: 1, seq: 0 };
      try {
        const result = body();
        this.stmt.finishGroup.run(result === undefined ? null : JSON.stringify(result), now(), input.groupKey);
        return result;
      } finally {
        this.active = null;
      }
    });

    try {
      return tx();
    } catch (e) {
      // 別プロセス・別呼び出しが先に確定させていた場合は、その結果を返す（資金は動かさない）
      if (isUniqueViolation(e)) {
        const settled = this.getGroup(input.groupKey);
        if (settled) return this.decodeResult<T>(settled);
      }
      throw e;
    }
  }

  /** いまグループの中か（チップ移動が許されるか） */
  isActive(): boolean {
    return this.active !== null;
  }

  /** チップ移動を1件追記する。グループの外では記録できない＝資金を動かせない */
  record(move: ChipMove): number {
    const group = this.active;
    if (!group) throw new ChipTxError("ERR_NO_GROUP", { reason: move.reason });
    if (!Number.isSafeInteger(move.amount) || move.amount <= 0) {
      throw new ChipTxError("ERR_BAD_AMOUNT", { amount: move.amount });
    }
    if (!move.reason || move.reason.trim() === "") throw new ChipTxError("ERR_EMPTY_REASON", { move });

    const needsFrom = move.txKind !== "deposit";
    const needsTo = move.txKind !== "redeem";
    if (needsFrom && !move.from) throw new ChipTxError("ERR_HOLDER_REQUIRED", { side: "from", txKind: move.txKind });
    if (needsTo && !move.to) throw new ChipTxError("ERR_HOLDER_REQUIRED", { side: "to", txKind: move.txKind });
    if (move.txKind !== "internal_transfer" && !move.ledgerTxId) {
      throw new ChipTxError("ERR_LEDGER_REF_REQUIRED", { txKind: move.txKind });
    }

    const seq = ++group.seq;
    const info = this.stmt.insertTx.run(
        group.groupKey,
        seq,
        move.txKind,
        move.txKind === "deposit" ? null : move.from,
        move.txKind === "redeem" ? null : move.to,
        move.amount,
        move.reason.trim(),
        move.game ?? null,
        move.sessionId ?? null,
        group.actorId,
        move.ledgerTxId ?? null,
        now(),
      );
    return Number(info.lastInsertRowid);
  }

  getGroup(groupKey: string): ChipGroupRow | undefined {
    return this.stmt.getGroup.get(groupKey) as ChipGroupRow | undefined;
  }

  getTx(id: number): ChipTxRow | undefined {
    return this.stmt.getTx.get(id) as ChipTxRow | undefined;
  }

  listByGroup(groupKey: string): ChipTxRow[] {
    return this.db.prepare("SELECT * FROM casino_tx WHERE group_key = ? ORDER BY seq").all(groupKey) as ChipTxRow[];
  }

  // ---- 開始残高 ----

  /** 現在の開始残高の版。未設定なら PR1 の版 */
  currentVersion(): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CHIP_OPENING_VERSION_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? LEGACY_OPENING_VERSION;
  }

  /**
   * 開始残高を保存する。同じ版で二度目は何もしない（戻り値 false）。
   * 「いまの残高を出発点にする」宣言なので、後から書き換えない。
   */
  captureOpening(version: string, balances: Iterable<readonly [string, number]>): boolean {
    const existing = this.db
      .prepare("SELECT COUNT(*) AS c FROM casino_chip_opening_balances WHERE opening_version = ?")
      .get(version) as { c: number };
    if (existing.c > 0) return false;

    const ts = now();
    const insert = this.db.prepare(
      `INSERT INTO casino_chip_opening_balances (opening_version, holder, amount, created_at) VALUES (?, ?, ?, ?)`,
    );
    const setSetting = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const [holder, amount] of balances) insert.run(version, holder, amount, ts);
      // 「この残高はどの取引の後の姿か」を固定する。既存の取引まで足し戻して二重に数えないため
      const lastTx = (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM casino_tx").get() as { id: number }).id;
      setSetting.run(CHIP_OPENING_VERSION_KEY, version, ts);
      setSetting.run(CHIP_OPENING_FROM_TX_KEY, String(lastTx), ts);
    })();
    return true;
  }

  /** 現在の開始残高が「どの取引の後の姿か」。これ以前の取引は再現に含めない */
  openingFromTxId(): number {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CHIP_OPENING_FROM_TX_KEY) as
      | { value: string }
      | undefined;
    const n = Number(row?.value ?? 0);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  /** PR1導入時の一度きりの記録。いまのチップ残高をそのまま開始残高にする */
  captureLegacyOpening(): boolean {
    const rows = this.db.prepare("SELECT user_id, amount FROM ether_balances ORDER BY user_id").all() as Array<{
      user_id: string;
      amount: number;
    }>;
    return this.captureOpening(
      LEGACY_OPENING_VERSION,
      rows.map((r) => [r.user_id, r.amount] as const),
    );
  }

  openingBalances(version = this.currentVersion()): Map<string, number> {
    const rows = this.db
      .prepare("SELECT holder, amount FROM casino_chip_opening_balances WHERE opening_version = ?")
      .all(version) as Array<{ holder: string; amount: number }>;
    return new Map(rows.map((r) => [r.holder, r.amount]));
  }

  // ---- 検算A: 開始残高 + 取引 = 現在残高 ----

  /** 記録から再現した残高。0 になった保有者も残す（実残高との突き合わせに使うため） */
  replayBalances(version = this.currentVersion()): Map<string, number> {
    const balances = this.openingBalances(version);
    const add = (holder: string | null, delta: number) => {
      if (!holder) return;
      balances.set(holder, (balances.get(holder) ?? 0) + delta);
    };
    const rows = this.db
      .prepare("SELECT tx_kind, from_holder, to_holder, amount FROM casino_tx WHERE id > ? ORDER BY id")
      .all(this.openingFromTxId()) as Array<Pick<ChipTxRow, "tx_kind" | "from_holder" | "to_holder" | "amount">>;
    for (const row of rows) {
      add(row.from_holder, -row.amount);
      add(row.to_holder, row.amount);
    }
    return balances;
  }

  /** 実残高（ether_balances）との突き合わせ。1 Ld の差も見逃さない */
  verifyBalances(version = this.currentVersion()): { ok: boolean; mismatches: ChipBalanceMismatch[] } {
    const expected = this.replayBalances(version);
    const actualRows = this.db.prepare("SELECT user_id, amount FROM ether_balances").all() as Array<{
      user_id: string;
      amount: number;
    }>;
    const actual = new Map(actualRows.map((r) => [r.user_id, r.amount]));

    const mismatches: ChipBalanceMismatch[] = [];
    for (const holder of new Set([...expected.keys(), ...actual.keys()])) {
      const e = expected.get(holder) ?? 0;
      const a = actual.get(holder) ?? 0;
      if (e !== a) mismatches.push({ holder, expected: e, actual: a });
    }
    return { ok: mismatches.length === 0, mismatches: mismatches.sort((x, y) => x.holder.localeCompare(y.holder)) };
  }

  private decodeResult<T>(row: ChipGroupRow): T {
    return (row.result_json === null ? undefined : (JSON.parse(row.result_json) as T)) as T;
  }
}

function isUniqueViolation(e: unknown): boolean {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code?: unknown }).code) : "";
  return code.startsWith("SQLITE_CONSTRAINT");
}
