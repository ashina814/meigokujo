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

/**
 * ## 版の切替と「旧版の検算」でできること・できないこと（確定）
 *
 * 開始残高には版（`opening_version`）がある。いまは PR1 導入時の `legacy_pre_reset` で、
 * 正式開業初期化（実装計画 R8〜R9）で `opening_v1` へ切り替わる。
 * 版の前後は `version_seq`（単調増加）で決める。取引IDでは決めない
 * （初期化で採番が巻き戻ると順序が逆転するため）。
 *
 * **旧版の取引再現は「初期化前（R7 の前）」でしかできない。**
 * 正式開業初期化の R7 で `casino_tx` / `casino_tx_groups` を空にするので、
 * それ以降 `replayBalances(旧版)` は開始残高そのものへ戻る（足す取引が無くなる）。
 * `verifyBalances(旧版)` も「旧版の開始残高 == 新版の開始残高」を見るだけになり、
 * 旧制度の取引が正しかったかを言うものではなくなる。
 *
 * これは仕様として次のように割り切る:
 * - **旧版の検算は R9 前の読み取り専用 preflight（実装計画 R2）限定**とする。
 *   初期化に進む前に `verifyBalances(legacy_pre_reset).ok` を確認し、その結果を記録に残す。
 * - **旧取引を新スキーマ側へアーカイブはしない。** 退避先は実装計画 R1-b の CSV
 *   （`casino_tx` / `casino_tx_groups` を含む旧賭場データ一式）とスナップショットで、
 *   初期化後に旧制度を追う必要が出たらそちらを読む。
 *   DB 内に旧取引を残すと、検算Aの窓・holder 名・単位（エテル→チップ）が新旧で混ざり、
 *   「いまの残高が正しいか」という本来の問いに答えられなくなるため。
 */
