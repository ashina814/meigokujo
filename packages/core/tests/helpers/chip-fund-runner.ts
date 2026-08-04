import { openDb } from "../../src/db/bootstrap.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { EventLog } from "../../src/events/service.js";
import { ChipTx } from "../../src/casino/chip-tx.js";
import { ChipLedgerCore } from "../../src/casino/exchange.js";
import { HouseReservations } from "../../src/casino/reservations.js";
import { HOUSE_HOLDER } from "../../src/casino/exchange.js";

/**
 * 別プロセスから**本番の資金API**（deposit / redeem / fundFromAccount / redeemToAccount）を
 * 同じ瞬間に叩く（PR8監査・項目14）。
 *
 * 同一プロセス・同一接続では better-sqlite3 が同期なので実質直列になり、
 * 「別接続が割り込んだらどうなるか」を確かめたことにならない。ここでは一時ファイルDBに対し、
 * 実物のコードを複数プロセスで走らせる。引数は JSON 1つ、結果は JSON 1行。
 */
export type FundOp = "deposit" | "redeem" | "fund" | "settle" | "reserve";

interface RunnerInput {
  dbPath: string;
  op: FundOp;
  /** deposit/redeem は利用者、fund/settle は holder、reserve は予約キー */
  subject: string;
  amount: number;
  idempotencyKey: string;
  account?: string;
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
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedgerCore(db, new Ledger(db), events, { chipTx });
  const reservations = new HouseReservations(db, chips as never, events);
  // 売上精算は「残高 − 予約」しか出せない（PR5）。別プロセスでも同じ配線にしておかないと、
  // 予約と精算が競合したときの本番の振る舞いを再現できない
  chips.setReservedProvider((h) => (h === HOUSE_HOLDER ? reservations.totalReserved() : 0));

  sleepUntil(input.startAt);

  let outcome: "ok" | "error" = "error";
  let payload: unknown = null;
  let error: string | null = null;
  let code: string | null = null;
  try {
    switch (input.op) {
      case "deposit":
        payload = chips.deposit(input.subject, input.amount, input.idempotencyKey);
        break;
      case "redeem":
        payload = chips.redeem(input.subject, input.amount, input.idempotencyKey);
        break;
      case "fund":
        payload = chips.fundFromAccount(input.account!, input.amount, input.subject, input.idempotencyKey);
        break;
      case "settle":
        payload = chips.redeemToAccount(input.subject, input.amount, input.account!, "system:test", input.idempotencyKey);
        break;
      case "reserve":
        payload = reservations.reserve(input.idempotencyKey, input.amount, "スロット", input.subject);
        break;
    }
    outcome = "ok";
  } catch (e) {
    error = e instanceof Error ? `${e.name}:${e.message}` : String(e);
    code = (e as { code?: string }).code ?? null;
  } finally {
    db.close();
  }

  process.stdout.write(JSON.stringify({ outcome, payload, error, code }) + "\n");
}

main();
