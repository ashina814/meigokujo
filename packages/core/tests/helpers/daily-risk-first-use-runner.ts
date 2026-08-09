import {
  CasinoChipAssets,
  ChipLedger,
  ChipTx,
  DailyRisk,
  EventLog,
  Ledger,
  openDb,
  registerDefaultTxTypes,
} from "../../src/index.js";

registerDefaultTxTypes();

/**
 * 別プロセスから「その日の最初のリスク操作」を行う実行体（PR23）。
 * 2本同時に走らせても、当日枠のスナップショットが1つに決まることを確かめる。
 */
const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  userId: string;
  scopeKey: string;
  operationId: string;
  maxPlayerLoss: number;
  now: number;
  startAt: number;
};

const db = openDb(input.dbPath);
const ledger = new Ledger(db);
const events = new EventLog(db);
const chipTx = new ChipTx(db);
const chips = new ChipLedger(db, ledger, events, { chipTx });
const assets = new CasinoChipAssets(db, chips);
const dailyRisk = new DailyRisk(db, ledger, assets, {
  now: () => input.now,
  openingPhase: () => chipTx.openingPhase(),
  boundaryOffsetMinutes: () => 0,
});

const delay = Math.max(0, input.startAt - Date.now());
setTimeout(() => {
  try {
    const exposure = dailyRisk.authorizeExposure({
      userId: input.userId,
      scopeKey: input.scopeKey,
      operationId: input.operationId,
      game: "ルーレット",
      maxPlayerLoss: input.maxPlayerLoss,
      mode: "replace",
    });
    const day = dailyRisk.dayFor(input.userId);
    console.log(JSON.stringify({ ok: true, dayKey: exposure.dayKey, openingHoldings: day.openingHoldings }));
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? err.name, error: err.message }));
  } finally {
    db.close();
  }
}, delay);
