import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_EXTENSION_PRICE_LAND,
  EventLog,
  Ledger,
  Shop,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "eval-extension-purchase-runner.ts");
const USER = "concurrent-eval-extension";
const DAY = 86_400;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  sequence?: number;
  code?: string | null;
  error?: string;
}

function runConcurrently(dbPath: string, jobs: Array<Record<string, unknown>>): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000;
  return Promise.all(jobs.map((job) => new Promise<RunnerResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, JSON.stringify({ dbPath, startAt, ...job })], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${code}: ${err.slice(-2_000)}`));
      resolve(JSON.parse(line) as RunnerResult);
    });
  })));
}

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-eval-extension-concurrency-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const ts = Math.floor(Date.now() / 1_000);
  const item = shop.createItem({
    name: "評価期間1日延長",
    price_land: EVAL_EXTENSION_PRICE_LAND,
    kind: "one_shot",
    delivery: "auto",
    delivery_kind: "extend_deadline",
    delivery_data: JSON.stringify({ days: 1 }),
  }, "staff");
  db.prepare(
    `INSERT INTO souls (user_id,status,ghost_at,eval_started_at,eval_deadline_at,updated_at)
     VALUES (?, 'ghost', ?, ?, ?, ?)`,
  ).run(USER, ts - 100, ts - 100, ts + 14 * DAY, ts);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "initial",
    actor: "staff",
    idempotencyKey: "seed:concurrent-eval-extension",
  });
  for (let i = 1; i <= 4; i += 1) {
    const quote = shop.checkEvaluationExtensionPurchase({ itemId: item.id, userId: USER });
    shop.purchaseEvaluationExtension({
      itemId: item.id,
      userId: USER,
      actor: USER,
      memberRoleIds: [],
      expected: { ...quote, priceLand: EVAL_EXTENSION_PRICE_LAND },
      idempotencyKey: `seed-use:${i}`,
    });
  }
  const expected = shop.checkEvaluationExtensionPurchase({ itemId: item.id, userId: USER });
  const beforeBalance = ledger.balanceOf(`user:${USER}`);
  db.close();
  return { dbPath, itemId: item.id, expected, beforeBalance };
}

describe("評価期間+1日の同時購入", () => {
  it("4回使用済みから別操作を同時実行しても5回目は1件だけで、6回へ突破しない", async () => {
    const { dbPath, itemId, expected, beforeBalance } = setupDb();
    const jobs = Array.from({ length: 4 }, (_, i) => ({
      itemId,
      userId: USER,
      idempotencyKey: `concurrent:${i}`,
      expected: {
        priceLand: EVAL_EXTENSION_PRICE_LAND,
        cycleStartedAt: expected.cycleStartedAt,
        currentDeadlineAt: expected.currentDeadlineAt,
        usedCount: expected.usedCount,
      },
    }));

    const results = await runConcurrently(dbPath, jobs);
    const db = openDb(dbPath);
    const ledger = new Ledger(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses WHERE user_id=?").get(USER)).toEqual({ n: 5 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM shop_purchases WHERE user_id=?").get(USER)).toEqual({ n: 5 });
    expect(ledger.balanceOf(`user:${USER}`)).toBe(beforeBalance - EVAL_EXTENSION_PRICE_LAND);
    expect(results.filter((result) => result.outcome === "ok" && result.sequence === 5)).toHaveLength(1);
    for (const rejected of results.filter((result) => result.outcome === "error")) {
      expect(`${rejected.code ?? ""}${rejected.error ?? ""}`).toMatch(
        /ERR_TERMS_CHANGED|ERR_EVAL_EXTENSION_LIMIT|SQLITE_BUSY|database is locked/i,
      );
    }
    db.close();
  }, 60_000);
});
