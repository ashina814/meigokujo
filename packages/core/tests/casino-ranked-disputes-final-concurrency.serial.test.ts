import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  Casino,
  CasinoMetrics,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  PersistentTables,
  RankedDisputes,
  RankedTables,
  TREASURY,
  escrowHolderFor,
  openDb,
  rankedFeeReservationKey,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";
import { createBarrier, release, waitAllReady } from "./helpers/process-barrier.js";

registerDefaultTxTypes();
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "helpers", "ranked-dispute-final-runner.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunnerResult {
  ok: boolean;
  code?: string;
  error?: string;
  result?: { closed: number; autoRefunded: number; failed: number } | { evidenceId: string; status: string };
  resolutionKind?: string | null;
}

type DeadlineTally = { closed: number; autoRefunded: number; failed: number };

/**
 * 既存DBへ接続し直してサービス一式を組む。次tick相当の掃引を親プロセスで行うのに使う。
 * `afterChips` は「元の組み立て順」を保つための差し込み口。開業処理はチップ台帳の直後、
 * 残りのサービスより前に走らせる必要がある。
 */
function buildServices(db: ReturnType<typeof openDb>, now: number, afterChips?: (chipTx: ChipTx, ledger: Ledger) => void) {
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  afterChips?.(chipTx, ledger);
  const casino = new Casino(db, chips, events);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0);
  const escrow = new Escrow(db, chips, events, { onPlayerNet: (userId, net) => casino.recordGameNet(userId, net) });
  const persistentTables = new PersistentTables(db, events, { openingPhase: () => chipTx.openingPhase(), now: () => now });
  const metrics = new CasinoMetrics(db, chipTx, () => now);
  const disputes = new RankedDisputes(db, chips, escrow, persistentTables, reservations, events, {
    openingPhase: () => chipTx.openingPhase(),
    now: () => now,
    onPlayerNet: (userId, net) => casino.recordGameNet(userId, net),
  });
  const rankedTables = new RankedTables(db, chips, escrow, persistentTables, events, metrics, { now: () => now, reservations, disputes });
  return { ledger, chipTx, chips, escrow, reservations, disputes, rankedTables };
}

function setupFileDb() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-pr22-final-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "casino.db");
  const db = openDb(dbPath);
  const services = buildServices(db, 1_700_000_000, (chipTx, ledger) => openFormally(chipTx, ledger));
  return { dbPath, db, dir, barrierDir: createBarrier(dir), ...services };
}

