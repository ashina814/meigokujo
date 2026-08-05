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

describe("OpeningExecutionStore.transition", () => {
  function acquired() {
    const ctx = setup();
    const { execution } = ctx.store.acquire("hash1", "admin", CONFIG);
    return { ...ctx, id: execution.id };
  }

  it("正常系: planned から completed まで順に遷移できる", () => {
    const { store, id } = acquired();
    store.transition(id, "opening_reset_acquired");
    store.transition(id, "backup_started");
    const afterBackup = store.transition(id, "backup_verified", {
      backupManifest: { backupFormatVersion: 1 } as never,
    });
    expect(afterBackup.backupManifest).toEqual({ backupFormatVersion: 1 });
    store.transition(id, "external_started");
    store.transition(id, "external_completed");
    store.transition(id, "applying");
    const applied = store.transition(id, "applied", {
      oldSettlementLandTxId: 10,
      newInvestmentLandTxId: 11,
      openingVersion: "opening_v1",
    });
    expect(applied.fundsApplied).toBe(true);
    expect(applied.reapplyAllowed).toBe(false);
    expect(applied.appliedAt).not.toBeNull();
    store.transition(id, "post_commit_pending");
    const completed = store.transition(id, "completed");
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).not.toBeNull();
  });

  it("未許可の遷移(planned→applied)はOpeningExecutionTransitionError", () => {
    const { store, id } = acquired();
    expect(() => store.transition(id, "applied")).toThrow(OpeningExecutionTransitionError);
  });

  it("後戻り(applied→planned)はOpeningExecutionTransitionError", () => {
    const { store, id } = acquired();
    for (const s of ["opening_reset_acquired", "backup_started", "backup_verified", "external_started", "external_completed", "applying", "applied"] as const) {
      store.transition(id, s);
    }
    expect(() => store.transition(id, "planned")).toThrow(OpeningExecutionTransitionError);
  });

  it("applying→failed はfundsApplied=falseのままで、opening_reset_acquiredへ再挑戦できる（COMMIT前失敗の安全な再試行）", () => {
    const { store, id } = acquired();
    for (const s of ["opening_reset_acquired", "backup_started", "backup_verified", "external_started", "external_completed", "applying"] as const) {
      store.transition(id, s);
    }
    const failed = store.markFailed(id, "applying", "SQLITE_BUSY: シミュレートしたクラッシュ");
    expect(failed.fundsApplied).toBe(false);
    expect(failed.failureStage).toBe("applying");
    const retried = store.transition(id, "opening_reset_acquired");
    expect(retried.status).toBe("opening_reset_acquired");
  });

  it("fundsApplied=true の行は failed→opening_reset_acquired を（データ破損等で不正にfailedへ来ても）拒否する", () => {
    const { store, db, id } = acquired();
    for (const s of ["opening_reset_acquired", "backup_started", "backup_verified", "external_started", "external_completed", "applying", "applied"] as const) {
      store.transition(id, s);
    }
    // 通常のtransition()経由ではapplied後にfailedへ行けない（FSM表に無い）。
    // 「資金確定後に何らかの理由でfailed行が存在した」という破損シナリオを直接fixtureで作り、
    // それでも再申請を拒否できることを確認する（二重の防御）。
    db.prepare("UPDATE casino_opening_executions SET status='failed' WHERE id=?").run(id);
    expect(() => store.transition(id, "opening_reset_acquired")).toThrow(OpeningExecutionTransitionError);
  });

  it("applied以降はmanual_review_requiredへ倒れ、manualReopenRequiredが立つ", () => {
    const { store, id } = acquired();
    for (const s of ["opening_reset_acquired", "backup_started", "backup_verified", "external_started", "external_completed", "applying", "applied"] as const) {
      store.transition(id, s);
    }
    const review = store.transition(id, "manual_review_required", { manualReviewReason: "notifier送信失敗" });
    expect(review.manualReopenRequired).toBe(true);
    expect(review.fundsApplied).toBe(true);
    expect(review.reapplyAllowed).toBe(false);
    const completed = store.transition(id, "completed");
    expect(completed.status).toBe("completed");
  });

  it("存在しないexecution idへの遷移はエラー", () => {
    const { store } = setup();
    expect(() => store.transition("opening-reset:does-not-exist", "backup_started")).toThrow();
  });

  it("completedは終端で、いかなる遷移も拒否する", () => {
    const { store, id } = acquired();
    for (const s of ["opening_reset_acquired", "backup_started", "backup_verified", "external_started", "external_completed", "applying", "applied", "post_commit_pending", "completed"] as const) {
      store.transition(id, s);
    }
    expect(store.canTransition("completed", "planned")).toBe(false);
    expect(store.canTransition("completed", "failed")).toBe(false);
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
});
