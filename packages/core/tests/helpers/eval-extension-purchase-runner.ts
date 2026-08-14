import { openDb } from "../../src/db/bootstrap.js";
import { EventLog } from "../../src/events/service.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { Shop } from "../../src/shop/service.js";

interface RunnerInput {
  dbPath: string;
  itemId: number;
  userId: string;
  idempotencyKey: string;
  expected: { priceLand: number; cycleStartedAt: number; currentDeadlineAt: number; usedCount: number };
  startAt: number;
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
    const result = shop.purchaseEvaluationExtension({
      itemId: input.itemId,
      userId: input.userId,
      actor: `user:${input.userId}`,
      memberRoleIds: [],
      expected: input.expected,
      idempotencyKey: input.idempotencyKey,
    });
    process.stdout.write(`${JSON.stringify({ outcome: "ok", sequence: result.extension.sequence })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      outcome: "error",
      code: (error as { code?: string }).code ?? null,
      error: (error as Error).message,
    })}\n`);
  } finally {
    db.close();
  }
}

main();