function seed(ctx: ReturnType<typeof setupFileDb>, userId: string): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${userId}`, amount: 30_000, type: "initial", actor: "test", idempotencyKey: `seed:${userId}` });
  ctx.chips.deposit(userId, 30_000, `deposit:${userId}`);
}

function disputedPostStart(ctx: ReturnType<typeof setupFileDb>, evidence: "pending" | "stored"): { deadline: number; evidenceOperationId: string } {
  ctx.rankedTables.create({ tableId: "t1", gameKey: "gf", baseAmount: 5_000, creatorId: "operator", operatorId: "operator", operationId: "create:t1" });
  seed(ctx, "alice");
  seed(ctx, "bob");
  ctx.rankedTables.join({ tableId: "t1", userId: "alice", seat: 1, operationId: "join:alice" });
  ctx.rankedTables.join({ tableId: "t1", userId: "bob", seat: 2, operationId: "join:bob" });
  ctx.rankedTables.ready({ tableId: "t1", userId: "alice", operationId: "ready:alice" });
  ctx.rankedTables.ready({ tableId: "t1", userId: "bob", operationId: "ready:bob" });
  const submitted = ctx.rankedTables.submitResult({ tableId: "t1", userId: "alice", orderedUserIds: ["alice", "bob"], operationId: "result:t1" });
  ctx.rankedTables.dispute({ tableId: "t1", userId: "bob", resultHash: submitted.result!.hash, operationId: "dispute:bob" });
  const evidenceOperationId = "evidence:race";
  ctx.disputes.beginEvidenceSubmission({ tableId: "t1", submitterId: "alice", evidenceKind: "screenshot", operationId: evidenceOperationId, payloadDigest: "digest" });
  if (evidence === "stored") {
    ctx.disputes.finalizeEvidenceStored({ operationId: evidenceOperationId, privateChannelId: "private-channel", privateMessageId: "private-message" });
  }
  return { deadline: ctx.disputes.publicStatus("t1")!.evidenceDeadlineAt, evidenceOperationId };
}

/**
 * 子プロセスを起動する。子は準備が終わると ready を出してバリアで停止するので、
 * この Promise は「親が release するまで解決しない」。
 * 解放の順序と同時性は呼び出し側が `release()` で決める＝壁時計に依存しない。
 */
function spawnRunner(
  ctx: { dbPath: string; barrierDir: string },
  barrierName: string,
  operation: "deadline" | "finalize" | "ranked_result",
  operationId: string,
  serviceNow: number,
  deadlineNow: number,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({
      dbPath: ctx.dbPath,
      tableId: "t1",
      operation,
      operationId,
      actor: "judge",
      serviceNow,
      deadlineNow,
      barrierDir: ctx.barrierDir,
      barrierName,
    });
    const child = spawn(process.execPath, ["--import", "tsx", RUNNER, input], { stdio: ["ignore", "pipe", "pipe"] });
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
  });
}

function chipSum(db: ReturnType<typeof openDb>): number {
  return (db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM ether_balances").get() as { n: number }).n;
}

/**
 * 締切処理の T1（判定）と T2（返金）の**すきま**へ割り込むための接続ラッパ。
 *
 * T1 は「保存済み主証拠が無い」と判断すると文字列 `needs_refund` を返して commit する。
 * その戻り値を捕まえて hook を呼べば、ロックが解放された直後・T2 が始まる前という
 * 狙った一点で他プロセスの確定を再現できる。
 *
 * 本番コードにテスト用の穴を開けたくないので、`RankedDisputes` へ渡す接続だけを
 * Proxy でくるむ。`chips` 側（T2 を張る ChipTx）は素の接続のままなので、
 * 差し込まれるのは T1 の直後だけに限られる。
 */
function dbInterceptingDeadlineDecision(db: ReturnType<typeof openDb>, hook: () => void): ReturnType<typeof openDb> {
  let fired = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return (fn: never) => {
        const tx = target.transaction(fn) as unknown as Record<string, (...args: unknown[]) => unknown> & ((...args: unknown[]) => unknown);
        const wrap = (run: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
          const out = run(...args);
          if (out === "needs_refund" && !fired) {
            fired = true;
            hook();
          }
          return out;
        };
        const wrapped = wrap(tx) as typeof tx;
        for (const mode of ["immediate", "deferred", "exclusive"] as const) {
          wrapped[mode] = wrap(tx[mode]!);
        }
        return wrapped;
      };
    },
  });
}

describe("PR22 final review cross-process arbitration races", () => {
  /**
   * 締切処理は**2つのトランザクション**に分かれている（ranked-disputes.ts processEvidenceDeadlines）。
   *
   *   T1 closeTx.immediate()        … 保存済み主証拠があるか判定するだけ。無ければ無書き込みで commit
   *   （ここが競合窓。T1 の commit でロックが外れる）
   *   T2 resolveWithFingerprint     … runGroup の単一 IMMEDIATE tx。中で再判定してから返金する
   *
   * finalizeEvidenceStored も IMMEDIATE なので、T2 と同時には走れない。
   * よって成立する interleaving は次の3つで、いずれも「保存済み証拠 + 返金確定」にはならない。
   *
   *   A. finalize が T1 より先      → stored + awaiting_arbitration（closed:1）
   *   B. T2 が finalize より先      → insufficient_evidence + 返金（autoRefunded:1）、finalize は拒否
   *   C. finalize が T1 と T2 の間  → stored + collecting_evidence のまま。T2 は再判定で自ら rollback
   *                                   （failed:1）。返金は起きず、次の掃引で awaiting_arbitration へ収束
   *
   * C は資金の穴ではなく**一時的な liveness の遅れ**。以前のテストは A と B しか想定しておらず、
   * C を引くたびに落ちていた（これがフレークの正体）。期待値を緩めるのではなく、
   * 3分岐それぞれの不変条件と、C の収束先まで検証する。
   */
  it("A: finalize/deadline race lands in one of three legal states and never refunds stored evidence", async () => {
    const ctx = setupFileDb();
    const { deadline, evidenceOperationId } = disputedPostStart(ctx, "pending");
    ctx.db.close();

    const finalizeRun = spawnRunner(ctx, "finalize", "finalize", evidenceOperationId, deadline - 1, deadline);
    const deadlineRunPromise = spawnRunner(ctx, "deadline", "deadline", "deadline:t1", deadline - 1, deadline);
    // 双方が DB open・service 構築・事前読み込みを終えてから、同時に解放する
    await waitAllReady(ctx.barrierDir, ["finalize", "deadline"]);
    release(ctx.barrierDir, "finalize", "deadline");
    const [finalize, deadlineRun] = await Promise.all([finalizeRun, deadlineRunPromise]);

    const db = openDb(ctx.dbPath);
    const read = () => ({
      evidence: (db.prepare("SELECT storage_status AS storageStatus FROM casino_table_evidence WHERE operation_id=?").get(evidenceOperationId) as { storageStatus: string }),
      dispute: (db.prepare("SELECT status, resolved_at AS resolvedAt, resolution_kind AS resolutionKind FROM casino_table_disputes WHERE table_id='t1'").get() as {
        status: string;
        resolvedAt: number | null;
        resolutionKind: string | null;
      }),
      table: (db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string }),
      escrowHeld: (db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount,
      refundGroups: (db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:evidence-timeout:%'").get() as { n: number }).n,
    });
    const after = read();

    // 3分岐に共通する絶対条件: 保存済み証拠と返金確定が同居しない
    expect(after.evidence.storageStatus === "stored" && after.dispute.resolvedAt !== null).toBe(false);

    if (after.evidence.storageStatus !== "stored") {
      // B: 締切側が先に確定した
      expect(deadlineRun.ok).toBe(true);
      expect(deadlineRun.result).toEqual({ closed: 0, autoRefunded: 1, failed: 0 } satisfies DeadlineTally);
      expect(finalize.ok).toBe(false);
      expect(after.dispute.resolutionKind).toBe("insufficient_evidence");
      expect(after.dispute.resolvedAt).not.toBeNull();
      expect(after.table.state).toBe("cancelled");
      expect(after.escrowHeld).toBe(0);
      expect(after.refundGroups).toBe(1);
      db.close();
      return;
    }

    expect(finalize.ok).toBe(true);
    expect(deadlineRun.ok).toBe(true);
    expect(after.dispute.resolvedAt).toBeNull();
    expect(after.table.state).toBe("disputed");
    // 返金は一切起きていない。預託は満額、返金グループも作られていない
    expect(after.escrowHeld).toBe(10_000);
    expect(after.refundGroups).toBe(0);

    if (after.dispute.status === "awaiting_arbitration") {
      // A: finalize が T1 の判定より先に確定した
      expect(deadlineRun.result).toEqual({ closed: 1, autoRefunded: 0, failed: 0 } satisfies DeadlineTally);
      db.close();
      return;
    }

    // C: finalize が T1 と T2 の間に割り込んだ
    expect(after.dispute.status).toBe("collecting_evidence");
    // 締切側は「正常な競合」として自ら rollback し、failed に数えて終わっている
    expect(deadlineRun.result).toEqual({ closed: 0, autoRefunded: 0, failed: 1 } satisfies DeadlineTally);
    const conflict = db
      .prepare("SELECT payload_json AS payloadJson FROM events WHERE type='casino_ranked_dispute_deadline_failed' AND target_id='t1' ORDER BY id DESC LIMIT 1")
      .get() as { payloadJson: string } | undefined;
    expect(conflict?.payloadJson ?? "").toContain("stored main evidence won the deadline race");

    // 次tick相当の掃引で、安全な終端（裁定待ち）へ収束すること
    const sweep = buildServices(db, deadline).disputes.processEvidenceDeadlines(deadline);
    expect(sweep).toEqual({ closed: 1, autoRefunded: 0, failed: 0 } satisfies DeadlineTally);
    const converged = read();
    expect(converged.dispute.status).toBe("awaiting_arbitration");
    expect(converged.dispute.resolvedAt).toBeNull();
    expect(converged.table.state).toBe("disputed");
    expect(converged.escrowHeld).toBe(10_000);
    expect(converged.refundGroups).toBe(0);
    db.close();
  }, 60_000);

  /**
   * 分岐 C を運任せにせず必ず踏む版。
   *
   * テスト A の C 分岐は実際のレースで引ける環境と引けない環境がある
   * （Windows では 15回中0回、Linux では数回に1回）。C の不変条件が
   * 環境次第で未検証になるのを避けるため、窓の位置を固定して同じ状態を作る。
   * 割り込みは**別接続**から行うので、単一接続の再入とは違う本物の競合になる。
   */
  it("C: evidence stored between the deadline decision and its resolution rolls back the refund and converges next sweep", () => {
    const ctx = setupFileDb();
    const { deadline, evidenceOperationId } = disputedPostStart(ctx, "pending");

    const sideDb = openDb(ctx.dbPath);
    const side = buildServices(sideDb, deadline - 1);
    const deadlineDb = openDb(ctx.dbPath);
    const deadlineServices = buildServices(deadlineDb, deadline);
    // T1 が「証拠なし」と判断した直後、T2 の返金が始まる前に別接続で証拠を確定させる
    const raced = new RankedDisputes(
      dbInterceptingDeadlineDecision(deadlineDb, () => {
        side.disputes.finalizeEvidenceStored({
          operationId: evidenceOperationId,
          privateChannelId: "private-channel",
          privateMessageId: "private-message",
        });
      }),
      deadlineServices.chips,
      deadlineServices.escrow,
      new PersistentTables(deadlineDb, new EventLog(deadlineDb), { openingPhase: () => deadlineServices.chipTx.openingPhase(), now: () => deadline }),
      deadlineServices.reservations,
      new EventLog(deadlineDb),
      { openingPhase: () => deadlineServices.chipTx.openingPhase(), now: () => deadline },
    );

    // 締切側は再判定で競合を検出し、自分の返金トランザクションごと巻き戻す
    expect(raced.processEvidenceDeadlines(deadline)).toEqual({ closed: 0, autoRefunded: 0, failed: 1 } satisfies DeadlineTally);

    const read = () => ({
      evidence: (ctx.db.prepare("SELECT storage_status AS s FROM casino_table_evidence WHERE operation_id=?").get(evidenceOperationId) as { s: string }).s,
      dispute: ctx.db.prepare("SELECT status, resolved_at AS resolvedAt FROM casino_table_disputes WHERE table_id='t1'").get() as { status: string; resolvedAt: number | null },
      table: (ctx.db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string }).state,
      escrowHeld: (ctx.db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount,
      refundGroups: (ctx.db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:evidence-timeout:%'").get() as { n: number }).n,
    });

    const mid = read();
    expect(mid.evidence).toBe("stored");
    expect(mid.dispute.status).toBe("collecting_evidence");
    expect(mid.dispute.resolvedAt).toBeNull();
    expect(mid.table).toBe("disputed");
    // 資金は1 Ld も動かない。返金グループも巻き戻っていて残っていない
    expect(mid.escrowHeld).toBe(10_000);
    expect(mid.refundGroups).toBe(0);

    // 次tick相当の掃引で裁定待ちへ収束する（本番 scheduler が次に呼ぶ経路）
    expect(deadlineServices.disputes.processEvidenceDeadlines(deadline)).toEqual({ closed: 1, autoRefunded: 0, failed: 0 } satisfies DeadlineTally);
    const converged = read();
    expect(converged.dispute.status).toBe("awaiting_arbitration");
    expect(converged.dispute.resolvedAt).toBeNull();
    expect(converged.table).toBe("disputed");
    expect(converged.escrowHeld).toBe(10_000);
    expect(converged.refundGroups).toBe(0);

    sideDb.close();
    deadlineDb.close();
    ctx.db.close();
  });

  it("A1: finalize commits first -> deadline closes to awaiting_arbitration and never refunds", async () => {
    const ctx = setupFileDb();
    const { deadline, evidenceOperationId } = disputedPostStart(ctx, "pending");
    ctx.db.close();

    // 順序は解放順で決める。先行プロセスの**完了を待ってから**後続を解放するので、
    // 壁時計の差分（+600ms）のように環境速度で入れ替わることがない。
    const finalizeRun = spawnRunner(ctx, "finalize", "finalize", evidenceOperationId, deadline - 1, deadline);
    const deadlineRunPromise = spawnRunner(ctx, "deadline", "deadline", "deadline:after-finalize", deadline - 1, deadline);
    await waitAllReady(ctx.barrierDir, ["finalize", "deadline"]);
    release(ctx.barrierDir, "finalize");
    const finalize = await finalizeRun;
    release(ctx.barrierDir, "deadline");
    const deadlineRun = await deadlineRunPromise;

    expect(finalize.ok).toBe(true);
    expect(deadlineRun.ok).toBe(true);
    expect(deadlineRun.result).toEqual({ closed: 1, autoRefunded: 0, failed: 0 });
    const db = openDb(ctx.dbPath);
    expect(db.prepare("SELECT storage_status FROM casino_table_evidence WHERE operation_id=?").get(evidenceOperationId)).toEqual({ storage_status: "stored" });
    expect(db.prepare("SELECT status, resolved_at FROM casino_table_disputes WHERE table_id='t1'").get()).toEqual({ status: "awaiting_arbitration", resolved_at: null });
    expect(db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get()).toEqual({ state: "disputed" });
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(10_000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:evidence-timeout:%'").get() as { n: number }).n).toBe(0);
    db.close();
  }, 60_000);

  it("A2: deadline commits first -> one refund and later finalize is rejected", async () => {
    const ctx = setupFileDb();
    const { deadline, evidenceOperationId } = disputedPostStart(ctx, "pending");
    ctx.db.close();

    const deadlineRunPromise = spawnRunner(ctx, "deadline", "deadline", "deadline:before-finalize", deadline - 1, deadline);
    const finalizeRun = spawnRunner(ctx, "finalize", "finalize", evidenceOperationId, deadline - 1, deadline);
    await waitAllReady(ctx.barrierDir, ["deadline", "finalize"]);
    release(ctx.barrierDir, "deadline");
    const deadlineRun = await deadlineRunPromise;
    release(ctx.barrierDir, "finalize");
    const finalize = await finalizeRun;

    expect(deadlineRun.ok).toBe(true);
    expect(deadlineRun.result).toEqual({ closed: 0, autoRefunded: 1, failed: 0 });
    expect(finalize.ok).toBe(false);
    const db = openDb(ctx.dbPath);
    expect(db.prepare("SELECT storage_status FROM casino_table_evidence WHERE operation_id=?").get(evidenceOperationId)).toEqual({ storage_status: "pending" });
    const dispute = db.prepare("SELECT status, resolved_at AS resolvedAt, resolution_kind AS resolutionKind FROM casino_table_disputes WHERE table_id='t1'").get() as { status: string; resolvedAt: number | null; resolutionKind: string | null };
    expect(dispute.status).toBe("insufficient_evidence");
    expect(dispute.resolutionKind).toBe("insufficient_evidence");
    expect(dispute.resolvedAt).not.toBeNull();
    expect(db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get()).toEqual({ state: "cancelled" });
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key LIKE 'ranked:dispute:t1:evidence-timeout:%'").get() as { n: number }).n).toBe(1);
    db.close();
  }, 60_000);

  it("B: two manual arbitrations have one winner and move/release/refund/history exactly once", async () => {
    const ctx = setupFileDb();
    disputedPostStart(ctx, "stored");
    ctx.disputes.assignArbitrator({ tableId: "t1", arbitratorId: "judge", assignedBy: "owner", operationId: "assign:judge" });
    const beforeSum = chipSum(ctx.db);
    ctx.db.close();

    const one = spawnRunner(ctx, "arb-one", "ranked_result", "arb:one", 1_700_000_100, 1_700_259_200);
    const two = spawnRunner(ctx, "arb-two", "ranked_result", "arb:two", 1_700_000_100, 1_700_259_200);
    await waitAllReady(ctx.barrierDir, ["arb-one", "arb-two"]);
    release(ctx.barrierDir, "arb-one", "arb-two");
    const results = await Promise.all([one, two]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const db = openDb(ctx.dbPath);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_table_disputes WHERE table_id='t1' AND resolved_at IS NOT NULL").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT state FROM casino_tables WHERE table_id='t1'").get() as { state: string }).state).toBe("settled");
    expect((db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(escrowHolderFor("t1")) as { amount: number }).amount).toBe(0);
    expect(db.prepare("SELECT * FROM casino_escrow WHERE session_id='t1'").all()).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx_groups WHERE group_key IN ('ranked:dispute:t1:arb:one','ranked:dispute:t1:arb:two')").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_tx WHERE session_id='t1' AND reason='ranked table fault fee refund'").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM casino_ranked_match_history WHERE table_id='t1'").get() as { n: number }).n).toBe(1);
    expect(db.prepare("SELECT * FROM casino_house_reservations WHERE key=?").get(rankedFeeReservationKey("t1"))).toBeUndefined();
    expect(chipSum(db)).toBe(beforeSum);
    db.close();
  }, 60_000);
});
