import { createHash } from "node:crypto";
import {
  AttachmentBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from "discord.js";
import type { RankedEvidenceKind } from "@meigokujo/core";
import { config } from "../config.js";
import type { Services } from "../services.js";

export const casinoEvidenceCommand = new SlashCommandBuilder()
  .setName("賭場証拠")
  .setDescription(" disputed table evidence")
  .addSubcommand((sub) =>
    sub
      .setName("提出")
      .setDescription("Submit private evidence for a disputed casino table")
      .addStringOption((opt) => opt.setName("table_id").setDescription("table id").setRequired(true))
      .addStringOption((opt) =>
        opt
          .setName("kind")
          .setDescription("evidence kind")
          .setRequired(true)
          .addChoices(
            { name: "screenshot", value: "screenshot" },
            { name: "history_url", value: "history_url" },
            { name: "replay_id", value: "replay_id" },
            { name: "third_party_testimony", value: "third_party_testimony" },
            { name: "table_vc_record", value: "table_vc_record" },
          ),
      )
      .addStringOption((opt) => opt.setName("text").setDescription("private text, URL, replay ID, or testimony").setRequired(false))
      .addAttachmentOption((opt) => opt.setName("attachment").setDescription("screenshot attachment").setRequired(false)),
  );

export async function handleCasinoEvidenceCommand(interaction: ChatInputCommandInteraction, services: Services): Promise<void> {
  if (interaction.options.getSubcommand() !== "提出") return;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
    return;
  }
  const tableId = interaction.options.getString("table_id", true);
  const kind = interaction.options.getString("kind", true) as RankedEvidenceKind;
  const text = interaction.options.getString("text", false)?.trim() ?? "";
  const attachment = interaction.options.getAttachment("attachment", false);
  if (kind === "screenshot" && !attachment) {
    await interaction.reply({ content: "screenshot evidence requires an attachment.", ephemeral: true });
    return;
  }
  if (kind !== "screenshot" && !text && !attachment) {
    await interaction.reply({ content: "Please include evidence text or an attachment.", ephemeral: true });
    return;
  }

  const evidenceChannel = await requirePrivateEvidenceChannel(interaction.client, guild);
  if (!evidenceChannel.ok) {
    await interaction.reply({ content: evidenceChannel.reason, ephemeral: true });
    return;
  }

  try {
    const content = [
      `table: ${tableId}`,
      `kind: ${kind}`,
      `submitter: ${interaction.user.id}`,
      text ? `content:\n${text}` : null,
    ].filter(Boolean).join("\n");
    const sent = await evidenceChannel.channel.send({
      content,
      files: attachment ? [new AttachmentBuilder(attachment.url, { name: attachment.name ?? "evidence" })] : [],
    });
    const digest = createHash("sha256")
      .update(canonicalDigestInput({ tableId, kind, text, attachmentName: attachment?.name ?? null, attachmentSize: attachment?.size ?? null, privateMessageId: sent.id }))
      .digest("hex");
    const result = services.rankedDisputes.submitEvidence({
      tableId,
      submitterId: interaction.user.id,
      evidenceKind: kind,
      operationId: interaction.id,
      privateChannelId: config.casinoEvidenceChannelId,
      privateMessageId: sent.id,
      attachmentName: attachment?.name ?? null,
      payloadDigest: digest,
      storageStatus: "stored",
    });
    await interaction.reply({ content: `Evidence stored privately: ${result.evidenceId}`, ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : String(error), ephemeral: true });
  }
}

export async function requirePrivateEvidenceChannel(
  client: Client,
  guild: Guild,
): Promise<{ ok: true; channel: { send(payload: unknown): Promise<{ id: string }> } } | { ok: false; reason: string }> {
  if (!config.casinoEvidenceChannelId || !config.casinoArbitratorRoleId) {
    return { ok: false, reason: "Evidence storage is not configured." };
  }
  const role = await guild.roles.fetch(config.casinoArbitratorRoleId).catch(() => null);
  if (!role) return { ok: false, reason: "Configured arbitrator role was not found." };
  const channel = await client.channels.fetch(config.casinoEvidenceChannelId).catch(() => null);
  if (!channel || !("guildId" in channel) || channel.guildId !== guild.id || !channel.isTextBased()) {
    return { ok: false, reason: "Configured evidence channel is not available for this guild." };
  }
  const everyone = channel.permissionsFor(guild.roles.everyone);
  const arbitrator = channel.permissionsFor(role);
  const botMember = guild.members.me ?? client.user;
  if (!botMember) return { ok: false, reason: "Bot member is not available for permission checks." };
  const bot = channel.permissionsFor(botMember);
  if (everyone?.has(PermissionFlagsBits.ViewChannel)) return { ok: false, reason: "Evidence channel is visible to everyone." };
  if (!arbitrator?.has(PermissionFlagsBits.ViewChannel)) return { ok: false, reason: "Arbitrator role cannot view the evidence channel." };
  if (!bot?.has(PermissionFlagsBits.SendMessages)) return { ok: false, reason: "Bot cannot write to the evidence channel." };
  return { ok: true, channel: channel as unknown as { send(payload: unknown): Promise<{ id: string }> } };
}

function canonicalDigestInput(input: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(input).sort().reduce<Record<string, unknown>>((out, key) => {
    out[key] = input[key];
    return out;
  }, {}));
}
