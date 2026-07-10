import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Services } from "../services.js";

/**
 * 住人向けの遊び方ガイド（オンボーディング）。運営設定に依存せず、常に使える一望。
 */
export const helpCommand = new SlashCommandBuilder()
  .setName("あそびかた")
  .setDescription("冥獄城の暮らしと遊びかたの案内")
  .setDMPermission(false);

export async function handleHelpCommand(interaction: ChatInputCommandInteraction, _services: Services): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("📖 冥獄城の歩きかた")
    .setColor(0x6b21a8)
    .setDescription("困ったらこれを開けば大体わかる。")
    .addFields(
      {
        name: "🏛 暮らし（Land）",
        value: [
          "`/プロフィール` — 自分の記録（階級・所持Land・在城日数・称号）",
          "`/送金` — 住人へ Land を送る　/　`/投げ銭` — 気持ちを乗せて贈る",
          "銀行パネルで残高照会・取引履歴も見られる",
        ].join("\n"),
      },
      {
        name: "🚪 入城・評価",
        value: [
          "入城申請パネルから説明会を予約 → 参加すると亡霊になり初期発行30,000",
          "魔剣士の評価で昇格印が貯まれば魔人へ。低評価が続くと迷霊落ち",
        ].join("\n"),
      },
      {
        name: "🛏 部屋",
        value: "各パネルから 宿 / 蜜月 / 朧月 / ゲーム部屋 を開ける。全員退出で自動で消える",
      },
    )
    .setFooter({ text: "全部おまかせ・任意参加。触りたいところから触ってOK。" });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
