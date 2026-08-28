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
  // 運営が延長商品を作り直した想定の、別IDの正規な延長商品。
  const replacement = shop.createItem({
    name: "評価期間1日延長（再作成）",
    price_land: EVAL_EXTENSION_PRICE_LAND,
    kind: "one_shot",
    delivery: "auto",
    delivery_kind: "extend_deadline",
    delivery_data: JSON.stringify({ days: 1 }),
  }, "staff");
  const expected = shop.checkEvaluationExtensionPurchase({ itemId: item.id, userId: USER });
  const beforeBalance = ledger.balanceOf(`user:${USER}`);
  db.close();
  return { dbPath, itemId: item.id, replacementItemId: replacement.id, expected, beforeBalance };
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

  it("A/B別商品から同時に来ても、sequence重複も5回超過も起きない", async () => {
    // 使用回数のidentityが商品IDから切り離されているので、別商品からの同時購入でも
    // 同じサイクルの同じ枠を奪い合う。application側の判定とDBの
    // UNIQUE(user_id, eval_started_at, sequence) が同じcycle semanticsを見る。
    const { dbPath, itemId, replacementItemId, expected, beforeBalance } = setupDb();
    const jobs = Array.from({ length: 4 }, (_, i) => ({
      itemId: i % 2 === 0 ? itemId : replacementItemId,
      userId: USER,
      idempotencyKey: `cross-item:${i}`,
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
    // 4回使用済み + 成功1件 = 5。商品が2種類でも枠は1つ。
    expect(db.prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses WHERE user_id=?").get(USER)).toEqual({ n: 5 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM shop_purchases WHERE user_id=?").get(USER)).toEqual({ n: 5 });
    const sequences = (db
      .prepare("SELECT sequence FROM shop_eval_extension_uses WHERE user_id=? ORDER BY sequence")
      .all(USER) as { sequence: number }[]).map((r) => r.sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5]); // 重複も欠番も無い
    expect(ledger.balanceOf(`user:${USER}`)).toBe(beforeBalance - EVAL_EXTENSION_PRICE_LAND);
    expect(results.filter((result) => result.outcome === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "ok" && result.sequence === 5)).toHaveLength(1);
    for (const rejected of results.filter((result) => result.outcome === "error")) {
      expect(`${rejected.code ?? ""}${rejected.error ?? ""}`).toMatch(
        /ERR_TERMS_CHANGED|ERR_EVAL_EXTENSION_LIMIT|SQLITE_BUSY|database is locked/i,
      );
    }
    db.close();
  }, 60_000);
});
