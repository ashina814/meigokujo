import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { HOUSE_HOLDER } from "../src/casino/exchange.js";
import { HouseReservations } from "../src/casino/reservations.js";
import { EtherExchangeCore } from "../src/casino/exchange.js";
import { Ledger } from "../src/ledger/service.js";
import { EventLog } from "../src/events/service.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";

registerDefaultTxTypes();

/**
 * PR5（胴元債務予約）の並行性を、単一プロセス内のループではなく
 * **別プロセスから本番コード（openDb / HouseReservations.reserve）**を同じ瞬間に
 * 走らせて確かめる。single-instance の Promise 並行だけでは、better-sqlite3 は
 * 同期 API なので実質直列になり、複数接続での競合を確かめたことにならない。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "reservation-runner.ts");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setupFileDb(houseBalance: number) {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-reservations-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(HOUSE_HOLDER, houseBalance);
  return { dbPath, db };
}

interface RunnerResult {
  outcome: "ok" | "capacity" | "conflict" | "error";
  amount: number;
  error: string | null;
}

/** 本番コードを別プロセスで N 件、同じ瞬間に走らせる */
function runReservations(
  dbPath: string,
  requests: Array<{ key: string; amount: number; game: string; userId: string; action?: "reserve" | "resize" }>,
): Promise<RunnerResult[]> {
  const startAt = Date.now() + 2_000; // 起動のばらつきを吸収してから一斉に走らせる
  return Promise.all(
    requests.map(
      (req) =>
        new Promise<RunnerResult>((resolve, reject) => {
          const input = JSON.stringify({ dbPath, startAt, ...req });
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

describe("複数接続からの同時予約（本番コード）", () => {
  it("house余力100に対し別keyで80と80を同時予約すると、成功は片方だけで合計予約は80", async () => {
    const { dbPath, db } = setupFileDb(100);
    db.close(); // 子プロセス側の接続だけで競合させる

    const results = await runReservations(dbPath, [
      { key: "a", amount: 80, game: "スロット", userId: "u1" },
      { key: "b", amount: 80, game: "スロット", userId: "u2" },
    ]);

    const reopened = openDb(dbPath);
    const reservations = new HouseReservations(
      reopened,
      new EtherExchangeCore(reopened, new Ledger(reopened), new EventLog(reopened), { baseRate: 1, chipTx: new ChipTx(reopened) }),
      new EventLog(reopened),
    );
    const total = reservations.totalReserved();
    const count = reservations.count();
    reopened.close();

    expect(results.filter((r) => r.outcome === "error")).toEqual([]);
    expect(results.filter((r) => r.outcome === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "capacity")).toHaveLength(1);
    expect(total).toBe(80);
    expect(count).toBe(1);
  }, 60_000);

  it("同一keyを同時予約しても二重行にならず、二重計上もしない", async () => {
    const { dbPath, db } = setupFileDb(1_000_000);
    db.close();

    const results = await runReservations(
      dbPath,
      Array.from({ length: 5 }, () => ({ key: "same-key", amount: 40_000, game: "スロット", userId: "u1" })),
    );

    const reopened = openDb(dbPath);
    const reservations = new HouseReservations(
      reopened,
      new EtherExchangeCore(reopened, new Ledger(reopened), new EventLog(reopened), { baseRate: 1, chipTx: new ChipTx(reopened) }),
      new EventLog(reopened),
    );
    const total = reservations.totalReserved();
    const count = reservations.count();
    reopened.close();

    // 全プロセスが同じ額を「保存済み」として見る（衝突・二重取得なし）
    expect(results.filter((r) => r.outcome === "error")).toEqual([]);
    expect(results.filter((r) => r.outcome === "conflict")).toEqual([]);
    expect(results.every((r) => r.outcome === "ok" && r.amount === 40_000)).toBe(true);
    expect(count).toBe(1);
    expect(total).toBe(40_000); // 5回動いても合計は1回分
  }, 60_000);

  it("house残高ちょうどを複数プロセスが取り合っても予約合計が残高を超えない", async () => {
    const house = 500_000;
    const { dbPath, db } = setupFileDb(house);
    db.close();

    const per = 100_000;
    const results = await runReservations(
      dbPath,
      Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, amount: per, game: "クラッシュ", userId: `u${i}` })),
    );

    const reopened = openDb(dbPath);
    const reservations = new HouseReservations(
      reopened,
      new EtherExchangeCore(reopened, new Ledger(reopened), new EventLog(reopened), { baseRate: 1, chipTx: new ChipTx(reopened) }),
      new EventLog(reopened),
    );
    const total = reservations.totalReserved();
    reopened.close();

    const okCount = results.filter((r) => r.outcome === "ok").length;
    expect(results.filter((r) => r.outcome === "error")).toEqual([]);
    // house は per の5倍ぴったりなので、最大5件しか通らない
    expect(okCount).toBeLessThanOrEqual(house / per);
    expect(total).toBeLessThanOrEqual(house);
    expect(total).toBe(okCount * per);
  }, 60_000);

  it("resize: 別チャンネル2卓（別key）が余力100に対し各80を同時に取りにいくと、片方だけ成功する（PR5マージ直前レビュー対応）", async () => {
    const { dbPath, db } = setupFileDb(100);
    db.close();

    const results = await runReservations(dbPath, [
      { key: "roulette:reserve:roulette:table-a", amount: 80, game: "ルーレット", userId: "system:roulette", action: "resize" },
      { key: "roulette:reserve:roulette:table-b", amount: 80, game: "ルーレット", userId: "system:roulette", action: "resize" },
    ]);

    const reopened = openDb(dbPath);
    const reservations = new HouseReservations(
      reopened,
      new EtherExchangeCore(reopened, new Ledger(reopened), new EventLog(reopened), { baseRate: 1, chipTx: new ChipTx(reopened) }),
      new EventLog(reopened),
    );
    const total = reservations.totalReserved();
    const count = reservations.count();
    reopened.close();

    expect(results.filter((r) => r.outcome === "error")).toEqual([]);
    expect(results.filter((r) => r.outcome === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "capacity")).toHaveLength(1);
    expect(total).toBe(80);
    expect(count).toBe(1);
  }, 60_000);
});
