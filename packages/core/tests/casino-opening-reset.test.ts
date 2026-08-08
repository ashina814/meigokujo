import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, FORMAL_OPENING_VERSION, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, CHIP_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino, JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { CASINO_DEPARTMENT_ACCOUNT, OpeningPlanner } from "../src/casino/opening-plan.js";
import {
  OpeningApplyBlockedError,
  OpeningApplyManualReviewError,
  OpeningApplyRolledBackError,
  OpeningReset,
} from "../src/casino/opening-reset.js";
import {
  FakeOpeningBackupAdapter,
  TestFilesystemOpeningBackupAdapter,
  type ManifestVerificationExpectation,
  type OpeningBackupAdapter,
  type OpeningBackupRequest,
  type OpeningBackupManifest,
  type OpeningBackupVerificationResult,
} from "../src/casino/opening-backup.js";
import { FakeOpeningExternalAdapter } from "../src/casino/opening-external.js";

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
  const reset = new OpeningReset({ db, ledger, chips: ether, chipAssets, integrity, status, settings, departments });
  return { db, ledger, events, chipTx, ether, escrow, chipAssets, integrity, status, settings, departments, reset };
}

type Ctx = ReturnType<typeof setup>;

/** legacy_pre_reset の窓を、旧取引fixtureで作る */
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
function configureAndOpenReset(ctx: Ctx, config = VALID_CONFIG, actorId = "admin"): void {
  writeCasinoOpeningConfig(ctx.settings, config, "test-admin");
  ctx.status.beginOpeningReset("テスト: 開業初期化準備", "test-admin");
  const plan = new OpeningPlanner({ ...ctx, chips: ctx.ether }).dryRun();
  const execution = ctx.reset.executionStore.acquire(plan.planHash, actorId, plan.snapshot.configuration).execution;
  ctx.status.bindOpeningExecutionOwner(execution.id, actorId);
}

// 監査ブロッカー5.3: 破壊的applyはdurability="persistent"のbackup adapterしか受け付けない。
// FakeOpeningBackupAdapter(memory)はbackup失敗・manifest改竄など「destructive txへ絶対に
// 到達しない」経路の注入専用に限定し、実際にapply()が完了/先へ進む経路は全部これを使う。
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function persistentBackupAdapter(): TestFilesystemOpeningBackupAdapter {
  const dir = mkdtempSync(join(tmpdir(), "pr12-opening-reset-test-"));
  tempDirs.push(dir);
  return new TestFilesystemOpeningBackupAdapter(dir);
}

function adapters() {
  return { backup: persistentBackupAdapter(), external: new FakeOpeningExternalAdapter() };
}

