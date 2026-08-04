/**
 * PR10 監査: 別SQLite接続・別Nodeプロセスでの並行性とクラッシュ窓。
 *
 * `:memory:` では別接続を作れないので、ここだけ実ファイルDBを使う。
 * 「別プロセスが先に確定させた」状態を作ってから同じ操作を実行し、
 * 資金が二度動かないこと・skipが成功扱いされないことを確かめる。
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CasinoChipAssets,
  CasinoChipFlow,
  ChipLedger,
  ChipTx,
  EventLog,
  HouseReservations,
  Ledger,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

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

function fileCtx(path: string, options: { isSeatOccupied?: (userId: string) => boolean } = {}) {
  const db = openDb(path);
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  const assets = new CasinoChipAssets(db, chips);
  new HouseReservations(db, chips, events);
  const flow = new CasinoChipFlow(db, chips, events, assets, options);
  return { db, ledger, chipTx, chips, assets, flow };
}

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chip-flow-conc-"));
  tempDirs.push(dir);
  return join(dir, "db.sqlite");
}

// 子プロセスの解決は cwd に依存させない（リポジトリ直下から vitest を起動すると
// hoist 済みの node_modules に better-sqlite3 が居ないことがある）
const driverPath = createRequire(import.meta.url).resolve("better-sqlite3");

/** 別Nodeプロセスから同じDBへ書く。 */
function externalExec(path: string, sql: string): void {
  execFileSync(
    process.execPath,
    [
      "-e",
      "const D=require(process.argv[1]);const d=new D(process.argv[2],{timeout:5000});d.pragma('journal_mode=WAL');d.pragma('busy_timeout=5000');d.exec(process.argv[3]);d.close()",
      driverPath,
      path,
      sql,
    ],
    { stdio: "pipe" },
  );
}

function seed(ctx: ReturnType<typeof fileCtx>, userId: string, land: number, chips = land): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY, to: `user:${userId}`, amount: land, type: "initial", actor: "test",
    idempotencyKey: `seed:${userId}`,
  });
  if (chips > 0) ctx.chips.deposit(userId, chips, `deposit:${userId}`);
}

