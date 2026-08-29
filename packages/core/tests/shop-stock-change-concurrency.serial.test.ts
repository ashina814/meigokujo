import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();

/**
 * 同じ在庫変更の確認が二重に確定されても、返金在庫は一度しか始末されない。
 *
 * 二重に通ると、`add_restorations` なら返金分が二回上乗せされ、`final_stock` なら
 * 「もう始末した義務」をもう一度含めたことにされる。どちらも運営が見た画面と違う。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "stock-change-runner.ts");
const USER = "concurrent-stock";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  newStock?: number | null;
  settled?: number;
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

/** 在庫3の商品を2件買って返金し、無制限のあいだに「未処理2個」を作る。 */
function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-stock-change-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const item = shop.createItem(
    { name: "限定札", price_land: 100, kind: "one_shot", delivery: "manual", delivery_kind: "none", stock: 3 } as never,
    "staff",
  );
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "t",
    approvedBy: "t",
    idempotencyKey: "seed:stock-change",
  });
  const buys = [0, 1].map(
    () =>
      shop.purchase({
        itemId: item.id,
        userId: USER,
        actor: `user:${USER}`,
        memberRoleIds: [],
        expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken,
      }).purchase,
  );
  // 無制限へ切り替えてから返金する（＝ applied=0 が2件たまる）
  const toUnlimited = shop.quoteStockChange(item.id, null);
  shop.applyStockChange({
    itemId: item.id,
    requestedStock: null,
    reconciliationMode: "none",
    expectedToken: toUnlimited.tokens.none!,
    actor: "staff",
  });
  for (const p of buys) shop.refund(p.id, "未提供のため", "staff");

  const quote = shop.quoteStockChange(item.id, 5);
  expect(quote.pending.quantity).toBe(2);
  db.close();
  return { dbPath, itemId: item.id, quote };
}

describe("在庫変更の同時確定", () => {
  it("同じ確認が二重に走っても、返金在庫は一度しか上乗せされない", async () => {
    const { dbPath, itemId, quote } = setupDb();
    const job = {
      itemId,
      requestedStock: 5,
      reconciliationMode: "add_restorations",
      expectedToken: quote.tokens.add_restorations!,
      actor: "staff",
    };

    const results = await runConcurrently(dbPath, [job, job]);

    expect(results.filter((r) => r.outcome === "ok")).toHaveLength(1);
    const failed = results.filter((r) => r.outcome === "error");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.code).toBe("ERR_STOCK_TERMS_CHANGED");

    const db = openDb(dbPath);
    // 5 + 2 が一度だけ。7 であって 9 ではない
    expect(db.prepare("SELECT stock FROM shop_items WHERE id=?").pluck().get(itemId)).toBe(7);
    expect(db.prepare("SELECT COUNT(*) FROM shop_stock_restoration_settlements").pluck().get()).toBe(2);
    db.close();
  }, 30_000);

  it("final_stock でも、二重確定で義務が二度始末されない", async () => {
    const { dbPath, itemId, quote } = setupDb();
    const job = {
      itemId,
      requestedStock: 5,
      reconciliationMode: "final_stock",
      expectedToken: quote.tokens.final_stock!,
      actor: "staff",
    };

    const results = await runConcurrently(dbPath, [job, job]);

    expect(results.filter((r) => r.outcome === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "error")[0]!.code).toBe("ERR_STOCK_TERMS_CHANGED");

    const db = openDb(dbPath);
    expect(db.prepare("SELECT stock FROM shop_items WHERE id=?").pluck().get(itemId)).toBe(5);
    expect(
      db.prepare("SELECT COUNT(*) FROM shop_stock_restoration_settlements WHERE disposition='absorbed'").pluck().get(),
    ).toBe(2);
    db.close();
  }, 30_000);
});
