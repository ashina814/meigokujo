import { afterEach, describe, expect, it, vi } from "vitest";
import { PVP_ACCEPT, PVP_CANCEL, challengeCard, closeChallengeCard, closedCard, postChallenge } from "../src/casino/pvp-card.js";
import { getChallenge, resetChallengesForTesting } from "../src/casino/pvp-challenge.js";

afterEach(() => {
  resetChallengesForTesting();
  vi.restoreAllMocks();
});

function ids(payload: { components?: unknown[] }): string[] {
  const row = payload.components?.[0] as { toJSON(): { components?: Array<{ custom_id?: string }> } } | undefined;
  return (row?.toJSON().components ?? []).map((c) => c.custom_id ?? "");
}

describe("募集カード", () => {
  it("受ける・取り消すのボタンに challenge ID を埋める", () => {
    const payload = challengeCard({ id: "abc", challengerId: "alice", game: "chinchiro", bet: 1_000 });
    expect(ids(payload)).toEqual([`${PVP_ACCEPT}:abc`, `${PVP_CANCEL}:abc`]);
  });

  it("ボタンは賭場ハブへ流れる接頭辞を使う", () => {
    // index.ts は casino:home: で賭場ハブへ流す。外れると押しても無反応になる
    for (const id of [PVP_ACCEPT, PVP_CANCEL]) expect(id.startsWith("casino:home:")).toBe(true);
  });

  it("終端表示にボタンを残さない", () => {
    expect(closedCard("募集は取り消されました").components).toEqual([]);
  });
});

describe("募集の公開と登録は隙間なく行う", () => {
  function fakeChannel(send: () => Promise<unknown>) {
    return { send } as never;
  }

  it("送信成功の直後に登録され、押せば見つかる", async () => {
    let capturedId = "";
    const card = { channelId: "ch1", edit: vi.fn() };
    const channel = fakeChannel(async (payload: never) => {
      capturedId = ids(payload as { components?: unknown[] })[0]!.split(":").pop()!;
      return card;
    });

    await postChallenge({ channel, challengerId: "alice", game: "chinchiro", bet: 1_000, onExpire: () => undefined });

    // カードに載った ID がそのまま登録されている（押しても gone にならない）
    expect(getChallenge(capturedId)?.state).toBe("open");
  });

  it("送信が落ちたら募集は登録されない", async () => {
    vi.useFakeTimers();
    const channel = fakeChannel(async () => {
      throw new Error("Missing Permissions");
    });
    await expect(
      postChallenge({ channel, challengerId: "alice", game: "chinchiro", bet: 1_000, onExpire: () => undefined }),
    ).rejects.toThrow("Missing Permissions");
    // 送信前に登録しないので、3分タイマーだけ生きているゴミが残らない
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("カードを閉じるとボタンが外れる", async () => {
    // accept / cancel / expire の終端で共通に使う。押せる見た目のまま残さない
    const edit = vi.fn(async () => undefined);
    await closeChallengeCard({ edit } as never, "募集は終了しました。");
    expect(edit.mock.calls[0]?.[0]).toMatchObject({ components: [] });
  });
});
