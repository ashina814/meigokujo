import { describe, expect, it, vi } from "vitest";
import {
  CASINO_DEPARTMENT,
  CHIP_ESCROW,
  CasinoOpeningReset,
  CasinoStatus,
  ChipLedger,
  ChipLedgerError,
  ChipTx,
  ETHER_APPROVER,
  ETHER_ESCROW,
  EventLog,
  FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
  Ledger,
  openDb,
  registerDefaultTxTypes,
  type OpeningBackupAdapter,
  type OpeningDiscordAdapter,
} from "../src/index.js";

registerDefaultTxTypes();

const config = {
  configured: true as const,
  casinoOpeningCapital: 1_000,
  houseCapital: 800,
  jackpotCapital: 100,
  reliefCapital: 100,
  minimumWorkingCapital: 100,
  remittanceBps: 0,
};

function cleanAdapters(): {
  backup: OpeningBackupAdapter;
  discord: OpeningDiscordAdapter;
  disabled: ReturnType<typeof vi.fn>;
} {
  const disabled = vi.fn(async () => undefined);
  return {
    backup: {
      backup: vi.fn(async ({ db, legacyTables }) => ({
        sqliteSha256: "a".repeat(64),
        csv: legacyTables.map((table: string) => ({
          table,
          sha256: "b".repeat(64),
          rows: (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
        })),
        createdAt: 1,
      })),
    },
    discord: { disableLegacyCasino: disabled },
    disabled,
  };
}

function fundedReset(oldReserveLand = 1_000) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx, requireOpeningV1: true });
  const status = new CasinoStatus(db);
  const lastLedgerTx = (db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM transactions").get() as { id: number }).id;
  if (!chipTx.captureLegacyOpening({ poolLand: 0, fromLedgerTxId: lastLedgerTx })) {
    throw new Error("legacy opening baseline already exists");
  }
  if (oldReserveLand > 0) {
    chipTx.runGroup({ groupKey: "seed-opening", kind: "deposit", actorId: ETHER_APPROVER }, () => {
      ledger.transfer({
        from: "sys:treasury",
        to: ETHER_ESCROW,
        amount: oldReserveLand,
        type: "ether_house_fund",
        actor: ETHER_APPROVER,
        approvedBy: ETHER_APPROVER,
        idempotencyKey: "seed-opening",
      });
    });
  }
  return { db, ledger, chips, chipTx, status, reset: new CasinoOpeningReset(db, ledger, chipTx) };
}

function fundDepartment(ctx: ReturnType<typeof fundedReset>, amount: number): void {
  ctx.ledger.ensureAccount(CASINO_DEPARTMENT, "system");
  ctx.ledger.transfer({
    from: "sys:treasury",
    to: CASINO_DEPARTMENT,
    amount,
    type: "ether_house_fund",
    actor: "admin:fund",
    approvedBy: "admin:fund",
    idempotencyKey: `seed-department:${amount}`,
  });
}

function fundPlayerLand(ctx: ReturnType<typeof fundedReset>, userId = "alice", amount = 5_000): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: "sys:treasury",
    to: `user:${userId}`,
    amount,
    type: "initial",
    actor: "test",
    idempotencyKey: `seed-player:${userId}`,
  });
}

function expectOpeningLocked(ctx: ReturnType<typeof fundedReset>, key: string): void {
  let error: unknown;
  try {
    ctx.chips.deposit("alice", 10, key);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ChipLedgerError);
  expect((error as { code: string }).code).toBe("ERR_CASINO_OPENING_NOT_COMPLETE");
}

