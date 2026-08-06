import { openDb } from "../../src/db/bootstrap.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { EventLog } from "../../src/events/service.js";
import { ChipLedger } from "../../src/casino/exchange.js";
import { Markets, MarketError } from "../../src/casino/market.js";

/**
 * 別プロセスから**本番コードそのもの**（openDb / Markets.betEventLand /
 * reportAndSettleEventLand / adminVoidEventLand）でイベントLand板の操作を1回実行する。
 * 複数接続での競合を、テスト用の写しではなく実物で確かめるため
 * （`chip-tx-runner.ts` と同じ流儀）。
 *
 * 引数は JSON1つ。結果は JSON1行を標準出力へ返す。
 */
interface RunnerInput {
  dbPath: string;
  action: "bet" | "settle" | "void";
  marketId: number;
  userId: string;
  roleIds?: string[];
  optionIndex?: number;
  amount?: number;
  winningOption?: number;
  isAdmin?: boolean;
  operationId: string;
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
  const ledger = new Ledger(db);
  const ether = new ChipLedger(db, ledger, new EventLog(db));
  const markets = new Markets(db, ether, new EventLog(db), { landLedger: ledger });

  sleepUntil(input.startAt);

  let outcome: "ok" | "error" = "error";
  let payload: unknown = null;
  let errorCode: string | null = null;
  let error: string | null = null;
  try {
    if (input.action === "bet") {
      payload = markets.betEventLand(
        input.marketId,
        input.userId,
        input.roleIds ?? [],
        input.optionIndex ?? 0,
        input.amount ?? 0,
        input.operationId,
      );
    } else if (input.action === "settle") {
      payload = markets.reportAndSettleEventLand(
        input.marketId,
        input.userId,
        input.winningOption ?? 0,
        input.operationId,
        input.isAdmin ?? false,
      );
    } else if (input.action === "void") {
      payload = markets.adminVoidEventLand(input.marketId, input.userId, input.operationId);
    }
    outcome = "ok";
  } catch (e) {
    error = e instanceof Error ? `${e.name}:${e.message}` : String(e);
    errorCode = e instanceof MarketError ? e.code : null;
  } finally {
    db.close();
  }

  process.stdout.write(JSON.stringify({ outcome, payload, error, errorCode }) + "\n");
}

main();
