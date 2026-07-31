import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import type { TicketPanel, TicketRow } from "@meigokujo/core";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => false }));

import {
  handleTicketButton,
  memberHasAnyRole,
  panelIdFromTicketButton,
  panelNotifyRoleIds,
  panelStaffRoleIds,
  openTicket,
  ticketOpenCustomId,
  ticketPanelMessageForPanel,
  ticketStaffRoleIds,
} from "../src/commands/tickets.js";

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

const ticket = (overrides: Partial<TicketRow> = {}): TicketRow => ({
  id: 1,
  thread_id: "thread1",
  user_id: "user1",
  kind: "appeal",
  status: "open",
  claimed_by: null,
  reminded_at: null,
  panel_id: "appeal",
  panel_name: "異議申立",
  panel_notify_role_ids_json: null,
  panel_staff_role_ids_json: null,
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeGuild(
  roleIds = ["staff_role"],
  memberSpecs: Array<{ id: string; roles: string[] }> = [{ id: "staff1", roles: ["staff_role"] }],
) {
  const members = new Map(
    memberSpecs.map((m) => [
      m.id,
      {
        id: m.id,
        user: { bot: false },
        roles: { cache: { has: (roleId: string) => m.roles.includes(roleId) } },
      },
    ]),
  );
  return {
    roles: {
      cache: { get: (roleId: string) => (roleIds.includes(roleId) ? { id: roleId } : undefined) },
      fetch: vi.fn(async (roleId: string) => (roleIds.includes(roleId) ? { id: roleId } : null)),
    },
    members: { fetch: vi.fn(async () => members) },
  };
}

function makeOpenTicketHarness(options: {
  panel?: TicketPanel;
  openByUserPanel?: () => TicketRow | undefined;
  deferReply?: () => Promise<void>;
  addMember?: (memberId: string) => Promise<void>;
  sendMessage?: () => Promise<void>;
  createTicket?: () => TicketRow;
} = {}) {
  const p = options.panel ?? panel({ staffRoleIds: ["staff_role"] });
  const thread = {
    id: "thread1",
    name: "🔴未対応｜異議申立-user1",
    members: {
      add: vi.fn(options.addMember ?? (async () => undefined)),
    },
    send: vi.fn(options.sendMessage ?? (async () => undefined)),
    delete: vi.fn(async () => undefined),
    setLocked: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
    setName: vi.fn(async () => undefined),
    isThread: () => true,
    toString: () => "<#thread1>",
  };
  const channel = {
    id: "panel_channel",
    type: ChannelType.GuildText,
    threads: { create: vi.fn(async () => thread) },
  };
  const services = {
    settings: { getString: vi.fn(() => undefined) },
    tickets: {
      getPanel: vi.fn(() => p),
      openByUserPanel: vi.fn(options.openByUserPanel ?? (() => undefined)),
      create: vi.fn(options.createTicket ?? (() => ticket({ thread_id: thread.id, panel_id: p.id, panel_name: p.name }))),
      rollbackCreate: vi.fn(() => ticket({ thread_id: thread.id, panel_id: p.id, panel_name: p.name })),
    },
  };
  const interaction: any = {
    user: { id: "user1", username: "user1", globalName: null },
    member: { displayName: "user1" },
    channel,
    guild: makeGuild(),
    deferred: false,
    replied: false,
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      await (options.deferReply ?? (async () => undefined))();
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
  };
  return { interaction, services, channel, thread };
}

function makeTicketButtonHarness(options: {
  customId?: string;
  currentTicket?: TicketRow;
  claimedTicket?: TicketRow;
  closedTicket?: TicketRow;
} = {}) {
  const currentTicket =
    options.currentTicket ??
    ticket({ panel_staff_role_ids_json: JSON.stringify(["staff_role"]) });
  const claimedTicket =
    options.claimedTicket ??
    ticket({
      status: "claimed",
      claimed_by: "user:staff1",
      panel_staff_role_ids_json: JSON.stringify(["staff_role"]),
    });
  const closedTicket =
    options.closedTicket ??
    ticket({
      status: "closed",
      claimed_by: "user:staff1",
      panel_staff_role_ids_json: JSON.stringify(["staff_role"]),
    });
  const controlMessage = {
    id: "control1",
    content: "📮 **異議申立** — <@user1>\n異議申立はこちら。\n\n🔴 **対応状況:** 未対応",
    edit: vi.fn(async () => undefined),
  };
  const thread = {
    id: "thread1",
    name: "🔴未対応｜異議申立-user1",
    isThread: () => true,
    setName: vi.fn(async () => undefined),
    setLocked: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
    messages: { fetch: vi.fn(async () => controlMessage) },
  };
  const services = {
    settings: { getString: vi.fn(() => undefined) },
    tickets: {
      getPanel: vi.fn(() => panel({ staffRoleIds: ["staff_role"] })),
      get: vi.fn(() => currentTicket),
      claim: vi.fn(() => claimedTicket),
      close: vi.fn(() => closedTicket),
    },
  };
  const interaction: any = {
    customId: options.customId ?? "ticket:claim",
    channelId: "thread1",
    channel: thread,
    user: { id: "staff1", username: "staff1", globalName: null },
    member: {
      displayName: "橋本",
      roles: { cache: { has: (roleId: string) => roleId === "staff_role" } },
    },
    message: { id: "control1", content: controlMessage.content, edit: vi.fn(async () => undefined) },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  };
  return { interaction, services, thread, controlMessage };
}

describe("汎用チケット受付パネル", () => {
  it("パネルIDを持つ共通ボタンを生成し、旧ボタンも解決できる", () => {
    expect(ticketOpenCustomId("appeal")).toBe("ticket:open:appeal");
    expect(panelIdFromTicketButton("ticket:open:appeal")).toBe("appeal");
    expect(panelIdFromTicketButton("ticket:return")).toBe("return");
    expect(panelIdFromTicketButton("ticket:consult")).toBe("consult");

    const msg = ticketPanelMessageForPanel(panel());
    const row = msg.components![0]!.toJSON() as { components: Array<{ custom_id: string; label: string }> };
    expect(row.components[0]!.custom_id).toBe("ticket:open:appeal");
    expect(row.components[0]!.label).toBe("申立する");
  });

  it("通知ロールと対応ロールを分離し、未設定時は旧ticket_staffへフォールバックする", () => {
    const services = { settings: { getString: (key: string) => (key === "role:ticket_staff" ? "legacy_staff" : undefined) } } as any;
    expect(panelStaffRoleIds(panel({ staffRoleIds: ["staff_a", "staff_b"] }), services)).toEqual(["staff_a", "staff_b"]);
    expect(panelStaffRoleIds(panel(), services)).toEqual(["legacy_staff"]);
    expect(panelNotifyRoleIds(panel({ notifyRoleIds: ["notify_a"] }), ["staff_a"])).toEqual(["notify_a"]);
    expect(panelNotifyRoleIds(panel(), ["staff_a"])).toEqual(["staff_a"]);
  });

  it("対応権限はチケット作成時のスナップショットを優先し、なければ現行パネル・旧設定へ落ちる", () => {
    const services = {
      settings: { getString: () => "legacy_staff" },
      tickets: { getPanel: () => panel({ staffRoleIds: ["current_staff"] }) },
    } as any;
    expect(ticketStaffRoleIds(ticket({ panel_staff_role_ids_json: JSON.stringify(["snapshot_staff"]) }), services)).toEqual([
      "snapshot_staff",
    ]);
    expect(ticketStaffRoleIds(ticket({ panel_staff_role_ids_json: "[]" }), services)).toEqual(["current_staff"]);
    expect(ticketStaffRoleIds(ticket({ panel_id: null }), services)).toEqual(["legacy_staff"]);
  });

  it("無権限者は対応・クローズ権限を満たさない", () => {
    const member = { roles: { cache: { has: (id: string) => id === "staff_a" } } } as any;
    expect(memberHasAnyRole(member, ["staff_a", "staff_b"])).toBe(true);
    expect(memberHasAnyRole(member, ["other"])).toBe(false);
    expect(memberHasAnyRole(null, ["staff_a"])).toBe(false);
  });

  it("同時に2回作成処理が走ってもチケット・スレッドは1件だけになる", async () => {
    const gate = deferred();
    const first = makeOpenTicketHarness({ deferReply: () => gate.promise });
    const second = {
      ...first.interaction,
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };

    const p1 = openTicket(first.interaction as any, first.services as any, "appeal");
    await Promise.resolve();
    await openTicket(second as any, first.services as any, "appeal");
    expect(second.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("受付処理中") }));
    expect(first.channel.threads.create).not.toHaveBeenCalled();

    gate.resolve();
    await p1;
    expect(first.channel.threads.create).toHaveBeenCalledTimes(1);
    expect(first.services.tickets.create).toHaveBeenCalledTimes(1);
  });

  it("新規チケットを未対応表示で作成する", async () => {
    const h = makeOpenTicketHarness();
    await openTicket(h.interaction as any, h.services as any, "appeal");

    expect(h.channel.threads.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringContaining("未対応") }),
    );
    expect(h.thread.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("🔴 **対応状況:** 未対応") }),
    );
  });

  it("申請者本人しか担当ロールにいない場合はチケットを作成しない", async () => {
    const h = makeOpenTicketHarness();
    h.interaction.guild = makeGuild(["staff_role"], [{ id: "user1", roles: ["staff_role"] }]) as any;

    await openTicket(h.interaction as any, h.services as any, "appeal");

    expect(h.channel.threads.create).not.toHaveBeenCalled();
    expect(h.services.tickets.create).not.toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("申請者以外") }));
  });

  it("担当者追加が全件失敗した場合はDB登録せず、作成済みスレッドを削除する", async () => {
    const h = makeOpenTicketHarness({
      addMember: async (memberId) => {
        if (memberId !== "user1") throw new Error("cannot add staff");
      },
    });
    await openTicket(h.interaction as any, h.services as any, "appeal");

    expect(h.services.tickets.create).not.toHaveBeenCalled();
    expect(h.thread.send).not.toHaveBeenCalled();
    expect(h.thread.delete).toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("受付を中止") }));
  });

  it("一部担当者のみ追加失敗した場合は警告付きで作成継続する", async () => {
    const h = makeOpenTicketHarness({
      panel: panel({ staffRoleIds: ["staff_role"] }),
      addMember: async (memberId) => {
        if (memberId === "staff2") throw new Error("cannot add staff2");
      },
    });
    h.interaction.guild = makeGuild(["staff_role"], [
      { id: "staff1", roles: ["staff_role"] },
      { id: "staff2", roles: ["staff_role"] },
    ]) as any;

    await openTicket(h.interaction as any, h.services as any, "appeal");

    expect(h.services.tickets.create).toHaveBeenCalledTimes(1);
    expect(h.thread.delete).not.toHaveBeenCalled();
    expect(h.thread.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("一部担当者") }));
  });

  it("初期メッセージ送信失敗時はDB登録を巻き戻し、作成済みスレッドを削除する", async () => {
    const h = makeOpenTicketHarness({
      sendMessage: async () => {
        throw new Error("send failed");
      },
    });

    await openTicket(h.interaction as any, h.services as any, "appeal");

    expect(h.services.tickets.create).toHaveBeenCalledTimes(1);
    expect(h.services.tickets.rollbackCreate).toHaveBeenCalledWith("thread1", "user:user1", "ticket initialization failed");
    expect(h.thread.delete).toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("作成されていません") }));
  });

  it("DB競合で作成に負けた場合は失敗扱いせず、既存チケットへ案内する", async () => {
    const raced = ticket({ thread_id: "thread-other", panel_name: "異議申立" });
    let lookupCount = 0;
    const h = makeOpenTicketHarness({
      openByUserPanel: () => {
        lookupCount += 1;
        return lookupCount >= 3 ? raced : undefined;
      },
      createTicket: () => {
        throw new Error("UNIQUE constraint failed: tickets.user_id, tickets.panel_id");
      },
    });

    await openTicket(h.interaction as any, h.services as any, "appeal");

    expect(h.thread.delete).toHaveBeenCalled();
    expect(h.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/受付は既に完了.*<#thread-other>/) }),
    );
  });
});

