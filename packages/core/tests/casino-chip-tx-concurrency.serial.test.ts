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
import { ChipLedger, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { JACKPOT_HOLDER } from "../src/casino/service.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { deptAccount } from "../src/departments/service.js";

import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * 冪等性の本番条件（複数接続・同時実行）を確かめる。
 *
 * 同じプロセス・同じ接続で繰り返し呼ぶだけでは、better-sqlite3 は同期なので実質直列になり、
 * 「同時に叩かれたらどうなるか」を確かめたことにならない。ここでは一時ファイルDBに対して
 * **別プロセスから本番コード（openDb / ChipTx / ChipLedger.runGroup）** を同じ瞬間に走らせる。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "chip-tx-runner.ts");

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
  const ether = new ChipLedger(db, ledger, events, { chipTx });
  // 正式開業ロックは外せない（PR8監査・ブロッカーA）。資金を動かす前に opening_v1 を確定させる
  openFormally(ether.chipTx, ledger);

  ledger.ensureAccount(deptAccount("賭博場"), "system");
  ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: "seed:dept",
  });
  ether.fundFromAccount(deptAccount("賭博場"), 100_000, HOUSE_HOLDER, "seed:house");
  ether.ensureHolder(JACKPOT_HOLDER);
  return { dbPath, db, ledger, events, chipTx, ether };
}

interface RunnerResult {
  outcome: "executed" | "replayed" | "error";
  payload: unknown;
  error: string | null;
}

/** 本番コードを別プロセスで N 個、同じ瞬間に走らせる */
function runProcesses(dbPath: string, groupKey: string, count: number, amount: number): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000; // 起動のばらつきを吸収してから一斉に走らせる
  return Promise.all(
    Array.from({ length: count }, () =>
      new Promise<RunnerResult>((resolve, reject) => {
        const input = JSON.stringify({
          dbPath,
          groupKey,
          kind: "solo_game",
          actorId: "alice",
          from: HOUSE_HOLDER,
          to: JACKPOT_HOLDER,
          amount,
          reason: "同時実行テスト",
          startAt,
        });
        const child = spawn(process.execPath, ["--import", "tsx", RUNNER, input], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += String(chunk)));
        child.stderr.on("data", (chunk) => (err += String(chunk)));
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

describe("複数接続からの同時実行（本番コード）", () => {
  it("同じgroupKeyを別プロセスから同時に叩いても、資金移動も明細も1回だけ", async () => {
    const ctx = setupFileDb();
    const before = ctx.ether.balanceOf(HOUSE_HOLDER);
    ctx.db.close(); // 子プロセス側の接続だけで競合させる

    const results = await runProcesses(ctx.dbPath, "concurrent:group", 5, 1_000);

    const reopened = openDb(ctx.dbPath);
    const chipTx = new ChipTx(reopened);
    const balance = (holder: string) =>
      ((reopened.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(holder) as
        | { amount: number }
        | undefined)?.amount ?? 0);
    const house = balance(HOUSE_HOLDER);
    const jackpot = balance(JACKPOT_HOLDER);
    const rows = chipTx.listByGroup("concurrent:group");
    const verified = chipTx.verifyBalances();
    reopened.close();

    // 1プロセスだけが実行し、残りは保存済みの結果を受け取る（SQLITE_BUSY 等で落ちない）
    expect(results.filter((r) => r.outcome === "error")).toEqual([]);
    expect(results.filter((r) => r.outcome === "executed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "replayed")).toHaveLength(4);
    // 全員が同じ結果を見る
    expect(results.map((r) => JSON.stringify(r.payload))).toEqual(
      Array.from({ length: 5 }, () => JSON.stringify({ moved: 1_000 })),
    );
    // 資金も明細も1回分
    expect(house).toBe(before - 1_000);
    expect(jackpot).toBe(1_000);
    expect(rows).toHaveLength(1);
    expect(verified.ok).toBe(true);
  }, 60_000);

  it("先に確定したグループへ後から来ても、資金を動かさず同じ結果を返す", async () => {
    const ctx = setupFileDb();
    const first = ctx.ether.runGroup({ groupKey: "pre:settled", kind: "solo_game", actorId: "alice" }, () => {
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 500, { reason: "先行した精算" });
      return { moved: 500 };
    });
    const after = ctx.ether.balanceOf(HOUSE_HOLDER);
    ctx.db.close();

    const results = await runProcesses(ctx.dbPath, "pre:settled", 3, 500);

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
  }, 60_000);
});
