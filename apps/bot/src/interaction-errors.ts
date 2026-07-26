import { MessageFlags } from "discord.js";

export const INTERACTION_ERROR_MESSAGE = "処理に失敗しました。時間をおいて再度お試しください。";

type ErrorRespondableInteraction = {
  isRepliable(): boolean;
  replied?: boolean;
  deferred?: boolean;
  reply?(payload: { content: string; flags?: MessageFlags.Ephemeral }): Promise<unknown>;
  editReply?(payload: { content: string }): Promise<unknown>;
  followUp?(payload: { content: string; flags?: MessageFlags.Ephemeral }): Promise<unknown>;
};

export async function respondInteractionError(interaction: ErrorRespondableInteraction): Promise<void> {
  if (!interaction.isRepliable()) return;

  try {
    if (!interaction.replied && !interaction.deferred && interaction.reply) {
      await interaction.reply({ content: INTERACTION_ERROR_MESSAGE, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.deferred && !interaction.replied && interaction.editReply) {
      await interaction.editReply({ content: INTERACTION_ERROR_MESSAGE });
      return;
    }

    await interaction.followUp?.({ content: INTERACTION_ERROR_MESSAGE, flags: MessageFlags.Ephemeral });
  } catch {
    // Interaction tokens can expire, and the original failure may be a Discord API issue.
    // Keep the original exception in the caller log without throwing a second error here.
  }
}
