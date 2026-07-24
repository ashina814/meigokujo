import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpMessageText, checkBumpCooldowns, handleBumpMessage } from "../src/bump.js";

const DISBOARD_ID = "302050872383242240";
const DISSOKU_ID = "761562078095867916";

function services(overrides: Record<string, unknown> = {}) {
  const stringSettings: Record<string, string | undefined> = {
    "guild:main": "guild-main",
    "channel:bump": "channel-bump",
    "role:bump_notify": "role-notify",
  };

  return {
    settings: {
      getString: vi.fn((key: string) => stringSettings[key]),
      getNumber: vi.fn(() => 1_000),
      getJson: vi.fn(() => null),
      set: vi.fn(),
      delete: vi.fn(),
    },
    ledger: {
      ensureAccount: vi.fn(),
      transfer: vi.fn(() => ({ duplicate: false, tx: { id: 1 } })),
    },
    bumps: {
      addOnce: vi.fn(() => true),
    },
    ...overrides,
  } as any;
}

function message(kind: "disboard" | "dissoku", overrides: Record<string, unknown> = {}) {
  const isDisboard = kind === "disboard";
  const send = vi.fn(async () => undefined);
  const base = {
    id: "message-1",
    author: { bot: true, id: isDisboard ? DISBOARD_ID : DISSOKU_ID },
    guildId: "guild-main",
    channelId: "channel-bump",
    content: "",
    interactionMetadata: {
      name: isDisboard ? "bump" : "up",
      user: { id: "user-1", bot: false },
    },
    embeds: isDisboard
      ? [
          {
            title: "DISBOARD: Discordサーバー掲示板",
            description: "表示順をアップしたよ :thumbsup:",
            fields: [],
          },
        ]
      : [
          {
            title: "ディス速 | Discordサーバー・友達募集・ボット掲示板",
            description: "<@user-1>\ncommand: `/up`",
            fields: [{ name: "`冥獄城` をアップしたよ!", value: "\u200b" }],
          },
        ],
    channel: { isSendable: () => true, send },
  };
  return { value: { ...base, ...overrides } as any, send };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bump/up メッセージ検知", () => {
  it("ディス速の field.name にある成功文面を検知して支給する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T00:00:00+09:00"));
    const s = services();
    const m = message("dissoku");

    await handleBumpMessage(m.value, s);

    expect(s.ledger.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:user-1",
        amount: 1_000,
        type: "reward_bump",
        reason: "up報酬",
        idempotencyKey: "bump:message-1",
      }),
    );
    expect(s.bumps.addOnce).toHaveBeenCalledWith("message-1", "user-1");
    expect(s.settings.set).toHaveBeenCalledWith(
      "bump:cooldown:dissoku",
      { until: Math.floor(Date.now() / 1000) + 7_200, channelId: "channel-bump" },
      "system:bump",
    );
    expect(m.send).toHaveBeenCalledOnce();
  });

  it("DISBOARD成功メッセージを従来どおり支給する", async () => {
    const s = services();
    const m = message("disboard");

    await handleBumpMessage(m.value, s);

    expect(s.ledger.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bump報酬", idempotencyKey: "bump:message-1" }),
    );
    expect(s.bumps.addOnce).toHaveBeenCalledWith("message-1", "user-1");
  });

  it("ディス速の失敗メッセージには支給しない", async () => {
    const s = services();
    const m = message("dissoku", {
      embeds: [
        {
          title: "ディス速",
          description: "<@user-1>\nコマンド: `/up`",
          fields: [{ name: "失敗しました... 間隔をあけてください(120分)", value: "\u200b" }],
        },
      ],
    });

    await handleBumpMessage(m.value, s);

    expect(s.ledger.transfer).not.toHaveBeenCalled();
    expect(s.bumps.addOnce).not.toHaveBeenCalled();
    expect(s.settings.set).not.toHaveBeenCalled();
  });

  it.each([
    ["Guild不一致", { guildId: "other-guild" }],
    ["Channel不一致", { channelId: "other-channel" }],
    ["コマンド不一致", { interactionMetadata: { name: "other", user: { id: "user-1", bot: false } } }],
    ["実行者なし", { interactionMetadata: { name: "up", user: undefined } }],
  ])("%sを拒否する", async (_label, override) => {
    const s = services();
    const m = message("dissoku", override);

    await handleBumpMessage(m.value, s);

    expect(s.ledger.transfer).not.toHaveBeenCalled();
    expect(s.bumps.addOnce).not.toHaveBeenCalled();
  });

  it("送金が処理済みでも未加算のランキングを追いつかせる", async () => {
    const s = services();
    s.ledger.transfer.mockReturnValue({ duplicate: true, tx: { id: 1 } });
    const m = message("dissoku");

    await handleBumpMessage(m.value, s);

    expect(s.bumps.addOnce).toHaveBeenCalledWith("message-1", "user-1");
    expect(m.send).not.toHaveBeenCalled();
  });

  it("報酬0でも成功回数は記録する", async () => {
    const s = services();
    s.settings.getNumber.mockReturnValue(0);
    const m = message("dissoku");

    await handleBumpMessage(m.value, s);

    expect(s.ledger.transfer).not.toHaveBeenCalled();
    expect(s.bumps.addOnce).toHaveBeenCalledWith("message-1", "user-1");
    expect(s.settings.set).toHaveBeenCalledWith(
      "bump:cooldown:dissoku",
      expect.any(Object),
      "system:bump",
    );
  });

  it("同一メッセージの再処理ではクールダウンを延長しない", async () => {
    const s = services();
    s.ledger.transfer.mockReturnValue({ duplicate: true, tx: { id: 1 } });
    s.bumps.addOnce.mockReturnValue(false);
    const m = message("dissoku");

    await handleBumpMessage(m.value, s);

    expect(s.settings.set).not.toHaveBeenCalled();
  });

  it("本文・title・description・field.name・field.valueを抽出する", () => {
    const text = bumpMessageText({
      content: "content",
      embeds: [
        {
          title: "title",
          description: "description",
          fields: [{ name: "field-name", value: "field-value" }],
        },
      ],
    } as any);

    expect(text).toBe("content title description field-name field-value");
  });
});

