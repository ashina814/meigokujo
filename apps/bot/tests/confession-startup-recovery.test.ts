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

const { armConfessionStartupRecovery, awaitConfessionReady, __setConfessionBarrierForTest } = await import(
  "../src/confession-startup.js"
);
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
  __setConfessionBarrierForTest(null);
  for (const h of handles.splice(0)) h.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows ではテスト後の一時ファイル削除が失敗しうる。結果とは無関係 */
  }
});

function boot() {
  const db = openDb(dbPath);
  handles.push(db);
  const events = new EventLog(db);
  const confessions = new Confessions(db, events);
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
    armConfessionStartupRecovery(after.services);

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
