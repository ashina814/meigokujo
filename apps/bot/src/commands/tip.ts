import {
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { LedgerError } from "@meigokujo/core";
import { fmtLd } from "../format.js";
import type { Services } from "../services.js";

/**
 * 投げ銭（経済設計.md §4 循環: 住人→住人）。type=tip・公開ログに流れる。
 * 高額は台帳の承認閾値に当たるので、その場合は /送金 に誘導する。
 */
export const tipCommand = new SlashCommandBuilder()
  .setName("投げ銭")
  .setDescription("住人に Land を投げ銭する（公開ログに流れます）")
  .setDMPermission(false)
  .addUserOption((o) => o.setName("相手").setDescription("投げ銭する相手").setRequired(true))
  .addIntegerOption((o) => o.setName("金額").setDescription("Land").setRequired(true).setMinValue(1))
  .addStringOption((o) => o.setName("一言").setDescription("メッセージ（任意）").setMaxLength(100));

export async function handleTip(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const target = interaction.options.getUser("相手", true);
  const amount = interaction.options.getInteger("金額", true);
  const message = interaction.options.getString("一言") ?? undefined;

  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "自分には投げ銭できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.bot) {
    await interaction.reply({ content: "Bot には投げ銭できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const from = `user:${interaction.user.id}`;
  const to = `user:${target.id}`;
  services.ledger.ensureAccount(from, "user");
  services.ledger.ensureAccount(to, "user");

  try {
    const result = services.ledger.transfer({
      from,
      to,
      amount,
      type: "tip",
      actor: from,
      reason: message,
      idempotencyKey: `tip:${interaction.id}`,
    });
    await interaction.reply({
      content: `💝 <@${target.id}> に **${fmtLd(amount)}** を投げ銭しました${message ? `\n『${message}』` : ""}（tx#${result.tx.id}）`,
      allowedMentions: { users: [target.id] },
    });
  } catch (e) {
    let msg = "投げ銭に失敗しました。";
    if (e instanceof LedgerError && e.code === "ERR_INSUFFICIENT") {
      msg = `残高が足りません（所持: ${fmtLd(Number(e.details.balance))} / 必要: ${fmtLd(amount)}）。`;
    } else if (e instanceof LedgerError && e.code === "ERR_NEEDS_APPROVAL") {
      msg = "高額の投げ銭は `/送金` をご利用ください（#決裁の承認が要ります）。";
    }
    await interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });
  }
}
