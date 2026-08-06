import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { OpeningExecutionConflictError } from "../src/casino/opening-execution.js";
import { OpeningReset } from "../src/casino/opening-reset.js";
import { FakeOpeningBackupAdapter, TestFilesystemOpeningBackupAdapter } from "../src/casino/opening-backup.js";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

registerDefaultTxTypes();

/**
 * PR12監査ブロッカーB: opening_reset取得の完全原子化。
 *
 * `apply()`のR0（status遷移・execution確定・casino_status.opening_execution_id/opening_actor_id
 * へのbind）が単一のIMMEDIATE transactionへ統合されたことを、次の観点で検証する:
 * - 正常系: bind完了後、casino_statusから所有execution/actorが機械的に読める
 * - 別actor: 資金・status・executionのいずれも変更されない
 * - 別configuration: 同上
 * - R0途中でcrash: statusの遷移も含めて完全にROLLBACKされる(owner不明状態にならない)
 */

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

const OTHER_CONFIG = {
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
  return { db, ledger, events, chipTx, ether, escrow, chipAssets, integrity, status, settings, departments, reset };
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

function owner(ctx: Ctx): { opening_execution_id: string | null; opening_actor_id: string | null } {
  return ctx.db.prepare("SELECT opening_execution_id, opening_actor_id FROM casino_status WHERE id = 1").get() as {
    opening_execution_id: string | null;
    opening_actor_id: string | null;
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function persistentBackupAdapter(): TestFilesystemOpeningBackupAdapter {
  const dir = mkdtempSync(join(tmpdir(), "pr12-owner-binding-test-"));
  tempDirs.push(dir);
  return new TestFilesystemOpeningBackupAdapter(dir);
}

describe("OpeningReset.apply — opening_reset所有権の原子的binding(PR12監査ブロッカーB)", () => {
  it("statusがopenからopening_resetへ進むのと同じtransactionでexecution/actorがbindされる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    expect(ctx.status.current().status).toBe("open");
    expect(owner(ctx)).toEqual({ opening_execution_id: null, opening_actor_id: null });

    // backupをわざと失敗させ、R0だけ完了させてR6より前で止める
    const backup = new FakeOpeningBackupAdapter({ fail: true });
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin-x", backup, external })).rejects.toThrow();

    expect(ctx.status.current().status).toBe("opening_reset");
    const bound = owner(ctx);
    expect(bound.opening_actor_id).toBe("admin-x");
    expect(bound.opening_execution_id).toMatch(/^opening-reset:/);

    const execRow = ctx.db.prepare("SELECT id, actor_id FROM casino_opening_executions WHERE id = ?").get(bound.opening_execution_id) as {
      id: string;
      actor_id: string;
    };
    expect(execRow.actor_id).toBe("admin-x");
  });

  it("別actorはresumeできない: 資金・status・executionを変更せずconflictになる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    const backup = new FakeOpeningBackupAdapter({ fail: true });
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin-x", backup, external })).rejects.toThrow();
    const before = owner(ctx);
    const executionCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;
    const historyCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_status_history").get() as { n: number }).n;

    await expect(ctx.reset.apply({ actorId: "admin-y", backup, external })).rejects.toThrow(OpeningExecutionConflictError);

    // 敗者(admin-y)は所有権・execution・statusのいずれも書き換えていない
    expect(owner(ctx)).toEqual(before);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(executionCountBefore);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_status_history").get() as { n: number }).n).toBe(historyCountBefore);
    expect(ctx.status.current().status).toBe("opening_reset");
  });

  it("別configurationでのresumeは、owner-first resumeにより旧executionがfailedへ記録された上で所有権が新plan executionへ原子的に移譲され、安全に再計画される（PR12監査: owner-first resume。旧仕様の「bindのCAS不一致で不変条件違反」は誤りだったため置き換え）", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    const backup = new FakeOpeningBackupAdapter({ fail: true });
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin-x", backup, external })).rejects.toThrow();
    const before = owner(ctx);
    const oldExecutionId = before.opening_execution_id!;
    const oldRowBefore = ctx.db
      .prepare("SELECT status, funds_applied FROM casino_opening_executions WHERE id = ?")
      .get(oldExecutionId) as { status: string; funds_applied: number };
    // backup失敗はcatch内でbackup_started->failedへ直接倒すので、この時点で既にfailed
    expect(oldRowBefore.status).toBe("failed");
    expect(oldRowBefore.funds_applied).toBe(0);

    // 同じactorだが別configurationへ書き換える(=別planHash=別execution id)。
    // 外部工程開始前(failed)なので、新仕様では安全に再計画され、新plan executionが
    // 最初から正常に完了できる(旧仕様のような永久デッドロックにならない)。
    writeCasinoOpeningConfig(ctx.settings, OTHER_CONFIG, "test-admin");
    const result = await ctx.reset.apply({ actorId: "admin-x", backup: persistentBackupAdapter(), external });

    expect(result.status).toBe("completed");
    expect(result.executionId).not.toBe(oldExecutionId);
    // 新configuration(OTHER_CONFIG)の金額で開業している(=現在のplan hashで再計画された証拠)
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(OTHER_CONFIG.openingHouse);

    // 旧executionは削除されず、failedのまま資金未確定で残る(監査記録として保持)
    const oldRowAfter = ctx.db
      .prepare("SELECT status, funds_applied FROM casino_opening_executions WHERE id = ?")
      .get(oldExecutionId) as { status: string; funds_applied: number };
    expect(oldRowAfter.status).toBe("failed");
    expect(oldRowAfter.funds_applied).toBe(0);

    // executionは旧(failed)・新(completed)の2件だけ
    const allExecutions = ctx.db.prepare("SELECT id, status FROM casino_opening_executions ORDER BY id").all() as Array<{
      id: string;
      status: string;
    }>;
    expect(allExecutions).toHaveLength(2);
    expect(allExecutions.map((e) => e.status).sort()).toEqual(["completed", "failed"]);

    // 所有権(casino_status)は最終的に新executionの完了によりクリアされている(R14)
    expect(ctx.status.current().status).toBe("open");
    expect(owner(ctx)).toEqual({ opening_execution_id: null, opening_actor_id: null });
  });

  it("R0途中(statusをopening_resetへ進めた直後・execution確定前)でcrashすると、statusの遷移も含めて完全にROLLBACKされる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    expect(ctx.status.current().status).toBe("open");
    const historyCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_status_history").get() as { n: number }).n;

    ctx.reset.__setCrashHookForTesting((point) => {
      if (point === "r0_after_status_flip") throw new Error("crash injection: r0_after_status_flip");
    });
    const backup = persistentBackupAdapter();
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin-x", backup, external })).rejects.toThrow();
    ctx.reset.__setCrashHookForTesting(null);

    // statusはopenへ完全に戻る(opening_resetへの遷移ごとROLLBACK)。owner不明状態にならない
    expect(ctx.status.current().status).toBe("open");
    expect(owner(ctx)).toEqual({ opening_execution_id: null, opening_actor_id: null });
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(0);
    // historyだけ残ることもない(rollbackなのでhistory行も増えていない)
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_status_history").get() as { n: number }).n).toBe(historyCountBefore);

    // crash hookを外せば同じactorで最初からやり直せる
    const retry = await ctx.reset.apply({ actorId: "admin-x", backup, external }).catch((e: unknown) => e);
    // backupが失敗しても構わない(ここではR0の再実行自体が正常に行えることだけ見る)
    expect(ctx.status.current().status === "opening_reset" || (retry as { status?: string })?.status === "completed").toBe(true);
  });

  it("R0途中(execution確定直後・所有権bind前)でcrashしても、statusの遷移・execution行ともに完全にROLLBACKされる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");

    ctx.reset.__setCrashHookForTesting((point) => {
      if (point === "r0_after_acquire") throw new Error("crash injection: r0_after_acquire");
    });
    const backup = persistentBackupAdapter();
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin-x", backup, external })).rejects.toThrow();
    ctx.reset.__setCrashHookForTesting(null);

    expect(ctx.status.current().status).toBe("open");
    expect(owner(ctx)).toEqual({ opening_execution_id: null, opening_actor_id: null });
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n).toBe(0);
  });

  it("R14(正式開業完了)後は所有権bindがクリアされる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    const backup = persistentBackupAdapter();
    const external = new FakeOpeningExternalAdapter();
    const result = await ctx.reset.apply({ actorId: "admin-x", backup, external });
    expect(result.status).toBe("completed");
    expect(ctx.status.current().status).toBe("open");
    expect(owner(ctx)).toEqual({ opening_execution_id: null, opening_actor_id: null });
  });
});
