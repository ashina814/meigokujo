import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFESSION_INSTANCE_LEASE_SECONDS, Confessions, EventLog, openDb } from "@meigokujo/core";
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
/**
 * 投稿者へ届いた1通を編集できるだけの、最小の Discord（プロセスをまたぐ収束の検証で共有する）。
 */
const DM_CH = "dm-channel";
const MSG = "dm-msg-0";

/**
 * 投稿者へ届いた1通を編集できるだけの、最小の Discord。
 *
 * **編集を境界で止められる。** DB の門は決着を守るが、Discord への編集は門より前に
 * 起きる——その順序を実際に作らないと、古い実行が最後に着地する競合は再現できない。
 * 何通「新しく」送られたかも数える（修復は編集であって、新しい DM ではない）。
 */
function dmWorld() {
  type Gate = { entered: () => void; wait: Promise<void> };
  const editGates: Gate[] = [];
  /** いま投稿者に見えている内容（最後の編集） */
  let current: any = { embeds: [{ toJSON: () => ({ description: "届いている本文" }) }] };
  const message = {
    get embeds() {
      return (current.embeds ?? []) as unknown[];
    },
    edited: [] as any[],
    edit: async (o: any) => {
      const gate = editGates.shift();
      if (gate) {
        gate.entered();
        await gate.wait;
      }
      // 結末は**関門を抜けたあと**に決める（止めている間に呼び出し側が決められる）
      const fail = pendingFailure;
      pendingFailure = null;
      if (fail === "api") throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      if (fail === "net") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      message.edited.push(o);
      current = o;
      return o;
    },
  };
  /**
   * 次の1回の編集の結末を決める。
   * `api` = Discord の確定拒否（外は変わっていない）、`net` = 応答が得られなかった。
   */
  let pendingFailure: "api" | "net" | null = null;
  const failNext = (mode: "api" | "net") => {
    pendingFailure = mode;
  };
  /** 次の1回の編集を止める */
  const holdEdit = () => {
    let release!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    editGates.push({ entered: signalEntered, wait });
    return { entered, release: () => release() };
  };
  /** いま投稿者に見えている文面（本文＋添えられた案内） */
  const visibleText = (): string => {
    const e = current.embeds?.[0];
    const j = e?.toJSON ? e.toJSON() : e;
    return [j?.description ?? "", ...(j?.fields ?? []).map((f: any) => f.value)].join("\n");
  };
  const visibleButtons = (): unknown[] => current.components ?? [];
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
  return { client, message, newDms, holdEdit, failNext, visibleText, visibleButtons };
}

