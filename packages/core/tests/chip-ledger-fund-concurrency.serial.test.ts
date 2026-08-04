import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { ChipLedgerCore, HOUSE_HOLDER, ETHER_ESCROW, CHIP_ESCROW } from "../src/casino/exchange.js";
import { ChipTx, FORMAL_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { HouseReservations } from "../src/casino/reservations.js";
import { deptAccount } from "../src/departments/service.js";
import type { FundOp } from "./helpers/chip-fund-runner.js";

registerDefaultTxTypes();

/**
 * PR8監査・項目14: 資金APIの**別接続・別プロセス**での並行性。
 *
 * 冪等性も予約保護も、同じ接続で順に呼ぶだけなら簡単に通る。本番で怖いのは
 * 「利用者が二重クリックした」「運営の精算と進行中ゲームの予約が同時に走った」など、
 * 別接続が同じ行を同じ瞬間に触る場合。ここでは実物のコードを複数プロセスで起こし、
 * **総量が保存されること**と**保護が効いたままであること**を確かめる。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "chip-fund-runner.ts");
const DEPT = deptAccount("賭博場");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  payload: unknown;
  error: string | null;
  code: string | null;
}

interface Job {
  op: FundOp;
  subject: string;
  amount: number;
  idempotencyKey: string;
  account?: string;
}

/** 指定した仕事を、全部まとめて同じ瞬間に別プロセスで走らせる */
function runConcurrently(dbPath: string, jobs: Job[]): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000; // 起動のばらつきを吸収してから一斉に走らせる
  return Promise.all(
    jobs.map(
      (job) =>
        new Promise<RunnerResult>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", RUNNER, JSON.stringify({ dbPath, startAt, ...job })], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (c) => (out += String(c)));
          child.stderr.on("data", (c) => (err += String(c)));
          child.on("error", reject);
          child.on("close", (code) => {
            const line = out.trim().split("\n").filter(Boolean).pop();
            if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
            resolve(JSON.parse(line) as RunnerResult);
          });
        }),
    ),
  );
}

