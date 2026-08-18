import { MessageFlags, type ButtonInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { handleCasinoHomeButton } from "../src/commands/casino-home.js";

function interaction(customId: string) {
  const reply = vi.fn(async () => undefined);
  return {
    value: {
      customId,
      user: { id: "u1" },
      guild: { name: "冥獄城" },
      reply,
    } as unknown as ButtonInteraction,
    reply,
  };
}

function services() {
  return {
    chipTx: { openingPhase: () => "formal" },
    casinoStatus: { current: () => ({ status: "open", reason: "" }) },
    chips: { balanceOf: () => 10_000 },
    dailyRisk: {
      maxBetForPlayerLoss: () => 10_000,
      holdings: () => 40_000,
    },
  } as never;
}

function customIds(payload: unknown): string[] {
  const input = payload as { components?: Array<{ toJSON(): { components?: Array<{ custom_id?: string }> } }> };
  return (input.components ?? []).flatMap((row) =>
    (row.toJSON().components ?? []).map((component) => component.custom_id).filter((id): id is string => Boolean(id)),
  );
}

describe("みんなで勝負 専用パネルの実ルート", () => {
  it("専用パネル → ゲーム選択 → 賭け金選択まで同じhandlerで到達できる", async () => {
    const s = services();
    const first = interaction("casino:home:pvp");

    await handleCasinoHomeButton(first.value, s);

    expect(first.reply).toHaveBeenCalledTimes(1);
    const firstPayload = first.reply.mock.calls[0]![0];
    expect((firstPayload as { flags?: number }).flags).toBe(MessageFlags.Ephemeral);
    const gameId = customIds(firstPayload).find((id) => id.startsWith("casino:home:pvpopen-game:"));
    expect(gameId).toBeTruthy();

    const second = interaction(gameId!);
    await handleCasinoHomeButton(second.value, s);

    expect(second.reply).toHaveBeenCalledTimes(1);
    const amountIds = customIds(second.reply.mock.calls[0]![0]);
    expect(amountIds.some((id) => id.startsWith("casino:home:pvpopen-post:"))).toBe(true);
    expect(amountIds.some((id) => id.startsWith("casino:home:pvpopen-custom:"))).toBe(true);
  });
});
