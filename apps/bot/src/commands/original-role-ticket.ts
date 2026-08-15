import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  LedgerError,
  OriginalRoleCaseError,
  ORIGINAL_ROLE_CONTINUATION_BASELINE_LAND,
  ORIGINAL_ROLE_NEW_BASELINE_LAND,
  ORIGINAL_ROLE_TICKET_PANEL_ID,
  type OriginalRoleInvoiceKind,
  type OriginalRoleInvoiceRow,
} from "@meigokujo/core";
import { fmtLd } from "../format.js";
import { isAdmin } from "../permissions.js";
import type { Services } from "../services.js";
import { memberHasAnyRole, ticketStaffRoleIds } from "./tickets.js";

const KIND_LABEL: Record<OriginalRoleInvoiceKind, string> = {
  new: "新規",
  continuation: "継続",
  restart: "再開",
  exception: "例外",
};

function staffAllowed(
  interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction,
  services: Services,
): boolean {
  if (isAdmin(interaction, services)) return true;
  if (!interaction.channelId) return false;
  const ticket = services.tickets.get(interaction.channelId);
  return memberHasAnyRole(interaction.member as GuildMember | null, ticketStaffRoleIds(ticket, services));
}

function isOriginalRoleTicket(services: Services, threadId: string | null) {
  if (!threadId) return undefined;
  const ticket = services.tickets.get(threadId);
  return ticket?.panel_id === ORIGINAL_ROLE_TICKET_PANEL_ID ? ticket : undefined;
}

function baselineNew(services: Services): number {
  const id = Number(services.settings.getString("shop:original_role_item_id"));
  const configured = Number.isSafeInteger(id) && id > 0 ? services.shop.getItem(id)?.price_land : null;
  return configured && configured > 0 ? configured : ORIGINAL_ROLE_NEW_BASELINE_LAND;
}

function baselineContinuation(services: Services): number {
  const raw = Number(services.settings.getString("original_role_renew_price"));
  return Number.isSafeInteger(raw) && raw > 0 ? raw : ORIGINAL_ROLE_CONTINUATION_BASELINE_LAND;
}

export function originalRoleTicketControlRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("orole:invoice").setLabel("請求を出す").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("orole:link").setLabel("既存契約を紐付け").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("orole:import-role").setLabel("実ロールをカルテ登録").setStyle(ButtonStyle.Secondary),
  );
}

export function originalRoleTicketIntro(): string {
  return [
    "🎨 **このスレッドが、このオリジナルロール専用のカルテです。**",
    "制作・継続・再開・今後の相談も、毎月新しいチケットを作らずここへ残します。",
    "料金の意味と金額は商館スタッフが本人と相談して決め、Botは請求・支払い・記録だけを担当します。",
  ].join("\n");
}

function invoiceCard(invoice: OriginalRoleInvoiceRow) {
  const buttons = invoice.status === "pending"
    ? [
        new ButtonBuilder()
          .setCustomId(`orole:invoice-pay:${invoice.id}`)
          .setLabel(`本人が支払う (${fmtLd(invoice.amount)})`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`orole:invoice-cancel:${invoice.id}`)
          .setLabel("請求を取り消す")
          .setStyle(ButtonStyle.Secondary),
      ]
    : [];
  return {
    content: [
      `🧾 **オリジナルロール請求 #${invoice.id}**`,
      `種別: **${KIND_LABEL[invoice.kind]}**`,
      `金額: **${fmtLd(invoice.amount)}**`,
      `対象: <@${invoice.user_id}>`,
      `発行: ${invoice.issued_by.startsWith("user:") ? `<@${invoice.issued_by.slice(5)}>` : invoice.issued_by}`,
      invoice.reason ? `理由: ${invoice.reason}` : "",
      "-# 種別はスタッフが明示しており、Botは金額から新規/継続/再開を推測しません。",
    ].filter(Boolean).join("\n"),
    components: buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [],
    allowedMentions: { users: [invoice.user_id] },
  };
}

async function postInvoice(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, invoice: OriginalRoleInvoiceRow) {
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) return;
  await channel.send(invoiceCard(invoice));
}

