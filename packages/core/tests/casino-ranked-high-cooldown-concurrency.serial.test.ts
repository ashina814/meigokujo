import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CasinoChipAssets,
  ChipLedger,
  ChipTx,
  DailyRisk,
  EventLog,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * PR23: 高卓以上の開催クールダウンは、別接続・別プロセスから同時に叩かれても
 * **1本しか通らない**こと。両方が「直前の高卓は無い」を見て通過してはならない。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CREATE_RUNNER = join(HERE, "helpers", "ranked-high-create-runner.ts");
const FIRST_USE_RUNNER = join(HERE, "helpers", "daily-risk-first-use-runner.ts");
// 実際の種まきより後の「当日」を使う（当日開始時点の所持を 0 に潰さないため）
const NOW = Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunnerResult {
  ok: boolean;
  tableId?: string;
  dayKey?: string;
  openingHoldings?: number;
  code?: string;
  error?: string;
}

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-high-cooldown-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  db.prepare("UPDATE casino_chip_opening_versions SET created_at=? WHERE opening_version='opening_v1'").run(NOW - 60 * 24 * 60 * 60);
  return { dbPath, db, ledger, chips, chipTx, events };
}

function spawnRunner(script: string, input: Record<string, unknown>): Promise<RunnerResult> {
  return new Promise<RunnerResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2000)}`));
      resolve(JSON.parse(line) as RunnerResult);
    });
  });
}

describe("high-tier ranked table creation under cross-process contention", () => {
  /**
   * 高卓以上の一律クールダウンは廃止した（運用方針の変更）。
   * 時間で自動的に開いてしまい「いま開けてよいか」が運営の手を離れるうえ、
   * 設定値が未投入だと逆に全ランクが死ぬ事故が実際に起きたため。
   *
   * したがってここで担保するのは「片方だけ通る」ことではなく、
   * **同時に開いても履歴表が壊れない**こと。別プロセスの同時 INSERT で
   * operation_id / table_id の一意制約が競合しても、行が落ちたり重複したりしない。
   */
  it("lets simultaneous high creates through without corrupting the open history", async () => {
    const ctx = setupFileDb();
    ctx.db.close();
    const startAt = Date.now() + 700;
    const common = { dbPath: ctx.dbPath, baseAmount: 10_000, now: NOW, startAt };

    const [a, b] = await Promise.all([
      spawnRunner(CREATE_RUNNER, { ...common, tableId: "high-a", operationId: "create:high-a" }),
      spawnRunner(CREATE_RUNNER, { ...common, tableId: "high-b", operationId: "create:high-b" }),
    ]);

    expect({ a: a.ok, b: b.ok }).toEqual({ a: true, b: true });

    const reopened = openDb(ctx.dbPath);
    const rows = reopened.prepare("SELECT table_id FROM casino_ranked_open_history ORDER BY table_id").all() as Array<{ table_id: string }>;
    expect(rows.map((r) => r.table_id)).toEqual(["high-a", "high-b"]);
    expect((reopened.prepare("SELECT COUNT(*) AS n FROM casino_tables").get() as { n: number }).n).toBe(2);
    reopened.close();
  }, 60_000);

  it("keeps a staged-unlock tier closed in every process until it is unlocked", async () => {
    const ctx = setupFileDb();
    ctx.db.close();
    const startAt = Date.now() + 700;
    // 極卓は段階解放が入るまで、どのプロセスから叩いても開かない（fail-closed）
    const locked = { dbPath: ctx.dbPath, baseAmount: 50_000, now: NOW, startAt };
    const [a, b] = await Promise.all([
      spawnRunner(CREATE_RUNNER, { ...locked, tableId: "ex-a", operationId: "create:ex-a" }),
      spawnRunner(CREATE_RUNNER, { ...locked, tableId: "ex-b", operationId: "create:ex-b" }),
    ]);
    expect({ a: a.ok, b: b.ok }).toEqual({ a: false, b: false });

    // 解放前は判定で止まるので、卓の表そのものが作られない（fail-closed）
    const reopened = openDb(ctx.dbPath);
    expect(reopened.prepare("SELECT 1 FROM sqlite_master WHERE name='casino_tables'").get()).toBeUndefined();
    reopened.close();
  }, 60_000);

  it("agrees on a single day snapshot when two processes touch the daily risk day first", async () => {
    const ctx = setupFileDb();
    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.transfer({ from: TREASURY, to: "user:alice", amount: 20_000, type: "initial", actor: "test", idempotencyKey: "seed:alice" });
    ctx.chips.deposit("alice", 20_000, "deposit:alice");
    ctx.db.close();

    const startAt = Date.now() + 700;
    const common = { dbPath: ctx.dbPath, userId: "alice", now: NOW, startAt };
    const [a, b] = await Promise.all([
      spawnRunner(FIRST_USE_RUNNER, { ...common, scopeKey: "roulette:a", operationId: "op-a", maxPlayerLoss: 1_000 }),
      spawnRunner(FIRST_USE_RUNNER, { ...common, scopeKey: "roulette:b", operationId: "op-b", maxPlayerLoss: 1_000 }),
    ]);

    expect({ a: a.ok, b: b.ok }).toEqual({ a: true, b: true });
    expect(a.dayKey).toBe(b.dayKey);
    expect(a.openingHoldings).toBe(b.openingHoldings);

    const reopened = openDb(ctx.dbPath);
    const days = reopened.prepare("SELECT user_id, day_key, opening_holdings FROM casino_daily_risk_days").all();
    expect(days).toHaveLength(1);
    reopened.close();

    // 同じ DB を読み直しても、片方のプロセスが見たスナップショットと一致する
    const verifyDb = openDb(ctx.dbPath);
    const verify = new DailyRisk(verifyDb, new Ledger(verifyDb), new CasinoChipAssets(verifyDb, new ChipLedger(verifyDb, new Ledger(verifyDb), new EventLog(verifyDb), { chipTx: new ChipTx(verifyDb) })), {
      now: () => NOW,
      boundaryOffsetMinutes: () => 0,
    });
    expect(verify.dayFor("alice").openingHoldings).toBe(a.openingHoldings);
    verifyDb.close();
  }, 60_000);
});
