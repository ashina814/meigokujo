import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type Guild,
  type GuildMember,
  type MessageCreateOptions,
  type PrivateThreadChannel,
  type TextChannel,
} from "discord.js";
import type { TicketKind, TicketPanel, TicketRow } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

const LEGACY_KIND_LABELS: Record<string, string> = { return: "出戻り申請", consult: "個別相談" };
const OPEN_PREFIX = "ticket:open:";
const inFlightTickets = new Set<string>();

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function parseRoleIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? uniq(parsed.filter((v): v is string => typeof v === "string")) : [];
  } catch {
    return [];
  }
}

export function ticketOpenCustomId(panelId: string): string {
  return `${OPEN_PREFIX}${panelId}`;
}

export function panelIdFromTicketButton(customId: string): string | undefined {
  if (customId.startsWith(OPEN_PREFIX)) return customId.slice(OPEN_PREFIX.length);
  if (customId === "ticket:return") return "return";
  if (customId === "ticket:consult") return "consult";
  return undefined;
}

function fallbackStaffRoleId(services: Services): string | undefined {
  return services.settings.getString("role:ticket_staff");
}

export function ticketPanelMessageForPanel(panel: TicketPanel): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description)
    .setColor(panel.enabled ? 0x0ea5e9 : 0x64748b)
    .setFooter({ text: `受付ID: ${panel.id}${panel.enabled ? "" : " / 無効"}` });
  const button = new ButtonBuilder()
    .setCustomId(ticketOpenCustomId(panel.id))
    .setLabel(panel.buttonLabel)
    .setStyle(panel.enabled ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(!panel.enabled);
  if (panel.buttonEmoji) button.setEmoji(panel.buttonEmoji);
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] };
}

/** 旧 /パネル設置 互換。内部では汎用チケットパネル設定を使う。 */
export function ticketPanelMessage(kind: TicketKind, services?: Services): MessageCreateOptions {
  const panel = services?.tickets.getPanel(kind) ?? services?.tickets.defaultPanel(kind) ?? {
    id: String(kind),
    name: LEGACY_KIND_LABELS[String(kind)] ?? String(kind),
    title: `${LEGACY_KIND_LABELS[String(kind)] ?? String(kind)} 受付`,
    description: "ボタンを押すと、あなたとスタッフだけのプライベートスレッドが開きます。",
    buttonLabel: LEGACY_KIND_LABELS[String(kind)] ?? String(kind),
    buttonEmoji: kind === "return" ? "🔄" : kind === "consult" ? "❓" : null,
    notifyRoleIds: [],
    staffRoleIds: [],
    enabled: true,
    channelId: null,
    messageId: null,
    createdAt: 0,
    updatedAt: 0,
    createdBy: null,
    updatedBy: null,
  };
  return ticketPanelMessageForPanel(panel);
}

export function panelStaffRoleIds(panel: TicketPanel, services: Services): string[] {
  const fallback = fallbackStaffRoleId(services);
  return panel.staffRoleIds.length > 0 ? panel.staffRoleIds : fallback ? [fallback] : [];
}

export function panelNotifyRoleIds(panel: TicketPanel, staffRoleIds: string[]): string[] {
  return panel.notifyRoleIds.length > 0 ? panel.notifyRoleIds : staffRoleIds;
}

export function ticketStaffRoleIds(ticket: TicketRow | undefined, services: Services): string[] {
  const snapshot = parseRoleIds(ticket?.panel_staff_role_ids_json);
  if (snapshot.length > 0) return snapshot;
  if (ticket?.panel_id) {
    const panel = services.tickets.getPanel(ticket.panel_id);
    if (panel?.staffRoleIds.length) return panel.staffRoleIds;
  }
  const fallback = fallbackStaffRoleId(services);
  return fallback ? [fallback] : [];
}

export function memberHasAnyRole(member: GuildMember | null, roleIds: string[]): boolean {
  return !!member && roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function isTicketStaff(interaction: ButtonInteraction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const ticket = services.tickets.get(interaction.channelId);
  const member = interaction.member as GuildMember | null;
  return memberHasAnyRole(member, ticketStaffRoleIds(ticket, services));
}

async function existingRoleIds(guild: Guild, roleIds: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const roleId of uniq(roleIds)) {
    const cached = guild.roles.cache.get(roleId);
    const fetched = cached ?? (await guild.roles.fetch(roleId).catch(() => null));
    if (fetched) result.push(roleId);
  }
  return result;
}

