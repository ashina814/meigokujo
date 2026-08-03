import { openDb } from "../../src/db/bootstrap.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { EventLog } from "../../src/events/service.js";
import { ChipTx } from "../../src/casino/chip-tx.js";
import { EtherExchangeCore } from "../../src/casino/exchange.js";
import { HouseReservations, ReservationConflictError } from "../../src/casino/reservations.js";

/**
 * 別プロセスから**本番コードそのもの**（openDb / HouseReservations.reserve）で
 * 同時に予約を取りにいく。PR5 の並行性検証（複数接続・同時実行）を実物で確かめるため。
 *
 * 引数は JSON1つ。結果は JSON1行を標準出力へ返す。
 */
interface RunnerInput {
  dbPath: string;
  key: string;
  amount: number;
  game: string;
  userId: string;
  /** "reserve"（既定）または "resize"（PR5マージ直前レビュー対応: 既存予約の原子的増減の並行性検証） */
  action?: "reserve" | "resize";
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
  const ether = new EtherExchangeCore(db, new Ledger(db), new EventLog(db), { baseRate: 1, chipTx });
  const reservations = new HouseReservations(db, ether, new EventLog(db));

  sleepUntil(input.startAt);

  let outcome: "ok" | "capacity" | "conflict" | "error" = "error";
  let amount = 0;
  let error: string | null = null;
  try {
    const r =
      input.action === "resize"
        ? reservations.resize(input.key, input.amount, input.game, input.userId)
        : reservations.reserve(input.key, input.amount, input.game, input.userId);
    if (r.ok) {
      outcome = "ok";
      amount = r.row?.amount ?? 0;
    } else {
      outcome = r.reason ?? "capacity";
      amount = r.available;
    }
  } catch (e) {
    outcome = e instanceof ReservationConflictError ? "conflict" : "error";
    error = e instanceof Error ? `${e.name}:${e.message}` : String(e);
  } finally {
    db.close();
  }

  process.stdout.write(JSON.stringify({ outcome, amount, error }) + "\n");
}

main();
