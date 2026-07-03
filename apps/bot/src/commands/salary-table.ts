import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

export const salaryTableCommand = new SlashCommandBuilder()
  .setName("給与表")
  .setDescription("ロールごとの給与を管理する（運営専用）")
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName("設定")
      .setDescription("ロールの給与額を設定（既存なら上書き）")
      .addRoleOption((o) => o.setName("ロール").setDescription("対象ロール").setRequired(true))
      .addIntegerOption((o) => o.setName("金額").setDescription("月給（Ld）").setRequired(true).setMinValue(0)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("削除")
      .setDescription("ロールを給与表から外す")
      .addRoleOption((o) => o.setName("ロール").setDescription("対象ロール").setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName("一覧").setDescription("給与表を表示"));

export async function handleSalaryTable(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "この操作には城の管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 刻時盤（給与の自動ドラフト）が対象ギルドを知るために記録しておく
  if (interaction.guildId) {
    services.settings.set("guild:main", interaction.guildId, `user:${interaction.user.id}`);
  }

  const sub = interaction.options.getSubcommand();
  const actor = `user:${interaction.user.id}`;

  if (sub === "設定") {
    const role = interaction.options.getRole("ロール", true);
    const amount = interaction.options.getInteger("金額", true);
    services.payroll.setSalary(role.id, role.name, amount, actor);
    await interaction.reply({
      content: `✅ 給与表: <@&${role.id}> = **${fmtLd(amount)}**/月（複数ロールは全額重複で支給されます）`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "削除") {
    const role = interaction.options.getRole("ロール", true);
    services.payroll.removeSalary(role.id, actor);
    await interaction.reply({ content: `✅ <@&${role.id}> を給与表から外しました。`, flags: MessageFlags.Ephemeral });
    return;
  }

  const rows = services.payroll.listSalaries();
  const lines =
    rows.length > 0
      ? rows.map((r) => `<@&${r.role_id}> — **${fmtLd(r.amount)}**`).join("\n")
      : "まだ何も設定されていません。`/給与表 設定` から登録してください。";
  const embed = new EmbedBuilder().setTitle("📑 給与表（毎月1日支給・全額重複）").setDescription(lines).setColor(0x6b21a8);
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
