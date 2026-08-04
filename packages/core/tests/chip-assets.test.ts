import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, ChipLedgerError } from "../src/casino/chip-ledger.js";
import {
  CasinoChipAssets,
  type EscrowAssetMismatchCode,
} from "../src/casino/chip-assets.js";
import { Escrow, escrowHolderFor } from "../src/casino/escrow.js";
import {
  MARKET_LIVE_STATUSES,
  Markets,
  marketEscrowHolder,
} from "../src/casino/market.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "../src/casino/free-spins.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(path = ":memory:", users: Record<string, number> = { alice: 20_000, bob: 20_000 }) {
  const db = openDb(path);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new ChipLedger(db, ledger, events);
  const escrow = new Escrow(db, chips, events);
  const markets = new Markets(db, chips, events);
  for (const [userId, amount] of Object.entries(users)) {
    ledger.ensureAccount(`user:${userId}`, "user");
    ledger.transfer({
      from: TREASURY,
      to: `user:${userId}`,
      amount,
      type: "initial",
      actor: "test",
      idempotencyKey: `fund:${userId}`,
    });
  }
  openFormally(chips.chipTx, ledger);
  for (const [userId, amount] of Object.entries(users)) {
    chips.deposit(userId, amount, `deposit:${userId}`);
  }
  return { db, ledger, events, chips, escrow, markets, assets: new CasinoChipAssets(db, chips) };
}

function createMarket(ctx: ReturnType<typeof setup>, creatorId = "alice", operationId = randomUUID()) {
  return ctx.markets.create({
    guildId: "g",
    creatorId,
    title: "AかBか",
    options: ["A", "B"],
    durationMin: 60,
    fee: 0,
    operationId,
  });
}

function codes(report: ReturnType<CasinoChipAssets["verifyEscrowed"]>): EscrowAssetMismatchCode[] {
  return report.mismatches.map((row) => row.code);
}

function expectCorrupt(op: () => unknown): void {
  try {
    op();
    throw new Error("expected ERR_CORRUPT_BALANCE");
  } catch (error) {
    expect(error).toBeInstanceOf(ChipLedgerError);
    expect((error as ChipLedgerError).code).toBe("ERR_CORRUPT_BALANCE");
  }
}

interface BareOptions {
  escrow?: boolean;
  markets?: boolean;
  bets?: boolean;
  marketColumns?: string;
  betColumns?: string;
  free?: number;
}