describe("OpeningReset — constructorは一切書き込まない(監査ブロッカー1)", () => {
  it("PRAGMA query_only=ONでもOpeningResetを構築できる", () => {
    const ctx = setup();
    ctx.db.pragma("query_only = ON");
    expect(() => new OpeningReset({ ...ctx, chips: ctx.ether })).not.toThrow();
    ctx.db.pragma("query_only = OFF");
  });

  it("構築するだけでは、schema・row count・outboxのいずれも変化しない", () => {
    const ctx = setup();
    seedLegacy(ctx);
    const tableNames = (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    const countsBefore = Object.fromEntries(
      tableNames.map((name) => [name, (ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]),
    );
    new OpeningReset({ ...ctx, chips: ctx.ether });
    const countsAfter = Object.fromEntries(
      tableNames.map((name) => [name, (ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]),
    );
    expect(countsAfter).toEqual(countsBefore);
  });
});

describe("OpeningReset.apply — 正常系", () => {
  it("blocker=0の状態でapplyすると、opening_v1が確立し賭場がopenへ戻る", async () => {
    const ctx = setup();
    new Casino(ctx.db, ctx.ether, ctx.events);
    seedLegacy(ctx, { houseChips: 30_000, deptSeed: 100_000 });
    ctx.db
      .prepare("INSERT INTO casino_home_preferences (user_id, last_game, last_amount, updated_at) VALUES (?, ?, ?, ?)")
      .run("alice", "スロット", 100, 1);
    configureAndOpenReset(ctx);
    const { backup, external } = adapters();

    const result = await ctx.reset.apply({ actorId: "admin", backup, external });

    expect(result.status).toBe("completed");
    expect(result.fundsApplied).toBe(true);
    expect(result.casinoReopened).toBe(true);
    expect(result.postflight.ok).toBe(true);
    expect(result.postflight.checks.every((c) => c.ok)).toBe(true);
    expect(result.openingVersion).toBe(FORMAL_OPENING_VERSION);

    // holder残高
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(VALID_CONFIG.openingHouse);
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(VALID_CONFIG.openingJackpot);
    expect(ctx.ether.balanceOf(RELIEF_HOLDER)).toBe(VALID_CONFIG.openingRelief);
    expect(ctx.ether.outstanding()).toBe(VALID_CONFIG.openingCapital);

    // Land側
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(VALID_CONFIG.openingCapital);
    // dept は 100,000 で開始し、先にhouse資金分30,000を旧準備口座へ払い出し済み(=70,000)。
    // R7で旧準備口座の30,000が戻り(=100,000)、R8で開業元本50,000を新準備口座へ出資する(=50,000)。
    expect(ctx.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)).toBe(100_000 - VALID_CONFIG.openingCapital);

    // R7/R8は別のLand取引
    expect(result.oldSettlementLandTxId).not.toBeNull();
    expect(result.oldSettlementLandTxId).not.toBe(result.newInvestmentLandTxId);

    // casino_tx/casino_tx_groupsは初期化済み(空)
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups").get() as { n: number }).n).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_home_preferences").get() as { n: number }).n).toBe(0);

    // 版はopening_v1、賭場はopen
    expect(ctx.chipTx.currentVersion()).toBe(FORMAL_OPENING_VERSION);
    expect(ctx.status.current().status).toBe("open");

    // legacy_pre_resetのopening metadataは保存されたまま(削除しない)
    const versions = ctx.chipTx.listOpeningVersions();
    expect(versions.map((v) => v.version)).toEqual([LEGACY_OPENING_VERSION, FORMAL_OPENING_VERSION]);

    // notifierは本PRでは配線しない(監査ブロッカー6)。何も送信していないのに'sent'を
    // 名乗ってはいけない。資金apply自体はnotifierと無関係に成功している。
    expect(result.notifierStatus).toBe("pending");
    const notifierRow = ctx.db.prepare("SELECT notifier_status FROM casino_opening_executions WHERE id = ?").get(
      result.executionId,
    ) as { notifier_status: string | null };
    expect(notifierRow.notifier_status).toBe("pending");
  });

  it("旧準備口座が0ならR7をスキップする(oldSettlementLandTxIdはnull)", async () => {
    const ctx = setup();
    seedLegacy(ctx, { houseChips: 0, deptSeed: 100_000 });
    configureAndOpenReset(ctx);
    const { backup, external } = adapters();
    const result = await ctx.reset.apply({ actorId: "admin", backup, external });
    expect(result.oldSettlementLandTxId).toBeNull();
    expect(result.status).toBe("completed");
  });

  it("casino_tx.idのAUTOINCREMENTがreset後は小さい値から再開する(sqlite_sequence初期化)", async () => {
    const ctx = setup();
    seedLegacy(ctx, { houseChips: 30_000 });
    configureAndOpenReset(ctx);
    // legacy期に大きめのcasino_tx.idを積んでおく。ether.transfer()は残高も一緒に更新するので
    // 検算Aを壊さない(chipTx.record()を直接呼ぶと明細だけ増えて残高と食い違いblockerになる)。
    ctx.chipTx.runMaintenance("test-seed", () => {
      ctx.chipTx.runGroup({ groupKey: "seed-group-1", kind: "opening_reset", actorId: "system:test" }, () => {
        for (let i = 0; i < 5; i++) {
          ctx.ether.transfer(HOUSE_HOLDER, "jackpot", 1, { reason: "test" });
          ctx.ether.transfer("jackpot", HOUSE_HOLDER, 1, { reason: "test-return" });
        }
      });
    });
    const lastLegacyTxId = (ctx.db.prepare("SELECT MAX(id) AS id FROM casino_tx").get() as { id: number }).id;
    expect(lastLegacyTxId).toBeGreaterThanOrEqual(5);

    const { backup, external } = adapters();
    await ctx.reset.apply({ actorId: "admin", backup, external });

    // opening_v1確立後、新しいchip移動を1つ記録すると、id=1から再開しているはず
    ctx.ether.runGroup({ groupKey: "post-open-move", kind: "opening_reset", actorId: "system:test" }, () => {
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 1, { reason: "post-open test move" });
    });
    const newRow = ctx.db.prepare("SELECT id FROM casino_tx ORDER BY id DESC LIMIT 1").get() as { id: number };
    expect(newRow.id).toBeLessThan(lastLegacyTxId);
    expect(newRow.id).toBe(1);
  });
});