async function memberIdsForRoles(guild: Guild, roleIds: string[]): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return [];
  const ids: string[] = [];
  for (const member of members.values()) {
    if (member.user.bot) continue;
    if (roleIds.some((roleId) => member.roles.cache.has(roleId))) ids.push(member.id);
  }
  return uniq(ids);
}

async function addMembersToThread(thread: PrivateThreadChannel, memberIds: string[]): Promise<{ added: number; failed: number }> {
  let added = 0;
  let failed = 0;
  for (const memberId of uniq(memberIds)) {
    try {
      await thread.members.add(memberId);
      added += 1;
    } catch {
      failed += 1;
    }
  }
  return { added, failed };
}

async function cleanupCreatedThread(thread: PrivateThreadChannel, reason: string): Promise<void> {
  try {
    await thread.delete(reason);
    return;
  } catch (e) {
    console.warn(`[ticket] 作成済みスレッドの削除に失敗したためロック/アーカイブします: ${thread.id}`, e);
  }
  await thread.setLocked(true, reason).catch((e) => console.warn(`[ticket] 作成済みスレッドのロックに失敗: ${thread.id}`, e));
  await thread.setArchived(true, reason).catch((e) => console.warn(`[ticket] 作成済みスレッドのアーカイブに失敗: ${thread.id}`, e));
}

async function replyTicketFailure(interaction: ButtonInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content }).catch((e) => console.warn("[ticket] 受付失敗メッセージの更新に失敗", e));
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((e) =>
    console.warn("[ticket] 受付失敗メッセージの送信に失敗", e),
  );
}

