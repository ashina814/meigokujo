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
admin = replace_once(admin, """  if (section === "tpanel" && action === "install") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:install-pick", "設置・再設置する受付を選ぶ")));
  if (section === "tpanel" && action === "notify") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:notify-pick", "通知ロールを設定する受付を選ぶ")));
  if (section === "tpanel" && action === "staff") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:staff-pick", "対応ロールを設定する受付を選ぶ")));
  if (section === "tpanel" && action === "disable") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:disable-pick", "無効化する受付を選ぶ")));
""", """  if (section === "tpanel" && action === "edit") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:edit-pick", "内容を編集する受付を選ぶ")));
  if (section === "tpanel" && action === "install") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:install-pick", "設置・再設置する受付を選ぶ")));
  if (section === "tpanel" && action === "remove") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:remove-pick", "設置パネルを撤去する受付を選ぶ", "installed")));
  if (section === "tpanel" && action === "notify") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:notify-pick", "通知ロールを設定する受付を選ぶ")));
  if (section === "tpanel" && action === "staff") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:staff-pick", "対応ロールを設定する受付を選ぶ")));
  if (section === "tpanel" && action === "disable") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:disable-pick", "無効化する受付を選ぶ", "enabled")));
  if (section === "tpanel" && action === "enable") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:enable-pick", "再有効化する受付を選ぶ", "disabled")));
  if (section === "tpanel" && action === "delete") return void (await interaction.update(ticketPanelPicker(services, "mgmt:tpanel:delete-pick", "削除・アーカイブする受付を選ぶ")));
  if (section === "tpanel" && action === "disable-confirm" && arg) return void (await setTicketPanelEnabled(interaction, services, arg, false));
  if (section === "tpanel" && action === "enable-confirm" && arg) return void (await setTicketPanelEnabled(interaction, services, arg, true));
  if (section === "tpanel" && action === "remove-confirm" && arg) return void (await uninstallTicketPanel(interaction, services, arg));
  if (section === "tpanel" && action === "delete-confirm" && arg) return void (await removeTicketPanelRegistration(interaction, services, arg));
""", "admin ticket panel button routes")
admin = replace_once(admin, """  if (section === "tpanel" && action === "install-pick" && interaction.isStringSelectMenu()) {
    return void (await installTicketPanel(interaction, services, interaction.values[0]!));
  }
  if (section === "tpanel" && action === "notify-pick" && interaction.isStringSelectMenu()) {
""", """  if (section === "tpanel" && action === "edit-pick" && interaction.isStringSelectMenu()) {
    const panel = services.tickets.getPanel(interaction.values[0]!);
    if (!panel || panel.archivedAt) {
      return void (await interaction.update({ content: "❌ 編集できる受付が見つかりません。", embeds: [], components: [backButton()] }));
    }
    return void (await interaction.showModal(ticketPanelEditModal(panel)));
  }
  if (section === "tpanel" && action === "install-pick" && interaction.isStringSelectMenu()) {
    return void (await installTicketPanel(interaction, services, interaction.values[0]!));
  }
  if (section === "tpanel" && action === "remove-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "remove")));
  }
  if (section === "tpanel" && action === "notify-pick" && interaction.isStringSelectMenu()) {
""", "admin edit/remove selection routes")
admin = replace_once(admin, """  if (section === "tpanel" && action === "disable-pick" && interaction.isStringSelectMenu()) {
    return void (await disableTicketPanel(interaction, services, interaction.values[0]!));
  }
""", """  if (section === "tpanel" && action === "disable-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "disable")));
  }
  if (section === "tpanel" && action === "enable-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "enable")));
  }
  if (section === "tpanel" && action === "delete-pick" && interaction.isStringSelectMenu()) {
    return void (await interaction.update(ticketPanelConfirm(services, interaction.values[0]!, "delete")));
  }
""", "admin lifecycle confirmation selection routes")
admin = replace_once(admin, """  if (section === "tpanel" && action === "create") {
    const id = interaction.fields.getTextInputValue("id").trim().toLowerCase();
    const name = interaction.fields.getTextInputValue("name").trim();
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const buttonLabel = interaction.fields.getTextInputValue("button_label").trim();
    try {
      const panel = services.tickets.upsertPanel(
        { id, name, title, description, buttonLabel, enabled: true },
        `user:${interaction.user.id}`,
      );
      await interaction.reply({
        content: `✅ チケット受付「${panel.name}」を保存しました。続けて **通知ロール** と **対応ロール** を設定してください。未設定の間は旧 ticket_staff にフォールバックします。`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      await interaction.reply({
        content: `❌ 保存に失敗しました。IDは英小文字・数字・_・- の2〜49文字で指定してください。${e instanceof Error ? ` (${e.message})` : ""}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }
""", """  if (section === "tpanel" && action === "create") {
    const id = interaction.fields.getTextInputValue("id").trim().toLowerCase();
    const name = interaction.fields.getTextInputValue("name").trim();
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const buttonLabel = interaction.fields.getTextInputValue("button_label").trim();
    try {
      const panel = services.tickets.upsertPanel({ id, name, title, description, buttonLabel, enabled: true }, `user:${interaction.user.id}`);
      await interaction.reply({ content: `✅ チケット受付「${panel.name}」を保存しました。続けて **通知ロール** と **対応ロール** を設定してください。未設定の間は旧 ticket_staff にフォールバックします。`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: `❌ 保存に失敗しました。IDは英小文字・数字・_・- の2〜49文字で指定してください。${e instanceof Error ? ` (${e.message})` : ""}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (section === "tpanel" && action === "edit") {
    const id = parts[3]!;
    const current = services.tickets.getPanel(id);
    if (!current || current.archivedAt) {
      await interaction.reply({ content: "❌ 編集できる受付が見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }
    const name = interaction.fields.getTextInputValue("name").trim();
    const title = interaction.fields.getTextInputValue("title").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const buttonLabel = interaction.fields.getTextInputValue("button_label").trim();
    try {
      const panel = services.tickets.upsertPanel({ id, name, title, description, buttonLabel, buttonEmoji: current.buttonEmoji, notifyRoleIds: current.notifyRoleIds, staffRoleIds: current.staffRoleIds, enabled: current.enabled }, `user:${interaction.user.id}`);
      let warning = "";
      if (panel.channelId && panel.messageId) {
        const channel = await interaction.client.channels.fetch(panel.channelId).catch(() => null);
        if (channel?.isTextBased() && "messages" in channel) {
          const fetched = await fetchPanelMessage(channel, panel.messageId);
          if (fetched.ok && fetched.message) {
            await fetched.message.edit(ticketPanelMessageForPanel(panel)).catch(() => { warning = "設置済みメッセージの表示更新に失敗しました。再設置してください。"; });
          } else if (fetched.ok) {
            services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing message");
            warning = "設置済みメッセージが見つからなかったため未設置へ戻しました。";
          } else warning = "設置済みメッセージの取得に失敗しました。設定内容は保存されています。";
        } else {
          services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing channel");
          warning = "設置チャンネルが見つからなかったため未設置へ戻しました。";
        }
      }
      await interaction.reply({ content: `✅ チケット受付「${panel.name}」を更新しました。${warning ? `\n⚠️ ${warning}` : ""}`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: `❌ 更新に失敗しました。${e instanceof Error ? ` (${e.message})` : ""}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
""", "admin edit modal handler")
admin_path.write_text(admin)
