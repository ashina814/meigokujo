import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { JACKPOT_HOLDER } from "../src/casino/service.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { deptAccount } from "../src/departments/service.js";

registerDefaultTxTypes();

/**
 * 冪等性の本番条件（複数接続・同時実行）を確かめる。
 *
 * 同じプロセス・同じ接続で繰り返し呼ぶだけでは、better-sqlite3 は同期なので実質直列になり、
 * 「同時に叩かれたらどうなるか」を確かめたことにならない。ここでは一時ファイルDBを
 * 別スレッド（別接続）から同じ瞬間に叩き、資金が一度だけ動くことを見る。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "helpers", "chip-tx-worker.mjs");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-chip-tx-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });

  ledger.ensureAccount(deptAccount("賭博場"), "system");
  ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  ether.fundFromAccount(deptAccount("賭博場"), 100_000, HOUSE_HOLDER, "seed:house");
  ether.ensureHolder(JACKPOT_HOLDER);
  return { dbPath, db, ledger, events, chipTx, ether };
}

function runWorkers(dbPath: string, groupKey: string, count: number, amount: number) {
  const startAt = Date.now() + 250; // 全スレッドを同じ瞬間に走らせる
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise<{ outcome: string; result?: string; error?: string }>((resolve, reject) => {
        const worker = new Worker(WORKER, {
          workerData: {
            dbPath,
            groupKey,
            kind: "solo_game",
            actorId: "alice",
            from: HOUSE_HOLDER,
            to: JACKPOT_HOLDER,
            amount,
            reason: "同時実行テスト",
            startAt,
          },
        });
        worker.once("message", resolve);
        worker.once("error", reject);
      }),
    ),
  );
}

describe("複数接続からの同時実行", () => {
  it("同じgroupKeyを別スレッドから同時に叩いても、資金移動も明細も1回だけ", async () => {
    const ctx = setupFileDb();
    const before = ctx.ether.balanceOf(HOUSE_HOLDER);
    ctx.db.close(); // ワーカー側の接続だけで競合させる

    const results = await runWorkers(ctx.dbPath, "concurrent:group", 6, 1_000);

    const reopened = openDb(ctx.dbPath);
    const chipTx = new ChipTx(reopened);
    const house = (reopened.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(HOUSE_HOLDER) as {
      amount: number;
    }).amount;
    const jackpot = (reopened.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(JACKPOT_HOLDER) as {
      amount: number;
    }).amount;
    const rows = chipTx.listByGroup("concurrent:group");
    reopened.close();

    // 1件だけが実行し、残りは保存済みの結果を受け取る（落ちない）
    expect(results.filter((r) => r.outcome === "executed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "replayed")).toHaveLength(5);
    expect(results.filter((r) => r.outcome === "error")).toEqual([]);
    // 全員が同じ結果を見る
    expect(new Set(results.map((r) => r.result))).toEqual(new Set([JSON.stringify({ moved: 1_000 })]));
    // 資金も明細も1回分
    expect(house).toBe(before - 1_000);
    expect(jackpot).toBe(1_000);
    expect(rows).toHaveLength(1);
  }, 30_000);

  it("先に確定したグループがあれば、後から来た側は資金を動かさず同じ結果を返す", async () => {
    const ctx = setupFileDb();
    const first = ctx.ether.runGroup({ groupKey: "pre:settled", kind: "solo_game", actorId: "alice" }, () => {
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 500, { reason: "先行した精算" });
      return { moved: 500 };
    });
    const after = ctx.ether.balanceOf(HOUSE_HOLDER);
    ctx.db.close();

    const results = await runWorkers(ctx.dbPath, "pre:settled", 4, 500);

    const reopened = openDb(ctx.dbPath);
    const house = (reopened.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(HOUSE_HOLDER) as {
      amount: number;
    }).amount;
    const rows = new ChipTx(reopened).listByGroup("pre:settled");
    reopened.close();

    expect(first).toEqual({ moved: 500 });
    expect(results.every((r) => r.outcome === "replayed")).toBe(true);
    expect(house).toBe(after);
    expect(rows).toHaveLength(1);
  }, 30_000);
});
