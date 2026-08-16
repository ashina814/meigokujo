import { describe, expect, it, vi } from "vitest";
import { PVP_ACCEPT, PVP_CANCEL } from "../src/casino/pvp-card.js";
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
  it("accept/cancel だけを賭場ホーム配下の募集操作として認識する", () => {
    expect(isPvpCardButton(`${PVP_ACCEPT}:c1`)).toBe(true);
    expect(isPvpCardButton(`${PVP_CANCEL}:c1`)).toBe(true);
    expect(isPvpCardButton("casino:home:pvp")).toBe(false);
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

  it("停止中 gate は accept を止めるが cancel は通す", () => {
    const accept = {
      isChatInputCommand: () => false,
      customId: `${PVP_ACCEPT}:c1`,
    } as never;
    const cancel = {
      isChatInputCommand: () => false,
      customId: `${PVP_CANCEL}:c1`,
    } as never;
    expect(isCasinoInteraction(accept)).toBe(true);
    expect(isCasinoInteraction(cancel)).toBe(false);
  });
});
