import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  canonicalHash,
  schemaFingerprint,
  sha256Hex,
  tableColumns,
  tableRowCount,
  tableToCsv,
} from "./opening-canonical.js";

/**
 * 正式開業初期化のバックアップ契約（CLAUDE.md §7）。
 *
 * `OpeningBackupAdapter` はSQLite全体のスナップショット・archive対象全tableのCSV・
 * それぞれのSHA-256・スキーマ情報・plan hash等を含む manifest を返す契約だけを持つ。
 * 実ファイルシステムを触る本番adapterは本PRでは実行しない
 * （`TestFilesystemOpeningBackupAdapter` は一時ディレクトリ専用、テストからのみ使う）。
 */
export const BACKUP_FORMAT_VERSION = 1;
export const SUPPORTED_BACKUP_FORMAT_VERSIONS: readonly number[] = [BACKUP_FORMAT_VERSION];

export interface OpeningBackupCsvEntry {
  table: string;
  columns: string[];
  rows: number;
  sha256: string;
}

export interface OpeningBackupManifest {
  backupFormatVersion: number;
  planHash: string;
  createdAt: number;
  /** このDB固有の識別子。誤って別DBのbackupやmanifestを取り違えないための照合値 */
  databaseIdentity: string;
  schemaFingerprint: string;
  sqliteSha256: string;
  csv: OpeningBackupCsvEntry[];
  latestLandTransactionId: number;
  latestChipTransactionId: number;
  /** casino_tx_groups の全group_keyを正規化・ソートしてhash化した世代識別子 */
  latestChipGroupGeneration: string;
  openingVersion: string;
  archiveTables: string[];
}

export interface OpeningBackupRequest {
  db: Database.Database;
  planHash: string;
  /** archive対象のテーブル名（分類表のarchive=trueだけを渡す。呼び出し側の責務） */
  archiveTables: readonly string[];
  openingVersion: string;
}

