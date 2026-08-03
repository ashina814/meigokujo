import { describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import type { Services } from "../src/services.js";

vi.mock("../src/permissions.js", () => ({ isAdmin: () => true }));

import { handleAdminButton, handleAdminModal } from "../src/commands/admin-hub.js";

/**
 * 正式開業初期化（`opening_reset`）は R0 停止 → R1〜R11 初期化 → R12 同一トランザクション内の検算 →
 * R13 成功時のみ COMMIT → R14 open という一続きの処理（PR12）。
 * 運営卓の通常の再開導線から、全点検A〜Dが通っただけで解除できてはいけない。
 */

type StatusValue = "open" | "manual_halt" | "integrity_halt" | "recovery_halt" | "maintenance" | "opening_reset";

/** 全点検が全部通っている報告（＝通常の再開ボタンなら通ってしまう条件） */
const cleanReport = {
  ok: true,
  ledger: { ok: true, detail: "一致" },
  checks: [
    { id: "A", name: "記録と残高", ok: true, detail: "一致" },
    { id: "B", name: "チップと準備", ok: true, detail: "一致" },
    { id: "C", name: "預り", ok: true, detail: "一致" },
    { id: "D", name: "積立", ok: true, detail: "一致" },
  ],
  failed: [],
};

function fakeServices(status: StatusValue) {
  const finishOpeningReset = vi.fn(() => ({ ok: true }));
  const services = {
    casinoStatus: {
      current: () => ({ status, reason: "正式開業初期化", changedBy: "boss", changedAt: 1 }),
      reopenFromManualHalt: vi.fn(() => ({ ok: true })),
      reopenAfterIntegrity: vi.fn(() => ({ ok: true })),
      endMaintenance: vi.fn(() => ({ ok: true })),
      finishOpeningReset,
      haltForIntegrity: vi.fn(() => false),
    },
    casinoIntegrity: { runFull: () => cleanReport },
    ether: { pool: () => 0, rate: () => 1, outstanding: () => 0 },
    casino: { houseBalance: () => 0, jackpotPool: () => 0 },
    departments: { get: () => ({ name: "賭博場" }), balanceOf: () => 0 },
    chipTx: { openingLandBaseline: () => ({ poolLand: 0 }) },
  } as unknown as Services;
  return { services, finishOpeningReset };
}

function buttonInteraction(customId: string) {
  return {
    customId,
    user: { id: "boss" },
    update: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
  } as unknown as ButtonInteraction & {
    update: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
    showModal: ReturnType<typeof vi.fn>;
  };
}

function modalInteraction(customId: string, reason: string) {
  return {
    customId,
    user: { id: "boss" },
    fields: { getTextInputValue: () => reason },
    reply: vi.fn(async () => undefined),
  } as unknown as ModalSubmitInteraction & { reply: ReturnType<typeof vi.fn> };
}

/** 運営卓に出ているボタンの customId を集める */
function buttonIds(payload: any): string[] {
  return (payload?.components ?? []).flatMap((row: any) =>
    (row.components ?? []).map((c: any) => c.data?.custom_id).filter(Boolean),
  );
}

describe("運営卓から開業準備中は解除できない", () => {
  it("開業準備中は通常の再開ボタンを出さない", async () => {
    const { services } = fakeServices("opening_reset");
    const i = buttonInteraction("mgmt:casino");
    await handleAdminButton(i, services);
    expect(buttonIds(i.update.mock.calls[0][0])).not.toContain("mgmt:casino:reopen");
  });

  it("手動停止中は通常の再開ボタンを出す（出さないのが開業準備中だけであることの確認）", async () => {
    const { services } = fakeServices("manual_halt");
    const i = buttonInteraction("mgmt:casino");
    await handleAdminButton(i, services);
    expect(buttonIds(i.update.mock.calls[0][0])).toContain("mgmt:casino:reopen");
  });

  it("古いパネルの再開ボタンを開業準備中に押しても、入力欄すら出さない", async () => {
    const { services } = fakeServices("opening_reset");
    const i = buttonInteraction("mgmt:casino:reopen");
    await handleAdminButton(i, services);
    expect(i.showModal).not.toHaveBeenCalled();
    expect(i.reply.mock.calls[0][0].content).toContain("正式開業初期化");
  });

  it("全点検A〜Dが正常でも、通常の再開操作では open にならない", async () => {
    const { services, finishOpeningReset } = fakeServices("opening_reset");
    const i = modalInteraction("mgmt:casino:reopen", "全点検が通ったので開ける");
    await handleAdminModal(i, services);

    // 通常導線から正式開業初期化の完了処理は呼ばれない
    expect(finishOpeningReset).not.toHaveBeenCalled();
    expect(i.reply.mock.calls[0][0].content).toContain("❌");
    expect(i.reply.mock.calls[0][0].content).toContain("opening_reset");
  });
});

describe("古い復旧再実行ボタンは recovery_halt 以外で何もしない", () => {
  it.each(["open", "manual_halt", "maintenance", "opening_reset", "integrity_halt"] as const)(
    "%s のときは recoverCasino を起動せず拒否する",
    async (status) => {
      const { services } = fakeServices(status);
      const i = buttonInteraction("mgmt:casino:rerecover");

      await handleAdminButton(i, services);

      // この fake Services には復旧に必要な db / escrow / reservations を入れていない。
      // それでも例外にならず応答だけ返ることが、recoverCasino に入っていない証拠になる。
      expect(i.reply).toHaveBeenCalledTimes(1);
      expect(i.reply.mock.calls[0][0].content).toContain("復旧の再実行");
    },
  );
});
