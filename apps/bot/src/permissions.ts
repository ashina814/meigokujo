import type { GuildMember, Interaction } from "discord.js";
import { config } from "./config.js";
import { memberInSlot } from "./church-roles.js";
import type { Services } from "./services.js";

/** OWNER または運営ボードの「管理コマンド利用ロール」保持者だけが運営操作を行える */
export function isAdminMember(member: GuildMember | null | undefined, services: Services): boolean {
  if (!member) return false;
  if (member.id === config.ownerId) return true;
  return memberInSlot(member, services, "admin");
}

export function isAdmin(interaction: Interaction, services: Services): boolean {
  if (interaction.user.id === config.ownerId) return true;
  const member = interaction.member as GuildMember | null;
  return isAdminMember(member, services);
}

/**
 * 賭博場従業員パネル（/賭場運営）の利用資格（PR24）。
 *
 * 運営（OWNER / 管理ロール）は上位資格として当然使える。賭博場従業員ロールは
 * **このパネルだけ**を開ける資格で、{@link isAdmin} には一切影響しない
 * ——従業員だからといって /管理 や裁定・金銭操作へ入れるようになってはいけない。
 */
export function isCasinoEmployee(interaction: Interaction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const member = interaction.member as GuildMember | null;
  return memberInSlot(member, services, "casino_employee");
}
