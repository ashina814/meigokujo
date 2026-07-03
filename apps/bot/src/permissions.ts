import type { GuildMember, Interaction } from "discord.js";
import { config } from "./config.js";
import type { Services } from "./services.js";

/** OWNER または /設定 管理ロールで指定されたロールの保持者だけが運営操作を行える */
export function isAdmin(interaction: Interaction, services: Services): boolean {
  if (interaction.user.id === config.ownerId) return true;
  const adminRoleId = services.settings.getString("role:admin");
  if (!adminRoleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(adminRoleId) ?? false;
}
