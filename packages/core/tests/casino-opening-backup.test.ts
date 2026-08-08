import { mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import {
  FakeOpeningBackupAdapter,
  ProductionOpeningBackupAdapter,
  TestFilesystemOpeningBackupAdapter,
  computeBackupManifest,
  databaseIdentity,
  verifyOpeningBackupManifest,
  verifyOpeningBackupFilesOnDisk,
} from "../src/casino/opening-backup.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  ledger.ensureAccount("user:alice", "user");
  ledger.transfer({ from: TREASURY, to: "user:alice", amount: 1000, type: "initial", actor: "t", idempotencyKey: "seed" });
  db.exec("CREATE TABLE IF NOT EXISTS ether_balances (user_id TEXT PRIMARY KEY, amount INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('house', 500, 0)").run();
  return { db, ledger };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("databaseIdentity", () => {
  it("同一DB内容なら同じ識別子、別DBなら異なる", () => {
    const a = setup();
    const b = setup();
    expect(databaseIdentity(a.db)).toBe(databaseIdentity(b.db));

    const c = openDb(":memory:");
    const ledgerC = new Ledger(c);
    ledgerC.ensureAccount("user:bob", "user");
    ledgerC.transfer({ from: TREASURY, to: "user:bob", amount: 1, type: "initial", actor: "t", idempotencyKey: "different-seed" });
    expect(databaseIdentity(a.db)).not.toBe(databaseIdentity(c));
  });
});

describe("FakeOpeningBackupAdapter", () => {
  it("archive対象テーブルのCSV・SHA256・sqlite全体のSHA256を含むmanifestを返す", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter();
    const manifest = await adapter.backup({ db, planHash: "abc123", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    expect(manifest.planHash).toBe("abc123");
    expect(manifest.csv).toHaveLength(1);
    expect(manifest.csv[0]!.table).toBe("ether_balances");
    expect(manifest.csv[0]!.rows).toBe(1);
    expect(/^[a-f0-9]{64}$/.test(manifest.csv[0]!.sha256)).toBe(true);
    expect(/^[a-f0-9]{64}$/.test(manifest.sqliteSha256)).toBe(true);
    expect(manifest.backupFormatVersion).toBe(1);
  });

  it("fail:trueで例外を投げる（backup失敗のcrash注入に使う）", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter({ fail: true, failMessage: "disk full" });
    await expect(adapter.backup({ db, planHash: "x", archiveTables: [], openingVersion: "legacy_pre_reset" })).rejects.toThrow("disk full");
  });

  it("corruptフックでmanifestを意図的に壊せる（manifest不一致テストに使う）", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter({ corrupt: (m) => ({ ...m, sqliteSha256: "0".repeat(64) }) });
    const manifest = await adapter.backup({ db, planHash: "x", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    expect(manifest.sqliteSha256).toBe("0".repeat(64));
  });
});

describe("TestFilesystemOpeningBackupAdapter", () => {
  it("実ファイル(sqlite/csv/manifest.json)を一時ディレクトリへ書き出す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-test-"));
    tmpDirs.push(dir);
    const { db } = setup();
    const adapter = new TestFilesystemOpeningBackupAdapter(dir);
    const manifest = await adapter.backup({ db, planHash: "filehash1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });

    expect(existsSync(join(dir, "casino-opening-filehash1.sqlite"))).toBe(true);
    expect(existsSync(join(dir, "casino-opening-filehash1-ether_balances.csv"))).toBe(true);
    expect(existsSync(join(dir, "casino-opening-filehash1-manifest.json"))).toBe(true);

    const csvText = readFileSync(join(dir, "casino-opening-filehash1-ether_balances.csv"), "utf8");
    expect(csvText).toContain("house");

    const savedManifest = JSON.parse(readFileSync(join(dir, "casino-opening-filehash1-manifest.json"), "utf8"));
    expect(savedManifest.planHash).toBe(manifest.planHash);
    expect(savedManifest.sqliteSha256).toBe(manifest.sqliteSha256);
  });
});

describe("ProductionOpeningBackupAdapter", () => {
  function persistentDir(): string {
    const dir = mkdtempSync(join(process.cwd(), "pr195-production-backup-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("writes persistent sqlite/csv/manifest files and verifies them from disk", async () => {
    const dir = persistentDir();
    const { db } = setup();
    const adapter = new ProductionOpeningBackupAdapter(dir);
    const manifest = await adapter.backup({
      db,
      planHash: "prodhash1",
      archiveTables: ["ether_balances"],
      openingVersion: "legacy_pre_reset",
    });

    expect(adapter.durability).toBe("persistent");
    expect(existsSync(join(dir, "casino-opening-prodhash1.sqlite"))).toBe(true);
    expect(existsSync(join(dir, "casino-opening-prodhash1-ether_balances.csv"))).toBe(true);
    expect(existsSync(join(dir, "casino-opening-prodhash1-manifest.json"))).toBe(true);

    const savedManifest = JSON.parse(readFileSync(join(dir, "casino-opening-prodhash1-manifest.json"), "utf8"));
    expect(savedManifest).toEqual(manifest);
    const diskCheck = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(diskCheck.ok).toBe(true);
  });

  it("returns the existing verified backup for the same plan and rejects corrupted published files", async () => {
    const dir = persistentDir();
    const { db } = setup();
    const adapter = new ProductionOpeningBackupAdapter(dir);
    const manifest = await adapter.backup({
      db,
      planHash: "prodhash2",
      archiveTables: ["ether_balances"],
      openingVersion: "legacy_pre_reset",
    });

    await expect(
      adapter.backup({ db, planHash: "prodhash2", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" }),
    ).resolves.toEqual(manifest);

    writeFileSync(join(dir, "casino-opening-prodhash2-ether_balances.csv"), "corrupt\n", "utf8");
    await expect(
      adapter.backup({ db, planHash: "prodhash2", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" }),
    ).rejects.toThrow(/incomplete|corrupt/);
  });

  it("rejects unset and OS temp backup directories", () => {
    expect(() => new ProductionOpeningBackupAdapter("")).toThrow(/not configured/);
    expect(() => new ProductionOpeningBackupAdapter(tmpdir())).toThrow(/OS temp/);
    expect(() => new ProductionOpeningBackupAdapter(join(tmpdir(), "casino-opening-backups"))).toThrow(/OS temp/);
  });
});

describe("verifyOpeningBackupManifest", () => {
  function expectationFor(db: ReturnType<typeof setup>["db"], planHash: string) {
    return {
      archiveTables: ["ether_balances"],
      planHash,
      databaseIdentity: databaseIdentity(db),
      schemaFingerprint: computeBackupManifest({ db, planHash, archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" }).schemaFingerprint,
      rowCounts: { ether_balances: 1 },
    };
  }

  it("正常なmanifestはok:true", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter();
    const manifest = await adapter.backup({ db, planHash: "ok1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    const result = verifyOpeningBackupManifest(manifest, expectationFor(db, "ok1"));
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("sqliteSha256の形式異常を検出する", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter({ corrupt: (m) => ({ ...m, sqliteSha256: "not-a-hash" }) });
    const manifest = await adapter.backup({ db, planHash: "bad1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    const result = verifyOpeningBackupManifest(manifest, expectationFor(db, "bad1"));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("sqliteSha256"))).toBe(true);
  });

  it("plan hash不一致を検出する", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter();
    const manifest = await adapter.backup({ db, planHash: "hash-a", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    const result = verifyOpeningBackupManifest(manifest, expectationFor(db, "hash-b"));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("plan hash"))).toBe(true);
  });

  it("database identity不一致を検出する（別DBのbackupの取り違え）", async () => {
    const { db } = setup();
    const other = setup();
    other.ledger.transfer({ from: TREASURY, to: "user:alice", amount: 1, type: "initial", actor: "t", idempotencyKey: "extra" });
    const adapter = new FakeOpeningBackupAdapter();
    const manifest = await adapter.backup({ db, planHash: "id1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    const expectation = { ...expectationFor(db, "id1"), databaseIdentity: databaseIdentity(other.db) };
    const result = verifyOpeningBackupManifest(manifest, expectation);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("database identity"))).toBe(true);
  });

  it("table欠落・table余剰・重複を検出する", async () => {
    const { db } = setup();
    db.exec("CREATE TABLE IF NOT EXISTS extra_table (id INTEGER PRIMARY KEY)");
    const adapter = new FakeOpeningBackupAdapter();

    const missingManifest = await adapter.backup({ db, planHash: "m1", archiveTables: [], openingVersion: "legacy_pre_reset" });
    const missingResult = verifyOpeningBackupManifest(missingManifest, expectationFor(db, "m1"));
    expect(missingResult.problems.some((p) => p.includes("欠落"))).toBe(true);

    const extraManifest = await adapter.backup({ db, planHash: "m2", archiveTables: ["ether_balances", "extra_table"], openingVersion: "legacy_pre_reset" });
    const extraResult = verifyOpeningBackupManifest(extraManifest, expectationFor(db, "m2"));
    expect(extraResult.problems.some((p) => p.includes("余剰"))).toBe(true);

    const dupManifest = await adapter.backup({ db, planHash: "m3", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    dupManifest.csv.push({ ...dupManifest.csv[0]! });
    const dupResult = verifyOpeningBackupManifest(dupManifest, expectationFor(db, "m3"));
    expect(dupResult.problems.some((p) => p.includes("重複"))).toBe(true);
  });

  it("row count不一致を検出する", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter();
    const manifest = await adapter.backup({ db, planHash: "r1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    const expectation = { ...expectationFor(db, "r1"), rowCounts: { ether_balances: 999 } };
    const result = verifyOpeningBackupManifest(manifest, expectation);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("row count"))).toBe(true);
  });

  it("backupFormatVersion未対応を検出する", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter({ corrupt: (m) => ({ ...m, backupFormatVersion: 999 }) });
    const manifest = await adapter.backup({ db, planHash: "v1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    const result = verifyOpeningBackupManifest(manifest, expectationFor(db, "v1"));
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("backupFormatVersion"))).toBe(true);
  });

  it("schema fingerprint不一致を検出する", async () => {
    const { db } = setup();
    const adapter = new FakeOpeningBackupAdapter();
    const manifest = await adapter.backup({ db, planHash: "s1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    const expectation = { ...expectationFor(db, "s1"), schemaFingerprint: "deadbeef" };
    const result = verifyOpeningBackupManifest(manifest, expectation);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("schema fingerprint"))).toBe(true);
  });
});

describe("verifyOpeningBackupFilesOnDisk — 実ファイル検証", () => {
  async function realBackup(dir: string) {
    const { db } = setup();
    const adapter = new TestFilesystemOpeningBackupAdapter(dir);
    const manifest = await adapter.backup({ db, planHash: "disk1", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });
    return { db, manifest };
  }

  it("正常なファイル一式はok:true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { manifest } = await realBackup(dir);
    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("SQLiteスナップショットファイルが存在しない(削除された)場合を検出する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { manifest } = await realBackup(dir);
    unlinkSync(join(dir, `casino-opening-${manifest.planHash}.sqlite`));
    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("存在しない") && p.includes("sqlite"))).toBe(true);
  });

  it("CSVファイルが存在しない場合を検出する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { manifest } = await realBackup(dir);
    unlinkSync(join(dir, `casino-opening-${manifest.planHash}-ether_balances.csv`));
    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("CSVファイルが存在しない"))).toBe(true);
  });

  it("SQLiteスナップショットが空ファイルに差し替えられた場合を検出する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { manifest } = await realBackup(dir);
    writeFileSync(join(dir, `casino-opening-${manifest.planHash}.sqlite`), "");
    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("空"))).toBe(true);
  });

  it("CSVが空ファイルに差し替えられた場合を検出する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { manifest } = await realBackup(dir);
    writeFileSync(join(dir, `casino-opening-${manifest.planHash}-ether_balances.csv`), "");
    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("CSVファイルが空"))).toBe(true);
  });

  it("CSVの内容が改変された場合(行の値を書き換え)を検出する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { manifest } = await realBackup(dir);
    const csvPath = join(dir, `casino-opening-${manifest.planHash}-ether_balances.csv`);
    const original = readFileSync(csvPath, "utf8");
    writeFileSync(csvPath, original.replace(/\d+/g, (m) => String(Number(m) + 1)));
    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("CSVファイルの実ファイルhash"))).toBe(true);
  });

  it("CSVの行順が改変された場合を検出する(2行以上のテーブルで検証)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { db } = setup();
    db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('user2', 100, 0)").run();
    const adapter = new TestFilesystemOpeningBackupAdapter(dir);
    const manifest = await adapter.backup({ db, planHash: "disk-order", archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" });

    const csvPath = join(dir, `casino-opening-${manifest.planHash}-ether_balances.csv`);
    const lines = readFileSync(csvPath, "utf8").split("\n");
    // ヘッダーを除く本体行(空行を除く)を逆順にする
    const header = lines[0];
    const body = lines.slice(1).filter((l) => l.length > 0);
    expect(body.length).toBeGreaterThanOrEqual(2);
    const reordered = [header, ...body.reverse()].join("\n") + "\n";
    writeFileSync(csvPath, reordered);

    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("CSVファイルの実ファイルhash"))).toBe(true);
  });

  it("manifestだけ本物で実ファイルが偽物(内容が別物)に差し替えられた場合を検出する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-files-"));
    tmpDirs.push(dir);
    const { manifest } = await realBackup(dir);
    // sqliteファイルを、全く別内容の(しかし空ではない)バイト列にすり替える
    writeFileSync(join(dir, `casino-opening-${manifest.planHash}.sqlite`), Buffer.from("not a real sqlite file, but manifest still claims the old hash"));
    const result = verifyOpeningBackupFilesOnDisk(dir, manifest);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("SQLiteスナップショットの実ファイルhash"))).toBe(true);
  });
});