describe("OpeningReset.apply — 未送信notifierをsent扱いしない(監査ブロッカー6)", () => {
  it("本PRはnotifier配線を持たない: 何度applyしてもnotifier_status='sent'は一度も書かれない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const { backup, external } = adapters();

    const result = await ctx.reset.apply({ actorId: "admin", backup, external });

    expect(result.status).toBe("completed");
    expect(result.fundsApplied).toBe(true);
    // 資金apply自体はnotifierと無関係に確定している(notifier未配線を理由にrollbackしない)
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(VALID_CONFIG.openingHouse);
    expect(result.notifierStatus).toBe("pending");

    // DB全体を見ても、この開業initializationのexecution行にnotifier_status='sent'は
    // 一度も書き込まれていない(未送信を「送った」ことにする虚偽記録が無いことの確認)
    const sentCount = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_executions WHERE notifier_status = 'sent'").get() as {
        n: number;
      }
    ).n;
    expect(sentCount).toBe(0);

    // completed後に同じplanへ再度applyすると、そもそも二重開業防止のpreflight blockerで
    // 即座に拒否される(already_opening_v1)。notifierだけを再送させる専用経路は本PRでは
    // 存在しない(本PRの範囲: notifier配線自体を持たないため、再送経路も配線しない)。
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);
    const executionRow = ctx.db
      .prepare("SELECT notifier_status FROM casino_opening_executions WHERE id = ?")
      .get(result.executionId) as { notifier_status: string | null };
    expect(executionRow.notifier_status).toBe("pending");
  });
});

