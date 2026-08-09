import { describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../src/services.js";
import { validateBet } from "../src/casino/common.js";

function fakeInteraction() {
  return {
    id: "interaction-1",
    user: { id: "u1" },
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction & {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
  };
}

function fakeServices(opts: { vip?: boolean; vipMult?: number } = {}) {
  const ensureFreeChips = vi.fn((_userId: string, amount: number) => ({ freeAfter: amount }));
  const services = {
    vip: {
      isVip: () => opts.vip ?? false,
      betCapMult: () => opts.vipMult ?? 2,
    },
    casino: {
      stats: () => ({ current_win_streak: 0 }),
      availableForLiability: () => Number.MAX_SAFE_INTEGER,
    },
    items: {
      armedWinBonusCap: () => 0,
    },
    chipFlow: {
      ensureFreeChips,
    },
    chipAssets: {
      freeChips: () => 1_000_000,
    },
    dailyRisk: {
      maxBetForPlayerLoss: (_userId: string, _lossPerBet: (bet: number) => number, cap: number) => cap,
      authorizeSoloStart: vi.fn(),
      dayFor: () => ({ lossCap: 1_000_000, remainingLossBudget: 1_000_000 }),
    },
  } as unknown as Services;
  return { services, ensureFreeChips };
}

describe("validateBet — PR16 safe integer validation", () => {
  it("100.9を100へ丸めず拒否する", async () => {
    const interaction = fakeInteraction();
    const { services, ensureFreeChips } = fakeServices();

    const result = await validateBet(interaction, services, 100.9, "丁半");

    expect(result).toEqual({ ok: false, bet: 100.9 });
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(ensureFreeChips).not.toHaveBeenCalled();
  });

  it("正常整数100は従来どおり受理する", async () => {
    const interaction = fakeInteraction();
    const { services, ensureFreeChips } = fakeServices();

    const result = await validateBet(interaction, services, 100, "丁半");

    expect(result).toEqual({ ok: true, bet: 100 });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(ensureFreeChips).toHaveBeenCalledWith("u1", 100, "interaction-1");
  });

  it("configured cap以内でもunsafe integerは拒否する", async () => {
    const interaction = fakeInteraction();
    const { services, ensureFreeChips } = fakeServices({ vip: true, vipMult: 100_000_000_000 });
    const unsafe = Number.MAX_SAFE_INTEGER + 1;

    const result = await validateBet(interaction, services, unsafe, "丁半");

    expect(result).toEqual({ ok: false, bet: unsafe });
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(ensureFreeChips).not.toHaveBeenCalled();
  });
});
