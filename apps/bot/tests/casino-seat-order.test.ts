import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import type { Services } from "../src/services.js";
import { MIN_BET, acquireSeat, isSeatOccupied, releaseSeat } from "../src/casino/common.js";
import { playSlots } from "../src/casino/slots.js";
import { playChohan } from "../src/casino/chohan.js";
import { playCrash } from "../src/casino/crash.js";
import { playChinchiro } from "../src/casino/chinchiro.js";
import { playBlackjack } from "../src/casino/blackjack.js";
import { playPoker } from "../src/casino/poker.js";
import { playHoldem } from "../src/casino/holdem.js";

type SoloEntry = (
  interaction: ButtonInteraction,
  services: Services,
  bet: number,
) => Promise<void>;

function interactionFor(userId: string) {
  return {
    id: `interaction-${userId}`,
    user: { id: userId },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

function fakeServices(opts: { validationThrows?: boolean } = {}) {
  const ensureFreeChips = vi.fn(() => ({
    freeBefore: 0,
    deposited: 500,
    freeAfter: 500,
  }));
  const availableForLiability = vi.fn(() => 1_000_000_000);
  const isVip = vi.fn(() => {
    if (opts.validationThrows) throw new Error("validation failed");
    return false;
  });

  const services = {
    vip: {
      isVip,
      betCapMult: () => 2,
    },
    casino: {
      availableForLiability,
      stats: () => ({ current_win_streak: 0 }),
    },
    items: {
      armedWinBonusCap: () => 0,
    },
    chipFlow: {
      ensureFreeChips,
    },
    chipAssets: {
      freeChips: () => 0,
    },
    dailyRisk: {
      maxBetForPlayerLoss: (_userId: string, _lossPerBet: (bet: number) => number, cap: number) => cap,
      authorizeSoloStart: vi.fn(),
      dayFor: () => ({ lossCap: 1_000_000, remainingLossBudget: 1_000_000 }),
    },
    persistentTables: {
      participantHasLiveTable: () => false,
    },
  } as unknown as Services;

  return { services, ensureFreeChips, availableForLiability, isVip };
}

const ENTRIES: Array<[string, SoloEntry]> = [
  ["スロット", playSlots],
  ["丁半", playChohan],
  ["クラッシュ", playCrash],
  ["チンチロ", playChinchiro],
  ["ブラックジャック", playBlackjack],
  ["ポーカー", playPoker],
  ["ホールデム", playHoldem],
];

describe("solo game public entry seat ordering", () => {
  for (const [game, play] of ENTRIES) {
    it(`${game}: occupied seat rejects before validation or automatic funding`, async () => {
      const uid = `seat-order-${game}`;
      const interaction = interactionFor(uid);
      const { services, ensureFreeChips, availableForLiability, isVip } = fakeServices();

      releaseSeat(uid);
      expect(acquireSeat(uid)).toBe(true);
      try {
        await play(interaction, services, 500);
      } finally {
        releaseSeat(uid);
      }

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("まだ前の勝負が終わっていない。") }),
      );
      expect(isVip).not.toHaveBeenCalled();
      expect(availableForLiability).not.toHaveBeenCalled();
      expect(ensureFreeChips).not.toHaveBeenCalled();
    });
  }

  it("丁半: invalid bet releases the seat through finally", async () => {
    const uid = "seat-order-invalid";
    const interaction = interactionFor(uid);
    const { services, ensureFreeChips } = fakeServices();

    releaseSeat(uid);
    await playChohan(interaction, services, MIN_BET - 1);

    expect(isSeatOccupied(uid)).toBe(false);
    expect(ensureFreeChips).not.toHaveBeenCalled();
  });

  it("丁半: validation exception also releases the seat through finally", async () => {
    const uid = "seat-order-throw";
    const interaction = interactionFor(uid);
    const { services, ensureFreeChips } = fakeServices({ validationThrows: true });

    releaseSeat(uid);
    await expect(playChohan(interaction, services, 500)).rejects.toThrow("validation failed");

    expect(isSeatOccupied(uid)).toBe(false);
    expect(ensureFreeChips).not.toHaveBeenCalled();
  });
});
