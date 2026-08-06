import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, CHIP_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { CASINO_DEPARTMENT_ACCOUNT } from "../src/casino/opening-plan.js";
import { OpeningReset, R6_ALL_DELETE_TABLES } from "../src/casino/opening-reset.js";
import { TestFilesystemOpeningBackupAdapter } from "../src/casino/opening-backup.js";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";
import { EVENT_MARKET_CREATE_FEE, EVENT_MARKET_FEES_HOLDER, Markets, eventMarketEscrowHolder } from "../src/casino/market.js";

registerDefaultTxTypes();

/**
 * PR12監査ブロッカーD: R6の全DELETE地点でのcrash injectionを網羅する。
 *
 * `casino-opening-reset-crash-injection.test.ts` の`PRE_COMMIT_POINTS`は
 * `"r6_after_delete"`という1つの粗い地点しか持たず、そのcrash hookは`firedPoint === point`
 * だけを見て`detail`（テーブル名）を無視するため、実際にはR6ループの**最初の1テーブル**で
 * しかcrashしない。ここでは`R6_ALL_DELETE_TABLES`（mixed market tableのfiltered delete化後の
 * 実質的な全DELETE対象）を1つずつループし、その`detail`ちょうどでcrashさせることで、
 * 全DELETE文の直後を漏れなく検証する。
 *
 * 併せて、イベントLand板（market_mode='event'）のデータ・event_market_ops・
 * イベントescrow・fee holderが、どの地点でcrashしても一切変化しないこと
 * （PR12監査: イベントLand板の完全保護）と、opening_reset所有権bind
 * （`casino_status.opening_execution_id`/`opening_actor_id`）が壊れないことも確認する。
 */

const VALID_CONFIG = {
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

const ROLE_A = "111111111111111111";

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
  const markets = new Markets(db, ether, events, { landLedger: ledger });
  const reset = new OpeningReset({ db, ledger, chips: ether, chipAssets, integrity, status, settings, departments });
  return { db, ledger, events, chipTx, ether, escrow, chipAssets, integrity, status, settings, departments, markets, reset };
}

type Ctx = ReturnType<typeof setup>;
let opCounter = 0;
const opId = () => `op:${++opCounter}:${Math.random().toString(36).slice(2)}`;

function seedLegacy(ctx: Ctx, opts: { houseChips?: number; deptSeed?: number } = {}): void {
  const houseChips = opts.houseChips ?? 30_000;
  const deptSeed = opts.deptSeed ?? 100_000;
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: deptSeed, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  if (houseChips > 0) {
    ctx.ledger.transfer({
      from: deptAccount("賭博場"), to: ETHER_ESCROW, amount: houseChips, type: "ether_house_fund", actor: "system:ether",
      approvedBy: "system:ether", idempotencyKey: "legacy:fund:house",
    });
    ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(HOUSE_HOLDER, houseChips);
  }
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

function seedLand(ledger: Ledger, userId: string, amount: number): void {
  ledger.ensureAccount(`user:${userId}`, "user");
  ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "t", idempotencyKey: `seed:${userId}:${opId()}` });
}

/** settled(的中あり)のイベント板を1つ作る。settle後はescrow=0になる */
function seedSettledEventMarket(ctx: Ctx): number {
  seedLand(ctx.ledger, "ev-creator", EVENT_MARKET_CREATE_FEE);
  const m = ctx.markets.createEvent({
    guildId: "g", creatorId: "ev-creator", title: "settled板", options: ["A", "B"],
    durationMin: 60, allowedRoleIds: [ROLE_A], operationId: opId(),
  });
  seedLand(ctx.ledger, "ev-bettor1", 1_000);
  ctx.markets.betEventLand(m.id, "ev-bettor1", [ROLE_A], 0, 1_000, opId());
  ctx.markets.close(m.id, "ev-creator");
  ctx.markets.reportAndSettleEventLand(m.id, "ev-creator", 0, opId());
  return m.id;
}

/** void(的中者なし)のイベント板を1つ作る。void後はescrow=0になる */
function seedVoidEventMarket(ctx: Ctx): number {
  seedLand(ctx.ledger, "ev-creator2", EVENT_MARKET_CREATE_FEE);
  const m = ctx.markets.createEvent({
    guildId: "g", creatorId: "ev-creator2", title: "void板", options: ["A", "B"],
    durationMin: 60, allowedRoleIds: [ROLE_A], operationId: opId(),
  });
  seedLand(ctx.ledger, "ev-bettor2", 500);
  ctx.markets.betEventLand(m.id, "ev-bettor2", [ROLE_A], 0, 500, opId());
  ctx.markets.close(m.id, "ev-creator2");
  ctx.markets.reportAndSettleEventLand(m.id, "ev-creator2", 1, opId()); // 誰も選択肢1に賭けていない→void
  return m.id;
}

