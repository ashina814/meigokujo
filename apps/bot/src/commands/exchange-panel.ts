import { EmbedBuilder, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import { C_MAMMON } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * 旧両替所パネルは意図的に無効化されている。入場はゲーム開始時の自動預入（1:1）、
 * 退場は自由チップの返還に置き換わっており、手動両替UIも資金を動かせる旧component ID も
 * もう存在しない。
 */
export function exchangePanelMessage(_services: Services) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("マモンの賭場 · Land入退場")
        .setColor(C_MAMMON)
        .setDescription("旧パネルは無効です。ゲーム開始時に必要額だけ自動で預け入れ、賭場を出ると自由チップだけをLandへ戻せます。"),
    ],
    components: [],
  };
}

/** 旧Discordメッセージに残っているボタンが押されても、資金は一切動かさない。 */
export async function handleEtherButton(interaction: ButtonInteraction, _services: Services): Promise<void> {
  await interaction.reply({
    content: "この旧ボタンは無効です。ゲーム開始時の自動預入をご利用ください。",
    flags: MessageFlags.Ephemeral,
  });
}

/** 旧Discordメッセージに残っているフォームが送信されても、資金は一切動かさない。 */
export async function handleEtherModal(interaction: ModalSubmitInteraction, _services: Services): Promise<void> {
  await interaction.reply({
    content: "この旧フォームは無効です。ゲーム開始時の自動預入をご利用ください。",
    flags: MessageFlags.Ephemeral,
  });
}
