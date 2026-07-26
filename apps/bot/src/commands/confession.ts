import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type Message,
  type MessageCreateOptions,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import type { CloseReason, ConfessionRow } from "@meigokujo/core";
import { isChurchManager } from "../church-roles.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";
import * as base from "./confession-base.js";

export * from "./confession-base.js";

const VOICE_RECEIVED_REASON: CloseReason = "voice_received";
const VOICE_RECEIVED_LABEL = "あなたの声は届きました";

function asJson(value: unknown): any {
  if (value && typeof value === "object" && "toJSON" in value) {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return toJSON.call(value);
  }
  return value;
}

function replaceReplyOrigin(text: string): string {
  return text
    .replaceAll("運営から返信がある場合は", "冥教会から返信がある場合は")
    .replaceAll("運営から返信があれば", "冥教会から返信があれば")
    .replaceAll("— 運営より", "— 冥教会より");
}

/** 常設パネルの利用者向け文面だけ、返信元を冥教会へ統一する。 */
export function confessionPanelMessage(): MessageCreateOptions {
  const message = base.confessionPanelMessage();
  const embeds = (message.embeds ?? []).map((embed) => {
    const json = { ...(asJson(embed) ?? {}) };
    if (typeof json.description === "string") json.description = replaceReplyOrigin(json.description);
    return EmbedBuilder.from(json);
  });
  return { ...message, embeds };
}

function confessionId(customId: string): number | null {
  const parts = customId.split(":");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (/^\d+$/.test(parts[i] ?? "")) return Number(parts[i]);
  }
  return null;
}

function caseStatusText(row: ConfessionRow): string {
  if (row.status === "open") return "🕯️ 未対応";
  if (row.status === "closed") return "✅ 終結";
  switch (row.stage) {
    case "awaiting_poster":
      return "⏳ 投稿者からの返信待ち";
    case "awaiting_staff":
      return "📥 担当者からの返信待ち";
    default:
      return "🤝 対応中";
  }
}

function canOperate(interaction: ButtonInteraction, services: Services, row: ConfessionRow): boolean {
  if (isAdmin(interaction, services)) return true;
  if (row.claimed_by === interaction.user.id) return true;
  if (services.confessions.isAssignee(row.id, interaction.user.id)) return true;
  return (
    isChurchManager(interaction.member as GuildMember | null, services) &&
    (row.type === "soudan" || row.type === "zange")
  );
}

function closedControls(id: number, row: ConfessionRow): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId(`mimi:reopen:${id}`).setLabel("再オープン").setEmoji("🔓").setStyle(ButtonStyle.Secondary),
  ];
  if (row.body && !row.body_purged_at) {
    buttons.push(
      new ButtonBuilder().setCustomId(`mimi:extend:${id}`).setLabel("保持延長").setEmoji("📅").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`mimi:purgenow:${id}`).setLabel("本文を削除").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
    );
  }
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

/**
 * 元実装が管理パネルを再描画した後に、返信不要案件の専用ボタンと専用終了理由を同期する。
 * 元の各操作・権限・匿名性はそのまま利用し、この差分だけを上乗せする。
 */
