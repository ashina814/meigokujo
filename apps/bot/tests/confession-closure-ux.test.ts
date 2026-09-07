import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { CONFESSION_INSTANCE_LEASE_SECONDS, Confessions, EventLog, openDb } from "@meigokujo/core";
import type { Services } from "../src/services.js";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));
vi.mock("../src/church-roles.js", () => ({
  isChurchManager: () => false,
  // 「対応する」を押せる資格だけを持つ（案件ごとの操作権限とは別物）
  isChurchConsult: () => true,
  notifyRoleIdsForDisposition: () => [],
  notifyRoleIdsForType: () => [],
  getRoleIds: () => [],
  roleMention: () => ({ content: undefined, roleIds: [] }),
}));

const {
  handleConfessionButton,
  handleConfessionModal,
  handleConfessionStringSelect,
  closeExpiredSenderWaits,
  retryPendingFollowUps,
  convergePendingRenders,
  relayStaffMessage,
} = await import("../src/commands/confession.js");

/**
 * 送った人から見た体験を固定する。
 *
 * 内部関数ではなく実際のハンドラを通し、**投稿者の DM に何が出て何が押せるか**と
 * **担当者のパネルに何が出るか**を見る。ここが壊れたら、体験そのものが壊れている。
 */

const STAFF = "staff-1";
const SENDER = "sender-1";
const THREAD = "thread-1";
const PANEL = "panel-1";
const NOTICE_CH = "confession-ch";
const DM_CH = "dm-channel";

type Sent = { embeds?: any[]; components?: any[]; content?: string; allowedMentions?: any };

function harness(wish: "yes" | "either" | "no" | null = "yes") {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const confessions = new Confessions(db, events);
  const row = confessions.create(SENDER, { type: "soudan", replyWish: wish ?? undefined, body: "本文" });
  confessions.claim(row.id, THREAD, STAFF);
  confessions.setPanelMsg(row.id, PANEL);
  const id = row.id;

  const dms: Sent[] = [];
  /** 届いた順の全版（編集前の中立な1通も残る） */
  const dmVersions: Sent[] = [];
  const dmMessages = new Map<string, { embeds: any[]; edit: (o: Sent) => Promise<unknown> }>();
  const threadPosts: Sent[] = [];
  const noticePosts: Sent[] = [];
  /**
   * Discord の応答を差し替える。
   * `api` = DiscordAPIError（サーバの確定応答＝届いていない）、
   * `net` = 応答が得られなかった（届いたか分からない）。
   */
  let dmMode: "ok" | "api" | "net" = "ok";
  let editMode: "ok" | "api" | "net" = "ok";
  /** この message id の編集だけを失敗させる（null なら editMode に従う） */
  let editFailFor: string | null = null;
  let threadMode: "ok" | "api" | "net" = "ok";
  /**
   * 送信の境界で止めるための関門。時間待ちは使わない。
   *
   * **同時に複数の送信を止められる。** 「古い試行がまだ飛んでいるあいだに、
   * 新しい試行も飛んでいる」という状態を作らないと、世代の門は
   * `outcome='sending'` の条件に隠れてしまい、外しても誰も気づかない。
   */
  type Gate = { entered: () => void; wait: Promise<"ok" | "api" | "net"> };
  const dmGates: Gate[] = [];
  const threadGates: Gate[] = [];
  const apiError = () => Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
  const netError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

  // パネルは編集された内容を保持する（overlay が読み直すため）
  const panelMessage: { embeds: any[]; components: any[]; edit: (o: Sent) => Promise<void> } = {
    embeds: [],
    components: [],
    edit: async (o: Sent) => {
      if (o.embeds) panelMessage.embeds = o.embeds;
      if (o.components) panelMessage.components = o.components;
    },
  };
  const thread = {
    isThread: () => true,
    archived: false,
    send: async (o: Sent) => {
      // 関門が積まれていれば、この1通はそこで止まる（結末も関門側が決める）
      const gate = threadGates.shift();
      let mode = threadMode;
      if (gate) {
        gate.entered();
        mode = await gate.wait;
      }
      if (mode === "api") throw apiError();
      if (mode === "net") throw netError();
      threadPosts.push(o);
    },
    setArchived: vi.fn(async () => undefined),
    messages: { fetch: async (mid: string) => (mid === PANEL ? panelMessage : null) },
    members: { add: vi.fn(), remove: vi.fn() },
  };
  const noticeChannel = {
    type: ChannelType.GuildText,
    isTextBased: () => true,
    send: async (o: Sent) => {
      noticePosts.push(o);
    },
  };
  // 投稿者への DM チャンネル。届いた1通を取り直して編集する経路まで模す
  const dmChannel = {
    id: DM_CH,
    isTextBased: () => true,
    messages: {
      fetch: async (mid: string) => {
        const found = dmMessages.get(mid);
        if (!found) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return found;
      },
    },
  };
  const client = {
    channels: {
      fetch: async (cid: string) =>
        cid === THREAD ? thread : cid === NOTICE_CH ? noticeChannel : cid === DM_CH ? dmChannel : null,
    },
    users: {
      fetch: async (uid: string) => ({
        id: uid,
        send: async (o: Sent) => {
          // 関門は**積んだ数だけ**の送信を止める。後続（投稿者側の操作で出る DM など）
          // まで無条件に止めると、競合そのものを作れない。
          const gate = dmGates.shift();
          let mode = dmMode;
          if (gate) {
            gate.entered(); // 「本当に送信の途中まで来た」ことを呼び出し側へ知らせる
            mode = await gate.wait;
          }
          if (mode === "api") throw apiError();
          if (mode === "net") throw netError();
          // 実物と同じく、届いた1通は **DMチャンネル経由で取り直して** 編集できる。
          // `dms` は投稿者にいま見えている内容、`dmVersions` は届いた順の全版。
          const index = dms.push(o) - 1;
          dmVersions.push(o);
          const messageId = `dm-msg-${index}`;
          dmMessages.set(messageId, {
            get embeds() {
              return (dms[index]?.embeds ?? []) as any[];
            },
            edit: async (next: Sent) => {
              if (editFailFor !== null && editFailFor === messageId) throw apiError();
              if (editMode === "api") throw apiError();
              if (editMode === "net") throw netError();
              dms[index] = next;
              dmVersions.push(next);
              return next;
            },
          });
          return { id: messageId, channelId: DM_CH };
        },
      }),
    },
  };
  const services = {
    db,
    events,
    confessions,
    settings: {
      getNumber: () => 90,
      getString: (k: string) => (k === "channel:confession" ? NOTICE_CH : undefined),
    },
  } as unknown as Services;

  const shown: string[] = [];
  const replies: Sent[] = [];
  const makeInteraction = (customId: string, userId: string, fields: Record<string, string> = {}) => ({
    customId,
    user: { id: userId },
    member: null,
    client,
    replied: false,
    deferred: false,
    fields: { getTextInputValue: (k: string) => fields[k] ?? "" },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async (o: Sent | string) => {
      replies.push(typeof o === "string" ? { content: o } : o);
    }),
    reply: vi.fn(async (o: Sent | string) => {
      replies.push(typeof o === "string" ? { content: o } : o);
    }),
    followUp: vi.fn(async (o: Sent | string) => {
      replies.push(typeof o === "string" ? { content: o } : o);
    }),
    update: vi.fn(async (o: Sent | string) => {
      replies.push(typeof o === "string" ? { content: o } : o);
    }),
    showModal: vi.fn(async (m: any) => {
      shown.push(m.toJSON().custom_id ?? m.data?.custom_id ?? "");
    }),
    fetchReply: vi.fn(async () => null),
    message: { components: [] },
  });

  /** 次に飛ぶ1通を止める関門を積む。積んだ順に消費される */
  const arm = (queue: Gate[]) => {
    let release!: (mode: "ok" | "api" | "net") => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const wait = new Promise<"ok" | "api" | "net">((resolve) => {
      release = resolve;
    });
    queue.push({ entered: signalEntered, wait });
    return { entered, release: (mode: "ok" | "api" | "net" = "ok") => release(mode) };
  };

  const press = async (customId: string, userId = STAFF) => {
    await handleConfessionButton(makeInteraction(customId, userId) as any, services);
  };
  const submit = async (customId: string, userId: string, fields: Record<string, string>) => {
    await handleConfessionModal(makeInteraction(customId, userId, fields) as any, services);
  };

  return {
    db, services, confessions, id, dms, threadPosts, replies, shown, thread, panelMessage, client,
    press, submit, noticePosts,
    /** 生の interaction（channel や values を差し替えて使う） */
    interactionFor: (customId: string, userId: string) => makeInteraction(customId, userId),
    /** 明確な失敗（Discord が拒否）を起こす */
    setDmFails: (v: boolean) => {
      dmMode = v ? "api" : "ok";
    },
    /** 送信結果が分からない状態にする */
    setDmUnknown: (v: boolean) => {
      dmMode = v ? "net" : "ok";
    },
    setThreadFails: (v: boolean) => {
      threadMode = v ? "api" : "ok";
    },
    setThreadUnknown: (v: boolean) => {
      threadMode = v ? "net" : "ok";
    },
    setEditFails: (v: boolean) => {
      editMode = v ? "api" : "ok";
    },
    /**
     * **1通ごとに編集の可否を分ける。** 「この案件でいくつ直せたか」ではなく
     * 「いま送ったこの1通を直せたか」を見るには、同じ案件に成功する表示と
     * 失敗する表示を同時に持たせるしかない。
     */
    setEditFailsFor: (messageId: string | null) => {
      editFailFor = messageId;
    },
    dmVersions,
    /** 届いた n 番目の DM の、指定した版のテキスト */
    dmVersionText: (i: number): string => {
      const e = dmVersions[i]?.embeds?.[0];
      const json = e?.toJSON ? e.toJSON() : e;
      return [json?.description ?? "", ...(json?.fields ?? []).map((f: any) => f.value)].join("\n");
    },
    /**
     * **貸出が切れた所有者の置き土産を掃く**（刻時盤が毎分やっていること）。
     *
     * 回収は「鼓動が途絶えた所有者か」だけで決まり、**自分自身も live に含まれる**。
     * だから「いま飛んでいる送信の所有者が死んだ」を作るには、貸出が切れた時点まで
     * 時計を進めて見るしかない——`heartbeat_at` を先に 0 に書いて回るのではなく、
     * 本番と同じ判定（鼓動の途絶）をそのまま通す。
     */
    sweepDeadOwners: () =>
      confessions.recoverOrphanedEffects(
        "system:sweep",
        Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1,
      ),
    /** 運営スレッドへの中継を境界で止める（`holdDm` と同じ形） */
    holdThread: () => arm(threadGates),
    /**
     * DM 送信を境界で止める。`entered` が解決した時点で「送信の途中」に確実に入っている
     * ので、そこから競合を起こせる（時間待ちに頼らない）。
     * `release(mode)` で、その1通だけの結末（届いた / 拒否された / 不明）を決められる。
     */
    holdDm: () => arm(dmGates),
    threadPostTexts: (): string =>
      threadPosts
        .map((p) => {
          const e = p.embeds?.[0];
          const json = e?.toJSON ? e.toJSON() : e;
          return [p.content ?? "", json?.description ?? ""].join(" ");
        })
        .join("\n"),
    row: () => confessions.get(id)!,
    /** パネル上に見えているボタンの customId */
    panelButtons: (): string[] =>
      panelMessage.components.flatMap((r: any) => (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id)),
    lastReply: () => replies[replies.length - 1] ?? {},
    dmText: (i = -1): string => {
      const dm = dms.at(i);
      const e = dm?.embeds?.[0];
      const json = e?.toJSON ? e.toJSON() : e;
      return [json?.description ?? "", ...(json?.fields ?? []).map((f: any) => f.value)].join("\n");
    },
    dmButtons: (i = -1): string[] =>
      (dms.at(i)?.components ?? []).flatMap((r: any) => (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id)),
  };
}

