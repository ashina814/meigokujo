import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog, Ledger, REEVAL_INVITE_COUNT, REEVAL_PRICE_LAND, Shop, openDb, registerDefaultTxTypes } from "../src/index.js";

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

function run(dbPath: string, operationId: string, startAt: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, JSON.stringify({ dbPath, operationId, startAt })], {
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
});
