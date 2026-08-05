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
import { ChipLedger } from "../src/casino/exchange.js";
import { EVENT_MARKET_CREATE_FEE, Markets, eventMarketEscrowHolder } from "../src/casino/market.js";

registerDefaultTxTypes();

/**
 * イベントLand板（緊急イベント用 hotfix）の冪等性・原子性を、**別接続・別プロセス**の
 * 本番コードで確かめる（CLAUDE.md §5: `:memory:` では別接続を作れないので実ファイルDBを使う）。
 *
 * 同一プロセス・同一接続の呼び出しは better-sqlite3 が同期のため実質直列になり、
 * 「同時に叩かれたらどうなるか」を確かめたことにならない。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "event-market-runner.ts");
const ROLE_A = "111111111111111111";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows ローカル環境要因（EPERM）はここでは無視する（CLAUDE.md §5）。
      // 一時ディレクトリの掃除失敗であって、テスト対象の正しさとは無関係。
    }
  }
});

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-event-market-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const ether = new ChipLedger(db, ledger, events);
  const markets = new Markets(db, ether, events, { landLedger: ledger });
  return { dbPath, db, ledger, events, ether, markets };
}

function seedLand(ledger: Ledger, userId: string, amount: number): void {
  ledger.ensureAccount(`user:${userId}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount,
    type: "initial",
    actor: "t",
    idempotencyKey: `seed:${userId}:${Math.random()}`,
  });
}

interface RunnerResult {
  outcome: "ok" | "error";
  payload: unknown;
  error: string | null;
  errorCode: string | null;
}

interface RunInput {
  action: "bet" | "settle" | "void";
  marketId: number;
  userId: string;
  roleIds?: string[];
  optionIndex?: number;
  amount?: number;
  winningOption?: number;
  isAdmin?: boolean;
  operationId: string;
}

/** 本番コードを別プロセスで、同じ瞬間に走らせる */
function runProcesses(dbPath: string, inputs: RunInput[]): Promise<RunnerResult[]> {
  const startAt = Date.now() + 1_500; // 起動のばらつきを吸収してから一斉に走らせる
  return Promise.all(
    inputs.map(
      (input) =>
        new Promise<RunnerResult>((resolve, reject) => {
          const json = JSON.stringify({ ...input, dbPath, startAt });
          const child = spawn(process.execPath, ["--import", "tsx", RUNNER, json], {
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

describe("イベントLand板: 複数接続・別プロセスからの同時実行", () => {
  it("同一利用者の同時bet（2つの別operationId）: 二重徴収せず最終状態が一貫する", async () => {
    const ctx = setupFileDb();
    seedLand(ctx.ledger, "creator", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "並行bet",
      options: ["A", "B"],
      durationMin: 60,
      allowedRoleIds: [ROLE_A],
      operationId: "create-op-1",
    });
    seedLand(ctx.ledger, "racer", 5_000);
    const before = ctx.ledger.balanceOf("user:racer");
    ctx.db.close();

    const results = await runProcesses(ctx.dbPath, [
      { action: "bet", marketId: m.id, userId: "racer", roleIds: [ROLE_A], optionIndex: 0, amount: 700, operationId: "op-A" },
      { action: "bet", marketId: m.id, userId: "racer", roleIds: [ROLE_A], optionIndex: 1, amount: 900, operationId: "op-B" },
    ]);

    expect(results.every((r) => r.outcome === "ok")).toBe(true);

    const reopened = openDb(ctx.dbPath);
    const ledger2 = new Ledger(reopened);
    const bets = reopened.prepare("SELECT * FROM casino_market_bets WHERE market_id = ?").all(m.id) as Array<{
      user_id: string;
      amount: number;
      option_index: number;
    }>;

    // 1人1口が守られている（re-bet が上書きした結果、行は1つだけ）
    expect(bets).toHaveLength(1);
    expect(bets[0]!.user_id).toBe("racer");
    // 最終的な bet 額は 700 か 900 のどちらか（後勝ち）だが、二重には課金されていない
    expect([700, 900]).toContain(bets[0]!.amount);
    const escrowBal = ledger2.balanceOf(eventMarketEscrowHolder(m.id));
    expect(escrowBal).toBe(bets[0]!.amount); // escrow残高 === 最終bet額（整合ガード通り）
    expect(ledger2.balanceOf("user:racer")).toBe(before - bets[0]!.amount); // 純減額は1回分だけ
    reopened.close();
  }, 60_000);

  it("複数利用者の同時bet: 互いに干渉せず、escrow残高がpot合計と一致する", async () => {
    const ctx = setupFileDb();
    seedLand(ctx.ledger, "creator", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "並行複数bet",
      options: ["A", "B"],
      durationMin: 60,
      allowedRoleIds: [ROLE_A],
      operationId: "create-op-2",
    });
    const userIds = ["u1", "u2", "u3", "u4"];
    for (const uid of userIds) seedLand(ctx.ledger, uid, 2_000);
    ctx.db.close();

    const results = await runProcesses(
      ctx.dbPath,
      userIds.map((uid, i) => ({
        action: "bet" as const,
        marketId: m.id,
        userId: uid,
        roleIds: [ROLE_A],
        optionIndex: i % 2,
        amount: 500 + i * 10,
        operationId: `op-${uid}`,
      })),
    );

    expect(results.every((r) => r.outcome === "ok")).toBe(true);

    const reopened = openDb(ctx.dbPath);
    const ledger2 = new Ledger(reopened);
    const bets = reopened.prepare("SELECT * FROM casino_market_bets WHERE market_id = ?").all(m.id) as Array<{
      user_id: string;
      amount: number;
    }>;

    expect(bets).toHaveLength(4);
    const pot = bets.reduce((s, b) => s + b.amount, 0);
    expect(ledger2.balanceOf(eventMarketEscrowHolder(m.id))).toBe(pot);
    for (const uid of userIds) {
      const bet = bets.find((b) => b.user_id === uid)!;
      expect(ledger2.balanceOf(`user:${uid}`)).toBe(2_000 - bet.amount);
    }
    reopened.close();
  }, 60_000);

  it("同じ結果確定buttonの同時押下（同じoperationId）: 二重配当しない", async () => {
    const ctx = setupFileDb();
    seedLand(ctx.ledger, "creator", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "並行settle",
      options: ["A", "B"],
      durationMin: 60,
      allowedRoleIds: [ROLE_A],
      operationId: "create-op-3",
    });
    seedLand(ctx.ledger, "winner", 2_000);
    seedLand(ctx.ledger, "loser", 2_000);
    ctx.markets.betEventLand(m.id, "winner", [ROLE_A], 0, 1_000, "bet-winner");
    ctx.markets.betEventLand(m.id, "loser", [ROLE_A], 1, 1_000, "bet-loser");
    ctx.markets.close(m.id, "creator");
    ctx.db.close();

    const sameOp = "confirm-op-shared";
    const results = await runProcesses(
      ctx.dbPath,
      Array.from({ length: 3 }, () => ({
        action: "settle" as const,
        marketId: m.id,
        userId: "creator",
        winningOption: 0,
        isAdmin: false,
        operationId: sameOp,
      })),
    );

    expect(results.every((r) => r.outcome === "ok")).toBe(true);
    // 全プロセスが同じ結果（同じ配当額）を見る
    const payloads = results.map((r) => JSON.stringify(r.payload));
    expect(new Set(payloads).size).toBe(1);

    const reopened = openDb(ctx.dbPath);
    const ledger2 = new Ledger(reopened);
    const marketRow = reopened.prepare("SELECT status FROM casino_markets WHERE id = ?").get(m.id) as { status: string };
    const feesBal = ledger2.balanceOf("sys:escrow:market:fees");
    const winnerBal = ledger2.balanceOf("user:winner");
    reopened.close();

    expect(marketRow.status).toBe("settled");
    // fees holder には板の開設手数料 500Ld が先に入っているので、houseCut(60) を足した 560 になる。
    // 二重配当ならここが 500+120=620 になるはずなので、560 であること自体が「houseCutは1回分だけ」の証拠。
    expect(feesBal).toBe(EVENT_MARKET_CREATE_FEE + 60);
    expect(winnerBal).toBe(1_000 + 1_940); // 元残高1000 + 配当(pot2000-houseCut60=1940、単独勝者)
  }, 60_000);

  it("同じ無効化（void）操作の同時実行（同じoperationId）: 二重返金しない", async () => {
    const ctx = setupFileDb();
    seedLand(ctx.ledger, "creator", EVENT_MARKET_CREATE_FEE);
    const m = ctx.markets.createEvent({
      guildId: "g",
      creatorId: "creator",
      title: "並行void",
      options: ["A", "B"],
      durationMin: 60,
      allowedRoleIds: [ROLE_A],
      operationId: "create-op-4",
    });
    seedLand(ctx.ledger, "u1", 2_000);
    ctx.markets.betEventLand(m.id, "u1", [ROLE_A], 0, 800, "bet-u1");
    ctx.db.close();

    const sameOp = "void-op-shared";
    const results = await runProcesses(
      ctx.dbPath,
      Array.from({ length: 3 }, () => ({
        action: "void" as const,
        marketId: m.id,
        userId: "admin",
        operationId: sameOp,
      })),
    );

    expect(results.every((r) => r.outcome === "ok")).toBe(true);
    const payloads = results.map((r) => JSON.stringify(r.payload));
    expect(new Set(payloads).size).toBe(1);

    const reopened = openDb(ctx.dbPath);
    const ledger2 = new Ledger(reopened);
    const marketRow = reopened.prepare("SELECT status FROM casino_markets WHERE id = ?").get(m.id) as { status: string };
    const u1Bal = ledger2.balanceOf("user:u1");
    reopened.close();

    expect(marketRow.status).toBe("void");
    expect(u1Bal).toBe(2_000); // 全額1回だけ返金（2000のまま、二重返金で2800等になっていない）
  }, 60_000);
});
