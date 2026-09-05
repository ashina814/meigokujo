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

/**
 * 利用者向けの文面だけ、返信元を冥教会へ統一する。
 *
 * base の文言が変わったらここも足す——**base と overlay で言葉がズレると、
 * 同じ機能が案内と DM で別の相手を名乗ることになる。**
 */
function replaceReplyOrigin(text: string): string {
  return text
    .replaceAll("運営から返信がある場合は", "冥教会から返信がある場合は")
    .replaceAll("運営から返信があれば", "冥教会から返信があれば")
    .replaceAll("運営からの回答をお待ちください", "冥教会からの回答をお待ちください")
    .replaceAll("必要に応じて運営からお返事します", "必要に応じて冥教会からお返事します")
    .replaceAll("運営が確認しだい", "冥教会が確認しだい")
    .replaceAll("必要があれば、運営から", "必要があれば、冥教会から")
    .replaceAll("運営からの回答は必要", "冥教会からの回答は必要")
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

/** 状態表示は base の正本を使う（期限付きの投稿者待ち・運営側の確認待ちをこちらで二重定義しない） */
const caseStatusText = base.statusText;

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

  // 受領確認は base の 📨 ボタンが全案件へ常設する。
  // ここでは古いパネルに残っている voice_received ボタンを取り除くだけ。

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
          ? { ...component, placeholder: "② この内容について、冥教会からの回答は必要？" }
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

export async function handleConfessionButton(
  interaction: ButtonInteraction,
  services: Services,
): Promise<void> {
  const action = interaction.customId.split(":")[1];
  const id = confessionId(interaction.customId);

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

/**
 * 外部返信の経路は 💬 返信する だけ。**スレッドへ書いても投稿者へは送らない。**
 * base 側の実装（スレッド内案内のみ）をそのまま使い、この overlay で
 * 迂回路を作り直さない。
 */
export const relayStaffMessage = base.relayStaffMessage;
