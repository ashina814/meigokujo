import { MessageFlags, type ButtonInteraction, type EmbedBuilder } from "discord.js";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";
import { renderCasinoAmountPicker, renderCasinoGameSelect } from "./amount-picker.js";
import { checkRetry, isSeatOccupied, SEAT_BUSY_REASON } from "./common.js";
import { isCasinoSoloGame, type CasinoSoloGame } from "./games.js";
import { startCasinoSoloGame } from "./play-route.js";
import { CASINO_EXIT_PREFIX, CASINO_RESULT_PREFIX, CASINO_RETRY_PREFIX } from "./solo-result.js";
import { parseStrictPositiveInteger } from "./wager-input.js";
import { paytableEmbed as blackjackRulesEmbed } from "./blackjack.js";
import { paytableEmbed as chinchiroRulesEmbed } from "./chinchiro.js";
import { paytableEmbed as chohanRulesEmbed } from "./chohan.js";
import { paytableEmbed as crashRulesEmbed } from "./crash.js";
import { holdemRulesEmbed } from "./holdem.js";
import { paytableEmbed as pokerRulesEmbed } from "./poker.js";
import { paytableEmbed as slotsRulesEmbed } from "./slots.js";

type ResultNav =
  | { ok: true; kind: "amount" | "rules"; game: CasinoSoloGame; ownerId: string }
  | { ok: true; kind: "games"; ownerId: string }
  | { ok: false };

export type CasinoRetryButtonParse =
  | { ok: true; game: CasinoSoloGame; amount: number; ownerId: string }
  | { ok: false };

export function isCasinoResultButton(customId: string): boolean {
  return customId.startsWith(CASINO_RESULT_PREFIX) || customId.startsWith(CASINO_RETRY_PREFIX) || customId.startsWith(CASINO_EXIT_PREFIX);
}

export async function handleCasinoResultButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId.startsWith(CASINO_RETRY_PREFIX)) {
    await handleCasinoRetry(interaction, services);
    return;
  }
  if (interaction.customId.startsWith(CASINO_EXIT_PREFIX)) {
    await handleCasinoExit(interaction, services);
    return;
  }

  const parsed = parseResultNav(interaction.customId);
  if (!parsed.ok) {
    await interaction.reply({ content: "❌ 不明な結果操作です。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!(await assertOwner(interaction, parsed.ownerId))) return;

  if (parsed.kind === "games") {
    await interaction.reply({ ...renderCasinoGameSelect(), flags: MessageFlags.Ephemeral });
    return;
  }
  if (parsed.kind === "amount") {
    await interaction.reply({ ...renderCasinoAmountPicker(parsed.ownerId, parsed.game, services), flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ embeds: [rulesEmbed(parsed.game)], flags: MessageFlags.Ephemeral });
}

export function parseCasinoRetryButton(customId: string): CasinoRetryButtonParse {
  const parts = customId.split(":");
  if (parts.length !== 5 || parts[0] !== "casino" || parts[1] !== "retry") return { ok: false };
  const [, , game, amountRaw, ownerId] = parts;
  if (!game || !isCasinoSoloGame(game)) return { ok: false };
  const parsedAmount = parseStrictPositiveInteger(amountRaw ?? "");
  if (!parsedAmount.ok) return { ok: false };
  if (!ownerId || !/^\d+$/.test(ownerId)) return { ok: false };
  return { ok: true, game, amount: parsedAmount.amount, ownerId };
}

async function handleCasinoRetry(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parsed = parseCasinoRetryButton(interaction.customId);
  if (!parsed.ok) {
    await interaction.reply({ content: "❌ 不明な再戦操作です。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!(await assertOwner(interaction, parsed.ownerId))) return;
  if (isSeatOccupied(interaction.user.id)) {
    await interaction.reply({ content: SEAT_BUSY_REASON, flags: MessageFlags.Ephemeral });
    return;
  }

  let retry: ReturnType<typeof checkRetry>;
  try {
    retry = checkRetry(services, interaction.user.id, parsed.amount, parsed.game);
  } catch {
    await interaction.reply({
      content: "❌ 現在の残高・胴元余力を確認できないため、再戦できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!retry.ok) {
    await interaction.reply({ content: `❌ ${retry.reason}`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  await startCasinoSoloGame(interaction, services, parsed.game, retry.bet, { source: "retry" });
}

function parseResultNav(customId: string): ResultNav {
  const parts = customId.split(":");
  if (parts[0] !== "casino" || parts[1] !== "result") return { ok: false };
  if (parts[2] === "games" && parts.length === 4 && parts[3]) {
    return { ok: true, kind: "games", ownerId: parts[3] };
  }
  if ((parts[2] === "amount" || parts[2] === "rules") && parts.length === 5 && parts[3] && parts[4]) {
    if (!isCasinoSoloGame(parts[3])) return { ok: false };
    return { ok: true, kind: parts[2], game: parts[3], ownerId: parts[4] };
  }
  return { ok: false };
}

function parseExit(customId: string): { ok: true; ownerId: string } | { ok: false } {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== "casino" || parts[1] !== "exit" || !parts[2]) return { ok: false };
  return { ok: true, ownerId: parts[2] };
}

async function assertOwner(interaction: ButtonInteraction, ownerId: string): Promise<boolean> {
  if (interaction.user.id === ownerId) return true;
  await interaction.reply({ content: "❌ 他人の結果画面は操作できません。", flags: MessageFlags.Ephemeral });
  return false;
}

async function handleCasinoExit(interaction: ButtonInteraction, services: Services): Promise<void> {
  const parsed = parseExit(interaction.customId);
  if (!parsed.ok) {
    await interaction.reply({ content: "❌ 不明な退場操作です。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!(await assertOwner(interaction, parsed.ownerId))) return;

  let result: ReturnType<Services["chipFlow"]["redeemFreeChips"]>;
  try {
    result = services.chipFlow.redeemFreeChips(interaction.user.id, interaction.id, "賭場を出る");
  } catch {
    await interaction.reply({
      content: "⚠️ 自由チップの返還処理でエラーが発生しました。残高を確認してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (result.skipped === "active_ownership") {
    await interaction.reply({
      content: "進行中の勝負・卓・板等があるため、今は返還できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: result.redeemed > 0
      ? `${fmtLd(result.redeemed)}をLandへ戻して賭場を出ました。`
      : "戻す自由チップはありません。賭場を出ました。",
    flags: MessageFlags.Ephemeral,
  }).catch(() => undefined);
  await interaction.message.edit({ components: [] }).catch(() => undefined);
}

function rulesEmbed(game: CasinoSoloGame): EmbedBuilder {
  switch (game) {
    case "スロット": return slotsRulesEmbed();
    case "丁半": return chohanRulesEmbed();
    case "クラッシュ": return crashRulesEmbed();
    case "チンチロ": return chinchiroRulesEmbed();
    case "ブラックジャック": return blackjackRulesEmbed();
    case "ポーカー": return pokerRulesEmbed();
    case "ホールデム": return holdemRulesEmbed();
  }
}
