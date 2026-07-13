import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther } from "../format.js";
import { C_JACKPOT, C_MAMMON, E, bar } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * /福分け — マモンの賭場のデイリーボーナス（casino-bot /daily 相当）。
 * 24時間に1回。連続日数ボーナス（7日毎に+50、最大+200）＋残高が少なければ救済プールから追加支給。
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
    const embed = new EmbedBuilder()
      .setAuthor({ name: "マモンの賭場 · 福分け" })
      .setColor(0x78716c)
      .setTitle("📅  もう受け取り済み")
      .setDescription(`次の福分けは <t:${r.nextClaimAt}:R>（<t:${r.nextClaimAt}:F>）`)
      .setFooter({ text: `連続日数を保つには <t:${r.nextClaimAt}:R>〜24時間以内に受け取れ` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }
  const { claim } = r;

  // 次の連続日ボーナスまでの進捗
  const nextBonusAt = Math.ceil(claim.streak / 7) * 7;
  const stepInto = claim.streak - Math.floor(claim.streak / 7) * 7;
  const streakProgress = bar(stepInto === 0 && claim.streak > 0 ? 7 : stepInto, 7, 14);

  // 内訳
  const breakdown: string[] = [];
  breakdown.push(`　基本  **+${fmtEther(claim.base)}**`);
  if (claim.streakBonus > 0) breakdown.push(`　連続日数ボーナス  **+${fmtEther(claim.streakBonus)}**`);
  if (claim.relief > 0) breakdown.push(`　${E.sparkle} 巡りの光（救済プール）  **+${fmtEther(claim.relief)}**`);

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · 福分け" })
    .setColor(claim.relief > 0 ? C_JACKPOT : C_MAMMON)
    .setTitle(`📅  受け取り  **+${fmtEther(claim.total)}**`)
    .addFields(
      { name: "▸ 内訳", value: breakdown.join("\n"), inline: false },
      {
        name: "🔥 連続日数",
        value: [
          `**${claim.streak}日** ${claim.isConsecutive ? "（連続中）" : "（新規カウント）"}`,
          `\`${streakProgress}\`  次の +${Math.min(200, Math.floor(nextBonusAt / 7) * 50)}◈ ボーナスまで ${claim.streak >= nextBonusAt ? 0 : nextBonusAt - claim.streak}日`,
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: `所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")} · 次は 24 時間後` });

  await interaction.reply({ embeds: [embed] });
}
