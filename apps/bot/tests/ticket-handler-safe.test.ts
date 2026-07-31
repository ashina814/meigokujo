import { describe, expect, it, vi } from "vitest";
import type { TicketRow } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));

import { handleTicketButton } from "../src/commands/ticket-handler-safe.js";

function ticket(overrides: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 1,
    thread_id: "thread1",
    user_id: "user1",
    kind: "consult",
    status: "open",
    claimed_by: null,
    reminded_at: null,
    panel_id: "consult",
    panel_name: "個別相談",
    panel_notify_role_ids_json: null,
    panel_staff_role_ids_json: JSON.stringify(["staff_role"]),
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function harness(options: {
  customId: string;
  current?: TicketRow;
  close?: () => TicketRow | undefined;
  updateError?: Error;
  editReplyError?: Error;
  messageEditError?: Error;
  roleCheck?: (roleId: string) => boolean;
}) {
  const current = options.current ?? ticket();
  const controlMessage = {
    id: "control1",
    content: "📮 **個別相談** — <@user1>\n相談内容\n\n🔴 **対応状況:** 未対応",
    edit: vi.fn(async () => {
      if (options.messageEditError) throw options.messageEditError;
      return controlMessage;
    }),
  };
  const thread = {
    id: "thread1",
    name: "個別相談-user1",
    isThread: () => true,
    setName: vi.fn(async () => undefined),
    setLocked: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
    messages: { fetch: vi.fn(async () => controlMessage) },
  };
  const roleHas = vi.fn(options.roleCheck ?? ((roleId: string) => roleId === "staff_role"));
  const services = {
    settings: { getString: vi.fn(() => undefined) },
    tickets: {
      get: vi.fn(() => current),
      getPanel: vi.fn(() => undefined),
      claim: vi.fn(() => ticket({ status: "claimed", claimed_by: "user:staff1" })),
      close: vi.fn(options.close ?? (() => ticket({ status: "closed", claimed_by: "user:staff1" }))),
    },
  };
  const interaction: any = {
    customId: options.customId,
    channelId: "thread1",
    channel: thread,
    user: { id: "staff1", username: "staff1", globalName: null },
    member: {
      displayName: "橋本",
      roles: { cache: { has: roleHas } },
    },
    message: controlMessage,
    deferred: false,
    replied: false,
    deferUpdate: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    update: vi.fn(async () => {
      if (options.updateError) throw options.updateError;
      interaction.replied = true;
      return controlMessage;
    }),
    editReply: vi.fn(async () => {
      if (options.editReplyError) throw options.editReplyError;
      return controlMessage;
    }),
    reply: vi.fn(async () => {
      interaction.replied = true;
      return controlMessage;
    }),
  };
  return { interaction, services, thread, controlMessage, roleHas };
}

describe("チケット操作のDiscord応答保証", () => {
  it("クローズ確定は先にdeferし、後から確認画面を更新する", async () => {
    const h = harness({
      customId: "ticket:close-confirm:control1",
      current: ticket({ status: "claimed", claimed_by: "user:staff1" }),
    });

    await handleTicketButton(h.interaction, h.services as any);

    expect(h.interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(h.interaction.update).not.toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("クローズしました") }),
    );
    expect(h.interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      h.services.tickets.close.mock.invocationCallOrder[0]!,
    );
    expect(h.thread.setLocked).toHaveBeenCalledWith(true, "チケット完了");
    expect(h.thread.setArchived).toHaveBeenCalledWith(true, "チケット完了");
  });

  it("defer後に権限を失ってもreplyをeditReplyへ変換して拒否を返す", async () => {
    let roleChecks = 0;
    const h = harness({
      customId: "ticket:close-confirm:control1",
      current: ticket({ status: "claimed", claimed_by: "user:staff1" }),
      roleCheck: () => {
        roleChecks += 1;
        return roleChecks === 1;
      },
    });

    await handleTicketButton(h.interaction, h.services as any);

    expect(h.interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(h.interaction.reply).not.toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("対応ロールだけ") }),
    );
    expect(h.services.tickets.close).not.toHaveBeenCalled();
  });

  it("クローズ競合側の確認画面更新が失敗してもロックとアーカイブを続ける", async () => {
    let raced = false;
    const active = ticket({ status: "claimed", claimed_by: "user:staff1" });
    const closed = ticket({ status: "closed", claimed_by: "user:staff2" });
    const h = harness({
      customId: "ticket:close-confirm:control1",
      current: active,
      close: () => {
        raced = true;
        return undefined;
      },
      editReplyError: new Error("discord unavailable"),
    });
    h.services.tickets.get.mockImplementation(() => (raced ? closed : active));

    await handleTicketButton(h.interaction, h.services as any);

    expect(h.interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(h.thread.setLocked).toHaveBeenCalledWith(true, "競合後の完了チケットを修復");
    expect(h.thread.setArchived).toHaveBeenCalledWith(true, "競合後の完了チケットを修復");
  });

  it("担当登録のupdate失敗時は元メッセージを直し、本人にも応答する", async () => {
    const h = harness({ customId: "ticket:claim", updateError: new Error("interaction expired") });

    await handleTicketButton(h.interaction, h.services as any);

    expect(h.controlMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<@staff1> が対応中") }),
    );
    expect(h.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "対応者として登録し、表示を更新しました。" }),
    );
    expect(h.thread.setName).toHaveBeenCalledWith(expect.stringContaining("橋本対応中"), "チケット対応開始");
  });

  it("旧UIの対応中チケットは修復前にdeferし、表示とスレッド名を直す", async () => {
    const h = harness({
      customId: "ticket:claim",
      current: ticket({ status: "claimed", claimed_by: "user:staff1" }),
    });

    await handleTicketButton(h.interaction, h.services as any);

    expect(h.interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(h.interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      h.controlMessage.edit.mock.invocationCallOrder[0]!,
    );
    expect(h.controlMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<@staff1> が対応中") }),
    );
    const payload = h.controlMessage.edit.mock.calls[0]![0] as any;
    const row = payload.components[0].toJSON() as { components: Array<{ label: string; disabled: boolean }> };
    expect(row.components[0]).toMatchObject({ label: "対応済み", disabled: true });
    expect(h.thread.setName).toHaveBeenCalledWith(
      expect.stringContaining("橋本対応中"),
      "既存チケットの対応表示を修復",
    );
    expect(h.interaction.reply).not.toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("既に <@staff1> が対応中") }),
    );
  });
});