describe("OpeningReset.apply — opening_reset取得責務(監査ブロッカー7)", () => {
  it("statusがopenで他にblockerが無ければ、apply()自身がactorIdの権限でopening_resetへ進める", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    // configureAndOpenResetを呼ばない: beginOpeningReset()を別処理で先に呼ばず、
    // 設定(writeCasinoOpeningConfig)だけ済ませておく。statusはopenのまま。
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    expect(ctx.status.current().status).toBe("open");
    const { backup, external } = adapters();

    const result = await ctx.reset.apply({ actorId: "admin-x", backup, external });

    expect(result.status).toBe("completed");
    expect(result.fundsApplied).toBe(true);
    // opening_resetへの遷移がこのapply()呼び出し自身のactorIdの下で記録されている
    // (execution行が'opening_reset_acquired'を名乗る以上、実際にその状態を取得したのが
    // 誰かを確認できなければならない、というのが監査ブロッカー7の要求)
    const openingResetEntry = ctx.status.history(10).find((h) => h.status === "opening_reset");
    expect(openingResetEntry?.changedBy).toBe("admin-x");
    // 最終的には正常にopenへ戻る
    expect(ctx.status.current().status).toBe("open");
  });

  it("maintenance等の人為的な停止状態からは、apply()がCasinoStatusへ一切触れずblockerで拒否する", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
    ctx.status.beginMaintenance("点検中", "ops");
    const historyBefore = ctx.status.history(10);
    const { backup, external } = adapters();

    // 破壊的applyが、人が明示的に入れた停止状態(maintenance)を暗黙に踏み越えて
    // opening_resetへ進めてしまわないことを確認する。
    await expect(ctx.reset.apply({ actorId: "admin-x", backup, external })).rejects.toThrow(OpeningApplyBlockedError);

    expect(ctx.status.current().status).toBe("maintenance");
    // CasinoStatusへ一切書き込んでいない(履歴が1件も増えていない)
    expect(ctx.status.history(10)).toEqual(historyBefore);
  });

  it("既にopening_resetの場合は、apply()は再度beginOpeningResetを呼ばず(履歴が増えず)そのまま進む", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx); // 既存の運用導線どおり、別処理で先にopening_resetへ入れておく
    const openingResetCountBefore = ctx.status.history(20).filter((h) => h.status === "opening_reset").length;
    const { backup, external } = adapters();

    const result = await ctx.reset.apply({ actorId: "admin", backup, external });

    expect(result.status).toBe("completed");
    // apply()開始時点で既にopening_resetだったので、apply()自身は新たな
    // opening_resetへの遷移を記録しない(素通りするだけ)
    const openingResetCountAfter = ctx.status.history(20).filter((h) => h.status === "opening_reset").length;
    expect(openingResetCountAfter).toBe(openingResetCountBefore);
  });
});

describe("OpeningReset.apply — preflight blocker", () => {
  it("blockerがあれば例外を投げ、executionを一切作らない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    // configureAndOpenResetを呼ばない = 設定未完了のblockerが残る。backupが一切呼ばれないことを
    // `.calls`で見たいので、ここだけはFakeOpeningBackupAdapter(memory)を直接使う
    // (preflightで止まる経路であり、durabilityゲートには到達しない)。
    const backup = new FakeOpeningBackupAdapter();
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);
    expect(backup.calls).toHaveLength(0);
    expect(ctx.reset.executionStore.getByPlanHash("does-not-matter")).toBeUndefined();
  });

  it("PR10未完了義務(refund saga)が残っている限り、R6のDELETEへ絶対に到達しない(監査ブロッカー2)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.prepare(
      "INSERT INTO casino_chip_refund_sagas (id,scope,requested_by,target_user_id,status,target_count,target_total,created_at) VALUES ('s1','user','admin','bob','blocked',1,100,0)",
    ).run();
    const rowsBefore = ctx.db.prepare("SELECT * FROM casino_chip_refund_sagas").all();

    // これもpreflightで止まる経路。backupが一切呼ばれないことを`.calls`で確認するため
    // FakeOpeningBackupAdapter(memory)を直接使う。
    const backup = new FakeOpeningBackupAdapter();
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);

    // backup/外部工程はおろか、execution行すら作られない(preflightの時点で止まる)
    expect(backup.calls).toHaveLength(0);
    // R6のDELETEに到達していない証拠: 行がそのまま残っている
    const rowsAfter = ctx.db.prepare("SELECT * FROM casino_chip_refund_sagas").all();
    expect(rowsAfter).toEqual(rowsBefore);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
  });

  it("PR10未完了義務(refund saga target)が残っている限り、R6のDELETEへ絶対に到達しない(監査ブロッカー2)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.db.prepare(
      "INSERT INTO casino_chip_refund_sagas (id,scope,requested_by,target_user_id,status,target_count,target_total,created_at) VALUES ('s1','user','admin','bob','executing',1,100,0)",
    ).run();
    ctx.db.prepare(
      "INSERT INTO casino_chip_refund_saga_targets (saga_id,user_id,amount,status,group_key) VALUES ('s1','bob',100,'failed','g1')",
    ).run();
    const targetRowsBefore = ctx.db.prepare("SELECT * FROM casino_chip_refund_saga_targets").all();

    const { backup, external } = adapters();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);

    const targetRowsAfter = ctx.db.prepare("SELECT * FROM casino_chip_refund_saga_targets").all();
    expect(targetRowsAfter).toEqual(targetRowsBefore);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
  });
});

