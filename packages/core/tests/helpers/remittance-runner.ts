import { openDb } from "../../src/db/bootstrap.js";
import { Ledger } from "../../src/ledger/service.js";
import { registerDefaultTxTypes } from "../../src/ledger/registry.js";
import { EventLog } from "../../src/events/service.js";
import { ChipLedger, HOUSE_HOLDER } from "../../src/casino/exchange.js";
import { HouseReservations } from "../../src/casino/reservations.js";
import { Settings } from "../../src/settings/service.js";
import { CasinoRemittance } from "../../src/casino/remittance.js";

registerDefaultTxTypes();

const input = JSON.parse(process.argv[2] ?? "{}") as {
  dbPath: string;
  action: "approve" | "execute";
  key: string;
  actor: string;
  startAt: number;
};

const db = openDb(input.dbPath);
const settings = new Settings(db);
const ledger = new Ledger(db);
const events = new EventLog(db);
const chips = new ChipLedger(db, ledger, events);
const reservations = new HouseReservations(db, chips, events);
chips.setReservedProvider((holder) => holder === HOUSE_HOLDER ? reservations.totalReserved() : 0);
const remit = new CasinoRemittance(db, ledger, chips, reservations, settings, { fukuReserve: () => 0 });

// barrier前にschema/account初期化を済ませ、競合対象をapprove/execute本体へ限定する。
remit.get(input.key);

const delay = Math.max(0, input.startAt - Date.now());
setTimeout(() => {
  try {
    const row = input.action === "approve" ? remit.approve(input.key, input.actor) : remit.execute(input.key, input.actor);
    console.log(JSON.stringify({ ok: true, status: row.status, approvedBy: row.approvedBy, executedBy: row.executedBy }));
  } catch (e) {
    const err = e as Error & { code?: string };
    console.log(JSON.stringify({ ok: false, code: err.code ?? err.name, error: err.message }));
  } finally {
    db.close();
  }
}, delay);
