import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Services } from "../src/services.js";

const common = vi.hoisted(() => ({
  releaseSeat: vi.fn(),
}));

vi.mock("../src/casino/common.js", () => ({
  MIN_BET: 5,
  acquireSeat: vi.fn(() => true),
  releaseSeat: common.releaseSeat,
  sleep: vi.fn(async () => undefined),
  validateBet: vi.fn(async (_interaction: unknown, _services: unknown, bet: number) => ({ ok: true, bet })),
  withHouseReservation: vi.fn(async (
    _interaction: unknown,
    _services: unknown,
    _game: string,
    _bet: number,
    _operationId: string,
    run: (reservationKey: string) => Promise<void>,
  ) => run("reservation")),
  reserveBlackjackLiability: vi.fn(() => ({ reservationKey: "reservation", doubleAllowed: false })),
  withExplicitHouseReservation: vi.fn(async (
    _interaction: unknown,
    _services: unknown,
    _game: string,
    _reserve: unknown,
    run: (reservationKey: string) => Promise<void>,
  ) => run("reservation")),
}));

vi.mock("../src/casino/solo-result.js", () => ({
  buildSoloResult: vi.fn(() => ({ embeds: [], components: [] })),
}));

vi.mock("../src/casino/bigwin.js", () => ({
  broadcastBigWin: vi.fn(),
}));

import { isCollectorTimeoutError } from "../src/casino/metrics.js";
import { playChohan } from "../src/casino/chohan.js";
import { playBlackjack } from "../src/casino/blackjack.js";

const timeoutError = () => ({
  code: "InteractionCollectorError",
  message: "Collector received no interactions before ending with reason: time",
});

function fakeInteraction(error: unknown) {
  const message = {
    awaitMessageComponent: vi.fn().mockRejectedValue(error),
    edit: vi.fn().mockResolvedValue(undefined),
  };
  const interaction = {
    id: "interaction-1",
    user: { id: "alice" },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(message),
    fetchReply: vi.fn().mockResolvedValue(message),
    client: {},
  };
  return { interaction, message };
}

function fakeServices() {
  const metricCalls = {
    start: vi.fn(),
    finish: vi.fn(),
    abandon: vi.fn(),
    replay: vi.fn(),
  };
  const settleSolo = vi.fn(() => ({
    payout: 100,
    net: 0,
    chainBonus: 0,
    chainLabel: "",
    chainStreak: 0,
    chainMult: 1,
    fukuTax: 0,
    fukuRate: 0,
    amuletNote: null,
  }));
  const services = {
    casinoMetrics: {
      gameStart: metricCalls.start,
      gameFinish: metricCalls.finish,
      gameAbandon: metricCalls.abandon,
      replay: metricCalls.replay,
    },
    rng: {
      int: vi.fn(() => 1),
      // pop() order after identity shuffle gives player K/Q=20, dealer J/10=20: no natural.
      shuffle: vi.fn(<T>(values: T[]) => values),
    },
    casino: { settleSolo },
    chips: { balanceOf: vi.fn(() => 10_000) },
  } as unknown as Services;
  return { services, metricCalls, settleSolo };
}

describe("PR19 game_abandon classification", () => {
  it("recognizes only an InteractionCollectorError whose end reason is time", () => {
    expect(isCollectorTimeoutError(timeoutError())).toBe(true);
    expect(isCollectorTimeoutError({
      code: "InteractionCollectorError",
      message: "Collector received no interactions before ending with reason: messageDelete",
    })).toBe(false);
    expect(isCollectorTimeoutError({
      code: "InteractionCollectorError",
      message: "Collector received no interactions before ending with reason: channelDelete",
    })).toBe(false);
    expect(isCollectorTimeoutError(new Error("Discord API failed"))).toBe(false);
  });

  it("Chohan genuine timeout records abandon and does not settle/finish", async () => {
    const { interaction } = fakeInteraction(timeoutError());
    const { services, metricCalls, settleSolo } = fakeServices();

    await playChohan(interaction as never, services, 100, { source: "amount" });

    expect(metricCalls.start).toHaveBeenCalledOnce();
    expect(metricCalls.abandon).toHaveBeenCalledOnce();
    expect(metricCalls.finish).not.toHaveBeenCalled();
    expect(settleSolo).not.toHaveBeenCalled();
  });

  it("Chohan system/Discord error is rethrown without abandon or finish", async () => {
    const systemError = new Error("Discord API failed");
    const { interaction } = fakeInteraction(systemError);
    const { services, metricCalls, settleSolo } = fakeServices();

    await expect(playChohan(interaction as never, services, 100, { source: "amount" })).rejects.toBe(systemError);

    expect(metricCalls.start).toHaveBeenCalledOnce();
    expect(metricCalls.abandon).not.toHaveBeenCalled();
    expect(metricCalls.finish).not.toHaveBeenCalled();
    expect(settleSolo).not.toHaveBeenCalled();
  });

  it("Blackjack genuine timeout records abandon, then conservative stand settlement records finish", async () => {
    const { interaction } = fakeInteraction(timeoutError());
    const { services, metricCalls, settleSolo } = fakeServices();

    await playBlackjack(interaction as never, services, 100, { source: "amount" });

    expect(metricCalls.start).toHaveBeenCalledOnce();
    expect(metricCalls.abandon).toHaveBeenCalledOnce();
    expect(settleSolo).toHaveBeenCalledOnce();
    expect(metricCalls.finish).toHaveBeenCalledOnce();
  });
});

describe("PR19 collector end reason structure", () => {
  const source = (name: string) => readFileSync(new URL(`../src/casino/${name}.ts`, import.meta.url), "utf8");

  it("Chohan, Blackjack and Holdem rethrow non-time awaitMessageComponent failures", () => {
    for (const name of ["chohan", "blackjack", "holdem"]) {
      const text = source(name);
      expect(text).toContain("if (!isCollectorTimeoutError(error)) throw error;");
    }
  });

  it("Poker and Chinchiro record abandon only for collector end reason time", () => {
    for (const name of ["poker", "chinchiro"]) {
      const text = source(name);
      expect(text).toContain('if (reason === "time")');
      expect(text).toContain("collector ended without timeout");
    }
  });

  it("Crash ordinary bust path does not emit game_abandon", () => {
    expect(source("crash")).not.toContain("recordCasinoGameAbandonBestEffort");
  });
});
