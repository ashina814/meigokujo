import type { ChatInputCommandInteraction } from "discord.js";
import type { Services } from "../services.js";
import { playKeiba } from "../casino/keiba.js";

/**
 * @deprecated slash registrationから退役済み。公開入口は専用常設パネル。
 * /競馬 — マモンの賭場の冥馬レース。誰でも卓を開ける。
 */
export async function handleKeibaCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await playKeiba(interaction, services);
}
