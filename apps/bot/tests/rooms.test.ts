import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { handleRecruitModal, handleRoomButton, handleRoomRenameModal, handleRoomVoiceUpdate, roomPanelMessage } from "../src/commands/rooms.js";
import { scanRooms } from "../src/rooms-lifecycle.js";

function servicesForPanel(overrides: Record<string, number> = {}) {
  const numbers: Record<string, number> = {
    room_slot_price: 7_000,
    room_mitsugetsu_price: 9_000,
    room_oborozuki_price: 33_000,
    room_recruit_expire_hours: 6,
    room_recruit_refund: 4_000,
    room_empty_grace_min: 2,
    room_unused_grace_min: 8,
    room_normal_max_capacity: 12,
    ...overrides,
  };
  return {
    rooms: {
      gameTiers: () => [
        [1, 1_000],
        [4, 4_000],
      ],
      panelValues: () => ({
        slotPrice: numbers.room_slot_price,
        mitsugetsuPrice: numbers.room_mitsugetsu_price,
        oborozukiPrice: numbers.room_oborozuki_price,
        gameTiers: [
          [1, 1_000],
          [4, 4_000],
        ],
        recruitExpireHours: numbers.room_recruit_expire_hours,
        recruitRefund: numbers.room_recruit_refund,
        emptyGraceMinutes: numbers.room_empty_grace_min,
        unusedGraceMinutes: numbers.room_unused_grace_min,
        loveRoomTtlHours: 12,
        normalMaxCapacity: numbers.room_normal_max_capacity,
      }),
    },
  };
}

