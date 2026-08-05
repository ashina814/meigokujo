import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import {
  OpeningExecutionConflictError,
  OpeningExecutionStore,
  OpeningExecutionTransitionError,
} from "../src/casino/opening-execution.js";
import type { CasinoOpeningConfig } from "../src/casino/opening-settings.js";

const CONFIG: CasinoOpeningConfig = {
  configured: true,
  openingCapital: 50_000,
  openingHouse: 40_000,
  openingJackpot: 8_000,
  openingRelief: 2_000,
  minWorkingCapital: 5_000,
  remitRateBps: 0,
};

function setup() {
  const db = openDb(":memory:");
  return { db, store: new OpeningExecutionStore(db) };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpeningExecutionStore.acquire", () => {
  it("初回は acquired:true で planned 状態の行を作る", () => {
    const { store } = setup();
    const result = store.acquire("hash1", "admin", CONFIG);
    expect(result.acquired).toBe(true);
    expect(result.execution.status).toBe("planned");
    expect(result.execution.planHash).toBe("hash1");
    expect(result.execution.fundsApplied).toBe(false);
    expect(result.execution.reapplyAllowed).toBe(true);
  });

  it("同じplanHash・同じconfigurationの再呼び出しは acquired:false で同じ行を返す（資金は動かない）", () => {
    const { store } = setup();
    const first = store.acquire("hash1", "admin", CONFIG);
    const second = store.acquire("hash1", "admin", CONFIG);
    expect(second.acquired).toBe(false);
    expect(second.execution.id).toBe(first.execution.id);
  });

  it("同じplanHash・別configurationはOpeningExecutionConflictErrorを投げる", () => {
    const { store } = setup();
    store.acquire("hash1", "admin", CONFIG);
    expect(() => store.acquire("hash1", "admin", { ...CONFIG, openingCapital: 999 })).toThrow(
      OpeningExecutionConflictError,
    );
  });

  it("異なるplanHashは独立したexecutionを作る", () => {
    const { store } = setup();
    const a = store.acquire("hash-a", "admin", CONFIG);
    const b = store.acquire("hash-b", "admin", CONFIG);
    expect(a.execution.id).not.toBe(b.execution.id);
  });
});

/** 経路に沿って順に遷移させるヘルパー。各呼び出しでCASのfromStatusを明示する */
const PATH: readonly ["planned" | "opening_reset_acquired" | "backup_started" | "backup_verified" | "external_started" | "external_completed" | "applying" | "applied" | "post_commit_pending", "opening_reset_acquired" | "backup_started" | "backup_verified" | "external_started" | "external_completed" | "applying" | "applied" | "post_commit_pending" | "completed"][] = [
  ["planned", "opening_reset_acquired"],
  ["opening_reset_acquired", "backup_started"],
  ["backup_started", "backup_verified"],
  ["backup_verified", "external_started"],
  ["external_started", "external_completed"],
  ["external_completed", "applying"],
  ["applying", "applied"],
  ["applied", "post_commit_pending"],
  ["post_commit_pending", "completed"],
];

function driveTo(store: OpeningExecutionStore, id: string, target: string): void {
  for (const [from, to] of PATH) {
    if (from === "planned" && target === "planned") return;
    store.transition(id, from, to);
    if (to === target) return;
  }
}

