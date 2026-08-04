import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedger, ETHER_ESCROW, CHIP_ESCROW, HOUSE_HOLDER } from "../src/casino/chip-ledger.js";
import { CasinoChipAssets } from "../src/casino/chip-assets.js";
import { CasinoChipFlow } from "../src/casino/chip-flow.js";
import { ChipTx, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { CasinoStatus } from "../src/casino/status.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { Escrow, ESCROW_QUARANTINE } from "../src/casino/escrow.js";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "../src/casino/free-spins.js";
import { HouseReservations } from "../src/casino/reservations.js";
import { FreeSpins } from "../src/casino/free-spins.js";
import { Stocks } from "../src/casino/stocks.js";
import { RecoveryRegistry, recoverCasino } from "../src/casino/recovery.js";
import { deptAccount } from "../src/departments/service.js";

registerDefaultTxTypes();

/**
 * PR8監査・項目13: **PR8単独では、既存の legacy DB を1単位も動かさない**。
 *
 * PR8 は「新しい台帳の形」を入れる PR で、旧制度の清算は PR12 が担当する。ところが
 * 準備口座の切替・検算・起動時復旧・UI 表示のどこか1つでも「ついでに揃えて」しまうと、
 * 運営が正式開業初期化を実行する前に旧残高が動いてしまう。取り返しがつかないので、
 * **実在しうる形の legacy DB を作り、PR8 のコードを一通り通したあと全テーブルを突き合わせる**。
 *
 * 復旧（PR7）が正当に触ってよい対象と混ざらないよう、孤児も帳簿不一致も無い
 * 「復旧が何もすることの無い」状態を作ってある。
 */

const DEPT = deptAccount("賭博場");
const tempDirs: string[] = [];
afterEach(() => {
  // Windows は閉じた直後の SQLite ファイルをしばらく掴んでいることがあるので再試行する
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 実在しうる legacy_pre_reset の DB を、ファイル上に作る（再起動相当を通すため） */
function buildLegacyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-legacy-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");

  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);

  ledger.ensureAccount(DEPT, "system");
  ledger.transfer({ from: TREASURY, to: DEPT, amount: 5_000_000, type: "adjust", actor: "seed", approvedBy: "seed", idempotencyKey: "seed:dept" });
  for (const u of ["u1", "u2", "u3"]) {
    ledger.ensureAccount(`user:${u}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount: 1_000_000, type: "initial", actor: "seed", idempotencyKey: `seed:${u}` });
  }

  // ── 旧準備口座へ入った Land（旧 EtherExchange が作った歴史データそのものの形） ──
  //
  // 新APIは使わない。正式開業ロックは外せないので、**旧取引 fixture で作る**のが
  // 正しい再現でもある（実際の legacy DB は `ether_*` 型の Land 取引で出来ている）。
  ledger.ensureAccount(ETHER_ESCROW, "system");
  ledger.ensureAccount(CHIP_ESCROW, "system");
  ledger.transfer({ from: "user:u1", to: ETHER_ESCROW, amount: 120_000, type: "ether_buy", actor: "user:u1", approvedBy: "system:ether", idempotencyKey: "legacy:buy:u1" });
  ledger.transfer({ from: "user:u2", to: ETHER_ESCROW, amount: 80_000, type: "ether_buy", actor: "user:u2", approvedBy: "system:ether", idempotencyKey: "legacy:buy:u2" });
  ledger.transfer({ from: DEPT, to: ETHER_ESCROW, amount: 500_000, type: "ether_house_fund", actor: "system:ether", approvedBy: "system:ether", idempotencyKey: "legacy:fund:house" });

  // ── 旧制度のチップ残高（合計が旧準備口座の Land と一致する＝裏付けが取れている状態） ──
  const legacyChipBalances: Array<[string, number]> = [
    ["u1", 110_000], // 120,000 のうち 10,000 は進行中の卓へ預託中
    ["u2", 80_000],
    [HOUSE_HOLDER, 462_500],
    ["jackpot", 23_000],
    ["relief", 5_000],
    [ESCROW_QUARANTINE, 2_500],
    ["escrow:session:sess-live", 10_000],
    [FREE_SPIN_JACKPOT_CLAIMS_HOLDER, 7_000],
  ];
  const insertChip = db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)");
  for (const [holder, amount] of legacyChipBalances) insertChip.run(holder, amount);
  expect(legacyChipBalances.reduce((a, [, n]) => a + n, 0)).toBe(ledger.balanceOf(ETHER_ESCROW));

  // 進行中の預託（帳簿と保有者残高が一致した「生きている」預託）。
  // `casino_escrow` は Escrow の構築時に作られるので、先に一度作らせる
  new Escrow(db, new ChipLedger(db, ledger, events, { chipTx }), events);
  db.prepare(
    "INSERT INTO casino_escrow (session_id, user_id, amount, game, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("sess-live", "u1", 10_000, "板", "escrow:session:sess-live", 1_700_000_000);

  // 保留フリースピン（固定JP請求つき）。請求額は system holder に隔離してある
  // （検算Cが「pending の合計 == holder 残高」を要求するので、健全な形で作る）
  const freeSpins = new FreeSpins(db);
  freeSpins.grant({
    userId: "u2", operationId: "legacy-spin", spinNo: 1, bet: 500, sourceGroup: "legacy:spin:group",
    reels: ["7", "7", "7"], rawPayout: 0, amuletEffect: { kind: "none", amount: 0 },
    payout: 0, jackpotWon: true, jackpotClaim: 7_000, totalClaim: 7_000,
  });
  expect(freeSpins.jackpotClaimHolder()).toBe(FREE_SPIN_JACKPOT_CLAIMS_HOLDER);

  // 胴元債務の予約（進行中ゲームの最大配当）。予約は資金グループを作らないので旧版でも置ける
  const reservations = new HouseReservations(db, new ChipLedger(db, ledger, events, { chipTx }), events);
  reservations.reserve("legacy:res:1", 40_000, "スロット", "u1");
  reservations.reserve("legacy:res:2", 15_000, "クラッシュ", "u2");

  // 株の建玉（PR6で停止しているが、持っているものには触らない）
  const stocks = new Stocks(db, new ChipLedger(db, ledger, events, { chipTx }), events);
  const anyStock = stocks.list()[0]!;
  db.prepare("INSERT INTO casino_holdings (user_id, stock_id, shares, avg_cost, bought_at) VALUES (?, ?, ?, ?, ?)").run("u3", anyStock.id, 12, 950, 1_700_000_000);

  // 版は legacy_pre_reset のまま（正式開業初期化は PR12）。
  // ここまでの残高を旧版の開始残高として確定するので、検算Aは「開始残高そのもの」で通る
  chipTx.captureLegacyOpening({ poolLand: ledger.balanceOf(ETHER_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
  expect(chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);

  db.close();
  return dbPath;
}

/** 「PR8 が動いたあと DB がどうなっているか」の全体像。差分が出たら必ずここに現れる */
const TRACKED_TABLES = [
  "ether_balances",
  "balances",
  "transactions",
  "casino_tx",
  "casino_tx_groups",
  "casino_chip_opening_versions",
  "casino_chip_opening_balances",
  "casino_escrow",
  "casino_house_reservations",
  "casino_pending_free_spins",
  "casino_holdings",
  "casino_stocks",
  "settings",
] as const;

function snapshot(dbPath: string) {
  const db = openDb(dbPath);
  try {
    const out: Record<string, unknown> = {};
    for (const table of TRACKED_TABLES) {
      out[table] = db.prepare(`SELECT * FROM ${table}`).all();
    }
    return out;
  } finally {
    db.close();
  }
}

/** production と同じ配線（正式開業ロックあり）で PR8 のサービス一式を組む */
function wire(dbPath: string) {
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const status = new CasinoStatus(db);
  chipTx.setClosedReason(() => status.denyMessage());
  const escrow = new Escrow(db, chips, events);
  const chipAssets = new CasinoChipAssets(db, chips);
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((h) => (h === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow);
  const registry = new RecoveryRegistry();
  // 「生きている預託」は所有元が申告する（PR7 S4）。申告しないと孤児として返金されてしまう
  registry.register({ type: "market", listLiveEscrowHolders: () => ["escrow:session:sess-live"] });
  return { db, ledger, events, chipTx, chips, status, escrow, chipAssets, chipFlow, reservations, integrity, registry };
}

/** UI（両替所・案内所・計器盤・運営卓）が読む値を一通り触る。読むだけで何も動かさないこと */
function readEverythingUiReads(w: ReturnType<typeof wire>): void {
  expect(w.chipTx.openingPhase()).toBe("pre_reset");
  expect(w.chips.reserveHolder()).toBe(ETHER_ESCROW);
  expect(w.chips.pool()).toBeGreaterThan(0);
  expect(w.chips.outstanding()).toBeGreaterThan(0);
  expect(w.chips.balanceOf(HOUSE_HOLDER)).toBeGreaterThan(0);
  expect(w.chips.settleableBalance(HOUSE_HOLDER)).toBeGreaterThanOrEqual(0);
  w.integrity.runFull();
}

/** 正式開業前に運営・利用者から届きうる資金操作。全て core 層で断られること */
function attemptAllFundOperations(w: ReturnType<typeof wire>, tag: string): void {
  const ops: Array<() => unknown> = [
    () => w.chips.deposit("u1", 1_000, `${tag}:deposit`),
    () => w.chips.redeem("u1", 1_000, `${tag}:redeem`),
    () => w.chips.fundFromAccount(DEPT, 1_000, HOUSE_HOLDER, `${tag}:fund`),
    () => w.chips.redeemToAccount(HOUSE_HOLDER, 1_000, DEPT, "boss", `${tag}:settle`),
    () => w.chips.redeemFairToAccount(HOUSE_HOLDER, 1_000, DEPT, `${tag}:fair`),
    () =>
      w.chips.runGroup({ groupKey: `${tag}:game`, kind: "solo_game", actorId: "u1" }, () =>
        w.chips.transfer("u1", HOUSE_HOLDER, 1_000, { reason: "賭け金" }),
      ),
  ];
  for (const op of ops) expect(op).toThrow(/ERR_CASINO_OPENING_NOT_COMPLETE/);
}

describe("PR8は既存legacy DBを変更しない（項目13）", () => {
  it("構築・UI表示・資金操作の試行・再起動相当を通しても、legacy DBが1行も変わらない", () => {
    const dbPath = buildLegacyDb();
    const before = snapshot(dbPath);

    // 2周まわす。2周目が「再起動して同じコードがもう一度立ち上がった」状態にあたる
    for (const pass of [1, 2]) {
      const w = wire(dbPath);
      try {
        readEverythingUiReads(w);
        attemptAllFundOperations(w, `pass${pass}`);
        readEverythingUiReads(w);
      } finally {
        w.db.close();
      }
    }

    const after = snapshot(dbPath);
    // テーブルごとに比較する。まとめて比較すると、どこが動いたのかが読み取れない
    for (const table of TRACKED_TABLES) {
      expect({ [table]: after[table] }).toEqual({ [table]: before[table] });
    }

    // 名指しの不変条件（差分比較が緩んでも、ここだけは必ず効く）
    const db = openDb(dbPath);
    try {
      const bal = (id: string) => (db.prepare("SELECT amount FROM balances WHERE account_id = ?").get(id) as { amount: number } | undefined)?.amount ?? 0;
      const chipBal = (id: string) => (db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(id) as { amount: number } | undefined)?.amount ?? 0;
      expect(bal(ETHER_ESCROW)).toBe(700_000); // 旧準備口座は 1 Ld も動いていない
      expect(bal(CHIP_ESCROW)).toBe(0); // 新準備口座には 1 Ld も入っていない（暗黙移行なし）
      expect(chipBal(HOUSE_HOLDER)).toBe(500_000 - 30_000 - 5_000 - 2_500);
      expect(chipBal("jackpot")).toBe(30_000 - 7_000);
      expect(chipBal("relief")).toBe(5_000);
      expect(chipBal(ESCROW_QUARANTINE)).toBe(2_500);
      expect(chipBal("escrow:session:sess-live")).toBe(10_000);
      expect((db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_house_reservations").get() as { s: number }).s).toBe(55_000);
      expect((db.prepare("SELECT jackpot_claim FROM casino_pending_free_spins WHERE user_id = 'u2'").get() as { jackpot_claim: number }).jackpot_claim).toBe(7_000);
      expect((db.prepare("SELECT shares, avg_cost FROM casino_holdings WHERE user_id = 'u3'").get() as { shares: number; avg_cost: number })).toEqual({ shares: 12, avg_cost: 950 });
      expect(new ChipTx(db).currentVersion()).toBe(LEGACY_OPENING_VERSION);
    } finally {
      db.close();
    }
  });

  it("起動時復旧を通しても、PR7の正規復旧対象（ソロ予約解放）以外は変わらない", () => {
    const dbPath = buildLegacyDb();
    const before = snapshot(dbPath);

    const w = wire(dbPath);
    let outcome: string;
    try {
      // S1〜S12。健全な legacy DB なので、孤児返金・隔離・凍結は発生しない
      const r = recoverCasino({
        db: w.db, status: w.status, integrity: w.integrity, chipTx: w.chipTx,
        escrow: w.escrow, reservations: w.reservations, registry: w.registry, events: w.events, chipFlow: w.chipFlow,
      });
      outcome = r.outcome;
      expect(r.refundedSessions).toBe(0);
      expect(r.refundedTotal).toBe(0);
      expect(r.quarantined).toBe(0);
      expect(r.mismatched).toEqual([]);
      expect(r.failedSessions).toEqual([]);
      // S9: 進行中でないソロ債務の予約解放は PR7 の正規復旧対象。ここだけは動いてよい
      expect(r.releasedReservations).toEqual({ released: true, count: 2, total: 55_000 });
      expect(r.redeemedFreeChips).toEqual({ redeemed: [], skipped: ["opening_not_formal"], failed: [] });
      // 復旧後も版は legacy のまま（PR8 は暗黙移行しない）
      expect(w.chipTx.openingPhase()).toBe("pre_reset");
      attemptAllFundOperations(w, "after-recovery");
    } finally {
      w.db.close();
    }
    expect(outcome).toBe("opened");

    const after = snapshot(dbPath);
    // 予約テーブルだけが空になり、それ以外は 1 行も変わらない
    expect(after.casino_house_reservations).toEqual([]);
    for (const table of TRACKED_TABLES) {
      if (table === "casino_house_reservations") continue;
      expect({ [table]: after[table] }).toEqual({ [table]: before[table] });
    }
  });
});
