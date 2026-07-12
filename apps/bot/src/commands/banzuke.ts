import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther } from "../format.js";
import type { Services } from "../services.js";

/**
 * /賭場番付 — マモンの賭場の番付（casino-bot /番付 相当）。
 * 冥獄城の /ランキング（住人の活動 4軸）とは別軸で、賭場での成績を並べる。
 * ephemeral（本人にだけ見える）。
 */
export const banzukeCommand = new SlashCommandBuilder()
  .setName("賭場番付")
  .setDescription("🏅 マモンの賭場の番付を見る")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("種別")
      .setDescription("見る番付")
      .setRequired(true)
      .addChoices(
        { name: "エテル残高", value: "balance" },
        { name: "勝率（10戦以上）", value: "win_rate" },
        { name: "最大単勝", value: "biggest_win" },
        { name: "総獲得", value: "total_earned" },
        { name: "総ベット", value: "total_wagered" },
        { name: "最長連勝", value: "best_win_streak" },
      ),
  );

const LABELS: Record<string, string> = {
  balance: "💰 エテル残高",
  win_rate: "📊 勝率",
  biggest_win: "🎯 最大単勝",
  total_earned: "📈 総獲得",
  total_wagered: "💸 総ベット",
  best_win_streak: "🔥 最長連勝",
};

export async function handleBanzukeCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const kind = interaction.options.getString("種別", true) as
    | "balance"
    | "win_rate"
    | "biggest_win"
    | "total_earned"
    | "total_wagered"
    | "best_win_streak";
  const rows = services.casino.top(kind, 10);
  const embed = new EmbedBuilder()
    .setTitle(`🏅 賭場番付 — ${LABELS[kind]} Top10`)
    .setColor(0xc9a227);
  if (rows.length === 0) {
    embed.setDescription("まだ番付に載る者がいない。");
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  const lines = rows.map((r, i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
    const value =
      kind === "win_rate"
        ? `${(r.value as number).toFixed(1)}%` + (r.sub ? `（${r.sub}戦）` : "")
        : kind === "best_win_streak"
          ? `${r.value}連勝`
          : fmtEther(r.value);
    return `${medal} <@${r.user_id}> — **${value}**`;
  });
  embed.setDescription(lines.join("\n"));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
