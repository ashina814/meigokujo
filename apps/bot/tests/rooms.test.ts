import { describe, expect, it, vi } from "vitest";
import { handleRoomRenameModal, roomPanelMessage } from "../src/commands/rooms.js";

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
});
