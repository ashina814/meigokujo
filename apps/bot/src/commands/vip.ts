import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { fmtEther } from "../format.js";
import { MAMMON_COLOR } from "../casino/common.js";
import type { Services } from "../services.js";

/**
 * /VIP — マモンの賭場のVIP会員（月額エテル）。casino-bot 準拠。
 * - 加入: 月会費エテル → VIP_DAYS 日間 VIP
 * - 特権: 賭け上限×2、VIP ロール自動付与（role:casino_vip 設定時）
 * - 期限切れは scheduler で自動失効＆ロール剥奪
 */
export const vipCommand = new SlashCommandBuilder()
  .setName("vip")
  .setDescription("💎 マモンの賭場のVIP会員（月額エテル）")
  .setDMPermission(false);

export async function handleVipCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  await interaction.reply({ ...renderStatus(interaction.user.id, services), flags: MessageFlags.Ephemeral });
}

function renderStatus(userId: string, services: Services) {
  const active = services.vip.isVip(userId);
  const left = services.vip.daysLeft(userId);
  const price = services.vip.price();
  const days = services.vip.days();
  const mult = services.vip.betCapMult();

  const embed = new EmbedBuilder()
    .setTitle("💎 マモンの賭場 — VIP会員")
    .setColor(MAMMON_COLOR)
    .setDescription(
      [
        active ? `✅ **VIP会員**（残り **${left}日**）` : "まだVIPじゃない。",
        "",
        `**月会費**: ${fmtEther(price)} / ${days}日`,
        "",
        "**特権**",
        `・🎰 賭け上限が **×${mult}**`,
        "・👑 VIPロール自動付与（設定されていれば）",
        "・🎫 通行証カードで VIP として表示（実装済み）",
      ].join("\n"),
    )
    .setFooter({ text: active ? "更新すると今の期限に日数が足される。" : "加入すると即日VIP。期限が切れると自動で解除される。" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("vip:join")
      .setLabel(active ? "更新する" : "加入する")
      .setStyle(ButtonStyle.Success)
      .setEmoji("💎"),
  );
  return { embeds: [embed], components: [row] };
}

export async function handleVipButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  if (interaction.customId !== "vip:join") return;
  const uid = interaction.user.id;
  const r = services.vip.join(uid);
  if (!r.ok) {
    await interaction.reply({
      content: `❌ 月会費 ${fmtEther(services.vip.price())} に足りない（所持 ${fmtEther(services.ether.balanceOf(uid))}）。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // VIPロール付与（設定されていれば）
  const roleId = services.settings.getString("role:casino_vip");
  if (roleId && interaction.guild) {
    const member = await interaction.guild.members.fetch(uid).catch(() => null);
    await member?.roles.add(roleId).catch(() => undefined);
  }
  await interaction.reply({
    content: [
      r.wasExtension ? "✅ VIP を **更新** した。" : "✅ VIP に **加入** した。",
      `期限: <t:${r.expiresAt}:F>（残り ${services.vip.daysLeft(uid)}日）`,
    ].join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}
