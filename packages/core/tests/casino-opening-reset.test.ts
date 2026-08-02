import { describe, expect, it, vi } from "vitest";
import { CASINO_DEPARTMENT, CasinoOpeningReset, FREE_SPIN_JACKPOT_CLAIMS_HOLDER, Ledger, ChipLedger, EventLog, ETHER_ESCROW, CHIP_ESCROW, openDb, registerDefaultTxTypes, type OpeningBackupAdapter, type OpeningDiscordAdapter } from "../src/index.js";

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
  const chips = new ChipLedger(db, ledger, new EventLog(db));
  ledger.transfer({ from: "sys:treasury", to: ETHER_ESCROW, amount: 1_000, type: "ether_house_fund", actor: "test", idempotencyKey: "seed-opening" });
  return { db, ledger, chips, reset: new CasinoOpeningReset(db, ledger, chips.chipTx) };
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

  it("設定の資本内訳不一致を拒否し、dry-run は書込みを行わない", () => {
    const { db, reset } = fundedReset();
    const before = db.prepare("SELECT COUNT(*) AS n FROM casino_opening_configuration").get() as { n: number };
    expect(() => reset.dryRun({ ...config, reliefCapital: 99 })).toThrow("house + jackpot + relief");
    const plan = reset.dryRun(config);
    expect(plan.blockers).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM casino_opening_configuration").get()).toEqual(before);
    db.close();
  });

  it("hash、バックアップ、fake Discord adapter を要求し、Land取引を分離して一度だけ適用する", async () => {
    const { db, ledger, chips, reset } = fundedReset();
    const plan = reset.dryRun(config);
    const { backup, discord, disabled } = cleanAdapters();
    const applied = await reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin:a", backup, discord });
    expect(disabled).toHaveBeenCalledOnce();
    expect(applied.oldSettlementLandTxId).not.toBe(applied.newInvestmentLandTxId);
    expect(ledger.balanceOf(ETHER_ESCROW)).toBe(0);
    expect(ledger.balanceOf(CHIP_ESCROW)).toBe(1_000);
    expect(chips.balanceOf("house")).toBe(800);
    expect(chips.balanceOf("jackpot")).toBe(100);
    expect(reset.configuration()).toEqual(config);
    await expect(reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin:b", backup, discord })).rejects.toThrow("already applied");
    db.close();
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
    // R7 旧制度清算 と R8 新制度出資 は、賭博場部署を挟んだ独立2本
    expect(txById(applied.oldSettlementLandTxId)).toEqual({ from_account: ETHER_ESCROW, to_account: CASINO_DEPARTMENT, amount: 1_000 });
    expect(txById(applied.newInvestmentLandTxId)).toEqual({ from_account: CASINO_DEPARTMENT, to_account: CHIP_ESCROW, amount: 1_000 });

    // 旧キーの口座も取引も生まれない
    expect(db.prepare("SELECT 1 FROM accounts WHERE id='sys:dept:casino'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE from_account='sys:dept:casino' OR to_account='sys:dept:casino'").get()).toEqual({ n: 0 });
    expect(ledger.balanceOf("sys:dept:casino")).toBe(0);
    // 通過口座なので、出資後の賭博場部署は残さない
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

    // 途中で利用者Landが動く実装になったら、検算で気づいて全部巻き戻す
    const second = fundedReset();
    second.ledger.ensureAccount("user:alice", "user");
    second.ledger.transfer({ from: "sys:treasury", to: "user:alice", amount: 5_000, type: "initial", actor: "test", idempotencyKey: "seed-alice" });
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
    second.db.close();
  });

  it("バックアップ失敗では R4 以降を一切変更しない", async () => {
    const { db, ledger, reset } = fundedReset();
    const plan = reset.dryRun(config);
    const backup: OpeningBackupAdapter = { backup: async () => { throw new Error("archive unavailable"); } };
    await expect(reset.apply({ configuration: config, planHash: plan.planHash, actorId: "admin", backup, discord: { disableLegacyCasino: async () => undefined } })).rejects.toThrow("archive unavailable");
    expect(ledger.balanceOf(ETHER_ESCROW)).toBe(1_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM casino_opening_reset_plans").get()).toEqual({ n: 0 });
    db.close();
  });
});
