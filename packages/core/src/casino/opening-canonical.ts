import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

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