export async function openTicket(interaction: ButtonInteraction, services: Services, panelId: string): Promise<void> {
  const panel = services.tickets.getPanel(panelId);
  if (!panel) {
    await interaction.reply({ content: "この受付パネルの設定が見つかりません。運営に確認してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!panel.enabled) {
    await interaction.reply({ content: `「${panel.name}」は現在受付停止中です。`, flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel as TextChannel | null;
  if (!channel || channel.type !== ChannelType.GuildText || !interaction.guild) return;

  const existing = services.tickets.openByUserPanel(interaction.user.id, panel.id);
  if (existing) {
    await interaction.reply({
      content: `既に未完了の「${existing.panel_name ?? panel.name}」チケットがあります: <#${existing.thread_id}>`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const flightKey = `${interaction.user.id}:${panel.id}`;
  if (inFlightTickets.has(flightKey)) {
    await interaction.reply({ content: `「${panel.name}」の受付処理中です。少し待ってから確認してください。`, flags: MessageFlags.Ephemeral });
    return;
  }
  inFlightTickets.add(flightKey);

  let thread: PrivateThreadChannel | undefined;
  let ticketCreated = false;
  let initialized = false;

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const staffRoleIds = panelStaffRoleIds(panel, services);
    const notifyRoleIds = panelNotifyRoleIds(panel, staffRoleIds);
    const validStaffRoleIds = await existingRoleIds(interaction.guild, staffRoleIds);
    if (validStaffRoleIds.length === 0) {
      await interaction.editReply({ content: `「${panel.name}」の対応ロールが未設定、または削除されています。運営に確認してください。` });
      return;
    }
    const validNotifyRoleIds = await existingRoleIds(interaction.guild, notifyRoleIds);
    const accessRoleIds = uniq([...validStaffRoleIds, ...validNotifyRoleIds]);
    const staffMemberIds = (await memberIdsForRoles(interaction.guild, accessRoleIds)).filter(
      (memberId) => memberId !== interaction.user.id,
    );
    if (staffMemberIds.length === 0) {
      await interaction.editReply({ content: `「${panel.name}」の担当者をスレッドへ招待できません。申請者以外のロールメンバーまたはBot権限を確認してください。` });
      return;
    }

    const nick =
      interaction.member && "displayName" in interaction.member
        ? (interaction.member as GuildMember).displayName
        : (interaction.user.globalName ?? interaction.user.username);
    thread = (await channel.threads.create({
      name: `${panel.name}-${nick}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.ThreeDays,
    })) as PrivateThreadChannel;
    await thread.members.add(interaction.user.id);
    const invited = await addMembersToThread(thread, staffMemberIds);
    if (invited.added === 0) {
      console.error("[ticket] 担当者を1人もスレッドへ追加できないため受付を中止します", {
        panelId: panel.id,
        userId: interaction.user.id,
        threadId: thread.id,
        staffRoleIds: validStaffRoleIds,
        accessRoleIds,
        attemptedMembers: staffMemberIds.length,
      });
      await cleanupCreatedThread(thread, "ticket staff invite failed");
      thread = undefined;
      await interaction.editReply({
        content: `「${panel.name}」の担当者をスレッドへ追加できなかったため、受付を中止しました。運営に確認してください。`,
      });
      return;
    }

    const duplicate = services.tickets.openByUserPanel(interaction.user.id, panel.id);
    if (duplicate) {
      await cleanupCreatedThread(thread, "duplicate ticket detected");
      thread = undefined;
      await interaction.editReply({ content: `既に未完了の「${duplicate.panel_name ?? panel.name}」チケットがあります: <#${duplicate.thread_id}>` });
      return;
    }

    const ticket = services.tickets.create(thread.id, interaction.user.id, panel.id, {
      id: panel.id,
      name: panel.name,
      notifyRoleIds: validNotifyRoleIds,
      staffRoleIds: validStaffRoleIds,
    });
    ticketCreated = true;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket:claim").setLabel("対応する").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket:close").setLabel("クローズ").setStyle(ButtonStyle.Danger),
    );
    await thread.send({
      content: [
        `📮 **${ticket.panel_name ?? panel.name}** — <@${interaction.user.id}>`,
        validNotifyRoleIds.length > 0 ? validNotifyRoleIds.map((roleId) => `<@&${roleId}>`).join(" ") : "",
        panel.description,
        invited.failed > 0 ? `⚠️ 一部担当者をスレッドへ追加できませんでした（失敗 ${invited.failed}件）。` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      components: [row],
      allowedMentions: { users: [interaction.user.id], roles: validNotifyRoleIds },
    });
    initialized = true;
    await interaction.editReply({ content: `✅ スレッドを開きました: ${thread.toString()}` });
  } catch (e) {
    console.error("[ticket] チケット受付処理に失敗しました", {
      panelId: panel.id,
      userId: interaction.user.id,
      threadId: thread?.id,
      ticketCreated,
      initialized,
      error: e,
    });

    if (!initialized) {
      if (ticketCreated && thread) {
        try {
          services.tickets.rollbackCreate(thread.id, `user:${interaction.user.id}`, "ticket initialization failed");
        } catch (rollbackError) {
          console.error("[ticket] チケットDB行の巻き戻し処理でエラー", { threadId: thread.id, error: rollbackError });
        }
      }
      if (thread) await cleanupCreatedThread(thread, "ticket initialization failed");
      await replyTicketFailure(interaction, `「${panel.name}」の受付処理に失敗しました。チケットは作成されていません。運営に確認してください。`);
    } else {
      console.warn("[ticket] チケットは作成済みですが、利用者への完了応答に失敗しました", { threadId: thread?.id });
    }
  } finally {
    inFlightTickets.delete(flightKey);
  }
}

export async function handleTicketButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const id = interaction.customId;
  const panelId = panelIdFromTicketButton(id);
  if (panelId) return void (await openTicket(interaction, services, panelId));

  if (id === "ticket:claim") {
    if (!isTicketStaff(interaction, services)) {
      await interaction.reply({ content: "対応は、このチケットの対応ロールだけが可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ticket = services.tickets.claim(interaction.channelId, `user:${interaction.user.id}`);
    if (!ticket) return;
    await interaction.reply({ content: `📌 <@${interaction.user.id}> が対応します。` });
    return;
  }

  if (id === "ticket:close") {
    if (!isTicketStaff(interaction, services)) {
      await interaction.reply({ content: "クローズは、このチケットの対応ロールだけが可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ticket = services.tickets.close(interaction.channelId, `user:${interaction.user.id}`);
    if (!ticket) return;
    await interaction.reply({ content: `🔒 <@${interaction.user.id}> がクローズしました。お疲れさまでした。` });
    const thread = interaction.channel;
    if (thread?.isThread()) {
      await thread.setLocked(true).catch(() => undefined);
      await thread.setArchived(true).catch(() => undefined);
    }
    return;
  }
}