describe("OpeningExecutionStore.transition — CAS", () => {
  function acquired() {
    const ctx = setup();
    const { execution } = ctx.store.acquire("hash1", "admin", CONFIG);
    return { ...ctx, id: execution.id };
  }

  it("正常系: planned から completed まで順に遷移でき、各呼び出しでapplied:trueとchanges===1相当が確認できる", () => {
    const { store, id } = acquired();
    const r1 = store.transition(id, "planned", "opening_reset_acquired");
    expect(r1.applied).toBe(true);
    store.transition(id, "opening_reset_acquired", "backup_started");
    const afterBackup = store.transition(id, "backup_started", "backup_verified", {
      backupManifest: { backupFormatVersion: 1 } as never,
    });
    expect(afterBackup.applied).toBe(true);
    expect(afterBackup.execution.backupManifest).toEqual({ backupFormatVersion: 1 });
    store.transition(id, "backup_verified", "external_started");
    store.transition(id, "external_started", "external_completed");
    store.transition(id, "external_completed", "applying");
    const applied = store.transition(id, "applying", "applied", {
      oldSettlementLandTxId: 10,
      newInvestmentLandTxId: 11,
      openingVersion: "opening_v1",
    });
    expect(applied.applied).toBe(true);
    expect(applied.execution.fundsApplied).toBe(true);
    expect(applied.execution.reapplyAllowed).toBe(false);
    expect(applied.execution.appliedAt).not.toBeNull();
    store.transition(id, "applied", "post_commit_pending");
    const completed = store.transition(id, "post_commit_pending", "completed");
    expect(completed.execution.status).toBe("completed");
    expect(completed.execution.completedAt).not.toBeNull();
  });

  it("未許可の遷移(fromStatus=planned, to=applied)はFSM違反として即座にOpeningExecutionTransitionError", () => {
    const { store, id } = acquired();
    expect(() => store.transition(id, "planned", "applied")).toThrow(OpeningExecutionTransitionError);
  });

  it("fromStatusが実際のDB状態と食い違う場合(CAS不一致)は例外を投げず applied:false を返し、行を書き換えない", () => {
    const { store, id } = acquired();
    store.transition(id, "planned", "opening_reset_acquired");
    // 実際は opening_reset_acquired なのに、古い状態(planned)を信じて遷移しようとする
    // （="別プロセスが既に先へ進めていた"を模擬）。FSM上 planned->backup_started は無効な遷移
    // ではなく到達不能なだけなので、CAS不一致(changes=0)として静かに現在の行を返す。
    const result = store.transition(id, "opening_reset_acquired", "backup_started");
    expect(result.applied).toBe(true); // まずは正常に進める
    // 同じfromStatusで二度目を叩く(既に進んでしまった後)＝CAS不一致
    const stale = store.transition(id, "opening_reset_acquired", "backup_started");
    expect(stale.applied).toBe(false);
    expect(stale.execution.status).toBe("backup_started"); // 実際の状態がそのまま返る
  });

  it("後戻り(applied→planned)はFSM上そもそも許されないtransitionとして例外", () => {
    const { store, id } = acquired();
    driveTo(store, id, "applied");
    expect(() => store.transition(id, "applied", "planned")).toThrow(OpeningExecutionTransitionError);
  });

  it("applying→failed はfundsApplied=falseのままで、opening_reset_acquiredへ再挑戦できる（COMMIT前失敗の安全な再試行）", () => {
    const { store, id } = acquired();
    driveTo(store, id, "applying");
    const failed = store.markFailed(id, "applying", "applying", "SQLITE_BUSY: シミュレートしたクラッシュ");
    expect(failed.applied).toBe(true);
    expect(failed.execution.fundsApplied).toBe(false);
    expect(failed.execution.failureStage).toBe("applying");
    const retried = store.transition(id, "failed", "opening_reset_acquired");
    expect(retried.execution.status).toBe("opening_reset_acquired");
  });

  it("fundsApplied=true の行は failed→opening_reset_acquired を（データ破損等で不正にfailedへ来ても）拒否する", () => {
    const { store, db, id } = acquired();
    driveTo(store, id, "applied");
    // 通常のtransition()経由ではapplied後にfailedへ行けない（FSM表に無い）。
    // 「資金確定後に何らかの理由でfailed行が存在した」という破損シナリオを直接fixtureで作り、
    // それでも再申請を拒否できることを確認する（二重の防御）。
    db.prepare("UPDATE casino_opening_executions SET status='failed' WHERE id=?").run(id);
    expect(() => store.transition(id, "failed", "opening_reset_acquired")).toThrow(OpeningExecutionTransitionError);
  });

  it("applied以降はmanual_review_requiredへ倒れ、manualReopenRequiredが立つ", () => {
    const { store, id } = acquired();
    driveTo(store, id, "applied");
    const review = store.transition(id, "applied", "manual_review_required", { manualReviewReason: "notifier送信失敗" });
    expect(review.execution.manualReopenRequired).toBe(true);
    expect(review.execution.fundsApplied).toBe(true);
    expect(review.execution.reapplyAllowed).toBe(false);
    const completed = store.transition(id, "manual_review_required", "completed");
    expect(completed.execution.status).toBe("completed");
  });

  it("存在しないexecution idへの遷移はエラー", () => {
    const { store } = setup();
    expect(() => store.transition("opening-reset:does-not-exist", "planned", "opening_reset_acquired")).toThrow();
  });

  it("completedは終端で、いかなる遷移も拒否する", () => {
    const { store, id } = acquired();
    driveTo(store, id, "completed");
    expect(store.canTransition("completed", "planned")).toBe(false);
    expect(store.canTransition("completed", "failed")).toBe(false);
  });

  it("勝者がCOMMITした後、敗者(古いfromStatusを持つ側)の再試行は勝者の状態・資金確定を一切変更しない", () => {
    const { store, id } = acquired();
    driveTo(store, id, "applied"); // 勝者が最後まで進めて資金確定
    const before = store.get(id)!;

    // 敗者: 自分が最後に見ていた古い状態(例えば"external_completed")を信じて、
    // 失敗として報告しようとする(実際にはとうに追い越されている)
    const loserAttempt = store.markFailed(id, "external_completed", "external", "敗者による古い失敗報告");
    expect(loserAttempt.applied).toBe(false); // CAS不一致で何も書き換えていない
    expect(loserAttempt.execution.status).toBe(before.status); // 勝者の状態がそのまま
    expect(loserAttempt.execution.fundsApplied).toBe(before.fundsApplied);
    expect(loserAttempt.execution.failureStage).toBeNull(); // 敗者の失敗理由は書き込まれていない

    const after = store.get(id)!;
    expect(after).toEqual(before);
  });
});

