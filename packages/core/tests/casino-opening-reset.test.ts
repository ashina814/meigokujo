import { describe, expect, it, vi } from "vitest";
import {
  CASINO_DEPARTMENT,
  CasinoOpeningReset,
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
const config = { configured: true as const, casinoOpeningCapital: 1000, houseCapital: 800, jackpotCapital: 100, reliefCapital: 100, minimumWorkingCapital: 100, remittanceBps: 0 };

function cleanAdapters(): { backup: OpeningBackupAdapter; discord: OpeningDiscordAdapter; disabled: ReturnType<typeof vi.fn> } {
  const disabled = vi.fn(async () => undefined);
  return {
    backup: { backup: vi.fn(async () => ({ sqliteSha256: "a".repeat(64), csv: [{ table: "casino_escrow", sha256: "b".repeat(64), rows: 0 }], createdAt: 1 })) },
    discord: { disableLegacyCasino: disabled }, disabled,
  };
}

function fundedReset() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const chipTx = new ChipTx(db);
  // productionと同じ共有ChipTx構築。opening_v1までは資金操作がcore層で閉じる。
  const chips = new ChipLedger(db, ledger, new EventLog(db), { chipTx });
  ledger.transfer({ from: "sys:treasury", to: ETHER_ESCROW, amount: 1_000, type: "ether_house_fund", actor: "test", idempotencyKey: "seed-opening" });
  return { db, ledger, chips, chipTx, reset: new CasinoOpeningReset(db, ledger, chipTx) };
}

function fundPlayerLand(ctx: ReturnType<typeof fundedReset>, userId = "alice", amount = 5_000): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: "sys:treasury", to: `user:${userId}`, amount, type: "initial", actor: "test", idempotencyKey: `seed-player:${userId}` });
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
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_configuration").get()).toEqual(before);
    expectOpeningLocked(ctx, "after:dry-run");
    ctx.db.close();
  });

  it("hash、バックアップ、fake Discord adapter を要求し、apply成功後だけ1:1操作を解放する", async () => {
    const ctx = fundedReset();
    fundPlayerLand(ctx);
    expectOpeningLocked(ctx, "before:apply");
    const plan = ctx.reset.dryRun(config);
    const { backup, discord, disabled } = cleanAdapters();
    const applied = await ctx.reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin:a", backup, discord });
    expect(disabled).toHaveBeenCalledOnce();
    expect(applied.oldSettlementLandTxId).not.toBe(applied.newInvestmentLandTxId);
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(0);
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(ctx.chips.balanceOf("house")).toBe(800);
    expect(ctx.chips.balanceOf("jackpot")).toBe(100);
    expect(ctx.reset.configuration()).toEqual(config);

    const deposit = ctx.chips.deposit("alice", 10, "after:apply");
    expect(deposit).toEqual({ input: 10, output: 10, burned: 0 });
    expect(ctx.ledger.balanceOf(CHIP_ESCROW)).toBe(1_010);
    await expect(ctx.reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin:b", backup, discord })).rejects.toThrow("already applied");
    ctx.db.close();
  });

  it("旧制度清算・新制度出資が正本の賭博場部署だけを通り、sys:dept:casino を作らない", async () => {
    const { db, ledger, reset } = fundedReset();
    const plan = reset.dryRun(config);
    const { backup, discord } = cleanAdapters();
    const applied = await reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin:a", backup, discord });

    expect(CASINO_DEPARTMENT).toBe("sys:dept:賭博場");
    const txById = (id: number) =>
      db.prepare("SELECT from_account, to_account, amount FROM transactions WHERE id=?").get(id) as
        { from_account: string; to_account: string; amount: number };
    expect(txById(applied.oldSettlementLandTxId)).toEqual({ from_account: ETHER_ESCROW, to_account: CASINO_DEPARTMENT, amount: 1_000 });
    expect(txById(applied.newInvestmentLandTxId)).toEqual({ from_account: CASINO_DEPARTMENT, to_account: CHIP_ESCROW, amount: 1_000 });
    expect(db.prepare("SELECT 1 FROM accounts WHERE id='sys:dept:casino'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE from_account='sys:dept:casino' OR to_account='sys:dept:casino'").get()).toEqual({ n: 0 });
    expect(ledger.balanceOf("sys:dept:casino")).toBe(0);
    expect(ledger.balanceOf(CASINO_DEPARTMENT)).toBe(0);
    db.close();
  });

  it("利用者の通常Landを変えず、変わってしまう場合は適用ごとROLLBACKする", async () => {
    const { db, ledger, chips, reset } = fundedReset();
    ledger.ensureAccount("user:alice", "user");
    ledger.ensureAccount("user:bob", "user");
    ledger.transfer({ from: "sys:treasury", to: "user:alice", amount: 5_000, type: "initial", actor: "test", idempotencyKey: "seed-alice" });
    ledger.transfer({ from: "sys:treasury", to: "user:bob", amount: 2_500, type: "initial", actor: "test", idempotencyKey: "seed-bob" });
    const plan = reset.dryRun(config);
    const { backup, discord } = cleanAdapters();

    await reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin:a", backup, discord });
    expect(ledger.balanceOf("user:alice")).toBe(5_000);
    expect(ledger.balanceOf("user:bob")).toBe(2_500);
    db.close();

    const second = fundedReset();
    second.ledger.ensureAccount("user:alice", "user");
    second.ledger.transfer({ from: "sys:treasury", to: "user:alice", amount: 5_000, type: "initial", actor: "test", idempotencyKey: "seed-alice" });
    expectOpeningLocked(second, "before:rollback");
    const secondPlan = second.reset.dryRun(config);
    const tampering = {
      backup: {
        backup: async () => {
          second.db.prepare("UPDATE balances SET amount = amount - 1 WHERE account_id = 'user:alice'").run();
          return { sqliteSha256: "a".repeat(64), csv: [], createdAt: 1 };
        },
      },
      discord: { disableLegacyCasino: async () => undefined },
    };
    await expect(second.reset.apply({ configuration: config, planHash: secondPlan.planHash, actorId: "admin:a", ...tampering }))
      .rejects.toThrow("must not change player Land");
    expect(second.ledger.balanceOf(ETHER_ESCROW)).toBe(1_000);
    expect(second.chips.balanceOf("house")).toBe(0);
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_reset_plans").get()).toEqual({ n: 0 });
    expectOpeningLocked(second, "after:rollback");
    second.db.close();
  });

  it("バックアップ失敗では R4 以降を一切変更せず、正式開業ロックも維持する", async () => {
    const ctx = fundedReset();
    fundPlayerLand(ctx);
    const plan = ctx.reset.dryRun(config);
    const backup: OpeningBackupAdapter = { backup: async () => { throw new Error("archive unavailable"); } };
    await expect(ctx.reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin", backup, discord: { disableLegacyCasino: async () => undefined } })).rejects.toThrow("archive unavailable");
    expect(ctx.ledger.balanceOf(ETHER_ESCROW)).toBe(1_000);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_opening_reset_plans").get()).toEqual({ n: 0 });
    expectOpeningLocked(ctx, "after:backup-failure");
    ctx.db.close();
  });
});
