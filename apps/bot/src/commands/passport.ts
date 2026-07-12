import {
  AttachmentBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import type { Services } from "../services.js";
import { renderPassportCard } from "../render/passport-card.js";

/**
 * /通行証 — マモンの賭場の通行証カード（casino-bot /通行証 相当）。
 * 冥獄城の /プロフィール（住人の記録カード）と対の位置付け:
 * - /プロフィール = 冥獄城住人としての階級・ランク・称号
 * - /通行証     = 賭場での戦績（残高・勝率・最大勝ち・連勝など）
 * どちらも本人だけに ephemeral で見える。
 */
export const passportCommand = new SlashCommandBuilder()
  .setName("通行証")
  .setDescription("🎫 マモンの賭場の通行証（戦績カード）を見る")
  .setDMPermission(false);

export async function handlePassportCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const uid = interaction.user.id;
  const stats = services.casino.stats(uid);
  const etherBalance = services.ether.balanceOf(uid);
  const landBalance = services.ledger.balanceOf(`user:${uid}`);
  const winRate = stats.games > 0 ? stats.wins / stats.games : 0;

  const member = (await interaction.guild?.members.fetch(uid).catch(() => null)) as GuildMember | null;
  const displayName = member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
  const avatarUrl = (member ?? interaction.user).displayAvatarURL({ extension: "png", size: 256 });

  const png = await renderPassportCard({
    displayName,
    avatarUrl,
    serverName: interaction.guild?.name,
    serverIconUrl: interaction.guild?.iconURL({ extension: "png", size: 128 }) ?? null,
    etherBalance,
    landBalance,
    stats: {
      games: stats.games,
      wins: stats.wins,
      losses: stats.losses,
      winRate,
      biggestWin: stats.biggest_win,
      totalEarned: stats.total_earned,
      totalWagered: stats.total_wagered,
      currentWinStreak: stats.current_win_streak,
      bestWinStreak: stats.best_win_streak,
    },
  });

  await interaction.editReply({ files: [new AttachmentBuilder(png, { name: "passport.png" })] });
}
