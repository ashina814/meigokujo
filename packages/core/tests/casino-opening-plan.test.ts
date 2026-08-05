import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { OpeningPlanner } from "../src/casino/opening-plan.js";
import { tableRowCount, schemaFingerprint } from "../src/casino/opening-canonical.js";

registerDefaultTxTypes();

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, ether, events);
  const chipAssets = new CasinoChipAssets(db, ether);
  const integrity = new CasinoIntegrity(db, ledger, ether, escrow, chipAssets);
  const status = new CasinoStatus(db);
  const settings = new Settings(db);
  const departments = new Departments(db, ledger);
  const planner = new OpeningPlanner({ db, ledger, chips: ether, chipAssets, integrity, status, settings, departments });
  return { db, ledger, events, chipTx, ether, escrow, chipAssets, integrity, status, settings, departments, planner };
}

type Ctx = ReturnType<typeof setup>;

/** legacy_pre_reset の窓を、旧取引fixtureで作る（casino-integrity.test.ts と同じ流儀） */
function seedLegacy(ctx: Ctx, opts: { aliceChips?: number; houseChips?: number } = {}): void {
  const aliceChips = opts.aliceChips ?? 0;
  const houseChips = opts.houseChips ?? 30_000;
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  if (aliceChips > 0) {
    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.transfer({ from: TREASURY, to: "user:alice", amount: 50_000, type: "initial", actor: "t", idempotencyKey: "seed:alice" });
    ctx.ledger.transfer({
      from: "user:alice", to: ETHER_ESCROW, amount: aliceChips, type: "ether_buy", actor: "user:alice",
      approvedBy: "system:ether", idempotencyKey: "legacy:buy:alice",
    });
  }
  ctx.ledger.transfer({
    from: deptAccount("賭博場"), to: ETHER_ESCROW, amount: houseChips, type: "ether_house_fund", actor: "system:ether",
    approvedBy: "system:ether", idempotencyKey: "legacy:fund:house",
  });
  const insert = ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)");
  if (aliceChips > 0) insert.run("alice", aliceChips);
  insert.run(HOUSE_HOLDER, houseChips);
  ctx.chipTx.captureLegacyOpening({
    poolLand: ctx.ledger.balanceOf(ETHER_ESCROW),
    fromLedgerTxId: ctx.ledger.lastTransactionId(),
  });
  ctx.departments.upsert("賭博場", "賭博場", null);
}

function configureAndOpenReset(ctx: Ctx): void {
  writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
  ctx.status.beginOpeningReset("テスト: 開業初期化準備", "test-admin");
}

