import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction } from "discord.js";
import type { Services } from "../src/services.js";
import { handleCasinoHomeButton } from "../src/commands/casino-home.js";

/**
 * 「/賭場 から開く個人用の子画面からは、必ず同じ場所へ帰れる」ことの検査。
 *
 * 公開1v1・競馬・板は専用パネルへ分離済みで、特に公開1v1は募集専用チャンネルから
 * 個人ホームへ抜ける導線を持たせない。ここで守るのは個人ホーム配下の画面だけ。
 */

function fakeServices(): Services {
  return {
    casinoStatus: { current: () => ({ status: "open", reason: "", changedBy: "boss", changedAt: 1 }) },
    chipTx: { openingPhase: () => "formal" },
    ledger: { balanceOf: () => 50_000 },
    chipAssets: { forUser: () => ({ userId: "u1", freeChips: 1_000, escrowed: 0, total: 1_000 }), freeChips: () => 1_000 },
    casino: { jackpotPool: () => 100, stats: () => ({ current_win_streak: 0 }), top: () => [], availableForLiability: () => 1_000_000, homePreference: () => null },
    daily: { nextClaimAt: () => 0 },
    vip: { isVip: () => false, betCapMult: () => 2 },
    items: { inventory: () => [], armedList: () => [], armedWinBonusCap: () => 0 },
    chips: { balanceOf: () => 1_000 },
    dailyRisk: { maxBetForPlayerLoss: (_u: string, _f: unknown, cap: number) => cap },
  } as unknown as Services;
}

function buttonFor(customId: string) {
  return {
    customId,
    id: "interaction-1",
    user: { id: "u1" },
    guild: null,
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ButtonInteraction & {
    reply: ReturnType<typeof vi.fn>;
    editReply: ReturnType<typeof vi.fn>;
  };
}

function backButtonIds(payload: unknown): string[] {
  const rows = ((payload as { components?: unknown[] }).components ?? []) as Array<{
    toJSON(): { components: Array<{ custom_id?: string }> };
  }>;
  return rows.flatMap((row) => row.toJSON().components.map((c) => c.custom_id ?? ""));
}

describe("/賭場 の個人用子画面はホームへ帰れる", () => {
  for (const customId of ["casino:home:shop", "casino:home:banzuke", "casino:home:first"]) {
    it(`${customId} にホームへ戻る導線がある`, async () => {
      const interaction = buttonFor(customId);
      await handleCasinoHomeButton(interaction, fakeServices());
      const payload = interaction.reply.mock.calls[0]![0];
      expect(backButtonIds(payload)).toContain("casino:home:back");
    });
  }

  it("通行証（画像）にもホームへ戻る導線がある", async () => {
    const interaction = buttonFor("casino:home:passport");
    await handleCasinoHomeButton(interaction, fakeServices()).catch(() => undefined);
    const payload = interaction.editReply.mock.calls[0]?.[0];
    if (payload) expect(backButtonIds(payload)).toContain("casino:home:back");
  });

  it("戻るボタンはホームを描き直す", async () => {
    // 戻るボタンは本人だけのホーム（ephemeral）にしか出ない。
    // 公開メッセージ上では update せず ephemeral reply になる（看板を壊さないため）
    const interaction = { ...buttonFor("casino:home:back"), message: { flags: { has: () => true } } };
    await handleCasinoHomeButton(interaction, fakeServices());
    const payload = (interaction.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(backButtonIds(payload)).toContain("casino:home:games");
  });
});
