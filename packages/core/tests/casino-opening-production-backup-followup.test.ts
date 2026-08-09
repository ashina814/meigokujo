import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { ProductionOpeningBackupAdapter } from "../src/casino/opening-backup.js";

registerDefaultTxTypes();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function persistentRoot(): string {
  const root = mkdtempSync(join(process.cwd(), "pr105-backup-followup-"));
  roots.push(root);
  return root;
}

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  ledger.ensureAccount("user:alice", "user");
  ledger.transfer({ from: TREASURY, to: "user:alice", amount: 1000, type: "initial", actor: "test", idempotencyKey: "seed" });
  db.exec("CREATE TABLE IF NOT EXISTS ether_balances (user_id TEXT PRIMARY KEY, amount INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('house', 500, 0)").run();
  return { db, ledger };
}

function request(db: ReturnType<typeof setup>["db"], planHash: string) {
  return { db, planHash, archiveTables: ["ether_balances"], openingVersion: "legacy_pre_reset" } as const;
}

function bundle(root: string, planHash: string): string {
  return join(root, `casino-opening-${planHash}`);
}

function orphanStage(root: string, planHash: string, files: readonly string[]): string {
  const stage = join(root, `.casino-opening-${planHash}.staging-crashed-process`);
  mkdirSync(stage, { mode: 0o700 });
  for (const file of files) writeFileSync(join(stage, file), `orphan:${file}`, { mode: 0o600 });
  return stage;
}

describe("ProductionOpeningBackupAdapter crash-safe atomic publish", () => {
  it.each([
    ["sqlite作成後crash", ["snapshot.sqlite"]],
    ["CSV途中crash", ["snapshot.sqlite", "partial.csv"]],
    ["manifest作成前crash", ["snapshot.sqlite", "ether_balances.csv"]],
    ["publish直前crash", ["snapshot.sqlite", "ether_balances.csv", "manifest.json"]],
  ] as const)("%s のstagingをcompleted扱いせずretryで収束する", async (_name, files) => {
    const root = persistentRoot();
    const { db } = setup();
    const planHash = `crash-${files.length}`;
    const orphan = orphanStage(root, planHash, files);
    const adapter = new ProductionOpeningBackupAdapter(root);

    const manifest = await adapter.backup(request(db, planHash));

    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(join(bundle(root, planHash), "snapshot.sqlite"))).toBe(true);
    expect(existsSync(join(bundle(root, planHash), "ether_balances.csv"))).toBe(true);
    expect(JSON.parse(readFileSync(join(bundle(root, planHash), "manifest.json"), "utf8"))).toEqual(manifest);
  });

  it("publish後の再実行はsame-plan/same-content completed backupを再利用する", async () => {
    const root = persistentRoot();
    const { db } = setup();
    const adapter = new ProductionOpeningBackupAdapter(root);
    const first = await adapter.backup(request(db, "published-replay"));
    await expect(adapter.backup(request(db, "published-replay"))).resolves.toEqual(first);
  });

  it("same plan different contentはconflictでfail-closed", async () => {
    const root = persistentRoot();
    const { db, ledger } = setup();
    const adapter = new ProductionOpeningBackupAdapter(root);
    await adapter.backup(request(db, "content-conflict"));
    ledger.transfer({ from: TREASURY, to: "user:alice", amount: 1, type: "initial", actor: "test", idempotencyKey: "changed" });
    await expect(adapter.backup(request(db, "content-conflict"))).rejects.toThrow(/conflict/);
  });

  it("final manifest破損を検出する", async () => {
    const root = persistentRoot();
    const { db } = setup();
    const adapter = new ProductionOpeningBackupAdapter(root);
    await adapter.backup(request(db, "bad-manifest"));
    writeFileSync(join(bundle(root, "bad-manifest"), "manifest.json"), "{broken", "utf8");
    await expect(adapter.backup(request(db, "bad-manifest"))).rejects.toThrow(/manifest is corrupt/);
  });

  it("final sqlite破損を検出する", async () => {
    const root = persistentRoot();
    const { db } = setup();
    const adapter = new ProductionOpeningBackupAdapter(root);
    await adapter.backup(request(db, "bad-sqlite"));
    writeFileSync(join(bundle(root, "bad-sqlite"), "snapshot.sqlite"), "corrupt", "utf8");
    await expect(adapter.backup(request(db, "bad-sqlite"))).rejects.toThrow(/incomplete or corrupt/);
  });

  it("final CSV破損を検出する", async () => {
    const root = persistentRoot();
    const { db } = setup();
    const adapter = new ProductionOpeningBackupAdapter(root);
    await adapter.backup(request(db, "bad-csv"));
    writeFileSync(join(bundle(root, "bad-csv"), "ether_balances.csv"), "corrupt", "utf8");
    await expect(adapter.backup(request(db, "bad-csv"))).rejects.toThrow(/incomplete or corrupt/);
  });

  it("final file欠損を検出する", async () => {
    const root = persistentRoot();
    const { db } = setup();
    const adapter = new ProductionOpeningBackupAdapter(root);
    await adapter.backup(request(db, "missing-file"));
    unlinkSync(join(bundle(root, "missing-file"), "ether_balances.csv"));
    await expect(adapter.backup(request(db, "missing-file"))).rejects.toThrow(/incomplete or corrupt/);
  });

  it("unrelated staging/completed backupを削除しない", async () => {
    const root = persistentRoot();
    const { db } = setup();
    const unrelatedStage = orphanStage(root, "other-plan", ["snapshot.sqlite"]);
    const unrelatedCompleted = join(root, "casino-opening-unrelated");
    mkdirSync(unrelatedCompleted);
    writeFileSync(join(unrelatedCompleted, "keep.txt"), "keep");

    await new ProductionOpeningBackupAdapter(root).backup(request(db, "target-plan"));

    expect(existsSync(unrelatedStage)).toBe(true);
    expect(readFileSync(join(unrelatedCompleted, "keep.txt"), "utf8")).toBe("keep");
  });
});