describe("受領確認は、どの回答希望でも使えて、回答にも終了にもならない", () => {
  // U1 / U2 / U3。U2（必要なら回答してほしい）が元バグの回帰。
  for (const [wish, expected] of [
    ["yes", "運営からの回答をお待ちください"],
    ["either", "必要に応じて運営からお返事します"],
    ["no", "ありがとうございます"],
  ] as const) {
    it(`回答希望=${wish}: 「届きました」が押せて、案件は開いたまま`, async () => {
      const h = harness(wish);
      // パネルに常設されている
      await h.press(`mimi:ack:${h.id}`);
      expect(h.dms).toHaveLength(1);
      expect(h.dmText()).toContain("あなたの声は届きました");
      expect(h.dmText()).toContain(expected);
      // 投稿者はこの DM からそのまま追記・終了できる
      expect(h.dmButtons()).toEqual([`mimi:reply:${h.id}`, `mimi:senderclose:${h.id}`]);

      const row = h.row();
      expect(row.status).toBe("claimed");
      expect(row.close_reason).toBeNull();
      expect(row.acknowledged_at).not.toBeNull();
      // U15: 受領しただけでは運営の番のまま。押した後もパネルは開いている
      expect(h.panelButtons()).toContain(`mimi:replystaff:${h.id}`);
      expect(h.panelButtons()).toContain(`mimi:close:${h.id}`);
    });
  }

  // R5
  it("二度押しでも DM は1通だけ", async () => {
    const h = harness("either");
    await h.press(`mimi:ack:${h.id}`);
    await h.press(`mimi:ack:${h.id}`);
    expect(h.dms).toHaveLength(1);
    expect(h.lastReply().content).toContain("既に受領確認が届いています");
  });

  // U16: 明確な失敗を「送信済み」に見せない
  it("DM が明確に失敗したら、送信済みにならず未達だと分かる", async () => {
    const h = harness("yes");
    h.setDmFails(true);
    await h.press(`mimi:ack:${h.id}`);

    expect(h.row().acknowledged_at).toBeNull();
    expect(h.services.confessions.ackState(h.id)).toBe("failed");
    const said = h.lastReply().content ?? "";
    expect(said).toContain("届けられませんでした");
    expect(said).toContain("まだ受領確認は伝わっていません");
    expect(said).not.toContain("伝えました");
    // パネルも「送信済み」に見えない
    const ack = h.panelMessage.components
      .flatMap((r: any) => (r.toJSON ? r.toJSON() : r).components)
      .find((c: any) => c.custom_id === `mimi:ack:${h.id}`);
    expect(ack.disabled).toBe(false);
    expect(ack.label).not.toContain("送信済み");
    expect(h.threadPostTexts()).toContain("まだ「届きました」とは伝わっていません");
  });

  // U16: 結果不明を delivered にも failed にもしない
  it("送信結果が分からないときは、届いたとも届かなかったとも言わない", async () => {
    const h = harness("yes");
    h.setDmUnknown(true);
    await h.press(`mimi:ack:${h.id}`);

    expect(h.row().acknowledged_at).toBeNull();
    expect(h.services.confessions.ackState(h.id)).toBe("unknown");
    expect(h.lastReply().content).toContain("送信結果を確認できませんでした");
    expect(h.lastReply().content).not.toContain("伝えました");
  });

  // U17: 明確な失敗のあとは、そのまま押し直せる
  it("明確な失敗のあとは押し直せて、届いたときだけ送信済みになる", async () => {
    const h = harness("either");
    h.setDmFails(true);
    await h.press(`mimi:ack:${h.id}`);
    expect(h.dms).toHaveLength(0);

    h.setDmFails(false);
    await h.press(`mimi:ack:${h.id}`);
    expect(h.dms).toHaveLength(1);
    expect(h.row().acknowledged_at).not.toBeNull();
    expect(h.lastReply().content).toContain("伝えました");
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_acknowledge'").get()).toEqual({ n: 1 });
  });

  // U17: 不明のあとは、重複を承知した明示操作でしか送り直さない
  it("結果不明のあとは、重複の確認を挟まないと送り直さない", async () => {
    const h = harness("yes");
    h.setDmUnknown(true);
    await h.press(`mimi:ack:${h.id}`);

    h.setDmUnknown(false);
    await h.press(`mimi:ack:${h.id}`);
    expect(h.dms).toHaveLength(0); // まだ送っていない
    expect(h.lastReply().content).toContain("既に投稿者へ届いている可能性");
    const buttons = (h.lastReply().components ?? []).flatMap((r: any) =>
      (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id),
    );
    expect(buttons).toEqual([`mimi:ackretry:${h.id}`]);

    await h.press(`mimi:ackretry:${h.id}`);
    expect(h.dms).toHaveLength(1);
    expect(h.row().acknowledged_at).not.toBeNull();
  });

  it("受領確認したあとのボタンは押せない形で残る（送信済みと分かる）", async () => {
    const h = harness("yes");
    await h.press(`mimi:ack:${h.id}`);
    const ack = h.panelMessage.components
      .flatMap((r: any) => (r.toJSON ? r.toJSON() : r).components)
      .find((c: any) => c.custom_id === `mimi:ack:${h.id}`);
    expect(ack.disabled).toBe(true);
    expect(ack.label).toContain("送信済み");
  });

  it("旧「あなたの声は届きました」ボタンは、受領確認だけを行い勝手に終了しない", async () => {
    const h = harness("no");
    await h.press(`mimi:voice_received:${h.id}`);
    expect(h.row().status).toBe("claimed");
    expect(h.row().acknowledged_at).not.toBeNull();
    expect(h.replies.map((r) => r.content ?? "").join("\n")).toContain("✅ 終了");
  });

  // 旧 confession-voice-received.test.ts が見ていた「DM できなかったことを担当者とスレッドに残す」を
  // 引き継ぐが、意味は正す。
  //
  // 旧テストは「DM が失敗しても受領した事実は残る」を正当化していた。しかし運営が声を
  // 読んだことと、投稿者へ「届きました」が届いたことは別の事実で、**ユーザーへ出す
  // ボタンが示すのは後者**でなければならない。試行として失敗を残しつつ、
  // acknowledged は立てない。
  it("DM が届かなくても案件は閉じず、届かなかったことが担当者にもスレッドにも残る", async () => {
    const h = harness("no");
    h.setDmFails(true);
    await h.press(`mimi:ack:${h.id}`);
    expect(h.row().acknowledged_at).toBeNull();
    expect(h.services.confessions.ackState(h.id)).toBe("failed");
    expect(h.services.confessions.lastAckAttempt(h.id)?.outcome).toBe("failed");
    expect(h.lastReply().content).toContain("届けられませんでした");
    expect(h.threadPostTexts()).toContain("届けられませんでした");
    // DM の成否にかかわらず案件は閉じない
    expect(h.row().status).toBe("claimed");
  });
});

describe("自由返信は、待つのか終えるのかを必ず選ぶ", () => {
  // U4
  it("返答を待つ: 本文が届き、追記と終了ができ、期限が予告される", async () => {
    const h = harness("yes");
    await h.press(`mimi:replystaff:${h.id}`);
    expect(h.shown).toEqual([`mimi:staffreplybody:${h.id}`]);

    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "確認しました。○○という対応になります。" });
    // まだ送っていない
    expect(h.dms).toHaveLength(0);
    expect(h.lastReply().content).toContain("まだ送っていません");
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;

    await h.press(`mimi:replywait:${draftId}`);
    expect(h.dms).toHaveLength(1);
    expect(h.dmText()).toContain("○○という対応になります");
    expect(h.dmText()).toContain("必要なら追記できます");
    expect(h.dmText()).toContain("7日後");
    expect(h.dmText()).toContain("急ぐ必要はありません");
    expect(h.dmButtons()).toEqual([`mimi:reply:${h.id}`, `mimi:senderclose:${h.id}`]);

    const row = h.row();
    expect(row.status).toBe("claimed");
    expect(row.stage).toBe("awaiting_poster");
    expect(row.reply_deadline_at).not.toBeNull();
  });

  // U5
  it("この返信で終了する: 本文も終了も伝わり、要対応から外れる", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "対応しました。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replyend:${draftId}`);

    expect(h.dmText()).toContain("対応しました");
    expect(h.dmText()).toContain("このやり取りはここで終了しました");
    expect(h.dmText()).toContain("新しくトートへ送れます");
    // 終了後は投稿者側のボタンを出さない
    expect(h.dmButtons()).toEqual([]);

    const row = h.row();
    expect(row.status).toBe("closed");
    expect(row.closed_side).toBe("staff");
    expect(h.thread.setArchived).toHaveBeenCalled();
  });

  // R4
  it("「返信して終了」の二度押しでも、本文は1回しか届かない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "本文" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replyend:${draftId}`);
    await h.press(`mimi:replyend:${draftId}`);
    expect(h.dms).toHaveLength(1);
    expect(h.lastReply().content).toContain("既に送信済み");
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_close'").get()).toEqual({ n: 1 });
  });

  it("DM を届けられなかったら、返信済みにも終了にもしない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "本文" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    h.setDmFails(true);
    await h.press(`mimi:replyend:${draftId}`);

    const row = h.row();
    expect(row.status).toBe("claimed"); // 終了していない
    expect(row.reply_deadline_at).toBeNull(); // 待機にもしていない
    expect(h.lastReply().content).toContain("状態は変えていません");
    expect(h.db.prepare("SELECT outcome FROM confession_reply_drafts WHERE id=?").pluck().get(draftId)).toBe("failed");
  });

  // R1
  it("返信を書いている間に投稿者が終了したら、その返信は送られず再開もしない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "本文" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;

    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    const dmsAfterClose = h.dms.length;

    await h.press(`mimi:replywait:${draftId}`);
    expect(h.dms).toHaveLength(dmsAfterClose); // 何も送っていない
    expect(h.row().status).toBe("closed");
    expect(h.row().closed_side).toBe("sender");
    expect(h.lastReply().content).toContain("既に終了しています");
  });
});

describe("「回答は不要」への返信は、止めないが必ず確認する", () => {
  // U11
  it("いきなりモーダルは出さず、明示の確認を挟む", async () => {
    const h = harness("no");
    await h.press(`mimi:replystaff:${h.id}`);
    expect(h.shown).toEqual([]);
    expect(h.lastReply().content).toContain("「回答は不要」を選択しています");
    expect(h.lastReply().content).toContain("それでも内容について返信しますか");
    const buttons = (h.lastReply().components ?? []).flatMap((r: any) => (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id));
    expect(buttons).toEqual([`mimi:replyno:${h.id}`]);
  });

  // U12
  it("確認を通して返信しても、回答希望は「回答は不要」のまま", async () => {
    const h = harness("no");
    await h.press(`mimi:replystaff:${h.id}`);
    await h.press(`mimi:replyno:${h.id}`);
    expect(h.shown).toEqual([`mimi:staffreplybody:${h.id}`]);

    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "重要な連絡です。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);

    expect(h.dmText()).toContain("重要な連絡です");
    expect(h.row().reply_wish).toBe("no");
  });
});

describe("投稿者が自分で終われる", () => {
  // U6
  it("確認を1回挟み、終了しても履歴は消えないと伝える", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclose:${h.id}`, SENDER);
    expect(h.lastReply().content).toContain("このやり取りを終了しますか");
    expect(h.lastReply().content).toContain("消えることはありません");
    const buttons = (h.lastReply().components ?? []).flatMap((r: any) => (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id));
    expect(buttons).toEqual([`mimi:senderclosego:${h.id}`, `mimi:sendercloseno:${h.id}`]);

    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    const row = h.row();
    expect(row.status).toBe("closed");
    expect(row.closed_side).toBe("sender");
    expect(row.body).toBe("本文");
    // 運営側にも分かる
    expect(h.threadPosts.map((p) => p.content).join("\n")).toContain("投稿者がこのやり取りを終了しました");
  });

  // U7
  it("本人以外が sender close の customId を叩いても拒否する", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclose:${h.id}`, "someone-else");
    expect(h.lastReply().content).toBe("この操作はできません。");
    await h.press(`mimi:senderclosego:${h.id}`, "someone-else");
    expect(h.row().status).toBe("claimed");
    // 担当者本人でも投稿者の代わりには終了できない
    await h.press(`mimi:senderclosego:${h.id}`, STAFF);
    expect(h.row().status).toBe("claimed");
  });

  // R3
  it("二度押しでも一度しか終了しない", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_close'").get()).toEqual({ n: 1 });
    expect(h.lastReply().content).toContain("既に終了しています");
  });

  it("「戻る」を押したらやり取りは続く", async () => {
    const h = harness("yes");
    await h.press(`mimi:sendercloseno:${h.id}`, SENDER);
    expect(h.row().status).toBe("claimed");
    expect(h.lastReply().content).toContain("そのまま続いています");
  });
});

