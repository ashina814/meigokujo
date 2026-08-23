import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { PublicEventsError } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

export const publicEventCompleteCommand = new SlashCommandBuilder()
  .setName("イベント完了記録")
  .setDescription("公開イベントの終了をcompletion正本へ記録する（運営限定）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o.setName("イベントキー").setDescription("保存済み公開イベントのimmutable slug").setRequired(true).setMaxLength(64),
  );

interface PendingPublicEventCompletion {
  readonly initiatingAdminId: string;
  readonly eventKey: string;
  readonly expiresAt: number;
}

const pending = new Map<string, PendingPublicEventCompletion>();
const CONFIRM_TTL_MS = 5 * 60_000;

function cleanupPending(): void {
  const now = Date.now();
  for (const [token, value] of pending) if (value.expiresAt < now) pending.delete(token);
}

export async function handlePublicEventCompleteCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "このコマンドは運営限定です。", flags: MessageFlags.Ephemeral });
    return;
  }
  cleanupPending();
  const eventKey = interaction.options.getString("イベントキー", true).trim();

  try {
    // preview値はすべて保存済みDB正本から読み、slash入力はeventKey以外を信用しない。
    const summary = services.publicEvents.getEventCompletionSummary(eventKey);
    const token = interaction.id;
    pending.set(token, {
      initiatingAdminId: interaction.user.id,
      eventKey: summary.eventKey,
      expiresAt: Date.now() + CONFIRM_TTL_MS,
    });
    const embed = new EmbedBuilder()
      .setTitle("✅ 公開イベント完了記録の確認")
      .setDescription(
        [
          `イベントキー: \`${summary.eventKey}\``,
          `イベント名: ${summary.name}`,
          `開催日: ${summary.eventDate}`,
          `参加者: **${summary.participantCount}人**`,
          "",
          "⚠️ **このイベントが終了済みであることを確認し、completion正本へ不可逆に記録します。**",
          "記録後は編集・削除できません。",
        ].join("\n"),
      )
      .setColor(0x166534);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`pevc:ok:${token}`).setLabel("終了済みとして記録").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`pevc:no:${token}`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  } catch (error) {
    const message =
      error instanceof PublicEventsError
        ? `イベントを確認できません: ${error.message}`
        : "イベントの確認に失敗しました。時間をおいて再度お試しください。";
    await interaction.reply({ content: `❌ ${message}`, flags: MessageFlags.Ephemeral });
  }
}

export async function handlePublicEventCompleteButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const parts = interaction.customId.split(":");
  if (parts.length !== 3 || parts[0] !== "pevc" || (parts[1] !== "ok" && parts[1] !== "no") || !parts[2]) return;
  const action = parts[1];
  const token = parts[2];
  const value = pending.get(token);
  if (!value || value.expiresAt < Date.now()) {
    pending.delete(token);
    await interaction.update({
      content: "⌛ 確認の期限が切れました。もう一度 `/イベント完了記録` からどうぞ。",
      embeds: [],
      components: [],
    });
    return;
  }
  if (interaction.user.id !== value.initiatingAdminId) return;
  if (!isAdmin(interaction, services)) {
    pending.delete(token);
    await interaction.update({
      content: "❌ 運営権限が確認できませんでした。もう一度 `/イベント完了記録` からどうぞ。",
      embeds: [],
      components: [],
    });
    return;
  }
  if (action === "no") {
    pending.delete(token);
    await interaction.update({ content: "完了記録をやめました。", embeds: [], components: [] });
    return;
  }

  pending.delete(token);
  try {
    const result = services.publicEvents.recordCompletedEvent({
      eventKey: value.eventKey,
      completedBy: value.initiatingAdminId,
    });
    const suffix = result.alreadyRecorded ? "（既に完了記録済みでした）" : "";
    await interaction.update({
      content: `✅ 公開イベント \`${result.eventKey}\` の終了を記録しました${suffix}。参加者: ${result.participantCount}人`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    const message =
      error instanceof PublicEventsError
        ? `完了を記録できません: ${error.message}`
        : "完了記録に失敗しました。時間をおいて再度お試しください。";
    await interaction.update({ content: `❌ ${message}`, embeds: [], components: [] });
  }
}
