import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, FORMAL_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { OpeningPlanner } from "../src/casino/opening-plan.js";
import { OpeningApplyBlockedError, OpeningReset } from "../src/casino/opening-reset.js";
import { TestFilesystemOpeningBackupAdapter } from "../src/casino/opening-backup.js";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";
import { EVENT_MARKET_CREATE_FEE, EVENT_MARKET_FEES_HOLDER, Markets, eventMarketEscrowHolder } from "../src/casino/market.js";

registerDefaultTxTypes();

/**
 * PR12監査: イベントLand板（PR#94・raw Ledger経済）の完全保護を、正式開業初期化
 * （OpeningReset.apply()）を実際に最後まで走らせて確認する統合テスト。
 *
 * - terminal（settled/void）なイベント板は保持したまま正式開業できる
 * - active（open/closed/frozen）なイベント板はpreflight blockerとなり、backup・external・R6の
 *   いずれも開始しない
 * - terminal板でもescrow残高が残っていればblockerになる（自動返金・自動精算はしない）
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
  const planner = new OpeningPlanner({ db, ledger, chips: ether, chipAssets, integrity, status, settings, departments });
  return { db, ledger, events, chipTx, ether, escrow, chipAssets, integrity, status, settings, departments, markets, reset, planner };
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

/**
 * status='opening_reset' へ進めるだけでなく、owner（execution/actor）も同時にbindする
 * （PR12監査: owner-first resume。R0は「status='opening_reset'ならownerは必ず完全にbind
 * 済み」を前提にしたため、`beginOpeningReset()`単独呼び出しだけでは不変条件違反になる）。
 */
function configureAndOpenReset(ctx: Ctx, actorId = "admin"): void {
  writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
  ctx.status.beginOpeningReset("テスト: 開業初期化準備", "test-admin");
  const plan = ctx.planner.dryRun();
  const execution = ctx.reset.executionStore.acquire(plan.planHash, actorId, plan.snapshot.configuration).execution;
  ctx.status.bindOpeningExecutionOwner(execution.id, actorId);
}

function seedLand(ledger: Ledger, userId: string, amount: number): void {
  ledger.ensureAccount(`user:${userId}`, "user");
  ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "t", idempotencyKey: `seed:${userId}:${opId()}` });
}