describe("OpeningReset.apply — backup失敗", () => {
  it("backup失敗時は資金を動かさず、statusをopening_resetのまま維持し、再試行で成功する", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const failingBackup = new FakeOpeningBackupAdapter({ fail: true });
    const external = new FakeOpeningExternalAdapter();

    await expect(ctx.reset.apply({ actorId: "admin", backup: failingBackup, external })).rejects.toThrow();
    expect(ctx.status.current().status).toBe("opening_reset");
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);

    const workingBackup = persistentBackupAdapter();
    const result = await ctx.reset.apply({ actorId: "admin", backup: workingBackup, external });
    expect(result.status).toBe("completed");
  });

  it("manifest検証失敗(corrupt)時も資金を動かさず、再試行で成功する", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const corruptBackup = new FakeOpeningBackupAdapter({ corrupt: (m) => ({ ...m, sqliteSha256: "0".repeat(64) }) });
    const external = new FakeOpeningExternalAdapter();

    await expect(ctx.reset.apply({ actorId: "admin", backup: corruptBackup, external })).rejects.toThrow();
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);

    const workingBackup = persistentBackupAdapter();
    const result = await ctx.reset.apply({ actorId: "admin", backup: workingBackup, external });
    expect(result.status).toBe("completed");
  });
});

describe("OpeningReset.apply — 外部工程失敗・リトライ", () => {
  it("外部adapterが指定回数失敗しても、資金は動かず、最終的に成功する", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const backup = persistentBackupAdapter();
    const flakyExternal = new FakeOpeningExternalAdapter({ failTimes: 2 });

    await expect(ctx.reset.apply({ actorId: "admin", backup, external: flakyExternal })).rejects.toThrow();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external: flakyExternal })).rejects.toThrow();
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);

    const result = await ctx.reset.apply({ actorId: "admin", backup, external: flakyExternal });
    expect(result.status).toBe("completed");
    // 外部工程は実際に3回目でようやく成功しているが、二重実行はしていない
    expect(flakyExternal.attemptsFor("casino-opening:disable-legacy-vcs")).toBe(3);
  });
});

describe("OpeningReset.apply — planのstale化", () => {
  /**
   * backup adapterのbackup()呼び出し中(非同期の隙)にDBを変化させ、backup後のplan再検査を発火させる。
   * innerはpersistent adapterを包む(durability/verifyPersistedBackupをそのまま委譲する)。
   * fakeのmemory adapterを包むと、この検証が始まる前に監査ブロッカー5.3のdurabilityゲートで
   * 弾かれてしまい、ここで見たいstale-plan検出まで到達できない。
   */
  class MutatingBackupAdapter implements OpeningBackupAdapter {
    constructor(
      private readonly inner: OpeningBackupAdapter,
      private readonly mutate: () => void,
    ) {}
    get durability() {
      return this.inner.durability;
    }
    async backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest> {
      const manifest = await this.inner.backup(request);
      this.mutate();
      return manifest;
    }
    verifyPersistedBackup(
      manifest: OpeningBackupManifest,
      expectation: ManifestVerificationExpectation,
    ): Promise<OpeningBackupVerificationResult> {
      return this.inner.verifyPersistedBackup(manifest, expectation);
    }
  }

  it("backup直後にDBが変化した場合、破壊的transactionへ進まずfailedになる(資金不変)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const mutating = new MutatingBackupAdapter(persistentBackupAdapter(), () => {
      ctx.db.prepare(
        "INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES ('sneaky','bob',10,'test','escrow:session:sneaky',0)",
      ).run();
    });
    const external = new FakeOpeningExternalAdapter();

    await expect(ctx.reset.apply({ actorId: "admin", backup: mutating, external })).rejects.toThrow();
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);

    // 混入行を取り除けば、次のapplyは新しいplan hashで最初から成功する
    ctx.db.prepare("DELETE FROM casino_escrow WHERE session_id = 'sneaky'").run();
    const result = await ctx.reset.apply({ actorId: "admin", backup: persistentBackupAdapter(), external });
    expect(result.status).toBe("completed");
  });

  it("外部工程完了後にDBが変化した場合、manual_review_requiredになり資金は動かず外部工程も再実行しない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const backup = persistentBackupAdapter();
    class MutatingExternal extends FakeOpeningExternalAdapter {
      override async disableLegacyCasino(request: Parameters<FakeOpeningExternalAdapter["disableLegacyCasino"]>[0]) {
        const result = await super.disableLegacyCasino(request);
        ctx.db.prepare(
          "INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES ('sneaky2','bob',10,'test','escrow:session:sneaky2',0)",
        ).run();
        return result;
      }
    }
    const external = new MutatingExternal();

    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyManualReviewError);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);
    // 外部工程は1回だけ実行されている(manual_review後に自動で再実行されない)
    expect(external.attemptsFor("casino-opening:disable-legacy-vcs")).toBe(1);
  });
});

