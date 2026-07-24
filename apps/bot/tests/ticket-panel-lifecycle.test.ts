// Lifecycle controls intentionally keep disable, uninstall, and registration removal as separate operations.
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
