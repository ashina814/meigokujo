import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, FORMAL_OPENING_VERSION, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, CHIP_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { CASINO_DEPARTMENT_ACCOUNT, OpeningPlanner } from "../src/casino/opening-plan.js";
import { OpeningReset, type OpeningResetCrashPoint } from "../src/casino/opening-reset.js";
import { TestFilesystemOpeningBackupAdapter } from "../src/casino/opening-backup.js";
import { tableExists } from "../src/casino/opening-canonical.js";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";

registerDefaultTxTypes();

/**
 * `OpeningReset.apply()` の全crash injection地点を網羅する（CLAUDE.md監査ブロッカー9）。
 *
 * COMMIT前（`before_commit`まで）の地点は、どこでcrashしても呼出前の状態へ完全に
 * ROLLBACKされることを確認する。COMMIT後の地点は、資金がCOMMIT済みのまま維持され、
 * post-commit工程（reopen/completed/notifier）だけが安全に再試行できることを確認する。
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
  return { db, ledger, events, chipTx, ether, escrow, chipAssets, integrity, status, settings, departments, reset };
}

type Ctx = ReturnType<typeof setup>;

function seedLegacy(ctx: Ctx, opts: { houseChips?: number; deptSeed?: number } = {}): void {
  const houseChips = opts.houseChips ?? 30_000;
  const deptSeed = opts.deptSeed ?? 100_000;
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: deptSeed, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  if (houseChips > 0) {
    ctx.ledger.transfer({
      from: deptAccount("賭博場"), to: ETHER_ESCROW, amount: houseChips, type: "ether_house_fund", actor: "system:ether",
      approvedBy: "system:ether", idempotencyKey: "legacy:fund:house",
    });
    ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(HOUSE_HOLDER, houseChips);
  }
  ctx.chipTx.captureLegacyOpening({
    poolLand: ctx.ledger.balanceOf(ETHER_ESCROW),
    fromLedgerTxId: ctx.ledger.lastTransactionId(),
  });
  ctx.departments.upsert("賭博場", "賭博場", null);
}

/**
 * status='opening_reset' へ進めるだけでなく、owner（execution/actor）も同時にbindする
 * （PR12監査: owner-first resume。R0は「status='opening_reset'ならownerは必ず完全にbind
 * 済み」を前提にしたため、`beginOpeningReset()`単独呼び出しだけでは不変条件違反になる）。
 */
function configureAndOpenReset(ctx: Ctx, actorId = "admin"): void {
  writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
  ctx.status.beginOpeningReset("テスト: 開業初期化準備", "test-admin");
  const plan = new OpeningPlanner({ ...ctx, chips: ctx.ether }).dryRun();
  const execution = ctx.reset.executionStore.acquire(plan.planHash, actorId, plan.snapshot.configuration).execution;
  ctx.status.bindOpeningExecutionOwner(execution.id, actorId);
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function persistentBackupAdapter(): TestFilesystemOpeningBackupAdapter {
  const dir = mkdtempSync(join(tmpdir(), "pr12-crash-injection-test-"));
  tempDirs.push(dir);
  return new TestFilesystemOpeningBackupAdapter(dir);
}

function adapters() {
  return { backup: persistentBackupAdapter(), external: new FakeOpeningExternalAdapter() };
}

/**
 * R6対象・Land・資金・opening metadataのスナップショット（監査ブロッカー9）。
 *
 * `casino_opening_executions`行はここに**含めない**: execution行自体は破壊的
 * transactionの外側（acquire・backup・external各段階）で個別にCOMMITされる設計であり、
 * 失敗時は`apply()`の catch が`status='failed'`へ倒す別の小さなtransactionを発行する
 * （これは正しいresume設計であって「呼出前に戻っていない」バグではない）。
 * execution行については`assertNoFundsApplied`で「fundsApplied=falseかつapplied/completed
 * に達していない」ことを別途チェックする。
 */
function snapshotAll(ctx: Ctx) {
  return {
    casinoTxRows: ctx.db.prepare("SELECT * FROM casino_tx ORDER BY id").all(),
    casinoTxGroupsRows: ctx.db.prepare("SELECT * FROM casino_tx_groups ORDER BY group_key").all(),
    casinoTxSeq: ctx.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='casino_tx'").get() ?? null,
    etherBalancesRows: ctx.db.prepare("SELECT * FROM ether_balances ORDER BY user_id").all(),
    etherEscrow: ctx.ledger.balanceOf(ETHER_ESCROW),
    department: ctx.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT),
    chipEscrow: ctx.ledger.balanceOf(CHIP_ESCROW),
    openingVersionRows: ctx.db.prepare("SELECT * FROM casino_chip_opening_versions ORDER BY opening_version").all(),
    openingBalanceRows: ctx.db
      .prepare("SELECT * FROM casino_chip_opening_balances ORDER BY opening_version, holder")
      .all(),
    currentVersion: ctx.chipTx.currentVersion(),
    settingsRows: ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'casino_opening%' ORDER BY key").all(),
    casinoStatus: ctx.status.current().status,
    // R6対象テーブルの代表。schemaFingerprint等で全体のtable set不変は別途確認済みなので、
    // ここではpreflightに存在するテーブルのみ安全に照合する
    escrowRows: tableExists(ctx.db, "casino_escrow")
      ? ctx.db.prepare("SELECT * FROM casino_escrow ORDER BY session_id").all()
      : null,
  };
}