describe("投稿者の追記", () => {
  // U8 / R6
  it("投稿者待ちから追記すると、運営の番へ戻り期限が消える", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "状況を教えてください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    expect(h.row().reply_deadline_at).not.toBeNull();

    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "こういう状況です。" });
    const row = h.row();
    expect(row.stage).toBe("awaiting_staff");
    expect(row.reply_deadline_at).toBeNull();
    // 運営のスレッドにも届く
    const posted = h.threadPosts.map((p) => {
      const e = p.embeds?.[0];
      return (e?.toJSON ? e.toJSON() : e)?.description ?? "";
    });
    expect(posted.join("\n")).toContain("こういう状況です");
  });

  it("追記の中継は、誰も呼び出さない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "@everyone たすけて" });
    const relay = h.threadPosts.find((p) => p.embeds);
    expect(relay?.allowedMentions).toEqual({ parse: [] });
  });

  // U18: 届いていない本文を「届けました」と言わない
  it("運営へ渡せなかったとき、届けましたと言わず本文も失わない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "状況を教えてください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    expect(h.row().reply_deadline_at).not.toBeNull();

    h.setThreadFails(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "本当に困っています" });

    const said = h.lastReply().content ?? "";
    expect(said).not.toContain("運営に届けました");
    expect(said).toContain("確かに預かりました");
    expect(said).toContain("内容は失われていません");

    // 本文は DB に残っている
    const pending = h.services.confessions.listUnrelayedFollowUps(h.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe("本当に困っています");
    // 期限は解除されたまま＝自動終了に巻き込まれない
    expect(h.row().reply_deadline_at).toBeNull();
    expect(h.row().stage).toBe("awaiting_staff");
    // 担当者パネルにも未引き渡しとして出る
    const embed = h.panelMessage.embeds[0];
    const json = embed?.toJSON ? embed.toJSON() : embed;
    expect(JSON.stringify(json)).toContain("未引き渡しの追記");
  });

  // U19: 明確な失敗だけ拾い直し、最終的に1回だけ届く
  it("渡せなかった追記は拾い直され、最終的にスレッドへ1回だけ届く", async () => {
    const h = harness("yes");
    h.setThreadFails(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "拾い直してほしい" });
    expect(h.threadPostTexts()).not.toContain("拾い直してほしい");

    h.setThreadFails(false);
    expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(1);
    expect(h.threadPostTexts()).toContain("拾い直してほしい");
    expect(h.services.confessions.listUnrelayedFollowUps(h.id)).toEqual([]);

    // もう一度掃いても二重には届かない
    expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(0);
    expect(h.threadPostTexts().split("拾い直してほしい").length - 1).toBe(1);
    expect(h.row().stage).toBe("awaiting_staff");
    expect(h.row().reply_deadline_at).toBeNull();
  });

  // unknown を自動で送り直さない
  it("渡せたか分からない追記は、自動では送り直さない", async () => {
    const h = harness("yes");
    h.setThreadUnknown(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "不明な追記" });
    expect(h.lastReply().content).toContain("確認できませんでした");

    h.setThreadUnknown(false);
    expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(0);
    expect(h.threadPostTexts()).not.toContain("不明な追記");
    // ただし担当者からは見える
    expect(h.services.confessions.listUnrelayedFollowUps(h.id)).toHaveLength(1);
  });

  // R11: 中継に失敗しても、期限で勝手に閉じられない
  it("中継に失敗した追記があっても、期限による自動終了は起きない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "お返事ください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    const staleDeadline = h.row().reply_deadline_at!;

    h.setThreadFails(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "まだ困っています" });

    expect(await closeExpiredSenderWaits(h.client as any, h.services, staleDeadline + 86_400 * 30)).toBe(0);
    expect(h.row().status).toBe("claimed");
    expect(h.services.confessions.listUnrelayedFollowUps(h.id)[0].body).toBe("まだ困っています");
  });

  it("終了済みには追記できない", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    await h.press(`mimi:reply:${h.id}`, SENDER);
    expect(h.shown).toEqual([]);
    expect(h.lastReply().content).toContain("既に終了しています");
  });

  it("投稿者以外は追記のモーダルを開けない", async () => {
    const h = harness("yes");
    await h.press(`mimi:reply:${h.id}`, "someone-else");
    expect(h.shown).toEqual([]);
    expect(h.lastReply().content).toBe("この操作はできません。");
  });
});

describe("自動終了は「返答を待つ」と決めた案件だけ", () => {
  const far = () => Math.floor(Date.now() / 1000) + 8 * 86_400;

  // U9
  it("期限が来たら終了し、拒否ではないと伝える", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "お待ちしています。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);

    const closed = await closeExpiredSenderWaits(h.client as any, h.services, far());
    expect(closed).toBe(1);
    expect(h.row().status).toBe("closed");
    expect(h.row().closed_side).toBe("timeout");
    expect(h.dmText()).toContain("一定期間返信がなかったため");
    expect(h.dmText()).toContain("拒否されたわけでもありません");
    expect(h.dmText()).toContain("新しくトートへ送れます");
    expect(h.row().body).toBe("本文"); // archive であって削除ではない
  });

  // U10 / M4
  it("運営側の確認待ちは、期限を過ぎても自動終了しない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "調べます。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    await h.press(`mimi:hold:${h.id}`);

    expect(h.row().stage).toBe("internal_hold");
    expect(h.row().reply_deadline_at).toBeNull();
    expect(await closeExpiredSenderWaits(h.client as any, h.services, far() + 86_400 * 365)).toBe(0);
    expect(h.row().status).toBe("claimed");
  });

  it("未対応・対応中の案件は自動終了しない", async () => {
    const h = harness("yes");
    expect(await closeExpiredSenderWaits(h.client as any, h.services, far() + 86_400 * 365)).toBe(0);
    expect(h.row().status).toBe("claimed");
  });

  // R2
  it("追記が受理されていれば、その直後の自動終了は何もしない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "お返事ください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    // 期限を過去へ倒し、その状態で投稿者が追記する
    h.db.prepare("UPDATE confession_tickets SET reply_deadline_at=? WHERE id=?").run(far() - 86_400 * 30, h.id);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "まだ困っています。" });

    expect(await closeExpiredSenderWaits(h.client as any, h.services, far())).toBe(0);
    expect(h.row().status).toBe("claimed");
    expect(h.row().stage).toBe("awaiting_staff");
  });

  // U14
  it("終了済みの案件が、古いボタンで再開されない", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    await h.press(`mimi:ack:${h.id}`);
    expect(h.lastReply().content).toContain("既に終了しています");
    await h.press(`mimi:replystaff:${h.id}`);
    expect(h.shown).toEqual([]);
    await h.press(`mimi:hold:${h.id}`);
    expect(h.row().status).toBe("closed");
  });
});

describe("外部返信の経路は 💬 返信する だけ", () => {
  const staffMessage = (h: ReturnType<typeof harness>, content: string, channelId = THREAD) => ({
    author: { bot: false },
    channel: {
      isThread: () => true,
      id: channelId,
      send: async (o: Sent) => {
        h.threadPosts.push(o);
      },
    },
    content,
    react: vi.fn(async () => undefined),
  });

  // U20
  it("スレッドへ直接書いても、投稿者へは送らず期限も作らない", async () => {
    const h = harness("yes");
    const message = staffMessage(h, "こんにちは、確認しています");
    await relayStaffMessage(h.client as any, h.services, message as any);

    expect(h.dms).toHaveLength(0);
    expect(h.row().reply_deadline_at).toBeNull();
    expect(h.row().stage).toBe("active");
    // 担当者へは canonical path を案内する
    expect(h.threadPostTexts()).toContain("投稿者へ送信していません");
    expect(h.threadPostTexts()).toContain("返信する");
    expect(message.react).toHaveBeenCalledWith("📝");
  });

  it("案内は同じスレッドで繰り返さない（内部メモとしては書けるまま）", async () => {
    const h = harness("yes");
    const channelId = `${THREAD}-memo`;
    h.db.prepare("UPDATE confession_tickets SET thread_id=? WHERE id=?").run(channelId, h.id);
    await relayStaffMessage(h.client as any, h.services, staffMessage(h, "メモ1", channelId) as any);
    await relayStaffMessage(h.client as any, h.services, staffMessage(h, "メモ2", channelId) as any);
    expect(h.threadPostTexts().split("投稿者へ送信していません").length - 1).toBe(1);
    expect(h.dms).toHaveLength(0);
  });
});

describe("送信中に会話が終わったとき、あとから来た確定が終了を塗り替えない", () => {
  // R8: staff「この返信で終了」送信中に sender close
  it("返信して終了の送信中に投稿者が終了したら、投稿者の終了が正本のまま", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "対応しました。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;

    const gate = h.holdDm();
    const sending = h.press(`mimi:replyend:${draftId}`);
    await gate.entered; // ここで確実に「DM 送信中」
    // 送信の途中で投稿者が終了する
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    const sealed = h.row();
    expect(sealed.closed_side).toBe("sender");
    gate.release();
    await sending;

    const after = h.row();
    expect(after.closed_side).toBe("sender");
    expect(after.close_reason).toBe("poster_ended");
    expect(after.closed_by).toBe(SENDER);
    expect(after.closed_at).toBe(sealed.closed_at);
    // 担当者側の偽の終了ログを残さない
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_close'").get()).toEqual({ n: 1 });
    // 担当者には競合の結果を返す
    expect(h.lastReply().content).toContain("送信中にこのやり取りは終了していました");
    expect(h.lastReply().content).toContain("投稿者が「もう大丈夫です」で終了");
  });

  // R9: staff「返答を待つ」送信中に sender close
  it("返答を待つの送信中に投稿者が終了したら、期限も待機イベントも作らない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "教えてください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;

    const gate = h.holdDm();
    const sending = h.press(`mimi:replywait:${draftId}`);
    await gate.entered;
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    gate.release();
    await sending;

    const after = h.row();
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
    expect(after.reply_deadline_at).toBeNull();
    expect(after.stage).not.toBe("awaiting_poster");
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_reply_wait'").get()).toEqual({ n: 0 });
    expect(h.lastReply().content).toContain("送信中にこのやり取りは終了していました");
  });

  // R10: staff 送信中に期限で自動終了
  it("送信中に期限で自動終了したら、その終了を維持して担当者へ知らせる", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "一度目。" });
    const first = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    await h.press(`mimi:replywait:${first}`);
    const deadline = h.row().reply_deadline_at!;

    // 二度目の返信を送っている最中に、期限が来て自動終了する
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "二度目。" });
    const second = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    const gate = h.holdDm();
    const sending = h.press(`mimi:replyend:${second}`);
    await gate.entered;
    expect(await closeExpiredSenderWaits(h.client as any, h.services, deadline + 1)).toBe(1);
    gate.release();
    await sending;

    const after = h.row();
    expect(after.closed_side).toBe("timeout");
    expect(after.close_reason).toBe("no_response");
    expect(h.lastReply().content).toContain("送信中にこのやり取りは終了していました");
    expect(h.lastReply().content).toContain("返答期限が過ぎて自動終了");
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_close'").get()).toEqual({ n: 1 });
  });
});

describe("会話本文を retention の外へ持ち出さない", () => {
  // P1
  it("届いた返信本文は DB から消え、監査メタだけが残る", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "秘密の返信です。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replyend:${draftId}`);

    const draft = h.services.confessions.getReplyDraft(draftId)!;
    expect(draft.body).toBeNull();
    expect(draft.outcome).toBe("delivered");
    expect(draft.staff_id).toBe(STAFF);
    // 本文が監査記録へ写っていないことも見る
    expect(JSON.stringify(h.db.prepare("SELECT * FROM events").all())).not.toContain("秘密の返信です");
  });

  it("届いた追記本文も DB から消える", async () => {
    const h = harness("yes");
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "秘密の追記です。" });
    const stored = h.db.prepare("SELECT body, outcome FROM confession_follow_ups").get() as any;
    expect(stored.outcome).toBe("delivered");
    expect(stored.body).toBeNull();
    expect(JSON.stringify(h.db.prepare("SELECT * FROM events").all())).not.toContain("秘密の追記です");
  });

  // P2
  it("届かなかった本文も、保持期限を過ぎたら消える", async () => {
    const h = harness("yes");
    h.setThreadFails(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "未引き渡しの秘密" });
    h.setThreadFails(false);
    h.setDmFails(true);
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "未達の秘密" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);

    const purgeAt = (h.db.prepare("SELECT MAX(body_purge_at) v FROM confession_follow_ups").get() as any).v as number;
    expect(purgeAt).not.toBeNull();
    const result = h.services.confessions.purgeExpiredConversationBodies(purgeAt);
    expect(result.followUps).toBe(1);
    expect(result.drafts).toBe(1);
    expect(h.db.prepare("SELECT body FROM confession_follow_ups").pluck().get()).toBeNull();
    expect(h.db.prepare("SELECT body FROM confession_reply_drafts").pluck().get()).toBeNull();
  });
});

describe("回答不要の人への約束は、最初から正確にする", () => {
  // U21: 投稿直後の DM を、実際の投稿経路を通して確認する
  it("回答不要でも「例外がありうる」ことを投稿直後に伝える", async () => {
    const h = harness("yes");
    await h.submit("mimi:body:soudan:no", "brand-new-sender", { text: "言いたいことだけ言います" });

    const dm = h.dmText();
    expect(dm).toContain("回答不要として受け付けました");
    expect(dm).toContain("原則として内容へのお返事はしません");
    expect(dm).toContain("安全上・運営上どうしても必要な連絡がある場合");
    // 「一切しません」と言い切らない
    expect(dm).not.toContain("こちらから内容へのお返事はしません");
    // 追記・終了の導線は回答不要でも出る
    const created = (h.db.prepare("SELECT MAX(id) v FROM confession_tickets").get() as any).v as number;
    expect(h.dmButtons()).toEqual([`mimi:reply:${created}`, `mimi:senderclose:${created}`]);
  });
});

describe("運営パネルの操作は絞られている", () => {
  it("会話の操作が1列目に並び、案件の取り回しは別の列にある", async () => {
    const h = harness("either");
    await h.press(`mimi:ack:${h.id}`); // パネルを描き直させる
    const rows = h.panelMessage.components.map((r: any) => (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id));
    expect(rows[0]).toEqual([
      `mimi:ack:${h.id}`,
      `mimi:replystaff:${h.id}`,
      `mimi:hold:${h.id}`,
      `mimi:close:${h.id}`,
    ]);
    expect(rows[1]).toContain(`mimi:assign:${h.id}`);
    expect(rows[1]).toContain(`mimi:emg:${h.id}`);
  });

  it("待機中は「待機」を押せない形で示す", async () => {
    const h = harness("yes");
    await h.press(`mimi:hold:${h.id}`);
    const hold = h.panelMessage.components
      .flatMap((r: any) => (r.toJSON ? r.toJSON() : r).components)
      .find((c: any) => c.custom_id === `mimi:hold:${h.id}`);
    expect(hold.disabled).toBe(true);
  });

  it("担当者でも管理者でもない人は会話の操作をできない", async () => {
    const h = harness("yes");
    await h.press(`mimi:ack:${h.id}`, "stranger");
    expect(h.row().acknowledged_at).toBeNull();
    await h.press(`mimi:hold:${h.id}`, "stranger");
    expect(h.row().stage).toBe("active");
  });
});

