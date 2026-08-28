import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();

/**
 * 「表示した条件でしか課金しない」を、**同じ瞬間に値段が変わる**本番条件で確かめる。
 *
 * 同一プロセス内で順番に呼ぶだけでは、better-sqlite3 は同期なので実質直列になり、
 * 「確認したのと課金するのが同じ取引か」を確かめたことにならない。ここでは
 * 一時ファイルDBに対し、購入プロセスと商品書き換えプロセスを同じ瞬間に走らせる。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "generic-purchase-terms-runner.ts");
const USER = "concurrent-generic-terms";
const PRICE = 80_000;
const RAISED = 200_000;
const START = 1_000_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  job: "buy" | "price";
  purchaseId?: number;
  paidLand?: number | null;
  code?: string | null;
  error?: string;
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

function setupDb(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-generic-terms-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const item = shop.createItem(
    {
      name: "裏チャット入場券",
      price_land: PRICE,
      kind: "one_shot",
      delivery: "manual",
      ...over,
    } as never,
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
    idempotencyKey: "seed:generic-terms-concurrency",
  });
  const token = shop.quoteGenericPurchase(item.id).termsToken;
  return { dir, dbPath, db, ledger, shop, item, token };
}

describe("generic購入契約の競合", () => {
  it("値上げと購入が同時に起きても、成立した購入は表示した額しか引かない", async () => {
    const ctx = setupDb();
    ctx.db.close();

    const results = await runConcurrently(ctx.dbPath, [
      ...Array.from({ length: 5 }, (_, i) => ({
        job: "buy",
        itemId: ctx.item.id,
        userId: USER,
        expectedTermsToken: ctx.token,
        idempotencyKey: `race:${i}`,
      })),
      { job: "price", itemId: ctx.item.id, priceLand: RAISED },
    ]);

    const db = openDb(ctx.dbPath);
    const rows = db.prepare("SELECT paid_land FROM shop_purchases").all() as Array<{ paid_land: number | null }>;
    const ledger = new Ledger(db);

    // 表示していない額（値上げ後）で成立した購入は1件もない。
    expect(rows.every((row) => row.paid_land === PRICE)).toBe(true);
    // 断られたものは ERR_TERMS_CHANGED だけ（別の理由で落ちていない）。
    for (const r of results.filter((r) => r.job === "buy" && r.outcome === "error")) {
      expect(r.code).toBe("ERR_TERMS_CHANGED");
    }
    // 引かれた総額は、成立した購入の件数×表示額とぴったり一致する。
    expect(ledger.balanceOf(`user:${USER}`)).toBe(START - rows.length * PRICE);
    db.close();
  }, 120_000);

  it("古い契約を持ったまま同時に押しても、全部止まって1 Ldも動かない", async () => {
    const ctx = setupDb();
    const stale = ctx.token;
    ctx.shop.updateItem(ctx.item.id, { price_land: RAISED } as never, "staff");
    ctx.db.close();

    const results = await runConcurrently(
      ctx.dbPath,
      Array.from({ length: 5 }, (_, i) => ({
        job: "buy",
        itemId: ctx.item.id,
        userId: USER,
        expectedTermsToken: stale,
        idempotencyKey: `stale:${i}`,
      })),
    );

    expect(results.every((r) => r.outcome === "error" && r.code === "ERR_TERMS_CHANGED")).toBe(true);

    const db = openDb(ctx.dbPath);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 0 });
    expect(new Ledger(db).balanceOf(`user:${USER}`)).toBe(START);
    db.close();
  }, 120_000);
});