function invoiceKindMenu(services: Services) {
  const newAmount = baselineNew(services);
  const continuation = baselineContinuation(services);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("orole:invoice-kind")
      .setPlaceholder("請求の意味をスタッフが選択")
      .addOptions(
        { label: `新規 — ${fmtLd(newAmount)}`, value: "new", description: "現行の新規基準額" },
        { label: `継続 — ${fmtLd(continuation)}`, value: "continuation", description: "現行の継続基準額" },
        { label: `再開 — ${fmtLd(continuation)}`, value: "restart", description: "現行基準額。期限から自動判定しません" },
        { label: "例外 — 金額を入力", value: "exception", description: "理由必須。個別に金額を決める" },
      ),
  );
}

function exceptionModal() {
  return new ModalBuilder()
    .setCustomId("orole:invoice-exception")
    .setTitle("オリジナルロール 例外請求")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("amount").setLabel("請求額 (Ld)").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("例外理由（必須）").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500),
      ),
    );
}

async function issueStandard(
  interaction: StringSelectMenuInteraction,
  services: Services,
  kind: Exclude<OriginalRoleInvoiceKind, "exception">,
): Promise<void> {
  const ticket = isOriginalRoleTicket(services, interaction.channelId);
  if (!ticket || !staffAllowed(interaction, services)) {
    await interaction.reply({ content: "この操作は商館スタッフのみ実行できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  const amount = kind === "new" ? baselineNew(services) : baselineContinuation(services);
  try {
    const invoice = services.originalRoleCases.issueInvoice({
      threadId: ticket.thread_id,
      kind,
      amount,
      actor: `user:${interaction.user.id}`,
    });
    await interaction.reply({ content: `請求 #${invoice.id} を発行しました。`, flags: MessageFlags.Ephemeral });
    await postInvoice(interaction, invoice);
  } catch (error) {
    const pending = services.originalRoleCases.pendingInvoiceByTicket(ticket.thread_id);
    await interaction.reply({
      content: pending ? `未払いの請求 #${pending.id} があるため、新しい請求は出していません。既存請求を再掲します。` : `請求を発行できませんでした: ${String(error)}`,
      flags: MessageFlags.Ephemeral,
    });
    if (pending) await postInvoice(interaction, pending);
  }
}

export async function handleOriginalRoleTicketButton(interaction: ButtonInteraction, services: Services): Promise<boolean> {
  if (!interaction.customId.startsWith("orole:")) return false;
  const action = interaction.customId.split(":")[1];
  const ticket = isOriginalRoleTicket(services, interaction.channelId);
  if (!ticket) return false;

  if (action === "invoice-pay") {
    const invoiceId = Number(interaction.customId.split(":")[2]);
    const invoice = services.originalRoleCases.invoice(invoiceId);
    if (!invoice || invoice.user_id !== interaction.user.id) {
      await interaction.reply({ content: "この請求を確定できるのは対象本人だけです。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (invoice.status !== "pending") {
      await interaction.reply({ content: "この請求は既に処理済みです。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = services.shop.purchaseOriginalRoleInvoice({
        invoiceId,
        userId: interaction.user.id,
        actor: `user:${interaction.user.id}`,
        memberRoleIds: [...((interaction.member as GuildMember | null)?.roles.cache.keys() ?? [])],
        idempotencyKey: `original-role-invoice:${invoiceId}`,
      });
      await interaction.editReply(
        `✅ ${fmtLd(result.purchase.paid_land ?? invoice.amount)} を支払いました。購入 #${result.purchase.id} / 取引 #${result.transactionId}\n-# 実ロールの作成・編集・付与は商館スタッフがこのカルテで続けます。`,
      );
      await interaction.message.edit({
        ...invoiceCard(services.originalRoleCases.invoice(invoiceId)!),
        content: `${invoiceCard(services.originalRoleCases.invoice(invoiceId)!).content}\n✅ **支払済み** — 購入 #${result.purchase.id} / 取引 #${result.transactionId}`,
        components: [],
      }).catch(() => undefined);
    } catch (error) {
      const message = error instanceof LedgerError && error.code === "ERR_INSUFFICIENT"
        ? "Land残高が足りません。"
        : error instanceof LedgerError && error.code === "ERR_NEEDS_APPROVAL"
          ? "この金額は高額承認の閾値を超えています。商館スタッフへ確認してください。"
          : "支払いを確定できませんでした。請求状態を確認してもう一度お試しください。";
      await interaction.editReply(`❌ ${message}`);
    }
    return true;
  }

  if (action === "invoice-cancel") {
    if (!staffAllowed(interaction, services)) {
      await interaction.reply({ content: "請求の取消は商館スタッフのみ可能です。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const invoiceId = Number(interaction.customId.split(":")[2]);
    try {
      const cancelled = services.originalRoleCases.cancelInvoice(invoiceId, `user:${interaction.user.id}`);
      await interaction.update({
        ...invoiceCard(cancelled),
        content: `${invoiceCard(cancelled).content}\n🚫 **取消済み**`,
        components: [],
      });
    } catch {
      await interaction.reply({ content: "この請求は既に処理済みです。", flags: MessageFlags.Ephemeral });
    }
    return true;
  }

  if (!staffAllowed(interaction, services)) {
    await interaction.reply({ content: "この操作は商館スタッフのみ実行できます。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === "invoice") {
    const pending = services.originalRoleCases.pendingInvoiceByTicket(ticket.thread_id);
    if (pending) {
      await interaction.reply({ content: `未払いの請求 #${pending.id} を再掲します。`, flags: MessageFlags.Ephemeral });
      await postInvoice(interaction, pending);
      return true;
    }
    await interaction.reply({ content: "請求の意味を選んでください。", components: [invoiceKindMenu(services)], flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === "link") {
    const serviceCase = services.originalRoleCases.byTicket(ticket.thread_id)!;
    if (serviceCase.original_role_id !== null) {
      await interaction.reply({ content: "このカルテには既に実ロール契約が紐付いています。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const rows = services.originalRoleCases.linkableOriginalRoles(ticket.user_id);
    if (rows.length === 0) {
      await interaction.reply({ content: "紐付け可能な既存契約はありません。DB未登録の旧ロールは「実ロールをカルテ登録」を使ってください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const menu = new StringSelectMenuBuilder().setCustomId("orole:link-contract").setPlaceholder("既存契約を選択").addOptions(
      rows.slice(0, 25).map((r) => ({ label: `#${r.id} ${r.name}`.slice(0, 100), value: String(r.id), description: `${r.status}${r.role_id ? ` / role ${r.role_id}` : ""}`.slice(0, 100) })),
    );
    await interaction.reply({ content: "本人と実ロールを確認したうえで紐付けてください。再購入は発生しません。", components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)], flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === "import-role") {
    const serviceCase = services.originalRoleCases.byTicket(ticket.thread_id)!;
    if (serviceCase.original_role_id !== null) {
      await interaction.reply({ content: "このカルテには既に実ロール契約が紐付いています。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const menu = new RoleSelectMenuBuilder().setCustomId("orole:import-role-select").setPlaceholder("本人が実際に持っているオリロを選択").setMinValues(1).setMaxValues(1);
    await interaction.reply({
      content: "旧購入履歴は使いません。**本人が実際にそのロールを持っていることを確認して**カルテへ登録します。期限は推測せず未設定で取り込みます。",
      components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  return false;
}

export async function handleOriginalRoleTicketSelect(interaction: StringSelectMenuInteraction, services: Services): Promise<boolean> {
  if (!interaction.customId.startsWith("orole:")) return false;
  const ticket = isOriginalRoleTicket(services, interaction.channelId);
  if (!ticket || !staffAllowed(interaction, services)) {
    await interaction.reply({ content: "この操作は商館スタッフのみ実行できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.customId === "orole:invoice-kind") {
    const kind = interaction.values[0] as OriginalRoleInvoiceKind | undefined;
    if (kind === "exception") {
      await interaction.showModal(exceptionModal());
      return true;
    }
    if (kind === "new" || kind === "continuation" || kind === "restart") {
      await issueStandard(interaction, services, kind);
      return true;
    }
  }
  if (interaction.customId === "orole:link-contract") {
    const serviceCase = services.originalRoleCases.byTicket(ticket.thread_id)!;
    try {
      const linked = services.originalRoleCases.linkOriginalRole(serviceCase.id, Number(interaction.values[0]), `user:${interaction.user.id}`);
      const role = linked.original_role_id ? services.originalRoles.get(linked.original_role_id) : undefined;
      await interaction.update({ content: `✅ **${role?.name ?? `#${linked.original_role_id}`}** をこのカルテへ紐付けました。再購入は発生していません。`, components: [] });
    } catch {
      await interaction.update({ content: "紐付けできませんでした。本人・契約・既存カルテを確認してください。", components: [] });
    }
    return true;
  }
  return false;
}

export async function handleOriginalRoleTicketRoleSelect(interaction: RoleSelectMenuInteraction, services: Services): Promise<boolean> {
  if (interaction.customId !== "orole:import-role-select") return false;
  const ticket = isOriginalRoleTicket(services, interaction.channelId);
  if (!ticket || !staffAllowed(interaction, services) || !interaction.guild) {
    await interaction.reply({ content: "この操作は商館スタッフのみ実行できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  const roleId = interaction.values[0];
  const role = roleId ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
  const member = await interaction.guild.members.fetch({ user: ticket.user_id, force: true }).catch(() => null);
  if (!role || !member || role.id === interaction.guild.id || !member.roles.cache.has(role.id)) {
    await interaction.update({ content: "本人が現在持っている実ロールとして確認できませんでした。取り込みはしていません。", components: [] });
    return true;
  }
  if (services.originalRoles.roleTaken(role.id)) {
    await interaction.update({ content: "この実ロールは既に original_roles に登録されています。「既存契約を紐付け」を使ってください。", components: [] });
    return true;
  }
  try {
    const imported = services.originalRoles.importExisting({
      userId: ticket.user_id,
      roleId: role.id,
      name: role.name,
      expiresAt: null,
      actor: `user:${interaction.user.id}`,
    });
    const serviceCase = services.originalRoleCases.byTicket(ticket.thread_id)!;
    services.originalRoleCases.linkOriginalRole(serviceCase.id, imported.id, `user:${interaction.user.id}`);
    await interaction.update({
      content: `✅ <@&${role.id}> を本人確認済みの既存オリロとしてこのカルテへ取り込みました。**再購入は発生していません。**\n-# 期限は旧購入履歴から推測せず未設定です。今後の扱いは本人と相談してください。`,
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch {
    await interaction.update({ content: "取り込みに失敗しました。既存登録や本人の所持状況を確認してください。", components: [] });
  }
  return true;
}

export async function handleOriginalRoleTicketModal(interaction: ModalSubmitInteraction, services: Services): Promise<boolean> {
  if (interaction.customId !== "orole:invoice-exception") return false;
  const ticket = isOriginalRoleTicket(services, interaction.channelId);
  if (!ticket || !staffAllowed(interaction, services)) {
    await interaction.reply({ content: "この操作は商館スタッフのみ実行できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  const amount = Number(interaction.fields.getTextInputValue("amount").replace(/[, _]/g, ""));
  const reason = interaction.fields.getTextInputValue("reason").trim();
  if (!Number.isSafeInteger(amount) || amount <= 0 || !reason) {
    await interaction.reply({ content: "例外請求は正の整数金額と理由が必須です。", flags: MessageFlags.Ephemeral });
    return true;
  }
  try {
    const invoice = services.originalRoleCases.issueInvoice({
      threadId: ticket.thread_id,
      kind: "exception",
      amount,
      reason,
      actor: `user:${interaction.user.id}`,
    });
    await interaction.reply({ content: `例外請求 #${invoice.id} を発行しました。`, flags: MessageFlags.Ephemeral });
    await postInvoice(interaction, invoice);
  } catch (error) {
    const message = error instanceof OriginalRoleCaseError && error.code === "ERR_PENDING_INVOICE_EXISTS"
      ? "未払い請求があるため、新しい請求は出していません。"
      : "例外請求を発行できませんでした。";
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
  return true;
}
