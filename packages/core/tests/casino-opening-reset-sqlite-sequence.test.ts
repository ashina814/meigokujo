import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx, FORMAL_OPENING_VERSION, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { ChipLedger, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { Settings } from "../src/settings/service.js";
import { Departments, deptAccount } from "../src/departments/service.js";
import { writeCasinoOpeningConfig } from "../src/casino/opening-settings.js";
import { OpeningReset } from "../src/casino/opening-reset.js";
import { FakeOpeningBackupAdapter } from "../src/casino/opening-backup.js";
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

function seedLegacy(ctx: Ctx, houseChips = 30_000): void {
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  ctx.ledger.transfer({
    from: deptAccount("賭博場"), to: ETHER_ESCROW, amount: houseChips, type: "ether_house_fund", actor: "system:ether",
    approvedBy: "system:ether", idempotencyKey: "legacy:fund:house",
  });
  ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(HOUSE_HOLDER, houseChips);
  ctx.chipTx.captureLegacyOpening({ poolLand: ctx.ledger.balanceOf(ETHER_ESCROW), fromLedgerTxId: ctx.ledger.lastTransactionId() });
  ctx.departments.upsert("賭博場", "賭博場", null);
}

function configureAndOpenReset(ctx: Ctx): void {
  writeCasinoOpeningConfig(ctx.settings, VALID_CONFIG, "test-admin");
  ctx.status.beginOpeningReset("テスト: sqlite_sequence検証", "test-admin");
}

function sequenceOf(db: ReturnType<typeof openDb>, name: string): number | undefined {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name) as { seq: number } | undefined;
  return row?.seq;
}

