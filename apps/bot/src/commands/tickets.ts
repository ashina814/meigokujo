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
import { REEVAL_PANEL_ID, linkReevalPurchase, reevalActionRow } from "./reeval.js";
import type { Services } from "../services.js";

const LEGACY_KIND_LABELS: Record<string, string> = { return: "出戻り申請", consult: "個別相談" };
const OPEN_PREFIX = "ticket:open:";
const CLOSE_CONFIRM_PREFIX = "ticket:close-confirm:";
const inFlightTickets = new Set<string>();

type LockableThread = {
  id: string;
  setLocked(locked: boolean, reason?: string): Promise<unknown>;
  setArchived(archived: boolean, reason?: string): Promise<unknown>;
};

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

function actorUserId(actor: string | null | undefined): string | undefined {
  if (!actor) return undefined;
  return actor.startsWith("user:") ? actor.slice("user:".length) : actor;
}

function interactionDisplayName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member && "displayName" in member && typeof member.displayName === "string") return member.displayName;
  return interaction.user.globalName ?? interaction.user.username;
}

function safeThreadPart(value: string, fallback: string): string {
  const cleaned = value.replace(/[\r\n｜]/gu, " ").replace(/\s+/gu, " ").trim();
  return (cleaned || fallback).slice(0, 24);
}

function ticketBaseThreadName(name: string): string {
  return name
    .replace(/^🔴未対応｜/u, "")
    .replace(/^🟡[^｜]{1,30}対応中｜/u, "")
    .replace(/^✅完了｜/u, "");
}

function ticketThreadName(
  status: "open" | "claimed" | "closed",
  currentOrBase: string,
  staffName?: string,
): string {
  const base = ticketBaseThreadName(currentOrBase);
  const prefix =
    status === "open"
      ? "🔴未対応｜"
      : status === "claimed"
        ? `🟡${safeThreadPart(staffName ?? "担当者", "担当者")}対応中｜`
        : "✅完了｜";
  return `${prefix}${base}`.slice(0, 90);
}

function ticketStatusContent(content: string, statusLine: string): string {
  const lines = content
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("🔴 **対応状況:**") &&
        !line.startsWith("🟡 **対応状況:**") &&
        !line.startsWith("✅ **対応状況:**"),
    );
  while (lines.at(-1) === "") lines.pop();
  return [...lines, "", statusLine].join("\n");
}

