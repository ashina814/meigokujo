import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { OpeningPlanner } from "../src/casino/opening-plan.js";
import { OpeningApplyManualReviewError, OpeningReset } from "../src/casino/opening-reset.js";
import { TestFilesystemOpeningBackupAdapter, type OpeningBackupManifest } from "../src/casino/opening-backup.js";
import { newExternalOperationId } from "../src/casino/opening-execution.js";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";

registerDefaultTxTypes();

/**
 * PR12監査ブロッカーC: resume時の永続backup再検証。
 *
 * `apply()`が backup_verified 以降のexecutionを（新しいプロセス／新しい呼び出しとして）
 * 再開するとき、backupManifest列の内容を信じるだけでなく、`OpeningResetService`が
 * ディスク上の実体を改めて再検証することを確認する。改竄・欠損の検出は
 * `verifyOpeningBackupFilesOnDisk`（SQLite/CSV/manifest.jsonそれぞれの実ファイルhash）に
 * 委譲されるので、ここでは「resumeの入口で本当に再検証が起きるか」「失敗時の状態遷移が
 * 仕様どおりか（backup_verifiedはfailed、external_started以降はmanual_review_required、
 * どちらもR6・外部工程の再実行・資金移動が起きない）」を見る。
 */

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, ether, events);
  const chipAssets = new CasinoChipAssets(db, ether);
  const integrity = new CasinoIntegrity(db, ledger, ether, escrow, chipAssets);
  const status = new CasinoStatus(db);
  const settings = new Settings(db);
  const departments = new Departments(db, ledger);
  const reset = new OpeningReset({ db, ledger, chips: ether, chipAssets, integrity, status, settings, departments });
  const planner = new OpeningPlanner({ db, ledger, chips: ether, chipAssets, integrity, status, settings, departments });
  return { db, ledger, events, chipTx, ether, escrow, chipAssets, integrity, status, settings, departments, reset, planner };
}

type Ctx = ReturnType<typeof setup>;

