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
const { retryPendingFollowUps, convergePendingRenders } = await import("../src/commands/confession.js");

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

/**
 * **投稿者に見えている1通の収束を、プロセスをまたいで確かめる。**
 *
 * 同じ service が自分の行を回収するだけでは「所有者が死んだ」ことの証拠にならない。
 * ここでは実ファイルDBを開き直し、instance A が収束を握ったまま消え、貸出が切れ、
 * instance B が引き取って**同じメッセージ**を直すまでを通す。
 */
describe("収束は、プロセスをまたいでも同じ1通へ向かう", () => {
  const DM_CH = "dm-channel";
  const MSG = "dm-msg-0";

  /** 投稿者へ届いた1通を編集できるだけの、最小の Discord。何通送られたかも数える */
  function dmWorld() {
    const message = {
      embeds: [{ toJSON: () => ({ description: "届いている本文" }) }] as unknown[],
      edited: [] as unknown[],
      edit: async (o: unknown) => {
        message.edited.push(o);
        return o;
      },
    };
    const newDms: unknown[] = [];
    const client = {
      channels: {
        fetch: async (cid: string) =>
          cid === DM_CH
            ? { id: DM_CH, isTextBased: () => true, messages: { fetch: async () => message } }
            : { isThread: () => true, archived: false, send: async () => undefined,
                messages: { fetch: async () => null }, setArchived: async () => undefined },
      },
      users: {
        fetch: async () => ({ send: async (o: unknown) => void newDms.push(o) }),
      },
    };
    return { client, message, newDms };
  }

  /**
   * 置き換わった試行（superseded）が残した収束義務を作る。
   * 会話は動いていないが、届いた1通は直しに行かなければならない。
   */
  function seedSupersededRender(ctx: ReturnType<typeof boot>) {
    const row = ctx.confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    ctx.confessions.claim(row.id, "thread-1", "staff-1");
    const draft = ctx.confessions.createReplyDraft(row.id, "staff-1", "届いている本文", 90);
    ctx.confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    const stale = ctx.confessions.getReplyDraft(draft.id)!.generation;
    // 回収されて、別の試行が現役になる
    ctx.confessions.recoverOrphanedEffects("system:startup", Math.floor(Date.now() / 1000) + 100000);
    ctx.confessions.claimReplyDraftManualRetry(row.id, draft.id, "staff-2");
    const result = ctx.confessions.finalizeStaffReply({
      draftId: draft.id,
      generation: stale,
      intent: "wait",
      actorId: "staff-1",
      renderTarget: { channelId: DM_CH, messageId: MSG },
    });
    expect(result.transition).toBe("superseded");
    return { confessionId: row.id, render: ctx.confessions.listPendingRenders()[0]! };
  }

  /** 返信が届いて「返答待ち」で確定した直後の状態（収束はまだ）を作る */
  function seedPendingRender(ctx: ReturnType<typeof boot>) {
    const row = ctx.confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    ctx.confessions.claim(row.id, "thread-1", "staff-1");
    const draft = ctx.confessions.createReplyDraft(row.id, "staff-1", "届いている本文", 90);
    ctx.confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    ctx.confessions.finalizeStaffReply({
      draftId: draft.id,
      generation: ctx.confessions.getReplyDraft(draft.id)!.generation,
      intent: "wait",
      actorId: "staff-1",
      renderTarget: { channelId: DM_CH, messageId: MSG },
    });
    return { confessionId: row.id, render: ctx.confessions.listPendingRenders()[0]! };
  }

  it("A が収束を握ったまま消えても、B が同じメッセージを直しきる", async () => {
    // ── instance A ──
    const a = boot("instance-A");
    const { confessionId, render } = seedPendingRender(a);
    const claimedByA = a.confessions.claimRender(render.id)!;
    expect(claimedByA.owner_instance).toBe("instance-A");
    expect(a.confessions.listStalledRenders()).toHaveLength(1);

    // ── A が消える。貸出が切れるまでは、誰も奪わない ──
    const b = boot("instance-B");
    expect(b.confessions.recoverOrphanedEffects("system:startup").renders).toBe(0);
    expect(b.confessions.listStalledRenders()).toHaveLength(1);

    killPreviousInstances(b.db, "instance-B");
    expect(b.confessions.recoverOrphanedEffects("system:startup").renders).toBe(1);

    // ── B が引き取って収束させる ──
    const world = dmWorld();
    expect(await convergePendingRenders(world.client as never, b.services)).toBe(1);
    expect(world.newDms).toEqual([]); // **新しい DM は1通も出ない**
    expect(world.message.edited).toHaveLength(1);
    expect(JSON.stringify(world.message.edited)).toContain("必要なら追記できます");
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
  });

  // R38
  it("A の古い callback は、B が引き取った実行を書き換えない", async () => {
    const a = boot("instance-A");
    const { confessionId, render } = seedPendingRender(a);
    const claimedByA = a.confessions.claimRender(render.id)!;

    const b = boot("instance-B");
    killPreviousInstances(b.db, "instance-B");
    b.confessions.recoverOrphanedEffects("system:startup");
    const claimedByB = b.confessions.claimRender(render.id)!;
    expect(claimedByB.generation).toBeGreaterThan(claimedByA.generation);

    // ここで A の renderer がようやく帰ってくる
    const stale = a.confessions.settleRender({
      renderId: render.id,
      generation: claimedByA.generation,
      state: "settled",
    });
    expect(stale.won).toBe(false);
    expect(b.confessions.pendingRendersFor(confessionId)[0]!.state).toBe("rendering");
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(1);

    // 現役の B だけが決着できる
    const live = b.confessions.settleRender({
      renderId: render.id,
      generation: claimedByB.generation,
      state: "settled",
    });
    expect(live.won).toBe(true);
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
  });

  it("行き違った1通も、プロセスをまたいで同じメッセージへ収束する", async () => {
    // ── A が superseded の義務を積んだところで消える ──
    const a = boot("instance-A");
    const { confessionId, render } = seedSupersededRender(a);
    expect(render.render_kind).toBe("superseded");
    a.confessions.claimRender(render.id);

    // ── 再起動 ──
    const b = boot("instance-B");
    killPreviousInstances(b.db, "instance-B");
    expect(b.confessions.recoverOrphanedEffects("system:startup").renders).toBe(1);

    const world = dmWorld();
    expect(await convergePendingRenders(world.client as never, b.services)).toBe(1);
    expect(world.newDms).toEqual([]); // 新しい DM は出ない
    const edited = JSON.stringify(world.message.edited);
    expect(edited).toContain("送信処理が別の試行と行き違いました");
    // 会話の状態は推測しない
    expect(edited).not.toContain("自動で終了します");
    expect(edited).not.toContain("このやり取りはここで終了しました");
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
    // 会話そのものは、この試行では動いていない
    expect(b.confessions.get(confessionId)!.status).not.toBe("closed");
  });

  it("A が生きているうちは、B は収束を奪わない", () => {
    const a = boot("instance-A");
    const { confessionId, render } = seedPendingRender(a);
    a.confessions.claimRender(render.id);

    const b = boot("instance-B");
    a.confessions.heartbeatInstance("instance-A"); // A はまだ鼓動を打っている
    expect(b.confessions.recoverOrphanedEffects("system:startup").renders).toBe(0);
    expect(b.confessions.claimRender(render.id)).toBeUndefined();
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(1);
  });
});
