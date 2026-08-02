import { describe, expect, it, vi } from "vitest";
import {
  CASINO_DEPARTMENT,
  CasinoOpeningReset,
  CasinoStatus,
  FREE_SPIN_JACKPOT_CLAIMS_HOLDER,
  Ledger,
  ChipLedger,
  ChipLedgerError,
  ChipTx,
  EventLog,
  ETHER_ESCROW,
  CHIP_ESCROW,
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
      backup: vi.fn(async () => ({
        sqliteSha256: "a".repeat(64),
        csv: [{ table: "casino_escrow", sha256: "b".repeat(64), rows: 0 }],
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
  ledger.transfer({
    from: "sys:treasury",
    to: ETHER_ESCROW,
    amount: oldReserveLand,
    type: "ether_house_fund",
    actor: "test",
    idempotencyKey: "seed-opening",
  });
  return { db, ledger, chips, chipTx, status, reset: new CasinoOpeningReset(db, ledger, chipTx) };
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

function seedProtectedData(ctx: ReturnType<typeof fundedReset>): void {
  ctx.db.exec(`
    DROP TABLE IF EXISTS vip_members;
    DROP TABLE IF EXISTS stocks;
    DROP TABLE IF EXISTS casino_stats;
    DROP TABLE IF EXISTS quarantine_assets;
    CREATE TABLE vip_members (user_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE stocks (user_id TEXT NOT NULL, symbol TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY(user_id, symbol));
    CREATE TABLE casino_stats (user_id TEXT PRIMARY KEY, wins INTEGER NOT NULL, losses INTEGER NOT NULL);
    CREATE TABLE quarantine_assets (holder_id TEXT PRIMARY KEY, amount INTEGER NOT NULL, reason TEXT NOT NULL);
    INSERT INTO vip_members VALUES ('alice', 123456);
    INSERT INTO stocks VALUES ('alice', 'MAMMON', 7);
    INSERT INTO casino_stats VALUES ('alice', 3, 2);
    INSERT INTO quarantine_assets VALUES ('sys:quarantine:test', 50, 'review');
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
    const db = openDb(":memory:");
    const chips = new ChipLedger(db, new Ledger(db), new EventLog(db));
    db.exec(`CREATE TABLE casino_pending_free_spins (id INTEGER PRIMARY KEY, status TEXT, jackpot_claim INTEGER)`);
    db.prepare("INSERT INTO casino_pending_free_spins VALUES (1,'pending',30),(2,'settled',20)").run();
    chips.ensureHolder(FREE_SPIN_JACKPOT_CLAIMS_HOLDER);
    const p = new CasinoOpeningReset(db).dryRun(config);
    expect(p.freeSpinClaims).toMatchObject({ pendingIds: [1], expected: 30, actual: 0, matches: false });
    expect(p.blockers.join(" ")).toContain("未精算無料スピン");
    expect(p.blockers.join(" ")).toContain("無料スピンJP請求不一致");
    db.close();
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
    expect(plan.playerLand.sha256).toHaveLength(64);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_configuration").get()).toEqual(before);
    expectOpeningLocked(ctx, "after:dry-run");
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

  it("hash、バックアップ、fake Discord adapterを要求し、apply成功後だけ1:1操作を解放する", async () => {
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
    expect(txById(applied.oldSettlementLandTxId)).toEqual({
      from_account: ETHER_ESCROW,
      to_account: CASINO_DEPARTMENT,
      amount: 1_500,
    });
    expect(txById(applied.newInvestmentLandTxId)).toEqual({
      from_account: CASINO_DEPARTMENT,
      to_account: CHIP_ESCROW,
      amount: 1_000,
    });
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(ctx.ledger.balanceOf(CASINO_DEPARTMENT)).toBe(500);
    expect(ctx.db.prepare("SELECT 1 FROM accounts WHERE id='sys:dept:casino'").get()).toBeUndefined();
    ctx.db.close();
  });

  it("VIP・株・戦績・隔離データは存在してもblockerにせず、内容を完全に保全する", async () => {
    const ctx = fundedReset();
    seedProtectedData(ctx);
    const plan = ctx.reset.dryRun(config);
    expect(plan.blockers).toEqual([]);
    expect(plan.protectedRows).toEqual({ vip_members: 1, stocks: 1, casino_stats: 1, quarantine_assets: 1 });

    await ctx.reset.apply(applyInput(ctx, plan.planHash));
    expect(ctx.db.prepare("SELECT * FROM vip_members").all()).toEqual([{ user_id: "alice", expires_at: 123456 }]);
    expect(ctx.db.prepare("SELECT * FROM stocks").all()).toEqual([{ user_id: "alice", symbol: "MAMMON", qty: 7 }]);
    expect(ctx.db.prepare("SELECT * FROM casino_stats").all()).toEqual([{ user_id: "alice", wins: 3, losses: 2 }]);
    expect(ctx.db.prepare("SELECT * FROM quarantine_assets").all()).toEqual([{ holder_id: "sys:quarantine:test", amount: 50, reason: "review" }]);
    ctx.db.close();
  });

  it("保全対象がadapter実行中に変わった場合は資金初期化前に停止する", async () => {
    const ctx = fundedReset();
    seedProtectedData(ctx);
    const plan = ctx.reset.dryRun(config);
    const adapters = cleanAdapters();
    adapters.discord.disableLegacyCasino = async () => {
      ctx.db.prepare("UPDATE vip_members SET expires_at=999999 WHERE user_id='alice'").run();
    };

    await expect(ctx.reset.apply(applyInput(ctx, plan.planHash, adapters))).rejects.toThrow("protected casino data");
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
    const backup: OpeningBackupAdapter = {
      backup: async () => { throw new Error("archive unavailable"); },
    };
    await expect(ctx.reset.apply({
      ...applyInput(ctx, plan.planHash),
      backup,
    })).rejects.toThrow("archive unavailable");
    expect(ctx.status.current().status).toBe("opening_reset");
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(1_000);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_reset_plans").get()).toEqual({ n: 0 });
    expectOpeningLocked(ctx, "after:backup-failure");
    ctx.db.close();
  });
});
