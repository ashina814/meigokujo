from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_regex(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 regex match, found {count}")
    return new_text


admin_path = Path("apps/bot/src/commands/admin-hub.ts")
admin = admin_path.read_text()
admin = replace_regex(admin, r"function ticketPanelSummary\(panel: TicketPanel\): string \{.*?\nfunction ticketPanelCreateModal\(\) \{", '''function ticketPanelSummary(panel: TicketPanel): string {
  const placement = panel.channelId && panel.messageId ? `<#${panel.channelId}>` : "未設置";
  const state = panel.archivedAt ? "📦 アーカイブ済み" : panel.enabled ? panel.channelId && panel.messageId ? "🟢 有効・設置済み" : "🟡 有効・未設置" : panel.channelId && panel.messageId ? "⚫ 無効・設置済み" : "⚪ 無効・未設置";
  return [`・${state} **${panel.name}** (\\`${panel.id}\\`)`, `設置: ${placement}`, `通知 ${panel.notifyRoleIds.length}件 / 対応 ${panel.staffRoleIds.length}件`].join(" / ");
}

function ticketPanelHome(services: Services) {
  const panels = services.tickets.listPanels(true, true);
  const list = panels.length > 0 ? panels.slice(0, 12).map(ticketPanelSummary).join("\\n") : "（受付なし）";
  const embed = new EmbedBuilder().setTitle("🎫 チケット受付パネル").setColor(0x0ea5e9).setDescription([
    "受付ごとに表示文・設置先・通知ロール・対応ロールを持たせます。",
    "無効化は受付停止、撤去はDiscordメッセージだけを削除、削除/アーカイブは登録自体の終了です。",
    "対応ロールは「対応する」「クローズ」の権限判定にも使います。",
    "通知ロールは新着時にメンションされ、プライベートスレッドへ追加されます。対応・クローズ操作はできませんが、本文は閲覧できます。",
    "", list, "", "履歴のない独自受付だけ完全削除し、利用履歴または旧来互換がある受付はアーカイブします。",
  ].join("\\n"));
  const primary = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:tpanel:create").setLabel("新規作成").setEmoji("➕").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:edit").setLabel("内容編集").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:notify").setLabel("通知ロール").setEmoji("📣").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:staff").setLabel("対応ロール").setEmoji("🛡").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:install").setLabel("設置/再設置").setEmoji("📌").setStyle(ButtonStyle.Success),
  );
  const lifecycle = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mgmt:tpanel:remove").setLabel("設置パネル撤去").setEmoji("🧹").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("mgmt:tpanel:disable").setLabel("無効化").setEmoji("🛑").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("mgmt:tpanel:enable").setLabel("再有効化").setEmoji("▶️").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mgmt:tpanel:delete").setLabel("削除/アーカイブ").setEmoji("🗑").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [primary, lifecycle, backButton()] };
}

type TicketPanelPickerFilter = "all" | "enabled" | "disabled" | "installed";

function ticketPanelPicker(services: Services, customId: string, placeholder: string, filter: TicketPanelPickerFilter = "all") {
  let panels = services.tickets.listPanels();
  if (filter === "enabled") panels = panels.filter((panel) => panel.enabled);
  if (filter === "disabled") panels = panels.filter((panel) => !panel.enabled);
  if (filter === "installed") panels = panels.filter((panel) => panel.channelId && panel.messageId);
  if (panels.length === 0) return { content: `対象となる受付がありません。${placeholder}`, embeds: [], components: [backButton()] };
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(panels.slice(0, 25).map((p) => ({ label: `${p.enabled ? "🟢" : "⚫"} ${p.name}`.slice(0, 100), description: `ID: ${p.id}${p.channelId ? ` / #${p.channelId.slice(-6)}` : " / 未設置"}`.slice(0, 100), value: p.id })));
  return { embeds: [new EmbedBuilder().setTitle("🎫 チケット受付を選択").setDescription(placeholder)], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), backButton()] };
}

export function ticketPanelRolePicker(services: Services, panelId: string, type: "notify" | "staff") {
  const panel = services.tickets.getPanel(panelId);
  const label = type === "notify" ? "通知ロール" : "対応ロール";
  if (!panel || panel.archivedAt) return { content: "❌ 受付が見つからないか、アーカイブ済みです。", embeds: [], components: [backButton()] };
  const picker = new RoleSelectMenuBuilder().setCustomId(`mgmt:tpanel:${type}-roles:${panel.id}`).setPlaceholder(`${panel.name} の${label}を選ぶ（複数可 / 空でフォールバック）`).setMinValues(0).setMaxValues(10);
  return { embeds: [new EmbedBuilder().setTitle(`🎭 ${label}設定`).setDescription([`対象: **${panel.name}** (\\`${panel.id}\\`)`, "", type === "notify" ? "新着時にメンションされ、プライベートスレッドへ追加されるロールです。対応・クローズ操作はできませんが、本文は閲覧できます。空にすると対応ロールへフォールバックします。" : "「対応する」「クローズ」を許可し、プライベートスレッドへ招待するロールです。空にすると旧 ticket_staff へフォールバックします。"].join("\\n"))], components: [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(picker), backButton()] };
}

function ticketPanelCreateModal() {''', "ticket panel admin home and picker", flags=re.S)
admin = replace_once(admin, """function ticketPanelCreateModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:tpanel:create")
    .setTitle("チケット受付を作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("id")
          .setLabel("受付ID（英数字/_/-）")
          .setPlaceholder("ex: return_request")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(49),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("管理用名称").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("表示タイトル").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("description").setLabel("説明文").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("button_label").setLabel("ボタン名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ),
    );
}
""", """function ticketPanelCreateModal() {
  return new ModalBuilder()
    .setCustomId("mgmt:tpanel:create")
    .setTitle("チケット受付を作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("id").setLabel("受付ID（英数字/_/-）").setPlaceholder("ex: return_request").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(49)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("管理用名称").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("title").setLabel("表示タイトル").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("description").setLabel("説明文").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("button_label").setLabel("ボタン名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
    );
}

function ticketPanelEditModal(panel: TicketPanel) {
  return new ModalBuilder()
    .setCustomId(`mgmt:tpanel:edit:${panel.id}`)
    .setTitle("チケット受付を編集")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("name").setLabel("管理用名称").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(panel.name)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("title").setLabel("表示タイトル").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200).setValue(panel.title)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("description").setLabel("説明文").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000).setValue(panel.description)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("button_label").setLabel("ボタン名").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(panel.buttonLabel)),
    );
}
""", "ticket panel edit modal")
admin_path.write_text(admin)
