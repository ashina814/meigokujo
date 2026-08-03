import { describe, expect, it } from "vitest";
import {
  CasinoRemittance,
  ChipLedger,
  EventLog,
  HouseReservations,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  const reservations = new HouseReservations(db, chips, new EventLog(db));
  const remittance = new CasinoRemittance(db, ledger, chips, reservations);
  return { db, ledger, chips, remittance };
}

function fund(c: ReturnType<typeof setup>, holder: string, amount: number, key: string): void {
  c.chips.fundFromAccount(TREASURY, amount, holder, key);
}

describe("PR14 構造化された実現損益", () => {
  it("理由文に依存せずgroup種別と資金方向で賭け・配当・連鎖・JPを分類する", () => {
    const c = setup();
    fund(c, "house", 10_000, "seed:house");
    fund(c, "u1", 1_000, "seed:u1");
    c.chips.runGroup({ groupKey: "solo:arbitrary", kind: "solo_game", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "文言A" });
      c.chips.transfer("house", "u1", 60, { reason: "文言B" });
      c.chips.transfer("house", "u1", 5, { reason: "文言C" });
      c.chips.transfer("house", "jackpot", 2, { reason: "文言D" });
    });

    expect(c.remittance.pnl().map((row) => [row.category, row.amount])).toEqual([
      ["wager", 100],
      ["payout", -60],
      ["chain_bonus", -5],
      ["jackpot_contribution", -2],
    ]);
    c.db.close();
  });

  it("チンチロの事前預託holderからhouseへ移る確定損失を収入として数える", () => {
    const c = setup();
    fund(c, "u1", 2_000, "seed:u1");
    c.chips.runGroup({ groupKey: "chinchiro:preheld", kind: "solo_game", actorId: "u1" }, () => {
      c.chips.transfer("u1", "escrow:session:chinchiro", 2_000, { reason: "預託" });
      c.chips.transfer("escrow:session:chinchiro", "house", 2_000, { reason: "確定損失" });
    });

    expect(c.remittance.pnl()).toEqual([
      expect.objectContaining({ category: "wager", amount: 2_000, chipGroupKey: "chinchiro:preheld" }),
    ]);
    c.db.close();
  });

  it("VIPと賭場商店をgroup種別で別分類する", () => {
    const c = setup();
    fund(c, "u1", 1_000, "seed:u1");
    c.chips.runGroup({ groupKey: "vip:1", kind: "vip", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "任意のVIP文言" });
    });
    c.chips.runGroup({ groupKey: "shop:1", kind: "shop", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 50, { reason: "任意の商品文言" });
    });

    expect(c.remittance.pnl().map((row) => [row.category, row.amount])).toEqual([
      ["vip", 100],
      ["shop", 50],
    ]);
    c.db.close();
  });

  it("JSTの月初0時台を新しい会計月へ入れる", () => {
    const c = setup();
    fund(c, "u1", 100, "seed:u1");
    c.chips.runGroup({ groupKey: "month:jst", kind: "shop", actorId: "u1" }, () => {
      c.chips.transfer("u1", "house", 100, { reason: "月境界" });
    });
    const jstAugustFirst0030 = Math.floor(Date.parse("2026-07-31T15:30:00.000Z") / 1_000);
    c.db.prepare("UPDATE casino_tx SET created_at=? WHERE group_key='month:jst'").run(jstAugustFirst0030);

    expect(c.remittance.pnl("2026-08")).toEqual([
      expect.objectContaining({ category: "shop", amount: 100, period: "2026-08" }),
    ]);
    expect(c.remittance.pnl("2026-07")).toEqual([]);
    c.db.close();
  });
});