describe("チケット対応UI", () => {
  it("最初の担当者だけを登録し、ボタン・表示・スレッド名を対応中へ更新する", async () => {
    const h = makeTicketButtonHarness();

    await handleTicketButton(h.interaction as any, h.services as any);

    expect(h.services.tickets.claim).toHaveBeenCalledWith("thread1", "user:staff1");
    const payload = h.interaction.update.mock.calls[0]![0];
    expect(payload.content).toContain("<@staff1> が対応中");
    const row = payload.components[0].toJSON() as {
      components: Array<{ label: string; disabled: boolean }>;
    };
    expect(row.components[0]).toMatchObject({ label: "対応済み", disabled: true });
    expect(h.thread.setName).toHaveBeenCalledWith(expect.stringContaining("橋本対応中"), "チケット対応開始");
  });

  it("既に担当者がいる場合は上書きせず、現在の担当者を案内する", async () => {
    const h = makeTicketButtonHarness({
      currentTicket: ticket({
        status: "claimed",
        claimed_by: "user:staff2",
        panel_staff_role_ids_json: JSON.stringify(["staff_role"]),
      }),
    });

    await handleTicketButton(h.interaction as any, h.services as any);

    expect(h.services.tickets.claim).not.toHaveBeenCalled();
    expect(h.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<@staff2> が対応中") }),
    );
    expect(h.interaction.update).not.toHaveBeenCalled();
  });

  it("クローズは即実行せず、本人だけに確認ボタンを表示する", async () => {
    const h = makeTicketButtonHarness({ customId: "ticket:close" });

    await handleTicketButton(h.interaction as any, h.services as any);

    expect(h.services.tickets.close).not.toHaveBeenCalled();
    const payload = h.interaction.reply.mock.calls[0]![0];
    expect(payload.content).toContain("クローズしますか");
    const row = payload.components[0].toJSON() as { components: Array<{ custom_id: string }> };
    expect(row.components.map((component) => component.custom_id)).toEqual([
      "ticket:close-confirm:control1",
      "ticket:close-cancel",
    ]);
  });

  it("確認後に受付メッセージとスレッド名を完了へ更新してからロックする", async () => {
    const h = makeTicketButtonHarness({
      customId: "ticket:close-confirm:control1",
      currentTicket: ticket({
        status: "claimed",
        claimed_by: "user:staff1",
        panel_staff_role_ids_json: JSON.stringify(["staff_role"]),
      }),
    });

    await handleTicketButton(h.interaction as any, h.services as any);

    expect(h.services.tickets.close).toHaveBeenCalledWith("thread1", "user:staff1");
    expect(h.thread.messages.fetch).toHaveBeenCalledWith("control1");
    expect(h.controlMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("がクローズ") }),
    );
    expect(h.thread.setName).toHaveBeenCalledWith(expect.stringContaining("完了"), "チケット完了");
    expect(h.interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("クローズしました"), components: [] }),
    );
    expect(h.thread.setLocked).toHaveBeenCalledWith(true, "チケット完了");
    expect(h.thread.setArchived).toHaveBeenCalledWith(true, "チケット完了");
  });

  it("クローズ確認をキャンセルできる", async () => {
    const h = makeTicketButtonHarness({ customId: "ticket:close-cancel" });

    await handleTicketButton(h.interaction as any, h.services as any);

    expect(h.services.tickets.close).not.toHaveBeenCalled();
    expect(h.interaction.update).toHaveBeenCalledWith({ content: "クローズをキャンセルしました。", components: [] });
  });
});
