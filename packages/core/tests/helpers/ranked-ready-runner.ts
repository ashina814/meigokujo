import {
  Casino,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  Ledger,
  PersistentTables,
  RankedTables,
  openDb,
  registerDefaultTxTypes,
} from "../../src/index.js";

registerDefaultTxTypes();

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  tableId: string;
  userId: string;
  operationId: string;
  startAt: number;
};

const db = openDb(input.dbPath);
const ledger = new Ledger(db);
const events = new EventLog(db);
const chipTx = new ChipTx(db);
const chips = new ChipLedger(db, ledger, events, { chipTx });
const casino = new Casino(db, chips, events);
const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => 1_700_000_000 });
const metrics = new CasinoMetrics(db, chipTx, () => 1_700_000_000);
const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, { now: () => 1_700_000_000 });

rankedTables.snapshot(input.tableId);

const delay = Math.max(0, input.startAt - Date.now());
setTimeout(() => {
  try {
    const snapshot = rankedTables.ready({
      tableId: input.tableId,
      userId: input.userId,
      operationId: input.operationId,
    });
    console.log(JSON.stringify({ ok: true, state: snapshot.table.state, revision: snapshot.table.revision }));
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? err.name, error: err.message }));
  } finally {
    db.close();
  }
}, delay);