describe("bump/up クールダウン通知", () => {
  it("通知成功後にだけ状態を削除する", async () => {
    const s = services();
    s.settings.getJson.mockImplementation((key: string) =>
      key === "bump:cooldown:disboard"
        ? { until: 1, channelId: "channel-bump" }
        : null,
    );
    const send = vi.fn(async () => undefined);
    const client = {
      channels: {
        fetch: vi.fn(async () => ({ isTextBased: () => true, send })),
      },
    } as any;

    await checkBumpCooldowns(client, s);

    expect(send).toHaveBeenCalledOnce();
    expect(s.settings.delete).toHaveBeenCalledWith("bump:cooldown:disboard", "system:bump");
  });

  it("通知失敗時は状態を残して次回再試行できる", async () => {
    const s = services();
    s.settings.getJson.mockImplementation((key: string) =>
      key === "bump:cooldown:dissoku"
        ? { until: 1, channelId: "channel-bump" }
        : null,
    );
    const client = {
      channels: { fetch: vi.fn(async () => Promise.reject(new Error("temporary"))) },
    } as any;

    await checkBumpCooldowns(client, s);

    expect(s.settings.delete).not.toHaveBeenCalled();
  });

  it("旧until:0は一度削除し、毎分再保存しない", async () => {
    const s = services();
    s.settings.getJson.mockImplementation((key: string) =>
      key === "bump:cooldown:disboard"
        ? { until: 0, channelId: "" }
        : null,
    );
    const client = { channels: { fetch: vi.fn() } } as any;

    await checkBumpCooldowns(client, s);

    expect(s.settings.delete).toHaveBeenCalledOnce();
    expect(s.settings.set).not.toHaveBeenCalled();
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });
});
