import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();

/**
 * 返金と手動完了が同時に来ても、最終状態が一つに決まる。
 *
 * どちらが勝ってもよいが、
 *   - Landが戻ったのに status が active のまま
 *   - 在庫だけ戻ってLandは戻っていない
 *   - 返金済みなのに配送済み
 * は作らない。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "shop-settlement-runner.ts");
const USER = "concurrent-settlement";
const PRICE = 30_000;
const START = 1_000_000;
const STOCK = 3;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  job: "refund" | "complete";
  refunded?: boolean;
  amount?: number;
  completed?: boolean;
  reason?: string;
  code?: string | null;
}

function runConcurrently(dbPath: string, jobs: Array<Record<string, unknown>>): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000;
  return Promise.all(
    jobs.map(
      (job) =>
        new Promise<RunnerResult>((resolve, reject) => {
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
        }),
    ),
  );
}

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-settlement-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const item = shop.createItem(
    { name: "限定グッズ", price_land: PRICE, kind: "one_shot", delivery: "manual", stock: STOCK } as never,
    "staff",
  );
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: START,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:settlement",
  });
  const purchase = shop.purchase({
    itemId: item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken,
  }).purchase;
  return { dir, dbPath, db, ledger, shop, item, purchase };
}

function inspect(dbPath: string) {
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const purchase = db.prepare("SELECT * FROM shop_purchases WHERE id=1").get() as {
    status: string;
    delivered_at: number | null;
    delivery_state: string | null;
  };
  const stock = (db.prepare("SELECT stock FROM shop_items WHERE id=1").get() as { stock: number | null }).stock;
  const balance = ledger.balanceOf(`user:${USER}`);
  const deliveredEvents = (db.prepare("SELECT COUNT(*) c FROM events WHERE type='shop_delivered'").get() as { c: number }).c;
  const restoredEvents = (db.prepare("SELECT COUNT(*) c FROM events WHERE type='shop_stock_restored'").get() as { c: number }).c;
  const restorations = (db.prepare("SELECT COUNT(*) c FROM shop_purchase_stock_restorations").get() as { c: number }).c;
  db.close();
  return { purchase, stock, balance, deliveredEvents, restoredEvents, restorations };
}

describe("返金と手動完了の競合", () => {
  it("同時に来ても、返金済みかつ配送済みという状態にならない", async () => {
    const ctx = setupDb();
    expect(ctx.shop.getItem(ctx.item.id)!.stock).toBe(STOCK - 1);
    ctx.db.close();

    await runConcurrently(ctx.dbPath, [
      { job: "refund", purchaseId: ctx.purchase.id, actor: "staff-a" },
      { job: "complete", purchaseId: ctx.purchase.id, actor: "staff-b" },
    ]);

    const s = inspect(ctx.dbPath);
    const isDelivered = s.purchase.delivered_at !== null || s.purchase.delivery_state === "delivered";
    // 「返金済み」と「配送済み」は両立しない
    expect(s.purchase.status === "refunded" && isDelivered).toBe(false);

    if (s.purchase.status === "refunded") {
      // 返金が勝った：Landは戻り、在庫も1つだけ戻る
      expect(s.balance).toBe(START);
      expect(s.stock).toBe(STOCK);
      expect(s.restorations).toBe(1);
      expect(s.restoredEvents).toBe(1);
      expect(s.deliveredEvents).toBe(0);
    } else {
      // 完了が勝った：Landは戻らず、在庫も減ったまま
      expect(s.purchase.status).toBe("active");
      expect(isDelivered).toBe(true);
      expect(s.balance).toBe(START - PRICE);
      expect(s.stock).toBe(STOCK - 1);
      expect(s.restorations).toBe(0);
      expect(s.deliveredEvents).toBe(1);
    }
  }, 120_000);

  it("同時に2つ返金しても、Landも在庫も一度しか戻らない", async () => {
    const ctx = setupDb();
    ctx.db.close();

    const results = await runConcurrently(ctx.dbPath, [
      { job: "refund", purchaseId: ctx.purchase.id, actor: "staff-a" },
      { job: "refund", purchaseId: ctx.purchase.id, actor: "staff-b" },
    ]);

    // 少なくとも1本は成功する（両方失敗して未処理のまま残らない）
    expect(results.some((r) => r.outcome === "ok" && r.refunded === true)).toBe(true);

    const s = inspect(ctx.dbPath);
    expect(s.purchase.status).toBe("refunded");
    expect(s.balance).toBe(START);
    expect(s.stock).toBe(STOCK);
    expect(s.restorations).toBe(1);
    expect(s.restoredEvents).toBe(1);
  }, 120_000);

  it("同時に2つ完了しても、配送記録は1回だけ", async () => {
    const ctx = setupDb();
    ctx.db.close();

    const results = await runConcurrently(ctx.dbPath, [
      { job: "complete", purchaseId: ctx.purchase.id, actor: "staff-a" },
      { job: "complete", purchaseId: ctx.purchase.id, actor: "staff-b" },
    ]);

    expect(results.filter((r) => r.outcome === "ok" && r.completed === true)).toHaveLength(1);

    const s = inspect(ctx.dbPath);
    expect(s.purchase.delivery_state).toBe("delivered");
    expect(s.deliveredEvents).toBe(1);
    expect(s.stock).toBe(STOCK - 1);
    ctx.db.close?.();
  }, 120_000);
});