describe("収束は、プロセスをまたいでも同じ1通へ向かう", () => {

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

/**
 * **DB の門は、Discord への書き込みまでは守れない。**
 *
 * 収束は「所有権を取る → Discord を編集する → 決着を書く」の順で進む。世代と所有者の門は
 * 最後の決着を守るが、**編集はその前に起きている**。貸出の切れた古い実行の編集が、
 * 新しい所有者の編集より後に着地すると、DB は正しく closed / settled なのに、
 * 投稿者の画面だけが古い姿へ戻る。
 *
 * ここでは、その順序を実際に作って戻ることを確かめ、そのうえで同じメッセージが
 * いまの案件へ収束し直すことを見る。
 */
describe("古い実行が外を書き換えても、投稿者の画面はいまの姿へ戻る", () => {

  /** 「返答待ち」で確定し、収束はまだ、という状態を作る */
  function seedWaiting(ctx: ReturnType<typeof boot>) {
    const row = ctx.confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    ctx.confessions.claim(row.id, "thread-1", "staff-1");
    const draft = ctx.confessions.createReplyDraft(row.id, "staff-1", "届いている本文", 90);
    ctx.confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    const finalized = ctx.confessions.finalizeStaffReply({
      draftId: draft.id,
      generation: ctx.confessions.getReplyDraft(draft.id)!.generation,
      intent: "wait",
      actorId: "staff-1",
      renderTarget: { channelId: DM_CH, messageId: MSG },
    });
    return { confessionId: row.id, renderId: finalized.renderId! };
  }

  /**
   * A が編集の途中で止まり、貸出が切れ、B が引き取って closed 表示まで書き終える。
   * そこへ A の古い編集が `mode` の結末で着地する。
   */
  async function staleLandsLast(mode: "ok" | "net" | "api") {
    const a = boot("instance-A");
    const { confessionId } = seedWaiting(a);
    const world = dmWorld();

    // ── A: 収束を始め、Discord への編集の直前で止まる ──
    const gate = world.holdEdit();
    const aConverging = convergePendingRenders(world.client as never, a.services);
    await gate.entered;

    // ── A の貸出が切れ、B が引き取る ──
    const b = boot("instance-B");
    killPreviousInstances(b.db, "instance-B");
    expect(b.confessions.recoverOrphanedEffects("system:sweep").renders).toBe(1);

    // ── その間に投稿者が終了する ──
    b.confessions.senderCloseAtomic(confessionId, "sender-1", 90);

    // ── B が同じメッセージを「終了」の姿へ書き換え、決着させる ──
    // （回収は「結末を見届けていない試行」の分も義務へ寄せるので、件数は1とは限らない）
    expect(await convergePendingRenders(world.client as never, b.services)).toBeGreaterThan(0);
    expect(world.visibleText()).toContain("既に終了しています");
    expect(world.visibleText()).not.toContain("自動で終了します");

    // ── ここで A の古い編集がようやく着地する ──
    if (mode === "net") world.failNext("net");
    if (mode === "api") world.failNext("api");
    gate.release();
    await aConverging;

    return { a, b, confessionId, world };
  }

  // R48: 古い編集が成功して着地する
  it("古い編集が後から成功しても、修復が同じメッセージを終了の姿へ戻す", async () => {
    const { b, confessionId, world } = await staleLandsLast("ok");

    // **まずは実際に古い姿へ戻ってしまっていることを確かめる**（ここが今回の穴）
    expect(world.visibleText()).toContain("必要なら追記できます");
    expect(world.visibleText()).toContain("自動で終了します");
    // DB は正しいまま。古い試行は何も動かしていない
    expect(b.confessions.get(confessionId)!.status).toBe("closed");
    expect(b.confessions.get(confessionId)!.closed_side).toBe("sender");

    // 修復の義務が durable に残っている（同じメッセージ・凍結した姿を持たない）
    const repairs = b.confessions.pendingRendersFor(confessionId);
    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) {
      expect(repair.message_id).toBe(MSG);
      expect(repair.render_kind).toBe("current_state");
      expect(repair.deadline_at).toBeNull();
    }

    // ── 刻時盤（あるいは再起動後）の収束 ──
    const before = world.newDms.length;
    expect(await convergePendingRenders(world.client as never, b.services)).toBeGreaterThan(0);

    const text = world.visibleText();
    expect(text).toContain("この返信は届きましたが、このやり取りは既に終了しています");
    expect(text).toContain("あなたが終了を選んだためです");
    expect(text).not.toContain("自動で終了します"); // 「7日後」を出さない
    expect(text).not.toContain("必要なら追記できます");
    expect(world.visibleButtons()).toEqual([]); // 追記／もう大丈夫 の操作を残さない
    expect(world.newDms).toHaveLength(before); // **新しい DM は 0**

    // 会話は一度も開き直っていない
    expect(b.confessions.get(confessionId)!.status).toBe("closed");
    expect(b.confessions.get(confessionId)!.reply_deadline_at).toBeNull();
    expect(
      (b.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_reopen'").get() as { n: number }).n,
    ).toBe(0);
    // 責務は片付いた
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
  });

  // R49: 古い編集の結末が分からない
  it("古い編集の結末が分からない場合も、修復して収束し直す", async () => {
    const { b, confessionId, world } = await staleLandsLast("net");

    // 触ったかどうか分からない以上、「触っていない」ことにはしない
    const repairs = b.confessions.pendingRendersFor(confessionId);
    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) expect(repair.message_id).toBe(MSG);

    const before = world.newDms.length;
    await convergePendingRenders(world.client as never, b.services);
    expect(world.visibleText()).toContain("既に終了しています");
    expect(world.visibleText()).not.toContain("自動で終了します");
    expect(world.newDms).toHaveLength(before);
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
  });

  // R50: 古い編集が明確に拒否された
  it("古い編集が明確に拒否されたなら、要らない修復を作らない", async () => {
    const { b, confessionId, world } = await staleLandsLast("api");

    // 外は変わっていないと確定している。B が書いた終了の姿のまま
    expect(world.visibleText()).toContain("既に終了しています");
    expect(world.visibleText()).not.toContain("自動で終了します");
    // **この callback は修復を作らない。** 残っているのは回収が寄せた分だけで、
    // それも収束済み（＝確定拒否を理由に新しい義務は生まれていない）
    expect(b.confessions.pendingRendersFor(confessionId)).toEqual([]);
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
    expect(b.confessions.listOpenRenderAttempts()).toEqual([]);
  });

  it("修復は、積んだ時点ではなく実行時の案件から描く", async () => {
    // **積んだ時点の姿を凍結しない。** 修復が queue されたあとに会話が終われば、
    // 直った表示は「終了しています」でなければならない——凍結すると、終わった会話へ
    // 「7日後に終了します」と追記の操作を復活させてしまう。
    const a = boot("instance-A");
    const { confessionId } = seedWaiting(a);
    const world = dmWorld();

    const gate = world.holdEdit();
    const aConverging = convergePendingRenders(world.client as never, a.services);
    await gate.entered;

    const b = boot("instance-B");
    killPreviousInstances(b.db, "instance-B");
    b.confessions.recoverOrphanedEffects("system:sweep");
    // **会話はまだ「返答待ち」のまま**（ここが凍結の分かれ目）
    expect(b.confessions.get(confessionId)!.reply_deadline_at).not.toBeNull();
    expect(await convergePendingRenders(world.client as never, b.services)).toBeGreaterThan(0);

    // 古い編集が着地し、修復が積まれる
    gate.release();
    await aConverging;
    expect(b.confessions.pendingRendersFor(confessionId).length).toBeGreaterThan(0);

    // ── そのあとで投稿者が終了する ──
    b.confessions.senderCloseAtomic(confessionId, "sender-1", 90);

    const before = world.newDms.length;
    expect(await convergePendingRenders(world.client as never, b.services)).toBeGreaterThan(0);
    const text = world.visibleText();
    expect(text).toContain("既に終了しています");
    expect(text).not.toContain("自動で終了します");
    expect(text).not.toContain("必要なら追記できます");
    expect(world.visibleButtons()).toEqual([]);
    expect(world.newDms).toHaveLength(before);
  });

  it("修復は無限に増えない（まだ実行していない指示があれば積まない）", async () => {
    const { b, confessionId, world } = await staleLandsLast("ok");
    const open = b.confessions.pendingRendersFor(confessionId).length;
    expect(open).toBeGreaterThan(0);

    // 同じメッセージについて、もう一度修復を積もうとしても増えない
    for (let i = 0; i < 5; i += 1) {
      expect(b.confessions.queueRenderRepair({ confessionId, channelId: DM_CH, messageId: MSG })).toBeNull();
    }
    expect(b.confessions.pendingRendersFor(confessionId)).toHaveLength(open);

    await convergePendingRenders(world.client as never, b.services);
    expect(b.confessions.pendingRendersFor(confessionId)).toEqual([]);
  });

  it("修復は、いま実行中の別の所有者を奪わない", async () => {
    const a = boot("instance-A");
    const { confessionId, renderId } = seedWaiting(a);
    // 別インスタンスが収束を握っている（まだ編集を終えていない）
    const other = boot("instance-C");
    expect(other.confessions.claimRender(renderId)).toBeTruthy();

    // 修復は別の行として積まれ、実行中の行には触らない
    const repairId = a.confessions.queueRenderRepair({
      confessionId,
      channelId: DM_CH,
      messageId: MSG,
    });
    expect(repairId).not.toBeNull();
    expect(repairId).not.toBe(renderId);
    expect(a.confessions.pendingRendersFor(confessionId).find((r) => r.id === renderId)!.state).toBe("rendering");
    expect(a.confessions.pendingRendersFor(confessionId).find((r) => r.id === repairId)!.state).toBe("pending");
  });

  it("修復の義務は、プロセスが落ちても残る", async () => {
    const { b, confessionId } = await staleLandsLast("ok");
    const repairId = b.confessions.pendingRendersFor(confessionId)[0]!.id;
    expect(repairId).toBeGreaterThan(0);

    // ── 再起動 ──
    const c = boot("instance-C");
    killPreviousInstances(c.db, "instance-C");
    c.confessions.recoverOrphanedEffects("system:startup");
    expect(c.confessions.pendingRendersFor(confessionId).map((r) => r.id)).toContain(repairId);

    const world = dmWorld();
    expect(await convergePendingRenders(world.client as never, c.services)).toBeGreaterThan(0);
    expect(world.visibleText()).toContain("既に終了しています");
    expect(world.newDms).toEqual([]);
    expect(c.confessions.obligations(confessionId).pendingRenders).toBe(0);
  });
});

/**
 * **落ちる場所が「編集のあと・決着の前」だと、DB には何の痕跡も残らない。**
 *
 * 収束の決着は編集の**あと**に書かれる。編集が着地したあと、決着を書く前に
 * プロセスが死ぬと、新しい世代が既に settled を書いていれば、誰も「外が古い姿に
 * なっている」ことを知れない。だから外部編集の試行そのものを、**編集の前に**
 * durable な行として置く。
 */
describe("編集の前に痕跡を残すから、その隙間で落ちても直せる", () => {
  function seedWaiting(ctx: ReturnType<typeof boot>) {
    const row = ctx.confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    ctx.confessions.claim(row.id, "thread-1", "staff-1");
    const draft = ctx.confessions.createReplyDraft(row.id, "staff-1", "届いている本文", 90);
    ctx.confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    const finalized = ctx.confessions.finalizeStaffReply({
      draftId: draft.id,
      generation: ctx.confessions.getReplyDraft(draft.id)!.generation,
      intent: "wait",
      actorId: "staff-1",
      renderTarget: { channelId: DM_CH, messageId: MSG },
    });
    return { confessionId: row.id, renderId: finalized.renderId! };
  }

  /**
   * A が「編集は着地したが、決着は一切書かないまま死んだ」状態を作る。
   *
   * `renderClaimed` の内部で死ぬのは在プロセスでは作れないので、**同じ順序を
   * core の API で組む**——編集の前に試行を置き、編集を実行し、決着を書かずに離れる。
   * これが本番で守りたい順序そのもの。
   */
  /** A が書いた「返答待ち」の姿を、実際に同じメッセージへ着地させる */
  async function writeStaleWaiting(world: ReturnType<typeof dmWorld>) {
    const channel: any = await (world.client.channels as any).fetch(DM_CH);
    await (await channel.messages.fetch(MSG)).edit({
      embeds: [
        {
          toJSON: () => ({
            description: "届いている本文",
            fields: [
            { value: "**必要なら追記できます。**" },
            { value: "返信がない場合、このやり取りは 自動で終了します。" },
          ],
          }),
        },
      ],
      components: [{}],
    });
  }

  function aTouchesOutsideThenDies(
    a: ReturnType<typeof boot>,
    confessionId: number,
    renderId: number,
  ): { generation: number; attemptId: number } {
    const claimed = a.confessions.claimRender(renderId)!;
    const attemptId = a.confessions.beginRenderAttempt({
      renderId,
      confessionId,
      generation: claimed.generation,
      channelId: DM_CH,
      messageId: MSG,
    });
    return { generation: claimed.generation, attemptId };
  }

  // R51
  it("編集は着地したのに決着を書けずに落ちても、修復へ収束する", async () => {
    const a = boot("instance-A");
    const { confessionId, renderId } = seedWaiting(a);
    const world = dmWorld();

    // ── A: **触る前に痕跡を残し**、待機表示を書き込む ──
    const { attemptId } = aTouchesOutsideThenDies(a, confessionId, renderId);
    expect(a.db.prepare("SELECT progress FROM confession_render_attempts WHERE id=?").pluck().get(attemptId)).toBe(
      "sending",
    );
    await writeStaleWaiting(world);
    // ── ここで A は死ぬ。決着も修復も書いていない ──
    expect(world.visibleText()).toContain("自動で終了します");

    // ── その間に投稿者が終了する ──
    a.confessions.senderCloseAtomic(confessionId, "sender-1", 90);

    // ── B が起動し、貸出の切れた置き土産を回収する ──
    const b = boot("instance-B");
    killPreviousInstances(b.db, "instance-B");
    const recovered = b.confessions.recoverOrphanedEffects(
      "system:startup",
      Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1,
    );
    // **決着していない外部編集の試行が、唯一の手がかりとして残っていた**
    expect(recovered.renderAttempts).toBe(1);
    // 届いたとも届かなかったとも書かない
    expect(b.db.prepare("SELECT progress FROM confession_render_attempts WHERE id=?").pluck().get(attemptId)).toBe(
      "unknown",
    );
    expect(b.confessions.pendingRendersFor(confessionId).length).toBeGreaterThan(0);

    // ── 収束 ──
    const before = world.newDms.length;
    expect(await convergePendingRenders(world.client as never, b.services)).toBeGreaterThan(0);

    const text = world.visibleText();
    expect(text).toContain("既に終了しています");
    expect(text).not.toContain("自動で終了します");
    expect(text).not.toContain("必要なら追記できます");
    expect(world.visibleButtons()).toEqual([]);
    expect(world.newDms).toHaveLength(before); // 新しい DM は 0
    expect(b.confessions.get(confessionId)!.status).toBe("closed");
    expect(
      (b.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_reopen'").get() as { n: number }).n,
    ).toBe(0);
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
    expect(b.confessions.listOpenRenderAttempts()).toEqual([]);
  });

  it("回収の修復は、まだ実行していない指示があっても必ず1つ後ろへ積む", async () => {
    // 外の編集が、その指示の収束より**先に**着地したのか後だったのかは分からない。
    // 先に置かれた指示が正しい姿を書いても、そのあとに着地されれば元の木阿弥なので、
    // 必ず1つ後ろに義務を積む（同じメッセージへの編集は冪等なので、余分に1回直すだけ）。
    const a = boot("instance-A");
    const { confessionId, renderId } = seedWaiting(a);
    aTouchesOutsideThenDies(a, confessionId, renderId);

    const b = boot("instance-B");
    killPreviousInstances(b.db, "instance-B");
    b.confessions.recoverOrphanedEffects(
      "system:startup",
      Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1,
    );
    // 元の指示（pending へ戻ったもの）と、修復の指示の2つ
    expect(b.confessions.pendingRendersFor(confessionId)).toHaveLength(2);

    const world = dmWorld();
    expect(await convergePendingRenders(world.client as never, b.services)).toBe(2);
    expect(world.newDms).toEqual([]); // どちらも編集。新しい DM は 0
    expect(b.confessions.obligations(confessionId).pendingRenders).toBe(0);
  });

  // R52
  it("決着と修復のあいだに隙間は無い（同じトランザクションで書く）", () => {
    const a = boot("instance-A");
    const { confessionId, renderId } = seedWaiting(a);
    const { generation, attemptId } = aTouchesOutsideThenDies(a, confessionId, renderId);

    // **ここで見たいのは決着の境界だけ**なので、回収は通さず（通すと試行も片付く）、
    // 収束の行だけを別の所有者が引き取って決着させた状態を直接作る。
    a.db.prepare("UPDATE confession_pending_renders SET state='pending' WHERE id=?").run(renderId);
    const b = boot("instance-B");
    const claimedByB = b.confessions.claimRender(renderId)!;
    b.confessions.settleRender({ renderId, generation: claimedByB.generation, state: "settled" });
    expect(b.confessions.pendingRendersFor(confessionId)).toEqual([]);

    // **A の決着は、負けると同時に修復を残す。** 片方だけが成立する状態は作れない
    const result = a.confessions.finishRenderAttempt({
      attemptId,
      renderId,
      generation,
      outcome: "delivered",
    });
    expect(result.won).toBe(false);
    expect(result.repairId).not.toBeNull();
    expect(a.confessions.pendingRendersFor(confessionId)).toHaveLength(1);
    // 試行はもう「決着していない」ものではない（回収が二重に修復を積まない）
    expect(a.confessions.listOpenRenderAttempts()).toEqual([]);
    expect(a.db.prepare("SELECT progress FROM confession_render_attempts WHERE id=?").pluck().get(attemptId)).toBe(
      "delivered",
    );
  });

  // R53
  it("確定拒否なら修復を作らないが、書けずに落ちたなら不明として修復へ寄せる", () => {
    // (a) 確定拒否まで書けた
    const a = boot("instance-A");
    const first = seedWaiting(a);
    const touched = aTouchesOutsideThenDies(a, first.confessionId, first.renderId);
    a.db.prepare("UPDATE confession_pending_renders SET state='pending' WHERE id=?").run(first.renderId);
    const b = boot("instance-B");
    const claimedByB = b.confessions.claimRender(first.renderId)!;
    b.confessions.settleRender({ renderId: first.renderId, generation: claimedByB.generation, state: "settled" });

    const rejected = a.confessions.finishRenderAttempt({
      attemptId: touched.attemptId,
      renderId: first.renderId,
      generation: touched.generation,
      outcome: "failed",
    });
    expect(rejected.won).toBe(false);
    expect(rejected.repairId).toBeNull(); // 外は変わっていないと確定している
    expect(a.confessions.pendingRendersFor(first.confessionId)).toEqual([]);

    // (b) 確定拒否を書く前に落ちた → 真実は不明。余分な修復は許容し、delivered とは書かない
    const second = seedWaiting(b);
    const crashed = aTouchesOutsideThenDies(b, second.confessionId, second.renderId);
    const c = boot("instance-C");
    killPreviousInstances(c.db, "instance-C");
    const recovered = c.confessions.recoverOrphanedEffects(
      "system:sweep",
      Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1,
    );
    expect(recovered.renderAttempts).toBe(1);
    expect(
      c.db.prepare("SELECT progress FROM confession_render_attempts WHERE id=?").pluck().get(crashed.attemptId),
    ).toBe("unknown");
    expect(
      c.db.prepare("SELECT progress FROM confession_render_attempts WHERE id=?").pluck().get(crashed.attemptId),
    ).not.toBe("delivered");
    expect(c.confessions.pendingRendersFor(second.confessionId).length).toBeGreaterThan(0);
  });

  // R54
  it("普通に成功した収束は、試行も義務も残さない", async () => {
    const a = boot("instance-A");
    const { confessionId, renderId } = seedWaiting(a);
    const world = dmWorld();

    expect(await convergePendingRenders(world.client as never, a.services)).toBe(1);

    expect(a.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(renderId)).toBe(
      "settled",
    );
    // 試行は片付いている（永久に修復の義務を残さない）
    expect(a.confessions.listOpenRenderAttempts()).toEqual([]);
    expect(
      a.db.prepare("SELECT progress FROM confession_render_attempts ORDER BY id DESC").pluck().get(),
    ).toBe("resolved");
    expect(a.confessions.pendingRendersFor(confessionId)).toEqual([]);
    expect(a.confessions.obligations(confessionId).pendingRenders).toBe(0);
    expect(world.newDms).toEqual([]);

    // 何周掃いても、余計な修復は生まれない
    for (let i = 0; i < 5; i += 1) {
      a.confessions.recoverOrphanedEffects(
        "system:sweep",
        Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1,
      );
      expect(await convergePendingRenders(world.client as never, a.services)).toBe(0);
    }
    expect(a.confessions.obligations(confessionId).pendingRenders).toBe(0);
  });
});