function createProtectedTables(ctx: ReturnType<typeof fundedReset>): void {
  ctx.db.exec(`
    CREATE TABLE IF NOT EXISTS casino_vip (
      user_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS casino_stocks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      price INTEGER NOT NULL,
      prev_price INTEGER NOT NULL,
      trend REAL NOT NULL,
      last_update INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS casino_holdings (
      user_id TEXT NOT NULL,
      stock_id TEXT NOT NULL,
      shares INTEGER NOT NULL,
      avg_cost INTEGER NOT NULL,
      bought_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, stock_id)
    );
    CREATE TABLE IF NOT EXISTS casino_stats (
      user_id TEXT PRIMARY KEY,
      games INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      losses INTEGER NOT NULL,
      total_wagered INTEGER NOT NULL,
      total_earned INTEGER NOT NULL,
      total_lost INTEGER NOT NULL,
      biggest_win INTEGER NOT NULL,
      current_win_streak INTEGER NOT NULL,
      best_win_streak INTEGER NOT NULL,
      current_lose_streak INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function seedBlockingProtectedData(ctx: ReturnType<typeof fundedReset>): void {
  createProtectedTables(ctx);
  ctx.db.exec(`
    INSERT INTO casino_vip VALUES ('alice', 2000000000);
    INSERT INTO casino_stocks VALUES ('hone', '骸骨精鉱', '💀', 1200, 1000, 0.1, 1);
    INSERT INTO casino_holdings VALUES ('alice', 'hone', 7, 1100, 12345);
    INSERT INTO casino_stats VALUES ('alice', 5, 3, 2, 500, 700, 400, 300, 1, 2, 0, 1);
    INSERT INTO ether_balances (user_id, amount, updated_at)
      VALUES ('sys:escrow:quarantine', 50, 1)
      ON CONFLICT(user_id) DO UPDATE SET amount=50, updated_at=1;
  `);
}

function seedNonBlockingProtectedData(ctx: ReturnType<typeof fundedReset>): void {
  createProtectedTables(ctx);
  ctx.db.exec(`
    INSERT INTO casino_vip VALUES ('expired', 1);
    INSERT INTO casino_stocks VALUES ('hone', '骸骨精鉱', '💀', 1200, 1000, 0.1, 1);
    INSERT INTO casino_holdings VALUES ('alice', 'hone', 0, 0, 0);
    INSERT INTO casino_stats VALUES ('alice', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
  `);
}

function applyInput(ctx: ReturnType<typeof fundedReset>, planHash: string, adapters = cleanAdapters()) {
  return {
    configuration: config,
    planHash,
    actorId: "admin:a",
    backup: adapters.backup,
    discord: adapters.discord,
    status: ctx.status,
  };
}

describe("PR12 開業初期化 preflight", () => {
  it("未精算フリースピンと固定JP請求holderを読み取り検査し、不一致やpendingをblockerにする", () => {
    const ctx = fundedReset(0);
    ctx.db.exec("CREATE TABLE casino_pending_free_spins (id INTEGER PRIMARY KEY, status TEXT, jackpot_claim INTEGER)");
    ctx.db.prepare("INSERT INTO casino_pending_free_spins VALUES (1,'pending',30),(2,'settled',20)").run();
    ctx.chips.ensureHolder(FREE_SPIN_JACKPOT_CLAIMS_HOLDER);
    const plan = ctx.reset.dryRun(config);
    expect(plan.freeSpinClaims).toMatchObject({ pendingIds: [1], expected: 30, actual: 0, matches: false });
    expect(plan.blockers.join(" ")).toContain("未精算無料スピン");
    expect(plan.blockers.join(" ")).toContain("無料スピンJP請求不一致");
    ctx.db.close();
  });

  it("設定の資本内訳不一致を拒否し、dry-run は書込みもロック解除も行わない", () => {
    const ctx = fundedReset();
    fundPlayerLand(ctx);
    const before = ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_configuration").get() as { n: number };
    expectOpeningLocked(ctx, "before:dry-run");
    expect(() => ctx.reset.dryRun({ ...config, reliefCapital: 99 })).toThrow("house + jackpot + relief");
    const plan = ctx.reset.dryRun(config);
    expect(plan.blockers).toEqual([]);
    expect(plan.oldReserveLand).toBe(1_000);
    expect(plan.openingSourceLand).toBe(1_000);
    expect(plan.legacyIntegrity).toMatchObject({ chipBalancesOk: true, reserveLandMatches: true, ok: true });
    expect(plan.playerLand.sha256).toHaveLength(64);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_configuration").get()).toEqual(before);
    expectOpeningLocked(ctx, "after:dry-run");
    ctx.db.close();
  });

  it("旧準備口座の説明不能なLand取引をplanへ記録し、初期化を停止する", () => {
    const ctx = fundedReset();
    ctx.ledger.transfer({
      from: "sys:treasury",
      to: ETHER_ESCROW,
      amount: 10,
      type: "adjust",
      actor: "manual",
      approvedBy: "manual",
      idempotencyKey: "untracked-reserve-change",
    });
    const plan = ctx.reset.dryRun(config);
    expect(plan.legacyIntegrity.reserveTransactions.at(-1)).toMatchObject({
      type: "adjust",
      valid: false,
      problem: "unknown_type:adjust",
    });
    expect(plan.legacyIntegrity.ok).toBe(false);
    expect(plan.blockers.join(" ")).toContain("旧制度のチップ検算または準備口座経路監査が不一致");
    ctx.db.close();
  });

  it("applyは同一DBのCasinoStatusを必須とし、R0停止を省略できない", async () => {
    const ctx = fundedReset();
    const plan = ctx.reset.dryRun(config);
    const adapters = cleanAdapters();

    await expect(ctx.reset.apply({
      ...applyInput(ctx, plan.planHash, adapters),
      status: undefined as unknown as CasinoStatus,
    })).rejects.toThrow("status is required");
    expect(ctx.status.current().status).toBe("open");
    expect(adapters.disabled).not.toHaveBeenCalled();

    const otherDb = openDb(":memory:");
    const otherStatus = new CasinoStatus(otherDb);
    await expect(ctx.reset.apply({
      ...applyInput(ctx, plan.planHash),
      status: otherStatus,
    })).rejects.toThrow("same database");
    expect(ctx.status.current().status).toBe("open");
    otherDb.close();
    ctx.db.close();
  });

  it("正本の補償候補を実テーブルから対象者別に出し、一件でもあれば初期化を止める", () => {
    const ctx = fundedReset();
    seedBlockingProtectedData(ctx);
    const plan = ctx.reset.dryRun(config);

    expect(plan.protectedFindings.activeVip).toEqual([{ userId: "alice", expiresAt: 2_000_000_000 }]);
    expect(plan.protectedFindings.stockHoldings).toEqual([{ userId: "alice", stockId: "hone", shares: 7, avgCost: 1_100, boughtAt: 12_345 }]);
    expect(plan.protectedFindings.casinoStats).toEqual([expect.objectContaining({ userId: "alice", games: 5, totalWagered: 500 })]);
    expect(plan.protectedFindings.quarantineChips).toBe(50);
    expect(plan.blockers.join(" ")).toContain("active VIP compensation candidates: 1");
    expect(plan.blockers.join(" ")).toContain("stock holding compensation candidates: 1");
    expect(plan.blockers.join(" ")).toContain("casino stats preservation candidates: 1");
    expect(plan.blockers.join(" ")).toContain("quarantine assets require manual attribution: 50");
    ctx.db.close();
  });

  it("期限切れVIP・ゼロ株・ゼロ戦績・銘柄マスタはblockerにせず、内容を完全に保全する", async () => {
    const ctx = fundedReset();
    seedNonBlockingProtectedData(ctx);
    const plan = ctx.reset.dryRun(config);
    expect(plan.blockers).toEqual([]);
    expect(plan.protectedRows).toEqual({ casino_vip: 1, casino_stocks: 1, casino_holdings: 1, casino_stats: 1 });

    await ctx.reset.apply(applyInput(ctx, plan.planHash));
    expect(ctx.db.prepare("SELECT * FROM casino_vip").all()).toEqual([{ user_id: "expired", expires_at: 1 }]);
    expect(ctx.db.prepare("SELECT * FROM casino_stocks").all()).toEqual([{ id: "hone", name: "骸骨精鉱", emoji: "💀", price: 1200, prev_price: 1000, trend: 0.1, last_update: 1 }]);
    expect(ctx.db.prepare("SELECT * FROM casino_holdings").all()).toEqual([{ user_id: "alice", stock_id: "hone", shares: 0, avg_cost: 0, bought_at: 0 }]);
    expect(ctx.db.prepare("SELECT * FROM casino_stats").all()).toEqual([{ user_id: "alice", games: 0, wins: 0, losses: 0, total_wagered: 0, total_earned: 0, total_lost: 0, biggest_win: 0, current_win_streak: 0, best_win_streak: 0, current_lose_streak: 0, updated_at: 1 }]);
    ctx.db.close();
  });

  it("全casinoテーブル・旧残高・設定のCSVを要求し、欠落や件数違いを拒否する", async () => {
    const ctx = fundedReset();
    const plan = ctx.reset.dryRun(config);
    expect(plan.archiveTables).toContain("ether_balances");
    expect(plan.archiveTables).toContain("settings");
    expect(plan.archiveTables).toContain("casino_tx");
    expect(plan.archiveTables).toContain("casino_chip_opening_balances");

    const backup: OpeningBackupAdapter = {
      backup: async () => ({
        sqliteSha256: "a".repeat(64),
        csv: [{ table: "ether_balances", sha256: "b".repeat(64), rows: 0 }],
        createdAt: 1,
      }),
    };
    await expect(ctx.reset.apply({ ...applyInput(ctx, plan.planHash), backup })).rejects.toThrow("manifest table set mismatch");
    expect(ctx.status.current().status).toBe("opening_reset");
    ctx.db.close();
  });

  it("hash、完全バックアップ、fake Discord adapterを要求し、apply成功後だけ1:1操作を解放する", async () => {
    const ctx = fundedReset();
    fundPlayerLand(ctx);
    expectOpeningLocked(ctx, "before:apply");
    const plan = ctx.reset.dryRun(config);
    const adapters = cleanAdapters();
    const applied = await ctx.reset.apply(applyInput(ctx, plan.planHash, adapters));

    expect(adapters.disabled).toHaveBeenCalledOnce();
    expect(applied.oldSettlementLandTxId).not.toBe(applied.newInvestmentLandTxId);
    expect(ctx.status.current().status).toBe("open");
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(ctx.chips.balanceOf("house")).toBe(800);
    expect(ctx.chips.balanceOf("jackpot")).toBe(100);
    expect(ctx.reset.configuration()).toEqual(config);
    const deposit = ctx.chips.deposit("alice", 10, "after:apply");
    expect(deposit).toEqual({ input: 10, output: 10, burned: 0 });
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(1_010);
    await expect(ctx.reset.apply({ ...applyInput(ctx, plan.planHash), actorId: "admin:b" })).rejects.toThrow("already applied");
    ctx.db.close();
  });

  it("旧準備を全額清算し、新制度には設定済み資本だけを出資する", async () => {
    const ctx = fundedReset(1_500);
    const plan = ctx.reset.dryRun(config);
    expect(plan.oldReserveLand).toBe(1_500);
    const applied = await ctx.reset.apply(applyInput(ctx, plan.planHash));
    const txById = (id: number) =>
      ctx.db.prepare("SELECT from_account, to_account, amount FROM transactions WHERE id=?").get(id) as
        { from_account: string; to_account: string; amount: number };

    expect(CASINO_DEPARTMENT).toBe("sys:dept:賭博場");
    expect(applied.oldSettlementLandTxId).not.toBeNull();
    expect(txById(applied.oldSettlementLandTxId!)).toEqual({ from_account: ETHER_ESCROW, to_account: CASINO_DEPARTMENT, amount: 1_500 });
    expect(txById(applied.newInvestmentLandTxId)).toEqual({ from_account: CASINO_DEPARTMENT, to_account: CHIP_ESCROW, amount: 1_000 });
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(ctx.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(500);
    expect(ctx.db.prepare("SELECT 1 FROM accounts WHERE id='sys:dept:casino'").get()).toBeUndefined();
    ctx.db.close();
  });

  it("旧準備が0でも部署資金が足りれば開業でき、0額の旧清算取引を作らない", async () => {
    const ctx = fundedReset(0);
    fundDepartment(ctx, 1_000);
    const plan = ctx.reset.dryRun(config);
    expect(plan).toMatchObject({ oldReserveLand: 0, departmentLandBefore: 1_000, openingSourceLand: 1_000, blockers: [] });

    const applied = await ctx.reset.apply(applyInput(ctx, plan.planHash));
    expect(applied.oldSettlementLandTxId).toBeNull();
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key LIKE '%old-settlement'").get()).toEqual({ n: 0 });
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(ctx.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(0);
    ctx.db.close();
  });

  it("adapter実行中に準備・保全データが変われば、資金初期化前にstale拒否する", async () => {
    const ctx = fundedReset();
    seedNonBlockingProtectedData(ctx);
    const plan = ctx.reset.dryRun(config);
    const adapters = cleanAdapters();
    adapters.discord.disableLegacyCasino = async () => {
      ctx.db.prepare("UPDATE casino_stocks SET price=9999 WHERE id='hone'").run();
    };

    await expect(ctx.reset.apply(applyInput(ctx, plan.planHash, adapters))).rejects.toThrow("stale after adapters");
    expect(ctx.status.current().status).toBe("opening_reset");
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(1_000);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(0);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_reset_plans").get()).toEqual({ n: 0 });
    ctx.db.close();
  });

  it("利用者Landは口座ごとのhashで固定し、総額が同じ付け替えもstaleとして拒否する", async () => {
    const ctx = fundedReset();
    fundPlayerLand(ctx, "alice", 5_000);
    fundPlayerLand(ctx, "bob", 2_500);
    const plan = ctx.reset.dryRun(config);

    ctx.db.prepare("UPDATE balances SET amount=amount-100 WHERE account_id='user:alice'").run();
    ctx.db.prepare("UPDATE balances SET amount=amount+100 WHERE account_id='user:bob'").run();

    await expect(ctx.reset.apply(applyInput(ctx, plan.planHash))).rejects.toThrow("plan hash is stale");
    expect(ctx.status.current().status).toBe("open");
    expect(ctx.ledger.balanceOf("user:alice")).toBe(4_900);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(2_600);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(1_000);
    ctx.db.close();
  });

  it("バックアップ失敗ではR4以降を変更せず、opening_reset停止と正式開業ロックを維持する", async () => {
    const ctx = fundedReset();
    fundPlayerLand(ctx);
    const plan = ctx.reset.dryRun(config);
    const backup: OpeningBackupAdapter = { backup: async () => { throw new Error("archive unavailable"); } };
    await expect(ctx.reset.apply({ ...applyInput(ctx, plan.planHash), backup })).rejects.toThrow("archive unavailable");
    expect(ctx.status.current().status).toBe("opening_reset");
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(1_000);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_reset_plans").get()).toEqual({ n: 0 });
    expectOpeningLocked(ctx, "after:backup-failure");
    ctx.db.close();
  });
});
