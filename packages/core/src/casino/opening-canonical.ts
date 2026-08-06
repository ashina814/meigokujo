import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { eventMarketEscrowHolder, EVENT_MARKET_FEES_HOLDER } from "./market.js";
import type { Ledger } from "../ledger/service.js";

/**
 * 決定的な正規化シリアライズ（PR12 plan hash の基盤）。
 *
 * - オブジェクトは**キーをソート**してから並べる（挿入順・列挙順に依存しない）。
 * - 配列は**渡された順序をそのまま使う**。呼び出し側が `Map`/`Set` やDBの読み取り順から
 *   配列を作るときは、意味のある安定した順序（holder名の辞書順など）へ**先に自分でソート**
 *   してから渡すこと。ここでは配列の意味（順序に意味があるか）を知らないので、勝手に並べ替えない。
 * - `number` はそのまま `JSON.stringify` する（`NaN`/`Infinity` は `null` になる — 呼び出し側は
 *   事前に safe integer を保証しておくこと。ここでの目的はhash計算であって入力検証ではない）。
 * - `undefined` なプロパティは `JSON.stringify` と同じくキーごと消える。
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  if (value instanceof Map) {
    throw new Error("canonicalStringify: Map を直接渡さない（ソート済み配列へ変換してから渡すこと）");
  }
  if (value instanceof Set) {
    throw new Error("canonicalStringify: Set を直接渡さない（ソート済み配列へ変換してから渡すこと）");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(",")}}`;
  }
  // string / number / boolean
  return JSON.stringify(value);
}

/** sha256(canonicalStringify(value)) の16進文字列 */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

/** Buffer/文字列そのもののsha256（ファイルバイト列など、正規化の対象ではない生データ用） */
export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * PR12内の資金・残高合算が桁あふれを黙って丸めないようにする（CLAUDE.md監査ブロッカー8）。
 * 個々の入力が`Number.isSafeInteger`でも、合計がsafe integerとは限らない
 * （`Number.MAX_SAFE_INTEGER`付近の値を複数足すと、生の`+`は誤差を含んだまま黙って通過する）。
 * `NaN`/`Infinity`/非safe-integerな入力もここで拒否する（`NaN`を0として扱わない）。
 *
 * 呼び出し側の文脈で挙動を選ぶこと: preflight（dry-run）で判明する場合は
 * try/catchして構造化blockerへ変換する。transaction中で判明する場合はそのまま
 * 投げさせ、transaction全体をROLLBACKさせる。
 */
export class UnsafeAmountArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeAmountArithmeticError";
  }
}

/** `values`をすべてsafe integerの範囲内で合算する。1件でも不正・overflowなら例外を投げる */
export function checkedAddAll(values: readonly number[], label: string): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) {
      throw new UnsafeAmountArithmeticError(`${label}: 入力がsafe integerではない(${v})`);
    }
    const next = total + v;
    if (!Number.isSafeInteger(next)) {
      throw new UnsafeAmountArithmeticError(`${label}: 合算結果がsafe integer範囲を超えた(overflow): ${total} + ${v}`);
    }
    total = next;
  }
  return total;
}

/** 2値版のショートハンド */
export function checkedAdd(a: number, b: number, label: string): number {
  return checkedAddAll([a, b], label);
}

export interface TableContentFingerprint {
  exists: boolean;
  rows: number;
  /** 各行を canonicalStringify → 辞書順ソート → 結合 → hash。読み取り順(rowid順)に依存しない */
  sha256: string;
}

/**
 * テーブル1つの内容フィンガープリント。
 *
 * 行の列挙順（SQLiteのSELECT結果順）に依存させないため、各行を正規化した文字列へ変換してから
 * **文字列としてソート**する。同じ内容の行集合なら、DBがどんな物理順で返しても同じhashになる。
 */
export function tableFingerprint(db: Database.Database, table: string): TableContentFingerprint {
  if (!tableExists(db, table)) {
    return { exists: false, rows: 0, sha256: canonicalHash([]) };
  }
  const rows = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Array<Record<string, unknown>>;
  const canonicalRows = rows.map((row) => canonicalStringify(row)).sort();
  return { exists: true, rows: rows.length, sha256: canonicalHash(canonicalRows) };
}

export function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(table),
  );
}

export function tableRowCount(db: Database.Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;
}

