import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBumpMessage } from "../src/bump.js";

const DISBOARD_ID = "302050872383242240";
const DISSOKU_ID = "761562078095867916";
type Kind = "disboard" | "dissoku";

function services() {
  return {
    settings: {
      getString: vi.fn((key: string) => {
        if (key === "guild:main") return "guild-main";
        if (key === "channel:bump") return "channel-bump";
        return undefined;
      }),
      getNumber: vi.fn(() => 1_000),
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
  } as any;
}

function baseMessage(kind: Kind, completed = false) {
  const isDisboard = kind === "disboard";
  const send = vi.fn(async () => undefined);
  return {
    id: `${kind}-message`,
    author: { bot: true, id: isDisboard ? DISBOARD_ID : DISSOKU_ID },
    guildId: "guild-main",
    channelId: "channel-bump",
    content: "",
    interactionMetadata: {
      name: isDisboard ? "bump" : "up",
      user: { id: "user-1", bot: false },
    },
    interaction: {
      commandName: isDisboard ? "bump" : "up",
      user: { id: "user-1", bot: false },
    },
    embeds: isDisboard
      ? [
          {
            title: "DISBOARD: Discordサーバー掲示板",
            description: completed ? "表示順をアップしたよ :thumbsup:" : "",
            fields: [],
          },
        ]
      : [
          {
            title: "ディス速 | Discordサーバー・友達募集・ボット掲示板",
            description: "<@user-1>\ncommand: `/up`",
            fields: completed ? [{ name: "`冥獄城` をアップしたよ!", value: "\u200b" }] : [],
          },
        ],
    channel: { isSendable: () => true, send },
    send,
  } as any;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bump/up の遅延embed完成", () => {
  it("ディス速は作成直後に成功文面がなくても1秒後の再取得で支給する", async () => {
    vi.useFakeTimers();
    const s = services();
    const initial = baseMessage("dissoku");
    const completed = baseMessage("dissoku", true);
    initial.fetch = vi.fn(async () => completed);

    await handleBumpMessage(initial, s);
    expect(s.ledger.transfer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(initial.fetch).toHaveBeenCalledWith(true);
    expect(s.ledger.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "up報酬",
        idempotencyKey: "bump:dissoku-message",
      }),
    );
    expect(s.bumps.addOnce).toHaveBeenCalledWith("dissoku-message", "user-1");
  });

  it("DISBOARDも未完成embedを再取得してbump報酬を支給する", async () => {
    vi.useFakeTimers();
    const s = services();
    const initial = baseMessage("disboard");
    const completed = baseMessage("disboard", true);
    initial.fetch = vi.fn(async () => completed);

    await handleBumpMessage(initial, s);
    expect(s.ledger.transfer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(initial.fetch).toHaveBeenCalledWith(true);
    expect(s.ledger.transfer).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "bump報酬",
        idempotencyKey: "bump:disboard-message",
      }),
    );
    expect(s.bumps.addOnce).toHaveBeenCalledWith("disboard-message", "user-1");
  });

  it("1秒・3秒で未完成でも7秒後の最終再取得で支給できる", async () => {
    vi.useFakeTimers();
    const s = services();
    const initial = baseMessage("dissoku");
    const completed = baseMessage("dissoku", true);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(completed);
    initial.fetch = fetch;

    await handleBumpMessage(initial, s);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.ledger.transfer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.ledger.transfer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(7_000);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(s.ledger.transfer).toHaveBeenCalledOnce();
  });

  it("3回再取得しても成功文面がなければ有限回で停止する", async () => {
    vi.useFakeTimers();
    const s = services();
    const initial = baseMessage("disboard");
    initial.fetch = vi.fn(async () => initial);

    await handleBumpMessage(initial, s);
    await vi.runAllTimersAsync();

    expect(initial.fetch).toHaveBeenCalledTimes(3);
    expect(s.ledger.transfer).not.toHaveBeenCalled();
    expect(s.bumps.addOnce).not.toHaveBeenCalled();
  });

  it("クールタイム等の明示的な失敗応答は再取得しない", async () => {
    vi.useFakeTimers();
    const s = services();
    const failed = baseMessage("dissoku");
    failed.embeds[0].fields = [
      { name: "失敗しました... 間隔をあけてください(120分)", value: "\u200b" },
    ];
    failed.fetch = vi.fn();

    await handleBumpMessage(failed, s);
    await vi.runAllTimersAsync();

    expect(failed.fetch).not.toHaveBeenCalled();
    expect(s.ledger.transfer).not.toHaveBeenCalled();
    expect(s.bumps.addOnce).not.toHaveBeenCalled();
  });
});
