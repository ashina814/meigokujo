import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  canonicalHash,
  canonicalStringify,
  schemaFingerprint,
  sha256Hex,
  tableColumns,
  tableExists,
  tableRowCount,
  tableToCsv,
} from "./opening-canonical.js";

/**
 * 正式開業初期化のバックアップ契約（CLAUDE.md §7）。
 *
 * `OpeningBackupAdapter` はSQLite全体のスナップショット・archive対象全tableのCSV・
 * それぞれのSHA-256・スキーマ情報・plan hash等を含む manifest を返す契約だけを持つ。
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

/**
 * `"memory"`: プロセス終了・GCで消える証拠(インメモリbackup)。破壊的applyの前提には**できない**。
 * `"persistent"`: プロセスと切り離された実体(ファイル等)として保存され、再読込による再検証が可能。
 * CLAUDE.md監査ブロッカー5.3: この区別を型として持たせ、破壊的applyはpersistentしか受け付けない。
 */
export type OpeningBackupDurability = "memory" | "persistent";

export interface OpeningBackupVerificationResult {
  ok: boolean;
  problems: string[];
}

export interface OpeningBackupAdapter {
  /** このadapterが返す証拠がプロセスを跨いで存在し続けるか。破壊的applyのゲートに使う */
  readonly durability: OpeningBackupDurability;

  backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest>;

  /**
   * `backup()` が返した証拠を、保存された実体から**再読込して**再検証する（CLAUDE.md監査
   * ブロッカー5.2）。`backup()` 自身が返したmanifestを信じるだけでは、実体を書き損なった・
   * 書いた直後に消えた、といった故障を検出できない。`durability !== "persistent"` の
   * adapterでは意味のある永続証拠が無いため、常に `ok:false` を返してよい。
   */
  verifyPersistedBackup(
    manifest: OpeningBackupManifest,
    expectation: ManifestVerificationExpectation,
  ): Promise<OpeningBackupVerificationResult>;
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

/**
 * casino_tx_groups の全group_keyを正規化・ソートしてhash化した世代識別子。
 * manifest自身の値を「期待値」として自己比較しないよう、backup検証の呼び出し側
 * （OpeningReset.apply）が稼働中DBから独立に再計算するためexportする（CLAUDE.md監査ブロッカー5.1）。
 */
export function chipGroupGeneration(db: Database.Database): string {
  const rows = db.prepare("SELECT group_key FROM casino_tx_groups ORDER BY group_key ASC").all() as Array<{
    group_key: string;
  }>;
  return canonicalHash(rows.map((r) => r.group_key));
}

/** 稼働中DBから独立に再計算するためexportする（理由は{@link chipGroupGeneration}と同じ） */
export function latestChipTransactionId(db: Database.Database): number {
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
  /** インメモリ = プロセス終了で消える証拠。破壊的applyの前提にはできない（CLAUDE.md監査ブロッカー5.3） */
  readonly durability: OpeningBackupDurability = "memory";
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyPersistedBackup(): Promise<OpeningBackupVerificationResult> {
    return { ok: false, problems: ["memory adapterは永続証拠を持たない(durability=memory)"] };
  }
}

/** テスト・ローカル検証専用のファイルシステムbackup adapter。 */
export class TestFilesystemOpeningBackupAdapter implements OpeningBackupAdapter {
  readonly durability: OpeningBackupDurability = "persistent";

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

  async verifyPersistedBackup(
    manifest: OpeningBackupManifest,
    expectation: ManifestVerificationExpectation,
  ): Promise<OpeningBackupVerificationResult> {
    const manifestCheck = verifyOpeningBackupManifest(manifest, expectation);
    const diskCheck = verifyOpeningBackupFilesOnDisk(this.directory, manifest);
    return {
      ok: manifestCheck.ok && diskCheck.ok,
      problems: [...manifestCheck.problems, ...diskCheck.problems],
    };
  }
}

/**
 * Production backup publisher.
 *
 * A backup becomes visible as completed only when a fully written and verified staging directory
 * is atomically renamed to `casino-opening-<planHash>` on the same filesystem. A process crash
 * before that rename can therefore leave only an ignored staging directory; a retry creates a new
 * staging directory and converges. A crash after rename is a completed publish and is read back and
 * verified on retry.
 */
export class ProductionOpeningBackupAdapter implements OpeningBackupAdapter {
  readonly durability: OpeningBackupDurability = "persistent";
  private readonly directory: string;
  private stagingSequence = 0;