describe("PR10監査: 別接続・別プロセス", () => {
  it("別接続が先に返還を確定させていれば、二度目は資金を動かさず同じ結果を返す", () => {
    const path = newDbPath();
    const a = fileCtx(path);
    openFormally(a.chipTx, a.ledger);
    seed(a, "alice", 100);

    // 接続A が確定
    expect(a.flow.redeemFreeChips("alice", "leave-1", "退場").redeemed).toBe(100);
    expect(a.ledger.balanceOf("user:alice")).toBe(100);

    // 接続B が同じ operationId を実行しても replay になる
    const b = fileCtx(path);
    const replayed = b.flow.redeemFreeChips("alice", "leave-1", "退場");
    expect(replayed.redeemed).toBe(100);
    expect(b.ledger.balanceOf("user:alice")).toBe(100);
    expect(b.assets.freeChips("alice")).toBe(0);

    a.db.close();
    b.db.close();
  });

  it("別プロセスが所有を作った直後の返還は、skipになり資金も group も残さない", () => {
    const path = newDbPath();
    const a = fileCtx(path);
    openFormally(a.chipTx, a.ledger);
    seed(a, "alice", 100);

    externalExec(
      path,
      `INSERT INTO casino_house_reservations (key,amount,game,user_id,created_at)
       VALUES ('ext:alice',100,'slots','alice',0);`,
    );

    const result = a.flow.redeemAllFreeChips("startup");
    expect(result.redeemed).toEqual([]);
    expect(result.skipped).toEqual([{ userId: "alice", amount: 100, reason: "active_ownership" }]);
    expect(a.assets.freeChips("alice")).toBe(100);
    expect(a.ledger.balanceOf("user:alice")).toBe(0);

    // 所有が消えれば同じ鍵で再試行できる（0円groupが残っていない）
    externalExec(path, "DELETE FROM casino_house_reservations WHERE user_id='alice';");
    const retry = a.flow.redeemAllFreeChips("startup");
    expect(retry.redeemed.map((entry) => entry.userId)).toEqual(["alice"]);
    expect(a.ledger.balanceOf("user:alice")).toBe(100);
    a.db.close();
  });

  it("別プロセスが同額を預け直しても、返還の冪等キーが衝突せず実際に返る", () => {
    const path = newDbPath();
    const a = fileCtx(path);
    openFormally(a.chipTx, a.ledger);
    seed(a, "alice", 300, 100);

    expect(a.flow.redeemAllFreeChips("startup").redeemed[0]?.redeemed).toBe(100);
    expect(a.ledger.balanceOf("user:alice")).toBe(300);

    // 別プロセスが同じ秒のうちに同額を戻す
    a.chips.deposit("alice", 100, "redeposit:alice");
    expect(a.assets.freeChips("alice")).toBe(100);

    const second = a.flow.redeemAllFreeChips("startup");
    expect(second.redeemed[0]?.redeemed).toBe(100);
    expect(a.assets.freeChips("alice")).toBe(0);
    expect(a.ledger.balanceOf("user:alice")).toBe(300);
    a.db.close();
  });

  it("別接続からの二重実行でも緊急返還は二重に資金を動かさない", () => {
    const path = newDbPath();
    const a = fileCtx(path);
    openFormally(a.chipTx, a.ledger);
    seed(a, "alice", 100);
    a.flow.createRefundSaga({ id: "saga-c", requestedBy: "user:admin", scope: "all" });

    const b = fileCtx(path);
    expect(a.flow.executeRefundSaga("saga-c", "user:admin").status).toBe("completed");
    expect(b.flow.executeRefundSaga("saga-c", "user:admin").status).toBe("completed");
    expect(a.ledger.balanceOf("user:alice")).toBe(100);

    a.db.close();
    b.db.close();
  });

  it("返還group確定・saga記録前でクラッシュしても、再実行でcompletedへ収束し二重返還しない", () => {
    const path = newDbPath();
    const a = fileCtx(path);
    openFormally(a.chipTx, a.ledger);
    seed(a, "alice", 100);
    a.flow.createRefundSaga({ id: "saga-crash", requestedBy: "user:admin", scope: "all" });

    // 返還グループだけ確定した状態でプロセスが落ちる
    a.flow.redeemExactFreeChips("alice", 100, "emergency:saga-crash:alice", "緊急返還", true);
    externalExec(path, "UPDATE casino_chip_refund_sagas SET status='executing' WHERE id='saga-crash';");
    expect(a.ledger.balanceOf("user:alice")).toBe(100);
    a.db.close();

    // 再起動後の別接続で再実行
    const b = fileCtx(path);
    const saga = b.flow.executeRefundSaga("saga-crash", "user:admin");
    expect(saga.status).toBe("completed");
    expect(b.ledger.balanceOf("user:alice")).toBe(100);
    expect(b.assets.freeChips("alice")).toBe(0);
    b.db.close();
  });

  it("別プロセスが自由チップを増やした確認票は、返還せずstaleとして拒否する", () => {
    const path = newDbPath();
    const a = fileCtx(path);
    openFormally(a.chipTx, a.ledger);
    seed(a, "alice", 300, 100);

    a.flow.createExternalConfirmation({
      id: "c-conc",
      userId: "alice",
      operationKind: "shop",
      operationId: "op",
      requiredLand: 100,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    // 確認後に残高が変わる
    a.chips.deposit("alice", 50, "extra:alice");

    expect(() => a.flow.executeExternalConfirmation("c-conc", "alice", () => "done")).toThrow(/変わっています/);
    expect(a.assets.freeChips("alice")).toBe(150);
    expect(a.flow.externalConfirmation("c-conc")?.status).toBe("pending");
    a.db.close();
  });
});
