import {
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedTables,
  openDb,
  registerDefaultTxTypes,
} from "../../src/index.js";

registerDefaultTxTypes();

/**
 * 別プロセスから高卓を1つ作りにいくだけの実行体（PR23）。
 * 2本同時に走らせて「クールダウンをすり抜けて両方成立する」ことが無いかを見る。
 */
const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  tableId: string;
  operationId: string;
  baseAmount: number;
  highCooldownSec: number;
  now: number;
  startAt: number;
};

const db = openDb(input.dbPath);
const ledger = new Ledger(db);
const events = new EventLog(db);
const chipTx = new ChipTx(db);
const chips = new ChipLedger(db, ledger, events, { chipTx });
const reservations = new HouseReservations(db, chips, events);
chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
const escrow = new Escrow(db, chips, events);
const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => input.now });
const metrics = new CasinoMetrics(db, chipTx, () => input.now);
const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, {
  now: () => input.now,
  reservations,
  openingPhase: () => chipTx.openingPhase(),
  highCooldownSec: () => input.highCooldownSec,
});

const delay = Math.max(0, input.startAt - Date.now());
setTimeout(() => {
  try {
    const snapshot = rankedTables.create({
      tableId: input.tableId,
      gameKey: "gf",
      baseAmount: input.baseAmount,
      creatorId: "operator",
      operatorId: "operator",
      operationId: input.operationId,
      authority: "employee",
    });
    console.log(JSON.stringify({ ok: true, tableId: snapshot.table.tableId }));
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? err.name, error: err.message }));
  } finally {
    db.close();
  }
}, delay);