describe("部屋Bot UI", () => {
  it("部屋パネル表示は実際の設定値から生成される", () => {
    const normal = JSON.stringify(roomPanelMessage("normal", servicesForPanel() as any));
    expect(normal).toContain("7,000 Ld");
    expect(normal).toContain("最大定員: 12人");
    expect(normal).toContain("未入室のまま 8分");
    expect(normal).toContain("全員退出後は 2分");

    const mitsu = JSON.stringify(roomPanelMessage("mitsugetsu", servicesForPanel() as any));
    expect(mitsu).toContain("9,000 Ld");
    expect(mitsu).toContain("募集期限: 6時間");
    expect(mitsu).toContain("募集失効時の返金額: 4,000 Ld");

    const game = JSON.stringify(roomPanelMessage("game", servicesForPanel() as any));
    expect(game).toContain("1時間: 1,000 Ld");
    expect(game).toContain("4時間: 4,000 Ld");
  });

  it("名前変更でDiscord setNameが失敗した場合は成功表示しない", async () => {
    const reply = vi.fn(async () => undefined);
    const setName = vi.fn(async () => {
      throw new Error("discord failed");
    });
    const services = {
      rooms: {
        get: vi.fn(() => ({
          id: 1,
          kind: "normal",
          channel_id: "vc1",
          owner_id: "owner",
          status: "open",
        })),
      },
      settings: { getString: vi.fn(() => undefined) },
    };
    const interaction = {
      customId: "room:renamemodal:1",
      user: { id: "owner" },
      member: { permissions: { has: vi.fn(() => false) }, roles: { cache: new Map() } },
      fields: { getTextInputValue: vi.fn(() => "新しい部屋") },
      guild: { channels: { fetch: vi.fn(async () => ({ setName })) } },
      reply,
    };

    await handleRoomRenameModal(interaction as any, services as any);

    expect(setName).toHaveBeenCalledWith("新しい部屋");
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("失敗") }));
    expect(JSON.stringify(reply.mock.calls[0]?.[0])).not.toContain("✅");
  });

  it("枠追加でDiscord定員反映だけ失敗した場合は未課金とは表示しない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const update = vi.fn(async () => undefined);
    const setUserLimit = vi.fn(async () => {
      throw new Error("discord failed");
    });
    const addSlot = vi.fn(() => ({
      id: 1,
      kind: "normal",
      channel_id: "vc1",
      owner_id: "owner",
      status: "open",
      capacity: 3,
    }));
    const services = {
      rooms: {
        get: vi.fn(() => ({
          id: 1,
          kind: "normal",
          channel_id: "vc1",
          owner_id: "owner",
          status: "open",
          capacity: 2,
        })),
        addSlot,
      },
      settings: { getNumber: vi.fn(() => 7000), getJson: vi.fn((_key: string, fallback: string[]) => fallback) },
    };
    const interaction = {
      customId: "room:slotpay:1:7000:2",
      isButton: () => true,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      user: { id: "payer" },
      channel: {
        type: ChannelType.GuildVoice,
        members: { has: vi.fn(() => true) },
        setUserLimit,
      },
      update,
    };

    await handleRoomButton(interaction as any, services as any);

    expect(addSlot).toHaveBeenCalledWith(1, "payer", { priceOverride: 7000 });
    expect(setUserLimit).toHaveBeenCalledWith(3);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("支払いとDB更新") }));
    expect(JSON.stringify(update.mock.calls[0]?.[0])).not.toContain("課金していません");
    expect(JSON.stringify(update.mock.calls[0]?.[0])).not.toContain("✅");
    errorSpy.mockRestore();
  });

  it("通常部屋の枠追加は実行時に無料ロールを取り直して0円で実行する", async () => {
    const update = vi.fn(async () => undefined);
    const setUserLimit = vi.fn(async () => undefined);
    const addSlot = vi.fn(() => ({
      id: 1,
      kind: "normal",
      channel_id: "vc1",
      owner_id: "owner",
      status: "open",
      capacity: 3,
    }));
    const services = {
      rooms: {
        get: vi.fn(() => ({
          id: 1,
          kind: "normal",
          channel_id: "vc1",
          owner_id: "owner",
          status: "open",
          capacity: 2,
        })),
        addSlot,
      },
      settings: {
        getNumber: vi.fn(() => 7000),
        getJson: vi.fn((key: string, fallback: string[]) => (key === "roles:room_normal_free" ? ["free-role"] : fallback)),
      },
    };
    const fetched = { id: "payer", roles: { cache: new Map([["free-role", { id: "free-role" }]]) } };
    const interaction = {
      customId: "room:slotpay:1:7000:2",
      isButton: () => true,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      user: { id: "payer" },
      guild: { members: { fetch: vi.fn(async () => fetched) } },
      channel: {
        type: ChannelType.GuildVoice,
        members: { has: vi.fn(() => true) },
        setUserLimit,
      },
      update,
    };

    await handleRoomButton(interaction as any, services as any);

    expect(addSlot).toHaveBeenCalledWith(1, "payer", { priceOverride: 0 });
    expect(JSON.stringify(update.mock.calls.at(-1)?.[0])).toContain("無料");
  });

  it("通常部屋の枠追加は確認後に無料ロールを失っていれば通常価格で実行する", async () => {
    const update = vi.fn(async () => undefined);
    const addSlot = vi.fn(() => ({ id: 1, kind: "normal", channel_id: "vc1", owner_id: "owner", status: "open", capacity: 3 }));
    const services = {
      rooms: {
        get: vi.fn(() => ({ id: 1, kind: "normal", channel_id: "vc1", owner_id: "owner", status: "open", capacity: 2 })),
        addSlot,
      },
      settings: {
        getNumber: vi.fn(() => 7000),
        getJson: vi.fn((key: string, fallback: string[]) => (key === "roles:room_normal_free" ? ["free-role"] : fallback)),
      },
    };
    const interaction = {
      customId: "room:slotpay:1:7000:2",
      isButton: () => true,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      user: { id: "payer" },
      guild: { members: { fetch: vi.fn(async () => ({ id: "payer", roles: { cache: new Map() } })) } },
      channel: {
        type: ChannelType.GuildVoice,
        members: { has: vi.fn(() => true) },
        setUserLimit: vi.fn(async () => undefined),
      },
      update,
    };

    await handleRoomButton(interaction as any, services as any);

    expect(addSlot).toHaveBeenCalledWith(1, "payer", { priceOverride: 7000 });
  });

  it("VoiceStateUpdateで部屋への人間入室を即時利用済みにする", () => {
    const markOccupancy = vi.fn();
    const services = {
      rooms: {
        byChannel: vi.fn(() => ({ id: 10, status: "open", pending_delete: 0 })),
        markOccupancy,
      },
    };

    handleRoomVoiceUpdate(
      { channelId: null, member: { user: { bot: false } } } as any,
      { channelId: "room-vc", member: { user: { bot: false } } } as any,
      services as any,
    );

    expect(services.rooms.byChannel).toHaveBeenCalledWith("room-vc");
    expect(markOccupancy).toHaveBeenCalledWith(10, true);
  });

  it("pending_delete再試行成功時にunused有料部屋の返金と通知まで実行する", async () => {
    const send = vi.fn(async () => undefined);
    const voiceDelete = vi.fn(async () => undefined);
    const room = {
      id: 20,
      kind: "game",
      channel_id: "room-vc",
      owner_id: "owner",
      status: "open",
      pending_delete: 1,
      close_reason: "unused",
    };
    const services = {
      settings: { getString: vi.fn(() => "guild-main"), getNumber: vi.fn(() => 5) },
      rooms: {
        listPendingDelete: vi.fn(() => [room]),
        get: vi.fn(() => room),
        markDeletedAndClosed: vi.fn(),
        markDeleteFailed: vi.fn(),
        refundUnusedPaidRoom: vi.fn(() => ({ refunded: 6000 })),
        listOpen: vi.fn(() => []),
        gamesNeedingWarning: vi.fn(() => []),
        expiredRooms: vi.fn(() => []),
        dueForDeletion: vi.fn(() => []),
        expireRecruits: vi.fn(() => []),
      },
    };
    const client = {
      guilds: { fetch: vi.fn(async () => ({ channels: { fetch: vi.fn() } })) },
      channels: { fetch: vi.fn(async () => ({ delete: voiceDelete })) },
      users: { fetch: vi.fn(async () => ({ send })) },
    };

    await scanRooms(client as any, services as any);

    expect(voiceDelete).toHaveBeenCalledWith("unused");
    expect(services.rooms.markDeletedAndClosed).toHaveBeenCalledWith(20, "unused");
    expect(services.rooms.refundUnusedPaidRoom).toHaveBeenCalledWith(20);
    expect(send).toHaveBeenCalledWith(expect.stringContaining("返金額: 6,000 Ld"));
  });

  it("朧月承諾後のパネル投稿失敗では返金し、削除成功時だけclosedにする", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editReply = vi.fn(async () => undefined);
    const channelDelete = vi.fn(async () => undefined);
    const room = {
      id: 30,
      kind: "oborozuki",
      channel_id: "oboro-vc",
      owner_id: "owner",
      status: "open",
      pending_delete: 0,
      expires_at: 123,
      capacity: 2,
    };
    const channel = {
      id: "oboro-vc",
      toString: () => "<#oboro-vc>",
      send: vi.fn(async () => {
        throw new Error("send failed");
      }),
      delete: channelDelete,
    };
    const guild = {
      roles: { everyone: { id: "everyone" } },
      members: {
        fetch: vi.fn(async (id: string) => ({ id, displayName: id, user: { bot: false }, send: vi.fn(), voice: {} })),
      },
      channels: {
        fetch: vi.fn(),
        create: vi.fn(async () => channel),
      },
    };
    const services = {
      settings: { getString: vi.fn(() => undefined), getNumber: vi.fn(() => 5) },
      rooms: {
        getOborozukiInviteByToken: vi.fn(() => ({
          id: 1,
          requester_id: "owner",
          target_id: "target",
          status: "pending",
          token: "token",
          price: 30000,
          expires_at: 999,
        })),
        acceptOborozukiInvite: vi.fn(() => ({ room, invite: { id: 1 } })),
        panelValues: vi.fn(() => ({
          slotPrice: 7000,
          mitsugetsuPrice: 5000,
          oborozukiPrice: 30000,
          gameTiers: [],
          recruitExpireHours: 6,
          recruitRefund: 2500,
          emptyGraceMinutes: 5,
          unusedGraceMinutes: 5,
          loveRoomTtlHours: 12,
          normalMaxCapacity: 99,
        })),
        refundUnusedPaidRoom: vi.fn(() => ({ refunded: 30000 })),
        requestDelete: vi.fn(),
        markDeletedAndClosed: vi.fn(),
        markDeleteFailed: vi.fn(),
      },
    };
    const interaction = {
      customId: "room:oboroaccept:token",
      isButton: () => true,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      user: { id: "target" },
      guild,
      client: { guilds: { fetch: vi.fn() } },
      deferUpdate: vi.fn(async () => undefined),
      editReply,
    };

    await handleRoomButton(interaction as any, services as any);

    expect(services.rooms.refundUnusedPaidRoom).toHaveBeenCalledWith(30);
    expect(services.rooms.requestDelete).toHaveBeenCalledWith(30, "panel_post_failed", "user:owner");
    expect(channelDelete).toHaveBeenCalledWith("朧月パネル投稿失敗のためロールバック");
    expect(services.rooms.markDeletedAndClosed).toHaveBeenCalledWith(30, "panel_post_failed", "user:owner");
    expect(services.rooms.markDeleteFailed).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("課金済み分は返金") }));
    expect(JSON.stringify(editReply.mock.calls.at(-1)?.[0])).not.toContain("課金していません");
    errorSpy.mockRestore();
  });

  it("蜜月作成失敗後のVC削除失敗ではpending_deleteを残しclosedにしない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editReply = vi.fn(async () => undefined);
    const channelDelete = vi.fn(async () => {
      throw new Error("delete failed");
    });
    const room = { id: 40, kind: "mitsugetsu", channel_id: "mitsu-vc", owner_id: "owner", status: "open", pending_delete: 0 };
    const panelChannel = {
      isTextBased: () => true,
      send: vi.fn(async () => {
        throw new Error("panel failed");
      }),
    };
    const owner = { id: "owner", displayName: "owner", user: { bot: false }, voice: {}, roles: { cache: new Map() } };
    const guild = {
      client: { channels: { fetch: vi.fn(async () => panelChannel) } },
      roles: { everyone: { id: "everyone" } },
      members: { fetch: vi.fn(async () => owner) },
      channels: {
        fetch: vi.fn(),
        create: vi.fn(async () => ({ id: "mitsu-vc", send: vi.fn(), delete: channelDelete })),
      },
    };
    const services = {
      ledger: { balanceOf: vi.fn(() => 100000) },
      settings: {
        getString: vi.fn((key: string) => (key === "role:male" ? "male-role" : key === "channel:recruit" ? "recruit-channel" : undefined)),
      },
      rooms: {
        priceFor: vi.fn(() => 5000),
        ownershipConflict: vi.fn(() => undefined),
        registerWithRecruit: vi.fn(() => ({ room, recruit: { id: 50, expires_at: 999 } })),
        setRecruitPanel: vi.fn(),
        refundUnusedPaidRoom: vi.fn(),
        requestDelete: vi.fn(),
        cancelRecruit: vi.fn(),
        markDeleteFailed: vi.fn(),
        markDeletedAndClosed: vi.fn(),
      },
    };
    const interaction = {
      customId: "room:recruit:male",
      user: { id: "owner" },
      guild,
      fields: { getTextInputValue: vi.fn((key: string) => (key === "purpose" ? "雑談" : "")) },
      deferReply: vi.fn(async () => undefined),
      editReply,
    };

    await handleRecruitModal(interaction as any, services as any);

    expect(services.rooms.requestDelete).toHaveBeenCalledWith(40, "recruit_cancelled", "user:owner");
    expect(channelDelete).toHaveBeenCalledWith("蜜月募集作成失敗のためロールバック");
    expect(services.rooms.markDeleteFailed).toHaveBeenCalledWith(40, expect.any(Error));
    expect(services.rooms.markDeletedAndClosed).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("募集作成に失敗") }));
    errorSpy.mockRestore();
  });
});
