import { describe, expect, it } from "vitest";
import { CasinoRemittance, ChipLedger, EventLog, HouseReservations, Ledger, TREASURY, deptAccount, openDb, registerDefaultTxTypes } from "../src/index.js";
registerDefaultTxTypes();
function setup() { const db=openDb(":memory:"); const ledger=new Ledger(db); const chips=new ChipLedger(db,ledger,new EventLog(db)); const reservations=new HouseReservations(db,chips,new EventLog(db)); return {db,ledger,chips,remit:new CasinoRemittance(db,ledger,chips,reservations),reservations}; }
describe("PR14 納付・補填", () => {
  it("余剰だけを別承認者のdraft→approve→executeで一度だけ国庫へ納付する", () => {
    const c=setup(); c.ledger.ensureAccount(deptAccount("seed"),"system"); c.chips.fundFromAccount(TREASURY,1000,"house","fund");
    const d=c.remit.draft("m1",5000,200,"maker"); expect(d.amount).toBe(400); expect(()=>c.remit.approve("m1","maker")).toThrow();
    c.remit.approve("m1","reviewer"); expect(c.remit.execute("m1","operator").status).toBe("executed"); expect(c.chips.balanceOf("house")).toBe(600); expect(()=>c.remit.execute("m1","operator")).toThrow(); c.db.close();
  });
});
