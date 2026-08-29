import { openDb } from "../../src/db/bootstrap.js";
import { EventLog } from "../../src/events/service.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { Shop, type StockReconciliationMode } from "../../src/shop/service.js";

/**
 * 同じ在庫変更の確認を、別プロセスから同じ瞬間に確定させるための実行体。
 *
 * 同一プロセスだと better-sqlite3 は同期なので実質直列になり、「二重に押されたら
 * どうなるか」を確かめたことにならない。
 */
interface RunnerInput {
  dbPath: string;
  itemId: number;
  requestedStock: number | null;
  reconciliationMode: StockReconciliationMode;
  expectedToken: string;
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
    const result = shop.applyStockChange({
      itemId: input.itemId,
      requestedStock: input.requestedStock,
      reconciliationMode: input.reconciliationMode,
      expectedToken: input.expectedToken,
      actor: input.actor,
    });
    process.stdout.write(`${JSON.stringify({ outcome: "ok", newStock: result.newStock, settled: result.settledQuantity })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        outcome: "error",
        code: (error as { code?: string }).code ?? null,
        error: (error as Error).message,
      })}\n`,
    );
  } finally {
    db.close();
  }
}

main();
