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
import { Shop, termDays } from "../src/shop/service.js";

registerDefaultTxTypes();

/**
 * 延長の**本当の二重押し**（別接続・別プロセスが同じ瞬間に確定する）。
 *
 * 同一プロセスで順に2回呼ぶだけなら、better-sqlite3 が同期なので簡単に通る。
 * 実際に怖いのは、利用者が確定ボタンを連打して2つの操作が同時に走る場合。
 * **同じ確認画面から出た確定は同じ操作ID**になるので、資金も期限も一度しか動かない。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "shop-extend-runner.ts");
const DAY = 86_400;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  extended?: boolean;
  expiresAt?: number;
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

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-extend-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const item = shop.createItem(
    {
      name: "裏チャット入場券",
      price_land: 80_000,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "r-ura" }),
    },
    "staff",
  );
  ledger.ensureAccount("user:alice", "user");
  ledger.transfer({ from: TREASURY, to: "user:alice", amount: 1_000_000, type: "initial", actor: "t", idempotencyKey: "seed:alice" });
  const purchase = shop.purchase({ itemId: item.id, userId: "alice", actor: "alice", memberRoleIds: [] }).purchase;
  const expected = { priceLand: item.price_land!, days: termDays(item)!, expiresAt: purchase.expires_at };
  const balance = ledger.balanceOf("user:alice");
  db.close();
  return { dbPath, purchase, expected, balance };
}

function inspect(dbPath: string) {
  const db = openDb(dbPath);
  try {
    const ledger = new Ledger(db);
    const shop = new Shop(db, ledger, new EventLog(db));
    const purchase = shop.getPurchase(1)!;
    const charges = db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE ref_type = 'shop_extend'")
      .get() as { n: number };
    const events = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'shop_extended'").get() as { n: number };
    return { balance: ledger.balanceOf("user:alice"), expiresAt: purchase.expires_at, charges: charges.n, events: events.n };
  } finally {
    db.close();
  }
}

describe("延長の同時実行", () => {
  it("同じ確認画面の確定を4つ同時に走らせても、課金も延長も1回だけ", async () => {
    const { dbPath, purchase, expected, balance } = setupDb();

    const results = await runConcurrently(
      dbPath,
      Array.from({ length: 4 }, () => ({
        purchaseId: purchase.id,
        userId: "alice",
        // 同じ確認画面から出た確定ボタン＝同じ操作ID
        operationId: "confirmation-1",
        expected,
      })),
    );

    const after = inspect(dbPath);
    // 期限は1回分だけ伸びる
    expect(after.expiresAt).toBe(purchase.expires_at! + 30 * DAY);
    expect(after.balance).toBe(balance - 80_000);
    expect(after.charges).toBe(1);
    expect(after.events).toBe(1);
    // 実際に延長したのは1プロセスだけ。残りは replay か、書き込み競合で失敗して資金を動かさない
    const applied = results.filter((r) => r.outcome === "ok" && r.extended === true);
    expect(applied).toHaveLength(1);
    for (const r of results.filter((r) => r.outcome === "error")) {
      expect(r.error ?? "").toMatch(/SQLITE_BUSY|database is locked/i);
    }
  }, 60_000);

  it("別々の確認画面から同時に確定すると、片方だけが通る（もう片方は条件変化で無課金）", async () => {
    const { dbPath, purchase, expected, balance } = setupDb();

    const results = await runConcurrently(dbPath, [
      { purchaseId: purchase.id, userId: "alice", operationId: "confirmation-A", expected },
      { purchaseId: purchase.id, userId: "alice", operationId: "confirmation-B", expected },
    ]);

    const after = inspect(dbPath);
    expect(after.expiresAt).toBe(purchase.expires_at! + 30 * DAY);
    expect(after.balance).toBe(balance - 80_000);
    expect(after.charges).toBe(1);
    const applied = results.filter((r) => r.outcome === "ok" && r.extended === true);
    expect(applied).toHaveLength(1);
    // 通らなかった方は、条件が変わったか書き込み競合。どちらでも資金は動いていない
    const rejected = results.find((r) => r.outcome === "error");
    if (rejected) expect(`${rejected.code ?? ""}${rejected.error ?? ""}`).toMatch(/ERR_TERMS_CHANGED|SQLITE_BUSY|database is locked/i);
  }, 60_000);
});
