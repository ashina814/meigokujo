from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_regex(text: str, pattern: str, replacement: str, label: str) -> str:
    new_text, count = re.subn(pattern, lambda _match: replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 regex match, found {count}")
    return new_text


admin_path = Path("apps/bot/src/commands/admin-hub.ts")
admin = admin_path.read_text()

admin = replace_once(
    admin,
    '''        const channel = await interaction.client.channels.fetch(panel.channelId).catch(() => null);
        if (channel?.isTextBased() && "messages" in channel) {
          const fetched = await fetchPanelMessage(channel, panel.messageId);
          if (fetched.ok && fetched.message) {
            const rendered = ticketPanelMessageForPanel(panel);
            await fetched.message.edit({ embeds: rendered.embeds, components: rendered.components }).catch(() => { warning = "設置済みメッセージの表示更新に失敗しました。再設置してください。"; });
          } else if (fetched.ok) {
            services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing message");
            warning = "設置済みメッセージが見つからなかったため未設置へ戻しました。";
          } else warning = "設置済みメッセージの取得に失敗しました。設定内容は保存されています。";
        } else {
          services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing channel");
          warning = "設置チャンネルが見つからなかったため未設置へ戻しました。";
        }
''',
    '''        let channelFetchFailed = false;
        const channel = await interaction.client.channels.fetch(panel.channelId).catch((error) => {
          channelFetchFailed = true;
          console.warn("[ticket-panel] 内容編集後の設置チャンネル取得に失敗しました", { panelId: panel.id, channelId: panel.channelId, error });
          return null;
        });
        if (channelFetchFailed) {
          warning = "設置チャンネルの取得に失敗しました。設置情報は維持しています。時間を置いて再試行してください。";
        } else if (channel?.isTextBased() && "messages" in channel) {
          const fetched = await fetchPanelMessage(channel, panel.messageId);
          if (fetched.ok && fetched.message) {
            const rendered = ticketPanelMessageForPanel(panel);
            await fetched.message.edit({ embeds: rendered.embeds, components: rendered.components }).catch(() => { warning = "設置済みメッセージの表示更新に失敗しました。再設置してください。"; });
          } else if (fetched.ok) {
            services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing message");
            warning = "設置済みメッセージが見つからなかったため未設置へ戻しました。";
          } else warning = "設置済みメッセージの取得に失敗しました。設定内容と設置情報は維持しています。";
        } else {
          services.tickets.clearPanelMessage(panel.id, `user:${interaction.user.id}`, "edit found missing channel");
          warning = "設置チャンネルが見つからなかったため未設置へ戻しました。";
        }
''',
    "preserve placement on transient edit fetch failure",
)

admin = replace_once(
    admin,
    '    services.tickets.setPanelMessage(panel.id, channel.id, sent.id, `user:${interaction.user.id}`);',
    '    const saved = services.tickets.setPanelMessage(panel.id, channel.id, sent.id, `user:${interaction.user.id}`);\n    if (!saved) throw new Error("ticket panel placement was not saved");',
    "require placement save result",
)

admin = replace_regex(
    admin,
    r'''  let warning = "";\n  if \(oldPlacement && oldPlacement\.channelId !== channel\.id\) \{.*?\n  \}\n\n  await interaction\.update''',
    '''  let warning = "";
  let staleOldPanelPossible = false;
  if (oldPlacement && oldPlacement.channelId !== channel.id) {
    let oldChannelFetchFailed = false;
    const oldChannel = await interaction.client.channels.fetch(oldPlacement.channelId).catch((e) => {
      oldChannelFetchFailed = true;
      console.warn("[ticket-panel] 移設後の旧チャンネル取得に失敗しました", { panelId: panel.id, oldPlacement, error: e });
      return null;
    });
    if (oldChannelFetchFailed) {
      staleOldPanelPossible = true;
      warning = "旧パネルのチャンネル取得に失敗し、旧パネルが残っている可能性があります。";
    } else if (oldChannel?.isTextBased() && "messages" in oldChannel) {
      const old = await fetchPanelMessage(oldChannel, oldPlacement.messageId);
      if (old.ok) {
        if (old.message) {
          const disabledOld = ticketPanelMessageForPanel({ ...panel, enabled: false });
          let oldDisabled = false;
          try {
            await old.message.edit({ embeds: disabledOld.embeds, components: disabledOld.components });
            oldDisabled = true;
          } catch (e) {
            console.warn("[ticket-panel] 移設後の旧パネル無効化に失敗しました", { panelId: panel.id, oldPlacement, error: e });
          }
          await old.message.delete().catch((e) => {
            warning = oldDisabled
              ? "旧パネルの削除に失敗しましたが、受付ボタンは無効化しました。手動削除してください。"
              : "旧パネルの無効化と削除に失敗しました。";
            if (!oldDisabled) staleOldPanelPossible = true;
            console.warn("[ticket-panel] 移設後の旧パネル削除に失敗しました", { panelId: panel.id, oldPlacement, oldDisabled, error: e });
          });
        }
      } else {
        staleOldPanelPossible = true;
        warning = "旧パネルの取得に失敗し、旧パネルが残っている可能性があります。";
        console.warn("[ticket-panel] 移設後の旧パネル取得に失敗しました", { panelId: panel.id, oldPlacement, error: old.error });
      }
    } else {
      warning = oldChannel
        ? "旧パネルのチャンネルがテキストチャンネルではありません。手動確認してください。"
        : "旧パネルのチャンネルが見つかりませんでした。";
      console.warn("[ticket-panel] 移設後の旧パネルチャンネルを処理できません", { panelId: panel.id, oldPlacement });
    }
  }

  if (staleOldPanelPossible) {
    try {
      const disabled = services.tickets.setPanelEnabled(panel.id, false, `user:${interaction.user.id}`);
      if (!disabled) throw new Error("ticket panel could not be disabled after stale placement risk");
      const disabledNew = ticketPanelMessageForPanel(disabled);
      await sent.edit({ embeds: disabledNew.embeds, components: disabledNew.components }).catch((e) =>
        console.warn("[ticket-panel] 安全停止後の新パネル表示更新に失敗しました", { panelId: panel.id, error: e }),
      );
      warning = `${warning} 安全のため受付登録を無効化しました。旧パネルを確認後、再有効化してください。`.trim();
    } catch (e) {
      console.error("[ticket-panel] 旧パネル残存リスク検出後の自動無効化に失敗しました", { panelId: panel.id, error: e });
      warning = `${warning} 受付登録の自動無効化にも失敗しました。直ちに手動で無効化してください。`.trim();
    }
  }

  await interaction.update''',
    "fail closed when old panel may remain",
)

admin_path.write_text(admin)

Path("apps/bot/tests/ticket-panel-lifecycle.test.ts").write_text(r'''// Lifecycle controls intentionally keep disable, uninstall, and registration removal as separate operations.
import { describe, expect, it, vi } from "vitest";
import type { TicketPanel } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

import {
  handleAdminModal,
  installTicketPanel,
  removeTicketPanelRegistration,
  setTicketPanelEnabled,
  uninstallTicketPanel,
} from "../src/commands/admin-hub.js";

const panel = (overrides: Partial<TicketPanel> = {}): TicketPanel => ({
  id: "appeal", name: "異議申立", channelId: "channel", messageId: "message", title: "異議申立 受付", description: "異議申立はこちら。", buttonLabel: "申立する", buttonEmoji: "🎫", notifyRoleIds: [], staffRoleIds: [], enabled: true, archivedAt: null, archivedBy: null, createdBy: null, updatedBy: null, createdAt: 1, updatedAt: 1, ...overrides,
});

function interaction(fetchChannel: (id: string) => Promise<any>) {
  return { user: { id: "admin" }, client: { channels: { fetch: vi.fn(fetchChannel) } }, update: vi.fn(async () => undefined) };
}

describe("チケット受付パネルの管理ライフサイクル", () => {
  it("再有効化時に設置メッセージが消えていれば未設置として復帰する", async () => {
    const before = panel({ enabled: false });
    const cleared = panel({ enabled: false, channelId: null, messageId: null });
    const enabled = panel({ enabled: true, channelId: null, messageId: null });
    const channel = { isTextBased: () => true, messages: { fetch: vi.fn(async () => Promise.reject({ code: 10008 })) } };
    const services = { tickets: { getPanel: vi.fn(() => before), clearPanelMessage: vi.fn(() => cleared), setPanelEnabled: vi.fn(() => enabled) } };
    const i = interaction(async () => channel);
    await setTicketPanelEnabled(i as any, services as any, "appeal", true);
    expect(services.tickets.clearPanelMessage).toHaveBeenCalled();
    expect(services.tickets.setPanelEnabled).toHaveBeenCalledWith("appeal", true, "user:admin");
    expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未設置") }));
  });

  it("内容編集時の一時的なチャンネル取得失敗では設置情報を解除しない", async () => {
    const before = panel();
    const updated = panel({ name: "異議申立 改" });
    const clearPanelMessage = vi.fn();
    const services = { tickets: { getPanel: vi.fn(() => before), upsertPanel: vi.fn(() => updated), clearPanelMessage } };
    const replies: any[] = [];
    const i = {
      customId: "mgmt:tpanel:edit:appeal",
      user: { id: "admin" },
      fields: { getTextInputValue: vi.fn((key: string) => ({ name: "異議申立 改", title: "異議申立 改", description: "変更後", button_label: "申立する" } as Record<string, string>)[key]) },
      client: { channels: { fetch: vi.fn(async () => Promise.reject(new Error("temporary"))) } },
      reply: vi.fn(async (payload: any) => { replies.push(payload); }),
    };
    await handleAdminModal(i as any, services as any);
    expect(clearPanelMessage).not.toHaveBeenCalled();
    expect(replies[0].content).toContain("設置情報は維持");
  });

  it("設置情報のDB保存結果が空なら新規メッセージを削除する", async () => {
    const sent = { id: "new_message", pin: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const channel = { id: "new_channel", isTextBased: () => true, send: vi.fn(async () => sent) };
    const services = { tickets: { getPanel: vi.fn(() => panel({ channelId: null, messageId: null })), setPanelMessage: vi.fn(() => undefined) } };
    const i = { ...interaction(async () => null), channel };
    await installTicketPanel(i as any, services as any, "appeal");
    expect(sent.delete).toHaveBeenCalledTimes(1);
    expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("保存に失敗") }));
  });

  it("移設時に旧パネルを無効化も削除もできなければ登録を安全停止する", async () => {
    const before = panel({ channelId: "old_channel", messageId: "old_message" });
    const placed = panel({ channelId: "new_channel", messageId: "new_message" });
    const disabled = panel({ channelId: "new_channel", messageId: "new_message", enabled: false });
    const sent = { id: "new_message", pin: vi.fn(async () => undefined), edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
    const oldMessage = { edit: vi.fn(async () => Promise.reject(new Error("edit failed"))), delete: vi.fn(async () => Promise.reject(new Error("delete failed"))) };
    const oldChannel = { isTextBased: () => true, messages: { fetch: vi.fn(async () => oldMessage) } };
    const newChannel = { id: "new_channel", isTextBased: () => true, send: vi.fn(async () => sent) };
    const services = { tickets: { getPanel: vi.fn(() => before), setPanelMessage: vi.fn(() => placed), setPanelEnabled: vi.fn(() => disabled) } };
    const i = { ...interaction(async () => oldChannel), channel: newChannel };
    await installTicketPanel(i as any, services as any, "appeal");
    expect(services.tickets.setPanelEnabled).toHaveBeenCalledWith("appeal", false, "user:admin");
    expect(sent.edit).toHaveBeenCalledTimes(1);
    expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it("撤去時にメッセージ削除が失敗したら登録を無効化して設置情報を解除する", async () => {
    const before = panel();
    const message = { edit: vi.fn(async () => undefined), delete: vi.fn(async () => Promise.reject(new Error("delete failed"))) };
    const channel = { isTextBased: () => true, messages: { fetch: vi.fn(async () => message) } };
    const services = { tickets: { getPanel: vi.fn(() => before), clearPanelMessage: vi.fn(() => panel({ enabled: false, channelId: null, messageId: null })) } };
    const i = interaction(async () => channel);
    await uninstallTicketPanel(i as any, services as any, "appeal");
    expect(services.tickets.clearPanelMessage).toHaveBeenCalledWith("appeal", "user:admin", "message delete failed during uninstall", true);
    expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("無効化") }));
  });

  it("履歴あり登録の削除操作はアーカイブ結果を表示する", async () => {
    const before = panel({ channelId: null, messageId: null });
    const services = { tickets: { getPanel: vi.fn(() => before), clearPanelMessage: vi.fn(() => before), removePanelRegistration: vi.fn(() => ({ mode: "archived", panel: before, totalTickets: 3, activeTickets: 1 })) } };
    const i = interaction(async () => null);
    await removeTicketPanelRegistration(i as any, services as any, "appeal");
    expect(services.tickets.removePanelRegistration).toHaveBeenCalledWith("appeal", "user:admin");
    expect(i.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("アーカイブ") }));
  });
});
''')