describe("R9: sqlite_sequenceの限定性", () => {
  it("casino_txのsequenceだけが対象で、他のAUTOINCREMENTテーブルのsequenceは変化しない", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    // casino_tx.idを進めておく(runMaintenance経由でrunGroup+recordを直接使う)
    ctx.chipTx.runMaintenance("test-seed", () => {
      ctx.chipTx.runGroup({ groupKey: "seed-1", kind: "opening_reset", actorId: "system:test" }, () => {
        ctx.ether.transfer(HOUSE_HOLDER, "jackpot", 1, { reason: "seed" });
        ctx.ether.transfer("jackpot", HOUSE_HOLDER, 1, { reason: "seed-return" });
      });
    });
    // 他のAUTOINCREMENTテーブル(transactions=Land台帳)にも十分な行がある状態
    const transactionsSeqBefore = sequenceOf(ctx.db, "transactions") ?? 0;
    const casinoTxSeqBefore = sequenceOf(ctx.db, "casino_tx");
    expect(casinoTxSeqBefore).toBeGreaterThanOrEqual(2);
    expect(transactionsSeqBefore).toBeGreaterThanOrEqual(1);

    configureAndOpenReset(ctx);
    // casino_status_historyはbeginOpeningReset()で初めて行ができる(それまでは0行)
    const statusHistorySeqBefore = sequenceOf(ctx.db, "casino_status_history") ?? 0;
    const result = await ctx.reset.apply({ actorId: "admin", backup: new FakeOpeningBackupAdapter(), external: new FakeOpeningExternalAdapter() });
    expect(result.status).toBe("completed");

    // casino_txのsequence行は消える(次回挿入時に1から採番される。行自体が無い＝リセット済み)
    expect(sequenceOf(ctx.db, "casino_tx")).toBeUndefined();
    // Land台帳のtransactionsテーブルのsequenceは、R7/R8の追記ぶんだけ増えているが
    // リセットはされていない(単調増加を維持している=beforeの値より小さくなっていない)
    expect(sequenceOf(ctx.db, "transactions")).toBeGreaterThanOrEqual(transactionsSeqBefore);
    // casino_status_historyのsequenceもR14の状態遷移分だけ増えるが、リセットされない
    expect(sequenceOf(ctx.db, "casino_status_history")).toBeGreaterThanOrEqual(statusHistorySeqBefore);
  });

  it("COMMIT後の最初の新制度txがopening_v1の検算窓へ正しく入る(version_seqにより新旧が混ざらない)", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    ctx.chipTx.runMaintenance("test-seed", () => {
      ctx.chipTx.runGroup({ groupKey: "seed-2", kind: "opening_reset", actorId: "system:test" }, () => {
        for (let i = 0; i < 3; i++) {
          ctx.ether.transfer(HOUSE_HOLDER, "jackpot", 1, { reason: "seed" });
          ctx.ether.transfer("jackpot", HOUSE_HOLDER, 1, { reason: "seed-return" });
        }
      });
    });
    const legacyLastId = (ctx.db.prepare("SELECT MAX(id) AS id FROM casino_tx").get() as { id: number }).id;
    configureAndOpenReset(ctx);
    await ctx.reset.apply({ actorId: "admin", backup: new FakeOpeningBackupAdapter(), external: new FakeOpeningExternalAdapter() });

    // 採番はリセットされ、新しいidはlegacyLastIdより小さくなる
    ctx.ether.runGroup({ groupKey: "post-open", kind: "opening_reset", actorId: "system:test" }, () => {
      ctx.ether.transfer(HOUSE_HOLDER, "jackpot", 100, { reason: "post-open move" });
    });
    const newTx = ctx.db.prepare("SELECT id, opening_version FROM casino_tx ORDER BY id DESC LIMIT 1").get() as {
      id: number;
      opening_version: string;
    };
    expect(newTx.id).toBeLessThan(legacyLastId);
    expect(newTx.opening_version).toBe(FORMAL_OPENING_VERSION);

    // opening_v1の検算窓に、巻き戻ったIDにもかかわらず正しく1件だけ入る(旧取引と混ざらない)
    const replay = ctx.chipTx.replayBalances(FORMAL_OPENING_VERSION);
    const opening = ctx.chipTx.openingBalances(FORMAL_OPENING_VERSION);
    expect(replay.get(HOUSE_HOLDER)).toBe((opening.get(HOUSE_HOLDER) ?? 0) - 100);
    expect(replay.get("jackpot")).toBe((opening.get("jackpot") ?? 0) + 100);
    const verify = ctx.chipTx.verifyBalances(FORMAL_OPENING_VERSION);
    expect(verify.ok).toBe(true);

    // legacy_pre_reset側の検算窓は、casino_txが空になった後は開始残高同士の比較に退化するだけで、
    // 新しい取引を誤って拾わない(=旧版の検算窓に新版の行が混入しない)
    const legacyReplay = ctx.chipTx.replayBalances(LEGACY_OPENING_VERSION);
    const legacyOpening = ctx.chipTx.openingBalances(LEGACY_OPENING_VERSION);
    expect(legacyReplay).toEqual(legacyOpening);
  });

  it("R9後からCOMMIT前に例外が出た場合、casino_tx・casino_tx_groups・sqlite_sequenceがすべて呼出前へ戻る", async () => {
    const ctx = setup();
    seedLegacy(ctx);
    ctx.chipTx.runMaintenance("test-seed", () => {
      ctx.chipTx.runGroup({ groupKey: "seed-3", kind: "opening_reset", actorId: "system:test" }, () => {
        ctx.ether.transfer(HOUSE_HOLDER, "jackpot", 1, { reason: "seed" });
        ctx.ether.transfer("jackpot", HOUSE_HOLDER, 1, { reason: "seed-return" });
      });
    });
    const casinoTxRowsBefore = (ctx.db.prepare("SELECT * FROM casino_tx ORDER BY id").all()) as unknown[];
    const casinoTxGroupsRowsBefore = (ctx.db.prepare("SELECT * FROM casino_tx_groups ORDER BY group_key").all()) as unknown[];
    const casinoTxSeqBefore = sequenceOf(ctx.db, "casino_tx");
    configureAndOpenReset(ctx);

    // postflight V1を強制的に失敗させる: R10(captureOpening)が実際に呼ばれた「後」だけ、
    // 準備Land(sys:escrow:casino)の読み取りを嘘の値にすり替える。R6〜R10はすべて実行された
    // 状態でV1がNGになり、transaction全体がROLLBACKされることを確認する。
    const originalBalanceOf = ctx.ledger.balanceOf.bind(ctx.ledger);
    let afterR10 = false;
    vi.spyOn(ctx.ledger, "balanceOf").mockImplementation((accountId: string) => {
      const real = originalBalanceOf(accountId);
      if (accountId === "sys:escrow:casino" && afterR10) return real + 12345; // V1をわざと不一致にする
      return real;
    });
    const originalCaptureOpening = ctx.chipTx.captureOpening.bind(ctx.chipTx);
    vi.spyOn(ctx.chipTx, "captureOpening").mockImplementation((...args: Parameters<typeof originalCaptureOpening>) => {
      const result = originalCaptureOpening(...args);
      afterR10 = true; // R10完了。以降のV1判定だけを壊す
      return result;
    });

    await expect(
      ctx.reset.apply({ actorId: "admin", backup: new FakeOpeningBackupAdapter(), external: new FakeOpeningExternalAdapter() }),
    ).rejects.toThrow();

    vi.restoreAllMocks();

    // ROLLBACKにより、legacy期の状態が完全に元通りになっている
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    const casinoTxRowsAfter = ctx.db.prepare("SELECT * FROM casino_tx ORDER BY id").all();
    const casinoTxGroupsRowsAfter = ctx.db.prepare("SELECT * FROM casino_tx_groups ORDER BY group_key").all();
    expect(casinoTxRowsAfter).toEqual(casinoTxRowsBefore);
    expect(casinoTxGroupsRowsAfter).toEqual(casinoTxGroupsRowsBefore);
    expect(sequenceOf(ctx.db, "casino_tx")).toBe(casinoTxSeqBefore);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(30_000);
  });
});
