import { describe, expect, it, vi } from "vitest";
import { PVP_ACCEPT, PVP_CANCEL } from "../src/casino/pvp-card.js";
import { PVP_CUSTOM_PREFIX, PVP_GAME_PREFIX, PVP_POST_PREFIX } from "../src/casino/pvp-open-ui.js";
import { handlePvpCardButton, isPvpCardButton } from "../src/casino/pvp-route.js";
import { isCasinoInteraction } from "../src/casino/gate.js";

function interaction(customId: string, userId = "alice", opts: { deferThrows?: boolean } = {}) {
  const order: string[] = [];
  return {
    order,
    value: {
      customId,
      user: { id: userId, bot: false },
      message: { id: "card1" },
      deferUpdate: vi.fn(async () => {
        order.push("defer");
        if (opts.deferThrows) throw new Error("Unknown interaction");
      }),
      reply: vi.fn(async () => undefined),
    } as never,
  };
}

function deps(overrides: Partial<Parameters<typeof handlePvpCardButton>[2]> = {}) {
  const order: string[] = [];
  const challenge = {
    id: "c1",
    challengerId: "alice",
    game: "chinchiro" as const,
    bet: 1_000,
    channelId: "ch1",
    state: "open" as const,
    expiresAt: Date.now() + 60_000,
  };
  return {
    order,
    value: {
      accept: vi.fn(async () => ({ ok: true as const })),
      get: vi.fn(() => challenge),
      cancel: vi.fn(() => {
        order.push("cancel");
        return { ...challenge, state: "cancelled" as const };
      }),
      closeCard: vi.fn(async () => {
        order.push("close");
      }),
      runners: {} as never,
      ...overrides,
    },
  };
}

describe("公開募集カードの route", () => {
  it("ゲーム選択からaccept/cancelまでを同じ賭場ホーム経路で認識する", () => {
    expect(isPvpCardButton("casino:home:pvp")).toBe(true);
    expect(isPvpCardButton(`${PVP_GAME_PREFIX}chinchiro`)).toBe(true);
    expect(isPvpCardButton(`${PVP_POST_PREFIX}chinchiro:500`)).toBe(true);
    expect(isPvpCardButton(`${PVP_CUSTOM_PREFIX}chinchiro`)).toBe(true);
    expect(isPvpCardButton(`${PVP_ACCEPT}:c1`)).toBe(true);
    expect(isPvpCardButton(`${PVP_CANCEL}:c1`)).toBe(true);
  });

  it("accept は challenge ID をそのまま受諾ハンドラへ渡す", async () => {
    const i = interaction(`${PVP_ACCEPT}:c1`, "bob");
    const d = deps();
    await handlePvpCardButton(i.value, {} as never, d.value as never);

    expect(d.value.accept).toHaveBeenCalledTimes(1);
    expect(d.value.accept.mock.calls[0]?.[2]).toBe("c1");
    expect(d.value.cancel).not.toHaveBeenCalled();
  });

  it("cancel は挑戦者だけ通し、状態遷移を defer より前に確定する", async () => {
    const i = interaction(`${PVP_CANCEL}:c1`);
    const d = deps();
    i.value.deferUpdate = vi.fn(async () => {
      i.order.push("defer");
    }) as never;
    d.value.cancel = vi.fn(() => {
      i.order.push("cancel");
      return {
        id: "c1", challengerId: "alice", game: "chinchiro", bet: 1_000,
        channelId: "ch1", state: "cancelled", expiresAt: Date.now(),
      } as never;
    }) as never;
    d.value.closeCard = vi.fn(async () => {
      i.order.push("close");
    }) as never;

    await handlePvpCardButton(i.value, {} as never, d.value as never);
    expect(i.order).toEqual(["cancel", "defer", "close"]);
  });

  it("他人の取消は状態を変えず本人だけに拒否する", async () => {
    const i = interaction(`${PVP_CANCEL}:c1`, "mallory");
    const d = deps();
    await handlePvpCardButton(i.value, {} as never, d.value as never);

    expect(d.value.cancel).not.toHaveBeenCalled();
    expect(d.value.closeCard).not.toHaveBeenCalled();
    expect(i.value.reply).toHaveBeenCalledTimes(1);
  });

  it("cancel 後に defer が落ちても募集を復活させずカードを閉じに行く", async () => {
    const i = interaction(`${PVP_CANCEL}:c1`, "alice", { deferThrows: true });
    const d = deps();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handlePvpCardButton(i.value, {} as never, d.value as never);
    expect(d.value.cancel).toHaveBeenCalledTimes(1);
    expect(d.value.closeCard).toHaveBeenCalledTimes(1);
  });

  it("停止中 gate は accept/post/custom を止めるが cancel と閲覧だけは通す", () => {
    const guarded = [
      `${PVP_ACCEPT}:c1`,
      `${PVP_POST_PREFIX}chinchiro:500`,
      `${PVP_CUSTOM_PREFIX}chinchiro`,
    ].map((customId) => ({ isChatInputCommand: () => false, customId }) as never);
    const unguarded = [
      `${PVP_CANCEL}:c1`,
      "casino:home:pvp",
      `${PVP_GAME_PREFIX}chinchiro`,
    ].map((customId) => ({ isChatInputCommand: () => false, customId }) as never);

    for (const item of guarded) expect(isCasinoInteraction(item)).toBe(true);
    for (const item of unguarded) expect(isCasinoInteraction(item)).toBe(false);
  });
});