describe("新規投稿の受付DMは、結末を取り違えない", () => {
  const submitNew = async (h: ReturnType<typeof harness>, sender: string) =>
    h.submit("mimi:body:soudan:yes", sender, { text: "はじめての相談" });

  it("届いたときだけ「控えを送った」と言う", async () => {
    const h = harness("yes");
    await submitNew(h, "new-sender");
    expect(h.lastReply().content).toContain("DM に受付の控えを送った");
  });

  // U22
  it("DM が明確に失敗したら、控えを送ったと言わない", async () => {
    const h = harness("yes");
    h.setDmFails(true);
    await submitNew(h, "new-sender");

    const said = h.lastReply().content ?? "";
    expect(said).not.toContain("DM に受付の控えを送った");
    expect(said).toContain("DM を届けられなかった");
    expect(said).toContain("追記・終了のボタンも届いていない");
    // 声そのものは受け付けている
    expect(said).toContain("トートの耳に届いた");
    expect(h.dms).toHaveLength(0);
  });

  // U23
  it("DM の結果が分からないときは、届いたとも届かなかったとも断定しない", async () => {
    const h = harness("yes");
    h.setDmUnknown(true);
    await submitNew(h, "new-sender");

    const said = h.lastReply().content ?? "";
    expect(said).not.toContain("DM に受付の控えを送った");
    expect(said).not.toContain("DM を届けられなかった");
    expect(said).toContain("DM が届いたかは確認できなかった");
    expect(h.dms).toHaveLength(0);
  });
});

describe("担当者が対応を始める前の追記", () => {
  /** claim していない案件（投稿直後の実際の姿） */
  const unclaimed = () => {
    const h = harness("yes");
    h.db.prepare("UPDATE confession_tickets SET status='open', thread_id=NULL, panel_msg_id=NULL WHERE id=?").run(h.id);
    return h;
  };

  // U24
  it("宛先が無い追記は預かられ、試行回数を焼かず、担当がついてから1回だけ届く", async () => {
    const h = unclaimed();
    expect(h.row().thread_id).toBeNull();

    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "対応前に伝えたいこと" });

    // 「届けました」とは言わない。預かったことを正確に伝える
    const said = h.lastReply().content ?? "";
    expect(said).toContain("預かりました");
    expect(said).not.toContain("運営に届けました");
    expect(said).toContain("担当者がついた時点で");
    // Discord へは1通も出していない
    expect(h.threadPosts).toHaveLength(0);

    const pending = h.services.confessions.listUnrelayedFollowUps(h.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe("対応前に伝えたいこと");
    expect(pending[0].attempts).toBe(0);
    expect(h.services.confessions.followUpTriage(h.id)).toMatchObject({ notReady: 1, failed: 0, exhausted: 0 });

    // 刻時盤が10周しても、試行回数を1つも消費しない
    for (let i = 0; i < 10; i += 1) {
      expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(0);
    }
    expect(h.services.confessions.getFollowUp(pending[0].id)!.attempts).toBe(0);
    expect(h.services.confessions.followUpTriage(h.id)).toMatchObject({ notReady: 1, exhausted: 0 });

    // 担当者が対応を開始すると、次の巡回でちょうど1回届く
    h.services.confessions.claim(h.id, THREAD, STAFF);
    h.services.confessions.setPanelMsg(h.id, PANEL);
    expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(1);
    expect(h.threadPostTexts()).toContain("対応前に伝えたいこと");
    expect(h.services.confessions.getFollowUp(pending[0].id)!.body).toBeNull();
    expect(h.services.confessions.listUnrelayedFollowUps(h.id)).toEqual([]);

    // もう一周しても二重には届かない
    expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(0);
    expect(h.threadPostTexts().split("対応前に伝えたいこと").length - 1).toBe(1);
  });

  it("対応前の追記でも、期限は付かず自動終了もしない", async () => {
    const h = unclaimed();
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "対応前の追記" });
    expect(h.row().reply_deadline_at).toBeNull();
    const far = Math.floor(Date.now() / 1000) + 86_400 * 365;
    expect(await closeExpiredSenderWaits(h.client as any, h.services, far)).toBe(0);
    expect(h.row().status).not.toBe("closed");
  });
});

describe("未解決の追記に、運営の出口がある", () => {
  const stuckUnknown = async () => {
    const h = harness("yes");
    h.setThreadUnknown(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "行方不明の追記" });
    h.setThreadUnknown(false);
    return h;
  };

  // U25
  it("unknown はパネルから見え、重複を承知した操作でだけ送り直せる", async () => {
    const h = await stuckUnknown();
    // 自動では拾わない
    expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(0);

    // パネルに出口が出る
    const buttons = h.panelButtons();
    expect(buttons).toContain(`mimi:followup:${h.id}`);
    const embedText = JSON.stringify(
      h.panelMessage.embeds.map((e: any) => (e.toJSON ? e.toJSON() : e)),
    );
    expect(embedText).toContain("渡せたか不明");

    await h.press(`mimi:followup:${h.id}`);
    expect(h.lastReply().content).toContain("判断が必要な追記");

    const followUpId = h.services.confessions.listFollowUpsNeedingDecision(h.id)[0].id;
    await h.press(`mimi:followupretry:${followUpId}:${h.id}`);
    expect(h.threadPostTexts()).toContain("行方不明の追記");
    expect(h.services.confessions.listUnrelayedFollowUps(h.id)).toEqual([]);
    expect(h.panelButtons()).not.toContain(`mimi:followup:${h.id}`);
  });

  it("もう追わないと決めたら、届いたことにせず閉じられる", async () => {
    const h = await stuckUnknown();
    const followUpId = h.services.confessions.listFollowUpsNeedingDecision(h.id)[0].id;
    await h.press(`mimi:followupdone:${followUpId}:${h.id}`);

    const after = h.services.confessions.getFollowUp(followUpId)!;
    expect(after.outcome).toBe("resolved_manually");
    expect(after.body).toBeNull();
    expect(h.threadPostTexts()).toContain("対応済み");
    expect(h.threadPostTexts()).not.toContain("行方不明の追記");
    expect(h.services.confessions.followUpTriage(h.id).total).toBe(0);
  });

  // U26
  it("自動再試行の上限に達しても行き止まりにならない", async () => {
    const h = harness("yes");
    h.setThreadFails(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "何度も落ちる追記" });
    for (let i = 0; i < 10; i += 1) await retryPendingFollowUps(h.client as any, h.services);

    const triage = h.services.confessions.followUpTriage(h.id);
    expect(triage.exhausted).toBe(1);
    expect(await retryPendingFollowUps(h.client as any, h.services)).toBe(0);

    h.setThreadFails(false);
    const followUpId = h.services.confessions.listFollowUpsNeedingDecision(h.id)[0].id;
    await h.press(`mimi:followupretry:${followUpId}:${h.id}`);
    expect(h.threadPostTexts()).toContain("何度も落ちる追記");
    expect(h.services.confessions.followUpTriage(h.id).total).toBe(0);
  });

  it("追記の出口は担当者・管理者のみ", async () => {
    const h = await stuckUnknown();
    const followUpId = h.services.confessions.listFollowUpsNeedingDecision(h.id)[0].id;
    await h.press(`mimi:followupretry:${followUpId}:${h.id}`, "stranger");
    expect(h.threadPostTexts()).not.toContain("行方不明の追記");
    await h.press(`mimi:followupdone:${followUpId}:${h.id}`, "stranger");
    expect(h.services.confessions.getFollowUp(followUpId)!.outcome).toBe("unknown");
  });
});

describe("投稿者に最後に見えている DM が、成立した結末と一致する", () => {
  const stageReply = async (h: ReturnType<typeof harness>, text: string) => {
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text });
    return h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
  };

  it("成立したら、そのときだけ期限と操作を見せる", async () => {
    const h = harness("yes");
    const draftId = await stageReply(h, "確認しました。");
    await h.press(`mimi:replywait:${draftId}`);

    // 最初に届いたのは本文だけの中立な1通
    expect(h.dmVersionText(0)).toContain("確認しました。");
    expect(h.dmVersionText(0)).not.toContain("7日後");
    expect(h.dmVersionText(0)).not.toContain("必要なら追記できます");
    // 最終的に見えているのは、成立した状態
    expect(h.dmText()).toContain("必要なら追記できます");
    expect(h.dmText()).toContain("7日後");
    expect(h.dmButtons()).toEqual([`mimi:reply:${h.id}`, `mimi:senderclose:${h.id}`]);
  });

  // R18
  it("送信中に投稿者が終了したら、最後に見える DM が「既に終了しています」へ収束する", async () => {
    const h = harness("yes");
    const draftId = await stageReply(h, "もう少し状況を教えてください。");

    const gate = h.holdDm();
    const sending = h.press(`mimi:replywait:${draftId}`);
    await gate.entered;
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    gate.release();
    await sending;

    // 投稿者に最後に見えている「返信の」DM（終了通知の DM とは別の1通）
    const dmTextOf = (dm: Sent): string => {
      const e = dm.embeds?.[0];
      const json = e?.toJSON ? e.toJSON() : e;
      return [json?.description ?? "", ...(json?.fields ?? []).map((f: any) => f.value)].join("\n");
    };
    const finalReplyDm = h.dms.find((dm) => dmTextOf(dm).includes("もう少し状況を教えてください。"))!;
    expect(finalReplyDm).toBeDefined();
    const text = dmTextOf(finalReplyDm);
    expect(text).toContain("もう少し状況を教えてください。");
    expect(text).toContain("この返信は届きましたが、このやり取りは既に終了しています");
    expect(text).toContain("あなたが終了を選んだためです");
    // **「7日後に自動終了」を出さない**
    expect(text).not.toContain("7日後");
    expect(text).not.toContain("必要なら追記できます");
    // 開いているように見えるボタンも残さない
    expect((finalReplyDm.components ?? []).length).toBe(0);
    expect(h.row().closed_side).toBe("sender");
  });

  // R19
  it("送信中に期限で終了したら、最後に見える DM が期限による終了へ収束する", async () => {
    const h = harness("yes");
    const first = await stageReply(h, "一度目。");
    await h.press(`mimi:replywait:${first}`);
    const deadline = h.row().reply_deadline_at!;

    const second = await stageReply(h, "二度目。");
    const gate = h.holdDm();
    const sending = h.press(`mimi:replyend:${second}`);
    await gate.entered;
    expect(await closeExpiredSenderWaits(h.client as any, h.services, deadline + 1)).toBe(1);
    gate.release();
    await sending;

    const last = h.dms[h.dms.length - 1];
    const json = last.embeds?.[0]?.toJSON ? last.embeds[0].toJSON() : last.embeds?.[0];
    const text = [json?.description ?? "", ...(json?.fields ?? []).map((f: any) => f.value)].join("\n");
    // 期限終了の案内 DM か、収束した返信 DM のどちらかが最後に見えている。
    // どちらであっても「7日後に終了します」とは言っていない
    expect(h.dmVersions.map((v) => {
      const e = v.embeds?.[0];
      const j = e?.toJSON ? e.toJSON() : e;
      return [j?.description ?? "", ...(j?.fields ?? []).map((f: any) => f.value)].join("\n");
    }).some((t) => t.includes("この返信は届きましたが、このやり取りは既に終了しています"))).toBe(true);
    expect(text).not.toContain("7日後");
    expect(h.row().closed_side).toBe("timeout");
  });

  it("最終形へ書き換えられなかったときも、中立な本文のまま嘘をつかない", async () => {
    const h = harness("yes");
    const draftId = await stageReply(h, "本文だけ届く返信。");
    h.setEditFails(true);
    await h.press(`mimi:replywait:${draftId}`);

    // 投稿者には本文だけが見えている（期限も操作も書かれていない）
    expect(h.dmText()).toContain("本文だけ届く返信。");
    expect(h.dmText()).not.toContain("7日後");
    // 担当者には書き換えられなかったことを伝える
    expect(h.lastReply().content).toContain("書き足せませんでした");
    // 会話の状態そのものは成立している
    expect(h.row().reply_deadline_at).not.toBeNull();
  });
});

describe("緊急対応は、会話の終了だけでは解決しない", () => {
  const withEmergency = (h: ReturnType<typeof harness>) =>
    h.services.confessions.createEmergency({
      confessionId: h.id,
      createdBy: STAFF,
      reason: "危険が続いている",
      target: "対象",
      dangerOngoing: true,
      measures: "watch",
      reviewNote: null,
      note: null,
    });

  // E1
  it("投稿者が終了しても緊急対応は open のままで、スレッドも畳まない", async () => {
    const h = harness("yes");
    const emg = withEmergency(h);
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);

    expect(h.row().status).toBe("closed");
    expect(h.services.confessions.getEmergency(emg.id)!.status).toBe("open");
    // 運営が見失わないよう、アーカイブしない
    expect(h.thread.setArchived).not.toHaveBeenCalled();
    expect(h.threadPostTexts()).toContain("緊急対応が未解決です");
  });

  // E2
  it("期限による自動終了でも緊急対応は open のまま", async () => {
    const h = harness("yes");
    const emg = withEmergency(h);
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "お返事ください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    const deadline = h.row().reply_deadline_at!;

    expect(await closeExpiredSenderWaits(h.client as any, h.services, deadline + 1)).toBe(1);
    expect(h.services.confessions.getEmergency(emg.id)!.status).toBe("open");
    expect(h.thread.setArchived).not.toHaveBeenCalled();
  });

  it("緊急対応が無ければ、これまで通りアーカイブする", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    expect(h.thread.setArchived).toHaveBeenCalled();
  });
});

