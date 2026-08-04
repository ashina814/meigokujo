/**
 * PR11独立監査 #50 フォローアップ: 別接続・別Nodeプロセスから `Escrow.hold()` /
 * `Escrow.holdAll()` に**異なる要求**（amount・game・参加者構成）で実際にほぼ同時アクセスした
 * ときの競合を検証する。
 *
 * `casino-chinchiro-prehold-independent-audit.test.ts` の「実際に同時開始する2プロセスの
 * 競合」と同じ ready/go 同期方式（両ワーカーの準備完了を確認してから一斉に "go" を書く）を
 * 使う。SQLite の IMMEDIATE トランザクションにより、実際には必ずどちらか一方が先に
 * `casino_tx_groups` へ INSERT できて確定し、もう一方は UNIQUE 制約違反から
 * 「保存済みグループの replay」経路に落ちる。異なる要求で来たそちらの側が、
 * fingerprint の不一致を検出して conflict で拒否されることを確認する
 * （＝どちらの要求が勝っても、実際に動いた額と勝者の要求が食い違わない）。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHIP_ESCROW,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  FORMAL_OPENING_VERSION,
  Ledger,
  TREASURY,
  escrowHolderFor,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";

registerDefaultTxTypes();

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows はハンドル解放前だと EPERM を返す。テスト結果には影響しない
    }
  }
});

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "escrow-hold-race-"));
  tempDirs.push(dir);
  return join(dir, "db.sqlite");
}

function fileSetup(path: string) {
  const db = openDb(path);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const escrow = new Escrow(db, chips, events);
  return { db, ledger, chipTx, chips, escrow };
}

/** 正式開業ロックは外せない（PR8監査・ブロッカーA）。資金を動かす前に opening_v1 を確定させる */
function openFormally(ctx: ReturnType<typeof fileSetup>): void {
  ctx.chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
    poolLand: ctx.ledger.balanceOf(CHIP_ESCROW),
    fromLedgerTxId: ctx.ledger.lastTransactionId(),
  });
}

function fund(ctx: ReturnType<typeof fileSetup>, uid: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${uid}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${uid}`, amount, type: "initial", actor: "test", idempotencyKey: `seed:${uid}` });
  ctx.chips.deposit(uid, amount, `deposit:${uid}`);
}

const tsxCliPath = createRequire(import.meta.url).resolve("tsx/cli");
const raceWorkerPath = fileURLToPath(new URL("./helpers/escrow-hold-race-worker.ts", import.meta.url));

async function runRace(
  dbPath: string,
  workers: ReadonlyArray<{ action: string; args: string[] }>,
): Promise<Array<{ result: unknown; error: string | null }>> {
  const dir = mkdtempSync(join(tmpdir(), "escrow-hold-race-signal-"));
  tempDirs.push(dir);
  const goPath = join(dir, "go");

  const specs = workers.map((w, i) => ({
    ...w,
    readyPath: join(dir, `ready-${i}`),
    outPath: join(dir, `out-${i}`),
  }));

  const children = specs.map((spec) =>
    spawn(
      process.execPath,
      [tsxCliPath, raceWorkerPath, dbPath, spec.readyPath, goPath, spec.outPath, spec.action, ...spec.args],
      { stdio: "pipe" },
    ),
  );

  const exits = children.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`race worker exited ${code}: ${stderr}`));
          else resolve();
        });
      }),
  );

  const deadline = Date.now() + 5000;
  while (!specs.every((spec) => existsSync(spec.readyPath))) {
    if (Date.now() > deadline) throw new Error("race workers did not become ready in time");
    await new Promise((r) => setTimeout(r, 5));
  }
  writeFileSync(goPath, "go");

  await Promise.all(exits);

  const { readFileSync } = await import("node:fs");
  return specs.map((spec) => JSON.parse(readFileSync(spec.outPath, "utf8")) as { result: unknown; error: string | null });
}

describe("PR11独立監査#50フォローアップ: 別接続・別Nodeプロセスからhold()に異なる要求で同時競合", () => {
  it("同じsession/user/operationIdに異なるamountで同時アクセスすると、片方だけ通り、もう片方はconflictで拒否される（資金は勝者の額しか動かない）", async () => {
    const path = newDbPath();
    const a = fileSetup(path);
    openFormally(a);
    fund(a, "u1", 10_000);
    a.db.close();

    const outcomes = await runRace(path, [
      { action: "hold", args: ["s1", "u1", "3000", "duel", "op-race"] },
      { action: "hold", args: ["s1", "u1", "7000", "duel", "op-race"] },
    ]);

    const successes = outcomes.filter((o) => o.result === true);
    const conflicts = outcomes.filter((o) => o.error?.includes("operation conflict"));
    // どちらが先に鍵を取るかは非決定的だが、必ず「片方だけ成功・片方だけconflict」になる
    // （両方成功＝二重取り違え成功、両方conflict＝正当な1件目まで拒否、はどちらも起きてはいけない）
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // 実際に動いた額は、勝者（成功した側）が要求した額のどちらか一方だけ。
    // 3,000 と 7,000 の合算(10,000)や中間値になっていないことを確認する
    const check = fileSetup(path);
    const held = check.chips.balanceOf(escrowHolderFor("s1"));
    expect([3_000, 7_000]).toContain(held);
    expect(check.chips.balanceOf("u1")).toBe(10_000 - held);
    check.db.close();
  });

  it("holdAllに異なる参加者構成で同時アクセスしても、片方だけ通りもう片方はconflictで拒否される", async () => {
    const path = newDbPath();
    const a = fileSetup(path);
    openFormally(a);
    fund(a, "alice", 10_000);
    fund(a, "bob", 10_000);
    fund(a, "carol", 10_000);
    a.db.close();

    const outcomes = await runRace(path, [
      { action: "holdAll", args: ["s1", "alice,bob", "2000", "丁半", "op-race"] },
      { action: "holdAll", args: ["s1", "alice,carol", "2000", "丁半", "op-race"] },
    ]);

    const successes = outcomes.filter((o) => o.result === true);
    const conflicts = outcomes.filter((o) => o.error?.includes("operation conflict"));
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // 負けた側の参加者（bob または carol、勝者に含まれない方）からは何も取られていない
    const check = fileSetup(path);
    const bobTaken = check.chips.balanceOf("bob") < 10_000;
    const carolTaken = check.chips.balanceOf("carol") < 10_000;
    // 勝者側の2人ぶんだけ取られている（bob,carolの片方だけ減っている。両方減る/両方減らないはNG）
    expect(bobTaken).not.toBe(carolTaken);
    expect(check.chips.balanceOf("alice")).toBe(10_000 - 2_000); // aliceは両方の候補に共通
    check.db.close();
  });
});