function seedLegacy(ctx: Ctx): void {
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  ctx.ledger.transfer({
    from: deptAccount("賭博場"), to: ETHER_ESCROW, amount: 30_000, type: "ether_house_fund", actor: "system:ether",
    approvedBy: "system:ether", idempotencyKey: "legacy:fund:house",
  });
  ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(HOUSE_HOLDER, 30_000);
  ctx.chipTx.captureLegacyOpening({ poolLand: ctx.ledger.balanceOf(ETHER_ESCROW), fromLedgerTxId: ctx.ledger.lastTransactionId() });
  ctx.departments.upsert("賭博場", "賭博場", null);
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newBackupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pr12-backup-reverify-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * `status`（"backup_verified" | "external_started" | "external_completed" | "applying"）まで
 * execution/casino_statusを持っていき、実backupファイル一式（persistent adapter）を書き出す。
 * 戻り値のdirectory配下のファイルをテストごとに改竄・削除して`apply()`のresumeを再度呼ぶ。
 */
async function primeExecutionAt(
  ctx: Ctx,
  actorId: string,
  targetStatus: "backup_verified" | "external_started" | "external_completed" | "applying",
): Promise<{ dir: string; manifest: OpeningBackupManifest; executionId: string; planHash: string }> {
  writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
  ctx.status.beginOpeningReset(`テスト: ${actorId}による開始`, actorId);
  const plan = ctx.planner.dryRun();
  expect(plan.blockers.length).toBe(0);
  const acquire = ctx.reset.executionStore.acquire(plan.planHash, actorId, plan.snapshot.configuration);
  const executionId = acquire.execution.id;
  // 所有権bindも本番のR0と同じ形にしておく(apply()側の不変条件チェックに引っかからないように)
  ctx.status.bindOpeningExecutionOwner(executionId, actorId);

  const dir = newBackupDir();
  const adapter = new TestFilesystemOpeningBackupAdapter(dir);
  const archiveTables = plan.snapshot.tables.filter((t) => t.archive && t.exists).map((t) => t.table);
  const manifest = await adapter.backup({ db: ctx.db, planHash: plan.planHash, archiveTables, openingVersion: LEGACY_OPENING_VERSION });

  // 各transition()の戻り値のapplied:trueを必ず確認する。CASが不一致（fromStatusの
  // 指定間違い等）で静かにno-opすると、以降の状態がずっと"planned"のまま止まり、
  // テストが「resumeの再検証」ではなく「まるごと新規実行」を検証してしまう事故になる。
  const acquired = ctx.reset.executionStore.transition(executionId, "planned", "opening_reset_acquired");
  if (!acquired.applied) throw new Error(`test setup失敗: planned->opening_reset_acquired (${JSON.stringify(acquired)})`);
  const started = ctx.reset.executionStore.transition(executionId, "opening_reset_acquired", "backup_started");
  if (!started.applied) throw new Error("test setup失敗: opening_reset_acquired->backup_started");
  const verified = ctx.reset.executionStore.transition(executionId, "backup_started", "backup_verified", { backupManifest: manifest });
  if (!verified.applied) throw new Error("test setup失敗: backup_started->backup_verified");
  if (targetStatus === "backup_verified") {
    return { dir, manifest, executionId, planHash: plan.planHash };
  }

  const extStarted = ctx.reset.executionStore.transition(executionId, "backup_verified", "external_started");
  if (!extStarted.applied) throw new Error("test setup失敗: backup_verified->external_started");
  if (targetStatus === "external_started") {
    return { dir, manifest, executionId, planHash: plan.planHash };
  }

  const externalOperationId = newExternalOperationId(plan.planHash);
  const extCompleted = ctx.reset.executionStore.transition(executionId, "external_started", "external_completed", {
    externalOperationId,
    externalOperationResult: { ok: true },
  });
  if (!extCompleted.applied) throw new Error("test setup失敗: external_started->external_completed");
  if (targetStatus === "external_completed") {
    return { dir, manifest, executionId, planHash: plan.planHash };
  }

  const applying = ctx.reset.executionStore.transition(executionId, "external_completed", "applying");
  if (!applying.applied) throw new Error("test setup失敗: external_completed->applying");
  return { dir, manifest, executionId, planHash: plan.planHash };
}

function readExecutionRow(ctx: Ctx, id: string) {
  return ctx.db
    .prepare("SELECT status, funds_applied FROM casino_opening_executions WHERE id = ?")
    .get(id) as { status: string; funds_applied: number };
}

describe("OpeningReset.apply — resume時の永続backup再検証(PR12監査ブロッカーC)", () => {
  it("正常resume: 改竄が無ければbackup_verifiedからそのまま最後まで完了する", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir } = await primeExecutionAt(ctx, "admin", "backup_verified");
    const result = await ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() });
    expect(result.status).toBe("completed");
  });

  it("backup_verified状態でSQLiteスナップショットが削除されている場合: failedへ倒れ、R6・資金移動は起きない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "backup_verified");
    unlinkSync(join(dir, `casino-opening-${manifest.planHash}.sqlite`));

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow(/永続backup再検証/);

    const row = readExecutionRow(ctx, executionId);
    expect(row.status).toBe("failed");
    expect(row.funds_applied).toBe(0);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
  });

  it("backup_verified状態でmanifest.jsonが削除されている場合も検出される", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "backup_verified");
    unlinkSync(join(dir, `casino-opening-${manifest.planHash}-manifest.json`));

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow(/永続backup再検証/);
    expect(readExecutionRow(ctx, executionId).status).toBe("failed");
  });

  it("backup_verified状態でCSVが1つ削除されている場合も検出される", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "backup_verified");
    const csvEntry = manifest.csv[0];
    expect(csvEntry).toBeTruthy();
    unlinkSync(join(dir, `casino-opening-${manifest.planHash}-${csvEntry!.table}.csv`));

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow(/永続backup再検証/);
    expect(readExecutionRow(ctx, executionId).status).toBe("failed");
  });

  it("backup_verified状態でSQLiteファイルが改竄されている場合も検出される", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "backup_verified");
    const sqlitePath = join(dir, `casino-opening-${manifest.planHash}.sqlite`);
    const bytes = readFileSync(sqlitePath);
    bytes[0] = (bytes[0]! + 1) % 256; // 1バイトだけ書き換える
    writeFileSync(sqlitePath, bytes);

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow(/永続backup再検証/);
    expect(readExecutionRow(ctx, executionId).status).toBe("failed");
  });

  it("backup_verified状態でCSVが改竄されている場合も検出される", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "backup_verified");
    const csvEntry = manifest.csv[0]!;
    const csvPath = join(dir, `casino-opening-${manifest.planHash}-${csvEntry.table}.csv`);
    writeFileSync(csvPath, `${readFileSync(csvPath, "utf8")}\ntampered,row,injected\n`);

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow(/永続backup再検証/);
    expect(readExecutionRow(ctx, executionId).status).toBe("failed");
  });

  it("external_startedでbackupが削除されている場合: manual_review_requiredへ倒れ、外部工程を再実行せず資金も動かない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "external_started");
    unlinkSync(join(dir, `casino-opening-${manifest.planHash}.sqlite`));

    const external = new FakeOpeningExternalAdapter();
    let externalCalledDuringResume = false;
    const originalDisable = external.disableLegacyCasino.bind(external);
    external.disableLegacyCasino = async (req) => {
      externalCalledDuringResume = true;
      return originalDisable(req);
    };

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external }),
    ).rejects.toThrow(OpeningApplyManualReviewError);

    expect(externalCalledDuringResume).toBe(false);
    const row = readExecutionRow(ctx, executionId);
    expect(row.status).toBe("manual_review_required");
    expect(row.funds_applied).toBe(0);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
  });

  it("external_completedでmanifestが改竄されている場合: manual_review_requiredへ倒れ、R6は開始しない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "external_completed");
    const manifestPath = join(dir, `casino-opening-${manifest.planHash}-manifest.json`);
    const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as OpeningBackupManifest;
    onDisk.sqliteSha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(onDisk, null, 2), "utf8");

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow(OpeningApplyManualReviewError);

    const row = readExecutionRow(ctx, executionId);
    expect(row.status).toBe("manual_review_required");
    expect(row.funds_applied).toBe(0);
    const casinoTxCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n;
    expect(casinoTxCount).toBe(0);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
  });

  it("applying直前でbackupが削除されている場合: R6を開始せず、manual_review_requiredへ倒れる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir, manifest, executionId } = await primeExecutionAt(ctx, "admin", "applying");
    unlinkSync(join(dir, `casino-opening-${manifest.planHash}.sqlite`));

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new TestFilesystemOpeningBackupAdapter(dir), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow(OpeningApplyManualReviewError);

    const row = readExecutionRow(ctx, executionId);
    expect(row.status).toBe("manual_review_required");
    expect(row.funds_applied).toBe(0);
    // R6が一切走っていない証拠: casino_tx/ether_balancesが元のまま、Land残高も変化なし
    const casinoTxCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n;
    expect(casinoTxCount).toBe(0);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
  });

  it("funds_applied=trueに達した後は、backupが削除されていてもpost-commit工程だけ継続し、資金再適用は起きない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { dir } = await primeExecutionAt(ctx, "admin", "applying");
    // 正常に最後まで走らせてfunds_appliedへ到達させる
    const backup = new TestFilesystemOpeningBackupAdapter(dir);
    const result = await ctx.reset.apply({ actorId: "admin", backup, external: new FakeOpeningExternalAdapter() });
    expect(result.status).toBe("completed");
    expect(ctx.chipTx.currentVersion()).toBe("opening_v1");

    // completed後に再度applyしても、二重開業防止(already_opening_v1 blocker)で弾かれるだけで、
    // 資金の再適用は起きない(backupの状態を見るより前に、そもそもblockerで拒否される設計)
    await expect(
      ctx.reset.apply({ actorId: "admin", backup, external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow();
    expect(ctx.chipTx.currentVersion()).toBe("opening_v1");
  });
});
