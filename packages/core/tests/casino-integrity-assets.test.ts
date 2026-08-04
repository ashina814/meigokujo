import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CHIP_ESCROW, ChipLedger } from "../src/casino/chip-ledger.js";
import { ChipTx, FORMAL_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { Escrow, escrowHolderFor } from "../src/casino/escrow.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { MARKET_LIVE_STATUSES, Markets, marketEscrowHolder } from "../src/casino/market.js";
import { HouseReservations } from "../src/casino/reservations.js";
import { RecoveryRegistry, recoverCasino } from "../src/casino/recovery.js";
import { CasinoStatus } from "../src/casino/status.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  const markets = new Markets(db, chips, events);
  const assets = new CasinoChipAssets(db, chips);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, assets);
  const status = new CasinoStatus(db);
  const reservations = new HouseReservations(db, chips, events);
  for (const userId of ["alice", "bob"]) ledger.ensureAccount(`user:${userId}`, "user");
  return { db, ledger, events, chipTx, chips, escrow, markets, assets, integrity, status, reservations };
}

type Ctx = ReturnType<typeof setup>;

function setBalance(ctx: Ctx, holder: string, amount: number): void {
  ctx.db.prepare(
    `INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)
     ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount`,
  ).run(holder, amount);
}

function insertSession(
  ctx: Ctx,
  sessionId: string,
  userId: string,
  amount: number,
  source = escrowHolderFor(sessionId),
): void {
  ctx.db.prepare(
    `INSERT INTO casino_escrow (session_id,user_id,amount,game,source,created_at)
     VALUES (?,?,?,?,?,0)`,
  ).run(sessionId, userId, amount, "test", source);
}

