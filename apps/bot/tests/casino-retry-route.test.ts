import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import type { Services } from "../src/services.js";
import { acquireSeat, releaseSeat, SEAT_BUSY_REASON } from "../src/casino/common.js";
import { CASINO_SOLO_GAMES } from "../src/casino/games.js";
import { retryCustomIdFor } from "../src/casino/solo-result.js";

const startCasinoSoloGameMock = vi.hoisted(() => vi.fn());

vi.mock("../src/casino/play-route.js", () => ({
  startCasinoSoloGame: startCasinoSoloGameMock,
}));

import { handleCasinoResultButton, parseCasinoRetryButton } from "../src/casino/result-route.js";

const OWNER_ID = "123456789012345678";
const OTHER_ID = "987654321098765432";

function fakeServices(opts: {
  land?: number;
  free?: number;
  capacity?: number;
  capacityThrows?: boolean;
} = {}): { services: Services; calls: Record<"balanceOf" | "freeChips" | "availableForLiability", ReturnType<typeof vi.fn>> } {
  const calls = {
    balanceOf: vi.fn(() => opts.land ?? 10_000),
    freeChips: vi.fn(() => opts.free ?? 0),
    availableForLiability: vi.fn(() => {
      if (opts.capacityThrows) throw new Error("capacity unavailable");
      return opts.capacity ?? 1_000_000;
    }),
  };

  return {
    calls,
    services: {
      ledger: { balanceOf: calls.balanceOf },
      chipAssets: { freeChips: calls.freeChips },
      casino: {
        availableForLiability: calls.availableForLiability,
        stats: () => ({ current_win_streak: 0 }),
      },
      vip: {
        isVip: () => false,
        betCapMult: () => 2,
      },
      items: {
        armedWinBonusCap: () => 0,
      },
    } as unknown as Services,
  };
}

function button(customId: string, userId = OWNER_ID) {
  return {
    customId,
    id: "interaction-1",
    user: { id: userId },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    deferUpdate: ReturnType<typeof vi.fn>;
  };
}

describe("casino retry route", () => {
  beforeEach(() => {
    startCasinoSoloGameMock.mockReset();
    releaseSeat(OWNER_ID);
    releaseSeat(OTHER_ID);
  });

  it("parses retry custom ids for all solo games", () => {
    for (const game of CASINO_SOLO_GAMES) {
      expect(parseCasinoRetryButton(retryCustomIdFor(game, 500, OWNER_ID))).toEqual({
        ok: true,
        game,
        amount: 500,
        ownerId: OWNER_ID,
      });
    }
  });

  it("rejects malformed retry custom ids fail-closed", () => {
    const game = CASINO_SOLO_GAMES[0]!;
    for (const customId of [
      "casino:retry:unknown:500:123456789012345678",
      `casino:retry:${game}:`,
      `casino:retry:${game}:0:${OWNER_ID}`,
      `casino:retry:${game}:-1:${OWNER_ID}`,
      `casino:retry:${game}:100.5:${OWNER_ID}`,
      `casino:retry:${game}:1e3:${OWNER_ID}`,
      `casino:retry:${game}:Infinity:${OWNER_ID}`,
      `casino:retry:${game}:NaN:${OWNER_ID}`,
      `casino:retry:${game}:9007199254740992:${OWNER_ID}`,
      `casino:retry:${game}:500`,
      `casino:retry:${game}:500:`,
      `casino:retry:${game}:500:${OWNER_ID}:extra`,
      `casino:retry:${game}:500:user-${OWNER_ID}`,
      `casino:retry:${game}:500:123:456`,
      `casino:play:${game}:500:${OWNER_ID}`,
    ]) {
      expect(parseCasinoRetryButton(customId)).toEqual({ ok: false });
    }
  });

  it("rejects non-owners before balance, seat, defer, or play checks", async () => {
    const game = CASINO_SOLO_GAMES[1]!;
    const { services, calls } = fakeServices();
    const interaction = button(retryCustomIdFor(game, 500, OWNER_ID), OTHER_ID);

    await handleCasinoResultButton(interaction, services);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(startCasinoSoloGameMock).not.toHaveBeenCalled();
    expect(calls.balanceOf).not.toHaveBeenCalled();
    expect(calls.freeChips).not.toHaveBeenCalled();
    expect(calls.availableForLiability).not.toHaveBeenCalled();
  });

  it("rejects occupied seats before retry validation, defer, or play", async () => {
    const game = CASINO_SOLO_GAMES[1]!;
    const { services, calls } = fakeServices();
    const interaction = button(retryCustomIdFor(game, 500, OWNER_ID));

    expect(acquireSeat(OWNER_ID)).toBe(true);
    try {
      await handleCasinoResultButton(interaction, services);
    } finally {
      releaseSeat(OWNER_ID);
    }

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: SEAT_BUSY_REASON }));
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(startCasinoSoloGameMock).not.toHaveBeenCalled();
    expect(calls.balanceOf).not.toHaveBeenCalled();
    expect(calls.freeChips).not.toHaveBeenCalled();
    expect(calls.availableForLiability).not.toHaveBeenCalled();
  });

  it("revalidates retry affordability on press", async () => {
    const game = CASINO_SOLO_GAMES[1]!;
    const { services } = fakeServices({ land: 10, free: 0 });
    const interaction = button(retryCustomIdFor(game, 500, OWNER_ID));

    await handleCasinoResultButton(interaction, services);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(startCasinoSoloGameMock).not.toHaveBeenCalled();
  });

  it("fails closed when retry validation throws", async () => {
    const game = CASINO_SOLO_GAMES[1]!;
    const { services } = fakeServices({ capacityThrows: true });
    const interaction = button(retryCustomIdFor(game, 500, OWNER_ID));

    await handleCasinoResultButton(interaction, services);

    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(startCasinoSoloGameMock).not.toHaveBeenCalled();
  });

  it("defers and dispatches through the canonical solo game starter after retry checks pass", async () => {
    const game = CASINO_SOLO_GAMES[1]!;
    const { services } = fakeServices({ land: 10_000, free: 0 });
    const interaction = button(retryCustomIdFor(game, 500, OWNER_ID));

    await handleCasinoResultButton(interaction, services);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(startCasinoSoloGameMock).toHaveBeenCalledWith(interaction, services, game, 500);
  });
});
