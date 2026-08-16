import { afterEach, describe, expect, it, vi } from "vitest";
import { CHALLENGE_WINDOW_MS, getOpenChallengeForChallenger, resetChallengesForTesting } from "../src/casino/pvp-challenge.js";
import {
  PVP_AMOUNT_MODAL_PREFIX,
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

function services(opts: { balance?: number; riskMax?: number; status?: string } = {}) {
  const holdAll = vi.fn();
  return {
    holdAll,
    value: {
      chipTx: { openingPhase: () => "formal" },
      casinoStatus: { current: () => ({ status: opts.status ?? "open", reason: "maintenance" }) },
      chips: { balanceOf: () => opts.balance ?? 20_000 },
      dailyRisk: { maxBetForPlayerLoss: () => opts.riskMax ?? 20_000 },
      escrow: { holdAll },
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
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
  } as never;
  return { interaction, card, send };
}

describe("公開1v1のゲーム選択と金額picker", () => {
  it("公開募集対象の4ゲームだけを出す", () => {
    const ids = allButtons(renderPvpOpenGameSelect()).map((b) => b.custom_id);
    expect(ids).toEqual([
      `${PVP_GAME_PREFIX}chinchiro`,
      `${PVP_GAME_PREFIX}bj`,
      `${PVP_GAME_PREFIX}sashi`,
      `${PVP_GAME_PREFIX}indian`,
      "casino:home:back",
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
