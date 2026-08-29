import { openDb } from "../../src/db/bootstrap.js";
import { EventLog } from "../../src/events/service.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { Shop } from "../../src/shop/service.js";

/**
 * 返金の決着と失効の巡回を、**別プロセス・別DB接続**からぶつけるための実行体。
 *
 * 同一プロセスだと better-sqlite3 は同期なので実質直列になり、
 * 「claim を解放した直後・返金の transaction を取る前」に失効が入る、という
 * 本当に危ない交錯を確かめたことにならない。
 */
interface RunnerInput {
  dbPath: string;
  job: "settle" | "expire";
  purchaseId: number;
  claimToken: string;
  startAt: number;
  /** 返金そのものを失敗させる（義務が立つ側の分岐を作る） */
  breakLedger?: boolean;
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
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  if (input.breakLedger) {
    (ledger as unknown as { transfer: unknown }).transfer = () => {
      throw new Error("ledger unavailable");
    };
  }
  sleepUntil(input.startAt);
  try {
    if (input.job === "settle") {
      const result = shop.settleVerifiedFailure({
        purchaseId: input.purchaseId,
        claimToken: input.claimToken,
        reason: "delivery_failed",
        actor: input.actor,
      });
      process.stdout.write(`${JSON.stringify({ outcome: "ok", job: "settle", result })}\n`);
    } else {
      // 巡回が何度も走る状況を作る（claim解放の直後を狙う）
      let last: unknown = null;
      for (let i = 0; i < 400; i += 1) last = shop.expireIfDue(input.purchaseId, input.actor);
      process.stdout.write(`${JSON.stringify({ outcome: "ok", job: "expire", result: last })}\n`);
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