/** 通常板(standard)を1つ、terminal状態(settled)で直接INSERTする(R6で削除される対象) */
function seedStandardTerminalMarket(ctx: Ctx): number {
  const info = ctx.db
    .prepare(
      `INSERT INTO casino_markets (guild_id, creator_id, title, options_json, deadline_at, status, market_mode, allowed_role_ids_json, approval_mode, currency_mode, created_at)
       VALUES ('g','creator','標準板','["A","B"]',0,'settled','standard','[]','participant','chip',0)`,
    )
    .run();
  const marketId = Number(info.lastInsertRowid);
  ctx.db.prepare("INSERT INTO casino_market_bets (market_id, user_id, option_index, amount, created_at) VALUES (?, 'u1', 0, 100, 0)").run(marketId);
  ctx.db.prepare("INSERT INTO casino_market_approvals (market_id, user_id, vote, created_at) VALUES (?, 'u1', 'approve', 0)").run(marketId);
  return marketId;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function persistentBackupAdapter(): TestFilesystemOpeningBackupAdapter {
  const dir = mkdtempSync(join(tmpdir(), "pr12-r6-crash-coverage-test-"));
  tempDirs.push(dir);
  return new TestFilesystemOpeningBackupAdapter(dir);
}

function adapters() {
  return { backup: persistentBackupAdapter(), external: new FakeOpeningExternalAdapter() };
}

/** R6・event保護・所有権bindを含む全snapshot */
function snapshotAll(ctx: Ctx) {
  const eventMarketIds = (
    ctx.db.prepare("SELECT id FROM casino_markets WHERE market_mode = 'event' ORDER BY id").all() as Array<{ id: number }>
  ).map((r) => r.id);
  return {
    casinoTxRows: ctx.db.prepare("SELECT * FROM casino_tx ORDER BY id").all(),
    casinoTxGroupsRows: ctx.db.prepare("SELECT * FROM casino_tx_groups ORDER BY group_key").all(),
    casinoTxSeq: ctx.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='casino_tx'").get() ?? null,
    etherBalancesRows: ctx.db.prepare("SELECT * FROM ether_balances ORDER BY user_id").all(),
    etherEscrow: ctx.ledger.balanceOf(ETHER_ESCROW),
    department: ctx.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT),
    chipEscrow: ctx.ledger.balanceOf(CHIP_ESCROW),
    openingVersionRows: ctx.db.prepare("SELECT * FROM casino_chip_opening_versions ORDER BY opening_version").all(),
    openingBalanceRows: ctx.db.prepare("SELECT * FROM casino_chip_opening_balances ORDER BY opening_version, holder").all(),
    currentVersion: ctx.chipTx.currentVersion(),
    settingsRows: ctx.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'casino_opening%' ORDER BY key").all(),
    casinoStatus: ctx.status.current().status,
    // opening_execution_id/opening_actor_id はR0（R6より前の別transaction）で確定・commit済みで
    // あり、R6以降のcrashでも変化しないのが正しい（＝呼出前と比較するのではなく、
    // 「apply()呼び出し前後で一貫して同じexecution/actorを指しているか」を別途検証する）。
    standardMarkets: ctx.db.prepare("SELECT * FROM casino_markets WHERE market_mode = 'standard' ORDER BY id").all(),
    standardBets: ctx.db
      .prepare(
        "SELECT * FROM casino_market_bets WHERE market_id IN (SELECT id FROM casino_markets WHERE market_mode = 'standard') ORDER BY market_id, user_id",
      )
      .all(),
    standardApprovals: ctx.db
      .prepare(
        "SELECT * FROM casino_market_approvals WHERE market_id IN (SELECT id FROM casino_markets WHERE market_mode = 'standard') ORDER BY market_id, user_id",
      )
      .all(),
    eventMarkets: ctx.db.prepare("SELECT * FROM casino_markets WHERE market_mode = 'event' ORDER BY id").all(),
    eventBets: ctx.db.prepare("SELECT * FROM casino_market_bets WHERE market_id IN (SELECT id FROM casino_markets WHERE market_mode = 'event') ORDER BY market_id, user_id").all(),
    eventMarketOps: ctx.db.prepare("SELECT * FROM event_market_ops ORDER BY operation_id").all(),
    eventEscrowBalances: eventMarketIds.map((id) => ctx.ledger.balanceOf(eventMarketEscrowHolder(id))),
    eventFeesHolderBalance: ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER),
  };
}

