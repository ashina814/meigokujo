import { EmbedBuilder, MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import { C_MAMMON } from "../casino/ui.js";
import type { Services } from "../services.js";

/**
 * The former exchange panel is deliberately inert.  Entry is now a game-local,
 * exact 1:1 deposit and exit is a free-chip redemption; neither exposes a
 * manual exchange UI nor a legacy custom ID capable of moving money.
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

/** Reject buttons retained in old Discord messages without invoking a money flow. */
export async function handleEtherButton(interaction: ButtonInteraction, _services: Services): Promise<void> {
  await interaction.reply({
    content: "この旧ボタンは無効です。ゲーム開始時の自動預入をご利用ください。",
    flags: MessageFlags.Ephemeral,
  });
}

/** Reject forms retained in old Discord messages without invoking a money flow. */
export async function handleEtherModal(interaction: ModalSubmitInteraction, _services: Services): Promise<void> {
  await interaction.reply({
    content: "この旧フォームは無効です。ゲーム開始時の自動預入をご利用ください。",
    flags: MessageFlags.Ephemeral,
  });
}