async function syncCasePanel(client: Client, services: Services, id: number): Promise<void> {
  const row = services.confessions.get(id);
  if (!row?.thread_id || !row.panel_msg_id) return;

  const thread = await client.channels.fetch(row.thread_id).catch(() => null);
  if (!thread?.isThread()) return;
  const message = await thread.messages.fetch(row.panel_msg_id).catch(() => null);
  if (!message) return;

  const firstEmbed = message.embeds[0]?.toJSON();
  const embeds = firstEmbed
    ? [
        EmbedBuilder.from({
          ...firstEmbed,
          color: row.status === "closed" ? 0x6b7280 : firstEmbed.color,
          fields: (() => {
            const original = firstEmbed.fields ?? [];
            const oldClose = original.find((field) => field.name === "終了理由");
            const fields = original
              .filter((field) => field.name !== "終了理由")
              .map((field) => (field.name === "状態" ? { ...field, value: caseStatusText(row) } : field));
            if (row.status === "closed" && row.close_reason) {
              fields.push({
                name: "終了理由",
                value: row.close_reason === VOICE_RECEIVED_REASON ? VOICE_RECEIVED_LABEL : oldClose?.value ?? row.close_reason,
                inline: false,
              });
            }
            return fields;
          })(),
        }),
      ]
    : [];

  if (row.status === "closed") {
    await message.edit({ embeds, components: closedControls(id, row) }).catch(() => undefined);
    return;
  }

  const rows = message.components.map((componentRow) => {
    const json = asJson(componentRow) as { components?: any[] };
    return {
      ...json,
      components: (json.components ?? []).filter((component) => component.custom_id !== `mimi:voice_received:${id}`),
    };
  });

  if (row.reply_wish === "no") {
    const button = new ButtonBuilder()
      .setCustomId(`mimi:voice_received:${id}`)
      .setLabel(VOICE_RECEIVED_LABEL)
      .setEmoji("🕯️")
      .setStyle(ButtonStyle.Success)
      .toJSON();
    const closeRow = rows.find((actionRow) =>
      (actionRow.components ?? []).some((component) => component.custom_id === `mimi:close:${id}`),
    );
    if (closeRow && (closeRow.components?.length ?? 0) < 5) closeRow.components?.splice(-1, 0, button);
  }

  await message.edit({ embeds, components: rows as any }).catch(() => undefined);
}

async function rewriteSelectionReply(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.replied && !interaction.deferred) return;
  const message = await interaction.fetchReply().catch(() => null);
  if (!message) return;
  const rows = message.components.map((componentRow) => {
    const json = asJson(componentRow) as { components?: any[] };
    return {
      ...json,
      components: (json.components ?? []).map((component) =>
        component.custom_id === "mimi:selwish"
          ? { ...component, placeholder: "② 冥教会からの返信を希望する？" }
          : component,
      ),
    };
  });
  await interaction.editReply({ components: rows as any }).catch(() => undefined);
}

async function rewriteAcknowledgement(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.replied && !interaction.deferred) return;
  const message = await interaction.fetchReply().catch(() => null);
  if (!message?.content) return;
  const content = replaceReplyOrigin(message.content);
  if (content !== message.content) await interaction.editReply({ content }).catch(() => undefined);
}