describe("投稿者が終わらせた会話を、あとからの「対応する」が開き直さない", () => {
  /** 実際の投稿直後と同じ姿（未対応・スレッド無し） */
  const unclaimed = () => {
    const h = harness("yes");
    h.db.prepare("UPDATE confession_tickets SET status='open', thread_id=NULL, panel_msg_id=NULL WHERE id=?").run(h.id);
    // 準備で作った claim の記録は、この試験の観測対象ではないので消しておく
    h.db.prepare("DELETE FROM events WHERE type='confession_claim'").run();
    return h;
  };

  const claimInteraction = (h: ReturnType<typeof harness>, opts: { gate?: Promise<void> } = {}) => {
    const created: { id: string; archived: boolean; deleted: boolean }[] = [];
    const channel = {
      type: ChannelType.GuildText,
      threads: {
        create: async () => {
          if (opts.gate) await opts.gate;
          const t = { id: `new-thread-${created.length}`, archived: false, deleted: false };
          created.push(t);
          return {
            id: t.id,
            isThread: () => true,
            send: async (o: Sent) => {
              h.threadPosts.push(o);
              return { id: "new-panel" };
            },
            setArchived: async () => {
              t.archived = true;
            },
            delete: async () => {
              t.deleted = true;
            },
            messages: { fetch: async () => null },
          };
        },
      },
    };
    return { created, channel };
  };

  // C1
  it("対応開始前に投稿者が終了していたら、開き直さず作ったスレッドも片付ける", async () => {
    const h = unclaimed();
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    const sealed = h.row();
    expect(sealed.closed_side).toBe("sender");

    const { created, channel } = claimInteraction(h);
    await handleConfessionButton(
      { ...h.interactionFor(`mimi:claim:${h.id}`, STAFF), channel } as any,
      h.services,
    );

    const after = h.row();
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
    expect(after.close_reason).toBe("poster_ended");
    expect(after.closed_at).toBe(sealed.closed_at);
    expect(after.thread_id).toBeNull(); // 結ばれていない
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_claim'").get()).toEqual({ n: 0 });
    // 作ってしまったスレッドは片付ける
    expect(created[0]?.deleted || created[0]?.archived).toBe(true);
    expect(h.lastReply().content).toContain("投稿者側ですでに終了しています");
  });

  // C2: スレッド作成の境界で投稿者が終了する
  it("スレッドを作っている最中に投稿者が終了しても、終了が正本のまま", async () => {
    const h = unclaimed();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { created, channel } = claimInteraction(h, { gate });

    const claiming = handleConfessionButton(
      { ...h.interactionFor(`mimi:claim:${h.id}`, STAFF), channel } as any,
      h.services,
    );
    // スレッドができる前に投稿者が終了する
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    release();
    await claiming;

    const after = h.row();
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
    expect(after.thread_id).toBeNull();
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_claim'").get()).toEqual({ n: 0 });
    expect(created[0]?.deleted || created[0]?.archived).toBe(true);
  });

  // B8: 未処理の内容があるときは、再開せずに宛先だけ結ぶ
  it("終了済みでも未処理の追記があれば、再開せずスレッドを結んで受け取れる", async () => {
    const h = unclaimed();
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "終了前に送った追記" });
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);

    const { channel } = claimInteraction(h);
    await handleConfessionButton(
      { ...h.interactionFor(`mimi:claim:${h.id}`, STAFF), channel } as any,
      h.services,
    );

    const after = h.row();
    // **開き直していない**
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
    // それでも宛先はできた
    expect(after.thread_id).not.toBeNull();
    expect(h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_claim'").get()).toEqual({ n: 0 });
    expect(h.lastReply().content).toContain("再開はしていません");
    expect(h.threadPostTexts()).toContain("投稿者側で既に終了しています");
    // 預かった追記が渡せる状態になる
    expect(h.services.confessions.listRelayableFollowUps()).toHaveLength(1);
  });

  it("担当開始のスレッドは「内部メモ」だと案内する", async () => {
    const h = unclaimed();
    const { channel } = claimInteraction(h);
    await handleConfessionButton(
      { ...h.interactionFor(`mimi:claim:${h.id}`, STAFF), channel } as any,
      h.services,
    );
    expect(h.threadPostTexts()).toContain("内部メモ");
    expect(h.threadPostTexts()).toContain("返信する");
    expect(h.threadPostTexts()).not.toContain("このスレッドに書くと、トートが投稿者の DM へ匿名で届けます");
  });
});

describe("別案件のIDを添えても、その内容へは届かない", () => {
  /** 権限のある案件 A と、権限の無い案件 B */
  const twoCases = async () => {
    const h = harness("yes");
    const bId = h.services.confessions.create("sender-2", { type: "soudan", replyWish: "yes", body: "B の本文" }).id;
    h.services.confessions.claim(bId, "thread-b", "other-staff");
    const f = h.services.confessions.recordSenderFollowUp(bId, "sender-2", "Bだけの秘密", 90) as {
      ok: true;
      followUpId: number;
    };
    h.services.confessions.claimFollowUpRelay(f.followUpId);
    h.services.confessions.settleFollowUpRelay({
      followUpId: f.followUpId,
      generation: h.services.confessions.getFollowUp(f.followUpId)!.generation,
      outcome: "unknown",
    });
    const draft = h.services.confessions.createReplyDraft(bId, "other-staff", "Bへの返信", 90);
    h.services.confessions.claimReplyDraft(draft.id, "other-staff", "wait");
    h.services.confessions.finishReplyDraft({
      draftId: draft.id,
      generation: h.services.confessions.getReplyDraft(draft.id)!.generation,
      outcome: "unknown",
    });
    return { h, bId, followUpId: f.followUpId, draftId: draft.id };
  };

  // S1
  it("別案件の追記を、権限のある案件のスレッドへ流せない", async () => {
    const { h, bId, followUpId } = await twoCases();
    await h.press(`mimi:followupretry:${followUpId}`, STAFF);

    // B の本文はどこへも出ていない
    expect(h.threadPostTexts()).not.toContain("Bだけの秘密");
    expect(JSON.stringify(h.replies)).not.toContain("Bだけの秘密");
    // B も A も変わらない
    expect(h.services.confessions.getFollowUp(followUpId)!.outcome).toBe("unknown");
    expect(h.services.confessions.getFollowUp(followUpId)!.body).toBe("Bだけの秘密");
    expect(h.services.confessions.followUpTriage(h.id).total).toBe(0);
    expect(h.lastReply().content).toContain("担当者または管理者のみ");
    void bId;
  });

  // S2
  it("別案件の追記を、手動決着もできない", async () => {
    const { h, followUpId } = await twoCases();
    await h.press(`mimi:followupdone:${followUpId}`, STAFF);
    expect(h.services.confessions.getFollowUp(followUpId)!.outcome).toBe("unknown");
    expect(h.services.confessions.getFollowUp(followUpId)!.resolved_at).toBeNull();
    expect(h.lastReply().content).toContain("担当者または管理者のみ");
  });

  // S3
  it("select の値が別案件のIDでも拒否する", async () => {
    const { h, followUpId } = await twoCases();
    await handleConfessionStringSelect(
      { ...h.interactionFor(`mimi:followupsel:${h.id}`, STAFF), values: [String(followUpId)] } as any,
      h.services,
    );
    expect(h.lastReply().content).toContain("担当者または管理者のみ");
    expect(JSON.stringify(h.replies)).not.toContain("Bだけの秘密");
  });

  it("別案件の未確定返信も、送り直せず畳めない", async () => {
    const { h, draftId } = await twoCases();
    await h.press(`mimi:draftretry:${draftId}`, STAFF);
    expect(h.dms).toHaveLength(0);
    expect(h.services.confessions.getReplyDraft(draftId)!.body).toBe("Bへの返信");
    await h.press(`mimi:draftdone:${draftId}`, STAFF);
    expect(h.services.confessions.getReplyDraft(draftId)!.outcome).toBe("unknown");
  });
});

describe("未確定の返信にも、重複を承知した出口がある", () => {
  const stuck = async (h: ReturnType<typeof harness>, mode: "unknown" | "failed") => {
    if (mode === "unknown") h.setDmUnknown(true);
    else h.setDmFails(true);
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "届いたか分からない返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    h.setDmUnknown(false);
    h.setDmFails(false);
    return draftId;
  };

  it("未確定の返信はパネルに出口として現れる", async () => {
    const h = harness("yes");
    await stuck(h, "unknown");
    expect(h.panelButtons()).toContain(`mimi:draftdecide:${h.id}`);
    const embedText = JSON.stringify(h.panelMessage.embeds.map((e: any) => (e.toJSON ? e.toJSON() : e)));
    expect(embedText).toContain("未確定の返信");
  });

  it("不明のときは、二重に届く可能性を必ず示してから送り直す", async () => {
    const h = harness("yes");
    const draftId = await stuck(h, "unknown");

    await h.press(`mimi:draftdecide:${h.id}`);
    expect(h.lastReply().content).toContain("判断が必要な返信");

    await handleConfessionStringSelect(
      { ...h.interactionFor(`mimi:draftsel:${h.id}`, STAFF), values: [String(draftId)] } as any,
      h.services,
    );
    const warn = h.lastReply().content ?? "";
    expect(warn).toContain("既に届いている可能性");
    expect(warn).toContain("二重に届くことがあります");
    const buttons = (h.lastReply().components ?? []).flatMap((r: any) =>
      (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id),
    );
    expect(buttons).toEqual([`mimi:draftretry:${draftId}`, `mimi:draftdone:${draftId}`]);

    await h.press(`mimi:draftretry:${draftId}`);
    expect(h.dms).toHaveLength(1);
    expect(h.dmText()).toContain("届いたか分からない返信");
    expect(h.row().reply_deadline_at).not.toBeNull();
  });

  it("これ以上送らないと決めても、届いたことにはしない", async () => {
    const h = harness("yes");
    const draftId = await stuck(h, "unknown");
    await h.press(`mimi:draftdone:${draftId}`);

    const after = h.services.confessions.getReplyDraft(draftId)!;
    expect(after.outcome).toBe("resolved_manually");
    expect(after.outcome).not.toBe("delivered");
    expect(after.body).toBeNull();
    expect(h.dms).toHaveLength(0);
    expect(h.threadPostTexts()).toContain("届いたことにはしていません");
    expect(h.panelButtons()).not.toContain(`mimi:draftdecide:${h.id}`);
  });
});

describe("投稿者に見えている表示は、再起動しても最終形へ収束する", () => {
  // R20
  it("編集の前に落ちても、同じメッセージが期限つきの最終形へ収束する", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "確認しました。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    // 編集だけが落ちた＝収束の指示は残るが反映されていない、という状況
    h.setEditFails(true);
    await h.press(`mimi:replywait:${draftId}`);

    expect(h.dmText()).toContain("確認しました。");
    expect(h.dmText()).not.toContain("7日後"); // まだ嘘をついていない
    expect(h.services.confessions.pendingRendersFor(h.id)).toHaveLength(1);
    const before = h.dms.length;

    // 起動時／刻時盤の収束
    h.setEditFails(false);
    expect(await convergePendingRenders(h.client as any, h.services)).toBe(1);

    expect(h.dmText()).toContain("必要なら追記できます");
    expect(h.dmText()).toContain("7日後");
    expect(h.dmButtons()).toEqual([`mimi:reply:${h.id}`, `mimi:senderclose:${h.id}`]);
    // **新しい DM は増えない**（同じメッセージを直しただけ）
    expect(h.dms).toHaveLength(before);
    expect(h.services.confessions.pendingRendersFor(h.id)).toEqual([]);
  });

  // R21
  it("終了で確定した場合も、同じメッセージが終了の表示へ収束する", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "対応しました。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    h.setEditFails(true);
    await h.press(`mimi:replyend:${draftId}`);
    const before = h.dms.length;

    h.setEditFails(false);
    expect(await convergePendingRenders(h.client as any, h.services)).toBe(1);
    expect(h.dmText()).toContain("対応しました。");
    expect(h.dmText()).toContain("このやり取りはここで終了しました");
    expect(h.dmButtons()).toEqual([]);
    expect(h.dms).toHaveLength(before);
  });

  // R22
  it("競合に負けた場合も、終了済みの表示へ収束する", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "もう少し教えてください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    h.setEditFails(true);
    const gate = h.holdDm();
    const sending = h.press(`mimi:replywait:${draftId}`);
    await gate.entered;
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    gate.release();
    await sending;

    h.setEditFails(false);
    expect(await convergePendingRenders(h.client as any, h.services)).toBe(1);
    const replyDm = h.dms.find((dm) => {
      const e = dm.embeds?.[0];
      const j = e?.toJSON ? e.toJSON() : e;
      return (j?.description ?? "").includes("もう少し教えてください。");
    })!;
    const j = replyDm.embeds?.[0]?.toJSON ? replyDm.embeds[0].toJSON() : replyDm.embeds?.[0];
    const text = [j?.description ?? "", ...(j?.fields ?? []).map((f: any) => f.value)].join("\n");
    expect(text).toContain("この返信は届きましたが、このやり取りは既に終了しています");
    expect(text).not.toContain("7日後");
    expect((replyDm.components ?? []).length).toBe(0);
  });

  // R23
  it("書き換えられなかったことは、会話の真実を壊さずに担当者から見える", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "本文だけ届く返信。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    h.setEditFails(true);
    await h.press(`mimi:replywait:${draftId}`);

    // 会話そのものは正しく確定している
    expect(h.row().reply_deadline_at).not.toBeNull();
    expect(h.row().stage).toBe("awaiting_poster");
    // 投稿者には本文だけが見えている（嘘は出ていない）
    expect(h.dmText()).not.toContain("7日後");
    // 担当者からは未収束として見える
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(1);
    // **その場で操作した本人には、すぐ伝える**（今回の1通の結果として）
    expect(h.lastReply().content).toContain("書き足せませんでした");
    // ただし、まだ自動で直せる余地がある段階でスレッドへ警告は積まない
    expect(h.threadPostTexts()).not.toContain("自動では最終形へ書き換えられませんでした");
  });
});

