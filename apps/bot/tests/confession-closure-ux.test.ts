import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
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
  handleConfessionButton,
  handleConfessionModal,
  closeExpiredSenderWaits,
  retryPendingFollowUps,
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
  const threadPosts: Sent[] = [];
  const noticePosts: Sent[] = [];
  /**
   * Discord の応答を差し替える。
   * `api` = DiscordAPIError（サーバの確定応答＝届いていない）、
   * `net` = 応答が得られなかった（届いたか分からない）。
   */
  let dmMode: "ok" | "api" | "net" = "ok";
  let editMode: "ok" | "api" | "net" = "ok";
  let threadMode: "ok" | "api" | "net" = "ok";
  /** 送信の境界で止めるための deferred。時間待ちは使わない。 */
  let dmGate: Promise<void> | null = null;
  let dmGateEntered: (() => void) | null = null;
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
      if (threadMode === "api") throw apiError();
      if (threadMode === "net") throw netError();
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
  const client = {
    channels: {
      fetch: async (cid: string) => (cid === THREAD ? thread : cid === NOTICE_CH ? noticeChannel : null),
    },
    users: {
      fetch: async (uid: string) => ({
        id: uid,
        send: async (o: Sent) => {
          // ゲートは**いま飛ぼうとしている1通だけ**を止める。後続（投稿者側の操作で
          // 出る DM など）まで止めると、競合そのものを作れない。
          const gate = dmGate;
          dmGate = null;
          if (gate) {
            dmGateEntered?.(); // 「本当に送信の途中まで来た」ことを呼び出し側へ知らせる
            await gate;
          }
          if (dmMode === "api") throw apiError();
          if (dmMode === "net") throw netError();
          // 実物と同じく、届いた1通はあとから編集できる。
          // `dms` は投稿者にいま見えている内容、`dmVersions` は届いた順の全版。
          const index = dms.push(o) - 1;
          dmVersions.push(o);
          return {
            edit: async (next: Sent) => {
              if (editMode === "api") throw apiError();
              if (editMode === "net") throw netError();
              dms[index] = next;
              dmVersions.push(next);
              return next;
            },
          };
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

  const press = async (customId: string, userId = STAFF) => {
    await handleConfessionButton(makeInteraction(customId, userId) as any, services);
  };
  const submit = async (customId: string, userId: string, fields: Record<string, string>) => {
    await handleConfessionModal(makeInteraction(customId, userId, fields) as any, services);
  };

  return {
    db, services, confessions, id, dms, threadPosts, replies, shown, thread, panelMessage, client,
    press, submit, noticePosts,
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
    dmVersions,
    /** 届いた n 番目の DM の、指定した版のテキスト */
    dmVersionText: (i: number): string => {
      const e = dmVersions[i]?.embeds?.[0];
      const json = e?.toJSON ? e.toJSON() : e;
      return [json?.description ?? "", ...(json?.fields ?? []).map((f: any) => f.value)].join("\n");
    },
    /**
     * DM 送信を境界で止める。`entered` が解決した時点で「送信の途中」に確実に入っている
     * ので、そこから競合を起こせる（時間待ちに頼らない）。
     */
    holdDm: () => {
      let release!: () => void;
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      dmGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      dmGateEntered = signalEntered;
      return { entered, release: () => release() };
    },
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
    expect(h.threadPostTexts()).toContain("緊急対応が未解決のため");
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