describe("OpeningExecutionStore — 同時実行", () => {
  it("同一plan hashの同時acquireは片方だけが処理権を取得する（別接続・同一ファイルDB）", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-exec-race-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "race.sqlite");
    const db1 = openDb(dbPath);
    const store1 = new OpeningExecutionStore(db1);
    const db2 = openDb(dbPath);
    const store2 = new OpeningExecutionStore(db2);

    const r1 = store1.acquire("race-hash", "admin", CONFIG);
    const r2 = store2.acquire("race-hash", "admin", CONFIG);

    const acquiredCount = [r1.acquired, r2.acquired].filter(Boolean).length;
    expect(acquiredCount).toBe(1);
    expect(r1.execution.id).toBe(r2.execution.id);

    db1.close();
    db2.close();
  });

  it("別接続からの同時transitionでも、片方だけがapplied:trueになりchangesは常に0か1", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr12-exec-transition-race-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "race.sqlite");
    const db1 = openDb(dbPath);
    const store1 = new OpeningExecutionStore(db1);
    const db2 = openDb(dbPath);
    const store2 = new OpeningExecutionStore(db2);

    const { execution } = store1.acquire("race-hash-2", "admin", CONFIG);

    const r1 = store1.transition(execution.id, "planned", "opening_reset_acquired");
    const r2 = store2.transition(execution.id, "planned", "opening_reset_acquired");

    const appliedCount = [r1.applied, r2.applied].filter(Boolean).length;
    expect(appliedCount).toBe(1);
    // 両方とも最終的に同じ状態を指している(敗者も最新行を読める)
    expect(r1.execution.status).toBe("opening_reset_acquired");
    expect(r2.execution.status).toBe("opening_reset_acquired");

    db1.close();
    db2.close();
  });
});

describe("OpeningExecutionStore — 未知statusのfail-closed", () => {
  it("DBのCHECK制約により、statusカラムへ未知の値を直接書き込むことはできない", () => {
    const { db, store } = setup();
    const { execution } = store.acquire("hash-unknown", "admin", CONFIG);
    expect(() => {
      db.prepare("UPDATE casino_opening_executions SET status = ? WHERE id = ?").run("totally_unknown_status", execution.id);
    }).toThrow(/CHECK constraint failed/);
  });
});
