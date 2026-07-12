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
import { MAMMON_COLOR } from "../casino/common.js";
import type { Services } from "../services.js";

/**
 * /案内 — マモンの賭場のホーム画面（casino-bot /案内 相当）。
 * 全機能への入口・現在の相場・胴元残高・JPプール・自分の残高/戦績を1画面で表示。
 * 全部 ephemeral。
 */
export const annaiCommand = new SlashCommandBuilder()
  .setName("案内")
  .setDescription("🏛 マモンの賭場のホーム画面")
  .setDMPermission(false);

export async function handleAnnaiCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const uid = interaction.user.id;
  const stats = services.casino.stats(uid);
  const ether = services.ether;
  const daily = services.daily;
  const heldEther = ether.balanceOf(uid);
  const heldLand = services.ledger.balanceOf(`user:${uid}`);
  const rate = ether.rate();
  const jp = services.casino.jackpotPool();
  const houseBal = services.casino.houseBalance();
  const nextClaim = daily.nextClaimAt(uid);
  const dailyLine = nextClaim === 0 || nextClaim <= Math.floor(Date.now() / 1000)
    ? "📅 **福分けが受け取れる**（`/福分け`）"
    : `📅 次の福分け: <t:${nextClaim}:R>`;

  const embed = new EmbedBuilder()
    .setTitle("🏛 マモンの賭場 — 案内所")
    .setColor(MAMMON_COLOR)
    .setDescription(
      [
        `所持: **${fmtEther(heldEther)}** ／ Land: ${fmtLd(heldLand)}`,
        `為替: 1 Ld = **${rate.toFixed(2)} ◈** ／ JPプール: ${fmtEther(jp)} ／ 胴元残: ${fmtEther(houseBal)}`,
        "",
        dailyLine,
        "",
        "**📊 戦績**",
        `　総ゲーム ${stats.games} / 勝率 ${stats.games > 0 ? ((stats.wins / stats.games) * 100).toFixed(1) : "0"}% / 最大単勝 ${fmtEther(stats.biggest_win)} / 連勝 ${stats.current_win_streak}（最長 ${stats.best_win_streak}）`,
        "",
        "**🎮 ソロ**: `/遊ぶ` — スロット/丁半/クラッシュ/チンチロ/ルーレット/ブラックジャック",
        "**⚔ 対人**: `/勝負` — 丁半(多人数)/チンチロ/BJ/サシ/インディアン",
        "**📈 投資**: `/株` — 6銘柄・1時間ごと更新・保有3日上限",
        "**🏇 レース**: `/競馬` — 冥馬6頭・単勝/複勝",
        "**🛍 商店**: `/賭場商店` — お守り（勝ちボーナス・敗北保護・二度振り）",
        "**🎫 通行証**: `/通行証` — 戦績カード",
        "**🏅 番付**: `/賭場番付` — 賭場のランキング",
      ].join("\n"),
    )
    .setFooter({ text: "エテル ⇄ Land の両替はマモンの両替所パネルで（入場フェア・退場20%奉納）" });

  const quickRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("annai:refresh").setLabel("🔁 更新").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ embeds: [embed], components: [quickRow], flags: MessageFlags.Ephemeral });
}

export async function handleAnnaiButton(interaction: import("discord.js").ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "annai:refresh") {
    // Re-render inline
    const uid = interaction.user.id;
    const stats = services.casino.stats(uid);
    const ether = services.ether;
    const daily = services.daily;
    const heldEther = ether.balanceOf(uid);
    const heldLand = services.ledger.balanceOf(`user:${uid}`);
    const rate = ether.rate();
    const jp = services.casino.jackpotPool();
    const houseBal = services.casino.houseBalance();
    const nextClaim = daily.nextClaimAt(uid);
    const dailyLine = nextClaim === 0 || nextClaim <= Math.floor(Date.now() / 1000)
      ? "📅 **福分けが受け取れる**（`/福分け`）"
      : `📅 次の福分け: <t:${nextClaim}:R>`;
    const embed = new EmbedBuilder()
      .setTitle("🏛 マモンの賭場 — 案内所")
      .setColor(MAMMON_COLOR)
      .setDescription(
        [
          `所持: **${fmtEther(heldEther)}** ／ Land: ${fmtLd(heldLand)}`,
          `為替: 1 Ld = **${rate.toFixed(2)} ◈** ／ JPプール: ${fmtEther(jp)} ／ 胴元残: ${fmtEther(houseBal)}`,
          "",
          dailyLine,
          "",
          "**📊 戦績**",
          `　総ゲーム ${stats.games} / 勝率 ${stats.games > 0 ? ((stats.wins / stats.games) * 100).toFixed(1) : "0"}% / 最大単勝 ${fmtEther(stats.biggest_win)} / 連勝 ${stats.current_win_streak}（最長 ${stats.best_win_streak}）`,
          "",
          "**🎮 ソロ**: `/遊ぶ` — スロット/丁半/クラッシュ/チンチロ/ルーレット/ブラックジャック",
          "**⚔ 対人**: `/勝負` — 丁半(多人数)/チンチロ/BJ/サシ/インディアン",
          "**📈 投資**: `/株` — 6銘柄・1時間ごと更新・保有3日上限",
          "**🏇 レース**: `/競馬` — 冥馬6頭・単勝/複勝",
          "**🛍 商店**: `/賭場商店` — お守り（勝ちボーナス・敗北保護・二度振り）",
          "**🎫 通行証**: `/通行証` — 戦績カード",
          "**🏅 番付**: `/賭場番付` — 賭場のランキング",
        ].join("\n"),
      );
    await interaction.update({ embeds: [embed] });
  }
}
