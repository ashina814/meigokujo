import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type GuildMember,
} from "discord.js";
import type { TicketRow } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";
import {
  handleTicketButton as handleTicketButtonBase,
  memberHasAnyRole,
  ticketStaffRoleIds,
} from "./tickets.js";

const CLOSE_CONFIRM_PREFIX = "ticket:close-confirm:";

type UpdatePayload = Parameters<ButtonInteraction["update"]>[0];
type ReplyPayload = Parameters<ButtonInteraction["reply"]>[0];
type EditReplyPayload = Parameters<ButtonInteraction["editReply"]>[0];

function actorUserId(actor: string | null | undefined): string | undefined {
  if (!actor) return undefined;
  return actor.startsWith("user:") ? actor.slice("user:".length) : actor;
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

function claimedActionRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:claim")
      .setLabel("対応済み")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder().setCustomId("ticket:close").setLabel("クローズ").setStyle(ButtonStyle.Danger),
  );
}

function baseThreadName(name: string): string {
  return name
    .replace(/^🔴未対応｜/u, "")
    .replace(/^🟡[^｜]{1,30}対応中｜/u, "")
    .replace(/^✅完了｜/u, "");
}

function displayName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member && "displayName" in member && typeof member.displayName === "string") return member.displayName;
  return interaction.user.globalName ?? interaction.user.username;
}

function safeThreadPart(value: string): string {
  return (value.replace(/[\r\n｜]/gu, " ").replace(/\s+/gu, " ").trim() || "担当者").slice(0, 24);
}

function canOperateTicket(
  interaction: ButtonInteraction,
  services: Services,
  ticket: TicketRow | undefined = services.tickets.get(interaction.channelId),
): boolean {
  if (isAdmin(interaction, services)) return true;
  const member = interaction.member as GuildMember | null;
  return memberHasAnyRole(member, ticketStaffRoleIds(ticket, services));
}

async function repairExistingClaimedUi(interaction: ButtonInteraction, ticket: TicketRow): Promise<void> {
  const claimantId = actorUserId(ticket.claimed_by);
  const status = claimantId ? `<@${claimantId}> が対応中` : "担当者が対応中";
  await interaction.message
    .edit({
      content: ticketStatusContent(interaction.message.content, `🟡 **対応状況:** ${status}`),
      components: [claimedActionRow()],
      allowedMentions: { parse: [] },
    })
    .catch((error) => console.warn("[ticket] 既存対応中チケットのメッセージ修復に失敗", error));

  const thread = interaction.channel;
  if (!thread?.isThread()) return;
  const staffName = claimantId === interaction.user.id ? displayName(interaction) : "担当者";
  const name = `🟡${safeThreadPart(staffName)}対応中｜${baseThreadName(thread.name)}`.slice(0, 90);
  await thread.setName(name, "既存チケットの対応表示を修復").catch((error) =>
    console.warn("[ticket] 既存対応中チケットのスレッド名修復に失敗", error),
  );
}

function toEditReplyPayload(payload: ReplyPayload): EditReplyPayload {
  if (typeof payload === "string") return { content: payload };
  const editable = { ...payload } as Record<string, unknown>;
  delete editable.flags;
  delete editable.ephemeral;
  delete editable.fetchReply;
  return editable as EditReplyPayload;
}

async function respondAfterAcknowledgement(
  interaction: ButtonInteraction,
  payload: ReplyPayload,
): Promise<unknown> {
  if (interaction.deferred || interaction.replied) return interaction.editReply(toEditReplyPayload(payload));
  return interaction.reply(payload);
}

function resilientInteraction(interaction: ButtonInteraction): ButtonInteraction {
  const closeConfirm = interaction.customId.startsWith(CLOSE_CONFIRM_PREFIX);

  return new Proxy(interaction, {
    get(target, property) {
      if (property === "reply") {
        return async (payload: ReplyPayload) => {
          try {
            return await respondAfterAcknowledgement(target, payload);
          } catch (error) {
            console.warn("[ticket] チケット操作結果の応答に失敗", error);
            return target.message as never;
          }
        };
      }

      if (property === "update") {
        return async (payload: UpdatePayload) => {
          if (target.deferred || target.replied) {
            try {
              return await target.editReply(payload);
            } catch (error) {
              const label = closeConfirm ? "クローズ確認画面" : "チケット操作画面";
              console.warn(`[ticket] ${label}の更新に失敗しましたが後処理を継続します`, error);
              return target.message as never;
            }
          }

          if (target.customId === "ticket:claim") {
            try {
              return await target.update(payload);
            } catch (error) {
              console.warn("[ticket] 対応状態のinteraction更新に失敗。元メッセージを直接更新します", error);
              const edited = await target.message.edit(payload).catch((editError) => {
                console.warn("[ticket] 対応状態の直接メッセージ更新にも失敗", editError);
                return null;
              });
              await respondAfterAcknowledgement(target, {
                content: edited
                  ? "対応者として登録し、表示を更新しました。"
                  : "対応者として登録しましたが、表示更新に失敗しました。再度押しても担当は重複しません。",
                flags: MessageFlags.Ephemeral,
              }).catch(() => undefined);
              return (edited ?? target.message) as never;
            }
          }

          return target.update(payload);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ButtonInteraction;
}

/**
 * チケット操作のDB状態遷移は tickets.ts / core が担い、この層はDiscord Interactionの応答期限と表示復旧を保証する。
 */
export async function handleTicketButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const ticket = services.tickets.get(interaction.channelId);
  const canOperate = canOperateTicket(interaction, services, ticket);
  const repairsClaimedUi =
    interaction.customId === "ticket:claim" && canOperate && ticket?.status === "claimed";

  if (repairsClaimedUi && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else if (
    interaction.customId.startsWith(CLOSE_CONFIRM_PREFIX) &&
    canOperate &&
    !interaction.deferred &&
    !interaction.replied
  ) {
    await interaction.deferUpdate();
  }

  if (repairsClaimedUi && ticket) await repairExistingClaimedUi(interaction, ticket);

  await handleTicketButtonBase(resilientInteraction(interaction), services);
}
