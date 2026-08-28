import { openDb } from "../../src/db/bootstrap.js";
import { EventLog } from "../../src/events/service.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { Shop } from "../../src/shop/service.js";

/**
 * 返金と手動完了を、別プロセスから同じ瞬間に叩くための実行体。
 *
 * 同一プロセスだと better-sqlite3 は同期なので実質直列になり、「同時に来たらどうなるか」を
 * 確かめたことにならない。
 */
interface RunnerInput {
  dbPath: string;
  job: "refund" | "complete";
  purchaseId: number;
  startAt: number;
  actor: string;
}

function sleepUntil(startAt: number): void {
  const waitMs = startAt - Date.now();
  if (waitMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
}

function main(): void {
  const input = JSON.parse(process.argv[2] ?? "{}") as RunnerInput;
  registerDefaultTxTypes();
  const db = openDb(input.dbPath);
  const shop = new Shop(db, new Ledger(db), new EventLog(db));
  sleepUntil(input.startAt);
  try {
    if (input.job === "refund") {
      const result = shop.refund(input.purchaseId, "concurrent refund", input.actor);
      process.stdout.write(`${JSON.stringify({ outcome: "ok", job: "refund", ...result })}\n`);
    } else {
      const result = shop.completeManualDelivery(input.purchaseId, input.actor);
      process.stdout.write(`${JSON.stringify({ outcome: "ok", job: "complete", ...result })}\n`);
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        outcome: "error",
        job: input.job,
        code: (error as { code?: string }).code ?? null,
        error: (error as Error).message,
      })}\n`,
    );
  } finally {
    db.close();
  }
}

main();
