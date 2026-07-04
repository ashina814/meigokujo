import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import { isAdmin } from "../permissions.js";
import { updateDashboard } from "../dashboard.js";
import type { Services } from "../services.js";

/** 計器盤をこのチャンネルに設置（または即時更新）する */
export const dashboardCommand = new SlashCommandBuilder()
  .setName("計器盤")
  .setDescription("城の計器盤を設置・更新する（運営専用）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub.setName("設置").setDescription("このチャンネルを計器盤にする（10分ごと自動更新）"),
  )
  .addSubcommand((sub) => sub.setName("更新").setDescription("今すぐ更新する"));

export async function handleDashboardCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = interaction.options.getSubcommand();
  const actor = `user:${interaction.user.id}`;

  if (sub === "設置") {
    if (!interaction.channelId) return;
    services.settings.set("channel:keikiban", interaction.channelId, actor);
    services.settings.set("dashboard:message_id", "", actor); // 新規投稿させる
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await updateDashboard(interaction.client, services);
  await interaction.editReply({
    content: sub === "設置" ? "✅ 計器盤を設置しました（以降10分ごとに自動更新されます）。" : "✅ 更新しました。",
  });
}
