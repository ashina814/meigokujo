import { afterEach, describe, expect, it, vi } from "vitest";
import { CHALLENGE_WINDOW_MS, getOpenChallengeForChallenger, resetChallengesForTesting } from "../src/casino/pvp-challenge.js";
import {
  PVP_AMOUNT_MODAL_PREFIX,
  PVP_BACK_CUSTOM_ID,
  PVP_CUSTOM_PREFIX,
  PVP_GAME_PREFIX,
  PVP_POST_PREFIX,
  handlePvpOpenSetupButton,
  renderPvpOpenAmountPicker,
  renderPvpOpenGameSelect,
} from "../src/casino/pvp-open-ui.js";

afterEach(() => {
  resetChallengesForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function services(opts: { balance?: number; riskMax?: number; holdings?: number; status?: string } = {}) {
  const holdAll = vi.fn();
  return {
    holdAll,
    value: {
      chipTx: { openingPhase: () => "formal" },
      casinoStatus: { current: () => ({ status: opts.status ?? "open", reason: "maintenance" }) },
      chips: { balanceOf: () => opts.balance ?? 20_000 },
      dailyRisk: {
        maxBetForPlayerLoss: () => opts.riskMax ?? 20_000,
        holdings: () => opts.holdings ?? 40_000,
      },
      escrow: { holdAll },
      settings: {
        getJson: (_key: string, fallback: unknown) => fallback,
        getString: () => undefined,
      },
    } as never,
  };
}

function allButtons(payload: { components?: unknown[] }) {
  return (payload.components ?? []).flatMap((row) => {
    const json = (row as { toJSON(): { components?: Array<{ custom_id?: string; disabled?: boolean }> } }).toJSON();
    return json.components ?? [];
  });
}

function buttonInteraction(customId: string, userId = "alice") {
  const card = {
    id: "card1",
    channelId: "ch1",
    url: "https://discord.com/channels/guild/ch1/card1",
    edit: vi.fn(async () => undefined),
  };
  const send = vi.fn(async () => card);
  const interaction = {
    id: "i1",
    customId,
    user: { id: userId, bot: false },
    channel: { send },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
  } as never;
  return { interaction, card, send };
}

describe("公開1v1のゲーム選択と金額picker", () => {
  it("公開募集対象の4ゲームだけを出し、個人用賭場ホームへの戻り口を置かない", () => {
    const ids = allButtons(renderPvpOpenGameSelect()).map((b) => b.custom_id);
    expect(ids).toEqual([
      `${PVP_GAME_PREFIX}chinchiro`,
      `${PVP_GAME_PREFIX}bj`,
      `${PVP_GAME_PREFIX}sashi`,
      `${PVP_GAME_PREFIX}indian`,
    ]);
    expect(ids).not.toContain("casino:home:back");
  });

  it("金額pickerの戻るは募集ゲーム選択だけへ戻し、個人ホームへ抜けない", async () => {
    const s = services();
    const pickerIds = allButtons(renderPvpOpenAmountPicker("alice", "chinchiro", s.value)).map((b) => b.custom_id);
    expect(pickerIds).toContain(PVP_BACK_CUSTOM_ID);
    expect(pickerIds).not.toContain("casino:home:back");

    const { interaction } = buttonInteraction(PVP_BACK_CUSTOM_ID);
    await handlePvpOpenSetupButton(interaction, s.value);

    expect(interaction.update).toHaveBeenCalledTimes(1);
    const payload = (interaction as { update: ReturnType<typeof vi.fn> }).update.mock.calls[0]?.[0] as { components?: unknown[] };
    const backIds = allButtons(payload).map((b) => b.custom_id);
    expect(backIds).toEqual([
      `${PVP_GAME_PREFIX}chinchiro`,
      `${PVP_GAME_PREFIX}bj`,
      `${PVP_GAME_PREFIX}sashi`,
      `${PVP_GAME_PREFIX}indian`,
    ]);
  });

  it("残高・日次上限を超える固定額だけをdisabledにする", () => {
    const s = services({ balance: 1_000, riskMax: 500 });
    const buttons = allButtons(renderPvpOpenAmountPicker("alice", "chinchiro", s.value));
    const byId = new Map(buttons.map((b) => [b.custom_id, b.disabled ?? false]));
    expect(byId.get(`${PVP_POST_PREFIX}chinchiro:100`)).toBe(false);
    expect(byId.get(`${PVP_POST_PREFIX}chinchiro:500`)).toBe(false);
    expect(byId.get(`${PVP_POST_PREFIX}chinchiro:2000`)).toBe(true);
    expect(byId.get(`${PVP_POST_PREFIX}chinchiro:10000`)).toBe(true);
  });

  it("所持50%を超える固定額も募集前にdisabledにする", () => {
    const s = services({ balance: 20_000, riskMax: 20_000, holdings: 4_000 });
    const buttons = allButtons(renderPvpOpenAmountPicker("alice", "chinchiro", s.value));
    const byId = new Map(buttons.map((b) => [b.custom_id, b.disabled ?? false]));
    expect(byId.get(`${PVP_POST_PREFIX}chinchiro:500`)).toBe(false);
    expect(byId.get(`${PVP_POST_PREFIX}chinchiro:2000`)).toBe(false); // ちょうど50%は通る
    expect(byId.get(`${PVP_POST_PREFIX}chinchiro:10000`)).toBe(true);
  });

  it("自由入力はPvP専用modal IDへ繋ぐ", async () => {
    const s = services();
    const { interaction } = buttonInteraction(`${PVP_CUSTOM_PREFIX}bj`);
    await handlePvpOpenSetupButton(interaction, s.value);

    const modal = (interaction as { showModal: ReturnType<typeof vi.fn> }).showModal.mock.calls[0]?.[0] as { toJSON(): { custom_id?: string } };
    expect(modal.toJSON().custom_id).toBe(`${PVP_AMOUNT_MODAL_PREFIX}bj`);
  });
});

describe("公開募集の投稿", () => {
  it("募集カードを出しても資金を1 Ldも動かさない", async () => {
    const s = services();
    const { interaction, send } = buttonInteraction(`${PVP_POST_PREFIX}chinchiro:500`);
    await handlePvpOpenSetupButton(interaction, s.value);

    expect(send).toHaveBeenCalledTimes(1);
    expect(getOpenChallengeForChallenger("alice")?.bet).toBe(500);
    expect(s.holdAll).not.toHaveBeenCalled();
  });

  it("同じ挑戦者の2件目は公開せず、既存募集を維持する", async () => {
    const s = services();
    const first = buttonInteraction(`${PVP_POST_PREFIX}sashi:500`);
    await handlePvpOpenSetupButton(first.interaction, s.value);

    const second = buttonInteraction(`${PVP_POST_PREFIX}indian:500`);
    await handlePvpOpenSetupButton(second.interaction, s.value);

    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
    expect(getOpenChallengeForChallenger("alice")?.game).toBe("sashi");
  });

  it("募集成功後の確認 editReply だけ落ちても、募集を成功状態のまま維持する", async () => {
    const s = services();
    const { interaction, send } = buttonInteraction(`${PVP_POST_PREFIX}chinchiro:500`);
    interaction.editReply = vi.fn(async () => {
      throw new Error("Unknown interaction");
    }) as never;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(handlePvpOpenSetupButton(interaction, s.value)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(getOpenChallengeForChallenger("alice")?.state).toBe("open");
    expect(errorLog).toHaveBeenCalledWith("[pvp] 募集開始後の確認表示に失敗:", expect.any(Error));
  });

  it("3分経過で募集を終端表示にしてボタンを外す", async () => {
    vi.useFakeTimers();
    const s = services();
    const { interaction, card } = buttonInteraction(`${PVP_POST_PREFIX}bj:500`);
    await handlePvpOpenSetupButton(interaction, s.value);

    vi.advanceTimersByTime(CHALLENGE_WINDOW_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(getOpenChallengeForChallenger("alice")).toBeUndefined();
    expect(card.edit).toHaveBeenCalledTimes(1);
    expect(card.edit.mock.calls[0]?.[0]).toMatchObject({ components: [] });
  });
});