export async function closeAsVoiceReceived(
  interaction: ButtonInteraction,
  services: Services,
  id: number,
): Promise<void> {
  const row = services.confessions.get(id);
  if (!row) {
    await interaction.reply({ content: "この件が見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canOperate(interaction, services, row)) {
    await interaction.reply({ content: "この案件の担当者、または管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (row.status === "closed") {
    await interaction.reply({ content: "この件は既に閉じられています。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (row.reply_wish !== "no") {
    await interaction.reply({
      content: "「あなたの声は届きました」は、返信不要を選んだ案件でのみ利用できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const retentionDays =
    row.court_status === "sent"
      ? services.settings.getNumber("confession_court_retention_days")
      : services.settings.getNumber("confession_body_retention_days");
  const closed = services.confessions.closeVoiceReceivedAtomic(id, interaction.user.id, retentionDays);
  if (!closed.ok) {
    await interaction.editReply({
      content:
        closed.code === "already_closed"
          ? "この件は既に閉じられています。"
          : "「あなたの声は届きました」は、返信不要を選んだ案件でのみ利用できます。",
    });
    return;
  }

  const openEmergency = services.confessions.openEmergencyFor(id);
  if (openEmergency) services.confessions.closeEmergency(openEmergency.id, interaction.user.id);

  const user = await interaction.client.users.fetch(closed.row.user_id).catch(() => null);
  const dmSent = user
    ? await user
        .send(
          [
            "# 🕯️ トートの耳",
            "",
            "あなたの声は、たしかに届きました。",
            "",
            "返信は不要とのことでしたので、この件はここでそっと閉じます。",
            "",
            "伝えてくれて、ありがとう。",
          ].join("\n"),
        )
        .then(() => true)
        .catch(() => false)
    : false;

  if (closed.row.thread_id) {
    const thread = await interaction.client.channels.fetch(closed.row.thread_id).catch(() => null);
    if (thread?.isThread()) {
      await thread
        .send({
          content: dmSent
            ? `🕯️ 「${VOICE_RECEIVED_LABEL}」でクローズしました。投稿者へのDM送信にも成功しました。`
            : `⚠️ 「${VOICE_RECEIVED_LABEL}」でクローズしましたが、投稿者へDMを送れませんでした。`,
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
    }
  }

  await syncCasePanel(interaction.client, services, id);
  await interaction.editReply({
    content: dmSent
      ? `投稿者へ『${VOICE_RECEIVED_LABEL}』と伝えてクローズしました`
      : "案件はクローズしましたが、投稿者へDMを送れませんでした",
  });

  if (closed.row.thread_id) {
    const thread = await interaction.client.channels.fetch(closed.row.thread_id).catch(() => null);
    if (thread?.isThread()) await thread.setArchived(true).catch(() => undefined);
  }
}

export async function handleConfessionButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  const id = confessionId(interaction.customId);

  if (action === "voice_received" && id !== null) {
    await closeAsVoiceReceived(interaction, services, id);
    return;
  }

  await base.handleConfessionButton(interaction, services);
  if (action === "new") await rewriteSelectionReply(interaction);
  if (id !== null) await syncCasePanel(interaction.client, services, id);
}

export async function handleConfessionStringSelect(
  interaction: StringSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  const id = confessionId(interaction.customId);
  await base.handleConfessionStringSelect(interaction, services);
  if (action === "seltype" || action === "selwish") await rewriteSelectionReply(interaction);
  if (id !== null) await syncCasePanel(interaction.client, services, id);
}

export async function handleConfessionModal(
  interaction: ModalSubmitInteraction,
  services: Services,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  const id = confessionId(interaction.customId);
  await base.handleConfessionModal(interaction, services);
  if (action === "body") await rewriteAcknowledgement(interaction);
  if (id !== null) await syncCasePanel(interaction.client, services, id);
}

export async function handleConfessionSelect(
  interaction: RoleSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const id = confessionId(interaction.customId);
  await base.handleConfessionSelect(interaction, services);
  if (id !== null) await syncCasePanel(interaction.client, services, id);
}

export async function handleConfessionUserSelect(
  interaction: UserSelectMenuInteraction,
  services: Services,
): Promise<void> {
  const id = confessionId(interaction.customId);
  await base.handleConfessionUserSelect(interaction, services);
  if (id !== null) await syncCasePanel(interaction.client, services, id);
}

/** 運営から投稿者への中継内容は維持し、利用者側の表示名だけ冥教会へ統一する。 */
export async function relayStaffMessage(
  client: Client,
  services: Services,
  message: Message,
): Promise<void> {
  if (message.author.bot || !message.channel.isThread()) return;
  const row = services.confessions.byThread(message.channel.id);
  if (!row || row.status === "closed") return;
  const body = message.content.trim();
  if (!body) return;

  const user = await client.users.fetch(row.user_id).catch(() => null);
  if (!user) return;
  const sent = await user
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x4c1d95)
          .setAuthor({ name: `👂 トートの耳 #${row.id} — 冥教会より` })
          .setDescription(body.slice(0, 4000))
          .setFooter({ text: "下のボタンから匿名のまま返信できます" }),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`mimi:reply:${row.id}`).setLabel("返信する").setEmoji("✍️").setStyle(ButtonStyle.Primary),
        ),
      ],
    })
    .then(() => true)
    .catch(() => false);

  await message.react(sent ? "📨" : "⚠️").catch(() => undefined);
  if (sent && (row.stage === "active" || row.stage === "awaiting_staff" || row.stage === "awaiting_poster")) {
    if (row.stage !== "awaiting_poster") services.confessions.setStage(row.id, "awaiting_poster", "system:relay");
    await syncCasePanel(client, services, row.id);
  }
}
