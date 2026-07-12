import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../services.js";
import { playKeiba } from "../casino/keiba.js";

/**
 * /競馬 — マモンの賭場の冥馬レース。誰でも卓を開ける。
 */
export const keibaCommand = new SlashCommandBuilder()
  .setName("競馬")
  .setDescription("🏇 冥馬レースを開く（60秒受付・単勝/複勝）")
  .setDMPermission(false);

export async function handleKeibaCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await playKeiba(interaction, services);
}