describe("OpeningPlanner.dryRun — 読み取り専用性", () => {
  it("PRAGMA query_only=ON でも成功する", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.pragma("query_only = ON");
    expect(() => ctx.planner.dryRun()).not.toThrow();
    ctx.db.pragma("query_only = OFF");
  });

  it("dry-run前後で全テーブルのrow count・content hash・schema fingerprintが完全一致する", () => {
    const ctx = setup();
    seedLegacy(ctx, { aliceChips: 500 });
    configureAndOpenReset(ctx);

    const tablesBefore = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const countsBefore = Object.fromEntries(tablesBefore.map((t) => [t, tableRowCount(ctx.db, t)]));
    const schemaBefore = schemaFingerprint(ctx.db);
    const statusBefore = ctx.status.current();
    const maxLandTx = ctx.ledger.lastTransactionId();

    const result1 = ctx.planner.dryRun();
    const result2 = ctx.planner.dryRun();

    const tablesAfter = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const countsAfter = Object.fromEntries(tablesAfter.map((t) => [t, tableRowCount(ctx.db, t)]));
    const schemaAfter = schemaFingerprint(ctx.db);
    const statusAfter = ctx.status.current();

    expect(tablesAfter).toEqual(tablesBefore);
    expect(countsAfter).toEqual(countsBefore);
    expect(schemaAfter).toBe(schemaBefore);
    expect(statusAfter).toEqual(statusBefore);
    expect(ctx.ledger.lastTransactionId()).toBe(maxLandTx);
    // 2回呼んでも同じplan hash（副作用が無い証拠）
    expect(result1.planHash).toBe(result2.planHash);
  });

  it("constructorも含め、CREATE/INSERT/UPDATE/DELETEを一切行わない", () => {
    const ctx = setup();
    const before = ctx.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number };
    new OpeningPlanner({
      db: ctx.db, ledger: ctx.ledger, chips: ctx.ether, chipAssets: ctx.chipAssets,
      integrity: ctx.integrity, status: ctx.status, settings: ctx.settings, departments: ctx.departments,
    });
    const after = ctx.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("OpeningPlanner.dryRun — blocker検出", () => {
  it("設定未完了はblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    ctx.status.beginOpeningReset("test", "test");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "opening_config_invalid")).toBe(true);
  });

  it("status が opening_reset でなければblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "status_not_opening_reset")).toBe(true);
  });

  it("部署'賭博場'が存在しなければblocker", () => {
    const ctx = setup();
    // seedLegacyを使わず、部署未登録のまま
    ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test");
    ctx.status.beginOpeningReset("test", "test");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "department_missing")).toBe(true);
  });

  it("利用者本人保有の旧チップは保護資産としてblockerになり、時価Land換算値が付く", () => {
    const ctx = setup();
    seedLegacy(ctx, { aliceChips: 500 });
    configureAndOpenReset(ctx);
    const result = ctx.planner.dryRun();
    const finding = result.protectedFindings.find((f) => f.assetType === "legacy_chip_balance" && f.userId === "alice");
    expect(finding).toBeDefined();
    expect(finding?.estimatedCompensationLand).toBe(500);
    expect(result.blockers.some((b) => b.category === "protected_asset" && b.userId === "alice")).toBe(true);
  });

  it("有効VIPは保護資産としてblockerになり、金額は推測しない(null)", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec("CREATE TABLE IF NOT EXISTS casino_vip (user_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    ctx.db.prepare("INSERT INTO casino_vip (user_id, expires_at) VALUES ('bob', ?)").run(Math.floor(Date.now() / 1000) + 100_000);
    const result = ctx.planner.dryRun();
    const finding = result.protectedFindings.find((f) => f.assetType === "vip");
    expect(finding).toBeDefined();
    expect(finding?.estimatedCompensationLand).toBeNull();
  });

  it("正の株保有は保護資産としてblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(
      "CREATE TABLE IF NOT EXISTS casino_holdings (user_id TEXT, stock_id TEXT, shares INTEGER, avg_cost INTEGER, bought_at INTEGER, PRIMARY KEY(user_id, stock_id))",
    );
    ctx.db.prepare("INSERT INTO casino_holdings (user_id, stock_id, shares, avg_cost, bought_at) VALUES ('bob','X',10,1000,0)").run();
    const result = ctx.planner.dryRun();
    expect(result.protectedFindings.some((f) => f.assetType === "stock_holding")).toBe(true);
  });

  it("進行中のcasino_escrow行はblocker（PR11チンチロ事前預託も含む）", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    // 正式開業ロックのため escrow.hold() は legacy 版では素通しできない（fail-closed で false を返す）。
    // R5が拾うべき「残留した進行中預託」を直接fixtureとして作る。
    ctx.db
      .prepare(
        "INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES ('chinchiro:prehold:bob:op1','bob',100,'チンチロ','escrow:session:chinchiro:prehold:bob:op1',0)",
      )
      .run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "active_escrow_rows")).toBe(true);
  });

  it("PR10: pending external confirmationはblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_chip_external_confirmations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, operation_kind TEXT NOT NULL, operation_id TEXT NOT NULL,
        required_land INTEGER NOT NULL, chip_amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, created_at INTEGER, expires_at INTEGER, completed_at INTEGER
      );
    `);
    ctx.db.prepare(
      "INSERT INTO casino_chip_external_confirmations (id,user_id,operation_kind,operation_id,required_land,chip_amount,status,created_at,expires_at) VALUES ('c1','bob','leave','op1',100,100,'pending',0,1000)",
    ).run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "pending_external_confirmation" && b.userId === "bob")).toBe(true);
  });

  it("未知のcasino_*テーブルはblocker（推測で分類しない）", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec("CREATE TABLE casino_totally_unknown_table (id INTEGER PRIMARY KEY)");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unknown_table")).toBe(true);
    expect(result.unknownTables).toContain("casino_totally_unknown_table");
  });

  it("既にopening_v1が存在すればblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.chipTx.captureOpening("opening_v1", [["house", 100]], { poolLand: 100, fromLedgerTxId: ctx.ledger.lastTransactionId() });
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "already_opening_v1")).toBe(true);
  });

  it("開業元本に対して資金源(旧準備+部署)が不足していればblocker", () => {
    const ctx = setup();
    seedLegacy(ctx, { houseChips: 1_000 }); // 資金源が少ない
    writeCasinoOpeningConfig(ctx.settings, { ...VALID_CONFIG, openingCapital: 999_999_999, openingHouse: 999_999_999 - 8_000 - 2_000, openingJackpot: 8_000, openingRelief: 2_000 }, "test");
    ctx.status.beginOpeningReset("test", "test");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "insufficient_opening_source")).toBe(true);
  });

  it("保護資産・未知blockerが何もない状態ならblockersは空", () => {
    const ctx = setup();
    seedLegacy(ctx); // aliceChips=0, house only
    configureAndOpenReset(ctx);
    const result = ctx.planner.dryRun();
    expect(result.blockers).toEqual([]);
  });
});

describe("OpeningPlanner.dryRun — plan hash", () => {
  it("同じ状態なら同じhash、1 Ldの変化でhashが変わる", () => {
    const ctx1 = setup();
    seedLegacy(ctx1, { aliceChips: 100 });
    configureAndOpenReset(ctx1);
    const h1 = ctx1.planner.dryRun().planHash;

    const ctx2 = setup();
    seedLegacy(ctx2, { aliceChips: 101 });
    configureAndOpenReset(ctx2);
    const h2 = ctx2.planner.dryRun().planHash;

    expect(h1).not.toBe(h2);
  });

  it("同一状態を作り直しても同じhashになる（DB取得順・オブジェクトkey順に依存しない、固定時計）", () => {
    // captureLegacyOpening等が created_at に実時刻を刻むため、固定時計にしないと
    // 2回のbuild()がテスト実行中に秒をまたいだ場合だけ偶発的にhashが変わってしまう
    // （テストの都合上の話であり、実運用では同一DBのdryRun()を2回呼んでも状態自体が
    //  変化しない限りcreated_at列は変化しないので問題にならない）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const build = () => {
        const ctx = setup();
        seedLegacy(ctx, { aliceChips: 250 });
        configureAndOpenReset(ctx);
        return ctx.planner.dryRun().planHash;
      };
      expect(build()).toBe(build());
    } finally {
      vi.useRealTimers();
    }
  });
});