describe("終了しても、届いた内容は運営から見えなくならない", () => {
  it("未処理の追記を抱えたまま終了しても、スレッドを畳まない", async () => {
    const h = harness("yes");
    h.setThreadUnknown(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "行方不明の追記" });
    h.setThreadUnknown(false);

    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    expect(h.row().status).toBe("closed");
    expect(h.thread.setArchived).not.toHaveBeenCalled();
    expect(h.threadPostTexts()).toContain("未処理のものが残っている");
    expect(h.threadPostTexts()).toContain("追記 1件");
  });

  it("終了済みのパネルでも、未確定の追記・返信の出口が消えない", async () => {
    const h = harness("yes");
    h.setThreadUnknown(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "行方不明の追記" });
    h.setThreadUnknown(false);
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);

    expect(h.panelButtons()).toContain(`mimi:followup:${h.id}`);
    // 終了済みでも処理できる
    const followUpId = h.services.confessions.listFollowUpsNeedingDecision(h.id)[0].id;
    await h.press(`mimi:followupretry:${followUpId}`);
    expect(h.threadPostTexts()).toContain("行方不明の追記");
    expect(h.services.confessions.obligations(h.id).total).toBe(0);
  });

  it("すべて片付いた終了なら、これまで通り畳む", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    expect(h.thread.setArchived).toHaveBeenCalled();
  });
});

describe("試行の世代は、本番の経路でも効いている", () => {
  /**
   * **Core を直接正しく呼ぶだけでは、本番の配線漏れは見つからない。**
   * ここは実際のハンドラ（投稿者の追記 / 刻時盤の再中継 / 担当者の返信）を通し、
   * 置き換わった古い試行の結果が、新しい試行の結末を塗り替えないことを見る。
   */
  const followUpId = (h: ReturnType<typeof harness>) =>
    h.db.prepare("SELECT id FROM confession_follow_ups ORDER BY id").pluck().get() as number;

  /**
   * **古い試行と新しい試行が、同時に飛んでいる状態を作る。**
   *
   * 片方が終わってから帰ってくるだけなら `outcome='sending'` の条件が働くので、
   * 世代の門を外しても誰も気づかない。門が本当に効いているかは、
   * 「新しい試行がまだ送信中のうちに、古い callback が帰る」でしか見えない。
   */

  // R28a: 投稿者の追記（本番の初回経路）
  it("追記の送り直しが飛んでいる最中に古い callback が帰っても、決着は新しい試行のもの", async () => {
    const h = harness("yes");
    const first = h.holdThread();
    const submitting = h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "世代の試験" });
    await first.entered; // 「中継の途中」に確実に入っている

    const fid = followUpId(h);
    const gen1 = h.services.confessions.getFollowUp(fid)!.generation;

    // 所有者が落ちた前提の回収。この送信はもう誰も見届けない
    expect(h.sweepDeadOwners().followUps).toBe(1);
    expect(h.services.confessions.getFollowUp(fid)!.outcome).toBe("unknown");

    // 担当者が重複を承知で送り直す（世代2）。**こちらもまだ飛んでいる**
    const second = h.holdThread();
    const retrying = h.press(`mimi:followupretry:${fid}`);
    await second.entered;
    const gen2 = h.services.confessions.getFollowUp(fid)!.generation;
    expect(gen2).toBeGreaterThan(gen1);
    expect(h.services.confessions.getFollowUp(fid)!.outcome).toBe("sending");

    // 世代1が「渡せたか分からない」で帰る。世代2はまだ送信中
    first.release("net");
    await submitting;
    // 世代2が渡せた
    second.release("ok");
    await retrying;

    const settled = h.services.confessions.getFollowUp(fid)!;
    // 古い試行の「不明」が、新しい試行の「渡せた」を塗り潰していない
    expect(settled.generation).toBe(gen2);
    expect(settled.outcome).toBe("delivered");
    expect(settled.relayed_at).not.toBeNull();
    expect(settled.body).toBeNull();
    // 渡し終えたものが、判断待ちとして残り続けない
    expect(h.services.confessions.listFollowUpsNeedingDecision(h.id)).toEqual([]);
    expect(h.services.confessions.obligations(h.id).followUps).toBe(0);
  });

  // R28b: 刻時盤の再中継経路
  it("刻時盤の再中継が飛んでいる最中に古い callback が帰っても、決着は新しい試行のもの", async () => {
    const h = harness("yes");
    h.setThreadFails(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "刻時盤の試験" });
    h.setThreadFails(false);
    const fid = followUpId(h);
    expect(h.services.confessions.getFollowUp(fid)!.outcome).toBe("failed");

    // 刻時盤が拾って再中継（世代2）。まだ飛んでいる
    const sweep = h.holdThread();
    const sweeping = retryPendingFollowUps(h.client as any, h.services);
    await sweep.entered;
    const genSweep = h.services.confessions.getFollowUp(fid)!.generation;

    expect(h.sweepDeadOwners().followUps).toBe(1);

    // 担当者が送り直す（世代3）。**こちらもまだ飛んでいる**
    const manual = h.holdThread();
    const retrying = h.press(`mimi:followupretry:${fid}`);
    await manual.entered;
    const genManual = h.services.confessions.getFollowUp(fid)!.generation;
    expect(genManual).toBeGreaterThan(genSweep);
    expect(h.services.confessions.getFollowUp(fid)!.outcome).toBe("sending");

    sweep.release("net");
    await sweeping;
    manual.release("ok");
    await retrying;

    const settled = h.services.confessions.getFollowUp(fid)!;
    expect(settled.generation).toBe(genManual);
    expect(settled.outcome).toBe("delivered");
    expect(settled.relayed_at).not.toBeNull();
    expect(h.services.confessions.listFollowUpsNeedingDecision(h.id)).toEqual([]);
  });

  // R29a: 返信の世代（本番の返信経路）
  it("返信の送信中に回収が入っても、古い callback は会話を動かさない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "世代のある返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;

    const gate = h.holdDm();
    const sending = h.press(`mimi:replywait:${draftId}`);
    await gate.entered;
    const gen1 = h.services.confessions.getReplyDraft(draftId)!.generation;

    expect(h.sweepDeadOwners().replyDrafts).toBe(1);
    expect(h.services.confessions.getReplyDraft(draftId)!.outcome).toBe("unknown");

    // 担当者が送り直す（世代2）。ここで会話が「返答待ち」になる
    await h.press(`mimi:draftretry:${draftId}`);
    const gen2 = h.services.confessions.getReplyDraft(draftId)!.generation;
    expect(gen2).toBeGreaterThan(gen1);
    const afterRetry = h.row();
    expect(afterRetry.reply_deadline_at).not.toBeNull();

    // 世代1の callback が「届いた」で帰ってくる
    gate.release();
    await sending;

    // 会話は世代2の結果のまま。期限を引き直しもしない
    const after = h.row();
    expect(after.status).toBe(afterRetry.status);
    expect(after.reply_deadline_at).toBe(afterRetry.reply_deadline_at);
    expect(h.services.confessions.getReplyDraft(draftId)!.generation).toBe(gen2);
  });

  // R29b: 置き換わった試行を「終了していた」と言わない
  it("置き換わった試行は、終わっていない会話を「終了していた」と言わない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "本文" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    const gate = h.holdDm();
    const sending = h.press(`mimi:replywait:${draftId}`);
    await gate.entered;
    h.sweepDeadOwners();
    await h.press(`mimi:draftretry:${draftId}`);
    gate.release();
    await sending;

    const said = h.lastReply().content ?? "";
    expect(said).toContain("置き換わって");
    // 会話は終わっていない。終わったとは言わない
    expect(h.row().status).not.toBe("closed");
    expect(said).not.toContain("このやり取りは終了していました");
    expect(h.threadPostTexts()).not.toContain("このやり取りが終了していました");
  });

  // R29c: 現役の世代だけが確定できる
  it("古い世代の確定は、会話にも本文にも触れない", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "本文" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    const claim = h.services.confessions.claimReplyDraft(draftId, STAFF, "wait");
    expect(claim.ok).toBe(true);
    const gen = h.services.confessions.getReplyDraft(draftId)!.generation;

    const stale = h.services.confessions.finalizeStaffReply({
      draftId,
      generation: gen - 1,
      intent: "wait",
      actorId: STAFF,
    });
    expect(stale.transition).toBe("superseded");
    expect(h.row().reply_deadline_at).toBeNull();
    expect(h.services.confessions.getReplyDraft(draftId)!.body).toBe("本文"); // 本文も消えていない

    const live = h.services.confessions.finalizeStaffReply({
      draftId,
      generation: gen,
      intent: "wait",
      actorId: STAFF,
    });
    expect(live.transition).toBe("waiting");
    expect(h.row().reply_deadline_at).not.toBeNull();
  });
});

describe("収束の途中で落ちても、同じメッセージが最終形へ向かう", () => {
  /** 編集だけが落ちた状態（収束の指示だけが残る）を作る */
  const staged = async (h: ReturnType<typeof harness>, body = "本文だけ届く返信。") => {
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: body });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    h.setEditFails(true);
    await h.press(`mimi:replywait:${draftId}`);
    h.setEditFails(false);
    return draftId;
  };

  /**
   * ここは**同じ service が自分の行を回収する**形なので、「所有者が死んだ」ことの
   * 証拠にはならない（自分の行は live から除かれるので必ず取れる）。見ているのは
   * 「`rendering` は通常の掃きに拾われない」「回収後は同じメッセージへ収束する」の2点。
   *
   * 別インスタンスの死・貸出切れ・引き取りは
   * `confession-startup-recovery.test.ts` で、実ファイルDBを開き直して確かめる。
   */
  // R30（プロセス内の部分）
  it("収束中のものは通常の掃きに拾われず、回収後は同じメッセージへ収束する", async () => {
    const h = harness("yes");
    await staged(h);

    // 収束の所有権を取った直後に落ちた、という状況
    const render = h.services.confessions.pendingRendersFor(h.id)[0]!;
    expect(h.services.confessions.claimRender(render.id)).toBeTruthy();
    expect(h.services.confessions.listStalledRenders()).toHaveLength(1);
    // この状態では通常の掃きは拾わない（誰かが実行中かもしれない）
    expect(await convergePendingRenders(h.client as any, h.services)).toBe(0);

    // 所有者の死が確かめられたら再開できる
    expect(h.sweepDeadOwners().renders).toBe(1);

    const before = h.dms.length;
    expect(await convergePendingRenders(h.client as any, h.services)).toBe(1);
    expect(h.dmText()).toContain("必要なら追記できます");
    expect(h.dms).toHaveLength(before); // **新しい DM は増えない**
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(0);
  });

  it("まだ生きている所有者の収束は奪わない", async () => {
    const h = harness("yes");
    await staged(h);
    const render = h.services.confessions.pendingRendersFor(h.id)[0]!;

    // 別プロセスが収束を握り、鼓動を打ち続けている
    const other = new Confessions(h.db, h.services.events, "other-live-instance");
    const claimed = other.claimRender(render.id)!;
    expect(claimed).toBeTruthy();

    // いまこの瞬間の掃きでは、鼓動が生きているので触らない
    expect(h.services.confessions.recoverOrphanedEffects("system:sweep").renders).toBe(0);
    expect(h.services.confessions.listStalledRenders()).toHaveLength(1);
    // 決着も奪えない（世代が合っていても所有者が違う）
    expect(
      h.services.confessions.settleRender({ renderId: render.id, generation: claimed.generation, state: "settled" }).won,
    ).toBe(false);
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(1);
  });
});

