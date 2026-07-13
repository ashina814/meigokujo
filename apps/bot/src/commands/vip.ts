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
import { C_JACKPOT, C_MAMMON, E, bar } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * /vip — マモンの賭場のVIP会員（月額エテル）。casino-bot 準拠。
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
  const held = services.ether.balanceOf(userId);

  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · VIP" })
    .setColor(active ? C_JACKPOT : C_MAMMON)
    .setTitle(active ? `💎  VIP 会員  ·  残り ${left}日` : "💎  一般席")
    .setDescription(
      active
        ? [
            "```",
            `${bar(left, days, 20)}`,
            "```",
            `期限まで **${left}日**  ／  会費 ${fmtEther(price).replace(" ◈", "◈")}／${days}日`,
          ].join("\n")
        : `月会費 **${fmtEther(price)}** で **${days}日間** のVIP資格が得られる。`,
    )
    .addFields(
      {
        name: "▸ VIP の特権",
        value: [
          `${E.up} 賭け上限 ×**${mult}**（各ゲーム自動反映）`,
          `${E.crown} VIP ロール自動付与（設定されていれば）`,
          `${E.paytable} 通行証カードで VIP 表示`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "▸ 財布",
        value: `所持 **${fmtEther(held)}**  ／  ${held >= price ? `${E.win} 会費を払える` : `${E.lose} 会費に不足（${fmtEther(price - held)}）`}`,
        inline: false,
      },
    )
    .setFooter({ text: active ? "更新すると今の期限に日数が足される" : "加入すると即日VIP。期限切れは自動で解除される" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("vip:join")
      .setLabel(active ? `更新（+${days}日）` : `加入する`)
      .setStyle(ButtonStyle.Success)
      .setEmoji("💎")
      .setDisabled(held < price),
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
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場 · VIP" })
    .setColor(C_JACKPOT)
    .setTitle(r.wasExtension ? "💎  VIP を更新" : "💎  VIP に加入")
    .setDescription(`期限: <t:${r.expiresAt}:F>  （<t:${r.expiresAt}:R>）`)
    .setFooter({ text: `残り ${services.vip.daysLeft(uid)}日 · 所持 ${fmtEther(services.ether.balanceOf(uid)).replace(" ◈", "◈")}` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