/** execution行が「資金確定に達していない」ことを確認する（COMMIT前crashの必須条件） */
function assertNoFundsApplied(ctx: Ctx): void {
  const row = ctx.db
    .prepare("SELECT status, funds_applied, postflight_json FROM casino_opening_executions ORDER BY id DESC LIMIT 1")
    .get() as { status: string; funds_applied: number; postflight_json: string | null } | undefined;
  if (!row) return; // まだexecution行自体が無い段階でcrashした場合(before_r6より前はここに来ない想定だが念のため)
  expect(row.status).not.toBe("applied");
  expect(row.status).not.toBe("completed");
  expect(row.funds_applied).toBe(0);
  expect(row.postflight_json).toBeNull();
}

// 全てのCOMMIT前crash地点（R6開始前 〜 COMMIT直前）。この地点でcrashしても、
// R6〜R13で行った変更が全部ROLLBACKされ、呼出前の状態と完全に一致することを見る。
const PRE_COMMIT_POINTS: OpeningResetCrashPoint[] = [
  "before_r6",
  "r6_after_delete",
  "after_r6",
  "before_r7",
  "after_r7_transfer",
  "before_r8",
  "after_r8_transfer",
  "after_casino_tx_delete",
  "after_casino_tx_groups_delete",
  "after_sqlite_sequence_delete",
  "after_ether_balances_delete",
  "after_house_holder_created",
  "after_jackpot_holder_created",
  "after_relief_holder_created",
  "after_opening_v1_captured",
  "v1",
  "v2",
  "v3",
  "v4",
  "v5",
  "v6",
  "v7",
  "before_applied_cas",
  "after_applied_cas",
  "before_commit",
];

describe("OpeningReset.apply — crash injection: COMMIT前の全地点(監査ブロッカー9)", () => {
  it.each(PRE_COMMIT_POINTS)("%sでcrashすると、呼出前の状態へ完全にROLLBACKされる", async (point) => {
    const ctx = setup();
    seedLegacy(ctx, { houseChips: 30_000, deptSeed: 100_000 });
    configureAndOpenReset(ctx);
    const before = snapshotAll(ctx);

    ctx.reset.__setCrashHookForTesting((firedPoint) => {
      if (firedPoint === point) throw new Error(`crash injection: ${point}`);
    });

    const { backup, external } = adapters();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow();

    ctx.reset.__setCrashHookForTesting(null);
    const after = snapshotAll(ctx);
    expect(after).toEqual(before);
    assertNoFundsApplied(ctx);
    expect(after.currentVersion).toBe(LEGACY_OPENING_VERSION);
  });

  it("before_commitでcrashした後、crash hookを外せば同じplanで最初から正常完了する", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.reset.__setCrashHookForTesting((point) => {
      if (point === "before_commit") throw new Error("crash injection: before_commit");
    });
    const { backup, external } = adapters();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow();

    ctx.reset.__setCrashHookForTesting(null);
    const result = await ctx.reset.apply({ actorId: "admin", backup, external });
    expect(result.status).toBe("completed");
    expect(ctx.chipTx.currentVersion()).toBe(FORMAL_OPENING_VERSION);
  });
});

