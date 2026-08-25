import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { C_MAMMON } from "../casino/ui.js";
import { renderCasinoHome } from "./casino-home.js";
import type { Services } from "../services.js";

/**
 * @deprecated `/案内` はslash registrationから退役済みで、正規入口は `/賭場`。
 * Discord側に残る旧interactionとの互換handlerだけを維持し、ボタン遷移では
 * `renderCasinoHome` を再利用する。新しい公開入口として登録しない。
 */
export const annaiCommand = new SlashCommandBuilder()
  .setName("案内")
  .setDescription("🏛 マモンの賭場の入口（/賭場 へ案内します）")
  .setDMPermission(false);

const MOVED_NOTICE = "賭場の入口は `/賭場` にまとまりました。次からは `/賭場` を使ってください。";

export async function handleAnnaiCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setAuthor({ name: "マモンの賭場" })
    .setColor(C_MAMMON)
    .setTitle("🏛  入口が新しくなりました")
    .setDescription(
      [
        MOVED_NOTICE,
        "",
        "遊ぶ・みんなで勝負・商店・通行証・番付・福分け・遊び方は、すべて `/賭場` から辿れます。",
      ].join("\n"),
    );
  await interaction.reply({
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("annai:home").setLabel("賭場ホームを開く").setEmoji("🏛").setStyle(ButtonStyle.Primary),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleAnnaiButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (interaction.customId === "annai:home" || interaction.customId === "annai:refresh") {
    await interaction.update({
      content: MOVED_NOTICE,
      ...renderCasinoHome(interaction.user.id, services, interaction.guild?.name),
    });
    return;
  }
}