  constructor(directory: string | undefined | null) {
    if (!directory || directory.trim() === "") {
      throw new Error("CASINO_OPENING_BACKUP_DIR is not configured");
    }
    this.directory = resolve(directory);
    const normalizedDirectory = this.directory.toLowerCase();
    const tempRoot = resolve(tmpdir()).toLowerCase();
    if (normalizedDirectory === tempRoot || normalizedDirectory.startsWith(`${tempRoot}\\`) || normalizedDirectory.startsWith(`${tempRoot}/`)) {
      throw new Error("CASINO_OPENING_BACKUP_DIR must not be an OS temp directory");
    }
  }

  async backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest> {
    this.ensureUsableDirectory();
    const finalDirectory = this.bundleDirectory(request.planHash);
    const existing = this.readExistingManifest(finalDirectory);
    if (existing) {
      this.assertExistingBackupMatchesRequest(existing, request, finalDirectory);
      return existing;
    }

    const stagingDirectory = join(
      this.directory,
      `.casino-opening-${request.planHash}.staging-${process.pid}-${Date.now()}-${++this.stagingSequence}`,
    );
    mkdirSync(stagingDirectory, { mode: 0o700 });

    const bytes = request.db.serialize();
    const manifest = computeBackupManifest(request);
    const finalManifest: OpeningBackupManifest = { ...manifest, sqliteSha256: sha256Hex(bytes) };
    let published = false;
    try {
      writeFileSync(join(stagingDirectory, "snapshot.sqlite"), bytes, { mode: 0o600 });
      for (const entry of finalManifest.csv) {
        const { csv: text } = tableToCsv(request.db, entry.table);
        writeFileSync(this.csvPath(stagingDirectory, entry.table), text, { encoding: "utf8", mode: 0o600 });
      }
      // manifest is deliberately last within staging; staging itself is never treated as completed.
      writeFileSync(join(stagingDirectory, "manifest.json"), JSON.stringify(finalManifest, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });

      const stagedCheck = this.verifyBundleFiles(stagingDirectory, finalManifest);
      if (!stagedCheck.ok) {
        throw new Error(`opening backup staging verification failed: ${stagedCheck.problems.join("; ")}`);
      }
      if (existsSync(finalDirectory)) {
        throw new Error(`opening backup final directory already exists: ${finalDirectory}`);
      }

      // Both paths are siblings under the configured persistent root, so this is a same-filesystem
      // directory rename and publishes sqlite/csv/manifest as one atomic directory entry.
      renameSync(stagingDirectory, finalDirectory);
      published = true;
      this.restrictBundle(finalDirectory, finalManifest);

      const verified = await this.verifyPersistedBackup(finalManifest, this.expectationForRequest(request));
      if (!verified.ok) {
        throw new Error(`opening backup verification failed: ${verified.problems.join("; ")}`);
      }
      return finalManifest;
    } catch (error) {
      // A real process crash never reaches this catch and may leave an orphan staging directory.
      // Retries ignore staging directories. Never remove a published/completed final directory here.
      if (!published && existsSync(stagingDirectory)) {
        rmSync(stagingDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async verifyPersistedBackup(
    manifest: OpeningBackupManifest,
    expectation: ManifestVerificationExpectation,
  ): Promise<OpeningBackupVerificationResult> {
    const manifestCheck = verifyOpeningBackupManifest(manifest, expectation);
    const diskCheck = this.verifyBundleFiles(this.bundleDirectory(manifest.planHash), manifest);
    return {
      ok: manifestCheck.ok && diskCheck.ok,
      problems: [...manifestCheck.problems, ...diskCheck.problems],
    };
  }

  private ensureUsableDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = statSync(this.directory);
    if (!stat.isDirectory()) throw new Error(`CASINO_OPENING_BACKUP_DIR is not a directory: ${this.directory}`);
    const probe = join(this.directory, `.opening-backup-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, "ok", { mode: 0o600 });
    rmSync(probe, { force: true });
  }

  private bundleDirectory(planHash: string): string {
    return join(this.directory, `casino-opening-${planHash}`);
  }

  private csvPath(directory: string, table: string): string {
    if (table === "" || table.includes("/") || table.includes("\\") || table === "." || table === "..") {
      throw new Error(`unsafe opening backup table filename: ${JSON.stringify(table)}`);
    }
    return join(directory, `${table}.csv`);
  }

  private readExistingManifest(finalDirectory: string): OpeningBackupManifest | null {
    if (!existsSync(finalDirectory)) return null;
    if (!statSync(finalDirectory).isDirectory()) {
      throw new Error(`existing opening backup path is not a directory: ${finalDirectory}`);
    }
    const manifestPath = join(finalDirectory, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`existing opening backup is incomplete: manifest missing: ${manifestPath}`);
    }
    try {
      return JSON.parse(readFileSync(manifestPath, "utf8")) as OpeningBackupManifest;
    } catch {
      throw new Error(`existing opening backup manifest is corrupt: ${manifestPath}`);
    }
  }

  private assertExistingBackupMatchesRequest(
    manifest: OpeningBackupManifest,
    request: OpeningBackupRequest,
    finalDirectory: string,
  ): void {
    const expected = {
      ...computeBackupManifest(request),
      createdAt: manifest.createdAt,
      sqliteSha256: sha256Hex(request.db.serialize()),
    };
    if (canonicalStringify(manifest) !== canonicalStringify(expected)) {
      throw new Error(`opening backup conflict for planHash ${request.planHash}`);
    }
    const verified = this.verifyBundleFiles(finalDirectory, manifest);
    if (!verified.ok) {
      throw new Error(`existing opening backup is incomplete or corrupt: ${verified.problems.join("; ")}`);
    }
  }

  private verifyBundleFiles(directory: string, manifest: OpeningBackupManifest): FileBackupVerificationResult {
    const problems: string[] = [];
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      return { ok: false, problems: [`backup directory does not exist: ${directory}`] };
    }

    const manifestPath = join(directory, "manifest.json");
    if (!existsSync(manifestPath)) {
      problems.push(`manifestファイルが存在しない: ${manifestPath}`);
    } else if (statSync(manifestPath).size === 0) {
      problems.push(`manifestファイルが空: ${manifestPath}`);
    } else {
      try {
        const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as OpeningBackupManifest;
        if (canonicalStringify(onDisk) !== canonicalStringify(manifest)) {
          problems.push(`manifestファイルの内容が保持しているmanifestと一致しない: ${manifestPath}`);
        }
      } catch {
        problems.push(`manifestファイルのJSONが不正: ${manifestPath}`);
      }
    }

    const sqlitePath = join(directory, "snapshot.sqlite");
    if (!existsSync(sqlitePath)) {
      problems.push(`SQLiteスナップショットファイルが存在しない: ${sqlitePath}`);
    } else if (statSync(sqlitePath).size === 0) {
      problems.push(`SQLiteスナップショットファイルが空: ${sqlitePath}`);
    } else if (sha256Hex(readFileSync(sqlitePath)) !== manifest.sqliteSha256) {
      problems.push(`SQLiteスナップショットの実ファイルhashがmanifestと一致しない: ${sqlitePath}`);
    }

    for (const entry of manifest.csv) {
      let csvPath: string;
      try {
        csvPath = this.csvPath(directory, entry.table);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!existsSync(csvPath)) {
        problems.push(`CSVファイルが存在しない: ${csvPath}`);
        continue;
      }
      if (statSync(csvPath).size === 0) {
        problems.push(`CSVファイルが空: ${entry.table}`);
        continue;
      }
      if (sha256Hex(readFileSync(csvPath, "utf8")) !== entry.sha256) {
        problems.push(`CSVファイルの実ファイルhashがmanifestと一致しない: ${entry.table}`);
      }
    }
    return { ok: problems.length === 0, problems };
  }

  private expectationForRequest(request: OpeningBackupRequest): ManifestVerificationExpectation {
    const rowCounts: Record<string, number> = {};
    const columns: Record<string, string[]> = {};
    for (const table of request.archiveTables) {
      rowCounts[table] = tableExists(request.db, table) ? tableRowCount(request.db, table) : 0;
      columns[table] = tableExists(request.db, table) ? tableColumns(request.db, table) : [];
    }
    return {
      archiveTables: request.archiveTables,
      planHash: request.planHash,
      databaseIdentity: databaseIdentity(request.db),
      schemaFingerprint: schemaFingerprint(request.db),
      rowCounts,
      columns,
      openingVersion: request.openingVersion,
      latestLandTransactionId: (request.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM transactions").get() as { id: number }).id,
      latestChipTransactionId: latestChipTransactionId(request.db),
      latestChipGroupGeneration: chipGroupGeneration(request.db),
      liveDb: request.db,
    };
  }

  private restrictBundle(directory: string, manifest: OpeningBackupManifest): void {
    try {
      chmodSync(directory, 0o700);
      chmodSync(join(directory, "snapshot.sqlite"), 0o600);
      chmodSync(join(directory, "manifest.json"), 0o600);
      for (const entry of manifest.csv) chmodSync(this.csvPath(directory, entry.table), 0o600);
      chmodSync(this.directory, 0o700);
    } catch {
      // Windows can ignore POSIX modes; read-back verification remains authoritative.
    }
  }
}

export interface ManifestVerificationExpectation {
  archiveTables: readonly string[];
  planHash: string;
  databaseIdentity: string;
  schemaFingerprint: string;
  /** table -> row count（backup時点の実カウントと突き合わせる） */
  rowCounts: Readonly<Record<string, number>>;
  /**
   * 省略可: 与えた場合、table -> 列一覧（PRAGMA table_info順）まで実DBと突き合わせる
   * （CLAUDE.md監査ブロッカー5.1: CSV列一覧もmanifestの自己申告だけでなく再検証する）
   */
  columns?: Readonly<Record<string, readonly string[]>>;
  /** 省略可: 与えた場合、backup対象がどの開業版時点だったかまで突き合わせる */
  openingVersion?: string;
  /** 省略可: 与えた場合、backup時点の最新Land取引IDまで突き合わせる（取り違え・世代ズレ検出） */
  latestLandTransactionId?: number;
  /** 省略可: 与えた場合、backup時点の最新chip取引IDまで突き合わせる */
  latestChipTransactionId?: number;
  /** 省略可: 与えた場合、backup時点のchip group世代識別子まで突き合わせる */
  latestChipGroupGeneration?: string;
  /**
   * 検証時点のDB接続。渡された場合、manifestが主張するsqliteSha256・各CSVのsha256を
   * **実データから再計算して突き合わせる**。省略した場合は形式検証のみ行う。
   */
  liveDb?: Database.Database;
}

export interface ManifestVerificationResult {
  ok: boolean;
  problems: string[];
}

/** manifestの完全検証。1件でも不一致ならバックアップは信用しない。 */
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
  } else if (expectation.liveDb) {
    const actualSqliteSha256 = sha256Hex(expectation.liveDb.serialize());
    if (actualSqliteSha256 !== manifest.sqliteSha256) {
      problems.push("sqliteSha256が実データの再計算値と一致しない（バックアップの改竄・取り違えの可能性）");
    }
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
  if (expectation.openingVersion !== undefined && manifest.openingVersion !== expectation.openingVersion) {
    problems.push(`openingVersion不一致: manifest=${manifest.openingVersion} expected=${expectation.openingVersion}`);
  }
  if (
    expectation.latestLandTransactionId !== undefined &&
    manifest.latestLandTransactionId !== expectation.latestLandTransactionId
  ) {
    problems.push(`latestLandTransactionId不一致: manifest=${manifest.latestLandTransactionId} expected=${expectation.latestLandTransactionId}`);
  }
  if (
    expectation.latestChipTransactionId !== undefined &&
    manifest.latestChipTransactionId !== expectation.latestChipTransactionId
  ) {
    problems.push(`latestChipTransactionId不一致: manifest=${manifest.latestChipTransactionId} expected=${expectation.latestChipTransactionId}`);
  }
  if (
    expectation.latestChipGroupGeneration !== undefined &&
    manifest.latestChipGroupGeneration !== expectation.latestChipGroupGeneration
  ) {
    problems.push("latestChipGroupGeneration不一致（backup後にchip取引の世代が進んだ可能性）");
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
    } else if (expectation.liveDb && tableExists(expectation.liveDb, entry.table)) {
      const { csv: actualCsv } = tableToCsv(expectation.liveDb, entry.table);
      if (sha256Hex(actualCsv) !== entry.sha256) {
        problems.push(`CSV hashが実データの再計算値と一致しない: ${entry.table}`);
      }
    }
    const expectedRows = expectation.rowCounts[entry.table];
    if (expectedRows !== undefined && entry.rows !== expectedRows) {
      problems.push(`row count不一致: ${entry.table} manifest=${entry.rows} expected=${expectedRows}`);
    }
    const expectedColumns = expectation.columns?.[entry.table];
    if (expectedColumns !== undefined) {
      const actualColumns = expectation.liveDb && tableExists(expectation.liveDb, entry.table)
        ? tableColumns(expectation.liveDb, entry.table)
        : entry.columns;
      const same = actualColumns.length === expectedColumns.length && actualColumns.every((c, i) => c === expectedColumns[i]);
      if (!same) {
        problems.push(`CSV列一覧が期待値と一致しない: ${entry.table}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

export interface FileBackupVerificationResult {
  ok: boolean;
  problems: string[];
}

/**
 * TestFilesystemOpeningBackupAdapter が使う従来flat layoutの実ファイル検証。
 * ProductionOpeningBackupAdapter はatomic bundle専用のprivate verifierを使う。
 */
export function verifyOpeningBackupFilesOnDisk(
  directory: string,
  manifest: OpeningBackupManifest,
): FileBackupVerificationResult {
  const problems: string[] = [];
  const prefix = `casino-opening-${manifest.planHash}`;

  const manifestPath = join(directory, `${prefix}-manifest.json`);
  if (!existsSync(manifestPath)) {
    problems.push(`manifestファイルが存在しない: ${manifestPath}`);
  } else if (statSync(manifestPath).size === 0) {
    problems.push(`manifestファイルが空: ${manifestPath}`);
  } else {
    try {
      const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as OpeningBackupManifest;
      if (canonicalStringify(onDisk) !== canonicalStringify(manifest)) {
        problems.push(`manifestファイルの内容が保持しているmanifestと一致しない: ${manifestPath}`);
      }
    } catch {
      problems.push(`manifestファイルのJSONが不正: ${manifestPath}`);
    }
  }

  const sqlitePath = join(directory, `${prefix}.sqlite`);
  if (!existsSync(sqlitePath)) {
    problems.push(`SQLiteスナップショットファイルが存在しない: ${sqlitePath}`);
  } else if (statSync(sqlitePath).size === 0) {
    problems.push(`SQLiteスナップショットファイルが空: ${sqlitePath}`);
  } else {
    const actual = sha256Hex(readFileSync(sqlitePath));
    if (actual !== manifest.sqliteSha256) {
      problems.push(`SQLiteスナップショットの実ファイルhashがmanifestと一致しない: ${sqlitePath}`);
    }
  }

  for (const entry of manifest.csv) {
    const csvPath = join(directory, `${prefix}-${entry.table}.csv`);
    if (!existsSync(csvPath)) {
      problems.push(`CSVファイルが存在しない: ${csvPath}`);
      continue;
    }
    if (statSync(csvPath).size === 0) {
      problems.push(`CSVファイルが空: ${entry.table}`);
      continue;
    }
    const actual = sha256Hex(readFileSync(csvPath, "utf8"));
    if (actual !== entry.sha256) {
      problems.push(`CSVファイルの実ファイルhashがmanifestと一致しない: ${entry.table}`);
    }
  }

  return { ok: problems.length === 0, problems };
}
