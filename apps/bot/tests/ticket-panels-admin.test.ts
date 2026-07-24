import { describe, expect, it, vi } from "vitest";
import type { TicketPanel } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

import {
  disableTicketPanel,
  installTicketPanel,
  isUnknownMessageError,
  ticketPanelRolePicker,
} from "../src/commands/admin-hub.js";

const panel = (overrides: Partial<TicketPanel> = {}): TicketPanel => ({
  id: "appeal",
  name: "異議申立",
  channelId: null,
  messageId: null,
  title: "異議申立 受付",
  description: "異議申立はこちら。",
  buttonLabel: "申立する",
  buttonEmoji: "🎫",
  notifyRoleIds: [],
  staffRoleIds: [],
  enabled: true,
  createdBy: null,
  updatedBy: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function makeInteraction(channel: any, fetchChannel = vi.fn(async () => null)) {
  return {
    user: { id: "admin" },
    channel,
    client: { channels: { fetch: fetchChannel } },
    update: vi.fn(async () => undefined),
  };
}

describe("チケット受付パネル管理", () => {
  it("Unknown Message / 404 だけを既存メッセージなしとして扱う", () => {
    expect(isUnknownMessageError({ code: 10008 })).toBe(true);
    expect(isUnknownMessageError({ rawError: { code: 10008 } })).toBe(true);
    expect(isUnknownMessageError({ status: 404 })).toBe(true);
    expect(isUnknownMessageError({ code: 50013 })).toBe(false);
  });

  it("新規設置失敗時に旧パネルを削除しない", async () => {
    const oldDelete = vi.fn(async () => undefined);
    const newChannel = {
      id: "new_channel",
      isTextBased: () => true,
      send: vi.fn(async () => {
        throw new Error("send failed");
      }),
    };
    const oldChannel = {
      id: "old_channel",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ delete: oldDelete })) },
    };
    const services = {
      tickets: {
        getPanel: vi.fn(() => panel({ channelId: "old_channel", messageId: "old_message" })),
        setPanelMessage: vi.fn(),
      },
    };
    const interaction = makeInteraction(newChannel, vi.fn(async () => oldChannel));

    await installTicketPanel(interaction as any, services as any, "appeal");

    expect(newChannel.send).toHaveBeenCalledTimes(1);
    expect(services.tickets.setPanelMessage).not.toHaveBeenCalled();
    expect(oldChannel.messages.fetch).not.toHaveBeenCalled();
    expect(oldDelete).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("既存パネルは削除していません") }));
  });

  it("既存メッセージ取得の一時エラー時に重複投稿しない", async () => {
    const channel = {
      id: "same_channel",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => {
        throw { code: 50013 };
      }) },
      send: vi.fn(async () => ({ id: "new_message", pin: vi.fn(async () => undefined) })),
    };
    const services = {
      tickets: {
        getPanel: vi.fn(() => panel({ channelId: "same_channel", messageId: "old_message" })),
        setPanelMessage: vi.fn(),
      },
    };
    const interaction = makeInteraction(channel);

    await installTicketPanel(interaction as any, services as any, "appeal");

    expect(channel.send).not.toHaveBeenCalled();
    expect(services.tickets.setPanelMessage).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("重複防止") }));
  });

  it("通知ロール・対応ロールを空へ戻せるUIになっている", () => {
    const services = { tickets: { getPanel: vi.fn(() => panel()) } };
    const notify = ticketPanelRolePicker(services as any, "appeal", "notify");
    const staff = ticketPanelRolePicker(services as any, "appeal", "staff");
    const notifyJson = (notify.components![0] as any).components[0].toJSON();
    const staffJson = (staff.components![0] as any).components[0].toJSON();
    expect(notifyJson.min_values).toBe(0);
    expect(staffJson.min_values).toBe(0);
  });

  it("無効化時に既存パネルを無効表示へ更新する", async () => {
    const edit = vi.fn(async () => undefined);
    const channel = {
      id: "panel_channel",
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit })) },
    };
    const disabled = panel({ enabled: false, channelId: "panel_channel", messageId: "panel_message" });
    const services = { tickets: { disablePanel: vi.fn(() => disabled) } };
    const interaction = makeInteraction({ id: "admin_channel" }, vi.fn(async () => channel));

    await disableTicketPanel(interaction as any, services as any, "appeal");

    expect(services.tickets.disablePanel).toHaveBeenCalledWith("appeal", "user:admin");
    expect(edit).toHaveBeenCalledTimes(1);
    const payload = edit.mock.calls[0]![0];
    const row = payload.components[0].toJSON() as { components: Array<{ disabled?: boolean }> };
    expect(row.components[0]!.disabled).toBe(true);
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("無効化しました") }));
  });
});