export interface OpeningBackupAdapter {
  backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest>;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * DB固有の識別子。書き込みなしで導出する（backupはpreflightより後だが、それでも
 * 「バックアップを取る」という操作自体に無関係な書き込みを混ぜない）。
 *
 * Land台帳の `sys:treasury` 口座の作成時刻と、最初期のLand取引の冪等キー（最大10件）から
 * 導出する。どちらもそのDBの生涯で一度しか作られず、後から変わらない値なので、
 * 別のSQLiteファイルを取り違えて操作しようとした場合に高確率で検出できる。
 */
export function databaseIdentity(db: Database.Database): string {
  const treasury = db.prepare("SELECT created_at FROM accounts WHERE id = 'sys:treasury'").get() as
    | { created_at: number }
    | undefined;
  const firstTxKeys = db
    .prepare("SELECT idempotency_key FROM transactions ORDER BY id ASC LIMIT 10")
    .all() as Array<{ idempotency_key: string }>;
  return canonicalHash({
    treasuryCreatedAt: treasury?.created_at ?? null,
    firstTxKeys: firstTxKeys.map((r) => r.idempotency_key),
  });
}

function chipGroupGeneration(db: Database.Database): string {
  const rows = db.prepare("SELECT group_key FROM casino_tx_groups ORDER BY group_key ASC").all() as Array<{
    group_key: string;
  }>;
  return canonicalHash(rows.map((r) => r.group_key));
}

function latestChipTransactionId(db: Database.Database): number {
  const row = db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM casino_tx").get() as { id: number };
  return row.id;
}

/** manifest計算そのもの（fake/filesystem両adapterで共有する。副作用はない） */
export function computeBackupManifest(request: OpeningBackupRequest): OpeningBackupManifest {
  const { db } = request;
  const archiveTables = [...request.archiveTables].sort();
  const csv: OpeningBackupCsvEntry[] = archiveTables.map((table) => {
    const { csv: text, rows, columns } = tableToCsv(db, table);
    return { table, columns, rows, sha256: sha256Hex(text) };
  });
  return {
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    planHash: request.planHash,
    createdAt: now(),
    databaseIdentity: databaseIdentity(db),
    schemaFingerprint: schemaFingerprint(db),
    sqliteSha256: "", // adapterがバイト列取得後に埋める
    csv,
    latestLandTransactionId: (db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM transactions").get() as { id: number }).id,
    latestChipTransactionId: latestChipTransactionId(db),
    latestChipGroupGeneration: chipGroupGeneration(db),
    openingVersion: request.openingVersion,
    archiveTables,
  };
}

/**
 * テスト専用のインメモリbackup adapter。
 *
 * 実ファイルを一切書かない。`better-sqlite3` の `serialize()`（DBバイト列をメモリ上に取得する
 * 標準API）でSQLite全体のスナップショットバイト列を得て、そのsha256をmanifestへ入れる。
 * crash injection・敵対的テストで「backup失敗」「manifest不一致」を注入するためのフックを持つ。
 */
export class FakeOpeningBackupAdapter implements OpeningBackupAdapter {
  readonly calls: OpeningBackupRequest[] = [];
  private readonly bytesByPlanHash = new Map<string, Buffer>();

  constructor(
    private readonly opts: {
      fail?: boolean;
      failMessage?: string;
      corrupt?: (manifest: OpeningBackupManifest) => OpeningBackupManifest;
    } = {},
  ) {}

  async backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest> {
    this.calls.push(request);
    if (this.opts.fail) throw new Error(this.opts.failMessage ?? "fake backup adapter: forced failure");
    const bytes = request.db.serialize();
    this.bytesByPlanHash.set(request.planHash, bytes);
    const manifest: OpeningBackupManifest = { ...computeBackupManifest(request), sqliteSha256: sha256Hex(bytes) };
    return this.opts.corrupt ? this.opts.corrupt(manifest) : manifest;
  }

  /** テスト用: 取得済みのSQLiteスナップショットを取り出す（復元検証など） */
  snapshotBytes(planHash: string): Buffer | undefined {
    return this.bytesByPlanHash.get(planHash);
  }
}

/**
 * テスト・ローカル検証専用のファイルシステムbackup adapter。
 *
 * **本番運用では使わない。** production向けの実装・配線は本PRの範囲外
 * （CLAUDE.md §7「本タスク中に実ファイルシステムのproduction backup adapterを実行しない」）。
 * 呼び出し側は必ず一時ディレクトリ（`os.tmpdir()`配下など）を渡すこと。
 */
export class TestFilesystemOpeningBackupAdapter implements OpeningBackupAdapter {
  constructor(private readonly directory: string) {}

  async backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest> {
    mkdirSync(this.directory, { recursive: true });
    const prefix = `casino-opening-${request.planHash}`;
    const sqlitePath = join(this.directory, `${prefix}.sqlite`);
    const bytes = request.db.serialize();
    writeFileSync(sqlitePath, bytes);

    const manifest = computeBackupManifest(request);
    for (const entry of manifest.csv) {
      const { csv: text } = tableToCsv(request.db, entry.table);
      writeFileSync(join(this.directory, `${prefix}-${entry.table}.csv`), text, "utf8");
    }
    const finalManifest: OpeningBackupManifest = { ...manifest, sqliteSha256: sha256Hex(readFileSync(sqlitePath)) };
    writeFileSync(join(this.directory, `${prefix}-manifest.json`), JSON.stringify(finalManifest, null, 2), "utf8");
    return finalManifest;
  }
}

export interface ManifestVerificationExpectation {
  archiveTables: readonly string[];
  planHash: string;
  databaseIdentity: string;
  schemaFingerprint: string;
  /** table -> row count（backup時点の実カウントと突き合わせる） */
  rowCounts: Readonly<Record<string, number>>;
}

export interface ManifestVerificationResult {
  ok: boolean;
  problems: string[];
}

/**
 * manifestの完全検証（CLAUDE.md §7）。文字列一致だけでなく、実データとの整合を全部見る。
 * 1件でも不一致ならバックアップは信用できない = applyの破壊的transactionへ進めない。
 */
export function verifyOpeningBackupManifest(
  manifest: OpeningBackupManifest,
  expectation: ManifestVerificationExpectation,
): ManifestVerificationResult {
  const problems: string[] = [];

  if (!SUPPORTED_BACKUP_FORMAT_VERSIONS.includes(manifest.backupFormatVersion)) {
    problems.push(`backupFormatVersion未対応: ${manifest.backupFormatVersion}`);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sqliteSha256)) {
    problems.push(`sqliteSha256の形式が不正: ${JSON.stringify(manifest.sqliteSha256)}`);
  }
  if (manifest.planHash !== expectation.planHash) {
    problems.push(`plan hash不一致: manifest=${manifest.planHash} expected=${expectation.planHash}`);
  }
  if (manifest.databaseIdentity !== expectation.databaseIdentity) {
    problems.push("database identity不一致（別のDBのbackupの可能性）");
  }
  if (manifest.schemaFingerprint !== expectation.schemaFingerprint) {
    problems.push("schema fingerprint不一致");
  }

  const expectedTables = [...expectation.archiveTables].sort();
  const manifestCsvTables = manifest.csv.map((c) => c.table);
  const manifestTableSet = new Set(manifestCsvTables);
  if (manifestCsvTables.length !== manifestTableSet.size) {
    problems.push("manifest内にCSVエントリの重複がある");
  }
  const missing = expectedTables.filter((t) => !manifestTableSet.has(t));
  const extra = [...manifestTableSet].filter((t) => !expectedTables.includes(t)).sort();
  if (missing.length > 0) problems.push(`manifestに必須tableが欠落: ${missing.join(",")}`);
  if (extra.length > 0) problems.push(`manifestに余剰tableがある: ${extra.join(",")}`);
  if (manifest.archiveTables.length !== expectedTables.length || manifest.archiveTables.some((t, i) => t !== expectedTables[i])) {
    problems.push("archiveTables一覧が期待値と一致しない");
  }

  for (const entry of manifest.csv) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      problems.push(`CSV hashの形式が不正: ${entry.table}`);
    }
    const expectedRows = expectation.rowCounts[entry.table];
    if (expectedRows !== undefined && entry.rows !== expectedRows) {
      problems.push(`row count不一致: ${entry.table} manifest=${entry.rows} expected=${expectedRows}`);
    }
  }

  return { ok: problems.length === 0, problems };
}
