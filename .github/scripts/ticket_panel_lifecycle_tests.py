from pathlib import Path

core_test_path = Path("packages/core/tests/vc-tickets.test.ts")
core_test = core_test_path.read_text()
core_test += r'''

describe("チケット受付パネルのライフサイクル", () => {
  it("無効化後に再有効化でき、撤去は登録内容を残す", () => {
    const { tickets } = setup();
    const panel = tickets.upsertPanel({ id: "lifecycle", name: "ライフサイクル受付", title: "受付", description: "説明", buttonLabel: "送る", notifyRoleIds: ["notify"], staffRoleIds: ["staff"] }, "user:admin");
    tickets.setPanelMessage(panel.id, "channel", "message", "user:admin");
    expect(tickets.disablePanel(panel.id, "user:admin")!.enabled).toBe(false);
    expect(tickets.enablePanel(panel.id, "user:admin")!.enabled).toBe(true);
    const cleared = tickets.clearPanelMessage(panel.id, "user:admin", "test uninstall")!;
    expect(cleared.channelId).toBeNull();
    expect(cleared.messageId).toBeNull();
    expect(cleared.name).toBe("ライフサイクル受付");
    expect(cleared.staffRoleIds).toEqual(["staff"]);
  });

  it("利用履歴のない独自受付は完全削除する", () => {
    const { tickets } = setup();
    tickets.upsertPanel({ id: "unused_panel", name: "未使用", title: "未使用", description: "未使用", buttonLabel: "送る" }, "user:admin");
    const result = tickets.removePanelRegistration("unused_panel", "user:admin")!;
    expect(result.mode).toBe("deleted");
    expect(result.totalTickets).toBe(0);
    expect(tickets.getPanel("unused_panel")).toBeUndefined();
  });

  it("利用履歴のある受付はアーカイブし、未完了チケットを変更しない", () => {
    const { tickets } = setup();
    const panel = tickets.upsertPanel({ id: "used_panel", name: "使用済み", title: "使用済み", description: "使用済み", buttonLabel: "送る" }, "user:admin");
    tickets.setPanelMessage(panel.id, "channel", "message", "user:admin");
    tickets.create("thread_used", "alice", panel.id, panel);
    const result = tickets.removePanelRegistration(panel.id, "user:admin")!;
    expect(result.mode).toBe("archived");
    expect(result.totalTickets).toBe(1);
    expect(result.activeTickets).toBe(1);
    expect(tickets.get("thread_used")!.status).toBe("open");
    expect(tickets.getPanel(panel.id)!.archivedAt).not.toBeNull();
    expect(tickets.getPanel(panel.id)!.enabled).toBe(false);
    expect(tickets.getPanel(panel.id)!.channelId).toBeNull();
    expect(tickets.listPanels().map((item) => item.id)).not.toContain(panel.id);
    expect(tickets.listPanels(true, true).map((item) => item.id)).toContain(panel.id);
    expect(tickets.setPanelRoles(panel.id, "staff", ["new"], "user:admin")).toBeUndefined();
    expect(tickets.setPanelMessage(panel.id, "new-channel", "new-message", "user:admin")).toBeUndefined();
    expect(tickets.enablePanel(panel.id, "user:admin")).toBeUndefined();
  });

  it("旧来受付は履歴がなくても再シードを避けるためアーカイブする", () => {
    const { tickets } = setup();
    const result = tickets.removePanelRegistration("return", "user:admin")!;
    expect(result.mode).toBe("archived");
    expect(tickets.getPanel("return")!.archivedAt).not.toBeNull();
  });

  it("撤去失敗用の強制無効化を同一操作で記録する", () => {
    const { db, tickets } = setup();
    tickets.upsertPanel({ id: "unsafe_orphan", name: "残存対策", title: "残存対策", description: "残存対策", buttonLabel: "送る" }, "user:admin");
    tickets.setPanelMessage("unsafe_orphan", "channel", "message", "user:admin");
    const panel = tickets.clearPanelMessage("unsafe_orphan", "user:admin", "delete failed", true)!;
    expect(panel.enabled).toBe(false);
    expect(panel.channelId).toBeNull();
    const event = db.prepare("SELECT payload_json FROM events WHERE type = 'ticket_panel_uninstalled' ORDER BY id DESC LIMIT 1").get() as { payload_json: string };
    expect(JSON.parse(event.payload_json).forceDisabled).toBe(true);
  });
});
'''
core_test_path.write_text(core_test)

Path("apps/bot/tests/ticket-panel-lifecycle.test.ts").write_text(r'''import { describe, expect, it, vi } from "vitest";
import type { TicketPanel } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

import { removeTicketPanelRegistration, setTicketPanelEnabled, uninstallTicketPanel } from "../src/commands/admin-hub.js";

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