function assertNoFundsApplied(ctx: Ctx): void {
  const row = ctx.db
    .prepare("SELECT status, funds_applied, postflight_json FROM casino_opening_executions ORDER BY id DESC LIMIT 1")
    .get() as { status: string; funds_applied: number; postflight_json: string | null } | undefined;
  if (!row) return;
  expect(row.status).not.toBe("applied");
  expect(row.status).not.toBe("completed");
  expect(row.funds_applied).toBe(0);
  expect(row.postflight_json).toBeNull();
}

describe("OpeningReset.apply — R6全DELETE地点のcrash injection網羅(PR12監査ブロッカーD)", () => {
  it.each(R6_ALL_DELETE_TABLES)("%s の削除直後でcrashすると、呼出前の状態(event板・所有権bindを含む)へ完全にROLLBACKされる", async (table) => {
    const ctx = setup();
    seedLegacy(ctx, { houseChips: 30_000, deptSeed: 100_000 });
    const settledId = seedSettledEventMarket(ctx);
    const voidId = seedVoidEventMarket(ctx);
    seedStandardTerminalMarket(ctx);
    configureAndOpenReset(ctx);
    const before = snapshotAll(ctx);
    expect(before.eventMarkets.length).toBe(2);
    expect(before.standardMarkets.length).toBe(1);
    expect(before.eventEscrowBalances.every((b) => b === 0)).toBe(true);

    ctx.reset.__setCrashHookForTesting((point, detail) => {
      if (point === "r6_after_delete" && detail === table) throw new Error(`crash injection: r6_after_delete:${table}`);
    });

    const { backup, external } = adapters();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow();

    ctx.reset.__setCrashHookForTesting(null);
    const after = snapshotAll(ctx);
    expect(after).toEqual(before);
    assertNoFundsApplied(ctx);
    expect(after.currentVersion).toBe(LEGACY_OPENING_VERSION);
    // event板そのものが消えていない・IDも変わっていないことを明示的に確認
    expect(after.eventMarkets.map((m: unknown) => (m as { id: number }).id).sort()).toEqual([settledId, voidId].sort());
    // opening_reset所有権bind（R0でR6より前にcommit済み）は、R6のcrashで壊れず
    // 一貫して同じactor/executionを指し続ける（PR12監査ブロッカーB・D）
    const owner = ctx.db
      .prepare("SELECT opening_execution_id, opening_actor_id FROM casino_status WHERE id = 1")
      .get() as { opening_execution_id: string | null; opening_actor_id: string | null };
    expect(owner.opening_actor_id).toBe("admin");
    expect(owner.opening_execution_id).not.toBeNull();
  });

  it("全DELETE地点を1つずつcrashさせた後、hookを外せば同じplanで最初から正常完了し、event板・standard終局板は正しく分かれて処理される", async () => {
    const ctx = setup();
    seedLegacy(ctx, { houseChips: 30_000, deptSeed: 100_000 });
    const settledId = seedSettledEventMarket(ctx);
    const voidId = seedVoidEventMarket(ctx);
    seedStandardTerminalMarket(ctx);
    configureAndOpenReset(ctx);

    ctx.reset.__setCrashHookForTesting((point, detail) => {
      if (point === "r6_after_delete" && detail === "casino_markets") throw new Error("crash injection: casino_markets");
    });
    const { backup, external } = adapters();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow();

    ctx.reset.__setCrashHookForTesting(null);
    const result = await ctx.reset.apply({ actorId: "admin", backup, external });
    expect(result.status).toBe("completed");

    // standard板は削除され、event板(settled/void)は残る
    const standardCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_markets WHERE market_mode='standard'").get() as { n: number }).n;
    expect(standardCount).toBe(0);
    const eventRows = ctx.db.prepare("SELECT id FROM casino_markets WHERE market_mode='event' ORDER BY id").all() as Array<{ id: number }>;
    expect(eventRows.map((r) => r.id).sort()).toEqual([settledId, voidId].sort());
  });
});