export function tableColumns(db: Database.Database, table: string): string[] {
  if (!tableExists(db, table)) return [];
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * スキーマ全体のフィンガープリント（sqlite_master の sql 定義そのものを正規化してhash化）。
 * テーブル追加・列追加・CHECK制約変更などを検知する。
 */
export interface PlayerLandFingerprint {
  accounts: number;
  total: number;
  /** [accountId, amount] のペアをaccountId昇順ソートしたもの */
  sha256: string;
}

/**
 * 利用者Landの口座別フィンガープリント。preflightとpostflightで同じ実装を使うこと
 * （CLAUDE.md監査ブロッカー4）。口座数・合計額だけでは、総額とaccount数を保ったまま
 * 利用者間でLandを付け替える改竄を検出できない。
 */
export function playerLandFingerprint(db: Database.Database): PlayerLandFingerprint {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, COALESCE(b.amount, 0) AS amount
       FROM accounts a
       LEFT JOIN balances b ON b.account_id = a.id
       WHERE a.kind = 'user'
       ORDER BY a.id`,
    )
    .all() as Array<{ account_id: string; amount: number }>;
  return {
    accounts: rows.length,
    total: checkedAddAll(rows.map((row) => Number(row.amount)), "playerLandFingerprint.total"),
    sha256: canonicalHash(rows.map((row) => [row.account_id, Number(row.amount)])),
  };
}

export function schemaFingerprint(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  return canonicalHash(rows.map((r) => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql })));
}

/**
 * イベントLand板（market_mode='event'）保護fingerprint（PR12監査: イベントLand板の完全保護）。
 *
 * 破壊的transaction（R6）の直前と、R6〜R13完了後（同一transaction内・COMMIT前）の2回計算し、
 * 一致することを要求する。一致しなければCOMMITせず、transaction全体をROLLBACKさせる
 * （postflightの他のV1〜V7と同じ思想: row countだけでなく行内容・残高の値そのものを比較する）。
 *
 * `tableFingerprint` と同じパターン（行を正規化文字列へ変換 → ソート → hash）で、
 * SELECTの物理的な返却順に依存しない。
 */
export interface EventProtectionFingerprint {
  eventMarketsSha256: string;
  eventBetsSha256: string;
  eventMarketOpsSha256: string;
  eventEscrowSha256: string;
  eventFeesHolderBalance: number;
}

export function eventProtectionFingerprint(db: Database.Database, ledger: Ledger): EventProtectionFingerprint {
  const hasMarketMode = tableExists(db, "casino_markets") && tableColumns(db, "casino_markets").includes("market_mode");

  const eventMarkets = hasMarketMode
    ? (db.prepare("SELECT * FROM casino_markets WHERE market_mode = 'event' ORDER BY id").all() as Array<
        Record<string, unknown>
      >)
    : [];
  const eventMarketIds = eventMarkets.map((r) => Number(r.id));

  const eventBets =
    eventMarketIds.length > 0 && tableExists(db, "casino_market_bets")
      ? (db
          .prepare(
            `SELECT * FROM casino_market_bets WHERE market_id IN (${eventMarketIds.map(() => "?").join(",")}) ` +
              `ORDER BY market_id, user_id, option_index, created_at`,
          )
          .all(...eventMarketIds) as Array<Record<string, unknown>>)
      : [];

  const eventOps = tableExists(db, "event_market_ops")
    ? (db.prepare("SELECT * FROM event_market_ops ORDER BY operation_id").all() as Array<Record<string, unknown>>)
    : [];

  const escrowPairs: Array<[string, number]> = eventMarketIds
    .map((id): [string, number] => [eventMarketEscrowHolder(id), ledger.balanceOf(eventMarketEscrowHolder(id))])
    .sort((a, b) => a[0].localeCompare(b[0]));

  return {
    eventMarketsSha256: canonicalHash(eventMarkets.map((r) => canonicalStringify(r)).sort()),
    eventBetsSha256: canonicalHash(eventBets.map((r) => canonicalStringify(r)).sort()),
    eventMarketOpsSha256: canonicalHash(eventOps.map((r) => canonicalStringify(r)).sort()),
    eventEscrowSha256: canonicalHash(escrowPairs),
    eventFeesHolderBalance: ledger.balanceOf(EVENT_MARKET_FEES_HOLDER),
  };
}

export function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return `"${value}"`;
}

/** CSVセルの正規表現ベースのエスケープ（RFC4180準拠の最小実装） */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** テーブル1つをCSVテキストへ変換する。列順は PRAGMA table_info の定義順で固定する */
export function tableToCsv(db: Database.Database, table: string): { csv: string; rows: number; columns: string[] } {
  const columns = tableColumns(db, table);
  const rows = db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Array<Record<string, unknown>>;
  const csv =
    [columns.join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(","))].join("\n") + "\n";
  return { csv, rows: rows.length, columns };
}
