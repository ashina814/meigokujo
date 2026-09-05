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
  const threadPosts: Sent[] = [];
  let dmFails = false;

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
      threadPosts.push(o);
    },
    setArchived: vi.fn(async () => undefined),
    messages: { fetch: async (mid: string) => (mid === PANEL ? panelMessage : null) },
    members: { add: vi.fn(), remove: vi.fn() },
  };
  const client = {
    channels: { fetch: async (cid: string) => (cid === THREAD ? thread : null) },
    users: {
      fetch: async (uid: string) => ({
        id: uid,
        send: async (o: Sent) => {
          if (dmFails) throw new Error("cannot DM");
          dms.push(o);
        },
      }),
    },
  };
  const services = {
    db,
    events,
    confessions,
    settings: { getNumber: () => 90, getString: () => undefined },
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
    press, submit,
    setDmFails: (v: boolean) => {
      dmFails = v;
    },
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
    expect(h.lastReply().content).toContain("既に受領確認を送っています");
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

  // 旧 confession-voice-received.test.ts が見ていた「DM できなかったことを担当者とスレッドに残す」を、
  // 新しい契約（受領確認はクローズしない）へ置き換えて固定する。
  it("DM が届かなくても、受領した事実は残り担当者にもスレッドにも知らされる", async () => {
    const h = harness("no");
    h.setDmFails(true);
    await h.press(`mimi:ack:${h.id}`);
    expect(h.row().acknowledged_at).not.toBeNull();
    expect(h.lastReply().content).toContain("届けられませんでした");
    expect(h.threadPosts.map((p) => p.content).join("\n")).toContain("DM を届けられませんでした");
    // 旧実装と違い、DM の成否にかかわらず案件は閉じない
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
    expect(h.db.prepare("SELECT outcome FROM confession_reply_drafts WHERE id=?").pluck().get(draftId)).toBe("undelivered");
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
