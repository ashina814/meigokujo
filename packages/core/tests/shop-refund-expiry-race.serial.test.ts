import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();

/**
 * 「返すべき金」が、失効の巡回とぶつかっても消えない。
 *
 * 危ないのは **claim を解放した直後・返金の transaction を取る前**。ここに別プロセスの
 * 失効が入ると、`refund()` は active からしか動けないので
 * 「金は返っていない・失効済み・キューにも出ない」が完成する。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "refund-expiry-runner.ts");
const USER = "race-refund";
const PRICE = 30_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  job: "settle" | "expire";
  result?: Record<string, unknown>;
  code?: string | null;
}

function runConcurrently(jobs: Array<Record<string, unknown>>): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000;
  return Promise.all(
    jobs.map(
      (job) =>
        new Promise<RunnerResult>((resolve, reject) => {
          const child = spawn(process.execPath, ["--import", "tsx", RUNNER, JSON.stringify({ startAt, ...job })], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (c) => (out += String(c)));
          child.stderr.on("data", (c) => (err += String(c)));
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

/** 期限切れ済み・配送失敗が確定していて、claim を握ったままの購入を作る */
function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-refund-race-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "bot.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const item = shop.createItem(
    {
      name: "裏口",
      price_land: PRICE,
      kind: "monthly",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "r-vip" }),
    } as never,
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
    idempotencyKey: "seed:race",
  });
  const purchase = shop.purchase({
    itemId: item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken,
  }).purchase;
  // 「副作用は無いと確認できた失敗」の直前状態＝claim を握ったまま、期限は過ぎている
  const claim = shop.claimExternalDelivery({ purchaseId: purchase.id, deliveryKind: "add_role", actor: "system" });
  const claimToken = (claim as { token: string }).token;
  // 期限は既に過ぎている＝巡回が来れば失効させたがる。
  // 月額のままだと、接続を開くたびに走る期限延長のmigrationが expires_at を先へ書き戻し、
  // 「実は期限切れではない購入」を相手にした無意味なテストになってしまう。
  db.prepare("UPDATE shop_items SET kind='one_shot' WHERE id=?").run(item.id);
  db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchase.id);
  const balance = ledger.balanceOf(`user:${USER}`);
  db.close();

  // 子プロセスが開き直しても期限切れのままであることを確かめる
  const check = openDb(dbPath);
  const overdue = check.prepare("SELECT expires_at FROM shop_purchases WHERE id=?").pluck().get(purchase.id) as number;
  check.close();
  if (overdue > Math.floor(Date.now() / 1000)) throw new Error(`test setup: purchase is not overdue (${overdue})`);
  return { dbPath, purchaseId: purchase.id, claimToken, balance };
}

function inspect(dbPath: string, purchaseId: number) {
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const shop = new Shop(db, ledger, new EventLog(db));
  const purchase = shop.getPurchase(purchaseId)!;
  const out = {
    status: purchase.status,
    balance: ledger.balanceOf(`user:${USER}`),
    obligations: db.prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id=?").pluck().get(purchaseId) as number,
    inQueue: shop.countRefundFailures(),
    retryOpen: shop.quoteRefundRetry(purchaseId).open,
    refundEvents: new EventLog(db).listByType("shop_refunded").length,
  };
  db.close();
  return out;
}

/** 禁止された最終状態がひとつも成立していないこと */
function expectSafeFinalState(after: ReturnType<typeof inspect>, before: number) {
  const refunded = after.balance === before + PRICE;
  if (refunded) {
    // A: きっちり1回だけ返っている
    expect(after.status).toBe("refunded");
    expect(after.refundEvents).toBe(1);
    expect(after.inQueue).toBe(0);
  } else {
    // B: 返っていないなら、義務が durable に残り、失効しておらず、復旧できる
    expect(after.balance).toBe(before);
    expect(after.status).not.toBe("expired");
    expect(after.status).toBe("active");
    expect(after.obligations).toBeGreaterThan(0);
    expect(after.inQueue).toBe(1);
    expect(after.retryOpen).toBe(true);
    expect(after.refundEvents).toBe(0);
  }
  // 禁止: expired + 未返金 / expired + 義務 / 義務なし + 未返金 / 二重返金
  expect(after.status === "expired" && !refunded).toBe(false);
  expect(after.refundEvents).toBeLessThanOrEqual(1);
}

describe("返金の決着と失効の巡回がぶつかる", () => {
  it("返金が通るケース: 失効に横取りされず、ちょうど1回返る", async () => {
    const { dbPath, purchaseId, claimToken, balance } = setupDb();

    const results = await runConcurrently([
      { dbPath, job: "settle", purchaseId, claimToken, actor: "system:p1" },
      { dbPath, job: "expire", purchaseId, claimToken, actor: "system:p2" },
    ]);

    expect(results.every((r) => r.outcome === "ok")).toBe(true);
    const after = inspect(dbPath, purchaseId);
    expectSafeFinalState(after, balance);
    // このケースは返金が通る側
    expect(after.status).toBe("refunded");
    expect(after.balance).toBe(balance + PRICE);
    expect(after.refundEvents).toBe(1);
  }, 40_000);

  it("返金が失敗するケース: 義務が durable に残り、失効していない", async () => {
    const { dbPath, purchaseId, claimToken, balance } = setupDb();

    const results = await runConcurrently([
      { dbPath, job: "settle", purchaseId, claimToken, actor: "system:p1", breakLedger: true },
      { dbPath, job: "expire", purchaseId, claimToken, actor: "system:p2" },
    ]);

    expect(results.every((r) => r.outcome === "ok")).toBe(true);
    const after = inspect(dbPath, purchaseId);
    expectSafeFinalState(after, balance);
    // このケースは義務が立つ側
    expect(after.status).toBe("active");
    expect(after.obligations).toBeGreaterThan(0);
    expect(after.retryOpen).toBe(true);

    // 再起動相当（別接続）でも同じ契約。運営がやり直せば返る
    const db = openDb(dbPath);
    const ledger = new Ledger(db);
    const shop = new Shop(db, ledger, new EventLog(db));
    expect(shop.countRefundFailures()).toBe(1);
    const quote = shop.quoteRefundRetry(purchaseId);
    expect(shop.retryRefund({ purchaseId, expectedToken: quote.token, actor: "staff" }).refunded).toBe(true);
    expect(ledger.balanceOf(`user:${USER}`)).toBe(balance + PRICE);
    expect(shop.countRefundFailures()).toBe(0);
    db.close();
  }, 40_000);
});