export const CHIP_OPENING_VERSION_KEY = "casino:opening_version";
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
  /**
   * deposit / redeem で必須。動いた Land の額。
   * 端数で 0 Ld になる返還（現行の変動レート由来）もあるので 0 を許す。
   */
  landAmount?: number | null;
  /** deposit / redeem で Land が動いたなら必須。対応する Land 取引の id */
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
  land_amount: number | null;
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
  | "ERR_CASINO_CLOSED"
  | "ERR_NO_GROUP"
  | "ERR_BAD_AMOUNT"
  | "ERR_EMPTY_REASON"
  | "ERR_HOLDER_REQUIRED"
  | "ERR_LAND_AMOUNT_REQUIRED"
  | "ERR_LEDGER_REF_REQUIRED"
  | "ERR_GROUP_CONFLICT"
  | "ERR_ASYNC_BODY";

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
  /** 現在の版。captureOpening で切り替わるまで変わらない */
  private cachedVersion: string | null = null;
  /**
   * 賭場が閉まっていれば理由を返す関数（PR2 で `CasinoStatus` を繋ぐ）。
   * **Discord の入口ではなくここで止める**ので、停止前から進行中のゲーム・scheduler・
   * 運営卓の資金操作も等しく止まる。
   */
  private closedReason: (() => string | null) | null = null;
  /**
   * 復旧・初期化のように「停止中でも動かしてよい」処理の入れ子深さ。
   * actor 文字列を見て判定すると呼び出し側で偽装できるので、
   * **`runMaintenance()` を通った区間だけ**が許可される明示的な経路にしてある。
   */
  private maintenanceDepth = 0;

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
           (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, game, session_id, actor_id,
            opening_version, land_amount, ledger_tx_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  /**
   * 賭場の稼働状態を繋ぐ。`open` 以外では**新しい金銭グループを作れなくなる**。
   * @param closedReason 閉まっていれば理由文、開いていれば null を返す関数
   */
  setClosedReason(closedReason: (() => string | null) | null): void {
    this.closedReason = closedReason;
  }

  /**
   * 停止中でも資金を動かしてよい区間（起動時の復旧・掃除、正式開業初期化）。
   *
   * この関数を通ることが唯一の許可経路。actor 文字列での判定にしないのは、
   * 呼び出し側が `actorId: "system:startup"` と名乗るだけで素通りできてしまうため。
   */
  runMaintenance<T>(reason: string, body: () => T): T {
    if (!reason.trim()) throw new ChipTxError("ERR_CASINO_CLOSED", { reason: "runMaintenance には理由が要る" });
    this.maintenanceDepth++;
    try {
      return body();
    } finally {
      this.maintenanceDepth--;
    }
  }

  /** いま復旧・初期化の区間の中か（テスト・診断用） */
  isMaintenance(): boolean {
    return this.maintenanceDepth > 0;
  }

  runGroup<T>(input: ChipGroupInput, body: () => T): T {
    assertGroupKey(input);
    if (this.active) {
      this.active.depth++;
      try {
        return this.assertSync(body(), input);
      } finally {
        this.active.depth--;
      }
    }

    // 処理済みの再試行は資金を動かさないので、閉まっていても保存済みの結果を返す
    const existing = this.getGroup(input.groupKey);
    if (existing) return this.replay<T>(existing, input);

    // ここから先は**新しい金銭グループを作る**。閉まっていれば作らせない
    if (this.maintenanceDepth === 0) {
      const closed = this.closedReason?.();
      if (closed) throw new ChipTxError("ERR_CASINO_CLOSED", { groupKey: input.groupKey, kind: input.kind, reason: closed });
    }

    // IMMEDIATE で始める。遅延トランザクションだと、後から書き込みへ昇格する時点で
    // SQLITE_BUSY が busy handler を通らずに即失敗しうる（複数接続で競合したとき）。
    const tx = this.db.transaction((): T => {
      const ts = now();
      this.stmt.insertGroup.run(input.groupKey, input.kind, input.actorId, ts);
      this.active = { ...input, depth: 1, seq: 0 };
      try {
        const result = this.assertSync(body(), input);
        this.stmt.finishGroup.run(result === undefined ? null : JSON.stringify(result), now(), input.groupKey);
        return result;
      } finally {
        this.active = null;
      }
    });

    try {
      return tx.immediate();
    } catch (e) {
      // 他の接続が先に確定させていた場合は、その結果を返す（資金は二度動かさない）
      if (isUniqueViolation(e)) {
        const settled = this.getGroup(input.groupKey);
        if (settled) return this.replay<T>(settled, input);
      }
      throw e;
    }
  }

  /**
   * 保存済みの結果を返す（＝二度目の呼び出し）。
   * 同じキーで種別や実行者が違うなら、別の操作が同じ鍵を使っている＝取り違えなので拒否する。
   */
  private replay<T>(row: ChipGroupRow, input: ChipGroupInput): T {
    if (row.kind !== input.kind || row.actor_id !== input.actorId) {
      throw new ChipTxError("ERR_GROUP_CONFLICT", {
        groupKey: input.groupKey,
        stored: { kind: row.kind, actorId: row.actor_id },
        requested: { kind: input.kind, actorId: input.actorId },
      });
    }
    return this.decodeResult<T>(row);
  }

  /**
   * 非同期の本体を拒否する。DBトランザクションは同期の間しか開いていられないので、
   * Promise を返す本体は「コミット後に資金が動く」＝記録と実体がずれる。
   */
  private assertSync<T>(result: T, input: ChipGroupInput): T {
    if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
      throw new ChipTxError("ERR_ASYNC_BODY", { groupKey: input.groupKey, kind: input.kind });
    }
    return result;
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
    if (move.txKind !== "internal_transfer") {
      // 預入・返還は「Landがいくら動いたか」を必ず持つ。1 Ldでも動いたなら取引IDも要る
      if (!Number.isSafeInteger(move.landAmount ?? NaN) || (move.landAmount ?? -1) < 0) {
        throw new ChipTxError("ERR_LAND_AMOUNT_REQUIRED", { txKind: move.txKind, landAmount: move.landAmount });
      }
      if (move.txKind === "deposit" && (move.landAmount ?? 0) <= 0) {
        throw new ChipTxError("ERR_LAND_AMOUNT_REQUIRED", { txKind: move.txKind, landAmount: move.landAmount });
      }
      if ((move.landAmount ?? 0) > 0 && !move.ledgerTxId) {
        throw new ChipTxError("ERR_LEDGER_REF_REQUIRED", { txKind: move.txKind });
      }
    } else if (move.landAmount != null || move.ledgerTxId != null) {
      throw new ChipTxError("ERR_LEDGER_REF_REQUIRED", { txKind: move.txKind, reason: "内部移動はLandを動かさない" });
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
        this.currentVersion(),
        move.txKind === "internal_transfer" ? null : (move.landAmount ?? 0),
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

  /** 現在の開始残高の版。未設定なら PR1 の版。版の切替は稀なのでキャッシュする */
  currentVersion(): string {
    if (this.cachedVersion === null) {
      const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(CHIP_OPENING_VERSION_KEY) as
        | { value: string }
        | undefined;
      this.cachedVersion = row?.value ?? LEGACY_OPENING_VERSION;
    }
    return this.cachedVersion;
  }

  /**
   * 開始残高を保存する。同じ版で二度目は何もしない（戻り値 false）。
   * 「いまの残高を出発点にする」宣言なので、後から書き換えない。
   */
  captureOpening(
    version: string,
    balances: Iterable<readonly [string, number]>,
    land?: { poolLand: number; fromLedgerTxId: number },
  ): boolean {
    const existing = this.db
      .prepare("SELECT COUNT(*) AS c FROM casino_chip_opening_versions WHERE opening_version = ?")
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
      // 版の前後は version_seq（単調増加）で決める。取引IDに依存させない
      const seq =
        (this.db.prepare("SELECT COALESCE(MAX(version_seq), 0) AS s FROM casino_chip_opening_versions").get() as {
          s: number;
        }).s + 1;
      const lastTx = (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM casino_tx").get() as { id: number }).id;
      this.db
        .prepare(
          `INSERT INTO casino_chip_opening_versions
             (opening_version, version_seq, from_tx_id, pool_land, from_ledger_tx_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(version, seq, lastTx, land?.poolLand ?? null, land?.fromLedgerTxId ?? null, ts);
      setSetting.run(CHIP_OPENING_VERSION_KEY, version, ts);
      this.cachedVersion = version;
    })();
    return true;
  }

  /** その版の開始残高を取った時点の最終取引ID（参考値） */
  openingFromTxId(version = this.currentVersion()): number {
    const row = this.db
      .prepare("SELECT from_tx_id FROM casino_chip_opening_versions WHERE opening_version = ?")
      .get(version) as { from_tx_id: number } | undefined;
    return row?.from_tx_id ?? 0;
  }

  /** その版の次の版（version_seq の並びで決める）。最新版なら null */
  private nextOpeningVersion(version: string): string | null {
    const row = this.db
      .prepare(
        `SELECT opening_version FROM casino_chip_opening_versions
         WHERE version_seq > (SELECT version_seq FROM casino_chip_opening_versions WHERE opening_version = ?)
         ORDER BY version_seq LIMIT 1`,
      )
      .get(version) as { opening_version: string } | undefined;
    return row?.opening_version ?? null;
  }

  /** 記録されている開始残高の版を古い順に */
  listOpeningVersions(): Array<{ version: string; seq: number; fromTxId: number }> {
    const rows = this.db
      .prepare("SELECT opening_version, version_seq, from_tx_id FROM casino_chip_opening_versions ORDER BY version_seq")
      .all() as Array<{ opening_version: string; version_seq: number; from_tx_id: number }>;
    return rows.map((r) => ({ version: r.opening_version, seq: r.version_seq, fromTxId: r.from_tx_id }));
  }

  /**
   * PR1導入時の一度きりの記録。いまのチップ残高をそのまま開始残高にする。
   * @param land その時点の準備プール残高と Land 台帳の最終取引ID（検算Bの出発点）。
   *   省略すると基準未設定になり、検算Bは NG のままになる（明示的な移行操作で置く）
   */
  captureLegacyOpening(land?: { poolLand: number; fromLedgerTxId: number }): boolean {
    const rows = this.db.prepare("SELECT user_id, amount FROM ether_balances ORDER BY user_id").all() as Array<{
      user_id: string;
      amount: number;
    }>;
    return this.captureOpening(
      LEGACY_OPENING_VERSION,
      rows.map((r) => [r.user_id, r.amount] as const),
      land,
    );
  }

  /**
   * その版の Land 側の基準（検算Bの出発点）。
   * - `poolLand`: その版を開いた時点の準備プール残高
   * - `fromLedgerTxId`: その時点の Land 台帳の最終取引ID。**これ以降の取引だけ**を監査する
   *
   * どちらか欠けていれば null を返す（＝検算Bは「基準未設定」で **NG**。自動で埋めない）。
   */
  openingLandBaseline(version = this.currentVersion()): { poolLand: number; fromLedgerTxId: number } | null {
    const row = this.db
      .prepare("SELECT pool_land, from_ledger_tx_id FROM casino_chip_opening_versions WHERE opening_version = ?")
      .get(version) as { pool_land: number | null; from_ledger_tx_id: number | null } | undefined;
    if (!row || row.pool_land === null || row.from_ledger_tx_id === null) return null;
    return { poolLand: row.pool_land, fromLedgerTxId: row.from_ledger_tx_id };
  }

  /**
   * 基準の無い版（PR2 より前に開始残高だけ取ったDB）に、後から基準を1度だけ置く。
   *
   * **これは検算ではなく明示的な移行操作**である。検算の中から自動で呼ばない
   * （自動で逆算すると、初回の検算が必ず通り、それまでの不正移動を出発点へ取り込んでしまう）。
   * 運営が「この時点を出発点にする」と決めて実行し、監査に残す。
   *
   * @returns 実際に置いたか（すでに基準があれば false・後から書き換えない）
   */
  establishOpeningLandBaseline(version: string, poolLand: number, fromLedgerTxId: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE casino_chip_opening_versions SET pool_land = ?, from_ledger_tx_id = ?
         WHERE opening_version = ? AND (pool_land IS NULL OR from_ledger_tx_id IS NULL)`,
      )
      .run(poolLand, fromLedgerTxId, version);
    return r.changes > 0;
  }

  /** その版より後に開かれた版の Land 境界（旧版の窓の終わり）。最新版なら null */
  nextOpeningLandBoundary(version = this.currentVersion()): number | null {
    const next = this.nextOpeningVersion(version);
    if (next === null) return null;
    const row = this.db
      .prepare("SELECT from_ledger_tx_id FROM casino_chip_opening_versions WHERE opening_version = ?")
      .get(next) as { from_ledger_tx_id: number | null } | undefined;
    return row?.from_ledger_tx_id ?? null;
  }

  /** group_key が存在するか（Land 取引と chip グループの対応確認に使う） */
  hasGroup(groupKey: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM casino_tx_groups WHERE group_key = ?").get(groupKey));
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
    // その版の窓に属する取引だけを足す。
    // - 版そのものを取引に刻んであるので、初期化で採番が巻き戻っても混ざらない
    // - 版を記録した時点より前の取引は除く（記録前の分まで足し戻して二重に数えない）
    const rows = this.db
      .prepare(
        `SELECT tx_kind, from_holder, to_holder, amount FROM casino_tx
         WHERE opening_version = ? AND id > ? ORDER BY id`,
      )
      .all(version, this.openingFromTxId(version)) as Array<
      Pick<ChipTxRow, "tx_kind" | "from_holder" | "to_holder" | "amount">
    >;
    for (const row of rows) {
      add(row.from_holder, -row.amount);
      add(row.to_holder, row.amount);
    }
    return balances;
  }

  /**
   * 記録から再現した残高と、実際の残高を突き合わせる。1 Ld の差も見逃さない。
   * 最新版は `ether_balances`、それ以前の版は**次の版の開始残高**と比べる
   * （旧版の窓の終わりの姿＝次の版の出発点、が一致していれば記録は繋がっている）。
   *
   * 旧版を指定した検算は、**その版の取引が `casino_tx` に残っている間だけ**意味がある。
   * 正式開業初期化で取引を初期化した後は開始残高同士の突き合わせに退化する（冒頭の解説を見る）。
   */
  verifyBalances(version = this.currentVersion()): { ok: boolean; mismatches: ChipBalanceMismatch[] } {
    const expected = this.replayBalances(version);
    const nextVersion = this.nextOpeningVersion(version);
    const actualRows =
      nextVersion === null
        ? (this.db.prepare("SELECT user_id, amount FROM ether_balances").all() as Array<{
            user_id: string;
            amount: number;
          }>)
        : (
            this.db
              .prepare("SELECT holder AS user_id, amount FROM casino_chip_opening_balances WHERE opening_version = ?")
              .all(nextVersion) as Array<{ user_id: string; amount: number }>
          );
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

/** groupKey の最低限の形。空文字や空白だけのキーは冪等性を担保できない */
function assertGroupKey(input: ChipGroupInput): void {
  if (!input.groupKey || input.groupKey.trim() === "") {
    throw new ChipTxError("ERR_GROUP_CONFLICT", { reason: "groupKey が空" });
  }
  if (!input.kind || !input.actorId) {
    throw new ChipTxError("ERR_GROUP_CONFLICT", { reason: "kind / actorId が空", groupKey: input.groupKey });
  }
}

function isUniqueViolation(e: unknown): boolean {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code?: unknown }).code) : "";
  return code.startsWith("SQLITE_CONSTRAINT");
}
