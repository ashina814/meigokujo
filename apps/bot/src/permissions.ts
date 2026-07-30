import type { GuildMember, Interaction } from "discord.js";
import { config } from "./config.js";
import { memberInSlot } from "./church-roles.js";
import type { Services } from "./services.js";

/** OWNER または運営ボードの「管理コマンド利用ロール」保持者だけが運営操作を行える */
export function isAdmin(interaction: Interaction, services: Services): boolean {
  if (interaction.user.id === config.ownerId) return true;
  const member = interaction.member as GuildMember | null;
  return memberInSlot(member, services, "admin");
}
