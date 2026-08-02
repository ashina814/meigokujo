import { describe, expect, it } from "vitest";
import { CasinoRemittance, ChipLedger, EventLog, HouseReservations, Ledger, TREASURY, deptAccount, openDb, registerDefaultTxTypes } from "../src/index.js";
registerDefaultTxTypes();
function setup() { const db=openDb(":memory:"); const ledger=new Ledger(db); const chips=new ChipLedger(db,ledger,new EventLog(db)); const reservations=new HouseReservations(db,chips,new EventLog(db)); return {db,ledger,chips,remit:new CasinoRemittance(db,ledger,chips,reservations),reservations}; }
describe("PR14 納付・補填", () => {
  it("余剰だけを別承認者のdraft→approve→executeで一度だけ国庫へ納付する", () => {
    const c=setup(); c.ledger.ensureAccount(deptAccount("seed"),"system"); c.chips.fundFromAccount(TREASURY,1000,"house","fund"); c.remit.recordRealized("game",800,"game:1");
    const d=c.remit.draft("m1",5000,200,"maker"); expect(d.amount).toBe(400); expect(()=>c.remit.approve("m1","maker")).toThrow();
    c.remit.approve("m1","reviewer"); expect(c.remit.execute("m1","operator").status).toBe("executed"); expect(c.chips.balanceOf("house")).toBe(600); expect(()=>c.remit.execute("m1","operator")).toThrow(); c.db.close();
  });
  it("補填はapprovedBy引数では実行できず、永続draft→別人approve→一度だけexecuteする", () => {
    const c=setup(); expect(()=>c.remit.bailout("b1",100,"maker","reviewer")).toThrow();
    c.remit.bailoutDraft("b1",100,"不足","{\"house\":0}" as unknown as Record<string,unknown>,"maker");
    expect(()=>c.remit.approve("b1","maker")).toThrow(); c.remit.approve("b1","reviewer");
    expect(c.remit.execute("b1","operator").status).toBe("executed"); expect(c.chips.balanceOf("house")).toBe(100); expect(()=>c.remit.execute("b1","operator")).toThrow(); c.db.close();
  });
});
