import {
  Casino,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputes,
  openDb,
  registerDefaultTxTypes,
} from "../../src/index.js";

registerDefaultTxTypes();

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  tableId: string;
  operation: "deadline" | "refund";
  operationId: string;
  actor: string;
  now: number;
  startAt: number;
};

const db = openDb(input.dbPath);
const ledger = new Ledger(db);
const events = new EventLog(db);
const chipTx = new ChipTx(db);
const chips = new ChipLedger(db, ledger, events, { chipTx });
const casino = new Casino(db, chips, events);
const reservations = new HouseReservations(db, chips, events);
chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => input.now });
const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
  openingPhase: () => chipTx.openingPhase(),
  now: () => input.now,
  onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
});

disputes.publicStatus(input.tableId);

const delay = Math.max(0, input.startAt - Date.now());
setTimeout(() => {
  try {
    if (input.operation === "deadline") {
      const result = disputes.processEvidenceDeadlines(input.now);
      console.log(JSON.stringify({ ok: true, result }));
    } else {
      const status = disputes.resolveCollateralRefund({
        tableId: input.tableId,
        actorId: input.actor,
        feeOutcome: "keep",
        publicSummary: "manual collateral refund",
        operationId: input.operationId,
      });
      console.log(JSON.stringify({ ok: true, resolvedAt: status.resolvedAt, resolutionKind: status.resolutionKind }));
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? err.name, error: err.message }));
  } finally {
    db.close();
  }
}, delay);