function insertMarket(
  ctx: Ctx,
  id: number,
  status: string,
  fundMode: string,
  userId = "alice",
  amount = 100,
): void {
  ctx.db.prepare(
    `INSERT INTO casino_markets
     (id,guild_id,creator_id,title,options_json,status,deadline_at,fee,payout_mode,fund_mode,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
  ).run(id, "g", userId, "test", '["A","B"]', status, 9_999_999_999, 0, "parimutuel", fundMode);
  ctx.db.prepare(
    "INSERT INTO casino_market_bets (market_id,user_id,option_index,amount,created_at) VALUES (?,?,0,?,0)",
  ).run(id, userId, amount);
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
      idempotencyKey: `fixture:pool:${outstanding}`,
    });
  }
  ctx.chipTx.captureOpening(
    FORMAL_OPENING_VERSION,
    balances.map((row) => [row.user_id, row.amount] as const),
    { poolLand: outstanding, fromLedgerTxId: ctx.ledger.lastTransactionId() },
  );
}

function mismatchNotes(ctx: Ctx): string {
  return ctx.integrity
    .runFull()
    .checks.flatMap((check) => check.mismatches)
    .map((mismatch) => mismatch.note ?? "")
    .join("\n");
}

describe("CasinoIntegrityは共通資産監査を検算C/Dに接続する", () => {
  const cases: Array<{
    name: string;
    code: string;
    arrange: (ctx: Ctx) => void;
  }> = [
    {
      name: "session source不一致",
      code: "invalid_legacy_source",
      arrange(ctx) {
        insertSession(ctx, "bad-source", "alice", 100, "house");
        setBalance(ctx, escrowHolderFor("bad-source"), 100);
      },
    },
    {
      name: "duplicate ownership",
      code: "duplicate_ownership",
      arrange(ctx) {
        ctx.db.exec(`
          DROP TABLE casino_escrow;
          CREATE TABLE casino_escrow (session_id TEXT, user_id TEXT, amount, game TEXT, source TEXT, created_at INTEGER);
        `);
        insertSession(ctx, "duplicate", "alice", 50);
        insertSession(ctx, "duplicate", "alice", 50);
        setBalance(ctx, escrowHolderFor("duplicate"), 100);
      },
    },
    {
      name: "帳簿なしsession holder",
      code: "missing_ledger_rows",
      arrange(ctx) {
        setBalance(ctx, escrowHolderFor("orphan"), 100);
      },
    },
    {
      name: "帳簿なしmarket holder",
      code: "missing_ledger_rows",
      arrange(ctx) {
        setBalance(ctx, marketEscrowHolder(77), 100);
      },
    },
    {
      name: "unknown escrow holder",
      code: "unknown_escrow_holder",
      arrange(ctx) {
        setBalance(ctx, "escrow:unknown:77", 100);
      },
    },
    {
      name: "market fund_mode不一致",
      code: "invalid_fund_mode",
      arrange(ctx) {
        insertMarket(ctx, 1, "open", "mystery");
      },
    },
    {
      name: "unknown market status",
      code: "unknown_market_status",
      arrange(ctx) {
        insertMarket(ctx, 1, "mystery", "escrow");
      },
    },
    {
      name: "corrupt amount",
      code: "corrupt_amount",
      arrange(ctx) {
        insertSession(ctx, "corrupt", "alice", 1.5);
        setBalance(ctx, escrowHolderFor("corrupt"), 1);
      },
    },
  ];

  for (const testCase of cases) {
    it(`runFullが${testCase.name}を検出する`, () => {
      const ctx = setup();
      setBalance(ctx, "alice", 1000);
      testCase.arrange(ctx);
      sealOpening(ctx);

      const report = ctx.integrity.runFull();
      expect(report.ok).toBe(false);
      expect(report.failed).toEqual(expect.arrayContaining(["C"]));
      expect(mismatchNotes(ctx)).toContain(testCase.code);
    });
  }

  it("legacy_house板をmarket escrow帳簿へ二重計上しない", () => {
    const ctx = setup();
    setBalance(ctx, "alice", 1000);
    setBalance(ctx, "house", 100);
    insertMarket(ctx, 1, "open", "legacy_house", "alice", 100);
    sealOpening(ctx);

    const inspection = ctx.assets.inspectEscrowed();
    expect(inspection.holders.some((row) => row.holder === marketEscrowHolder(1))).toBe(false);
    expect(inspection.mismatches).toContainEqual(
      expect.objectContaining({ code: "invalid_legacy_source", holder: "house" }),
    );
    expect(mismatchNotes(ctx)).toContain("invalid_legacy_source");
  });

  it("MARKET_LIVE_STATUSESの全statusを資産APIと検算C/Dが同じ集合として扱う", () => {
    const ctx = setup();
    setBalance(ctx, "alice", 1000);
    MARKET_LIVE_STATUSES.forEach((status, index) => {
      const id = index + 1;
      insertMarket(ctx, id, status, "escrow", "alice", 100);
      setBalance(ctx, marketEscrowHolder(id), 100);
    });
    sealOpening(ctx);

    const inspection = ctx.assets.inspectEscrowed();
    expect(inspection.holders.filter((row) => row.sourceKind === "market")).toHaveLength(MARKET_LIVE_STATUSES.length);
    expect(ctx.integrity.runFull().ok).toBe(true);
  });
});

describe("startup precheckとpostflightの境界", () => {
  it("startup precheckは孤児があってもA/B正常ならS4以降へ進み、整理後に再開する", () => {
    const ctx = setup();
    setBalance(ctx, escrowHolderFor("orphan"), 100);
    sealOpening(ctx);

    const precheck = ctx.integrity.runStartupPrecheck();
    expect(precheck.ok).toBe(true);
    expect(precheck.checks.map((check) => check.id)).toEqual(["A", "B"]);

    const result = recoverCasino({
      db: ctx.db,
      status: ctx.status,
      integrity: ctx.integrity,
      chipTx: ctx.chipTx,
      escrow: ctx.escrow,
      reservations: ctx.reservations,
      registry: new RecoveryRegistry(),
      events: ctx.events,
    });
    expect(result.steps).toContain("S4:生存収集");
    expect(result.outcome).toBe("opened");
    expect(ctx.status.current().status).toBe("open");
  });

  it("recovery後のpostflightで残存する未知market statusがあれば営業再開しない", () => {
    const ctx = setup();
    insertMarket(ctx, 1, "mystery", "escrow", "alice", 100);
    sealOpening(ctx);

    expect(ctx.integrity.runStartupPrecheck().ok).toBe(true);
    const result = recoverCasino({
      db: ctx.db,
      status: ctx.status,
      integrity: ctx.integrity,
      chipTx: ctx.chipTx,
      escrow: ctx.escrow,
      reservations: ctx.reservations,
      registry: new RecoveryRegistry(),
      events: ctx.events,
    });
    expect(result.steps).toContain("S4:生存収集");
    expect(result.outcome).toBe("halted");
    expect(ctx.status.current().status).not.toBe("open");
    expect(result.reason).toContain("unknown_market_status");
  });
});