describe("収束先は、凍結した希望ではなく、いまの案件から導く", () => {
  const staged = async (h: ReturnType<typeof harness>) => {
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "もう少し教えてください。" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    h.setEditFails(true);
    await h.press(`mimi:replywait:${draftId}`);
    h.setEditFails(false);
    return draftId;
  };
  /** 返信本文が入っている DM（収束後も本文は現物から拾われる） */
  const replyDm = (h: ReturnType<typeof harness>) => {
    const dm = h.dms.find((d) => {
      const e = d.embeds?.[0];
      const j = e?.toJSON ? e.toJSON() : e;
      return (j?.description ?? "").includes("もう少し教えてください。");
    })!;
    const j = dm.embeds?.[0]?.toJSON ? dm.embeds[0].toJSON() : dm.embeds?.[0];
    return { text: [j?.description ?? "", ...(j?.fields ?? []).map((f: any) => f.value)].join("\n"), dm };
  };

  // R31
  it("待機で積まれたあと投稿者が終了したら、終了の表示へ収束する", async () => {
    const h = harness("yes");
    await staged(h);
    // 収束が済む前に投稿者が終了する
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    expect(await convergePendingRenders(h.client as any, h.services)).toBe(1);

    const { text, dm } = replyDm(h);
    expect(text).toContain("この返信は届きましたが、このやり取りは既に終了しています");
    expect(text).toContain("あなたが終了を選んだためです");
    // 終わった会話へ「開いている」案内も期限も出さない
    expect(text).not.toContain("必要なら追記できます");
    expect(text).not.toContain("自動で終了します");
    expect((dm.components ?? []).length).toBe(0);
  });

  // R32
  it("待機で積まれたあと期限で終了したら、期限による終了の表示へ収束する", async () => {
    const h = harness("yes");
    await staged(h);
    const deadline = h.row().reply_deadline_at!;
    expect(await closeExpiredSenderWaits(h.client as any, h.services, deadline + 1)).toBe(1);
    await convergePendingRenders(h.client as any, h.services);

    const { text, dm } = replyDm(h);
    expect(text).toContain("この返信は届きましたが、このやり取りは既に終了しています");
    expect(text).toContain("返答の期限が過ぎたためです");
    expect(text).not.toContain("自動で終了します");
    expect((dm.components ?? []).length).toBe(0);
  });

  // R33
  it("期限が解除されていたら、古い期限を描かない", async () => {
    const h = harness("yes");
    await staged(h);
    const oldDeadline = h.row().reply_deadline_at!;

    // 投稿者が追記し、番が運営へ戻る（期限は解除される）
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "追記します" });
    expect(h.row().reply_deadline_at).toBeNull();

    await convergePendingRenders(h.client as any, h.services);
    const { text } = replyDm(h);
    // 追記・終了はできるが、**もう無い期限**は描かない
    expect(text).toContain("必要なら追記できます");
    expect(text).not.toContain("自動で終了します");
    expect(text).not.toContain(`<t:${oldDeadline}:R>`);
  });
});