function createEventMarket(ctx: Ctx, creatorId: string, title = "イベント板") {
  seedLand(ctx.ledger, creatorId, EVENT_MARKET_CREATE_FEE);
  return ctx.markets.createEvent({
    guildId: "g", creatorId, title, options: ["A", "B"], durationMin: 60, allowedRoleIds: [ROLE_A], operationId: opId(),
  });
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function persistentBackupAdapter(): TestFilesystemOpeningBackupAdapter {
  const dir = mkdtempSync(join(tmpdir(), "pr12-event-protection-test-"));
  tempDirs.push(dir);
  return new TestFilesystemOpeningBackupAdapter(dir);
}

function adapters() {
  return { backup: persistentBackupAdapter(), external: new FakeOpeningExternalAdapter() };
}

describe("正式開業初期化 — terminalイベント板を保持したまま正式開業(PR12監査)", () => {
  it("settled板・void板・event_market_ops・fees holder残高・Land取引履歴を維持しつつ、standard板だけ削除してopening_v1が確立する", async () => {
    const ctx = setup();
    seedLegacy(ctx);

    // settled(的中あり)イベント板
    const settled = createEventMarket(ctx, "creator-s", "settled板");
    seedLand(ctx.ledger, "bettor-s", 2_000);
    ctx.markets.betEventLand(settled.id, "bettor-s", [ROLE_A], 0, 2_000, opId());
    ctx.markets.close(settled.id, "creator-s");
    const settleResult = ctx.markets.reportAndSettleEventLand(settled.id, "creator-s", 0, opId());
    expect(settleResult.void).toBe(false);

    // void(的中者なし)イベント板
    const voidMarket = createEventMarket(ctx, "creator-v", "void板");
    seedLand(ctx.ledger, "bettor-v", 800);
    ctx.markets.betEventLand(voidMarket.id, "bettor-v", [ROLE_A], 0, 800, opId());
    ctx.markets.close(voidMarket.id, "creator-v");
    const voidResult = ctx.markets.reportAndSettleEventLand(voidMarket.id, "creator-v", 1, opId());
    expect(voidResult.void).toBe(true);

    // 両方ともescrowは0になっているはず(全額精算/返金済み)
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(settled.id))).toBe(0);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(voidMarket.id))).toBe(0);
    const feesBefore = ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER);
    expect(feesBefore).toBeGreaterThan(0); // 開設手数料+場代が積み上がっている

    const opsCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS n FROM event_market_ops").get() as { n: number }).n;
    expect(opsCountBefore).toBeGreaterThan(0);
    const eventBetsBefore = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM casino_market_bets WHERE market_id IN (?, ?)")
      .get(settled.id, voidMarket.id) as { n: number };
    expect(eventBetsBefore.n).toBe(2);

    // standard(チップ経済)板を1つ、terminal状態で直接INSERTする(削除対象)
    ctx.db
      .prepare(
        `INSERT INTO casino_markets (guild_id, creator_id, title, options_json, deadline_at, status, market_mode, allowed_role_ids_json, approval_mode, currency_mode, created_at)
         VALUES ('g','creator','標準板','["A","B"]',0,'settled','standard','[]','participant','chip',0)`,
      )
      .run();

    configureAndOpenReset(ctx);
    const { backup, external } = adapters();
    const result = await ctx.reset.apply({ actorId: "admin", backup, external });
    expect(result.status).toBe("completed");
    expect(result.openingVersion).toBe(FORMAL_OPENING_VERSION);
    // V-event-1〜5が全部含まれ、postflightがokであること
    const postflight = result.postflight;
    expect(postflight.ok).toBe(true);
    for (const id of ["V-event-1", "V-event-2", "V-event-3", "V-event-4", "V-event-5"]) {
      const check = postflight.checks.find((c) => c.id === id);
      expect(check, `${id} が postflight に存在する`).toBeTruthy();
      expect(check!.ok, `${id}: ${check!.detail}`).toBe(true);
    }

    // standard板は削除された
    const standardCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_markets WHERE market_mode='standard'").get() as { n: number }).n;
    expect(standardCount).toBe(0);

    // event板・bets・opsはすべて維持されている
    const eventMarketsAfter = ctx.db.prepare("SELECT id, status FROM casino_markets WHERE market_mode='event' ORDER BY id").all() as Array<{
      id: number;
      status: string;
    }>;
    expect(eventMarketsAfter.map((m) => m.id).sort((a, b) => a - b)).toEqual([settled.id, voidMarket.id].sort((a, b) => a - b));
    expect(eventMarketsAfter.find((m) => m.id === settled.id)!.status).toBe("settled");
    expect(eventMarketsAfter.find((m) => m.id === voidMarket.id)!.status).toBe("void");
    const eventBetsAfter = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM casino_market_bets WHERE market_id IN (?, ?)")
      .get(settled.id, voidMarket.id) as { n: number };
    expect(eventBetsAfter.n).toBe(2);
    const opsCountAfter = (ctx.db.prepare("SELECT COUNT(*) AS n FROM event_market_ops").get() as { n: number }).n;
    expect(opsCountAfter).toBe(opsCountBefore);

    // fees holder残高・Land取引履歴(残高)は不変
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBe(feesBefore);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(settled.id))).toBe(0);
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(voidMarket.id))).toBe(0);
    // 利用者Land残高もイベント板の精算結果のまま(正式開業初期化で一切触れていない)
    expect(ctx.ledger.balanceOf("user:bettor-s")).toBeGreaterThan(0); // 的中者は配当を受け取っている
  });
});