/** opening_v1 を確定させた「正式開業後」のファイルDBを作る（1:1 の資金操作が動く唯一の状態） */
function setupOpenedDb(options: { userLand?: number; houseChips?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-fund-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedgerCore(db, ledger, events, { chipTx });
  const reservations = new HouseReservations(db, chips as never, events);
  chips.setReservedProvider((h) => (h === HOUSE_HOLDER ? reservations.totalReserved() : 0));

  ledger.ensureAccount(DEPT, "system");
  ledger.transfer({ from: TREASURY, to: DEPT, amount: 10_000_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
  ledger.ensureAccount("user:alice", "user");
  ledger.transfer({ from: TREASURY, to: "user:alice", amount: options.userLand ?? 1_000_000, type: "initial", actor: "t", idempotencyKey: "seed:alice" });

  // 正式開業初期化の結果に相当する状態（PR12が本来置く版）を、テストの前提として置く
  chipTx.captureOpening(FORMAL_OPENING_VERSION, [], { poolLand: ledger.balanceOf(CHIP_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
  if (options.houseChips) chips.fundFromAccount(DEPT, options.houseChips, HOUSE_HOLDER, "seed:house");

  return { dir, dbPath, db, ledger, events, chipTx, chips, reservations };
}

/** 「発行済みチップ == 準備Land」（100%準備）は、どの競合の後でも成り立つ */
function assertFullyBacked(dbPath: string): { outstanding: number; pool: number } {
  const db = openDb(dbPath);
  try {
    const chipTx = new ChipTx(db);
    const chips = new ChipLedgerCore(db, new Ledger(db), new EventLog(db), { chipTx });
    const outstanding = chips.outstanding();
    const pool = chips.pool();
    expect(chips.reserveHolder()).toBe(CHIP_ESCROW);
    expect(pool).toBe(outstanding);
    return { outstanding, pool };
  } finally {
    db.close();
  }
}

function read(dbPath: string, fn: (c: { db: ReturnType<typeof openDb>; chips: ChipLedgerCore; chipTx: ChipTx; ledger: Ledger; reservations: HouseReservations }) => void): void {
  const db = openDb(dbPath);
  try {
    const events = new EventLog(db);
    const chipTx = new ChipTx(db);
    const ledger = new Ledger(db);
    const chips = new ChipLedgerCore(db, ledger, events, { chipTx });
    const reservations = new HouseReservations(db, chips as never, events);
    chips.setReservedProvider((h) => (h === HOUSE_HOLDER ? reservations.totalReserved() : 0));
    fn({ db, chips, chipTx, ledger, reservations });
  } finally {
    db.close();
  }
}

describe("資金APIの別プロセス並行性（項目14）", () => {
  it("同じ deposit キーを5プロセスが同時に叩いても、資金は一度しか動かない", async () => {
    const ctx = setupOpenedDb();
    ctx.db.close();
    const results = await runConcurrently(
      ctx.dbPath,
      Array.from({ length: 5 }, () => ({ op: "deposit" as const, subject: "alice", amount: 10_000, idempotencyKey: "dup:deposit" })),
    );
    // 全プロセスが同じ結果を受け取る（成功した1件の結果を、残りは保存済み結果として読む）
    expect(results.every((r) => r.outcome === "ok")).toBe(true);
    for (const r of results) expect(r.payload).toEqual({ input: 10_000, output: 10_000, burned: 0 });

    read(ctx.dbPath, ({ chips, db }) => {
      expect(chips.balanceOf("alice")).toBe(10_000);
      expect((db.prepare("SELECT COUNT(*) AS c FROM casino_tx_groups WHERE group_key = 'dup:deposit'").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM casino_tx WHERE group_key = 'dup:deposit'").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE idempotency_key = 'dup:deposit'").get() as { c: number }).c).toBe(1);
    });
    assertFullyBacked(ctx.dbPath);
  });

  it("同じ利用者への別々の deposit は、全部が別々に成立して合算される", async () => {
    const ctx = setupOpenedDb();
    ctx.db.close();
    const amounts = [1_000, 2_000, 3_000, 4_000, 5_000];
    const results = await runConcurrently(
      ctx.dbPath,
      amounts.map((amount, i) => ({ op: "deposit" as const, subject: "alice", amount, idempotencyKey: `multi:deposit:${i}` })),
    );
    expect(results.filter((r) => r.outcome === "ok")).toHaveLength(amounts.length);
    const total = amounts.reduce((a, b) => a + b, 0);
    read(ctx.dbPath, ({ chips, ledger }) => {
      expect(chips.balanceOf("alice")).toBe(total);
      expect(ledger.balanceOf("user:alice")).toBe(1_000_000 - total);
    });
    assertFullyBacked(ctx.dbPath);
  });

  it("redeem を同時実行しても、持っている以上は返還されない", async () => {
    const ctx = setupOpenedDb();
    ctx.chips.deposit("alice", 10_000, "seed:alice-deposit");
    ctx.db.close();
    // 手持ちは 10,000。8,000 の返還を5プロセスが同時に狙う（成功できるのは1件だけ）
    const results = await runConcurrently(
      ctx.dbPath,
      Array.from({ length: 5 }, (_, i) => ({ op: "redeem" as const, subject: "alice", amount: 8_000, idempotencyKey: `race:redeem:${i}` })),
    );
    const ok = results.filter((r) => r.outcome === "ok");
    expect(ok).toHaveLength(1);
    for (const r of results.filter((r) => r.outcome === "error")) {
      // 残高不足で断られた（SQLITE_BUSY 等の技術的失敗で「たまたま」通らなかったのではない）
      expect(r.code).toBe("ERR_INSUFFICIENT_CHIPS");
    }
    read(ctx.dbPath, ({ chips }) => expect(chips.balanceOf("alice")).toBe(2_000));
    assertFullyBacked(ctx.dbPath);
  });

  it("売上精算と胴元債務の予約が同時でも、予約済み資金は外へ出ない", async () => {
    const ctx = setupOpenedDb({ houseChips: 100_000 });
    ctx.db.close();
    // 胴元 100,000。予約 80,000 と 精算 50,000 を同時に走らせる。
    // どちらが先でも「残高 − 予約 >= 精算額」が破られてはいけない（PR5）
    const results = await runConcurrently(ctx.dbPath, [
      { op: "reserve", subject: "alice", amount: 80_000, idempotencyKey: "race:res:1" },
      { op: "settle", subject: HOUSE_HOLDER, amount: 50_000, idempotencyKey: "race:settle:1", account: DEPT },
    ]);
    const settleResult = results[1]!;
    read(ctx.dbPath, ({ chips, reservations }) => {
      const held = chips.balanceOf(HOUSE_HOLDER);
      const reserved = reservations.totalReserved();
      // 精算が通ったなら予約が入る前、通らなかったなら予約が先。どちらでも不変条件は同じ
      expect(held - reserved).toBeGreaterThanOrEqual(0);
      if (settleResult.outcome === "ok") {
        expect(held).toBe(50_000);
      } else {
        expect(settleResult.code).toBe("ERR_RESERVED_FUNDS");
        expect(held).toBe(100_000);
        expect(reserved).toBe(80_000);
      }
    });
    assertFullyBacked(ctx.dbPath);
  });

  it("元手投入と売上精算が同時に走っても、総量と100%準備が保たれる", async () => {
    const ctx = setupOpenedDb({ houseChips: 200_000 });
    ctx.db.close();
    const results = await runConcurrently(ctx.dbPath, [
      { op: "fund", subject: HOUSE_HOLDER, amount: 60_000, idempotencyKey: "race:fund:1", account: DEPT },
      { op: "settle", subject: HOUSE_HOLDER, amount: 40_000, idempotencyKey: "race:settle:2", account: DEPT },
      { op: "fund", subject: HOUSE_HOLDER, amount: 30_000, idempotencyKey: "race:fund:2", account: DEPT },
    ]);
    expect(results.every((r) => r.outcome === "ok")).toBe(true);
    read(ctx.dbPath, ({ chips }) => expect(chips.balanceOf(HOUSE_HOLDER)).toBe(200_000 + 60_000 - 40_000 + 30_000));
    assertFullyBacked(ctx.dbPath);
  });

  it("正式開業の版切替の境界では、旧準備口座と新準備口座が混ざらない", async () => {
    // 版切替の「前」に確定した資金は旧準備口座、「後」は新準備口座。境界をまたいで
    // 同じ準備口座を使ってしまうと、どちらの版の裏付けなのか分からなくなる
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-boundary-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "casino.db");
    const db = openDb(dbPath);
    const ledger = new Ledger(db);
    const chipTx = new ChipTx(db);
    const chips = new ChipLedgerCore(db, ledger, new EventLog(db), { chipTx });
    ledger.ensureAccount(DEPT, "system");
    ledger.transfer({ from: TREASURY, to: DEPT, amount: 10_000_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
    ledger.ensureAccount("user:alice", "user");
    ledger.transfer({ from: TREASURY, to: "user:alice", amount: 1_000_000, type: "initial", actor: "t", idempotencyKey: "seed:alice" });
    chipTx.captureLegacyOpening({ poolLand: ledger.balanceOf(ETHER_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
    // 版切替の前に legacy で 20,000 預ける
    chips.deposit("alice", 20_000, "boundary:legacy-deposit");
    expect(ledger.balanceOf(ETHER_ESCROW)).toBe(20_000);
    // 版を opening_v1 へ切り替える（PR12 の完了処理が置く状態）
    chipTx.captureOpening(FORMAL_OPENING_VERSION, [], { poolLand: ledger.balanceOf(CHIP_ESCROW), fromLedgerTxId: ledger.lastTransactionId() });
    db.close();

    // 切替の後に別プロセスから預ける。新準備口座へ入り、旧準備口座は 1 Ld も動かない
    const results = await runConcurrently(dbPath, [
      { op: "deposit", subject: "alice", amount: 5_000, idempotencyKey: "boundary:formal-deposit-1" },
      { op: "deposit", subject: "alice", amount: 7_000, idempotencyKey: "boundary:formal-deposit-2" },
    ]);
    expect(results.every((r) => r.outcome === "ok")).toBe(true);

    read(dbPath, ({ ledger: l, chips: c, chipTx: t }) => {
      expect(t.currentVersion()).toBe(FORMAL_OPENING_VERSION);
      expect(c.reserveHolder()).toBe(CHIP_ESCROW);
      expect(l.balanceOf(ETHER_ESCROW)).toBe(20_000); // 旧準備口座は据え置き
      expect(l.balanceOf(CHIP_ESCROW)).toBe(12_000); // 新しい預入だけが新準備口座へ
      expect(c.balanceOf("alice")).toBe(32_000);
      expect(c.pool()).toBe(12_000); // pool() は「いまの版の準備口座」しか見ない
    });
  });
});