function ticketActionRow(status: TicketRow["status"]): ActionRowBuilder<ButtonBuilder> {
  const claim = new ButtonBuilder()
    .setCustomId("ticket:claim")
    .setLabel(status === "open" ? "対応する" : "対応済み")
    .setStyle(status === "open" ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(status !== "open");
  const close = new ButtonBuilder()
    .setCustomId("ticket:close")
    .setLabel(status === "closed" ? "クローズ済み" : "クローズ")
    .setStyle(status === "closed" ? ButtonStyle.Secondary : ButtonStyle.Danger)
    .setDisabled(status === "closed");
  return new ActionRowBuilder<ButtonBuilder>().addComponents(claim, close);
}

function closeConfirmationRow(controlMessageId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CLOSE_CONFIRM_PREFIX}${controlMessageId}`)
      .setLabel("閉じる")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("ticket:close-cancel").setLabel("キャンセル").setStyle(ButtonStyle.Secondary),
  );
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
  const available = panel.enabled && !panel.archivedAt;
  const stateLabel = panel.archivedAt ? " / アーカイブ済み" : available ? "" : " / 無効";
  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description)
    .setColor(available ? 0x0ea5e9 : 0x64748b)
    .setFooter({ text: `受付ID: ${panel.id}${stateLabel}` });
  const button = new ButtonBuilder()
    .setCustomId(ticketOpenCustomId(panel.id))
    .setLabel(panel.buttonLabel)
    .setStyle(available ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(!available);
  if (panel.buttonEmoji) button.setEmoji(panel.buttonEmoji);
  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)] };
}

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

async function lockAndArchiveThread(thread: LockableThread, reason: string): Promise<void> {
  await thread.setLocked(true, reason).catch((e) => console.warn(`[ticket] スレッドのロックに失敗: ${thread.id}`, e));
  await thread.setArchived(true, reason).catch((e) => console.warn(`[ticket] スレッドのアーカイブに失敗: ${thread.id}`, e));
}

async function cleanupCreatedThread(thread: PrivateThreadChannel, reason: string): Promise<void> {
  try {
    await thread.delete(reason);
    return;
  } catch (e) {
    console.warn(`[ticket] 作成済みスレッドの削除に失敗したためロック/アーカイブします: ${thread.id}`, e);
  }
  await lockAndArchiveThread(thread, reason);
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
  if (panel.archivedAt) {
    await interaction.reply({ content: `「${panel.name}」は終了した受付です。`, flags: MessageFlags.Ephemeral });
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
    const staffMemberIds = (await memberIdsForRoles(interaction.guild, accessRoleIds)).filter((id) => id !== interaction.user.id);
    if (staffMemberIds.length === 0) {
      await interaction.editReply({ content: `「${panel.name}」の担当者をスレッドへ招待できません。申請者以外のロールメンバーまたはBot権限を確認してください。` });
      return;
    }

    const nick = interaction.member && "displayName" in interaction.member
      ? (interaction.member as GuildMember).displayName
      : (interaction.user.globalName ?? interaction.user.username);
    thread = (await channel.threads.create({
      name: ticketThreadName("open", `${panel.name}-${nick}`),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.ThreeDays,
    })) as PrivateThreadChannel;
    await thread.members.add(interaction.user.id);
    const invited = await addMembersToThread(thread, staffMemberIds);
    if (invited.added === 0) {
      await cleanupCreatedThread(thread, "ticket staff invite failed");
      thread = undefined;
      await interaction.editReply({ content: `「${panel.name}」の担当者をスレッドへ追加できなかったため、受付を中止しました。運営に確認してください。` });
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
    // 再評価面談は面談権（再評価チャレンジの購入）と機械的に紐付ける。
    // 同じ購入は一意インデックスで1チケットしか消費できない
    const reevalPurchaseId =
      panel.id === REEVAL_PANEL_ID ? linkReevalPurchase(services, thread.id, interaction.user.id) : null;
    await thread.send({
      content: [
        ...[
          `📮 **${ticket.panel_name ?? panel.name}** — <@${interaction.user.id}>`,
          validNotifyRoleIds.length > 0 ? validNotifyRoleIds.map((id) => `<@&${id}>`).join(" ") : "",
          panel.description,
          invited.failed > 0 ? `⚠️ 一部担当者をスレッドへ追加できませんでした（失敗 ${invited.failed}件）。` : "",
        ].filter(Boolean),
        "",
        "🔴 **対応状況:** 未対応",
      ].join("\n"),
      components: [ticketActionRow("open")],
      allowedMentions: { users: [interaction.user.id], roles: validNotifyRoleIds },
    });
    initialized = true;
    await interaction.editReply({ content: `✅ スレッドを開きました: ${thread.toString()}` });
  } catch (e) {
    console.error("[ticket] チケット受付処理に失敗しました", { panelId: panel.id, userId: interaction.user.id, threadId: thread?.id, ticketCreated, initialized, error: e });
    if (!initialized) {
      if (ticketCreated && thread) {
        try {
          services.tickets.rollbackCreate(thread.id, `user:${interaction.user.id}`, "ticket initialization failed");
        } catch (rollbackError) {
          console.error("[ticket] チケットDB行の巻き戻し処理でエラー", { threadId: thread.id, error: rollbackError });
        }
      }
      if (thread) await cleanupCreatedThread(thread, "ticket initialization failed");
      const raced = services.tickets.openByUserPanel(interaction.user.id, panel.id);
      await replyTicketFailure(
        interaction,
        raced
          ? `✅ 受付は既に完了しています。「${raced.panel_name ?? panel.name}」のスレッドはこちらです: <#${raced.thread_id}>`
          : `「${panel.name}」の受付処理に失敗しました。チケットは作成されていません。運営に確認してください。`,
      );
    } else {
      console.warn("[ticket] チケットは作成済みですが、利用者への完了応答に失敗しました", { threadId: thread?.id });
    }
  } finally {
    inFlightTickets.delete(flightKey);
  }
}

