import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Confessions, EventLog, openDb } from "@meigokujo/core";
import type { Services } from "../src/services.js";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));
vi.mock("../src/church-roles.js", () => ({
  isChurchManager: () => false,
  isChurchConsult: () => false,
  notifyRoleIdsForDisposition: () => [],
  notifyRoleIdsForType: () => [],
  getRoleIds: () => [],
  roleMention: () => ({ content: undefined, roleIds: [] }),
}));

const {
  armConfessionStartupRecovery,
  awaitConfessionReady,
  startConfessionHeartbeat,
  stopConfessionHeartbeat,
  __setConfessionBarrierForTest,
} = await import("../src/confession-startup.js");
const { retryPendingFollowUps } = await import("../src/commands/confession.js");

/**
 * **前のプロセスが残した「送信中」を、新しいプロセスが追い越さない。**
 *
 * durable な所有権を入れた以上、落ちたときの置き土産（送信中の受領確認・消費済みの
 * 下書き・中継中の追記）を誰かが回収しないと、その案件だけが永久に詰まる。
 * ここでは **DBを開き直して「プロセスが消えた」を作り**、回収が外部送信より先に
 * 走ることを確かめる。時間待ちは使わない。
 */

let tmpDir: string;
let dbPath: string;
const handles: { close: () => void }[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "confession-startup-"));
  dbPath = join(tmpDir, "bot.db");
  __setConfessionBarrierForTest(null);
});

afterEach(() => {
  stopConfessionHeartbeat();
  __setConfessionBarrierForTest(null);
  for (const h of handles.splice(0)) h.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows ではテスト後の一時ファイル削除が失敗しうる。結果とは無関係 */
  }
});

/**
 * 前のプロセスが「もういない」状態を作る。
 *
 * 起動時回収は**鼓動が途切れた所有者の行だけ**を回収するので、単に DB を開き直しても
 * それだけでは回収されない（生きているかもしれない相手を奪わないのが正しい）。
 * 実際の再起動と同じく、貸出期限を過ぎさせてから見る。
 */
function killPreviousInstances(db: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } }, keep: string) {
  db.prepare("UPDATE confession_instances SET heartbeat_at=0 WHERE instance_id<>?").run(keep);
}

function boot(instanceId?: string) {
  const db = openDb(dbPath);
  handles.push(db);
  const events = new EventLog(db);
  const confessions = new Confessions(db, events, instanceId);
  const services = {
    db,
    events,
    confessions,
    settings: { getNumber: () => 90, getString: () => undefined },
  } as unknown as Services;
  return { db, confessions, services };
}

describe("起動時の回収は、外部送信より先に走る", () => {
  it("前プロセスの「送信中」を unknown へ回収し、詰まりを解く", async () => {
    // ── 前のプロセス ──
    const before = boot();
    const row = before.confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    before.confessions.claim(row.id, "thread-1", "staff-1");
    const begun = before.confessions.beginAcknowledgement(row.id, "staff-1");
    expect(begun.ok).toBe(true);
    const draft = before.confessions.createReplyDraft(row.id, "staff-1", "送信中の返信", 90);
    before.confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    const follow = before.confessions.recordSenderFollowUp(row.id, "sender-1", "送信中の追記", 90) as {
      ok: true;
      followUpId: number;
    };
    before.confessions.claimFollowUpRelay(follow.followUpId);

    // ── ここでプロセスが消える（DBを開き直す）──
    const after = boot();
    expect(after.confessions.ackState(row.id)).toBe("in_flight");
    killPreviousInstances(after.db, after.confessions.instance);

    armConfessionStartupRecovery(after.services);
    // 回収は関門の裏で走る。外部へ触る前に必ずここを通るので、テストも同じ順で待つ
    await awaitConfessionReady();

    expect(after.confessions.ackState(row.id)).toBe("unknown");
    expect(after.confessions.get(row.id)!.acknowledged_at).toBeNull();
    expect(after.confessions.getReplyDraft(draft.id)!.outcome).toBe("unknown");
    expect(after.confessions.getReplyDraft(draft.id)!.body).toBe("送信中の返信");
    expect(after.confessions.getFollowUp(follow.followUpId)!.outcome).toBe("unknown");
    expect(after.confessions.getFollowUp(follow.followUpId)!.body).toBe("送信中の追記");
    // 詰まりが解けて、あらためて送れる（自動再送ではなく、担当者の操作で）
    expect(after.confessions.beginAcknowledgement(row.id, "staff-1").ok).toBe(true);
  });

  it("回収し終えるまで外部送信は始まらない", async () => {
    const ctx = boot();
    let recovered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    __setConfessionBarrierForTest(
      gate.then(() => {
        recovered = true;
      }),
    );

    const waiting = awaitConfessionReady().then(() => recovered);
    // 回収が済むまで通らない
    release();
    expect(await waiting).toBe(true);
    void ctx;
  });

  it("回収に失敗しても関門は開く（Bot 全体を止めない）", async () => {
    __setConfessionBarrierForTest(null);
    const failing = {
      confessions: {
        recoverOrphanedEffects: () => {
          throw new Error("回収に失敗");
        },
      },
    } as unknown as Services;
    armConfessionStartupRecovery(failing);
    await expect(awaitConfessionReady()).resolves.toBeUndefined();
  });

  it("回収後、自動中継は unknown を拾わない（重複を作らない）", async () => {
    const before = boot();
    const row = before.confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    before.confessions.claim(row.id, "thread-1", "staff-1");
    const follow = before.confessions.recordSenderFollowUp(row.id, "sender-1", "中継中だった追記", 90) as {
      ok: true;
      followUpId: number;
    };
    before.confessions.claimFollowUpRelay(follow.followUpId);

    const after = boot();
    killPreviousInstances(after.db, after.confessions.instance);
    armConfessionStartupRecovery(after.services);
    await awaitConfessionReady();

    const posted: unknown[] = [];
    const client = {
      channels: {
        fetch: async () => ({ isThread: () => true, send: async (o: unknown) => void posted.push(o) }),
      },
      users: { fetch: async () => ({ send: async () => undefined }) },
    };
    expect(await retryPendingFollowUps(client as never, after.services)).toBe(0);
    expect(posted).toEqual([]);
    // 担当者の判断待ちとして残る
    expect(after.confessions.listFollowUpsNeedingDecision(row.id)).toHaveLength(1);
  });
});

