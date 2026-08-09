import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { config } from "../config.js";
import type { Services } from "../services.js";
import { editBoundRankedTableMessage } from "../casino/ranked-table-ui.js";

export const casinoArbitrationCommand = new SlashCommandBuilder()
  .setName("casino-arbitration")
  .setDescription("Restricted casino dispute arbitration")
  .addSubcommand((sub) =>
    sub
      .setName("assign")
      .setDescription("Owner-only arbitrator assignment")
      .addStringOption((opt) => opt.setName("table_id").setDescription("table id").setRequired(true))
      .addUserOption((opt) => opt.setName("arbitrator").setDescription("assigned arbitrator").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("ranked_result")
      .setDescription("Resolve a ranked table result")
      .addStringOption((opt) => opt.setName("table_id").setDescription("table id").setRequired(true))
      .addStringOption((opt) => opt.setName("rank_order").setDescription("space/comma separated user ids or mentions").setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName("fee_outcome")
          .setDescription("fee outcome")
          .setRequired(true)
          .addChoices({ name: "keep", value: "keep" }, { name: "fault_refund", value: "fault_refund" }),
      )
      .addBooleanOption((opt) => opt.setName("record_stats").setDescription("record ranked match stats").setRequired(true))
      .addStringOption((opt) => opt.setName("public_summary").setDescription("short public reason without evidence details").setRequired(true)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("refund_collateral")
      .setDescription("Refund disputed ranked table collateral")
      .addStringOption((opt) => opt.setName("table_id").setDescription("table id").setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName("fee_outcome")
          .setDescription("fee outcome")
          .setRequired(true)
          .addChoices({ name: "keep", value: "keep" }, { name: "fault_refund", value: "fault_refund" }),
      )
      .addStringOption((opt) => opt.setName("public_summary").setDescription("short public reason without evidence details").setRequired(true)),
  );

export async function handleCasinoArbitrationCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const tableId = interaction.options.getString("table_id", true);
  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
    return;
  }
  try {
    if (sub === "assign") {
      if (interaction.user.id !== config.ownerId) {
        await interaction.reply({ content: "Only OWNER_ID can assign casino arbitrators.", ephemeral: true });
        return;
      }
      const arbitrator = interaction.options.getUser("arbitrator", true);
      services.rankedDisputes.assignArbitrator({
        tableId,
        arbitratorId: arbitrator.id,
        assignedBy: interaction.user.id,
        operationId: interaction.id,
      });
      await editBoundRankedTableMessage(interaction.client, services, tableId);
      await interaction.reply({ content: `Assigned arbitrator: ${arbitrator.id}`, ephemeral: true });
      return;
    }

    if (!(await isConfiguredAssignedArbitrator(interaction, services, tableId))) return;
    if (sub === "ranked_result") {
      const orderedUserIds = parseRankOrder(interaction.options.getString("rank_order", true));
      services.rankedDisputes.resolveRankedResult({
        tableId,
        actorId: interaction.user.id,
        orderedUserIds,
        feeOutcome: interaction.options.getString("fee_outcome", true) as "keep" | "fault_refund",
        recordStats: interaction.options.getBoolean("record_stats", true),
        publicSummary: interaction.options.getString("public_summary", true),
        operationId: interaction.id,
      });
    } else if (sub === "refund_collateral") {
      services.rankedDisputes.resolveCollateralRefund({
        tableId,
        actorId: interaction.user.id,
        feeOutcome: interaction.options.getString("fee_outcome", true) as "keep" | "fault_refund",
        publicSummary: interaction.options.getString("public_summary", true),
        operationId: interaction.id,
      });
    }
    await editBoundRankedTableMessage(interaction.client, services, tableId);
    await interaction.reply({ content: "Arbitration decision recorded.", ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : String(error), ephemeral: true });
  }
}

async function isConfiguredAssignedArbitrator(interaction: ChatInputCommandInteraction, services: Services, tableId: string): Promise<boolean> {
  if (!config.casinoArbitratorRoleId) {
    await interaction.reply({ content: "Arbitrator role is not configured.", ephemeral: true });
    return false;
  }
  const member = interaction.member as GuildMember | null;
  if (!member?.roles.cache.has(config.casinoArbitratorRoleId)) {
    await interaction.reply({ content: "Only configured casino arbitrators can resolve disputes.", ephemeral: true });
    return false;
  }
  const dispute = services.rankedDisputes.publicStatus(tableId);
  if (dispute?.assignedArbitratorId !== interaction.user.id) {
    await interaction.reply({ content: "Only the assigned arbitrator can resolve this dispute.", ephemeral: true });
    return false;
  }
  return true;
}

function parseRankOrder(raw: string): string[] {
  return raw.split(/[\s,]+/).map((value) => value.replace(/[<@!>]/g, "").trim()).filter(Boolean);
}
