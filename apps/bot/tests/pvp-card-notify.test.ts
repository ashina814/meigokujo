import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PvpChallengePostInProgressError,
  postChallenge,
  resetPvpChallengePostLocksForTesting,
} from "../src/casino/pvp-card.js";
import { preparePvpNotify, resetPvpNotifyThrottleForTesting } from "../src/casino/pvp-notify-throttle.js";

afterEach(() => {
  resetPvpChallengePostLocksForTesting();
  resetPvpNotifyThrottleForTesting();
});

describe("公開1v1募集の投稿と通知", () => {
  it("Discord送信失敗では通知回数を消費しない", async () => {
    const channel = {
      send: vi.fn(async () => {
        throw new Error("discord send failed");
      }),
    };

    await expect(
      postChallenge({
        channel: channel as never,
        challengerId: "alice",
        game: "bj",
        bet: 100,
        mentionRoleIds: ["role-a"],
        onExpire: () => undefined,
      }),
    ).rejects.toThrow("discord send failed");

    // send が失敗したので、まだ最初の通知として3回枠を丸ごと使える。
    const first = preparePvpNotify("alice", ["role-a"]);
    expect(first).toMatchObject({ roleIds: ["role-a"], status: "sent" });
    first.commit();
    const second = preparePvpNotify("alice", ["role-a"]);
    expect(second.status).toBe("sent");
    second.commit();
    const third = preparePvpNotify("alice", ["role-a"]);
    expect(third.status).toBe("sent");
  });

  it("同一ユーザーの投稿処理中は2件目を送らず二重pingを防ぐ", async () => {
    let rejectFirst!: (reason?: unknown) => void;
    const pendingSend = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const channel = { send: vi.fn(() => pendingSend) };

    const first = postChallenge({
      channel: channel as never,
      challengerId: "alice",
      game: "bj",
      bet: 100,
      mentionRoleIds: ["role-a"],
      onExpire: () => undefined,
    }).catch((error: unknown) => error);

    await Promise.resolve();

    await expect(
      postChallenge({
        channel: channel as never,
        challengerId: "alice",
        game: "sashi",
        bet: 500,
        mentionRoleIds: ["role-a"],
        onExpire: () => undefined,
      }),
    ).rejects.toBeInstanceOf(PvpChallengePostInProgressError);
    expect(channel.send).toHaveBeenCalledTimes(1);

    rejectFirst(new Error("finish test"));
    expect(await first).toBeInstanceOf(Error);
  });
});
