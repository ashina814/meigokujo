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
  )
  .addStringOption((o) =>
    o
      .setName("主催責任者")
      .setDescription("primary organizer 1名のメンションまたはDiscord ID")
      .setRequired(true)
      .setMaxLength(30),
  )
  .addStringOption((o) =>
    o
      .setName("共同主催")
      .setDescription("共同organizerのメンション/Discord ID（任意、複数可）")
      .setRequired(false)
      .setMaxLength(4000),
  )
  .addStringOption((o) =>
    o
      .setName("スタッフ")
      .setDescription("staffのメンション/Discord ID（任意、複数可）")
      .setRequired(false)
      .setMaxLength(4000),
  );

interface PendingPublicEventRecord {
  readonly initiatingAdminId: string;
  readonly eventKey: string;
  readonly name: string;
  readonly eventDate: string;
  readonly participantUserIds: readonly string[];
  readonly organizerUserIds: readonly string[];
  readonly staffUserIds: readonly string[];
  readonly primaryOrganizerUserId: string;
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
 *
 * previewはimmutable write前の唯一の確認画面なので、表示する人数と実際にcommitされる
 * roster数を一致させる——ここで最初のappearance順のdedupeまで行い、dedupe済みの
 * participantUserIdsをpendingへ保存する（PR #162レビュー§3）。core側
 * （`PublicEvents.recordFinalizedEvent()`）のdedupeはdefense-in-depthとして残る。
 */
function parseParticipantTokens(raw: string): readonly string[] | null {
  const tokens = raw
    .split(/[\s,、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const token of tokens) {
    const mentionMatch = MENTION_PATTERN.exec(token);
    const id = mentionMatch?.[1] ?? (RAW_ID_PATTERN.test(token) ? token : null);
    if (id === null) return null; // 1つでも不正なtokenがあれば全体reject（partial保存しない）
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
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
  const primaryOrganizerRaw = interaction.options.getString("主催責任者", true);
  const organizersRaw = interaction.options.getString("共同主催") ?? "";
  const staffRaw = interaction.options.getString("スタッフ") ?? "";

  const participantUserIds = parseParticipantTokens(participantsRaw);
  if (!participantUserIds) {
    await interaction.reply({
      content:
        "参加者リストに認識できないIDが含まれています。メンション（`<@...>`）または生のDiscord IDだけを、空白・改行・カンマ区切りで貼り付けてください。一部だけを保存することはできません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const primaryOrganizerIds = parseParticipantTokens(primaryOrganizerRaw);
  if (!primaryOrganizerIds || primaryOrganizerIds.length !== 1) {
    await interaction.reply({
      content: "主催責任者は、1名分のメンション（`<@...>`）または生のDiscord IDを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const organizerUserIds = organizersRaw.trim() ? parseParticipantTokens(organizersRaw) : [];
  const staffUserIds = staffRaw.trim() ? parseParticipantTokens(staffRaw) : [];
  if (!organizerUserIds || !staffUserIds) {
    await interaction.reply({
      content: "共同主催またはスタッフに認識できないIDがあります。メンションまたは生のDiscord IDだけを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const primaryOrganizerUserId = primaryOrganizerIds[0]!;
  const coOrganizerUserIds = organizerUserIds.filter((id) => id !== primaryOrganizerUserId);

  const token = interaction.id;
  pending.set(token, {
    initiatingAdminId: interaction.user.id,
    eventKey,
    name,
    eventDate,
    participantUserIds,
    organizerUserIds: coOrganizerUserIds,
    staffUserIds,
    primaryOrganizerUserId,
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
        `主催: **${coOrganizerUserIds.length + 1}人**（primary含む）`,
        `スタッフ: **${staffUserIds.length}人**`,
        `主催責任者: <@${primaryOrganizerUserId}>`,
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
  // allowed actionをexactに"ok"/"no"だけへ限定する（PR #162レビュー§1）——
  // customIdは実質caller側で自由に組み立てられる入力なので、未知/malformedな
  // actionは即fail-closedし、confirmロジックへ一切到達させない。
  if (!token || (action !== "ok" && action !== "no")) return;

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
  // previewから確定まで最大5分空く——previewの時点でadminだった本人が、その間に
  // admin権限を失っていてもConfirmだけで書き込めてしまわないよう、実際のDB
  // mutation直前にも現在のadmin権限を再検証する（PR #162レビュー§2）。
  if (!isAdmin(interaction, services)) {
    pending.delete(token);
    await interaction.update({
      content: "❌ 運営権限が確認できませんでした。もう一度 `/イベント参加記録` からどうぞ。",
      embeds: [],
      components: [],
    });
    return;
  }

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
      organizerUserIds: p.organizerUserIds,
      staffUserIds: p.staffUserIds,
      primaryOrganizerUserId: p.primaryOrganizerUserId,
      recordedBy: p.initiatingAdminId,
    });
    const suffix = result.alreadyRecorded ? "（既に同内容で記録済みでした）" : "";
    await interaction.update({
      content: `✅ 公開イベント \`${result.eventKey}\` を保存しました${suffix}。参加者: ${result.participantCount}人 / 主催: ${result.organizerCount}人 / スタッフ: ${result.staffCount}人`,
      embeds: [],
      components: [],
    });
  } catch (e) {
    const message =
      e instanceof PublicEventsError
        ? e.code === "conflict"
          ? "このイベントキーは既に別の内容（名前/開催日/参加者/主催/スタッフ）で記録済みです。上書きはできません。"
          : `入力エラー: ${e.message}`
        : "記録に失敗しました。時間をおいて再度お試しください。";
    await interaction.update({ content: `❌ ${message}`, embeds: [], components: [] });
  }
}
