import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";

/**
 * /福分け — マモンの賭場のデイリーボーナス（casino-bot /daily 相当）。
 * 24時間に1回。連続日数ボーナス（7日ごとに+50、最大+200）＋残高が少なければ救済プールから追加支給。
 */
export const dailyCommand = new SlashCommandBuilder()
  .setName("福分け")
  .setDescription("📅 マモンの福分けを受け取る（24時間に1回）")
  .setDMPermission(false);

export async function handleDailyCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const uid = interaction.user.id;
  const r = services.daily.claim(uid);
  if (!r.ok) {
    const wait = r.nextClaimAt - Math.floor(Date.now() / 1000);
    await interaction.reply({
      content: `今日の福分けは既に受け取っている。次は <t:${r.nextClaimAt}:R> から。`,
      flags: MessageFlags.Ephemeral,
    });
    void wait;
    return;
  }
  const { claim } = r;
  const lines = [
    `💰 **+${fmtEther(claim.total)}**`,
    `　├ 基本: ${fmtEther(claim.base)}`,
    claim.streakBonus > 0 ? `　├ 連続ボーナス: +${fmtEther(claim.streakBonus)}` : "",
    claim.relief > 0 ? `　└ 🕊 巡りの光（救済プールから）: +${fmtEther(claim.relief)}` : "",
    "",
    `🔥 連続日数: **${claim.streak}日**${claim.isConsecutive ? "" : "（新規カウント）"}`,
  ].filter(Boolean);
  const embed = new EmbedBuilder()
    .setTitle("📅 マモンの福分け")
    .setColor(0xc9a227)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `所持: ${fmtEther(services.ether.balanceOf(uid))}` });
  await interaction.reply({ embeds: [embed] });
}