describe("OpeningReset.apply — 二重開業防止", () => {
  it("成功後に再度applyすると、already_opening_v1 blockerで拒否される", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const { backup, external } = adapters();
    await ctx.reset.apply({ actorId: "admin", backup, external });

    ctx.status.beginMaintenance("test", "admin"); // opening_reset状態ではないのでblockerが先に出る可能性もあるが、
    // 主目的はalready_opening_v1が確実に検出されること
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);
  });
});

describe("OpeningReset.apply — 永続証拠の不在をrankだけで見逃さない", () => {
  it("statusがbackup_verified以降なのにbackupManifestが無い(データ破損)場合は不変条件違反として即座に止まる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const { backup, external } = adapters();
    const planner = new OpeningPlanner({ ...ctx, chips: ctx.ether });
    const plan = planner.dryRun();
    const acquireResult = ctx.reset.executionStore.acquire(plan.planHash, "admin", plan.snapshot.configuration);
    // acquireだけ行い、backupManifestを書き込まないまま直接status='backup_verified'を注入する
    // (実運用では絶対に起きないはずの破損状態を模擬)
    ctx.db.prepare("UPDATE casino_opening_executions SET status = 'backup_verified' WHERE id = ?").run(acquireResult.execution.id);

    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);
  });

  it("statusがexternal_completed以降なのにexternalOperationIdが無い(データ破損)場合は不変条件違反として即座に止まる", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const { backup, external } = adapters();
    const planner = new OpeningPlanner({ ...ctx, chips: ctx.ether });
    const plan = planner.dryRun();
    const acquireResult = ctx.reset.executionStore.acquire(plan.planHash, "admin", plan.snapshot.configuration);
    // backupManifestは正しく埋めつつ、external関連だけ欠落させた破損状態を作る
    ctx.db.prepare("UPDATE casino_opening_executions SET status = 'external_completed', backup_manifest_json = '{}' WHERE id = ?").run(
      acquireResult.execution.id,
    );

    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/不変条件違反/);
  });
});

