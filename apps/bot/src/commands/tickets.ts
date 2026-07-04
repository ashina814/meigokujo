import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ThreadAutoArchiveDuration,
  type GuildMember,
  type MessageCreateOptions,
  type TextChannel,
} from "discord.js";
import type { TicketKind } from "@meigokujo/core";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";

const KIND_LABELS: Record<TicketKind, string> = { return: "出戻り申請", consult: "個別相談" };

export function ticketPanelMessage(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("📮 冥獄城 受付")
    .setDescription(
      [
        "ボタンを押すと、あなたとスタッフだけのプライベートスレッドが開きます。",
        "",
        "🔄 **出戻り申請** — 以前いた方の再入城はこちら",
        "❓ **個別相談** — その他の相談・問い合わせ",
      ].join("\n"),
    )
    .setColor(0x6b21a8);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ticket:return").setLabel("出戻り申請").setEmoji("🔄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ticket:consult").setLabel("個別相談").setEmoji("❓").setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function isTicketStaff(interaction: ButtonInteraction, services: Services): boolean {
  if (isAdmin(interaction, services)) return true;
  const roleId = services.settings.getString("role:ticket_staff");
  if (!roleId) return false;
  const member = interaction.member as GuildMember | null;
  return member?.roles.cache.has(roleId) ?? false;
}

export async function handleTicketButton(interaction: ButtonInteraction, services: Services): Promise<void> {
  const id = interaction.customId;

  if (id === "ticket:return" || id === "ticket:consult") {
    const kind: TicketKind = id === "ticket:return" ? "return" : "consult";
    const channel = interaction.channel as TextChannel | null;
    if (!channel || channel.type !== ChannelType.GuildText) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // 鯖のニックネーム（表示名）を使う。無ければグローバル名→ユーザー名
    const nick =
      interaction.member && "displayName" in interaction.member
        ? (interaction.member as GuildMember).displayName
        : (interaction.user.globalName ?? interaction.user.username);
    const thread = await channel.threads.create({
      name: `${KIND_LABELS[kind]}-${nick}`.slice(0, 90),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.ThreeDays,
    });
    await thread.members.add(interaction.user.id);
    services.tickets.create(thread.id, interaction.user.id, kind);

    const staffRoleId = services.settings.getString("role:ticket_staff");
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket:claim").setLabel("対応する").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket:close").setLabel("クローズ").setStyle(ButtonStyle.Danger),
    );
    await thread.send({
      content: [
        `📮 **${KIND_LABELS[kind]}** — <@${interaction.user.id}>`,
        staffRoleId ? `<@&${staffRoleId}>` : "",
        kind === "return"
          ? "以前のお名前と、いつ頃まで在城していたかを書いてお待ちください。"
          : "相談内容を書いてお待ちください。",
      ]
        .filter(Boolean)
        .join("\n"),
      components: [row],
    });
    await interaction.editReply({ content: `✅ スレッドを開きました: ${thread.toString()}` });
    return;
  }

  if (id === "ticket:claim") {
    if (!isTicketStaff(interaction, services)) {
      await interaction.reply({ content: "対応はスタッフのみ可能です。", flags: MessageFlags.Ephemeral });
      return;
    }
    const ticket = services.tickets.claim(interaction.channelId, `user:${interaction.user.id}`);
    if (!ticket) return;
    await interaction.reply({ content: `🙋 <@${interaction.user.id}> が対応します。` });
    return;
  }

  if (id === "ticket:close") {
    if (!isTicketStaff(interaction, services)) {
      await interaction.reply({ content: "クローズはスタッフのみ可能です。", flags: MessageFlags.Ephemeral });
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