describe("正式開業初期化 — activeイベント板はpreflight blocker(PR12監査)", () => {
  for (const targetStatus of ["open", "closed", "frozen"] as const) {
    it(`status='${targetStatus}' のイベント板が1件でもあれば、backup・external・R6のいずれも開始せずblockerで拒否される`, async () => {
      const ctx = setup();
      seedLegacy(ctx);
      const m = createEventMarket(ctx, "creator-active");
      if (targetStatus === "closed") {
        ctx.markets.close(m.id, "creator-active");
      } else if (targetStatus === "frozen") {
        // frozenは通常escrow不整合検知で内部的にセットされる。テストでは直接注入する
        ctx.db.prepare("UPDATE casino_markets SET status = 'frozen' WHERE id = ?").run(m.id);
      }
      // open はそのまま

      // ここでは意図的に configureAndOpenReset() を使わず status='open' のまま維持する。
      // blockerが残っている限りexecutionが一切作られないことを検証したいので、
      // apply()自身に「open→opening_reset→blocker検出→ロールバックでopenへ戻る」の
      // 一連をR0のIMMEDIATE transactionの中で行わせる（実運用でこの状態が起きる経路と一致させる。
      // PR12監査: owner-first resumeにより、あらかじめopening_resetへ進めてしまうと
      // ownerが未bindのまま観測される＝それ自体が別の不変条件違反になってしまうため）。
      writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
      const preflight = ctx.planner.dryRun();
      const blocker = preflight.blockers.find((b) => b.code === "active_event_land_market");
      expect(blocker, `active_event_land_market blockerが検出される(status=${targetStatus})`).toBeTruthy();
      expect(blocker!.message).toContain(`marketId=${m.id}`);

      const { backup, external } = adapters();
      await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);

      // backup・external・R6のいずれも開始していない
      // executionが一切acquireされていない(=backup・externalに到達する経路自体が
      // 実行されていない。apply()はbackup/externalよりexecution acquire=Rを先に行う設計)
      const executionRows = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;
      expect(executionRows).toBe(0);

      // イベント板・escrowは一切変更されていない
      const after = ctx.db.prepare("SELECT status FROM casino_markets WHERE id = ?").get(m.id) as { status: string };
      expect(after.status).toBe(targetStatus);
      expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(0); // betしていないので0のまま
    });
  }
});

describe("正式開業初期化 — terminalイベント板のescrow異常はblocker(PR12監査)", () => {
  it("settled/voidなのにescrow残高が残っていれば、自動返金・自動freeze・自動補正なしでblockerになる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    const m = createEventMarket(ctx, "creator-anomaly");
    seedLand(ctx.ledger, "bettor-anomaly", 1_500);
    ctx.markets.betEventLand(m.id, "bettor-anomaly", [ROLE_A], 0, 1_500, opId());
    ctx.markets.close(m.id, "creator-anomaly");
    ctx.markets.reportAndSettleEventLand(m.id, "creator-anomaly", 0, opId());
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(0);

    // 精算後に何らかの理由でescrowへLandを追加(実運用では起きないはずの異常状態を模擬)
    ctx.ledger.transfer({
      from: TREASURY,
      to: eventMarketEscrowHolder(m.id),
      amount: 999,
      type: "adjust",
      actor: "test",
      idempotencyKey: `anomaly:${opId()}`,
    });
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(999);

    // 意図的にconfigureAndOpenReset()を使わずstatus='open'のまま維持する（理由は上記の
    // activeイベント板blockerテストと同じ。PR12監査: owner-first resume）。
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    const preflight = ctx.planner.dryRun();
    const blocker = preflight.blockers.find((b) => b.code === "terminal_event_market_escrow_nonzero");
    expect(blocker, "terminal_event_market_escrow_nonzero blockerが検出される").toBeTruthy();
    expect(blocker!.message).toContain(`marketId=${m.id}`);
    expect(blocker!.message).toContain("999");

    const { backup, external } = adapters();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);

    const executionRows = (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions").get() as { n: number }).n;
    expect(executionRows).toBe(0);
    // 自動返金・自動freeze・自動補正されていない(escrow残高そのまま・statusもsettledのまま)
    expect(ctx.ledger.balanceOf(eventMarketEscrowHolder(m.id))).toBe(999);
    const after = ctx.db.prepare("SELECT status FROM casino_markets WHERE id = ?").get(m.id) as { status: string };
    expect(after.status).toBe("settled");
  });

  it("sys:escrow:market:fees が正の残高でもblockerにならない(正常)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    createEventMarket(ctx, "creator-fees"); // 開設手数料でfees holderへ入金される
    expect(ctx.ledger.balanceOf(EVENT_MARKET_FEES_HOLDER)).toBeGreaterThan(0);

    configureAndOpenReset(ctx);
    const preflight = ctx.planner.dryRun();
    // fees holderの残高そのものはblockerにならない(open状態のイベント板自体はactive blockerになる)
    expect(preflight.blockers.some((b) => b.message.includes("fees"))).toBe(false);
  });
});
