import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { isAdmin } from "../permissions.js";
import { createAndPostDraft } from "../payday.js";
import { jstNow } from "../scheduler.js";
import type { Services } from "../services.js";

/** 手動起動（臨時・再実行用）。通常は刻時盤が毎月1日 09:00 に自動でドラフトを投稿する */
export const paydayCommand = new SlashCommandBuilder()
  .setName("給与支給")
  .setDescription("支給案を作成して #決裁 に承認パネルを出す（運営専用・臨時用）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o.setName("対象月").setDescription("YYYY-MM 形式（省略時は今月）").setMaxLength(7),
  );

export async function handlePaydayCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.guildId) {
    services.settings.set("guild:main", interaction.guildId, `user:${interaction.user.id}`);
  }
  const period = interaction.options.getString("対象月") ?? jstNow().period;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await createAndPostDraft(
    interaction.client,
    services,
    period,
    `user:${interaction.user.id}`,
  );
  await interaction.editReply({
    content: result.ok
      ? `✅ ${period} の支給案 (#${result.runId}) を #決裁 に投稿しました。承認ボタンで実行されます。`
      : `❌ ${result.message}`,
  });
}
