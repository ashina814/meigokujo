import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Services } from "../services.js";

export const weatherCommand = new SlashCommandBuilder()
  .setName("天気")
  .setDescription("今日の冥界の天気（カジノ配当への影響）")
  .setDMPermission(false);

export async function handleWeatherCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const w = services.weather.today();
  const eff = w.mult === 1 ? "配当は平常（等倍）。" : w.mult > 1 ? `カジノ配当が **×${w.mult}**（プレイヤー有利）！` : `カジノ配当が **×${w.mult}**（渋め）。`;
  const embed = new EmbedBuilder()
    .setTitle(`🌦 冥界の天気: ${w.emoji} ${w.label}`)
    .setColor(w.mult > 1 ? 0xf0b429 : w.mult < 1 ? 0x64748b : 0x8b5cf6)
    .setDescription([w.note, "", eff, "", "天気は毎朝7時に変わります。"].join("\n"));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
