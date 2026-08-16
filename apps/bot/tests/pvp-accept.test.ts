import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptPvpChallenge } from "../src/casino/pvp-accept.js";
import { createChallenge, getChallenge, resetChallengesForTesting } from "../src/casino/pvp-challenge.js";

afterEach(() => {
  resetChallengesForTesting();
  vi.restoreAllMocks();
});

/**
 * この機能で本当に壊したくないのは関数個々ではなく**順序**。
 *
 *   claim → deferUpdate → collectStakes(1回) → pvpViewFromMessage → runFundedX
 *
 * どこかで失敗したとき、募集を復活させないことも合わせて固定する。
 */
function setup(opts: { stakesOk?: boolean; deferThrows?: boolean } = {}) {
  const order: string[] = [];
  const collect = vi.fn(() => {
    order.push("collectStakes");
    return opts.stakesOk === false ? { ok: false as const, reason: "capacity" as const } : { ok: true as const };
  }) as never;

  const run = vi.fn(async () => {
    order.push("runFunded");
  });
  const closeCard = vi.fn(async () => {
    order.push("closeCard");
  });
  const deferUpdate = vi.fn(async () => {
    order.push("deferUpdate");
    if (opts.deferThrows) throw new Error("Unknown interaction");
  });

  createChallenge({
    id: "c1",
    challengerId: "alice",
    game: "chinchiro",
    bet: 1_000,
    channelId: "ch1",
    onExpire: () => undefined,
  });

  const interaction = {
    user: { id: "bob", bot: false },
    message: { id: "card1" },
    client: { users: { fetch: async (id: string) => ({ id }) } },
    deferUpdate,
    reply: vi.fn(async () => undefined),
  } as never;

  const deps = {
    runners: { chinchiro: run, bj: run, sashi: run, indian: run },
    closeCard,
    collect,
  } as never;

  return { interaction, deps, order, collect, run, closeCard };
}

describe("受諾は claim → defer → 徴収 → 本体 の順で進む", () => {
  it("正常系の順序が固定される", async () => {
    const { interaction, deps, order, collect, run } = setup();
    const services = {} as never;
    const result = await acceptPvpChallenge(interaction, services, "c1", deps);

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["deferUpdate", "collectStakes", "runFunded"]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    // claim は同期で完了しているので、募集はもう存在しない
    expect(getChallenge("c1")).toBeUndefined();
  });

  it("徴収は両者ぶんを1回だけ通す", async () => {
    const { interaction, deps, collect } = setup();
    await acceptPvpChallenge(interaction, {} as never, "c1", deps);
    const users = collect.mock.calls[0]?.[1];
    expect(users).toEqual(["alice", "bob"]);
  });
});

describe("どこで失敗しても募集を復活させない", () => {
  it("2人同時に受けても collectStakes は1回だけ", async () => {
    const { interaction, deps, collect } = setup();
    const second = { ...(interaction as object), user: { id: "carol", bot: false } } as never;
    const services = {} as never;

    const [a, b] = await Promise.all([
      acceptPvpChallenge(interaction, services, "c1", deps),
      acceptPvpChallenge(second, services, "c1", deps),
    ]);

    const wins = [a, b].filter((r) => r.ok).length;
    expect(wins, "2人とも成立している").toBe(1);
    expect(collect, "徴収が二重に走った").toHaveBeenCalledTimes(1);
  });

  it("deferUpdate が落ちたら徴収へ進まない", async () => {
    const { interaction, deps, collect, run, closeCard } = setup({ deferThrows: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await acceptPvpChallenge(interaction, {} as never, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "defer_failed" });
    expect(collect, "応答に失敗したのに資金を動かしている").not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(closeCard).toHaveBeenCalled();
    // 復活させない
    expect(getChallenge("c1")).toBeUndefined();
  });

  it("徴収が落ちたら本体へ進まず、再受諾もできない", async () => {
    const { interaction, deps, run } = setup({ stakesOk: false });
    const result = await acceptPvpChallenge(interaction, {} as never, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "stakes_failed" });
    expect(run, "徴収に失敗したのに対戦が始まっている").not.toHaveBeenCalled();
    expect(getChallenge("c1")).toBeUndefined();

    const retry = await acceptPvpChallenge(interaction, {} as never, "c1", deps);
    expect(retry).toEqual({ ok: false, reason: "gone" });
  });
});
