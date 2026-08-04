/**
 * PR11 独立本監査（2回目）: 実際に同時開始する2プロセスでの競合テスト用ワーカー。
 *
 * `execFileSync` による直列テストでは「一方が終わってから他方」しか再現できない。
 * このワーカーは、親プロセスが作る "go" ファイルが現れるまで同期的にビジーウェイトし、
 * 親が両ワーカーの準備完了を確認してから一斉に "go" を書くことで、実際にほぼ同時に
 * 目的の操作（beginChinchiroPrehold / settleChinchiroRound / refundChinchiroPreholdOnFailure）
 * を実行する。
 *
 * 引数: dbPath readyPath goPath outPath action ...actionArgs
 */
import { existsSync, writeFileSync } from "node:fs";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  CasinoStatus,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  Ledger,
  RecoveryRegistry,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import type { Services } from "../../src/services.js";
import {
  beginChinchiroPrehold,
  refundChinchiroPreholdOnFailure,
  settleChinchiroRound,
} from "../../src/casino/chinchiro.js";

registerDefaultTxTypes();

const [, , dbPath, readyPath, goPath, outPath, action, ...rest] = process.argv;
if (!dbPath || !readyPath || !goPath || !outPath || !action) {
  throw new Error("usage: chinchiro-race-worker.ts <dbPath> <readyPath> <goPath> <outPath> <action> ...args");
}

function build(db: ReturnType<typeof openDb>) {
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const items = new Items(db);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const escrow = new Escrow(db, chips, events);
  const casino = new Casino(db, chips, events, { items, reservations });
  const chipAssets = new CasinoChipAssets(db, chips);
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets);
  new CasinoIntegrity(db, ledger, chips, escrow, chipAssets);
  new CasinoStatus(db);
  new RecoveryRegistry();
  const services = {
    db, ledger, events, chipTx, chips, ether: chips, items, reservations, escrow, casino, chipAssets, chipFlow,
  } as unknown as Services;
  return services;
}

/** 同期ビジーウェイト。async を挟まないので、両ワーカーの実行タイミングが素直に揃う。 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function waitForGo(timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(goPath)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for go signal");
    sleepSync(2);
  }
}

const db = openDb(dbPath);
const services = build(db);

// 準備完了を親へ知らせ、"go" が現れるまで待つ
writeFileSync(readyPath, "ready");
waitForGo();

let result: unknown;
let error: string | null = null;
try {
  if (action === "begin") {
    const [uid, betStr, operationId] = rest;
    result = beginChinchiroPrehold(services, uid!, Number(betStr), operationId!);
  } else if (action === "settle") {
    const [uid, betStr, mulStr, operationId] = rest;
    result = settleChinchiroRound(services, uid!, Number(betStr), Number(mulStr), operationId!);
  } else if (action === "refund") {
    const [sessionId] = rest;
    try {
      refundChinchiroPreholdOnFailure(services, sessionId!, new Error("worker-simulated crash"));
    } catch (e) {
      // refundChinchiroPreholdOnFailure は必ず（no-opでも）例外を投げて終わる設計。
      // ワーカーにとってはそれ自体が「実行できた」ことの証拠
      result = { threw: e instanceof Error ? e.message : String(e) };
    }
  } else {
    throw new Error(`unknown action: ${action}`);
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}

writeFileSync(outPath, JSON.stringify({ result, error }));
db.close();
