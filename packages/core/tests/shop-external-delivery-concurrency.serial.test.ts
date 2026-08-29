import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();

/**
 * claim と refund / expiry が同時に来ても、最終状態が一つに決まる。
 *
 * どちらが勝ってもよいが、
 *   - claim が取れているのに返金・失効も通った
 *   - 返金済みなのに claim が取れた
 * は作らない。作ると「返金済みなのにロールだけ残る」が成立する。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "external-delivery-runner.ts");
const USER = "concurrent-external";
const PRICE = 30_000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface RunnerResult {
  outcome: "ok" | "error";
  job: "claim" | "refund" | "expire";
  ok?: boolean;
  reason?: string;
  refunded?: boolean;
  expired?: boolean;
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

function setupDb(opts: { due?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-external-"));
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
    idempotencyKey: "seed:external",
  });
  const purchase = shop.purchase({
    itemId: item.id,
    userId: USER,
    actor: `user:${USER}`,
    memberRoleIds: [],
    expectedTermsToken: shop.quoteGenericPurchase(item.id).termsToken,
  }).purchase;
  if (opts.due) db.prepare("UPDATE shop_purchases SET expires_at=1 WHERE id=?").run(purchase.id);
  const balance = ledger.balanceOf(`user:${USER}`);
  db.close();
  return { dbPath, purchaseId: purchase.id, balance };
}

function inspect(dbPath: string, purchaseId: number) {
  const db = openDb(dbPath);
  const shop = new Shop(db, new Ledger(db), new EventLog(db));
  const purchase = shop.getPurchase(purchaseId)!;
  const claim = shop.externalDeliveryClaim(purchaseId);
  const balance = new Ledger(db).balanceOf(`user:${USER}`);
  const claimRows = db
    .prepare("SELECT COUNT(*) FROM shop_external_delivery_attempts WHERE purchase_id=?")
    .pluck()
    .get(purchaseId) as number;
  db.close();
  return { status: purchase.status, claimState: claim?.state ?? null, balance, claimRows };
}

describe("claim と status 遷移の同時実行", () => {
  it("claim と refund が同時でも、両方は通らない", async () => {
    const { dbPath, purchaseId, balance } = setupDb();

    const results = await runConcurrently(dbPath, [
      { job: "claim", purchaseId, actor: "staff" },
      { job: "refund", purchaseId, actor: "staff" },
    ]);

    const claim = results.find((r) => r.job === "claim")!;
    const refund = results.find((r) => r.job === "refund")!;
    const after = inspect(dbPath, purchaseId);

    const claimWon = claim.outcome === "ok" && claim.ok === true;
    if (claimWon) {
      // claim が勝った → 返金は止まっていて、資産も status も動いていない
      expect(refund.outcome).toBe("error");
      expect(refund.code).toBe("ERR_DELIVERY_IN_FLIGHT");
      expect(after.status).toBe("active");
      expect(after.balance).toBe(balance);
      expect(after.claimState).toBe("in_flight");
    } else {
      // 返金が勝った → claim は取れていない（返金済みへ配送しない）
      expect(refund.outcome).toBe("ok");
      expect(after.status).toBe("refunded");
      expect(after.claimState).toBeNull();
      expect(after.claimRows).toBe(0);
    }
  }, 30_000);

  it("claim と expiry が同時でも、両方は通らない", async () => {
    const { dbPath, purchaseId } = setupDb({ due: true });

    const results = await runConcurrently(dbPath, [
      { job: "claim", purchaseId, actor: "staff" },
      { job: "expire", purchaseId, actor: "staff" },
    ]);

    const claim = results.find((r) => r.job === "claim")!;
    const expire = results.find((r) => r.job === "expire")!;
    const after = inspect(dbPath, purchaseId);

    if (claim.ok === true) {
      // **失効は成立していない。** 理由の文字列は交錯の仕方で変わる
      // （claim を見て見送るか、UPDATE が1行も動かさないか）。守るべきなのは
      // 「status が動かず、claim が生きたまま残る」ことなので、そちらを固定する。
      expect(expire.expired).toBe(false);
      expect(after.status).toBe("active");
      expect(after.claimState).toBe("in_flight");
    } else {
      expect(expire.expired).toBe(true);
      expect(after.status).toBe("expired");
      expect(after.claimRows).toBe(0);
    }
  }, 30_000);

  it("同じ purchase への claim が同時に2本来ても、生きる claim は1つ", async () => {
    const { dbPath, purchaseId } = setupDb();

    const results = await runConcurrently(dbPath, [
      { job: "claim", purchaseId, actor: "staff" },
      { job: "claim", purchaseId, actor: "staff" },
    ]);

    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.ok === false)).toHaveLength(1);
    const after = inspect(dbPath, purchaseId);
    expect(after.claimRows).toBe(1);
    expect(after.claimState).toBe("in_flight");
  }, 30_000);

  it("refund と expiry が同時に来ても、最終状態は1つ", async () => {
    const { dbPath, purchaseId } = setupDb({ due: true });

    const results = await runConcurrently(dbPath, [
      { job: "refund", purchaseId, actor: "staff" },
      { job: "expire", purchaseId, actor: "staff" },
    ]);

    const after = inspect(dbPath, purchaseId);
    expect(["refunded", "expired"]).toContain(after.status);
    // 片方だけが成立する
    const wins = results.filter((r) => r.refunded === true || r.expired === true);
    expect(wins).toHaveLength(1);
  }, 30_000);
});