function bare(options: BareOptions = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id TEXT, kind TEXT);
    CREATE TABLE ether_balances (user_id TEXT, amount);
  `);
  db.prepare("INSERT INTO accounts (id, kind) VALUES ('user:alice', 'user'), ('user:bob', 'user')").run();
  db.prepare("INSERT INTO ether_balances (user_id, amount) VALUES ('alice', ?)").run(options.free ?? 0);
  if (options.escrow !== false) {
    db.exec("CREATE TABLE casino_escrow (session_id TEXT, user_id TEXT, amount, source TEXT)");
  }
  if (options.markets !== false) {
    db.exec(`CREATE TABLE casino_markets (${options.marketColumns ?? "id, status, fund_mode"})`);
  }
  if (options.bets !== false) {
    db.exec(`CREATE TABLE casino_market_bets (${options.betColumns ?? "market_id, user_id, amount"})`);
  }
  const chips = {
    freeChips(userId: string) {
      const row = db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(userId) as
        | { amount: number }
        | undefined;
      return row?.amount ?? 0;
    },
  } as unknown as ChipLedger;
  return { db, chips, assets: new CasinoChipAssets(db, chips) };
}

function insertSession(
  db: Database.Database,
  sessionId: string,
  userId: string,
  amount: number,
  source = escrowHolderFor(sessionId),
): void {
  db.prepare("INSERT INTO casino_escrow (session_id, user_id, amount, source) VALUES (?, ?, ?, ?)")
    .run(sessionId, userId, amount, source);
}

function insertBalance(db: Database.Database, holder: string, amount: number): void {
  db.prepare("INSERT INTO ether_balances (user_id, amount) VALUES (?, ?)").run(holder, amount);
}

function externalExec(path: string, sql: string): void {
  execFileSync(
    process.execPath,
    [
      "-e",
      [
        "const Database = require('better-sqlite3');",
        "const db = new Database(process.argv[1], { timeout: 5000 });",
        "db.pragma('journal_mode = WAL');",
        "db.pragma('busy_timeout = 5000');",
        "db.exec(process.argv[2]);",
        "db.close();",
      ].join(""),
      path,
      sql,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
}

function fileSetup() {
  const dir = mkdtempSync(join(tmpdir(), "chip-assets-"));
  tempDirs.push(dir);
  const path = join(dir, "casino.sqlite");
  return { path, ctx: setup(path, { alice: 20_000, bob: 20_000 }) };
}

function snapshotTables(db: Database.Database): string {
  const tables = [
    "ether_balances",
    "casino_escrow",
    "casino_market_bets",
    "casino_markets",
    "casino_tx",
    "casino_tx_groups",
    "transactions",
    "events",
    "casino_chip_opening_versions",
    "casino_house_reservations",
    "casino_status",
  ];
  return JSON.stringify(
    Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
    ),
  );
}

describe("CasinoChipAssets 基本分類", () => {
  it("自由チップのみを返す", () => {
    const ctx = setup();
    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 20_000,
      escrowed: 0,
      total: 20_000,
    });
  });

  it("卓・板・複数holder・複数利用者を本人別に合算する", () => {
    const ctx = setup();
    expect(ctx.escrow.hold("table:1", "alice", 2_000, "丁半", "hold:a1")).toBe(true);
    expect(ctx.escrow.hold("table:2", "alice", 1_000, "丁半", "hold:a2")).toBe(true);
    expect(ctx.escrow.hold("table:1", "bob", 500, "丁半", "hold:b1")).toBe(true);

    const market1 = createMarket(ctx, "alice", "market:create:1");
    const market2 = createMarket(ctx, "bob", "market:create:2");
    ctx.markets.bet(market1.id, "alice", 0, 3_000, "bet:a1");
    ctx.markets.bet(market1.id, "bob", 1, 700, "bet:b1");
    ctx.markets.bet(market2.id, "alice", 0, 400, "bet:a2");

    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 13_600,
      escrowed: 6_400,
      total: 20_000,
    });
    expect(ctx.assets.forUser("bob")).toEqual({
      userId: "bob",
      freeChips: 18_800,
      escrowed: 1_200,
      total: 20_000,
    });
    expect(ctx.assets.verifyEscrowed()).toEqual({ ok: true, mismatches: [] });
  });

  it("他人・house・JP・relief・quarantine・free-spin・system残高を本人資産へ入れない", () => {
    const ctx = setup();
    expect(ctx.escrow.hold("bob-only", "bob", 1_000, "丁半", "hold:bob")).toBe(true);
    for (const [holder, amount] of [
      ["house", 100],
      ["jackpot", 200],
      ["relief", 300],
      ["sys:escrow:quarantine", 400],
      [FREE_SPIN_JACKPOT_CLAIMS_HOLDER, 500],
      ["system:test", 600],
    ] as const) {
      ctx.db.prepare(
        `INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount`,
      ).run(holder, amount);
    }
    expect(ctx.assets.forUser("alice").escrowed).toBe(0);
  });

  it.each([
    "",
    " ",
    " alice",
    "alice ",
    "user:alice",
    "user:user:alice",
    "house",
    "jackpot",
    "relief",
    "sys:test",
    "system:test",
    "escrow:session:x",
  ])("不正な利用者ID %j を拒否する", (userId) => {
    const ctx = setup();
    expect(() => ctx.assets.freeChips(userId)).toThrowError(ChipLedgerError);
    expect(() => ctx.assets.forUser(userId)).toThrowError(ChipLedgerError);
  });
});

describe("本人帰属とlegacy", () => {
  it("source='house' の旧卓行を本人資産へ加えず明示的不一致にする", () => {
    const ctx = bare();
    insertSession(ctx.db, "legacy", "alice", 500, "house");
    const report = ctx.assets.verifyEscrowed();
    expect(codes(report)).toContain("invalid_legacy_source");
    expectCorrupt(() => ctx.assets.forUser("alice"));
  });

  it("canonical holder以外のsourceを推測配分しない", () => {
    const ctx = bare();
    insertSession(ctx.db, "x", "alice", 500, "escrow:session:y");
    expect(codes(ctx.assets.verifyEscrowed())).toContain("invalid_legacy_source");
  });

  it("利用者口座が無い台帳行を本人帰属にしない", () => {
    const ctx = bare();
    insertSession(ctx.db, "x", "ghost", 500);
    insertBalance(ctx.db, escrowHolderFor("x"), 500);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("invalid_user_id");
  });
});

describe("板statusの資金状態", () => {
  it("open/closed/reported/disputed/frozenだけを拘束中として集計し、settled/voidを除外する", () => {
    const ctx = bare();
    const statuses = [...MARKET_LIVE_STATUSES, "settled", "void"] as const;
    statuses.forEach((status, index) => {
      const id = index + 1;
      ctx.db.prepare("INSERT INTO casino_markets (id, status, fund_mode) VALUES (?, ?, 'escrow')")
        .run(id, status);
      ctx.db.prepare("INSERT INTO casino_market_bets (market_id, user_id, amount) VALUES (?, 'alice', 100)")
        .run(id);
      if ((MARKET_LIVE_STATUSES as readonly string[]).includes(status)) {
        insertBalance(ctx.db, marketEscrowHolder(id), 100);
      }
    });
    expect(ctx.assets.forUser("alice").escrowed).toBe(MARKET_LIVE_STATUSES.length * 100);
    expect(ctx.assets.verifyEscrowed().ok).toBe(true);
  });

  it.each(["cancelled", "refunded", "future_status"])("未知の終了状態 %s は0扱いせずfail-closed", (status) => {
    const ctx = bare();
    ctx.db.prepare("INSERT INTO casino_markets (id, status, fund_mode) VALUES (1, ?, 'escrow')").run(status);
    ctx.db.prepare("INSERT INTO casino_market_bets (market_id, user_id, amount) VALUES (1, 'alice', 100)").run();
    const report = ctx.assets.verifyEscrowed();
    expect(codes(report)).toContain("unknown_market_status");
    expectCorrupt(() => ctx.assets.forUser("alice"));
  });

  it("live legacy_house板はhouse混在勘定として利用者へ配分しない", () => {
    const ctx = bare();
    ctx.db.prepare("INSERT INTO casino_markets (id, status, fund_mode) VALUES (1, 'open', 'legacy_house')").run();
    ctx.db.prepare("INSERT INTO casino_market_bets (market_id, user_id, amount) VALUES (1, 'alice', 100)").run();
    expect(codes(ctx.assets.verifyEscrowed())).toContain("invalid_legacy_source");
  });
});

describe("双方向検算", () => {
  it.each([
    ["actualが1多い", 2_001],
    ["actualが1少ない", 1_999],
    ["実残高が無い", 0],
  ])("%s", (_label, actual) => {
    const ctx = setup();
    expect(ctx.escrow.hold("table:1", "alice", 2_000, "丁半", "hold")).toBe(true);
    ctx.db.prepare("UPDATE ether_balances SET amount = ? WHERE user_id = ?")
      .run(actual, escrowHolderFor("table:1"));
    const report = ctx.assets.verifyEscrowed();
    expect(codes(report)).toContain("balance_mismatch");
    expectCorrupt(() => ctx.assets.forUser("alice"));
  });

  it("帳簿0・actual正数のsession holderを検出する", () => {
    const ctx = bare();
    insertBalance(ctx.db, escrowHolderFor("orphan"), 100);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("missing_ledger_rows");
  });

  it("帳簿0・actual正数のmarket holderを検出する", () => {
    const ctx = bare();
    insertBalance(ctx.db, marketEscrowHolder(7), 100);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("missing_ledger_rows");
  });

  it("未知のescrow holderを利用者預託とみなさない", () => {
    const ctx = bare();
    insertBalance(ctx.db, "escrow:mystery:1", 100);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("unknown_escrow_holder");
  });

  it("同一market・userの複数行をduplicate ownershipとして検出する", () => {
    const ctx = bare();
    ctx.db.prepare("INSERT INTO casino_markets (id, status, fund_mode) VALUES (1, 'open', 'escrow')").run();
    ctx.db.prepare(
      "INSERT INTO casino_market_bets (market_id, user_id, amount) VALUES (1, 'alice', 100), (1, 'alice', 100)",
    ).run();
    insertBalance(ctx.db, marketEscrowHolder(1), 200);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("duplicate_ownership");
  });

  it("market行だけ孤立したbetを検出する", () => {
    const ctx = bare();
    ctx.db.prepare("INSERT INTO casino_market_bets (market_id, user_id, amount) VALUES (99, 'alice', 100)").run();
    expect(codes(ctx.assets.verifyEscrowed())).toContain("missing_ledger_rows");
  });

  it("session台帳だけでholder残高が無い状態を検出する", () => {
    const ctx = bare();
    insertSession(ctx.db, "x", "alice", 100);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("balance_mismatch");
  });
});

describe("数値破損とoverflow", () => {
  it.each([
    ["負数", -1],
    ["非整数", 1.5],
    ["safe範囲外", Number.MAX_SAFE_INTEGER + 1],
  ])("casino_escrow.amountの%sを拒否する", (_label, amount) => {
    const ctx = bare();
    insertSession(ctx.db, "bad", "alice", amount);
    insertBalance(ctx.db, escrowHolderFor("bad"), amount);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("corrupt_amount");
  });

  it("holder実残高の負数・非整数・safe範囲外を拒否する", () => {
    const ctx = bare();
    insertBalance(ctx.db, "escrow:session:negative", -1);
    insertBalance(ctx.db, "escrow:session:fraction", 1.5);
    insertBalance(ctx.db, "escrow:session:unsafe", Number.MAX_SAFE_INTEGER + 1);
    const report = ctx.assets.verifyEscrowed();
    expect(codes(report).filter((code) => code === "corrupt_amount")).toHaveLength(3);
  });

  it("holder別expectedの加算overflowを拒否する", () => {
    const ctx = bare();
    insertSession(ctx.db, "same", "alice", Number.MAX_SAFE_INTEGER);
    insertSession(ctx.db, "same", "bob", 1);
    insertBalance(ctx.db, escrowHolderFor("same"), Number.MAX_SAFE_INTEGER);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("corrupt_amount");
  });

  it("利用者別escrowedの加算overflowを拒否する", () => {
    const ctx = bare();
    insertSession(ctx.db, "one", "alice", Number.MAX_SAFE_INTEGER);
    insertSession(ctx.db, "two", "alice", 1);
    insertBalance(ctx.db, escrowHolderFor("one"), Number.MAX_SAFE_INTEGER);
    insertBalance(ctx.db, escrowHolderFor("two"), 1);
    expect(codes(ctx.assets.verifyEscrowed())).toContain("corrupt_amount");
  });

  it("freeChips + escrowedのoverflowを拒否する", () => {
    const ctx = bare({ free: Number.MAX_SAFE_INTEGER });
    insertSession(ctx.db, "one", "alice", 1);
    insertBalance(ctx.db, escrowHolderFor("one"), 1);
    expectCorrupt(() => ctx.assets.forUser("alice"));
  });
});

describe("旧DB・不完全schema", () => {
  it("market両tableなしはmarket預託0として読める", () => {
    const ctx = bare({ markets: false, bets: false });
    expect(ctx.assets.verifyEscrowed()).toEqual({ ok: true, mismatches: [] });
  });

  it.each([
    ["marketsのみ", { markets: true, bets: false }],
    ["betsのみ", { markets: false, bets: true }],
    ["markets列不足", { markets: true, bets: true, marketColumns: "id, status" }],
    ["bets列不足", { markets: true, bets: true, betColumns: "market_id, user_id" }],
  ] as const)("%sを検算不能にする", (_label, options) => {
    const ctx = bare({ ...options });
    expect(codes(ctx.assets.verifyEscrowed())).toContain("schema_incomplete");
  });

  it("casino_escrowのsource列が無い旧schemaを0扱いしない", () => {
    const ctx = bare({ escrow: false });
    ctx.db.exec("CREATE TABLE casino_escrow (session_id TEXT, user_id TEXT, amount)");
    expect(codes(ctx.assets.verifyEscrowed())).toContain("schema_incomplete");
  });
});

describe("別接続・別プロセスの読み取りスナップショット", () => {
  it("user→session移動中のforUserは移動前の一貫状態だけを返す", () => {
    const { path, ctx } = fileSetup();
    const original = ctx.chips.freeChips.bind(ctx.chips);
    let fired = false;
    vi.spyOn(ctx.chips, "freeChips").mockImplementation((userId) => {
      const value = original(userId);
      if (!fired) {
        fired = true;
        externalExec(
          path,
          `BEGIN IMMEDIATE;
           UPDATE ether_balances SET amount = amount - 2000 WHERE user_id = 'alice';
           INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('escrow:session:parallel', 2000, 0);
           INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at)
             VALUES ('parallel', 'alice', 2000, 'test', 'escrow:session:parallel', 0);
           COMMIT;`,
        );
      }
      return value;
    });
    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 20_000,
      escrowed: 0,
      total: 20_000,
    });
  });

  it("session refund中のforUserは移動前の一貫状態だけを返す", () => {
    const { path, ctx } = fileSetup();
    expect(ctx.escrow.hold("parallel", "alice", 2_000, "test", "hold")).toBe(true);
    const original = ctx.chips.freeChips.bind(ctx.chips);
    let fired = false;
    vi.spyOn(ctx.chips, "freeChips").mockImplementation((userId) => {
      const value = original(userId);
      if (!fired) {
        fired = true;
        externalExec(
          path,
          `BEGIN IMMEDIATE;
           UPDATE ether_balances SET amount = amount + 2000 WHERE user_id = 'alice';
           UPDATE ether_balances SET amount = 0 WHERE user_id = 'escrow:session:parallel';
           DELETE FROM casino_escrow WHERE session_id = 'parallel';
           COMMIT;`,
        );
      }
      return value;
    });
    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 18_000,
      escrowed: 2_000,
      total: 20_000,
    });
  });

  it("market bet中のforUserは移動前の一貫状態だけを返す", () => {
    const { path, ctx } = fileSetup();
    const market = createMarket(ctx, "alice", "parallel-market");
    const original = ctx.chips.freeChips.bind(ctx.chips);
    let fired = false;
    vi.spyOn(ctx.chips, "freeChips").mockImplementation((userId) => {
      const value = original(userId);
      if (!fired) {
        fired = true;
        externalExec(
          path,
          `BEGIN IMMEDIATE;
           UPDATE ether_balances SET amount = amount - 3000 WHERE user_id = 'alice';
           INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('escrow:market:${market.id}', 3000, 0);
           INSERT INTO casino_market_bets (market_id, user_id, option_index, amount, created_at)
             VALUES (${market.id}, 'alice', 0, 3000, 0);
           COMMIT;`,
        );
      }
      return value;
    });
    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice",
      freeChips: 20_000,
      escrowed: 0,
      total: 20_000,
    });
  });

  it("market settle中のverifyEscrowedも一つのスナップショットだけを見る", () => {
    const { path, ctx } = fileSetup();
    const market = createMarket(ctx, "alice", "parallel-settle");
    ctx.markets.bet(market.id, "alice", 0, 3_000, "parallel-bet");

    let fired = false;
    const wrappedDb = new Proxy(ctx.db, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (sql.includes("FROM ether_balances WHERE user_id LIKE 'escrow:%'")) {
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  if (statementProperty === "all") {
                    return (...args: unknown[]) => {
                      if (!fired) {
                        fired = true;
                        externalExec(
                          path,
                          `BEGIN IMMEDIATE;
                           UPDATE ether_balances SET amount = amount + 3000 WHERE user_id = 'alice';
                           UPDATE ether_balances SET amount = 0 WHERE user_id = 'escrow:market:${market.id}';
                           UPDATE casino_markets SET status = 'settled' WHERE id = ${market.id};
                           COMMIT;`,
                        );
                      }
                      return Reflect.apply(
                        statementTarget.all as (...values: unknown[]) => unknown[],
                        statementTarget,
                        args,
                      );
                    };
                  }
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                },
              });
            }
            return statement;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database.Database;

    const assets = new CasinoChipAssets(wrappedDb, ctx.chips);
    expect(assets.verifyEscrowed()).toEqual({ ok: true, mismatches: [] });
  });
});

describe("read-only保証", () => {
  it("正常DBで全APIを呼んでも対象tableが完全不変", () => {
    const ctx = setup();
    expect(ctx.escrow.hold("readonly", "alice", 500, "test", "hold")).toBe(true);
    const market = createMarket(ctx, "alice", "readonly-market");
    ctx.markets.bet(market.id, "alice", 0, 600, "readonly-bet");
    const before = snapshotTables(ctx.db);
    expect(ctx.assets.freeChips("alice")).toBe(18_900);
    expect(ctx.assets.escrowed("alice")).toBe(1_100);
    expect(ctx.assets.forUser("alice").total).toBe(20_000);
    expect(ctx.assets.verifyEscrowed().ok).toBe(true);
    expect(snapshotTables(ctx.db)).toBe(before);
  });

  it("不一致DBでも検算・例外は資金や状態を変更しない", () => {
    const ctx = setup();
    expect(ctx.escrow.hold("readonly-bad", "alice", 500, "test", "hold")).toBe(true);
    ctx.db.prepare("UPDATE ether_balances SET amount = 499 WHERE user_id = ?")
      .run(escrowHolderFor("readonly-bad"));
    const before = snapshotTables(ctx.db);
    expect(ctx.assets.verifyEscrowed().ok).toBe(false);
    expectCorrupt(() => ctx.assets.forUser("alice"));
    expect(snapshotTables(ctx.db)).toBe(before);
  });
});
