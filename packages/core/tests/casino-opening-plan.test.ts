import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino } from "../src/casino/service.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { OpeningPlanner } from "../src/casino/opening-plan.js";
import { tableRowCount, schemaFingerprint } from "../src/casino/opening-canonical.js";
import { classificationFor } from "../src/casino/opening-tables.js";

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

  it("quarantine残高が正ならblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('sys:escrow:quarantine', 500, 0)").run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "quarantine_nonzero")).toBe(true);
  });

  it("未精算の無料スピン(pending free spin)はblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_pending_free_spins (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        spin_no INTEGER NOT NULL, bet INTEGER NOT NULL, source_group TEXT NOT NULL,
        status TEXT NOT NULL, reels_json TEXT NOT NULL, jackpot_claim INTEGER DEFAULT 0
      );
    `);
    ctx.db.prepare(
      "INSERT INTO casino_pending_free_spins (user_id, operation_id, spin_no, bet, source_group, status, reels_json, jackpot_claim) VALUES ('bob','op1',1,100,'g1','pending','[]',0)",
    ).run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "pending_free_spin" && b.userId === "bob")).toBe(true);
  });

  it("進行中のcasino_house_reservationsはblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_house_reservations (
        key TEXT PRIMARY KEY, amount INTEGER NOT NULL, game TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    ctx.db.prepare("INSERT INTO casino_house_reservations (key, amount, game, user_id, created_at) VALUES ('r1', 100, 'スロット', 'bob', 0)").run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "active_house_reservations")).toBe(true);
  });

  it("未終局な板(casino_markets)はblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_markets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, creator_id TEXT, title TEXT, options_json TEXT,
        deadline_at INTEGER, status TEXT NOT NULL DEFAULT 'open', result_option INTEGER, channel_id TEXT, message_id TEXT, created_at INTEGER
      );
    `);
    ctx.db.prepare("INSERT INTO casino_markets (title, status, created_at) VALUES ('テスト板','open',0)").run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "live_market_row")).toBe(true);
  });

  it("正の戦績(casino_stats)は保護資産としてblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_stats (
        user_id TEXT PRIMARY KEY, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0, total_wagered INTEGER NOT NULL DEFAULT 0, total_earned INTEGER NOT NULL DEFAULT 0,
        total_lost INTEGER NOT NULL DEFAULT 0, biggest_win INTEGER NOT NULL DEFAULT 0,
        current_win_streak INTEGER NOT NULL DEFAULT 0, best_win_streak INTEGER NOT NULL DEFAULT 0,
        current_lose_streak INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
    `);
    ctx.db.prepare(
      "INSERT INTO casino_stats (user_id, games, total_wagered, total_earned, total_lost, biggest_win, best_win_streak, updated_at) VALUES ('bob',5,500,300,200,100,2,0)",
    ).run();
    const result = ctx.planner.dryRun();
    expect(result.protectedFindings.some((f) => f.assetType === "casino_stats" && f.userId === "bob")).toBe(true);
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

});

describe("OpeningPlanner.dryRun — PR10未完了義務のwhitelist方式判定(監査ブロッカー2)", () => {
  // casino_chip_external_confirmations / casino_chip_refund_sagas / casino_chip_refund_saga_targets は
  // packages/core/src/db/bootstrap.ts のDDLに既に存在する（openDb()の時点で作成済み）ため、
  // ここで独自のCREATE TABLEを重ねない（CREATE TABLE IF NOT EXISTSは無条件で無視され、
  // 実際にはbootstrap側のCHECK制約付きschemaがそのまま使われる）。挿入時は実schemaの
  // NOT NULL/CHECK制約（target_count/target_total必須、amount>0、group_key必須等）に従う。
  let sagaTargetSeq = 0;
  function insertRefundSaga(ctx: Ctx, id: string, status: string, extra: { failureJson?: string | null } = {}): void {
    ctx.db.prepare(
      "INSERT INTO casino_chip_refund_sagas (id,scope,requested_by,target_user_id,status,target_count,target_total,created_at,failure_json) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(id, "user", "admin", "bob", status, 1, 100, 0, extra.failureJson ?? null);
  }
  function insertRefundSagaTarget(
    ctx: Ctx,
    sagaId: string,
    userId: string,
    status: string,
    extra: { resultJson?: string | null; failure?: string | null } = {},
  ): void {
    sagaTargetSeq++;
    ctx.db.prepare(
      "INSERT INTO casino_chip_refund_saga_targets (saga_id,user_id,amount,status,group_key,result_json,failure) VALUES (?,?,?,?,?,?,?)",
    ).run(sagaId, userId, 100, status, `group-${sagaTargetSeq}`, extra.resultJson ?? null, extra.failure ?? null);
  }
  function insertExternalConfirmation(ctx: Ctx, id: string, userId: string, status: string): void {
    ctx.db.prepare(
      "INSERT INTO casino_chip_external_confirmations (id,user_id,operation_kind,operation_id,required_land,chip_amount,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(id, userId, "leave", `op-${id}`, 100, 100, status, 0, 1000);
  }

  /**
   * bootstrap.tsのschemaはstatusにCHECK制約を持つため、通常のINSERTでは
   * schema許容集合外の値をそもそも作れない（=DB層で既に強く守られている）。
   * これは「古いDB・移行前の行に未知statusが残っている」ケースを模したもので、
   * 現行のCHECK制約より緩い（=CHECK無し）版へテスト用に差し替えて未知値を作る。
   */
  function dropStatusCheck(ctx: Ctx, table: string, createSql: string): void {
    ctx.db.exec(`DROP TABLE IF EXISTS ${table}; ${createSql}`);
  }

  function withMarketsTable(ctx: Ctx): void {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_markets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, creator_id TEXT, title TEXT, options_json TEXT,
        deadline_at INTEGER, status TEXT NOT NULL DEFAULT 'open', result_option INTEGER, channel_id TEXT, message_id TEXT, created_at INTEGER
      );
    `);
  }
  function withFreeSpinsTable(ctx: Ctx): void {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_pending_free_spins (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        spin_no INTEGER NOT NULL, bet INTEGER NOT NULL, source_group TEXT NOT NULL,
        status TEXT NOT NULL, reels_json TEXT NOT NULL, jackpot_claim INTEGER DEFAULT 0
      );
    `);
  }

  it("refund saga: status='blocked'は見落とされずblocker(旧実装の見落とし回帰)", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    insertRefundSaga(ctx, "s1", "blocked");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unfinished_refund_saga")).toBe(true);
  });

  it("refund saga target: status='failed'/'blocked'は見落とされずblocker(旧実装の見落とし回帰)", () => {
    for (const status of ["failed", "blocked"]) {
      const ctx = setup();
      seedLegacy(ctx);
      configureAndOpenReset(ctx);
      insertRefundSaga(ctx, "s1", "executing"); // FK親行(targetのsaga_idが参照する)
      insertRefundSagaTarget(ctx, "s1", "bob", status);
      const result = ctx.planner.dryRun();
      expect(result.blockers.some((b) => b.code === "unfinished_refund_saga_target" && b.userId === "bob"), `status=${status}`).toBe(true);
    }
  });

  it("external confirmation: schema許容集合外の未知statusはunknown_statusとしてfail-closed(旧DBの移行残り相当)", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    dropStatusCheck(
      ctx,
      "casino_chip_external_confirmations",
      `CREATE TABLE casino_chip_external_confirmations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, operation_kind TEXT NOT NULL, operation_id TEXT NOT NULL,
        required_land INTEGER NOT NULL, chip_amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, created_at INTEGER, expires_at INTEGER, completed_at INTEGER
      )`,
    );
    insertExternalConfirmation(ctx, "c1", "bob", "totally_unknown");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unknown_status_external_confirmation" && b.userId === "bob")).toBe(true);
  });

  it("refund saga: schema許容集合外の未知statusはunknown_statusとしてfail-closed(旧DBの移行残り相当)", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    dropStatusCheck(
      ctx,
      "casino_chip_refund_sagas",
      `CREATE TABLE casino_chip_refund_sagas (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, requested_by TEXT NOT NULL, target_user_id TEXT,
        status TEXT NOT NULL, target_count INTEGER NOT NULL DEFAULT 0, target_total INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER, started_at INTEGER, completed_at INTEGER, failure_json TEXT
      )`,
    );
    insertRefundSaga(ctx, "s1", "totally_unknown");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unknown_status_refund_saga")).toBe(true);
  });

  it("refund saga target: schema許容集合外の未知statusはunknown_statusとしてfail-closed(旧DBの移行残り相当)", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    insertRefundSaga(ctx, "s1", "executing"); // FK親行(CHECKは緩めない。親テーブルは通常schemaのまま)
    dropStatusCheck(
      ctx,
      "casino_chip_refund_saga_targets",
      `CREATE TABLE casino_chip_refund_saga_targets (
        saga_id TEXT NOT NULL, user_id TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, group_key TEXT, result_json TEXT, failure TEXT, completed_at INTEGER,
        PRIMARY KEY (saga_id, user_id)
      )`,
    );
    insertRefundSagaTarget(ctx, "s1", "bob", "totally_unknown");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unknown_status_refund_saga_target" && b.userId === "bob")).toBe(true);
  });

  it("pending free spin: schema許容集合外の未知statusはunknown_statusとしてfail-closed", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    withFreeSpinsTable(ctx);
    ctx.db.prepare(
      "INSERT INTO casino_pending_free_spins (user_id,operation_id,spin_no,bet,source_group,status,reels_json) VALUES ('bob','op1',1,100,'g1','totally_unknown','[]')",
    ).run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unknown_status_pending_free_spin" && b.userId === "bob")).toBe(true);
  });

  it("market: schema許容集合外の未知statusはunknown_statusとしてfail-closed", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    withMarketsTable(ctx);
    ctx.db.prepare("INSERT INTO casino_markets (title, status, created_at) VALUES ('板','totally_unknown',0)").run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unknown_status_market")).toBe(true);
  });

  it("refund saga: status='completed'でもfailure_jsonが破損していれば正常・完了として扱わずblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    insertRefundSaga(ctx, "s1", "completed", { failureJson: "{not valid json" });
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "corrupt_json_refund_saga")).toBe(true);
  });

  it("refund saga target: status='completed'でもresult_json/failureが破損していれば正常・完了として扱わずblocker", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    insertRefundSaga(ctx, "s1", "executing"); // FK親行
    insertRefundSagaTarget(ctx, "s1", "bob", "completed", { resultJson: "{not valid json" });
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "corrupt_json_refund_saga_target" && b.userId === "bob")).toBe(true);
  });

  it("正常終端(completed/cancelled/settled/void等)のみの状態ならPR10 blockerは出ない", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    withMarketsTable(ctx);
    withFreeSpinsTable(ctx);
    insertExternalConfirmation(ctx, "c1", "bob", "completed");
    insertRefundSaga(ctx, "s1", "completed");
    insertRefundSagaTarget(ctx, "s1", "bob", "completed");
    ctx.db.prepare("INSERT INTO casino_markets (title, status, created_at) VALUES ('板','settled',0)").run();
    ctx.db.prepare(
      "INSERT INTO casino_pending_free_spins (user_id,operation_id,spin_no,bet,source_group,status,reels_json) VALUES ('bob','op1',1,100,'g1','settled','[]')",
    ).run();
    const result = ctx.planner.dryRun();
    expect(result.blockers.filter((b) => b.category === "pr10_obligation" || b.category === "market")).toEqual([]);
  });
});

describe("OpeningPlanner.dryRun — 未知テーブル・その他blocker", () => {
  it("未知のcasino_*テーブルはblocker（推測で分類しない）", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec("CREATE TABLE casino_totally_unknown_table (id INTEGER PRIMARY KEY)");
    const result = ctx.planner.dryRun();
    expect(result.blockers.some((b) => b.code === "unknown_table")).toBe(true);
    expect(result.unknownTables).toContain("casino_totally_unknown_table");
  });

  it("Casino生成済みのcasino_home_preferencesは未知テーブルにも保護資産にもならない", () => {
    const ctx = setup();
    new Casino(ctx.db, ctx.ether, ctx.events);
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db
      .prepare("INSERT INTO casino_home_preferences (user_id, last_game, last_amount, updated_at) VALUES (?, ?, ?, ?)")
      .run("alice", "スロット", 100, 1);

    const result = ctx.planner.dryRun();

    expect(result.unknownTables).not.toContain("casino_home_preferences");
    expect(result.blockers).toEqual([]);
    expect(result.protectedFindings.some((f) => f.sourceTable === "casino_home_preferences")).toBe(false);
    expect(result.tableAudits.find((a) => a.table === "casino_home_preferences")).toMatchObject({
      exists: true,
      rows: 1,
    });
  });

  it("casino_metric_events / casino_metric_daily は未知テーブルにも保護資産にもならない", () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(`
      CREATE TABLE casino_metric_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        user_id TEXT,
        game TEXT,
        source TEXT,
        operation_id TEXT,
        wager INTEGER,
        payout INTEGER,
        net INTEGER,
        amount INTEGER,
        payload_json TEXT,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE casino_metric_daily (
        date TEXT PRIMARY KEY,
        play_count INTEGER NOT NULL DEFAULT 0,
        unique_users INTEGER NOT NULL DEFAULT 0,
        total_wager INTEGER NOT NULL DEFAULT 0,
        total_payout INTEGER NOT NULL DEFAULT 0,
        house_pnl INTEGER NOT NULL DEFAULT 0,
        table_fee_income INTEGER NOT NULL DEFAULT 0,
        jackpot_delta INTEGER NOT NULL DEFAULT 0,
        fuku_outflow INTEGER NOT NULL DEFAULT 0,
        table_open_count INTEGER NOT NULL DEFAULT 0,
        table_start_count INTEGER NOT NULL DEFAULT 0,
        table_dispute_count INTEGER NOT NULL DEFAULT 0,
        replay_rate_bps INTEGER,
        revisit_rate_bps INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    ctx.db
      .prepare("INSERT INTO casino_metric_events (event_key, event_type, user_id, occurred_at, created_at) VALUES ('home_open:test','home_open','alice',1,1)")
      .run();
    ctx.db.prepare("INSERT INTO casino_metric_daily (date, updated_at) VALUES ('2026-01-01', 1)").run();

    const result = ctx.planner.dryRun();

    expect(result.unknownTables).not.toContain("casino_metric_events");
    expect(result.unknownTables).not.toContain("casino_metric_daily");
    expect(result.blockers).toEqual([]);
    expect(result.protectedFindings.some((f) => f.sourceTable === "casino_metric_events" || f.sourceTable === "casino_metric_daily")).toBe(false);
  });

  it("casino_nagareboshi is classified as resettable transient data and participates in the plan hash", () => {
    const classification = classificationFor("casino_nagareboshi");
    expect(classification).toMatchObject({
      kind: "optional_feature",
      archive: true,
      resetOnApply: true,
      resetPhase: "R6",
      preserve: false,
    });
    expect(classification?.includeInPlanHash).toBeUndefined();

    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_nagareboshi (
        user_id TEXT NOT NULL,
        day_key TEXT NOT NULL,
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day_key)
      );
    `);
    ctx.db.prepare("INSERT INTO casino_nagareboshi (user_id, day_key, count) VALUES ('alice', '2026-08-09', 1)").run();

    const first = ctx.planner.dryRun();
    expect(first.unknownTables).not.toContain("casino_nagareboshi");
    expect(first.blockers).toEqual([]);
    expect(first.protectedFindings.some((f) => f.sourceTable === "casino_nagareboshi")).toBe(false);
    expect(first.tableAudits.find((a) => a.table === "casino_nagareboshi")).toMatchObject({ exists: true, rows: 1 });

    ctx.db.prepare("UPDATE casino_nagareboshi SET count = 2 WHERE user_id = 'alice' AND day_key = '2026-08-09'").run();
    const second = ctx.planner.dryRun();
    expect(second.planHash).not.toBe(first.planHash);
  });

  it("source-created casino_* tables are represented in the opening classification table", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const srcRoots = [join(repoRoot, "packages", "core", "src"), join(repoRoot, "apps", "bot", "src")];
    const discovered = new Set<string>();
    const createTable = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:[`"])?(casino_[A-Za-z0-9_]+)/gi;

    function visit(dir: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          visit(full);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(createTable)) {
          const table = match[1]!;
          if (table.endsWith("_new")) continue;
          discovered.add(table);
        }
      }
    }

    for (const root of srcRoots) visit(root);
    const missing = [...discovered].filter((table) => !classificationFor(table)).sort();
    expect(missing).toEqual([]);
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
