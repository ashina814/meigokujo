import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { CasinoChipAssets, type EscrowAssetMismatchCode } from "../src/casino/chip-assets.js";
import { ChipLedger, ChipLedgerError } from "../src/casino/chip-ledger.js";
import { escrowHolderFor } from "../src/casino/escrow.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "../src/casino/free-spins.js";
import { MARKET_LIVE_STATUSES, marketEscrowHolder } from "../src/casino/market.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
  db.exec("INSERT INTO accounts VALUES ('user:alice','user'), ('user:bob','user')");
  db.prepare("INSERT INTO ether_balances VALUES ('alice', ?)").run(options.free ?? 10_000);
  db.prepare("INSERT INTO ether_balances VALUES ('bob', 10_000)").run();
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
    freeChips(userId: string): number {
      const row = db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(userId) as
        | { amount: number }
        | undefined;
      return row?.amount ?? 0;
    },
  } as unknown as ChipLedger;
  return { db, assets: new CasinoChipAssets(db, chips) };
}

function session(db: Database.Database, id: string, userId: string, amount: number, source = escrowHolderFor(id)) {
  db.prepare("INSERT INTO casino_escrow VALUES (?, ?, ?, ?)").run(id, userId, amount, source);
}

function market(db: Database.Database, id: number, status: string, amount: number, userId = "alice", mode = "escrow") {
  db.prepare("INSERT INTO casino_markets VALUES (?, ?, ?)").run(id, status, mode);
  db.prepare("INSERT INTO casino_market_bets VALUES (?, ?, ?)").run(id, userId, amount);
}

function balance(db: Database.Database, holder: string, amount: number) {
  db.prepare("INSERT INTO ether_balances VALUES (?, ?)").run(holder, amount);
}

function reportCodes(assets: CasinoChipAssets): EscrowAssetMismatchCode[] {
  return assets.verifyEscrowed().mismatches.map((row) => row.code);
}

function expectCorrupt(operation: () => unknown): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ChipLedgerError);
  expect((caught as ChipLedgerError).code).toBe("ERR_CORRUPT_BALANCE");
}

