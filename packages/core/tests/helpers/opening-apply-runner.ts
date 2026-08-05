import { openDb } from "../../src/db/bootstrap.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { EventLog } from "../../src/events/service.js";
import { ChipTx } from "../../src/casino/chip-tx.js";
import { ChipLedger } from "../../src/casino/exchange.js";
import { Escrow } from "../../src/casino/escrow.js";
import { CasinoChipAssets } from "../../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../../src/casino/integrity.js";
import { CasinoStatus } from "../../src/casino/status.js";
import { Settings } from "../../src/settings/service.js";
import { Departments } from "../../src/departments/service.js";
import { OpeningReset } from "../../src/casino/opening-reset.js";
import { FakeOpeningBackupAdapter } from "../../src/casino/opening-backup.js";
import { FakeOpeningExternalAdapter } from "../../src/casino/opening-external.js";

/**
 * 別プロセスから**本番コードそのもの**（OpeningReset.apply）で正式開業初期化を同時に叩く。
 * `casino-chip-tx-concurrency.serial.test.ts` と同じ流儀（sleepUntilバリア）。
 *
 * 引数は JSON1つ。結果は JSON1行を標準出力へ返す。
 */
interface RunnerInput {
  dbPath: string;
  actorId: string;
  /** 全プロセスを同じ瞬間に走らせるための開始時刻（epoch ms） */
  startAt: number;
}

interface RunnerResult {
  outcome: "completed" | "error";
  status: string | null;
  fundsApplied: boolean | null;
  errorName: string | null;
  errorMessage: string | null;
}

function sleepUntil(startAt: number): void {
  const waitMs = startAt - Date.now();
  if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? "{}") as RunnerInput;
  registerDefaultTxTypes();
  const db = openDb(input.dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  const chipAssets = new CasinoChipAssets(db, chips);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, chipAssets);
  const status = new CasinoStatus(db);
  const settings = new Settings(db);
  const departments = new Departments(db, ledger);
  const reset = new OpeningReset({ db, ledger, chips, chipAssets, integrity, status, settings, departments });

  sleepUntil(input.startAt);

  let result: RunnerResult;
  try {
    const applyResult = await reset.apply({
      actorId: input.actorId,
      backup: new FakeOpeningBackupAdapter(),
      external: new FakeOpeningExternalAdapter(),
    });
    result = {
      outcome: "completed",
      status: applyResult.status,
      fundsApplied: applyResult.fundsApplied,
      errorName: null,
      errorMessage: null,
    };
  } catch (e) {
    result = {
      outcome: "error",
      status: null,
      fundsApplied: null,
      errorName: e instanceof Error ? e.name : "Unknown",
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  } finally {
    db.close();
  }

  process.stdout.write(JSON.stringify(result) + "\n");
}

main();
