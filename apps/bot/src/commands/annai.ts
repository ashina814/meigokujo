import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther, fmtLd } from "../format.js";
import { C_MAMMON, C_JACKPOT, E, HR_THIN, fmtSignedEther, bar } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * /案内 — マモンの賭場ホーム画面。
 * setFields で情報を6セクションに分けて視覚階層を明確に:
 * ① 財布   ② 賭場相場   ③ 福分けと日々の稼ぎ
 * ④ 戦績   ⑤ 遊び方入口   ⑥ 経済・投資入口
 */
export const annaiCommand = new SlashCommandBuilder()
  .setName("案内")
  .setDescription("🏛 マモンの賭場のホーム画面")
  .setDMPermission(false);

export async function handleAnnaiCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.reply({ ...renderHome(interaction.user.id, services, interaction.guild?.name), flags: MessageFlags.Ephemeral });
}

export async function handleAnnaiButton(interaction: import("discord.js").ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "annai:refresh") {
    await interaction.update(renderHome(interaction.user.id, services, interaction.guild?.name));
  }
}

function renderHome(userId: string, services: Services, serverName?: string) {
  const stats = services.casino.stats(userId);
  const ether = services.ether;
  const daily = services.daily;
  const heldEther = ether.balanceOf(userId);
  const heldLand = services.ledger.balanceOf(`user:${userId}`);
  const rate = ether.rate();
  const jp = services.casino.jackpotPool();
  const houseBal = services.casino.houseBalance();
  const pool = ether.pool();
  const outstanding = ether.outstanding();

  const isVip = services.vip.isVip(userId);
  const vipDaysLeft = isVip ? services.vip.daysLeft(userId) : 0;

  const nextClaim = daily.nextClaimAt(userId);
  const dailyReady = nextClaim === 0 || nextClaim <= Math.floor(Date.now() / 1000);
  const streak = daily.currentStreak(userId);

  const winRate = stats.games > 0 ? (stats.wins / stats.games) * 100 : 0;
  const streakLine = stats.current_win_streak >= 2 ? `${E.fire} ${stats.current_win_streak}連勝中` : "";
  const loseStreakLine = stats.current_lose_streak >= 3 ? `${E.lose} ${stats.current_lose_streak}連敗` : "";
  const netLifetime = stats.total_earned - stats.total_wagered;

  const walletValue = [
    `**${fmtEther(heldEther)}** (エテル)`,
    `${fmtLd(heldLand)}`,
    isVip ? `${E.jp} **VIP** 残り${vipDaysLeft}日` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const marketValue = [
    `**1 Ld = ${rate.toFixed(2)} ${E.ether}**   （準備 ${pool.toLocaleString()} Ld ／ 発行 ${outstanding.toLocaleString()} ${E.ether}）`,
    `${E.jp} JPプール **${fmtEther(jp)}**`,
    `胴元残 ${fmtEther(houseBal)}`,
  ].join("\n");

  const dailyValue = dailyReady
    ? `${E.sparkle} **今すぐ受け取れる** → \`/福分け\``
    : `次は <t:${nextClaim}:R>  ／  連続 ${streak}日  ${streak >= 7 ? `**+${Math.min(200, Math.floor(streak / 7) * 50)}◈ボーナス**` : ""}`;

  const statsValue = [
    `${E.chart} 総 **${stats.games}** ／ 勝 ${stats.wins} 負 ${stats.losses}  勝率 **${winRate.toFixed(1)}%**`,
    `${E.up} 最大単勝 ${fmtEther(stats.biggest_win)}  ／  総獲得 ${fmtEther(stats.total_earned)}`,
    `${E.down} 総ベット ${fmtEther(stats.total_wagered)}  ／  通算 **${fmtSignedEther(netLifetime)}**`,
    `${E.streak} 連勝 ${stats.current_win_streak}／最長 ${stats.best_win_streak}${streakLine || loseStreakLine ? `  ${streakLine}${loseStreakLine}` : ""}`,
  ].join("\n");

  const playValue = [
    `${E.demon} \`/遊ぶ\` — スロット・丁半・クラッシュ・チンチロ・ルーレット・BJ・ポーカー・ホールデム`,
    `⚔ \`/勝負\` — 丁半(卓)・チンチロ・BJ・サシ・インディアン`,
    `🃏 \`/賭場商店\` — お守り（勝ちボーナス／敗北保護／二度振り）`,
  ].join("\n");

  const economyValue = [
    `📈 \`/株\` — 6銘柄・1時間毎更新・3日保有上限`,
    `🏇 \`/競馬\` — 冥馬6頭・単勝/複勝パリミュチュエル`,
    `📋 \`/板\` — 何でも賭けられる公開市場`,
    `✨ \`/流れ星\` — 1日5回の占い（初回無料）`,
    `${E.jp} \`/vip\` — 月額${fmtEther(services.vip.price())} で賭け上限×${services.vip.betCapMult()}`,
  ].join("\n");

  const detailValue = [
    `${E.paytable} \`/通行証\` — 戦績カード`,
    `🏅 \`/賭場番付\` — Top10（残高/勝率/最大単勝/連勝など）`,
    `${HR_THIN}`,
    `${E.ether} エテル ⇄ Land はマモンの両替所パネルで`,
    `　入場フェア／退場は **二割奉納**（80%着地・10%焼却・10%プール残留）`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${serverName ?? "冥獄城"} · マモンの賭場` })
    .setTitle(`${E.home} 案内所`)
    .setColor(jp > 100_000 ? C_JACKPOT : C_MAMMON)
    .addFields(
      { name: `👛 財布`, value: walletValue, inline: true },
      { name: `${E.chart} 相場・胴元`, value: marketValue, inline: true },
      { name: `📅 福分け`, value: dailyValue, inline: false },
      { name: `${E.chart} 戦績`, value: statsValue, inline: false },
      { name: `🎮 遊び`, value: playValue, inline: false },
      { name: `💹 経済・投資`, value: economyValue, inline: false },
      { name: `${E.paytable} 記録・入口`, value: detailValue, inline: false },
    )
    .setFooter({ text: `所持 ${fmtEther(heldEther)}${isVip ? ` · ${E.jp} VIP` : ""}${stats.current_win_streak >= 2 ? ` · ${E.fire}${stats.current_win_streak}連勝` : ""}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("annai:refresh").setLabel("更新").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// unused import prevented by re-export shape
void bar;
