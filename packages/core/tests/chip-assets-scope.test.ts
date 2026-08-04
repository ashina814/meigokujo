import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { ChipLedger, ChipLedgerError } from "../src/casino/chip-ledger.js";
import { escrowHolderFor } from "../src/casino/escrow.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT, kind TEXT);
    CREATE TABLE ether_balances (user_id TEXT, amount);
    CREATE TABLE casino_escrow (session_id TEXT, user_id TEXT, amount, source TEXT);
    CREATE TABLE casino_markets (id, status, fund_mode);
    CREATE TABLE casino_market_bets (market_id, user_id, amount);
    INSERT INTO accounts VALUES ('user:alice','user'), ('user:bob','user');
    INSERT INTO ether_balances VALUES ('alice',10000), ('bob',10000);
  `);
  const chips = {
    freeChips(userId: string): number {
      const row = db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(userId) as
        | { amount: number }
        | undefined;
      return row?.amount ?? 0;
    },
  } as unknown as ChipLedger;
  return { db, assets: new CasinoChipAssets(db, chips) };
}

function hold(
  db: Database.Database,
  sessionId: string,
  userId: string,
  amount: number,
  source = escrowHolderFor(sessionId),
): void {
  db.prepare("INSERT INTO casino_escrow VALUES (?, ?, ?, ?)").run(sessionId, userId, amount, source);
}

function balance(db: Database.Database, holder: string, amount: number): void {
  db.prepare("INSERT INTO ether_balances VALUES (?, ?)").run(holder, amount);
}

function expectCorrupt(read: () => unknown): ChipLedgerError {
  let caught: unknown;
  try {
    read();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ChipLedgerError);
  expect((caught as ChipLedgerError).code).toBe("ERR_CORRUPT_BALANCE");
  return caught as ChipLedgerError;
}

describe("利用者単位のエスクロー不一致", () => {
  it("Bobのsessionが1 Ld不足してもAliceの既知資産は返す", () => {
    const { db, assets } = setup();
    hold(db, "alice-session", "alice", 2000);
    hold(db, "bob-session", "bob", 3000);
    balance(db, escrowHolderFor("alice-session"), 2000);
    balance(db, escrowHolderFor("bob-session"), 2999);

    const verification = assets.verifyEscrowed();
    expect(verification.ok).toBe(false);
    expect(verification.mismatches).toContainEqual(
      expect.objectContaining({
        code: "balance_mismatch",
        scope: "holder",
        affectedUserIds: ["bob"],
      }),
    );
    expectCorrupt(() => assets.forUser("bob"));
    expect(assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 10000,
      escrowed: 2000,
      total: 12000,
    });
  });

  it("Bobのsource不正はBobだけを停止する", () => {
    const { db, assets } = setup();
    hold(db, "alice-session", "alice", 2000);
    hold(db, "bob-session", "bob", 3000, "house");
    balance(db, escrowHolderFor("alice-session"), 2000);
    balance(db, escrowHolderFor("bob-session"), 3000);

    const mismatch = assets.verifyEscrowed().mismatches.find((row) => row.code === "invalid_legacy_source");
    expect(mismatch).toEqual(
      expect.objectContaining({ scope: "user", affectedUserIds: ["bob"], userId: "bob" }),
    );
    expectCorrupt(() => assets.forUser("bob"));
    expect(assets.forUser("alice").escrowed).toBe(2000);
  });

  it("帳簿なし孤児holderはglobal verifyを落とすがAliceを止めない", () => {
    const { db, assets } = setup();
    hold(db, "alice-session", "alice", 2000);
    balance(db, escrowHolderFor("alice-session"), 2000);
    balance(db, escrowHolderFor("orphan"), 777);

    const verification = assets.verifyEscrowed();
    expect(verification.ok).toBe(false);
    const mismatch = verification.mismatches.find((row) => row.code === "missing_ledger_rows");
    expect(mismatch).toEqual(expect.objectContaining({ code: "missing_ledger_rows", scope: "holder" }));
    expect(mismatch).not.toHaveProperty("affectedUserIds");
    expect(assets.forUser("alice").total).toBe(12000);
  });

  it("unknown escrow holderはglobal verifyを落とすが無関係なAliceを止めない", () => {
    const { db, assets } = setup();
    hold(db, "alice-session", "alice", 2000);
    balance(db, escrowHolderFor("alice-session"), 2000);
    balance(db, "escrow:unknown:thing", 555);

    const verification = assets.verifyEscrowed();
    expect(verification.ok).toBe(false);
    const mismatch = verification.mismatches.find((row) => row.code === "unknown_escrow_holder");
    expect(mismatch).toEqual(expect.objectContaining({ code: "unknown_escrow_holder", scope: "holder" }));
    expect(mismatch).not.toHaveProperty("affectedUserIds");
    expect(assets.forUser("alice").escrowed).toBe(2000);
  });

  it("schema_incompleteは全利用者をfail-closedにする", () => {
    const { db, assets } = setup();
    db.exec("DROP TABLE casino_market_bets");

    const mismatch = assets.verifyEscrowed().mismatches.find((row) => row.code === "schema_incomplete");
    expect(mismatch).toEqual(expect.objectContaining({ scope: "global" }));
    expectCorrupt(() => assets.forUser("alice"));
    expectCorrupt(() => assets.forUser("bob"));
  });

  it("AliceとBobが同じ正常holderを共有する場合、そのholder不一致は両者を停止する", () => {
    const { db, assets } = setup();
    hold(db, "shared", "alice", 1000);
    hold(db, "shared", "bob", 2000);
    balance(db, escrowHolderFor("shared"), 2999);

    const mismatch = assets.verifyEscrowed().mismatches.find((row) => row.code === "balance_mismatch");
    expect(mismatch).toEqual(
      expect.objectContaining({ scope: "holder", affectedUserIds: ["alice", "bob"] }),
    );
    expectCorrupt(() => assets.forUser("alice"));
    expectCorrupt(() => assets.forUser("bob"));
  });
});
