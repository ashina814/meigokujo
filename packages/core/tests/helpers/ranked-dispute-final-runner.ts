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
  operation: "deadline" | "finalize" | "ranked_result";
  operationId: string;
  actor: string;
  serviceNow: number;
  deadlineNow: number;
  startAt: number;
};

const db = openDb(input.dbPath);
const ledger = new Ledger(db);
const events = new EventLog(db);
const chipTx = new ChipTx(db);
const chips = new ChipLedger(db, ledger, events, { chipTx });
const casino = new Casino(db, chips, events);
const reservations = new HouseReservations(db, chips, events);
chips.setReservedProvider((holderId) => holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0);
const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => input.serviceNow });
const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
  openingPhase: () => chipTx.openingPhase(),
  now: () => input.serviceNow,
  onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
});

disputes.publicStatus(input.tableId);

setTimeout(() => {
  try {
    if (input.operation === "deadline") {
      const result = disputes.processEvidenceDeadlines(input.deadlineNow);
      console.log(JSON.stringify({ ok: true, result }));
    } else if (input.operation === "finalize") {
      const result = disputes.finalizeEvidenceStored({
        operationId: input.operationId,
        privateChannelId: "private-channel",
        privateMessageId: "private-message",
        metadata: { source: "race-test" },
      });
      console.log(JSON.stringify({ ok: true, result }));
    } else {
      const result = disputes.resolveRankedResult({
        tableId: input.tableId,
        actorId: input.actor,
        orderedUserIds: ["alice", "bob"],
        feeOutcome: "fault_refund",
        recordStats: true,
        publicSummary: "manual arbitration race",
        operationId: input.operationId,
      });
      console.log(JSON.stringify({ ok: true, resolutionKind: result.resolutionKind, resolvedAt: result.resolvedAt }));
    }
  } catch (error) {
    const err = error as Error & { code?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? err.name, error: err.message }));
  } finally {
    db.close();
  }
}, Math.max(0, input.startAt - Date.now()));