describe("OpeningReset.apply — 永続backup証拠をapply前提へ接続(監査ブロッカー5)", () => {
  /** manifestの内容だけを改竄する(実ファイルはinnerが正しく書いたまま)。5.1の自己比較バグの回帰テスト用 */
  class DatabaseIdentityCorruptingAdapter implements OpeningBackupAdapter {
    constructor(private readonly inner: OpeningBackupAdapter) {}
    get durability() {
      return this.inner.durability;
    }
    async backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest> {
      const manifest = await this.inner.backup(request);
      return { ...manifest, databaseIdentity: "0".repeat(64) };
    }
    verifyPersistedBackup(
      manifest: OpeningBackupManifest,
      expectation: ManifestVerificationExpectation,
    ): Promise<OpeningBackupVerificationResult> {
      return this.inner.verifyPersistedBackup(manifest, expectation);
    }
  }

  it("manifestのdatabaseIdentityが実DBと食い違う場合を検出する(期待値の自己比較バグの回帰、監査ブロッカー5.1)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    // 「expectation.databaseIdentity: manifest.databaseIdentity」という自己比較のバグが
    // あれば、この改竄は常にok:trueをすり抜ける(自分自身と比較しているだけなので)。
    // 稼働中DBから独立に期待値を計算していれば、ここで確実に検出できる。
    const backup = new DatabaseIdentityCorruptingAdapter(persistentBackupAdapter());
    const external = new FakeOpeningExternalAdapter();

    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/database identity/);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);
    expect(ctx.status.current().status).toBe("opening_reset");
  });

  it("durability=memoryのbackup adapterでは破壊的applyへ進めない(監査ブロッカー5.3)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const backup = new FakeOpeningBackupAdapter();
    const external = new FakeOpeningExternalAdapter();

    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/durability=memory/);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);
    expect(ctx.status.current().status).toBe("opening_reset");

    // durability=persistentへ切り替えれば、同じplanで最初から成功する
    const result = await ctx.reset.apply({ actorId: "admin", backup: persistentBackupAdapter(), external });
    expect(result.status).toBe("completed");
  });

  it("backup()直後に永続実体が消えた場合、再読込による再検証で検出し破壊的applyへ進めない(監査ブロッカー5.2)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    const dir = mkdtempSync(join(tmpdir(), "pr12-backup-vanish-"));
    tempDirs.push(dir);
    const inner = new TestFilesystemOpeningBackupAdapter(dir);
    class VanishingBackupAdapter implements OpeningBackupAdapter {
      get durability() {
        return inner.durability;
      }
      async backup(request: OpeningBackupRequest): Promise<OpeningBackupManifest> {
        const manifest = await inner.backup(request);
        // backup()自身は成功を報告した直後に、保存されたはずの実体が消えた状況を模擬する
        // (書き込み後にディスク故障・別プロセスによる誤削除などが起きたケース)
        rmSync(join(dir, `casino-opening-${manifest.planHash}.sqlite`));
        return manifest;
      }
      verifyPersistedBackup(
        manifest: OpeningBackupManifest,
        expectation: ManifestVerificationExpectation,
      ): Promise<OpeningBackupVerificationResult> {
        return inner.verifyPersistedBackup(manifest, expectation);
      }
    }
    const backup = new VanishingBackupAdapter();
    const external = new FakeOpeningExternalAdapter();

    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/永続backup証拠/);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);
    expect(ctx.status.current().status).toBe("opening_reset");
  });
});