// 全てのCOMMIT後crash地点。この地点でcrashしても、R6〜R10・opening_v1
// captureは再実行されず、fundsApplied=true・reapplyAllowed=falseを維持したまま、
// post-commit工程だけを再試行できることを見る。
const POST_COMMIT_POINTS: OpeningResetCrashPoint[] = [
  "after_commit",
  "before_post_commit_pending",
  "after_post_commit_pending",
  "before_reopen",
  "after_reopen",
  "before_completed",
  "after_completed",
  "before_notifier",
  "after_notifier",
];

describe("OpeningReset.apply — crash injection: COMMIT後の全地点(監査ブロッカー9)", () => {
  it.each(POST_COMMIT_POINTS)(
    "%sでcrashしても資金はCOMMIT済みのまま維持され、post-commit工程だけ再試行できる",
    async (point) => {
      const ctx = setup();
      seedLegacy(ctx, { houseChips: 30_000, deptSeed: 100_000 });
      configureAndOpenReset(ctx);
      const { backup, external } = adapters();

      ctx.reset.__setCrashHookForTesting((firedPoint) => {
        if (firedPoint === point) throw new Error(`crash injection: ${point}`);
      });

      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow();

      // COMMIT済みの資金はそのまま: R6〜R10は再実行されない・fundsAppliedは維持される
      expect(ctx.chipTx.currentVersion()).toBe(FORMAL_OPENING_VERSION);
      expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(VALID_CONFIG.openingHouse);
      expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(VALID_CONFIG.openingJackpot);
      expect(ctx.ether.balanceOf(RELIEF_HOLDER)).toBe(VALID_CONFIG.openingRelief);
      expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(VALID_CONFIG.openingCapital);
      expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);
      const midExecution = ctx.db
        .prepare("SELECT funds_applied, reapply_allowed FROM casino_opening_executions ORDER BY id DESC LIMIT 1")
        .get() as { funds_applied: number; reapply_allowed: number };
      expect(midExecution.funds_applied).toBe(1);
      expect(midExecution.reapply_allowed).toBe(0);
      const landAfterCrash = {
        etherEscrow: ctx.ledger.balanceOf(ETHER_ESCROW),
        department: ctx.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT),
        chipEscrow: ctx.ledger.balanceOf(CHIP_ESCROW),
      };
      const casinoTxCountAfterCrash = (
        ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }
      ).n;
      const statusAfterCrash = ctx.db
        .prepare("SELECT status FROM casino_opening_executions ORDER BY id DESC LIMIT 1")
        .get() as { status: string };

      ctx.reset.__setCrashHookForTesting(null);
      if (statusAfterCrash.status === "completed") {
        // "after_completed" / "before_notifier" / "after_notifier" は、crashが起きた時点で
        // 既にexecution行がcompletedへ達している(notifierはPR12では常にpendingのまま・
        // 資金applyに影響しない残り作業でしかない)。この場合、二重開業防止の仕組みが
        // 正しく働き、素直な再applyはblockerで拒否されるのが正しい挙動
        // (「二重開業防止」describe blockの既存テストと同じ扱い)。
        await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow();
      } else {
        // crash hookを外して再試行すると、post-commit工程だけが完了する
        // (R6〜R10・opening_v1 captureが再実行されていれば、Landや残高がここでズレるはず)
        const retryResult = await ctx.reset.apply({ actorId: "admin", backup, external });
        expect(retryResult.status).toBe("completed");
        expect(retryResult.casinoReopened).toBe(true);
      }
      expect(ctx.status.current().status).toBe("open");

      // 再試行後もLand・casino_txはcrash直後と一切変わっていない(R6〜R10が二重実行されていない)
      expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(landAfterCrash.etherEscrow);
      expect(ctx.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)).toBe(landAfterCrash.department);
      expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(landAfterCrash.chipEscrow);
      expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n).toBe(
        casinoTxCountAfterCrash,
      );
      expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(VALID_CONFIG.openingHouse);

      const finalExecution = ctx.db
        .prepare("SELECT funds_applied, reapply_allowed, status FROM casino_opening_executions ORDER BY id DESC LIMIT 1")
        .get() as { funds_applied: number; reapply_allowed: number; status: string };
      expect(finalExecution.status).toBe("completed");
      expect(finalExecution.funds_applied).toBe(1);
      expect(finalExecution.reapply_allowed).toBe(0);
    },
  );
});
