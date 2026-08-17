import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHALLENGE_WINDOW_MS,
  cancelChallenge,
  claimChallenge,
  createChallenge,
  getChallenge,
  resetChallengesForTesting,
} from "../src/casino/pvp-challenge.js";

afterEach(() => {
  resetChallengesForTesting();
  vi.useRealTimers();
});

function open(onExpire = () => undefined) {
  return createChallenge({
    id: "c1",
    challengerId: "alice",
    game: "chinchiro",
    bet: 1_000,
    channelId: "ch1",
    onExpire,
  });
}

describe("募集の状態遷移は open から一度きり", () => {
  it("最初に押した1人だけが取れる", () => {
    open();
    expect(claimChallenge("c1", "bob", false).ok).toBe(true);
    // ほぼ同時に押した2人目。await を挟まず確定しているので必ず弾かれる
    const second = claimChallenge("c1", "carol", false);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe("gone");
  });

  it("挑戦者自身とボットは受けられない", () => {
    open();
    expect(claimChallenge("c1", "alice", false)).toEqual({ ok: false, reason: "self" });
    expect(claimChallenge("c1", "bot", true)).toEqual({ ok: false, reason: "bot" });
    // 弾かれても募集は open のまま
    expect(getChallenge("c1")?.state).toBe("open");
  });

  it("取消は挑戦者だけ。取消後は受けられない", () => {
    open();
    expect(cancelChallenge("c1", "bob")).toBeNull();
    expect(cancelChallenge("c1", "alice")).not.toBeNull();
    expect(claimChallenge("c1", "bob", false).ok).toBe(false);
  });

  it("受諾済みの募集は取り消せない", () => {
    open();
    claimChallenge("c1", "bob", false);
    expect(cancelChallenge("c1", "alice")).toBeNull();
  });
});

describe("claim は timeout を巻き込まない", () => {
  it("受諾後に期限が来ても onExpire が走らない", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    open(onExpire);
    claimChallenge("c1", "bob", false);

    // 募集カードはこの時点で対戦盤になっている。ここで「⌛ 募集終了」に
    // 書き換えられると進行中の盤面を破壊する
    vi.advanceTimersByTime(CHALLENGE_WINDOW_MS + 1_000);
    expect(onExpire, "対戦中に募集終了が発火した").not.toHaveBeenCalled();
  });

  it("取消後も期限で発火しない", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    open(onExpire);
    cancelChallenge("c1", "alice");
    vi.advanceTimersByTime(CHALLENGE_WINDOW_MS + 1_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("誰も受けなければ3分で期限切れになり、以後は受けられない", async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    open(onExpire);
    vi.advanceTimersByTime(CHALLENGE_WINDOW_MS + 1);
    // onExpire は表示失敗を隔離するため microtask 経由で呼ばれる
    await vi.runAllTimersAsync();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire.mock.calls[0]![0].state).toBe("expired");
    expect(claimChallenge("c1", "bob", false).ok).toBe(false);
  });
});

describe("同じIDの募集を二重に作れない", () => {
  it("重複IDは拒否される", () => {
    open();
    expect(() => open()).toThrow("Duplicate challenge id");
  });

  it("期限切れ表示が落ちても募集は復活しない", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    open(() => {
      throw new Error("Unknown Message");
    });
    vi.advanceTimersByTime(CHALLENGE_WINDOW_MS + 1);
    await vi.runAllTimersAsync();

    // 表示に失敗しても expired のまま。受諾できるように戻らない
    expect(claimChallenge("c1", "bob", false).ok).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