function full(path = ":memory:") {
  const db = openDb(path);
  const ledger = new Ledger(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  ledger.ensureAccount("user:alice", "user");
  ledger.ensureAccount("user:bob", "user");
  for (const userId of ["alice", "bob"]) {
    ledger.transfer({
      from: TREASURY,
      to: `user:${userId}`,
      amount: 20_000,
      type: "initial",
      actor: "test",
      idempotencyKey: `fund:${userId}`,
    });
  }
  openFormally(chips.chipTx, ledger);
  chips.deposit("alice", 20_000, "deposit:alice");
  chips.deposit("bob", 20_000, "deposit:bob");
  return { db, chips, assets: new CasinoChipAssets(db, chips) };
}

function moveToSession(ctx: ReturnType<typeof full>, id: string, userId: string, amount: number) {
  const holder = escrowHolderFor(id);
  ctx.chips.runGroup({ groupKey: `hold:${id}:${userId}`, kind: "table_hold", actorId: userId }, () => {
    ctx.chips.transfer(userId, holder, amount, { reason: "test hold", sessionId: id });
    ctx.db.prepare(
      "INSERT INTO casino_escrow (session_id,user_id,amount,game,source,created_at) VALUES (?,?,?,?,?,0)",
    ).run(id, userId, amount, "test", holder);
  });
}

function moveToMarket(ctx: ReturnType<typeof full>, id: number, userId: string, amount: number, status = "open") {
  const holder = marketEscrowHolder(id);
  ctx.chips.runGroup({ groupKey: `market:${id}:${userId}`, kind: "market_bet", actorId: userId }, () => {
    ctx.db.prepare(
      `INSERT INTO casino_markets
       (id,guild_id,creator_id,title,options_json,status,deadline_at,fee,payout_mode,fund_mode,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
    ).run(id, "g", userId, "test", '["A","B"]', status, 9999999999, 0, "parimutuel", "escrow");
    ctx.chips.transfer(userId, holder, amount, { reason: "test market", sessionId: `market:${id}` });
    ctx.db.prepare(
      "INSERT INTO casino_market_bets (market_id,user_id,option_index,amount,created_at) VALUES (?,?,0,?,0)",
    ).run(id, userId, amount);
  });
}

function externalExec(path: string, sql: string): void {
  execFileSync(process.execPath, [
    "-e",
    "const D=require('better-sqlite3');const d=new D(process.argv[1],{timeout:5000});d.pragma('journal_mode=WAL');d.exec(process.argv[2]);d.close()",
    path,
    sql,
  ], { cwd: process.cwd(), stdio: "pipe" });
}

function fileCtx() {
  const dir = mkdtempSync(join(tmpdir(), "chip-assets-"));
  tempDirs.push(dir);
  const path = join(dir, "db.sqlite");
  return { path, ctx: full(path) };
}

function tableSnapshot(db: Database.Database): string {
  const names = [
    "ether_balances", "casino_escrow", "casino_market_bets", "casino_markets",
    "casino_tx", "casino_tx_groups", "transactions", "events",
    "casino_chip_opening_versions", "casino_house_reservations", "casino_status",
  ];
  return JSON.stringify(Object.fromEntries(names.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()])));
}

describe("freeChips / escrowed / total", () => {
  it("自由のみ、卓のみ、板のみ、卓+板、複数利用者を本人別に合算する", () => {
    const ctx = bare();
    session(ctx.db, "s1", "alice", 2_000);
    session(ctx.db, "s1", "bob", 500);
    session(ctx.db, "s2", "alice", 1_000);
    balance(ctx.db, escrowHolderFor("s1"), 2_500);
    balance(ctx.db, escrowHolderFor("s2"), 1_000);
    market(ctx.db, 1, "open", 3_000);
    market(ctx.db, 2, "closed", 400);
    market(ctx.db, 3, "reported", 700, "bob");
    balance(ctx.db, marketEscrowHolder(1), 3_000);
    balance(ctx.db, marketEscrowHolder(2), 400);
    balance(ctx.db, marketEscrowHolder(3), 700);

    expect(ctx.assets.forUser("alice")).toEqual({
      userId: "alice", freeChips: 10_000, escrowed: 6_400, total: 16_400,
    });
    expect(ctx.assets.forUser("bob")).toEqual({
      userId: "bob", freeChips: 10_000, escrowed: 1_200, total: 11_200,
    });
    expect(ctx.assets.verifyEscrowed()).toEqual({ ok: true, mismatches: [] });
  });

  it("他人・house・jackpot・relief・quarantine・free-spin・systemを含めない", () => {
    const ctx = bare();
    session(ctx.db, "bob", "bob", 500);
    balance(ctx.db, escrowHolderFor("bob"), 500);
    for (const [holder, amount] of [
      ["house", 1], ["jackpot", 2], ["relief", 3], ["sys:escrow:quarantine", 4],
      [FREE_SPIN_JACKPOT_CLAIMS_HOLDER, 5], ["system:test", 6],
    ] as const) balance(ctx.db, holder, amount);
    expect(ctx.assets.forUser("alice").escrowed).toBe(0);
  });

  it.each([
    "", " ", " alice", "alice ", "user:alice", "user:user:alice",
    "house", "jackpot", "relief", "sys:test", "system:test", "escrow:session:x",
  ])("不正な利用者ID %j を拒否する", (userId) => {
    const ctx = bare();
    expect(() => ctx.assets.freeChips(userId)).toThrowError(ChipLedgerError);
    expect(() => ctx.assets.forUser(userId)).toThrowError(ChipLedgerError);
  });
});

describe("帰属・状態・双方向検算", () => {
  it("source='house'と未知sourceを本人へ推測配分しない", () => {
    const ctx = bare();
    session(ctx.db, "legacy", "alice", 100, "house");
    session(ctx.db, "wrong", "alice", 100, "escrow:session:other");
    expect(reportCodes(ctx.assets).filter((code) => code === "invalid_legacy_source")).toHaveLength(2);
    expectCorrupt(() => ctx.assets.forUser("alice"));
  });

  it("open/closed/reported/disputed/frozenだけを集計しsettled/voidを除外する", () => {
    const ctx = bare();
    [...MARKET_LIVE_STATUSES, "settled", "void"].forEach((status, index) => {
      const id = index + 1;
      market(ctx.db, id, status, 100);
      if ((MARKET_LIVE_STATUSES as readonly string[]).includes(status)) balance(ctx.db, marketEscrowHolder(id), 100);
    });
    expect(ctx.assets.forUser("alice").escrowed).toBe(MARKET_LIVE_STATUSES.length * 100);
  });

  it.each(["cancelled", "refunded", "future"])("未知status %sを0扱いしない", (status) => {
    const ctx = bare();
    market(ctx.db, 1, status, 100);
    expect(reportCodes(ctx.assets)).toContain("unknown_market_status");
  });

  it("live legacy_house板を本人資産へ配分しない", () => {
    const ctx = bare();
    market(ctx.db, 1, "open", 100, "alice", "legacy_house");
    expect(reportCodes(ctx.assets)).toContain("invalid_legacy_source");
  });

  it.each([2_001, 1_999, 0])("actual=%dの帳簿→実残高不一致を検出する", (actual) => {
    const ctx = bare();
    session(ctx.db, "s", "alice", 2_000);
    balance(ctx.db, escrowHolderFor("s"), actual);
    expect(reportCodes(ctx.assets)).toContain("balance_mismatch");
  });

  it("帳簿なしsession/market、unknown holderを実残高→帳簿で検出する", () => {
    const ctx = bare();
    balance(ctx.db, escrowHolderFor("orphan"), 100);
    balance(ctx.db, marketEscrowHolder(9), 100);
    balance(ctx.db, "escrow:mystery:1", 100);
    const codes = reportCodes(ctx.assets);
    expect(codes.filter((code) => code === "missing_ledger_rows")).toHaveLength(2);
    expect(codes).toContain("unknown_escrow_holder");
  });

  it("duplicate ownership、孤立bet、session台帳のみを検出する", () => {
    const ctx = bare();
    market(ctx.db, 1, "open", 100);
    ctx.db.prepare("INSERT INTO casino_market_bets VALUES (1,'alice',100)").run();
    balance(ctx.db, marketEscrowHolder(1), 200);
    ctx.db.prepare("INSERT INTO casino_market_bets VALUES (99,'alice',100)").run();
    session(ctx.db, "ledger-only", "alice", 100);
    const codes = reportCodes(ctx.assets);
    expect(codes).toContain("duplicate_ownership");
    expect(codes).toContain("missing_ledger_rows");
    expect(codes).toContain("balance_mismatch");
  });
});

describe("数値破損とschema", () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("session amount %dを拒否する", (amount) => {
    const ctx = bare();
    session(ctx.db, "bad", "alice", amount);
    balance(ctx.db, escrowHolderFor("bad"), amount);
    expect(reportCodes(ctx.assets)).toContain("corrupt_amount");
  });

  it("actualの負数・小数・unsafeを拒否する", () => {
    const ctx = bare();
    balance(ctx.db, "escrow:session:a", -1);
    balance(ctx.db, "escrow:session:b", 1.5);
    balance(ctx.db, "escrow:session:c", Number.MAX_SAFE_INTEGER + 1);
    expect(reportCodes(ctx.assets).filter((code) => code === "corrupt_amount")).toHaveLength(3);
  });

  it("holder合算・利用者合算・totalのoverflowを拒否する", () => {
    const holder = bare();
    session(holder.db, "same", "alice", Number.MAX_SAFE_INTEGER);
    session(holder.db, "same", "bob", 1);
    balance(holder.db, escrowHolderFor("same"), Number.MAX_SAFE_INTEGER);
    expect(reportCodes(holder.assets)).toContain("corrupt_amount");

    const user = bare();
    session(user.db, "one", "alice", Number.MAX_SAFE_INTEGER);
    session(user.db, "two", "alice", 1);
    balance(user.db, escrowHolderFor("one"), Number.MAX_SAFE_INTEGER);
    balance(user.db, escrowHolderFor("two"), 1);
    expect(reportCodes(user.assets)).toContain("corrupt_amount");

    const total = bare({ free: Number.MAX_SAFE_INTEGER });
    session(total.db, "one", "alice", 1);
    balance(total.db, escrowHolderFor("one"), 1);
    expectCorrupt(() => total.assets.forUser("alice"));
  });

  it("market両tableなしだけを0件として許可し、片側・列不足はfail-closed", () => {
    expect(bare({ markets: false, bets: false }).assets.verifyEscrowed().ok).toBe(true);
    for (const options of [
      { markets: true, bets: false },
      { markets: false, bets: true },
      { marketColumns: "id,status" },
      { betColumns: "market_id,user_id" },
    ]) expect(reportCodes(bare(options).assets)).toContain("schema_incomplete");
  });

  it("source列の無いcasino_escrowを0件扱いしない", () => {
    const ctx = bare({ escrow: false });
    ctx.db.exec("CREATE TABLE casino_escrow (session_id,user_id,amount)");
    expect(reportCodes(ctx.assets)).toContain("schema_incomplete");
  });
});

describe("別接続・別プロセスの一貫スナップショット", () => {
  it("user→session移動とrefund中のforUserは移動前だけを見る", () => {
    const first = fileCtx();
    const original = first.ctx.chips.freeChips.bind(first.ctx.chips);
    vi.spyOn(first.ctx.chips, "freeChips").mockImplementation((userId) => {
      const value = original(userId);
      externalExec(first.path, `BEGIN IMMEDIATE;
        UPDATE ether_balances SET amount=18000 WHERE user_id='alice';
        INSERT INTO ether_balances VALUES ('escrow:session:p',2000,0);
        INSERT INTO casino_escrow VALUES ('p','alice',2000,'test','escrow:session:p',0);
        COMMIT;`);
      return value;
    });
    expect(first.ctx.assets.forUser("alice")).toEqual({
      userId: "alice", freeChips: 20_000, escrowed: 0, total: 20_000,
    });

    const second = fileCtx();
    moveToSession(second.ctx, "p", "alice", 2_000);
    const original2 = second.ctx.chips.freeChips.bind(second.ctx.chips);
    vi.spyOn(second.ctx.chips, "freeChips").mockImplementation((userId) => {
      const value = original2(userId);
      externalExec(second.path, `BEGIN IMMEDIATE;
        UPDATE ether_balances SET amount=20000 WHERE user_id='alice';
        UPDATE ether_balances SET amount=0 WHERE user_id='escrow:session:p';
        DELETE FROM casino_escrow WHERE session_id='p';
        COMMIT;`);
      return value;
    });
    expect(second.ctx.assets.forUser("alice")).toEqual({
      userId: "alice", freeChips: 18_000, escrowed: 2_000, total: 20_000,
    });
  });

  it("market bet中のforUserとsettle中のverifyも一貫状態だけを見る", () => {
    const betting = fileCtx();
    betting.ctx.db.prepare(
      `INSERT INTO casino_markets
       (id,guild_id,creator_id,title,options_json,status,deadline_at,fee,payout_mode,fund_mode,created_at)
       VALUES (1,'g','alice','t','["A","B"]','open',9999999999,0,'parimutuel','escrow',0)`,
    ).run();
    const original = betting.ctx.chips.freeChips.bind(betting.ctx.chips);
    vi.spyOn(betting.ctx.chips, "freeChips").mockImplementation((userId) => {
      const value = original(userId);
      externalExec(betting.path, `BEGIN IMMEDIATE;
        UPDATE ether_balances SET amount=17000 WHERE user_id='alice';
        INSERT INTO ether_balances VALUES ('escrow:market:1',3000,0);
        INSERT INTO casino_market_bets VALUES (1,'alice',0,3000,0);
        COMMIT;`);
      return value;
    });
    expect(betting.ctx.assets.forUser("alice").total).toBe(20_000);

    const settling = fileCtx();
    moveToMarket(settling.ctx, 1, "alice", 3_000);
    let fired = false;
    const wrapped = new Proxy(settling.ctx.db, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM ether_balances WHERE user_id LIKE 'escrow:%'")) return statement;
          return new Proxy(statement, {
            get(stmt, prop) {
              if (prop === "all") return (...args: unknown[]) => {
                if (!fired) {
                  fired = true;
                  externalExec(settling.path, `BEGIN IMMEDIATE;
                    UPDATE ether_balances SET amount=20000 WHERE user_id='alice';
                    UPDATE ether_balances SET amount=0 WHERE user_id='escrow:market:1';
                    UPDATE casino_markets SET status='settled' WHERE id=1;
                    COMMIT;`);
                }
                return Reflect.apply(stmt.all as (...values: unknown[]) => unknown[], stmt, args);
              };
              const value = Reflect.get(stmt, prop, stmt);
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          });
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database.Database;
    expect(new CasinoChipAssets(wrapped, settling.ctx.chips).verifyEscrowed().ok).toBe(true);
  });
});

describe("read-only保証", () => {
  it("正常・不一致DBの全APIが資金・帳簿・状態を変更しない", () => {
    const ctx = full();
    moveToSession(ctx, "readonly", "alice", 500);
    moveToMarket(ctx, 1, "alice", 600);
    const before = tableSnapshot(ctx.db);
    expect(ctx.assets.freeChips("alice")).toBe(18_900);
    expect(ctx.assets.escrowed("alice")).toBe(1_100);
    expect(ctx.assets.forUser("alice").total).toBe(20_000);
    expect(ctx.assets.verifyEscrowed().ok).toBe(true);
    expect(tableSnapshot(ctx.db)).toBe(before);

    ctx.db.prepare("UPDATE ether_balances SET amount=499 WHERE user_id=?").run(escrowHolderFor("readonly"));
    const corruptBefore = tableSnapshot(ctx.db);
    expect(ctx.assets.verifyEscrowed().ok).toBe(false);
    expectCorrupt(() => ctx.assets.forUser("alice"));
    expect(tableSnapshot(ctx.db)).toBe(corruptBefore);
  });
});
