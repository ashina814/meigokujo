import { describe, expect, it } from "vitest";
import { CasinoOpeningReset, FREE_SPIN_JACKPOT_CLAIMS_HOLDER, Ledger, ChipLedger, EventLog, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();
const config = { configured: true as const, casinoOpeningCapital: 1000, houseCapital: 500, jackpotCapital: 100, reliefCapital: 100, minimumWorkingCapital: 100, remittanceBps: 0 };

describe("PR12 開業初期化 preflight", () => {
  it("未精算フリースピンと固定JP請求holderを読み取り検査し、不一致やpendingをblockerにする", () => {
    const db = openDb(":memory:");
    const chips = new ChipLedger(db, new Ledger(db), new EventLog(db));
    db.exec(`CREATE TABLE casino_pending_free_spins (id INTEGER PRIMARY KEY, status TEXT, jackpot_claim INTEGER)`);
    db.prepare("INSERT INTO casino_pending_free_spins VALUES (1,'pending',30),(2,'settled',20)").run();
    chips.ensureHolder(FREE_SPIN_JACKPOT_CLAIMS_HOLDER);
    const p = new CasinoOpeningReset(db).dryRun(config);
    expect(p.freeSpinClaims).toMatchObject({ pendingIds: [1], expected: 30, actual: 0, matches: false });
    expect(p.blockers.join(" ")).toContain("未精算無料スピン");
    expect(p.blockers.join(" ")).toContain("無料スピンJP請求不一致");
    db.close();
  });
});
