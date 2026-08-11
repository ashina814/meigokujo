import { openDb } from "../../src/db/bootstrap.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { EventLog } from "../../src/events/service.js";
import { Shop } from "../../src/shop/service.js";

/**
 * 別プロセスから**本番の延長API**を同じ瞬間に叩く。
 *
 * 同一プロセス・同一接続では better-sqlite3 が同期なので実質直列になり、
 * 「同じ確認画面の確定ボタンを本当に同時に2回押した」を再現できない。
 * ここでは一時ファイルDBに対し、実物のコードを複数プロセスで走らせる。
 */
interface RunnerInput {
  dbPath: string;
  purchaseId: number;
  userId: string;
  /** 同じ確認画面から出た確定ボタンなら、全プロセスで同じ値になる */
  operationId: string;
  expected: { priceLand: number; days: number; expiresAt: number | null };
  /** 全プロセスを同じ瞬間に走らせるための開始時刻（epoch ms） */
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
    const result = shop.extend({
      purchaseId: input.purchaseId,
      userId: input.userId,
      actor: `user:${input.userId}`,
      operationId: input.operationId,
      memberRoleIds: [],
      expected: input.expected,
    });
    process.stdout.write(
      `${JSON.stringify({ outcome: "ok", extended: result.extended, expiresAt: result.purchase.expires_at })}\n`,
    );
  } catch (error) {
    const code = (error as { code?: string }).code ?? null;
    process.stdout.write(`${JSON.stringify({ outcome: "error", code, error: (error as Error).message })}\n`);
  } finally {
    db.close();
  }
}

main();
