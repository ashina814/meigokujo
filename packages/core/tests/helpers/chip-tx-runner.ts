import { openDb } from "../../src/db/bootstrap.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { EventLog } from "../../src/events/service.js";
import { ChipTx } from "../../src/casino/chip-tx.js";
import { ChipLedger } from "../../src/casino/exchange.js";

/**
 * 別プロセスから**本番コードそのもの**（openDb / ChipTx / ChipLedger.runGroup）で
 * 同じ業務グループを実行する。複数接続での競合を、テスト用の写しではなく実物で確かめるため。
 *
 * 引数は JSON1つ。結果は JSON1行を標準出力へ返す。
 */
interface RunnerInput {
  dbPath: string;
  groupKey: string;
  kind: string;
  actorId: string;
  from: string;
  to: string;
  amount: number;
  reason: string;
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
  const chipTx = new ChipTx(db);
  const ether = new ChipLedger(db, new Ledger(db), new EventLog(db), { chipTx });

  sleepUntil(input.startAt);

  let outcome: "executed" | "replayed" | "error" = "error";
  let payload: unknown = null;
  let error: string | null = null;
  try {
    // 本体が動いたかどうかで「自分が実行した / 保存済み結果を受け取った」を判定する
    let executedHere = false;
    payload = ether.runGroup({ groupKey: input.groupKey, kind: input.kind, actorId: input.actorId }, () => {
      executedHere = true;
      ether.transfer(input.from, input.to, input.amount, { reason: input.reason });
      return { moved: input.amount };
    });
    outcome = executedHere ? "executed" : "replayed";
  } catch (e) {
    error = e instanceof Error ? `${e.name}:${e.message}` : String(e);
  } finally {
    db.close();
  }

  process.stdout.write(JSON.stringify({ outcome, payload, error }) + "\n");
}

main();
