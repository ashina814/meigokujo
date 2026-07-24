import { describe, expect, it, vi } from "vitest";
import type { TicketPanel } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

import { installTicketPanel } from "../src/commands/admin-hub.js";

const panel = (overrides: Partial<TicketPanel> = {}): TicketPanel => ({
  id: "appeal",
  name: "異議申立",
  channelId: "old_channel",
  messageId: "old_message",
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

function makeInteraction(channel: any, fetchChannel: (id: string) => Promise<any>) {
  return {
    user: { id: "admin" },
    channel,
    client: { channels: { fetch: vi.fn(fetchChannel) } },
    update: vi.fn(async () => undefined),
  };
}

describe("チケット受付パネル管理の最終安全策", () => {
  it("新パネル送信後にDB保存が失敗した場合は新メッセージを削除し、旧パネルを残す", async () => {
    const sent = {
      id: "new_message",
      pin: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const newChannel = {
      id: "new_channel",
      isTextBased: () => true,
      send: vi.fn(async () => sent),
    };
    const services = {
      tickets: {
        getPanel: vi.fn(() => panel()),
        setPanelMessage: vi.fn(() => {
          throw new Error("db failed");
        }),
      },
    };
    const interaction = makeInteraction(newChannel, async () => {
      throw new Error("旧チャンネルは取得しないはず");
    });

    await installTicketPanel(interaction as any, services as any, "appeal");

    expect(newChannel.send).toHaveBeenCalledTimes(1);
    expect(services.tickets.setPanelMessage).toHaveBeenCalledTimes(1);
    expect(sent.delete).toHaveBeenCalledTimes(1);
    expect(interaction.client.channels.fetch).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("設置情報の保存に失敗") }),
    );
  });

  it("移設後に旧チャンネルを取得できない場合は管理者へ警告を表示する", async () => {
    const sent = {
      id: "new_message",
      pin: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const newChannel = {
      id: "new_channel",
      isTextBased: () => true,
      send: vi.fn(async () => sent),
    };
    const services = {
      tickets: {
        getPanel: vi.fn(() => panel()),
        setPanelMessage: vi.fn(() => panel({ channelId: "new_channel", messageId: "new_message" })),
      },
    };
    const interaction = makeInteraction(newChannel, async () => {
      throw new Error("temporary fetch failure");
    });

    await installTicketPanel(interaction as any, services as any, "appeal");

    expect(sent.delete).not.toHaveBeenCalled();
    const payload = interaction.update.mock.calls.at(-1)?.[0];
    const description = payload.embeds[0].toJSON().description as string;
    expect(description).toContain("旧パネルのチャンネル取得に失敗");
    expect(description).toContain("手動確認");
  });
});
