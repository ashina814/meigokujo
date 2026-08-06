import { mkdtempSync, rmSync } from "node:fs";
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
import { writeCasinoOpeningConfig, type CasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { OpeningPlanner } from "../src/casino/opening-plan.js";
import { OpeningApplyManualReviewError, OpeningReset } from "../src/casino/opening-reset.js";
import { FakeOpeningBackupAdapter, TestFilesystemOpeningBackupAdapter } from "../src/casino/opening-backup.js";
import { OpeningExecutionConflictError } from "../src/casino/opening-execution.js";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";

registerDefaultTxTypes();

/**
 * PR12監査（独立監査で見つかった残存ブロッカー）: owner-first resume。
 *
 * `OpeningReset.apply()`のR0が、statusが既に`opening_reset`でownerがbind済みの場合に
 * **現在のplan hashではなく`casino_status.opening_execution_id`を起点に**再開することを
 * 検証する。`casino-opening-reset-owner-binding.test.ts`（R0全体の原子性）・
 * `casino-opening-reset-backup-reverify.test.ts`（永続backup再検証）とは別の関心事
 * （plan hashがCOMMIT前に変化した場合の段階別resume挙動）に絞る。
 */

const VALID_CONFIG: CasinoOpeningConfig = {
  configured: true,
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

const OTHER_CONFIG: CasinoOpeningConfig = {
  ...VALID_CONFIG,
  openingCapital: 60_000,
  openingHouse: 48_000,
  openingJackpot: 10_000,
  openingRelief: 2_000,
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
  const dir = mkdtempSync(join(tmpdir(), "pr12-owner-first-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

function persistentBackupAdapter(): TestFilesystemOpeningBackupAdapter {
  return new TestFilesystemOpeningBackupAdapter(newBackupDir());
}

function owner(ctx: Ctx): { opening_execution_id: string | null; opening_actor_id: string | null } {
  return ctx.db.prepare("SELECT opening_execution_id, opening_actor_id FROM casino_status WHERE id = 1").get() as {
    opening_execution_id: string | null;
    opening_actor_id: string | null;
  };
}

function readExecutionRow(ctx: Ctx, id: string) {
  return ctx.db
    .prepare("SELECT status, funds_applied, failure_stage FROM casino_opening_executions WHERE id = ?")
    .get(id) as { status: string; funds_applied: number; failure_stage: string | null };
}

/**
 * `casino-opening-reset-backup-reverify.test.ts`の`primeExecutionAt`と同じ手法。
 * `apply()`を経由せず、`executionStore`のCAS付きtransitionを直接呼んで狙った状態まで
 * 手動で進める（configを指定できるようにした版。外部adapterは一切呼ばない＝
 * 「external_startedまで進めたが、実際に外部工程を1回も呼んでいない」状態を厳密に作れる）。
 */
async function primeExecutionAt(
  ctx: Ctx,
  actorId: string,
  targetStatus: "backup_verified" | "external_started",
  config: CasinoOpeningConfig = VALID_CONFIG,
): Promise<{ executionId: string; planHash: string }> {
  writeCasinoOpeningConfig(ctx.settings, config, "test-admin");
  ctx.status.beginOpeningReset(`テスト: ${actorId}による開始`, actorId);
  const plan = ctx.planner.dryRun();
  expect(plan.blockers).toEqual([]);
  const acquire = ctx.reset.executionStore.acquire(plan.planHash, actorId, plan.snapshot.configuration);
  const executionId = acquire.execution.id;
  ctx.status.bindOpeningExecutionOwner(executionId, actorId);

  const adapter = persistentBackupAdapter();
  const archiveTables = plan.snapshot.tables.filter((t) => t.archive && t.exists).map((t) => t.table);
  const manifest = await adapter.backup({ db: ctx.db, planHash: plan.planHash, archiveTables, openingVersion: LEGACY_OPENING_VERSION });

  const acquired = ctx.reset.executionStore.transition(executionId, "planned", "opening_reset_acquired");
  if (!acquired.applied) throw new Error("test setup失敗: planned->opening_reset_acquired");
  const started = ctx.reset.executionStore.transition(executionId, "opening_reset_acquired", "backup_started");
  if (!started.applied) throw new Error("test setup失敗: opening_reset_acquired->backup_started");
  const verified = ctx.reset.executionStore.transition(executionId, "backup_started", "backup_verified", { backupManifest: manifest });
  if (!verified.applied) throw new Error("test setup失敗: backup_started->backup_verified");
  if (targetStatus === "backup_verified") {
    return { executionId, planHash: plan.planHash };
  }

  const extStarted = ctx.reset.executionStore.transition(executionId, "backup_verified", "external_started");
  if (!extStarted.applied) throw new Error("test setup失敗: backup_verified->external_started");
  return { executionId, planHash: plan.planHash };
}

describe("OpeningReset.apply — owner-first resume: plan hash変化時の段階別挙動", () => {
  it("A: backup失敗後にplan hashが変化しても、owner executionから安全に再計画され、永久デッドロックにならない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    const failingBackup = new FakeOpeningBackupAdapter({ fail: true });
    const external = new FakeOpeningExternalAdapter();

    await expect(ctx.reset.apply({ actorId: "admin", backup: failingBackup, external })).rejects.toThrow();
    expect(ctx.status.current().status).toBe("opening_reset");
    const before = owner(ctx);
    const oldExecutionId = before.opening_execution_id!;
    expect(readExecutionRow(ctx, oldExecutionId).status).toBe("failed");
    expect(readExecutionRow(ctx, oldExecutionId).funds_applied).toBe(0);

    // plan hashに影響する安全なDB変化(開業設定の変更)を入れる
    writeCasinoOpeningConfig(ctx.settings, OTHER_CONFIG, "test-admin");

    // 同じactorで再実行 → 新設計ではowner executionから再開判断され、safely再計画されて完走する
    // (旧設計ではbindOpeningExecutionOwner()のCAS不一致で「不変条件違反」を投げ続ける永久ロックだった)
    const result = await ctx.reset.apply({ actorId: "admin", backup: persistentBackupAdapter(), external });

    expect(result.status).toBe("completed");
    expect(result.executionId).not.toBe(oldExecutionId);
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(OTHER_CONFIG.openingHouse);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);

    // 旧executionは失敗記録のまま残る(削除しない)。資金は二重に動いていない
    const oldRow = readExecutionRow(ctx, oldExecutionId);
    expect(oldRow.status).toBe("failed");
    expect(oldRow.funds_applied).toBe(0);
    const completedCount = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions WHERE status='completed'").get() as { n: number }
    ).n;
    expect(completedCount).toBe(1);
  });

  it("B: backup_verifiedで中断後にplan hashが変化 → 外部工程開始前として安全に再計画され、owner conflictにならない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { executionId: oldExecutionId } = await primeExecutionAt(ctx, "admin", "backup_verified", VALID_CONFIG);
    expect(readExecutionRow(ctx, oldExecutionId).status).toBe("backup_verified");

    // 外部工程には一切到達していない状態でplan hashを変える
    writeCasinoOpeningConfig(ctx.settings, OTHER_CONFIG, "test-admin");

    const external = new FakeOpeningExternalAdapter();
    const result = await ctx.reset.apply({ actorId: "admin", backup: persistentBackupAdapter(), external });

    expect(result.status).toBe("completed");
    expect(result.executionId).not.toBe(oldExecutionId);
    // 外部工程はこの呼び出しで初めて(1回だけ)実行されている
    expect(external.attemptsFor("casino-opening:disable-legacy-vcs")).toBe(1);
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(OTHER_CONFIG.openingHouse);

    // 旧executionはfailedへ記録され、ownerは新executionへ原子的に移った(conflictにならない)
    const oldRow = readExecutionRow(ctx, oldExecutionId);
    expect(oldRow.status).toBe("failed");
    expect(oldRow.funds_applied).toBe(0);
  });

  it("C: external_started後にplan hashが変化 → owner executionを直接取得してmanual_review_requiredへ倒れ、外部工程・backup・R6・Land資金移動を一切実行しない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { executionId } = await primeExecutionAt(ctx, "admin", "external_started", VALID_CONFIG);
    expect(readExecutionRow(ctx, executionId).status).toBe("external_started");

    const before = {
      etherEscrow: ctx.ledger.balanceOf(ETHER_ESCROW),
      houseChips: ctx.ether.balanceOf(HOUSE_HOLDER),
      casinoTxCount: (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n,
    };

    // 外部工程開始後にplan hashを変える(=自動再計画してはいけない領域)
    writeCasinoOpeningConfig(ctx.settings, OTHER_CONFIG, "test-admin");

    const external = new FakeOpeningExternalAdapter();
    let externalCalled = false;
    const originalDisable = external.disableLegacyCasino.bind(external);
    external.disableLegacyCasino = async (req) => {
      externalCalled = true;
      return originalDisable(req);
    };

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: persistentBackupAdapter(), external }),
    ).rejects.toThrow(OpeningApplyManualReviewError);

    // 外部工程は一度も呼ばれていない(resumeで再実行しない)
    expect(externalCalled).toBe(false);
    const row = readExecutionRow(ctx, executionId);
    expect(row.status).toBe("manual_review_required");
    expect(row.funds_applied).toBe(0);
    // 新plan executionへの自動移譲もしていない(所有executionは同じIDのまま)
    expect(owner(ctx)).toEqual({ opening_execution_id: executionId, opening_actor_id: "admin" });
    // R6・Land資金移動が一切走っていない証拠
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(before.etherEscrow);
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(before.houseChips);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n).toBe(before.casinoTxCount);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
  });

  it("D: 別actorでのresumeはOpeningExecutionConflictError(actor_mismatch)になり、状態・資金は一切変更されない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const { executionId } = await primeExecutionAt(ctx, "admin-a", "backup_verified", VALID_CONFIG);
    const before = owner(ctx);
    const beforeRow = readExecutionRow(ctx, executionId);
    const historyCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_status_history").get() as { n: number }).n;

    const external = new FakeOpeningExternalAdapter();
    await expect(
      ctx.reset.apply({ actorId: "admin-b", backup: persistentBackupAdapter(), external }),
    ).rejects.toThrow(OpeningExecutionConflictError);

    expect(owner(ctx)).toEqual(before);
    expect(readExecutionRow(ctx, executionId)).toEqual(beforeRow);
    expect(ctx.status.current().status).toBe("opening_reset");
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_status_history").get() as { n: number }).n).toBe(historyCountBefore);
    expect(external.attemptsFor("casino-opening:disable-legacy-vcs")).toBe(0);
  });

  describe("E: owner破損はfail-closed(新規executionを推測で作らない)", () => {
    it("opening_actor_idだけがNULL(部分破損)の場合、新規acquireへ逃げず不変条件違反で止まる", async () => {
      const ctx = setup();
      seedLegacy(ctx);
      writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
      ctx.status.beginOpeningReset("テスト", "admin");
      // 通常発生し得ない部分破損を直接注入する(execution_idだけ埋め、actor_idはNULLのまま)
      ctx.db.prepare("UPDATE casino_status SET opening_execution_id = ? WHERE id = 1").run("opening-reset:bogus");
      const executionCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;

      const backup = new FakeOpeningBackupAdapter();
      const external = new FakeOpeningExternalAdapter();
      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);

      expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(
        executionCountBefore,
      );
      expect(ctx.status.current().status).toBe("opening_reset");
    });

    it("ownerが指すexecution行が存在しない場合、新規executionを作らず不変条件違反で止まる", async () => {
      const ctx = setup();
      seedLegacy(ctx);
      writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
      ctx.status.beginOpeningReset("テスト", "admin");
      ctx.db
        .prepare("UPDATE casino_status SET opening_execution_id = ?, opening_actor_id = ? WHERE id = 1")
        .run("opening-reset:does-not-exist", "admin");
      const executionCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;

      const backup = new FakeOpeningBackupAdapter();
      const external = new FakeOpeningExternalAdapter();
      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);

      expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(
        executionCountBefore,
      );
    });

    it("execution.actorIdとowner.actorIdが食い違う場合、不変条件違反で止まる(実在executionを横取りしない)", async () => {
      const ctx = setup();
      seedLegacy(ctx);
      writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
      ctx.status.beginOpeningReset("テスト", "admin");
      const plan = ctx.planner.dryRun();
      expect(plan.blockers).toEqual([]);
      // execution行自体はactor="bob"で正規にacquireする
      const acquireResult = ctx.reset.executionStore.acquire(plan.planHash, "bob", plan.snapshot.configuration);
      // casino_status側のownerだけ"admin"へ直接書き換える(本来bindOpeningExecutionOwner()の
      // CASを通せば起きないはずの、execution行とowner記録の不整合を模擬する)
      ctx.db
        .prepare("UPDATE casino_status SET opening_execution_id = ?, opening_actor_id = ? WHERE id = 1")
        .run(acquireResult.execution.id, "admin");

      const backup = new FakeOpeningBackupAdapter();
      const external = new FakeOpeningExternalAdapter();
      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);

      // execution行自体は書き換わっていない(横取りしていない)
      const row = ctx.db.prepare("SELECT actor_id, status FROM casino_opening_executions WHERE id = ?").get(
        acquireResult.execution.id,
      ) as { actor_id: string; status: string };
      expect(row.actor_id).toBe("bob");
      expect(row.status).toBe("planned");
    });

    // PR12監査(続き): `currentOpeningOwner()`は「両方非NULL」以外(両方NULL・片方だけNULL)を
    // 一律nullへ丸めてしまうため、R0が誤ってそれを「まだ誰も取得していない」と判断し、
    // 新規acquireへ進んでしまう(＝破損状態を推測で補完してしまう)おそれがあった。
    // R0は`openingOwnerRawFields()`の生値を見て、次の3パターンをすべてfail-closedにする。
    //
    // 上の「opening_actor_idだけがNULL」テストは`opening_execution_id`に**実在しないbogus値**
    // (`"opening-reset:bogus"`)を使っていたため、後段の「executionが見つからない」不変条件違反
    // で止まっているだけの可能性があり、部分NULLそのものを検知しているとは言い切れなかった。
    // ここでは実在する正規のexecution行を指すexecution_idを使い、部分NULL自体が
    // (resumeFromOwnerへ進む前に)検知されていることを確認する。
    it("opening_execution_idは実在executionを指しているのにopening_actor_idだけがNULL(部分破損)の場合、新規acquireへ逃げず不変条件違反で止まる", async () => {
      const ctx = setup();
      seedLegacy(ctx);
      writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
      ctx.status.beginOpeningReset("テスト", "admin");
      const plan = ctx.planner.dryRun();
      expect(plan.blockers).toEqual([]);
      // execution行は正規にacquire+bindしてから、owner側のactor_idだけを直接NULLへ戻す
      // (bindOpeningExecutionOwner()のCASを経由しては起きないはずの破損を模擬する)
      const acquireResult = ctx.reset.executionStore.acquire(plan.planHash, "admin", plan.snapshot.configuration);
      const bound = ctx.status.bindOpeningExecutionOwner(acquireResult.execution.id, "admin");
      expect(bound).toBe(true);
      ctx.db.prepare("UPDATE casino_status SET opening_actor_id = NULL WHERE id = 1").run();
      const before = owner(ctx);
      expect(before).toEqual({ opening_execution_id: acquireResult.execution.id, opening_actor_id: null });
      const executionCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;
      const lastTxBefore = ctx.ledger.lastTransactionId();

      const backup = new FakeOpeningBackupAdapter();
      const external = new FakeOpeningExternalAdapter();
      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);

      // 新規executionを作らない・owner列を書き換えない・statusを変更しない・
      // backupを呼ばない・R6/Land資金移動へ進まない
      expect(backup.calls).toHaveLength(0);
      expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(executionCountBefore);
      expect(owner(ctx)).toEqual(before);
      expect(ctx.status.current().status).toBe("opening_reset");
      expect(ctx.ledger.lastTransactionId()).toBe(lastTxBefore);
      expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
      // execution行自体も書き換わっていない
      const row = readExecutionRow(ctx, acquireResult.execution.id);
      expect(row.status).toBe("planned");
    });

    it("opening_execution_idがNULLでopening_actor_idだけが設定されている(部分破損)の場合、新規acquireへ逃げず不変条件違反で止まる", async () => {
      const ctx = setup();
      seedLegacy(ctx);
      writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
      ctx.status.beginOpeningReset("テスト", "admin");
      // execution_idはNULLのまま、actor_idだけ直接注入する
      ctx.db.prepare("UPDATE casino_status SET opening_actor_id = ? WHERE id = 1").run("admin");
      const before = owner(ctx);
      expect(before).toEqual({ opening_execution_id: null, opening_actor_id: "admin" });
      const executionCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;
      const lastTxBefore = ctx.ledger.lastTransactionId();

      const backup = new FakeOpeningBackupAdapter();
      const external = new FakeOpeningExternalAdapter();
      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);

      expect(backup.calls).toHaveLength(0);
      expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(executionCountBefore);
      expect(owner(ctx)).toEqual(before);
      expect(ctx.status.current().status).toBe("opening_reset");
      expect(ctx.ledger.lastTransactionId()).toBe(lastTxBefore);
      expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    });

    it("opening_execution_id・opening_actor_idが両方NULL(status='opening_reset'なのにownerが一度も確定していない)場合、新規acquireへ逃げず不変条件違反で止まる", async () => {
      const ctx = setup();
      seedLegacy(ctx);
      writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
      // beginOpeningReset()だけを呼び、acquire/bindは一切行わない
      // (`apply()`自身のR0はstatus遷移とacquire+bindを単一transactionで行うため、
      //  正しく動作しているシステムではこの状態は本来観測されないはず。ここではその
      //  「あり得ないはずの中間状態」を直接注入して、fail-closedになることを確認する)
      ctx.status.beginOpeningReset("テスト", "admin");
      const before = owner(ctx);
      expect(before).toEqual({ opening_execution_id: null, opening_actor_id: null });
      const executionCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;
      expect(executionCountBefore).toBe(0);
      const lastTxBefore = ctx.ledger.lastTransactionId();

      const backup = new FakeOpeningBackupAdapter();
      const external = new FakeOpeningExternalAdapter();
      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);

      expect(backup.calls).toHaveLength(0);
      expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(0);
      expect(owner(ctx)).toEqual(before);
      expect(ctx.status.current().status).toBe("opening_reset");
      expect(ctx.ledger.lastTransactionId()).toBe(lastTxBefore);
      expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    });
  });

  it("F(回帰): 同じplan hashでの正常resumeは引き続き成功する(backup失敗→再試行で完了)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    ctx.status.beginOpeningReset("テスト", "admin");
    // status='opening_reset'ならownerは必ず完全にbind済みであるべき（PR12監査続き）なので、
    // ここでもacquire+bindしてから最初のapply()を呼ぶ。
    const initialPlan = ctx.planner.dryRun();
    const initialExecution = ctx.reset.executionStore.acquire(initialPlan.planHash, "admin", initialPlan.snapshot.configuration).execution;
    ctx.status.bindOpeningExecutionOwner(initialExecution.id, "admin");
    const failingBackup = new FakeOpeningBackupAdapter({ fail: true });
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin", backup: failingBackup, external })).rejects.toThrow();
    const oldExecutionId = owner(ctx).opening_execution_id!;

    // configは変えない(=同じplan hash)
    const result = await ctx.reset.apply({ actorId: "admin", backup: persistentBackupAdapter(), external });
    expect(result.status).toBe("completed");
    // 同じexecutionがそのままresumeされている(新規executionは作られない)
    expect(result.executionId).toBe(oldExecutionId);
  });
});
