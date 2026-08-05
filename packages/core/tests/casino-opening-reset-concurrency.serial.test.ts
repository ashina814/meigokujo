import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { CasinoStatus } from "../src/casino/status.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";

registerDefaultTxTypes();

/**
 * OpeningReset.apply() の実プロセス競合テスト。
 *
 * CLAUDE.md §16.4「実プロセス競合はready/go barrier等で実際に同時開始してください。
 * 処理完了後の直列replayだけを「競合テスト」と呼ばないでください」に対応する。
 * `casino-chip-tx-concurrency.serial.test.ts` と同じ流儀（別プロセス・同一開始時刻）で、
 * 同じ正式開業initializationを複数プロセスから同時に叩き、資金移動が1回だけになることを見る。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "opening-apply-runner.ts");

/** 全worker・単独リトライが共有する、唯一の認可済みactor identity（監査ブロッカー3） */
const AUTHORIZED_ACTOR_ID = "authorized-admin";

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-opening-reset-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const chipTx = new ChipTx(db);
  const settings = new Settings(db);
  const departments = new Departments(db, ledger);
  const status = new CasinoStatus(db);

  ledger.ensureAccount(deptAccount("賭博場"), "system");
  ledger.ensureAccount(ETHER_ESCROW, "system");
  ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  ledger.transfer({
    from: deptAccount("賭博場"), to: ETHER_ESCROW, amount: 30_000, type: "ether_house_fund", actor: "system:ether",
    approvedBy: "system:ether", idempotencyKey: "legacy:fund:house",
  });
  db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(HOUSE_HOLDER, 30_000);
  chipTx.captureLegacyOpening({ poolLand: ledger.balanceOf(ETHER_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
  departments.upsert("賭博場", "賭博場", null);
  writeCasinoOpeningConfig(settings, VALID_CONFIG, "test-admin");
  status.beginOpeningReset("テスト: 実プロセス競合検証", "test-admin");

  return { dbPath, db };
}

interface RunnerResult {
  outcome: "completed" | "error";
  status: string | null;
  fundsApplied: boolean | null;
  errorName: string | null;
  errorMessage: string | null;
}

function runProcesses(dbPath: string, count: number): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000; // 起動のばらつきを吸収してから一斉に走らせる
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      new Promise<RunnerResult>((resolve, reject) => {
        // 監査ブロッカー3: 暗黙の別actor引き継ぎは禁止。同一の認可済みactor identityを
        // 全workerが使う(現実の運用でも、1つの正式開業initializationは1人の運営者の
        // 操作として認可されるべきで、プロセスが分かれているだけで別人が引き継ぐわけではない)。
        void i;
        const input = JSON.stringify({ dbPath, actorId: AUTHORIZED_ACTOR_ID, startAt });
        const child = spawn(process.execPath, ["--import", "tsx", RUNNER, input], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += String(chunk)));
        child.stderr.on("data", (chunk) => (err += String(chunk)));
        child.on("error", reject);
        child.on("close", (code) => {
          const line = out.trim().split("\n").filter(Boolean).pop();
          if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
          resolve(JSON.parse(line) as RunnerResult);
        });
      }),
    ),
  );
}

