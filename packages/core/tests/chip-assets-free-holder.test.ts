import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CHIP_ESCROW, ChipLedger, ChipLedgerError } from "../src/casino/chip-ledger.js";
import { ChipTx, FORMAL_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";

registerDefaultTxTypes();

function setup(withAlice = false) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  const assets = new CasinoChipAssets(db, chips);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, assets);
  if (withAlice) ledger.ensureAccount("user:alice", "user");
  return { db, ledger, chipTx, chips, assets, integrity };
}

type Ctx = ReturnType<typeof setup>;

function setBalance(ctx: Ctx, holder: string, amount: number): void {
  ctx.db.prepare(
    `INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount`,
  ).run(holder, amount);
}

function sealOpening(ctx: Ctx): void {
  const balances = ctx.db.prepare("SELECT user_id, amount FROM ether_balances ORDER BY user_id").all() as Array<{
    user_id: string;
    amount: number;
  }>;
  const outstanding = balances.reduce((sum, row) => sum + row.amount, 0);
  if (outstanding > 0) {
    ctx.ledger.transfer({
      from: TREASURY,
      to: CHIP_ESCROW,
      amount: outstanding,
      type: "adjust",
      actor: "test",
      approvedBy: "test",
      idempotencyKey: `fixture:free-holder:${outstanding}`,
    });
  }
  ctx.chipTx.captureOpening(
    FORMAL_OPENING_VERSION,
    balances.map((row) => [row.user_id, row.amount] as const),
    { poolLand: outstanding, fromLedgerTxId: ctx.ledger.lastTransactionId() },
  );
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

describe("自由チップholderのLand利用者口座確認", () => {
  it("口座なしで自由チップ500ならfreeChips/forUserを停止し、検算DもNGにする", () => {
    const ctx = setup();
    setBalance(ctx, "ghost", 500);
    sealOpening(ctx);

    const freeError = expectCorrupt(() => ctx.assets.freeChips("ghost"));
    expect(freeError.details).toEqual(
      expect.objectContaining({
        userId: "ghost",
        mismatches: [
          expect.objectContaining({
            code: "invalid_user_id",
            scope: "user",
            affectedUserIds: ["ghost"],
          }),
        ],
      }),
    );
    expectCorrupt(() => ctx.assets.forUser("ghost"));

    const report = ctx.integrity.runFull();
    const checkD = report.checks.find((check) => check.id === "D");
    expect(report.ok).toBe(false);
    expect(report.failed).toContain("D");
    expect(checkD?.mismatches).toContainEqual(
      expect.objectContaining({
        subject: "ghost",
        actual: 500,
        note: "台帳に user 口座が無い保有者",
      }),
    );
  });

  it("口座なしでも自由チップ0・預託0なら新規利用者の0資産として許可する", () => {
    const ctx = setup();

    expect(ctx.assets.freeChips("ghost")).toBe(0);
    expect(ctx.assets.forUser("ghost")).toEqual({
      userId: "ghost",
      freeChips: 0,
      escrowed: 0,
      total: 0,
    });
  });

  it("Aliceが正常でghostだけに孤児自由残高があればAliceへ波及させない", () => {
    const ctx = setup(true);
    setBalance(ctx, "alice", 1_000);
    setBalance(ctx, "ghost", 500);
    sealOpening(ctx);

    const report = ctx.integrity.runFull();
    expect(report.ok).toBe(false);
    expect(report.failed).toContain("D");
    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 1_000,
      escrowed: 0,
      total: 1_000,
    });
    expect(ctx.assets.freeChips("alice")).toBe(1_000);
    expectCorrupt(() => ctx.assets.freeChips("ghost"));
    expectCorrupt(() => ctx.assets.forUser("ghost"));
  });

  it("accounts schemaが不完全ならfreeChips/forUserとも全利用者をfail-closedにする", () => {
    const ctx = setup(true);
    setBalance(ctx, "alice", 500);
    ctx.db.pragma("foreign_keys = OFF");
    ctx.db.exec("DROP TABLE accounts; CREATE TABLE accounts (id TEXT)");

    expectCorrupt(() => ctx.assets.freeChips("alice"));
    expectCorrupt(() => ctx.assets.forUser("alice"));
  });

  it("正常な利用者口座と自由チップは従来どおり返す", () => {
    const ctx = setup(true);
    setBalance(ctx, "alice", 500);

    expect(ctx.assets.freeChips("alice")).toBe(500);
    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 500,
      escrowed: 0,
      total: 500,
    });
  });
});