describe("生存の記録は、刻時盤の長い周回に巻き込まれない", () => {
  /**
   * **鼓動が止まると、生きているプロセスが「死んだ所有者」に見える。**
   *
   * 刻時盤は1周が長く、しかも前の周が終わるまで次が始まらない。鼓動をその列に混ぜると、
   * 鼓動より前の無関係な処理が貸出期限より長く詰まっただけで、別インスタンスが
   * 実行中の送信を奪えてしまう。だから鼓動は独立した間隔で打つ。
   */
  it("刻時盤の周回が終わらなくても、貸出は更新され続ける", () => {
    const ctx = boot();
    const id = ctx.confessions.instance;

    // 刻時盤の周回が終わらない状況（この Promise は最後まで解決しない）
    let tickSettled = false;
    let releaseTick!: () => void;
    const stalledTick = new Promise<void>((resolve) => {
      releaseTick = resolve;
    }).then(() => {
      tickSettled = true;
    });

    vi.useFakeTimers();
    try {
      startConfessionHeartbeat(ctx.services);
      // ここから先、誰も明示的には鼓動を打たない
      ctx.db.prepare("UPDATE confession_instances SET heartbeat_at=0 WHERE instance_id=?").run(id);
      expect(ctx.confessions.liveInstances()).not.toContain(id);

      // 刻時盤は止まったまま。時間だけが進む
      vi.advanceTimersByTime(30_000);
      expect(tickSettled).toBe(false);
      // それでも生きていると分かる＝この実行は奪われない
      expect(ctx.confessions.liveInstances()).toContain(id);

      // さらに周回しても打ち続ける
      ctx.db.prepare("UPDATE confession_instances SET heartbeat_at=0 WHERE instance_id=?").run(id);
      vi.advanceTimersByTime(30_000);
      expect(ctx.confessions.liveInstances()).toContain(id);
    } finally {
      stopConfessionHeartbeat();
      vi.useRealTimers();
      releaseTick();
      void stalledTick;
    }
  });

  it("止めれば、貸出は期限どおり切れる（回収できなくならない）", () => {
    const ctx = boot();
    const id = ctx.confessions.instance;
    vi.useFakeTimers();
    try {
      startConfessionHeartbeat(ctx.services);
      stopConfessionHeartbeat();
      ctx.db.prepare("UPDATE confession_instances SET heartbeat_at=0 WHERE instance_id=?").run(id);
      vi.advanceTimersByTime(120_000);
      // 打ち手がいない以上、更新されない
      expect(ctx.confessions.liveInstances()).not.toContain(id);
    } finally {
      vi.useRealTimers();
    }
  });
});