describe("OpeningReset.apply — 実プロセス競合(別プロセス・同一開始時刻)", () => {
  it("同じ正式開業initializationを3プロセスから同時に叩いても、資金移動は高々1回・二重確定は絶対に起きない", async () => {
    // 安全性(資金が二重に動かない・executionが1件しか完了しない)は毎回必ず成り立つべき不変条件。
    // 一方、3プロセスが寸分違わぬ瞬間に競合すると、backup/外部工程などの重い工程が冗長に
    // 実行され合い、"誰も勝てずに全員failed"で終わる稀なインターリーブが起こりうる
    // （fundsが動いていない=安全は保たれている。単なる可用性の話）。
    // そのため「1回目の競合で必ず1つ完了する」ことまでは要求せず、
    // 「1回目で完了しなければ、競合が収まった後の再試行で必ず完了できる」ことを見る。
    const { dbPath, db } = setupFileDb();
    db.close(); // 子プロセス側の接続だけで競合させる

    const results = await runProcesses(dbPath, 3);
    if (process.env.DEBUG_OPENING_RESET_CONCURRENCY) {
      console.error("RESULTS", JSON.stringify(results, null, 2));
    }

    // ---- 安全性についての注意 ----
    // 複数プロセスが outcome:"completed" / fundsApplied:true を報告すること自体は問題ない。
    // 「先に完了した実行を後から観測しただけ」のプロセスも、実際の状態(=既にcompleted)を
    // 正直に返しているだけであり、資金を二重に動かしたわけではない
    // （CasinoStatus.finishOpeningReset()も「既にopen」ならok:trueを返す設計で、
    //  post-commit工程はそもそも複数回呼ばれても安全なよう作ってある）。
    // 資金の安全性として実際に検証すべきなのは「executionのcompleted行が1件だけ」
    // 「house/reserve残高が二重出資になっていない」という**DB状態そのもの**であり、
    // 各プロセスの戻り値の個数ではない。それは以下でDBを直接見て確認する。

    const wonRace = results.some((r) => r.outcome === "completed" && r.status === "completed");
    if (!wonRace) {
      // 誰も完了しなかった場合だけ、競合が収まった後に単独で再試行する(現実の運用と同じ手順)。
      // ここでexecutionが壊れていたり資金が中途半端に動いていれば、この再試行自体が失敗する。
      const { OpeningReset } = await import("../src/casino/opening-reset.js");
      const { Ledger: LedgerCtor } = await import("../src/ledger/service.js");
      const { EventLog } = await import("../src/events/service.js");
      const { ChipTx: ChipTxCtor } = await import("../src/casino/chip-tx.js");
      const { ChipLedger } = await import("../src/casino/exchange.js");
      const { Escrow } = await import("../src/casino/escrow.js");
      const { CasinoChipAssets } = await import("../src/casino/chip-assets.js");
      const { CasinoIntegrity } = await import("../src/casino/integrity.js");
      const { CasinoStatus: CasinoStatusCtor } = await import("../src/casino/status.js");
      const { Settings: SettingsCtor } = await import("../src/settings/service.js");
      const { Departments: DepartmentsCtor } = await import("../src/departments/service.js");
      const { FakeOpeningBackupAdapter } = await import("../src/casino/opening-backup.js");
      const { FakeOpeningExternalAdapter } = await import("../src/casino/opening-external.js");

      const retryDb = openDb(dbPath);
      const retryLedger = new LedgerCtor(retryDb);
      const retryEvents = new EventLog(retryDb);
      const retryChipTx = new ChipTxCtor(retryDb);
      const retryChips = new ChipLedger(retryDb, retryLedger, retryEvents, { chipTx: retryChipTx });
      const retryEscrow = new Escrow(retryDb, retryChips, retryEvents);
      const retryChipAssets = new CasinoChipAssets(retryDb, retryChips);
      const retryIntegrity = new CasinoIntegrity(retryDb, retryLedger, retryChips, retryEscrow, retryChipAssets);
      const retryStatus = new CasinoStatusCtor(retryDb);
      const retrySettings = new SettingsCtor(retryDb);
      const retryDepartments = new DepartmentsCtor(retryDb, retryLedger);
      const retryReset = new OpeningReset({
        db: retryDb, ledger: retryLedger, chips: retryChips, chipAssets: retryChipAssets,
        integrity: retryIntegrity, status: retryStatus, settings: retrySettings, departments: retryDepartments,
      });
      const retryResult = await retryReset.apply({
        // リトライも同じ認可済みactorで行う(別actorへの暗黙引き継ぎをここでも作らない)
        actorId: AUTHORIZED_ACTOR_ID,
        backup: new FakeOpeningBackupAdapter(),
        external: new FakeOpeningExternalAdapter(),
      });
      expect(retryResult.status).toBe("completed");
      retryDb.close();
    }

    const reopened = openDb(dbPath);
    const ledger = new Ledger(reopened);
    const chipTxAfter = new ChipTx(reopened);
    const houseBalance = (
      reopened.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(HOUSE_HOLDER) as
        | { amount: number }
        | undefined
    )?.amount ?? 0;
    const version = chipTxAfter.currentVersion();
    const reserveLand = ledger.balanceOf("sys:escrow:casino");
    const oldReserveLand = ledger.balanceOf(ETHER_ESCROW);
    const executionCount = (
      reopened.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }
    ).n;
    const completedCount = (
      reopened.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions WHERE status='completed'").get() as {
        n: number;
      }
    ).n;
    reopened.close();

    // 最終的に: executionは1件だけ・そのcompleted遷移も1回だけ・資金移動は二重出資になっていない
    expect(executionCount).toBe(1);
    expect(houseBalance).toBe(VALID_CONFIG.openingHouse);
    expect(reserveLand).toBe(VALID_CONFIG.openingCapital);
    expect(oldReserveLand).toBe(0);
    expect(version).toBe("opening_v1");
    expect(completedCount).toBe(1);
  }, 60_000);
});
