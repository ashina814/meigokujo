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
 * /案内 — 旧・賭場ホーム。
 *
 * 賭場のホーム画面が `/賭場` と `/案内` の2つあり、しかも商店・番付・通行証・
 * 競馬・板への導線は `/案内` 側にしか無かった。利用者が `/賭場` を覚えると
 * そこから半分の機能へ辿り着けず、逆に `/案内` を覚えると遊ぶ導線が弱い、
 * という分断が起きていた。入口は `/賭場` へ一本化する。
 *
 * コマンド自体は消さない。覚えている人が打ったときに「存在しないコマンド」に
 * なるより、新しい入口へ案内するほうが親切なため。中身の描画は
 * `renderCasinoHome` を呼ぶだけにして、二重に育てない。
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
