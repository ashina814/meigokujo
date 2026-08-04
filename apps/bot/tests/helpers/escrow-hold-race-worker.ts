/**
 * PR11独立監査 #50 フォローアップ: 別接続・別Nodeプロセスから `Escrow.hold()` /
 * `Escrow.holdAll()` に**異なる要求**（amount・game・参加者構成）で同時アクセスした
 * ときの競合を再現するワーカー。
 *
 * `chinchiro-race-worker.ts` と同じ ready/go 同期方式（親が両ワーカーの準備完了を
 * 確認してから一斉に "go" を書く）で、実際にほぼ同時実行させる。
 *
 * 引数: dbPath readyPath goPath outPath action ...actionArgs
 *   action=hold:    sessionId userId amount game operationId
 *   action=holdAll: sessionId userIdsCsv amount game operationId
 */
import { existsSync, writeFileSync } from "node:fs";
import { ChipLedger, ChipTx, Escrow, EventLog, Ledger, openDb } from "@meigokujo/core";

const [, , dbPath, readyPath, goPath, outPath, action, ...rest] = process.argv;
if (!dbPath || !readyPath || !goPath || !outPath || !action) {
  throw new Error("usage: escrow-hold-race-worker.ts <dbPath> <readyPath> <goPath> <outPath> <action> ...args");
}

function build(db: ReturnType<typeof openDb>) {
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  return { db, chips, escrow };
}

/** 同期ビジーウェイト。async を挟まないので、両ワーカーの実行タイミングが素直に揃う */
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
const ctx = build(db);

writeFileSync(readyPath, "ready");
waitForGo();

let result: unknown;
let error: string | null = null;
try {
  if (action === "hold") {
    const [sessionId, userId, amountStr, game, operationId] = rest;
    result = ctx.escrow.hold(sessionId!, userId!, Number(amountStr), game!, operationId!);
  } else if (action === "holdAll") {
    const [sessionId, userIdsCsv, amountStr, game, operationId] = rest;
    result = ctx.escrow.holdAll(sessionId!, userIdsCsv!.split(","), Number(amountStr), game!, operationId!);
  } else {
    throw new Error(`unknown action: ${action}`);
  }
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}

writeFileSync(outPath, JSON.stringify({ result, error }));
db.close();
