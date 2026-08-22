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

/**
 * 公開イベント参加記録（PR E3）。運営が確定した公開イベントrosterを
 * `PublicEvents.recordFinalizedEvent()`へ1回のconfirmでatomic writeする。
 *
 * slash入力時点ではDB mutationを一切行わない（§32, §37）。preview→confirmの
 * 2段階で、confirmを押した瞬間だけ`services.publicEvents.recordFinalizedEvent()`を呼ぶ。
 */
export const publicEventRecordCommand = new SlashCommandBuilder()
  .setName("イベント参加記録")
  .setDescription("運営が確定した公開イベントの参加rosterを記録する（運営限定）")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o
      .setName("イベントキー")
      .setDescription("開催instanceごとのimmutable slug（例: gf-2026-08-22）")
      .setRequired(true)
      .setMaxLength(64),
  )
  .addStringOption((o) => o.setName("イベント名").setDescription("表示名").setRequired(true).setMaxLength(200))
  .addStringOption((o) =>
    o.setName("開催日").setDescription("JSTの開催日 YYYY-MM-DD").setRequired(true).setMaxLength(10),
  )
  .addStringOption((o) =>
    o
      .setName("参加者")
      .setDescription("参加者のメンション/DiscordIDを空白・改行・カンマ区切りで貼り付け")
      .setRequired(true)
      .setMaxLength(4000),
  );

interface PendingPublicEventRecord {
  readonly initiatingAdminId: string;
  readonly eventKey: string;
  readonly name: string;
  readonly eventDate: string;
  readonly participantUserIds: readonly string[];
  readonly expiresAt: number;
}

/** confirm前のpreview state。Bot再起動で消えてよい——confirm前なのでDB不整合は起きない（§34）。 */
const pending = new Map<string, PendingPublicEventRecord>();
const CONFIRM_TTL_MS = 5 * 60_000;

function cleanupPending(): void {
  const now = Date.now();
  for (const [key, p] of pending) if (p.expiresAt < now) pending.delete(key);
}

const MENTION_PATTERN = /^<@!?(\d{15,25})>$/;
const RAW_ID_PATTERN = /^\d{15,25}$/;

/**
 * Discord user identityとして明確にparseできるtokenだけを受け付ける（§30-31）。
 * usernameやdisplay nameからの推測は一切しない。1 tokenでも不正なら全体をrejectし、
 * partial rosterを保存しない——nullを返す。
 */
function parseParticipantTokens(raw: string): readonly string[] | null {
  const tokens = raw
    .split(/[\s,、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const ids: string[] = [];
  for (const token of tokens) {
    const mentionMatch = MENTION_PATTERN.exec(token);
    if (mentionMatch?.[1]) {
      ids.push(mentionMatch[1]);
      continue;
    }
    if (RAW_ID_PATTERN.test(token)) {
      ids.push(token);
      continue;
    }
    return null; // 1つでも不正なtokenがあれば全体reject（partial保存しない）
  }
  return ids;
}

export async function handlePublicEventRecordCommand(
  interaction: ChatInputCommandInteraction,
  services: Services,
): Promise<void> {
  if (!isAdmin(interaction, services)) {
    await interaction.reply({ content: "このコマンドは運営限定です。", flags: MessageFlags.Ephemeral });
    return;
  }
  cleanupPending();

  const eventKey = interaction.options.getString("イベントキー", true).trim();
  const name = interaction.options.getString("イベント名", true).trim();
  const eventDate = interaction.options.getString("開催日", true).trim();
  const participantsRaw = interaction.options.getString("参加者", true);

  const participantUserIds = parseParticipantTokens(participantsRaw);
  if (!participantUserIds) {
    await interaction.reply({
      content:
        "参加者リストに認識できないIDが含まれています。メンション（`<@...>`）または生のDiscord IDだけを、空白・改行・カンマ区切りで貼り付けてください。一部だけを保存することはできません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const token = interaction.id;
  pending.set(token, {
    initiatingAdminId: interaction.user.id,
    eventKey,
    name,
    eventDate,
    participantUserIds,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });

  const embed = new EmbedBuilder()
    .setTitle("📋 公開イベント参加記録の確認")
    .setDescription(
      [
        `イベントキー: \`${eventKey}\``,
        `イベント名: ${name}`,
        `開催日: ${eventDate}`,
        `参加者: **${participantUserIds.length}人**`,
        "",
        "⚠️ **公開イベント参加履歴として確定します。将来、称号・プロフィール等の公開identityに利用される可能性があります。**",
        "確定後は編集・削除できません。",
      ].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`pev:ok:${token}`).setLabel("確定する").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pev:no:${token}`).setLabel("やめる").setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handlePublicEventRecordButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const [, action, token] = interaction.customId.split(":");
  if (!action || !token) return;

  const p = pending.get(token);
  if (!p || p.expiresAt < Date.now()) {
    pending.delete(token);
    await interaction.update({
      content: "⌛ 確認の期限が切れました。もう一度 `/イベント参加記録` からどうぞ。",
      embeds: [],
      components: [],
    });
    return;
  }
  // previewを出した運営本人だけがConfirm/Cancelできる（§35）。ephemeral messageなので
  // 通常は他人からは見えないが、defense-in-depthとして明示的に検証する。
  if (interaction.user.id !== p.initiatingAdminId) return;

  if (action === "no") {
    pending.delete(token);
    await interaction.update({ content: "記録をやめました。", embeds: [], components: [] });
    return;
  }

  pending.delete(token);
  try {
    const result = services.publicEvents.recordFinalizedEvent({
      eventKey: p.eventKey,
      name: p.name,
      eventDate: p.eventDate,
      participantUserIds: p.participantUserIds,
      recordedBy: p.initiatingAdminId,
    });
    const suffix = result.alreadyRecorded ? "（既に同内容で記録済みでした）" : "";
    await interaction.update({
      content: `✅ 公開イベント \`${result.eventKey}\` の参加記録を保存しました${suffix}。参加者: ${result.participantCount}人`,
      embeds: [],
      components: [],
    });
  } catch (e) {
    const message =
      e instanceof PublicEventsError
        ? e.code === "conflict"
          ? "このイベントキーは既に別の内容（名前/開催日/参加者）で記録済みです。上書きはできません。"
          : `入力エラー: ${e.message}`
        : "記録に失敗しました。時間をおいて再度お試しください。";
    await interaction.update({ content: `❌ ${message}`, embeds: [], components: [] });
  }
}
