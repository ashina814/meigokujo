import { afterEach, describe, expect, it, vi } from "vitest";
import { handleBumpMessage } from "../src/bump.js";

const DISSOKU_ID = "761562078095867916";

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

function baseMessage(fields: Array<{ name: string; value: string }> = []) {
  const send = vi.fn(async () => undefined);
  return {
    id: "dissoku-message",
    author: { bot: true, id: DISSOKU_ID },
    guildId: "guild-main",
    channelId: "channel-bump",
    content: "",
    interactionMetadata: {
      name: "up",
      user: { id: "user-1", bot: false },
    },
    interaction: {
      commandName: "up",
      user: { id: "user-1", bot: false },
    },
    embeds: [
      {
        title: "ディス速 | Discordサーバー・友達募集・ボット掲示板",
        description: "<@user-1>\ncommand: `/up`",
        fields,
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

describe("ディス速の遅延embed完成", () => {
  it("作成直後に成功文面がなくても1秒後の再取得で支給する", async () => {
    vi.useFakeTimers();
    const s = services();
    const initial = baseMessage();
    const completed = baseMessage([{ name: "`冥獄城` をアップしたよ!", value: "\u200b" }]);
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

  it("1回目も未完成なら3秒後にもう一度だけ再取得する", async () => {
    vi.useFakeTimers();
    const s = services();
    const initial = baseMessage();
    const completed = baseMessage([{ name: "`冥獄城` をアップしたよ!", value: "\u200b" }]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(completed);
    initial.fetch = fetch;

    await handleBumpMessage(initial, s);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.ledger.transfer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.ledger.transfer).toHaveBeenCalledOnce();
  });

  it("クールタイム等の明示的な失敗応答は再取得しない", async () => {
    vi.useFakeTimers();
    const s = services();
    const failed = baseMessage([
      { name: "失敗しました... 間隔をあけてください(120分)", value: "\u200b" },
    ]);
    failed.fetch = vi.fn();

    await handleBumpMessage(failed, s);
    await vi.runAllTimersAsync();

    expect(failed.fetch).not.toHaveBeenCalled();
    expect(s.ledger.transfer).not.toHaveBeenCalled();
    expect(s.bumps.addOnce).not.toHaveBeenCalled();
  });
});
