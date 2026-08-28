import { openDb } from "../../src/db/bootstrap.js";
import { EventLog } from "../../src/events/service.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { Shop } from "../../src/shop/service.js";

/**
 * generic購入契約の競合条件を、本番コードで別プロセスから同時に叩くための実行体。
 *
 * `job: "buy"`  … 表示時に受け取ったtokenのまま購入を試みる（利用者）
 * `job: "price"` … 同じ瞬間に商品を書き換える（運営）
 */
interface RunnerInput {
  dbPath: string;
  job: "buy" | "price";
  startAt: number;
  itemId: number;
  userId?: string;
  idempotencyKey?: string;
  expectedTermsToken?: string;
  priceLand?: number;
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
    if (input.job === "price") {
      shop.updateItem(input.itemId, { price_land: input.priceLand! }, "staff");
      process.stdout.write(`${JSON.stringify({ outcome: "ok", job: "price" })}\n`);
      return;
    }
    const result = shop.purchase({
      itemId: input.itemId,
      userId: input.userId!,
      actor: `user:${input.userId}`,
      memberRoleIds: [],
      expectedTermsToken: input.expectedTermsToken,
      idempotencyKey: input.idempotencyKey,
    });
    process.stdout.write(
      `${JSON.stringify({
        outcome: "ok",
        job: "buy",
        purchaseId: result.purchase.id,
        paidLand: result.purchase.paid_land,
      })}\n`,
    );
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