describe("OpeningReset.apply — 利用者Landの口座別postflight検証(監査ブロッカー4)", () => {
  it("apply transaction中に利用者Land口座間で付け替え(総額・口座数は不変)が起きた場合、accountId別SHA不一致で検出しR6〜R10をまるごとrollbackする", async () => {
    const ctx = setup();
    seedLegacy(ctx, { houseChips: 30_000, deptSeed: 100_000 });
    configureAndOpenReset(ctx);

    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.ensureAccount("user:bob", "user");
    ctx.ledger.transfer({
      from: TREASURY,
      to: "user:alice",
      amount: 1_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed:alice",
    });

    const before = {
      alice: ctx.ledger.balanceOf("user:alice"),
      bob: ctx.ledger.balanceOf("user:bob"),
      etherEscrow: ctx.ledger.balanceOf(ETHER_ESCROW),
      dept: ctx.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT),
      chipEscrow: ctx.ledger.balanceOf(CHIP_ESCROW),
      casinoTx: (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n,
      etherBalances: (ctx.db.prepare("SELECT COUNT(*) AS n FROM ether_balances").get() as { n: number }).n,
    };

    // apply()の破壊的transaction内、R10(opening_v1確立=casino_chip_opening_versions INSERT)の
    // 直後にだけ発火する敵対的トリガー。利用者Landの「口座数」と「総額」を保ったまま、
    // aliceからbobへ1,000を付け替える(単純な口座数・合計額比較では検出できない改竄)。
    // 台帳の複式簿記(transactions/balances)を正しく整合させて動かすため、V2(ledger整合性)には
    // 引っかからず、監査ブロッカー4で追加したaccountId別SHA検証だけが検出できることを確認する。
    ctx.db.exec(`
      CREATE TEMP TRIGGER sneaky_land_swap
      AFTER INSERT ON casino_chip_opening_versions
      WHEN NEW.opening_version = '${FORMAL_OPENING_VERSION}'
      BEGIN
        INSERT INTO transactions (idempotency_key, from_account, to_account, amount, type, actor_id, created_at)
          VALUES ('sneaky-mid-apply-swap', 'user:alice', 'user:bob', 1000, 'adjust', 'sneaky-test', 0);
        UPDATE balances SET amount = amount - 1000, updated_at = 0 WHERE account_id = 'user:alice';
        INSERT INTO balances (account_id, amount, updated_at) VALUES ('user:bob', 1000, 0)
          ON CONFLICT(account_id) DO UPDATE SET amount = balances.amount + 1000, updated_at = 0;
      END;
    `);

    const { backup, external } = adapters();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(/player_land_unchanged/);

    // R6〜R10がまるごとrollbackされ、資金・opening版・執行状態のいずれも変化していない
    expect(ctx.ledger.balanceOf("user:alice")).toBe(before.alice);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(before.bob);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(before.etherEscrow);
    expect(ctx.ledger.balanceOf(CASINO_DEPARTMENT_ACCOUNT)).toBe(before.dept);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(before.chipEscrow);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx").get() as { n: number }).n).toBe(before.casinoTx);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM ether_balances").get() as { n: number }).n).toBe(
      before.etherBalances,
    );
    expect(ctx.status.current().status).toBe("opening_reset");

    // executionはapplied化しておらず、failedへ落ちている(opening metadataも巻き戻っている)
    const planner = new OpeningPlanner({ ...ctx, chips: ctx.ether });
    const plan = planner.dryRun();
    expect(plan.blockers).toEqual([]);
    const execution = ctx.reset.executionStore.getByPlanHash(plan.planHash);
    expect(execution?.status).toBe("failed");
    expect(execution?.fundsApplied).toBe(false);
  });
});

describe("OpeningReset.apply — 資金合算のchecked add化(監査ブロッカー8)", () => {
  it("敵対的: 利用者Land残高が個々にはsafe integerでも合算がoverflowする場合、preflightがarithmetic blockerで拒否しexecutionを一切作らない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    configureAndOpenReset(ctx);
    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.ensureAccount("user:bob", "user");
    // 通常のledger.transferはmaxAmountで大口を弾くため、safe-integer境界付近の値を
    // 敵対的に注入するには直接SQLを使う(DB破損・不正操作を模擬)。
    ctx.db.prepare("INSERT INTO balances (account_id, amount, updated_at) VALUES (?, ?, 0)").run(
      "user:alice",
      Number.MAX_SAFE_INTEGER,
    );
    ctx.db.prepare("INSERT INTO balances (account_id, amount, updated_at) VALUES (?, ?, 0)").run("user:bob", 1);

    const backup = new FakeOpeningBackupAdapter();
    const external = new FakeOpeningExternalAdapter();
    await expect(ctx.reset.apply({ actorId: "admin", backup, external })).rejects.toThrow(OpeningApplyBlockedError);

    // 破壊的applyへは一切進んでいない(backupすら呼ばれない、execution行も作られない)
    expect(backup.calls).toHaveLength(0);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);

    // dryRun()自体はクラッシュせず、"arithmetic"カテゴリのblockerとして報告する
    const planner = new OpeningPlanner({ ...ctx, chips: ctx.ether });
    const plan = planner.dryRun();
    expect(plan.blockers.some((b) => b.category === "arithmetic")).toBe(true);
  });
});