async function claimTicket(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isTicketStaff(interaction, services)) {
    await interaction.reply({ content: "対応は、このチケットの対応ロールだけが可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const current = services.tickets.get(interaction.channelId);
  if (!current) {
    await interaction.reply({ content: "このスレッドのチケット情報が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (current.status === "closed") {
    await interaction.reply({ content: "このチケットは既にクローズされています。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (current.status === "claimed") {
    const claimantId = actorUserId(current.claimed_by);
    await interaction.reply({ content: claimantId ? `既に <@${claimantId}> が対応中です。` : "このチケットは既に対応中です。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  const claimed = services.tickets.claim(interaction.channelId, `user:${interaction.user.id}`);
  if (!claimed || claimed.status !== "claimed") {
    await interaction.reply({ content: "対応状態の更新に失敗しました。もう一度お試しください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const claimantId = actorUserId(claimed.claimed_by);
  if (claimantId && claimantId !== interaction.user.id) {
    await interaction.reply({ content: `既に <@${claimantId}> が対応中です。`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  const content = ticketStatusContent(interaction.message.content, `🟡 **対応状況:** <@${interaction.user.id}> が対応中`);
  const payload = { content, components: [ticketActionRow("claimed")], allowedMentions: { parse: [] as never[] } };
  try {
    await interaction.update(payload);
  } catch (e) {
    console.warn("[ticket] 対応状態のinteraction更新に失敗。元メッセージを直接更新します", e);
    const repaired = await interaction.message.edit(payload).then(() => true).catch((editError) => {
      console.warn("[ticket] 対応状態の直接メッセージ更新にも失敗", editError);
      return false;
    });
    if (!repaired) {
      await interaction.reply({ content: "対応者として登録しましたが、表示更新に失敗しました。再度押しても担当は重複しません。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }

  const thread = interaction.channel;
  if (thread?.isThread()) {
    const nextName = ticketThreadName("claimed", thread.name, interactionDisplayName(interaction));
    await thread.setName(nextName, "チケット対応開始").catch((e) => console.warn("[ticket] 対応中スレッド名への更新に失敗", e));
  }
}

async function requestTicketClose(interaction: ButtonInteraction, services: Services): Promise<void> {
  if (!isTicketStaff(interaction, services)) {
    await interaction.reply({ content: "クローズは、このチケットの対応ロールだけが可能です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const ticket = services.tickets.get(interaction.channelId);
  if (!ticket) {
    await interaction.reply({ content: "このスレッドのチケット情報が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (ticket.status === "closed") {
    await interaction.reply({ content: "このチケットは既にクローズされています。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({
    content: "このチケットをクローズしますか？ クローズ後はスレッドがロック・アーカイブされます。",
    components: [closeConfirmationRow(interaction.message.id)],
    flags: MessageFlags.Ephemeral,
  });
}

async function confirmTicketClose(
  interaction: ButtonInteraction,
  services: Services,
  controlMessageId: string,
): Promise<void> {
  if (!isTicketStaff(interaction, services)) {
    await interaction.reply({ content: "クローズは、このチケットの対応ロールだけが可能です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const thread = interaction.channel?.isThread() ? interaction.channel : null;
  const current = services.tickets.get(interaction.channelId);
  if (!current) {
    await interaction.update({ content: "このスレッドのチケット情報が見つかりません。", components: [] });
    return;
  }

  if (current.status === "closed") {
    try {
      await interaction.update({ content: "このチケットは既にクローズされています。", components: [] });
    } finally {
      if (thread) await lockAndArchiveThread(thread, "既に完了済みのチケットを修復");
    }
    return;
  }

  const closed = services.tickets.close(interaction.channelId, `user:${interaction.user.id}`);
  if (!closed || closed.status !== "closed") {
    const latest = services.tickets.get(interaction.channelId);
    await interaction.update({
      content: latest?.status === "closed" ? "このチケットは既にクローズされています。" : "クローズ処理に失敗しました。もう一度お試しください。",
      components: [],
    });
    if (latest?.status === "closed" && thread) await lockAndArchiveThread(thread, "競合後の完了チケットを修復");
    return;
  }

  try {
    if (thread) {
      const controlMessage = await thread.messages.fetch(controlMessageId).catch((e) => {
        console.warn("[ticket] クローズ時に受付メッセージを取得できませんでした", e);
        return null;
      });
      if (controlMessage) {
        const content = ticketStatusContent(controlMessage.content, `✅ **対応状況:** <@${interaction.user.id}> がクローズ`);
        await controlMessage.edit({ content, components: [ticketActionRow("closed")], allowedMentions: { parse: [] } }).catch((e) => console.warn("[ticket] クローズ状態のメッセージ更新に失敗", e));
      }
      await thread.setName(ticketThreadName("closed", thread.name), "チケット完了").catch((e) => console.warn("[ticket] 完了スレッド名への更新に失敗", e));
    }

    await interaction.update({
      content: `🔒 <@${interaction.user.id}> がクローズしました。お疲れさまでした。`,
      components: [],
      allowedMentions: { parse: [] },
    }).catch((e) => console.warn("[ticket] クローズ完了応答に失敗", e));
  } finally {
    if (thread) await lockAndArchiveThread(thread, "チケット完了");
  }
}

export async function handleTicketButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const id = interaction.customId;
  const panelId = panelIdFromTicketButton(id);
  if (panelId) return void (await openTicket(interaction, services, panelId));
  if (id === "ticket:claim") return void (await claimTicket(interaction, services));
  if (id === "ticket:close") return void (await requestTicketClose(interaction, services));
  if (id === "ticket:close-cancel") {
    await interaction.update({ content: "クローズをキャンセルしました。", components: [] });
    return;
  }
  if (id.startsWith(CLOSE_CONFIRM_PREFIX)) {
    const controlMessageId = id.slice(CLOSE_CONFIRM_PREFIX.length);
    if (!controlMessageId) {
      await interaction.update({ content: "元の受付メッセージを特定できません。もう一度クローズを押してください。", components: [] });
      return;
    }
    return void (await confirmTicketClose(interaction, services, controlMessageId));
  }
}
