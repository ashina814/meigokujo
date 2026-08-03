import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger } from "../src/casino/chip-ledger.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { Escrow } from "../src/casino/escrow.js";
import { Markets } from "../src/casino/market.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new ChipLedger(db, ledger, events);
  const escrow = new Escrow(db, chips, events);
  const markets = new Markets(db, chips, events);
  ledger.ensureAccount("user:alice", "user");
  ledger.transfer({ from: TREASURY, to: "user:alice", amount: 10_000, type: "initial", actor: "test", idempotencyKey: "fund:alice" });
  chips.deposit("alice", 10_000, "deposit:alice");
  return { chips, escrow, markets, assets: new CasinoChipAssets(db, chips) };
}

describe("利用者の自由チップと拘束チップ", () => {
  it("卓・板に預けた額を自由チップと分離し、合計資産を保持する", () => {
    const ctx = setup();
    expect(ctx.escrow.hold("table:1", "alice", 2_000, "丁半", "hold:1")).toBe(true);
    const market = ctx.markets.create({ guildId: "g", creatorId: "alice", title: "AかBか", options: ["A", "B"], durationMin: 60, fee: 0, operationId: "market:create" });
    ctx.markets.bet(market.id, "alice", 0, 3_000, "market:bet");

    expect(ctx.chips.freeChips("alice")).toBe(5_000);
    expect(ctx.assets.forUser("alice")).toEqual({ userId: "alice", freeChips: 5_000, escrowed: 5_000, total: 10_000 });
    expect(ctx.assets.verifyEscrowed()).toEqual({ ok: true, mismatches: [] });
  });

  it("holder残高が拘束台帳と異なれば、利用者資産検算が不一致を返す", () => {
    const ctx = setup();
    expect(ctx.escrow.hold("table:1", "alice", 2_000, "丁半", "hold:1")).toBe(true);
    ctx.chips.runGroup({ groupKey: "tamper", kind: "table_settle", actorId: "test" }, () => {
      ctx.chips.transfer("escrow:session:table:1", "house", 1, { reason: "test tamper" });
    });
    expect(ctx.assets.verifyEscrowed()).toEqual({
      ok: false,
      mismatches: [{ holder: "escrow:session:table:1", expected: 2_000, actual: 1_999 }],
    });
  });
});
