import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptPvpChallenge } from "../src/casino/pvp-accept.js";
import { createChallenge, getChallenge, resetChallengesForTesting } from "../src/casino/pvp-challenge.js";
import {
  acquireTransientParticipation,
  hasTransientParticipation,
  releaseTransientParticipation,
  resetTransientParticipationForTesting,
} from "../src/casino/participation.js";
import { pvpRiskScope } from "../src/casino/pvp-common.js";

afterEach(() => {
  resetChallengesForTesting();
  resetTransientParticipationForTesting();
  vi.restoreAllMocks();
});

/**
 * この機能で本当に壊したくないのは関数個々ではなく**順序**。
 *
 *   両者の参加席を同期確保 → claim → deferUpdate → 挑戦者解決 → collectStakes(1回) → runFundedX
 *
 * challenge を食う資格がない人は claim の前で止め、どこかで失敗しても
 * いったん claim した募集は復活させない。
 */
function setup(opts: { stakesOk?: boolean; deferThrows?: boolean } = {}) {
  const order: string[] = [];
  const collect = vi.fn(
    (
      _services: unknown,
      userIds: string[],
      _bet: number,
      _operationId: string,
      session: string,
      _game: string,
    ) => {
      order.push("collectStakes");
      if (opts.stakesOk === false) {
        // 本番 collectStakes は失敗時に自分で参加席をロールバックする。
        // 入口側から無条件に解くと、露出解除失敗時に fail-closed で残した席を壊すので、
        // fake も同じ責務を持たせる。
        const scope = pvpRiskScope(session);
        for (const userId of userIds) releaseTransientParticipation(userId, "pvp", scope);
        return { ok: false as const, reason: "broke" as const };
      }
      return { ok: true as const };
    },
  ) as never;

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

function realCollectServices(opts: { holdThrows?: boolean } = {}) {
  const holdAll = vi.fn(() => {
    if (opts.holdThrows) throw new Error("escrow unavailable");
    return true;
  });
  const authorizeExposure = vi.fn(() => undefined);
  const revokeExposure = vi.fn(() => undefined);
  const exposureOf = vi.fn(() => null);
  return {
    holdAll,
    authorizeExposure,
    revokeExposure,
    exposureOf,
    value: {
      dailyRisk: { authorizeExposure, revokeExposure, exposureOf },
      escrow: { holdAll },
    } as never,
  };
}

describe("受諾は 席確保 → claim → defer → 徴収 → 本体 の順で進む", () => {
  it("正常系の順序が固定される", async () => {
    const { interaction, deps, order, collect, run } = setup();
    const services = {} as never;
    const result = await acceptPvpChallenge(interaction, services, "c1", deps);

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(["deferUpdate", "collectStakes", "runFunded"]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    // claim は最初の await より前に同期完了している
    expect(getChallenge("c1")).toBeUndefined();
  });

  it("最初の await に着いた時点で両者の参加席と claim が確定している", async () => {
    const { interaction, deps } = setup();
    interaction.deferUpdate = vi.fn(async () => {
      expect(getChallenge("c1"), "defer 前に challenge がまだ open").toBeUndefined();
      expect(hasTransientParticipation("alice"), "挑戦者の席を claim 前に取れていない").toBe(true);
      expect(hasTransientParticipation("bob"), "受諾者の席を claim 前に取れていない").toBe(true);
    }) as never;

    await acceptPvpChallenge(interaction, {} as never, "c1", deps);
  });

  it("徴収は両者ぶんを1回だけ通す", async () => {
    const { interaction, deps, collect } = setup();
    await acceptPvpChallenge(interaction, {} as never, "c1", deps);
    const users = collect.mock.calls[0]?.[1];
    expect(users).toEqual(["alice", "bob"]);
  });
});

describe("challenge を食う資格がない人は open を消費しない", () => {
  it("別卓にいる受諾者が押しても募集は open のまま残る", async () => {
    const { interaction, deps, collect, run } = setup();
    expect(acquireTransientParticipation("bob", "solo", "solo")).toBe(true);

    const result = await acceptPvpChallenge(interaction, {} as never, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "accepter_busy" });
    expect(getChallenge("c1")?.state).toBe("open");
    expect(collect).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("挑戦者が募集後に別卓へ入っていても募集は open のまま残し、受諾者の席を取らない", async () => {
    const { interaction, deps, collect } = setup();
    expect(acquireTransientParticipation("alice", "roulette", "rl:1")).toBe(true);

    const result = await acceptPvpChallenge(interaction, {} as never, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "challenger_busy" });
    expect(getChallenge("c1")?.state).toBe("open");
    expect(hasTransientParticipation("bob")).toBe(false);
    expect(collect).not.toHaveBeenCalled();
  });

  it("同じ人が別々の募集を同時に受けても1件しか claim できない", async () => {
    const { interaction, deps, collect } = setup();
    createChallenge({
      id: "c2",
      challengerId: "carol",
      game: "sashi",
      bet: 500,
      channelId: "ch2",
      onExpire: () => undefined,
    });
    const second = {
      ...(interaction as object),
      message: { id: "card2" },
      deferUpdate: vi.fn(async () => undefined),
    } as never;

    const [a, b] = await Promise.all([
      acceptPvpChallenge(interaction, {} as never, "c1", deps),
      acceptPvpChallenge(second, {} as never, "c2", deps),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: false, reason: "accepter_busy" });
    expect(getChallenge("c1")).toBeUndefined();
    expect(getChallenge("c2")?.state).toBe("open");
    expect(collect, "1人が2つの公開募集を同時に成立させた").toHaveBeenCalledTimes(1);
  });
});

describe("どこで失敗しても募集を復活させない", () => {
  it("2人同時に同じ募集を受けても collectStakes は1回だけ", async () => {
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

  it("deferUpdate が落ちたら徴収へ進まず、仮確保した両者の席を解く", async () => {
    const { interaction, deps, collect, run, closeCard } = setup({ deferThrows: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await acceptPvpChallenge(interaction, {} as never, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "defer_failed" });
    expect(collect, "応答に失敗したのに資金を動かしている").not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(closeCard).toHaveBeenCalled();
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(hasTransientParticipation("bob")).toBe(false);
    expect(getChallenge("c1")).toBeUndefined();
  });

  it("徴収が成立しなければ本体へ進まず、collect 側のロールバックで席も残さない", async () => {
    const { interaction, deps, run } = setup({ stakesOk: false });
    const result = await acceptPvpChallenge(interaction, {} as never, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "stakes_failed" });
    expect(run, "徴収に失敗したのに対戦が始まっている").not.toHaveBeenCalled();
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(hasTransientParticipation("bob")).toBe(false);
    expect(getChallenge("c1")).toBeUndefined();

    const retry = await acceptPvpChallenge(interaction, {} as never, "c1", deps);
    expect(retry).toEqual({ ok: false, reason: "gone" });
  });
});

describe("本物の collectStakes と公開受諾の接続", () => {
  it("claim 前に取った同じ scope の参加席へ reentrant し、holdAll を1回だけ呼ぶ", async () => {
    const { interaction, deps, run } = setup();
    delete (deps as { collect?: unknown }).collect;
    const services = realCollectServices();

    const result = await acceptPvpChallenge(interaction, services.value, "c1", deps);

    expect(result).toEqual({ ok: true });
    expect(services.authorizeExposure).toHaveBeenCalledTimes(2);
    expect(services.holdAll).toHaveBeenCalledTimes(1);
    expect(services.holdAll).toHaveBeenCalledWith(
      "pvpopen:c1",
      ["alice", "bob"],
      1_000,
      "chinchiro-duel",
      "pvpopen:c1:collect",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("本物の collectStakes が技術例外を投げても rollback 後にカードを閉じる", async () => {
    const { interaction, deps, run, closeCard } = setup();
    delete (deps as { collect?: unknown }).collect;
    const services = realCollectServices({ holdThrows: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await acceptPvpChallenge(interaction, services.value, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "stakes_failed" });
    expect(services.holdAll).toHaveBeenCalledTimes(1);
    expect(services.revokeExposure).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(closeCard).toHaveBeenCalledTimes(1);
    expect(closeCard.mock.calls[0]?.[1]).toContain("賭け金を確認できない");
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(hasTransientParticipation("bob")).toBe(false);
    expect(getChallenge("c1")).toBeUndefined();
  });
});

describe("挑戦者の解決は徴収より前", () => {
  it("挑戦者を取れなければ徴収も対戦も起きず、仮確保した席を解く", async () => {
    const { interaction, deps, collect, run, closeCard } = setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 徴収後にここが落ちると runFundedSession の保護区間へ入れず資金が残る。
    // だから解決は徴収より前で、失敗しても1 Ld も動かないこと
    (deps as { fetchUser?: unknown }).fetchUser = async () => {
      throw new Error("Unknown User");
    };

    const result = await acceptPvpChallenge(interaction, {} as never, "c1", deps);

    expect(result).toEqual({ ok: false, reason: "challenger_unresolved" });
    expect(collect, "挑戦者を確認できないのに資金を動かしている").not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(closeCard).toHaveBeenCalled();
    expect(hasTransientParticipation("alice")).toBe(false);
    expect(hasTransientParticipation("bob")).toBe(false);
    expect(getChallenge("c1")).toBeUndefined();
  });

  it("台帳へ入る game 名が指名導線と同じ内部識別子になる", async () => {
    const { interaction, deps, collect } = setup();
    await acceptPvpChallenge(interaction, {} as never, "c1", deps);
    // 表示名（"チンチロ"）ではなく、既存の /勝負 チンチロ と同じ値
    expect(collect.mock.calls[0]?.[5]).toBe("chinchiro-duel");
  });
});
