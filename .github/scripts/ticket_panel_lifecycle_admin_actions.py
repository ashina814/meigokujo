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
admin = replace_regex(admin, r"export async function disableTicketPanel\(.*?\n\}\n\n// ---- 給与サブパネル ----", '''type TicketPanelConfirmAction = "disable" | "enable" | "remove" | "delete";

function ticketPanelConfirm(services: Services, panelId: string, action: TicketPanelConfirmAction) {
  const panel = services.tickets.getPanel(panelId);
  if (!panel || panel.archivedAt) return { content: "❌ 対象の受付が見つからないか、既にアーカイブ済みです。", embeds: [], components: [backButton()] };
  const counts = services.tickets.panelTicketCounts(panel.id);
  const copy = {
    disable: { title: "🛑 受付を無効化しますか？", description: "登録と設置メッセージを残したまま、新規受付を停止します。後から再有効化できます。", label: "無効化する" },
    enable: { title: "▶️ 受付を再有効化しますか？", description: "設置済みメッセージが存在する場合は、受付ボタンも再び有効にします。", label: "再有効化する" },
    remove: { title: "🧹 設置パネルを撤去しますか？", description: "Discord上の受付メッセージと設置情報だけを削除します。登録内容は残り、後から再設置できます。", label: "撤去する" },
    delete: { title: "🗑 受付登録を終了しますか？", description: counts.total === 0 && !["return", "consult"].includes(panel.id) ? "利用履歴がないため登録を完全削除します。" : `利用履歴または旧来互換があるためアーカイブします（全${counts.total}件 / 未完了${counts.active}件）。既存チケットは変更しません。`, label: counts.total === 0 && !["return", "consult"].includes(panel.id) ? "完全削除する" : "アーカイブする" },
  }[action];
  const confirm = new ButtonBuilder().setCustomId(`mgmt:tpanel:${action}-confirm:${panel.id}`).setLabel(copy.label).setStyle(action === "enable" ? ButtonStyle.Success : ButtonStyle.Danger);
  const cancel = new ButtonBuilder().setCustomId("mgmt:tpanel").setLabel("キャンセル").setStyle(ButtonStyle.Secondary);
  return { embeds: [new EmbedBuilder().setTitle(copy.title).setDescription([`対象: **${panel.name}** (\\`${panel.id}\\`)`, "", copy.description].join("\\n"))], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel)] };
}

export async function setTicketPanelEnabled(interaction: ButtonInteraction, services: Services, panelId: string, enabled: boolean): Promise<void> {
  const before = services.tickets.getPanel(panelId);
  if (!before || before.archivedAt) { await interaction.update({ content: "❌ 受付が見つからないか、アーカイブ済みです。", embeds: [], components: [backButton()] }); return; }
  const actor = `user:${interaction.user.id}`;
  let warning = "";
  if (before.channelId && before.messageId) {
    let channelFetchFailed = false;
    const channel = await interaction.client.channels.fetch(before.channelId).catch((error) => { channelFetchFailed = true; console.warn("[ticket-panel] 状態変更前のチャンネル取得に失敗しました", { panelId, enabled, error }); return null; });
    if (channelFetchFailed) { await interaction.update({ content: "⚠️ 設置チャンネルの取得に失敗したため、状態変更を中止しました。時間を置いて再試行してください。", embeds: [], components: [backButton()] }); return; }
    if (!channel || !channel.isTextBased() || !("messages" in channel)) {
      services.tickets.clearPanelMessage(panelId, actor, "state change found missing channel");
      warning = "設置チャンネルが見つからなかったため、未設置状態へ戻しました。";
    } else {
      const fetched = await fetchPanelMessage(channel, before.messageId);
      if (!fetched.ok) { await interaction.update({ content: "⚠️ 設置済みメッセージの取得に失敗したため、状態変更を中止しました。時間を置いて再試行してください。", embeds: [], components: [backButton()] }); return; }
      if (!fetched.message) {
        services.tickets.clearPanelMessage(panelId, actor, "state change found missing message");
        warning = "設置済みメッセージが見つからなかったため、未設置状態へ戻しました。";
      } else {
        const preview: TicketPanel = { ...before, enabled };
        const previewMessage = ticketPanelMessageForPanel(preview);
        try { await fetched.message.edit({ embeds: previewMessage.embeds, components: previewMessage.components }); }
        catch (error) { console.warn("[ticket-panel] 状態変更前のメッセージ更新に失敗しました", { panelId, enabled, error }); await interaction.update({ content: "❌ 設置済みメッセージを更新できなかったため、DB上の状態は変更していません。", embeds: [], components: [backButton()] }); return; }
        try {
          const changed = services.tickets.setPanelEnabled(panelId, enabled, actor);
          if (!changed) throw new Error("panel state update returned no row");
        } catch (error) {
          const rollback = ticketPanelMessageForPanel(before);
          await fetched.message.edit({ embeds: rollback.embeds, components: rollback.components }).catch((rollbackError) => console.error("[ticket-panel] 状態変更DB失敗後の表示ロールバックにも失敗しました", { panelId, enabled, error: rollbackError }));
          console.error("[ticket-panel] 状態変更のDB保存に失敗しました", { panelId, enabled, error });
          await interaction.update({ content: "❌ 状態変更の保存に失敗しました。可能な範囲で表示を元に戻しました。", embeds: [], components: [backButton()] });
          return;
        }
        await interaction.update({ content: `${enabled ? "▶️" : "🛑"} 「${before.name}」を${enabled ? "再有効化" : "無効化"}しました。既存チケットは変更していません。`, embeds: [], components: [backButton()] });
        return;
      }
    }
  }
  const panel = services.tickets.setPanelEnabled(panelId, enabled, actor);
  await interaction.update({ content: panel ? `${enabled ? "▶️" : "🛑"} 「${panel.name}」を${enabled ? "再有効化" : "無効化"}しました。現在は未設置です。${warning ? `\\n⚠️ ${warning}` : ""}` : "❌ 状態変更に失敗しました。", embeds: [], components: [backButton()] });
}

async function detachTicketPanelMessage(interaction: ButtonInteraction, services: Services, panel: TicketPanel, actor: string): Promise<{ warning: string; forcedDisabled: boolean }> {
  if (!panel.channelId || !panel.messageId) { services.tickets.clearPanelMessage(panel.id, actor, "already uninstalled"); return { warning: "既に未設置でした。", forcedDisabled: false }; }
  let channelFetchFailed = false;
  const channel = await interaction.client.channels.fetch(panel.channelId).catch((error) => { channelFetchFailed = true; console.warn("[ticket-panel] 撤去時のチャンネル取得に失敗しました", { panelId: panel.id, error }); return null; });
  if (channelFetchFailed) { services.tickets.clearPanelMessage(panel.id, actor, "channel fetch failed during uninstall", true); return { warning: "設置チャンネルを取得できず旧メッセージが残る可能性があるため、登録を安全のため無効化しました。手動確認後に再有効化してください。", forcedDisabled: true }; }
  if (!channel || !channel.isTextBased() || !("messages" in channel)) { services.tickets.clearPanelMessage(panel.id, actor, "channel missing during uninstall"); return { warning: "設置チャンネルが存在しなかったため、古い設置情報だけ解除しました。", forcedDisabled: false }; }
  const fetched = await fetchPanelMessage(channel, panel.messageId);
  if (!fetched.ok) { services.tickets.clearPanelMessage(panel.id, actor, "message fetch failed during uninstall", true); return { warning: "設置メッセージを取得できず残存の可能性があるため、登録を安全のため無効化しました。手動確認後に再有効化してください。", forcedDisabled: true }; }
  if (!fetched.message) { services.tickets.clearPanelMessage(panel.id, actor, "message missing during uninstall"); return { warning: "設置メッセージは既に削除されていたため、古い設置情報だけ解除しました。", forcedDisabled: false }; }
  const disabledMessage = ticketPanelMessageForPanel({ ...panel, enabled: false });
  await fetched.message.edit({ embeds: disabledMessage.embeds, components: disabledMessage.components }).catch((error) => console.warn("[ticket-panel] 撤去前のボタン無効化に失敗しました", { panelId: panel.id, error }));
  try { await fetched.message.delete(); services.tickets.clearPanelMessage(panel.id, actor, "manual uninstall"); return { warning: "", forcedDisabled: false }; }
  catch (error) { console.warn("[ticket-panel] 設置メッセージ削除に失敗しました", { panelId: panel.id, error }); services.tickets.clearPanelMessage(panel.id, actor, "message delete failed during uninstall", true); return { warning: "メッセージ削除に失敗したため設置情報を解除し、残ったボタンから受付できないよう登録を無効化しました。手動削除してください。", forcedDisabled: true }; }
}

export async function uninstallTicketPanel(interaction: ButtonInteraction, services: Services, panelId: string): Promise<void> {
  const panel = services.tickets.getPanel(panelId);
  if (!panel || panel.archivedAt) { await interaction.update({ content: "❌ 受付が見つからないか、アーカイブ済みです。", embeds: [], components: [backButton()] }); return; }
  const result = await detachTicketPanelMessage(interaction, services, panel, `user:${interaction.user.id}`);
  await interaction.update({ content: `🧹 「${panel.name}」の設置パネルを撤去しました。受付登録と既存チケットは残っています。${result.warning ? `\\n⚠️ ${result.warning}` : ""}`, embeds: [], components: [backButton()] });
}

export async function removeTicketPanelRegistration(interaction: ButtonInteraction, services: Services, panelId: string): Promise<void> {
  const panel = services.tickets.getPanel(panelId);
  if (!panel || panel.archivedAt) { await interaction.update({ content: "❌ 受付が見つからないか、既にアーカイブ済みです。", embeds: [], components: [backButton()] }); return; }
  const detach = await detachTicketPanelMessage(interaction, services, panel, `user:${interaction.user.id}`);
  const result = services.tickets.removePanelRegistration(panelId, `user:${interaction.user.id}`);
  if (!result) { await interaction.update({ content: "❌ 受付登録の削除・アーカイブに失敗しました。", embeds: [], components: [backButton()] }); return; }
  await interaction.update({ content: result.mode === "deleted" ? `🗑 「${panel.name}」の受付登録を完全削除しました。${detach.warning ? `\\n⚠️ ${detach.warning}` : ""}` : `📦 「${panel.name}」をアーカイブしました（履歴 ${result.totalTickets}件 / 未完了 ${result.activeTickets}件）。既存チケットは変更していません。${detach.warning ? `\\n⚠️ ${detach.warning}` : ""}`, embeds: [], components: [backButton()] });
}

// ---- 給与サブパネル ----''', "ticket panel lifecycle admin functions", flags=re.S)
admin_path.write_text(admin)
