import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, REEVAL_INVITE_COUNT, REEVAL_PRICE_LAND, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "reeval-purchase-runner.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface Result {
  outcome: "ok" | "error";
  purchaseId?: number;
  code?: string | null;
  error?: string;
}

function run(
  dbPath: string,
  operationId: string,
  startAt: number,
  extra: { itemId?: number; saleItemId?: number; mode?: "land" | "invite" } = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, JSON.stringify({ dbPath, operationId, startAt, ...extra })], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return reject(new Error(`runner exited ${exitCode}: ${err.slice(-2_000)}`));
      resolve(JSON.parse(line) as Result);
    });
  });
}

describe("再評価チャレンジ招待払いの同時実行", () => {
  it("別操作を同時確定しても購入1件・招待使用5件だけが成立する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-reeval-race-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "bot.db");
    const db = openDb(dbPath);
    const shop = new Shop(db, new Ledger(db), new EventLog(db));
    shop.createItem(
      {
        name: "再評価チャレンジ",
        price_land: REEVAL_PRICE_LAND,
        price_alt_kind: "invite",
        price_alt_amount: REEVAL_INVITE_COUNT,
        kind: "one_shot",
        delivery: "manual",
      },
      "staff",
    );
    db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES ('alice','meirei',1)").run();
    const addInvite = db.prepare("INSERT INTO invites (inviter_id,invitee_id,credited_at) VALUES ('alice',?,?)");
    for (let i = 0; i < 10; i += 1) addInvite.run(`guest-${i}`, i + 1);
    db.close();

    const startAt = Date.now() + 2_000;
    const results = await Promise.all([run(dbPath, "reeval-A", startAt), run(dbPath, "reeval-B", startAt)]);

    const after = openDb(dbPath);
    expect(after.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 1 });
    expect(after.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 5 });
    expect(after.prepare("SELECT COUNT(DISTINCT invite_id) AS n FROM shop_reeval_invite_uses").get()).toEqual({ n: 5 });
    expect(after.prepare("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 10 });
    after.close();

    expect(results.filter((result) => result.outcome === "ok")).toHaveLength(1);
    const rejected = results.find((result) => result.outcome === "error");
    expect(rejected?.code === "ERR_REEVAL_RIGHT_EXISTS" || /SQLITE_BUSY|database is locked/i.test(rejected?.error ?? "")).toBe(true);
  }, 60_000);

  it("A/B別商品から同時に来ても、未使用の再評価権は1件しか成立しない", async () => {
    // 権利のidentityが商品IDから切り離されているので、旧商品Aと新商品Bの同時購入でも
    // 同じ「未消費権は1件だけ」という制約を奪い合う。
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-reeval-cross-item-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "bot.db");
    const db = openDb(dbPath);
    const ledger = new Ledger(db);
    const shop = new Shop(db, ledger, new EventLog(db));
    const mk = (name: string) => shop.createItem(
      {
        name,
        price_land: REEVAL_PRICE_LAND,
        price_alt_kind: "invite",
        price_alt_amount: REEVAL_INVITE_COUNT,
        kind: "one_shot",
        delivery: "manual",
      },
      "staff",
    );
    const a = mk("再評価チャレンジ");
    const b = mk("再評価チャレンジ（再作成）");
    db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES ('alice','meirei',1)").run();
    ledger.ensureAccount("user:alice", "user");
    ledger.transfer({
      from: TREASURY, to: "user:alice", amount: REEVAL_PRICE_LAND + 1_000,
      type: "initial", actor: "staff", idempotencyKey: "seed:alice",
    });
    const addInvite = db.prepare("INSERT INTO invites (inviter_id,invitee_id,credited_at) VALUES ('alice',?,?)");
    for (let i = 0; i < 10; i += 1) addInvite.run(`guest-${i}`, i + 1);
    const beforeLand = ledger.balanceOf("user:alice");
    db.close();

    const startAt = Date.now() + 2_000;
    // 片方は旧A（販売設定もAとして見えている個体）、もう片方は新B。
    const results = await Promise.all([
      run(dbPath, "cross-A", startAt, { itemId: a.id, saleItemId: a.id, mode: "land" }),
      run(dbPath, "cross-B", startAt, { itemId: b.id, saleItemId: b.id, mode: "invite" }),
    ]);

    const after = openDb(dbPath);
    const afterLedger = new Ledger(after);
    // 未消費権は1件だけ。商品が2種類でも枠は1つ。
    expect(after.prepare("SELECT COUNT(*) AS n FROM shop_purchases").get()).toEqual({ n: 1 });
    const okCount = results.filter((r) => r.outcome === "ok").length;
    expect(okCount).toBe(1);
    // 成立した分だけLand/inviteが動く
    const inviteUses = (after.prepare("SELECT COUNT(*) AS n FROM shop_reeval_invite_uses").get() as { n: number }).n;
    const spentLand = beforeLand - afterLedger.balanceOf("user:alice");
    expect(inviteUses === REEVAL_INVITE_COUNT || spentLand === REEVAL_PRICE_LAND).toBe(true);
    expect(inviteUses === 0 || spentLand === 0).toBe(true); // どちらか一方だけ
    expect(after.prepare("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 10 });
    after.close();

    for (const rejected of results.filter((r) => r.outcome === "error")) {
      expect(
        rejected.code === "ERR_REEVAL_RIGHT_EXISTS" || /SQLITE_BUSY|database is locked/i.test(rejected.error ?? ""),
      ).toBe(true);
    }
  }, 60_000);
});