describe("誰が操作したのかを、記録が取り違えない", () => {
  const OTHER_STAFF = "staff-2";

  // B5
  it("別の担当者が未確定の返信を送り直したら、終わらせたのはその人になる", async () => {
    const h = harness("yes");
    // A（STAFF）が下書きを書き、届いたか分からないまま残る
    h.setDmUnknown(true);
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "Aが書いた返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replyend:${draftId}`);
    h.setDmUnknown(false);
    expect(h.services.confessions.getReplyDraft(draftId)!.staff_id).toBe(STAFF);
    expect(h.row().status).not.toBe("closed");

    // B が正規の担当として送り直す
    h.services.confessions.addAssignee(h.id, OTHER_STAFF, STAFF);
    await h.press(`mimi:draftretry:${draftId}`, OTHER_STAFF);

    const draft = h.services.confessions.getReplyDraft(draftId)!;
    expect(draft.staff_id).toBe(STAFF); // 本文を書いたのは A のまま
    expect(draft.executed_by).toBe(OTHER_STAFF); // 実際に送ったのは B

    // 会話を終わらせたのも B。監査記録もスレッドの記録も一致する
    const row = h.row();
    expect(row.status).toBe("closed");
    expect(row.closed_by).toBe(OTHER_STAFF);
    const closeEvent = h.db
      .prepare("SELECT actor_id FROM events WHERE type='confession_close' ORDER BY id DESC LIMIT 1")
      .get() as { actor_id: string };
    expect(closeEvent.actor_id).toBe(OTHER_STAFF);
    expect(h.threadPostTexts()).toContain(`<@${OTHER_STAFF}>`);
    expect(h.threadPostTexts()).not.toContain(`<@${STAFF}> が未確定だった返信`);
  });

  it("最初に送った担当者が終わらせたなら、その人のまま", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "本文" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:replyend:${draftId}`);
    expect(h.row().closed_by).toBe(STAFF);
    expect(h.services.confessions.getReplyDraft(draftId)!.executed_by).toBe(STAFF);
  });
});

describe("終わった会話から、担当者が新しい送信を始められない", () => {
  /** 届いたか分からない／届かなかった返信を1つ残す */
  const stuck = async (h: ReturnType<typeof harness>, mode: "unknown" | "failed") => {
    if (mode === "unknown") h.setDmUnknown(true);
    else h.setDmFails(true);
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "未確定の返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    h.setDmUnknown(false);
    h.setDmFails(false);
    return draftId;
  };

  // R36a / R36b
  for (const mode of ["failed", "unknown"] as const) {
    it(`${mode} の返信は、投稿者が終了したあと送り直せない`, async () => {
      const h = harness("yes");
      const draftId = await stuck(h, mode);
      await h.press(`mimi:senderclosego:${h.id}`, SENDER);
      const dmsAfterClose = h.dms.length;
      const before = h.services.confessions.getReplyDraft(draftId)!;

      await h.press(`mimi:draftretry:${draftId}`);

      // **新しい DM は1通も出ない**
      expect(h.dms).toHaveLength(dmsAfterClose);
      const after = h.services.confessions.getReplyDraft(draftId)!;
      expect(after.outcome).toBe(before.outcome);
      expect(after.generation).toBe(before.generation);
      expect(after.body).toBe("未確定の返信");
      // 会話も終わったまま
      expect(h.row().status).toBe("closed");
      expect(h.row().closed_side).toBe("sender");
      // 担当者には理由と出口が示される
      const said = h.lastReply().content ?? "";
      expect(said).toContain("既に終了している");
      expect(said).toContain("再オープン");
    });
  }

  it("終了済みの画面には「もう一度送る」を出さない（出口は残す）", async () => {
    const h = harness("yes");
    const draftId = await stuck(h, "unknown");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);

    // 未確定の返信の出口そのものは消えない
    expect(h.panelButtons()).toContain(`mimi:draftdecide:${h.id}`);
    await h.press(`mimi:draftdecide:${h.id}`);
    await handleConfessionStringSelect(
      { ...h.interactionFor(`mimi:draftsel:${h.id}`, STAFF), values: [String(draftId)] } as any,
      h.services,
    );
    const buttons = (h.lastReply().components ?? []).flatMap((r: any) =>
      (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id),
    );
    expect(buttons).toEqual([`mimi:draftdone:${draftId}`]);
    expect(h.lastReply().content).toContain("再オープン");

    // 「これ以上送らない」は通り、届いたことにはしない
    const before = h.dms.length;
    await h.press(`mimi:draftdone:${draftId}`);
    expect(h.services.confessions.getReplyDraft(draftId)!.outcome).toBe("resolved_manually");
    expect(h.services.confessions.getReplyDraft(draftId)!.outcome).not.toBe("delivered");
    expect(h.dms).toHaveLength(before); // 何も送らない
    expect(h.services.confessions.obligations(h.id).replyDrafts).toBe(0);
  });

  // R36c
  it("再オープンすれば送り直せる", async () => {
    const h = harness("yes");
    const draftId = await stuck(h, "unknown");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    await h.press(`mimi:draftretry:${draftId}`);
    const blocked = h.dms.length;

    await h.press(`mimi:reopen:${h.id}`);
    expect(h.row().status).toBe("claimed");
    expect(h.row().stage).toBe("active");

    await h.press(`mimi:draftretry:${draftId}`);
    expect(h.dms.length).toBe(blocked + 1);
    expect(h.dmText()).toContain("未確定の返信");
    expect(h.row().reply_deadline_at).not.toBeNull();
  });
});

describe("再オープンは、開いている会話を壊さない", () => {
  // R35（実ハンドラ経由）
  it("進行中の会話で再オープンを押しても、期限も番も動かない", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    await h.press(`mimi:reopen:${h.id}`);
    expect(h.row().status).toBe("claimed");

    // 新しい返信が成立し、新しい期限ができる
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "続きです" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    const fresh = h.row();
    expect(fresh.reply_deadline_at).not.toBeNull();
    const reopenEvents = () =>
      (h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_reopen'").get() as { n: number }).n;
    const before = reopenEvents();

    // 古い画面に残っていた再オープンが押される
    await h.press(`mimi:reopen:${h.id}`);

    const after = h.row();
    expect(after.reply_deadline_at).toBe(fresh.reply_deadline_at);
    expect(after.stage).toBe("awaiting_poster");
    expect(reopenEvents()).toBe(before);
    expect(h.lastReply().content).toContain("終了していません");
    expect(h.threadPostTexts()).not.toContain("再オープンしました。\n");
  });
});

describe("行き違った返信も、投稿者の手元で宙ぶらりんにしない", () => {
  // R37
  it("置き換わった試行の1通は、専用の案内へ収束する（新しい DM は増えない）", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "行き違った返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;

    // 試行1の DM を境界で止める
    const first = h.holdDm();
    const sending = h.press(`mimi:replywait:${draftId}`);
    await first.entered;
    // 回収 → 試行2が始まる（こちらも送信中のまま）
    h.sweepDeadOwners();
    const second = h.holdDm();
    const retrying = h.press(`mimi:draftretry:${draftId}`);
    await second.entered;

    // 試行1が「届いた」で帰る（＝置き換わっているが、確かに届いている）
    first.release("ok");
    await sending;
    second.release("ok");
    await retrying;

    // 会話を動かしたのは試行2だけ
    expect(h.row().reply_deadline_at).not.toBeNull();

    const supersededDm = h.dms.find((d) => {
      const j = d.embeds?.[0]?.toJSON ? d.embeds[0].toJSON() : d.embeds?.[0];
      return [j?.description ?? "", ...(j?.fields ?? []).map((f: any) => f.value)]
        .join("\n")
        .includes("送信処理が別の試行と行き違いました");
    });
    expect(supersededDm).toBeDefined();
    const j = supersededDm!.embeds?.[0]?.toJSON ? supersededDm!.embeds[0].toJSON() : supersededDm!.embeds?.[0];
    const text = [j?.description ?? "", ...(j?.fields ?? []).map((f: any) => f.value)].join("\n");
    // 本文は消えていない
    expect(text).toContain("行き違った返信");
    // open/closed も期限も推測しない
    expect(text).not.toContain("自動で終了します");
    expect(text).not.toContain("このやり取りはここで終了しました");
    expect((supersededDm!.components ?? []).length).toBe(0);
    // 責務は残っていない（収束済み）
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(0);
  });

  it("収束の前に落ちても、同じメッセージが行き違いの案内へ収束する", async () => {
    const h = harness("yes");
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "行き違った返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;

    h.setEditFails(true); // 収束（編集）だけが落ちる
    const first = h.holdDm();
    const sending = h.press(`mimi:replywait:${draftId}`);
    await first.entered;
    h.sweepDeadOwners();
    const second = h.holdDm();
    const retrying = h.press(`mimi:draftretry:${draftId}`);
    await second.entered;
    first.release("ok");
    await sending;
    second.release("ok");
    await retrying;

    // 直せていないので、義務として残る（本文だけの1通のまま）
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBeGreaterThan(0);
    const before = h.dms.length;

    // 起動時／刻時盤の収束
    h.setEditFails(false);
    await convergePendingRenders(h.client as any, h.services);

    expect(h.dms).toHaveLength(before); // **新しい DM は増えない**
    expect(JSON.stringify(h.dms)).toContain("送信処理が別の試行と行き違いました");
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(0);
  });
});

describe("手動の決着を、二人目が「閉じた」と記録しない", () => {
  /** スレッドに出た「閉じました」系の記録の件数 */
  const closedLogs = (h: ReturnType<typeof harness>, needle: string) =>
    h.threadPostTexts().split("\n").filter((line) => line.includes(needle)).length;

  const stuckFollowUp = async (h: ReturnType<typeof harness>) => {
    h.setThreadUnknown(true);
    await h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "渡せたか分からない追記" });
    h.setThreadUnknown(false);
    return h.db.prepare("SELECT id FROM confession_follow_ups ORDER BY id DESC").pluck().get() as number;
  };
  const stuckDraft = async (h: ReturnType<typeof harness>) => {
    h.setDmUnknown(true);
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "届いたか分からない返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    h.setDmUnknown(false);
    return draftId;
  };

  // R42a
  it("先に畳んだ人だけが記録に残る（追記）", async () => {
    const h = harness("yes");
    const followUpId = await stuckFollowUp(h);
    h.services.confessions.addAssignee(h.id, "staff-2", STAFF);

    await h.press(`mimi:followupdone:${followUpId}`, STAFF);
    expect(h.services.confessions.getFollowUp(followUpId)!.resolved_by).toBe(STAFF);
    const logsAfterFirst = closedLogs(h, "「対応済み」として閉じました");
    expect(logsAfterFirst).toBe(1);

    // 二人目が、古い画面のボタンを押す
    await h.press(`mimi:followupdone:${followUpId}`, "staff-2");

    // DB は動かない
    const after = h.services.confessions.getFollowUp(followUpId)!;
    expect(after.resolved_by).toBe(STAFF);
    // **嘘の「閉じました」を積まない**
    expect(closedLogs(h, "「対応済み」として閉じました")).toBe(logsAfterFirst);
    expect(h.threadPostTexts()).not.toContain("<@staff-2> が未確定の追記");
    expect(h.lastReply().content).toContain("既に処理済み");
    expect(
      (h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_followup_resolved'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("先に畳んだ人だけが記録に残る（返信）", async () => {
    const h = harness("yes");
    const draftId = await stuckDraft(h);
    h.services.confessions.addAssignee(h.id, "staff-2", STAFF);

    await h.press(`mimi:draftdone:${draftId}`, STAFF);
    const logsAfterFirst = closedLogs(h, "「これ以上送らない」として閉じました");
    expect(logsAfterFirst).toBe(1);

    await h.press(`mimi:draftdone:${draftId}`, "staff-2");
    expect(h.services.confessions.getReplyDraft(draftId)!.resolved_by).toBe(STAFF);
    expect(closedLogs(h, "「これ以上送らない」として閉じました")).toBe(logsAfterFirst);
    expect(h.lastReply().content).toContain("既に処理済み");
    expect(
      (h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_reply_resolved'").get() as { n: number }).n,
    ).toBe(1);
  });

  // R42b
  it("保持期限で終端化されたあとに押しても、担当者が閉じたことにならない（追記）", async () => {
    const h = harness("yes");
    const followUpId = await stuckFollowUp(h);
    h.services.confessions.purgeExpiredConversationBodies(
      h.services.confessions.getFollowUp(followUpId)!.body_purge_at!,
    );
    expect(h.services.confessions.getFollowUp(followUpId)!.outcome).toBe("expired_retention");

    await h.press(`mimi:followupdone:${followUpId}`, STAFF);

    const after = h.services.confessions.getFollowUp(followUpId)!;
    expect(after.outcome).toBe("expired_retention");
    expect(after.resolved_by).toBe("system:retention"); // 担当者の名前へすり替わらない
    expect(closedLogs(h, "「対応済み」として閉じました")).toBe(0);
    expect(h.lastReply().content).toContain("既に処理済み");
  });

  it("保持期限で終端化されたあとに押しても、担当者が閉じたことにならない（返信）", async () => {
    const h = harness("yes");
    const draftId = await stuckDraft(h);
    h.services.confessions.purgeExpiredConversationBodies(
      h.services.confessions.getReplyDraft(draftId)!.body_purge_at!,
    );
    expect(h.services.confessions.getReplyDraft(draftId)!.outcome).toBe("expired_retention");

    await h.press(`mimi:draftdone:${draftId}`, STAFF);

    expect(h.services.confessions.getReplyDraft(draftId)!.resolved_by).toBe("system:retention");
    expect(closedLogs(h, "「これ以上送らない」として閉じました")).toBe(0);
    expect(h.lastReply().content).toContain("既に処理済み");
  });
});

describe("終了が成立したあとは、担当者の操作でも新しい送信を始めない", () => {
  it("受領確認は、終了したあと押しても DM を出さない", async () => {
    const h = harness("yes");
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    const before = h.dms.length;

    await h.press(`mimi:ack:${h.id}`);

    expect(h.dms).toHaveLength(before); // **新しい DM は出ない**
    expect(h.row().acknowledged_at).toBeNull();
    expect(
      (h.db.prepare("SELECT COUNT(*) n FROM confession_ack_attempts").get() as { n: number }).n,
    ).toBe(0); // 試行の行も作らない（索引を塞がない）
    expect(h.services.confessions.ackState(h.id)).toBe("none");
    expect(h.lastReply().content).toContain("既に終了");
  });

  it("書き終えた返信も、終了したあとは送れない", async () => {
    const h = harness("yes");
    // 本文だけ書いて、送る前に投稿者が終了する
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "送る前に終わった返信" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts").pluck().get() as number;
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    const before = h.dms.length;

    await h.press(`mimi:replywait:${draftId}`);

    expect(h.dms).toHaveLength(before);
    const after = h.services.confessions.getReplyDraft(draftId)!;
    expect(after.consumed_at).toBeNull();
    expect(after.body).toBe("送る前に終わった返信");
    expect(h.row().status).toBe("closed");
    expect(h.row().reply_deadline_at).toBeNull();
    expect(h.lastReply().content).toContain("既に終了しています");
  });
});

describe("貸出の切れた所有者は、刻時盤の掃きで拾われる", () => {
  it("送信中のまま止まった追記が、掃きのあと担当者の判断待ちへ出てくる", async () => {
    const h = harness("yes");
    // 中継の途中で止まったまま（所有者は返ってこない）
    const gate = h.holdThread();
    const submitting = h.submit(`mimi:replybody:${h.id}`, SENDER, { text: "止まったままの追記" });
    await gate.entered;
    const followUpId = h.db.prepare("SELECT id FROM confession_follow_ups").pluck().get() as number;
    expect(h.services.confessions.getFollowUp(followUpId)!.outcome).toBe("sending");

    // 貸出が生きているうちは誰も奪わない
    expect(h.services.confessions.recoverOrphanedEffects("system:sweep").followUps).toBe(0);
    // 貸出が切れたら、定期の掃きが拾う
    expect(h.sweepDeadOwners().followUps).toBe(1);
    expect(h.services.confessions.getFollowUp(followUpId)!.outcome).toBe("unknown");
    expect(h.services.confessions.listFollowUpsNeedingDecision(h.id)).toHaveLength(1);

    gate.release("net");
    await submitting;
  });
});

describe("「直せた」と言えるのは、いま送ったその1通について", () => {
  /** 返信を1通送り、その DM の message id と render id を返す */
  const sendReply = async (h: ReturnType<typeof harness>, text: string) => {
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    const render = h.db
      .prepare("SELECT id, message_id, state FROM confession_pending_renders ORDER BY id DESC")
      .get() as { id: number; message_id: string; state: string };
    return render;
  };

  // R44
  it("古い表示が直っても、今回の失敗を隠さない", async () => {
    const h = harness("yes");
    // A: 1通目。ここではまだ直せない（あとで直る）
    h.setEditFails(true);
    const a = await sendReply(h, "1通目");
    h.setEditFails(false);
    expect(h.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(a.id)).toBe("failed");

    // B: 2通目（今回の返信）。**この1通だけ**編集に失敗する
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "2通目" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    // いま送る DM は次の index。その1通だけ落とす
    h.setEditFailsFor(`dm-msg-${h.dms.length}`);
    await h.press(`mimi:replywait:${draftId}`);
    h.setEditFailsFor(null);

    const b = h.db
      .prepare("SELECT id, state FROM confession_pending_renders ORDER BY id DESC")
      .get() as { id: number; state: string };
    expect(b.id).not.toBe(a.id);
    expect(b.state).toBe("failed");
    // **今回の1通は直せていない。** 古い A が直った件数を根拠にしない
    const said = h.lastReply().content ?? "";
    expect(said).toContain("書き足せませんでした");
    expect(h.services.confessions.pendingRendersFor(h.id).some((r) => r.id === b.id)).toBe(true);
  });

  it("今回の1通が直れば、今回について成功と言える", async () => {
    const h = harness("yes");
    // A: 古い表示は直せないまま残す
    h.setEditFails(true);
    const a = await sendReply(h, "1通目");
    h.setEditFails(false);

    // B: 今回の返信は直せる
    const b = await sendReply(h, "2通目");
    expect(h.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(b.id)).toBe("settled");
    expect(h.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(a.id)).toBe("failed");
    const said = h.lastReply().content ?? "";
    expect(said).not.toContain("書き足せませんでした");
    expect(said).toContain("返信を届けました");
  });
});

describe("直せない表示を、毎分叩き続けない", () => {
  const stalled = async (h: ReturnType<typeof harness>) => {
    h.setEditFails(true);
    await h.submit(`mimi:staffreplybody:${h.id}`, STAFF, { text: "直せない表示の本文" });
    const draftId = h.db.prepare("SELECT id FROM confession_reply_drafts ORDER BY id DESC").pluck().get() as number;
    await h.press(`mimi:replywait:${draftId}`);
    return h.db.prepare("SELECT id FROM confession_pending_renders ORDER BY id DESC").pluck().get() as number;
  };
  const warnings = (h: ReturnType<typeof harness>) =>
    h.threadPostTexts().split("\n").filter((l) => l.includes("自動では最終形へ書き換えられませんでした")).length;

  // R45
  it("有限回で打ち切り、以後は刻時盤が触らない", async () => {
    const h = harness("yes");
    const renderId = await stalled(h);

    // 刻時盤が回る。上限までは試し、そこで打ち切る
    for (let i = 0; i < 10; i += 1) await convergePendingRenders(h.client as any, h.services);

    const row = h.db
      .prepare("SELECT state, attempts FROM confession_pending_renders WHERE id=?")
      .get(renderId) as { state: string; attempts: number };
    expect(row.state).toBe("exhausted");
    expect(row.attempts).toBe(5);
    // **警告はスレッドに1度だけ**（毎分積まない）
    expect(warnings(h)).toBe(1);

    // さらに10周しても、試行も警告も増えない
    for (let i = 0; i < 10; i += 1) await convergePendingRenders(h.client as any, h.services);
    const after = h.db
      .prepare("SELECT state, attempts FROM confession_pending_renders WHERE id=?")
      .get(renderId) as { state: string; attempts: number };
    expect(after.attempts).toBe(row.attempts);
    expect(after.state).toBe("exhausted");
    expect(warnings(h)).toBe(1);

    // 担当者からは出口として見える
    expect(h.panelButtons()).toContain(`mimi:renderdecide:${h.id}`);
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(1);
  });

  // R46
  it("担当者がもう一度直すと決めれば、同じメッセージが直る", async () => {
    const h = harness("yes");
    const renderId = await stalled(h);
    for (let i = 0; i < 10; i += 1) await convergePendingRenders(h.client as any, h.services);
    const before = h.dms.length;

    // 一覧 → 選ぶ → もう一度直す
    await h.press(`mimi:renderdecide:${h.id}`);
    expect(h.lastReply().content).toContain("自動では直せなかった表示");
    await handleConfessionStringSelect(
      { ...h.interactionFor(`mimi:rendersel:${h.id}`, STAFF), values: [String(renderId)] } as any,
      h.services,
    );
    const buttons = (h.lastReply().components ?? []).flatMap((r: any) =>
      (r.toJSON ? r.toJSON() : r).components.map((c: any) => c.custom_id),
    );
    expect(buttons).toEqual([`mimi:renderretry:${renderId}`, `mimi:renderdone:${renderId}`]);

    h.setEditFails(false);
    await h.press(`mimi:renderretry:${renderId}`);

    expect(h.dms).toHaveLength(before); // **新しい DM は増えない**
    expect(h.dmText()).toContain("必要なら追記できます");
    expect(h.dmText()).toContain("直せない表示の本文");
    expect(h.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(renderId)).toBe(
      "settled",
    );
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(0);
    expect(h.lastReply().content).toContain("最終形へ直しました");
  });

  it("もう一度直しても駄目なら、また打ち切って伝える", async () => {
    const h = harness("yes");
    const renderId = await stalled(h);
    for (let i = 0; i < 10; i += 1) await convergePendingRenders(h.client as any, h.services);
    await h.press(`mimi:renderretry:${renderId}`); // 失敗したまま
    expect(h.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(renderId)).toBe(
      "exhausted",
    );
    expect(h.lastReply().content).toContain("まだ直せませんでした");
    // 打ち切りの警告は積み増さない
    expect(warnings(h)).toBe(1);
  });

  // R47
  it("諦めれば、届いたことにはせずアーカイブが通る", async () => {
    const h = harness("yes");
    const renderId = await stalled(h);
    for (let i = 0; i < 10; i += 1) await convergePendingRenders(h.client as any, h.services);
    const before = h.dms.length;

    await h.press(`mimi:renderdone:${renderId}`);

    expect(h.dms).toHaveLength(before);
    const state = h.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(renderId);
    expect(state).toBe("resolved_manually");
    expect(state).not.toBe("settled");
    expect(h.threadPostTexts()).toContain("直せたことにはしていません");
    expect(h.services.confessions.obligations(h.id).pendingRenders).toBe(0);
    expect(h.services.confessions.obligations(h.id).total).toBe(0);
    expect(h.panelButtons()).not.toContain(`mimi:renderdecide:${h.id}`);

    // アーカイブが通る（未処理を抱えたままにならない）
    await h.press(`mimi:senderclosego:${h.id}`, SENDER);
    expect(h.thread.setArchived).toHaveBeenCalled();
  });

  it("二人目が「諦めた」と記録しない", async () => {
    const h = harness("yes");
    const renderId = await stalled(h);
    for (let i = 0; i < 10; i += 1) await convergePendingRenders(h.client as any, h.services);
    h.services.confessions.addAssignee(h.id, "staff-2", STAFF);

    await h.press(`mimi:renderdone:${renderId}`, STAFF);
    const logs = () => h.threadPostTexts().split("\n").filter((l) => l.includes("の修正を諦めました")).length;
    expect(logs()).toBe(1);

    await h.press(`mimi:renderdone:${renderId}`, "staff-2");
    expect(logs()).toBe(1);
    expect(h.lastReply().content).toContain("既に処理済み");
    expect(
      (h.db.prepare("SELECT COUNT(*) n FROM events WHERE type='confession_render_resolved'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("別案件のIDでは、表示にも触れない", async () => {
    const h = harness("yes");
    const renderId = await stalled(h);
    for (let i = 0; i < 10; i += 1) await convergePendingRenders(h.client as any, h.services);
    await h.press(`mimi:renderdone:${renderId}`, "stranger");
    expect(h.db.prepare("SELECT state FROM confession_pending_renders WHERE id=?").pluck().get(renderId)).toBe(
      "exhausted",
    );
    expect(h.lastReply().content).toContain("担当者または管理者のみ");
  });
});
