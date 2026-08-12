import { describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
import { EventLog, Settings, openDb, registerDefaultTxTypes } from "@meigokujo/core";
import { ENTRY_GUIDE_KEY, ENTRY_OPS_KEY, entryGuideChannelId, entryOpsChannelId } from "../src/entry-channels.js";
import type { Services } from "../src/services.js";

/**
 * 入城導線のチャンネルは「見せる場所」と「運用が動く場所」で別。
 *
 * 案内の掲示先を変えただけで、説明会のお知らせや時間外希望のスレッドまで
 * 一緒に移ってしまうのを避けるためにキーを分けた。**分離を入れただけでは
 * 投稿先が変わらない**（未設定なら従来どおり案内側へ落ちる）ことが要点。
 */

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? "test-token";
process.env.CLIENT_ID = process.env.CLIENT_ID ?? "test-client";
process.env.OWNER_ID = process.env.OWNER_ID ?? "test-owner";
registerDefaultTxTypes();

const GUIDE = "1463895543830024334"; // #冥獄城について
const OPS = "1463886592090312848"; // #希望日程

function setup() {
  const db = openDb(":memory:");
  const settings = new Settings(db);
  const services = { db, settings, events: new EventLog(db) } as unknown as Services;
  return { db, settings, services };
}

describe("運用チャンネルの解決", () => {
  it("未設定なら案内側へ落ちる（deployしただけでは投稿先が変わらない）", () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");

    expect(entryOpsChannelId(ctx.services)).toBe(GUIDE);
    expect(entryGuideChannelId(ctx.services)).toBe(GUIDE);
    ctx.db.close();
  });

  it("設定を入れた時点で運用側だけが移る", () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");
    ctx.settings.set(ENTRY_OPS_KEY, OPS, "test");

    expect(entryOpsChannelId(ctx.services)).toBe(OPS);
    expect(entryGuideChannelId(ctx.services)).toBe(GUIDE); // 案内側は動かない
    ctx.db.close();
  });

  it("どちらも未設定なら undefined（呼び出し側が従来どおり判断する）", () => {
    const ctx = setup();
    expect(entryOpsChannelId(ctx.services)).toBeUndefined();
    ctx.db.close();
  });
});

describe("説明会のお知らせ", () => {
  async function notify(ctx: ReturnType<typeof setup>) {
    const { sendSessionNotification } = await import("../src/scheduler.js");
    const send = vi.fn(async () => undefined);
    const fetched: string[] = [];
    const client = {
      channels: {
        fetch: vi.fn(async (id: string) => {
          fetched.push(id);
          return { isTextBased: () => true, send };
        }),
      },
    };
    await sendSessionNotification(client as never, ctx.services, 21, "5m");
    return { fetched, send };
  }

  it("運用側が未設定なら案内側へ出す", async () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");

    const { fetched, send } = await notify(ctx);

    expect(fetched).toEqual([GUIDE]);
    expect(send).toHaveBeenCalled();
    ctx.db.close();
  });

  it("運用側を設定したらそちらへ出す（案内チャンネルには出さない）", async () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");
    ctx.settings.set(ENTRY_OPS_KEY, OPS, "test");

    const { fetched } = await notify(ctx);

    expect(fetched).toEqual([OPS]);
    expect(fetched).not.toContain(GUIDE);
    ctx.db.close();
  });
});

describe("時間外希望の進行中スレッド数", () => {
  async function countFlex(ctx: ReturnType<typeof setup>, threadsByChannel: Record<string, string[]>) {
    const { countFlexRequests } = await import("../src/waiters-board.js");
    const fetched: string[] = [];
    const guild = {
      channels: {
        fetch: vi.fn(async (id: string) => {
          fetched.push(id);
          return {
            isTextBased: () => true,
            threads: {
              fetchActive: async () => ({
                threads: new Collection(
                  (threadsByChannel[id] ?? []).map((name, i) => [String(i), { name, archived: false }]),
                ),
              }),
            },
          };
        }),
      },
    };
    const result = await countFlexRequests(guild as never, ctx.services);
    return { ...result, fetched };
  }

  it("**スレッドを作った場所＝運用側**を数える", async () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");
    ctx.settings.set(ENTRY_OPS_KEY, OPS, "test");

    // 運用側（旧チャンネル）に5件、案内側は空
    const r = await countFlex(ctx, {
      [OPS]: ["時間外希望-あ", "時間外希望-い", "時間外希望-う", "時間外希望-え", "時間外希望-お"],
      [GUIDE]: [],
    });

    expect(r.fetched).toEqual([OPS]);
    expect(r.flexOpen).toBe(5);
    expect(r.flexFallback).toBe(false);
    ctx.db.close();
  });

  it("運用側が未設定なら案内側を数える", async () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");

    const r = await countFlex(ctx, { [GUIDE]: ["時間外希望-あ"] });

    expect(r.fetched).toEqual([GUIDE]);
    expect(r.flexOpen).toBe(1);
    ctx.db.close();
  });

  it("「時間外希望-」以外のスレッドは数えない", async () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_OPS_KEY, OPS, "test");

    const r = await countFlex(ctx, { [OPS]: ["時間外希望-あ", "雑談スレ"] });

    expect(r.flexOpen).toBe(1);
    ctx.db.close();
  });
});

describe("時間外希望スレッドの作成先", () => {
  async function openFlex(ctx: ReturnType<typeof setup>) {
    const { handleEntryButton } = await import("../src/commands/entry.js");
    const fetched: string[] = [];
    const create = vi.fn(async () => ({
      id: "th-1",
      members: { add: vi.fn(async () => undefined) },
      send: vi.fn(async () => undefined),
      toString: () => "<#th-1>",
    }));
    const guild = {
      id: "g1",
      channels: {
        fetch: vi.fn(async (id: string) => {
          fetched.push(id);
          return { isTextBased: () => true, threads: { create } };
        }),
      },
      members: { fetch: vi.fn(async () => ({ displayName: "テスト" })) },
    };
    const interaction = {
      customId: "entry:flex",
      isButton: () => true,
      isUserSelectMenu: () => false,
      user: { id: "u1" },
      guild,
      channel: null,
      client: { channels: { fetch: vi.fn(async () => null) } },
      reply: vi.fn(async () => undefined),
    };
    await handleEntryButton(interaction as never, ctx.services);
    return { fetched, create };
  }

  it("運用側を設定したら、そちらにスレッドを作る", async () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");
    ctx.settings.set(ENTRY_OPS_KEY, OPS, "test");

    const { fetched, create } = await openFlex(ctx);

    expect(fetched).toEqual([OPS]);
    expect(create).toHaveBeenCalled();
    ctx.db.close();
  });

  it("運用側が未設定なら、従来どおり案内側に作る", async () => {
    const ctx = setup();
    ctx.settings.set(ENTRY_GUIDE_KEY, GUIDE, "test");

    const { fetched } = await openFlex(ctx);

    expect(fetched).toEqual([GUIDE]);
    ctx.db.close();
  });
});
