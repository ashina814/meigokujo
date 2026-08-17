import { describe, expect, it, vi } from "vitest";
import { createSoloLiquidityViews } from "../src/casino/spendable-wallet.js";

describe("solo max-loss liquidity bridge", () => {
  it("authorizeSoloStartで記録した最大損失をcapacity通過後のensureFreeChipsへ引き継ぐ", () => {
    const dailyRisk = {
      authorizeSoloStart: vi.fn(() => undefined),
      holdings: vi.fn(() => 100_000),
    } as never;
    const chipFlow = {
      ensureFreeChips: vi.fn((_userId: string, required: number) => ({
        required,
        freeBefore: 0,
        deposited: required,
        freeAfter: required,
      })),
      leaveCasino: vi.fn(),
    } as never;
    const views = createSoloLiquidityViews(dailyRisk, chipFlow);

    views.dailyRisk.authorizeSoloStart({
      userId: "alice",
      operationId: "interaction1",
      game: "ホールデム",
      bet: 1_000,
      maxPlayerLoss: 5_000,
    });
    const result = views.chipFlow.ensureFreeChips("alice", 1_000, "interaction1");

    expect(chipFlow.ensureFreeChips).toHaveBeenCalledWith("alice", 5_000, "interaction1");
    expect(result.freeAfter).toBe(5_000);
  });

  it("BJのダブルぶんも開始時に2倍まで裏付ける", () => {
    const dailyRisk = { authorizeSoloStart: vi.fn(() => undefined) } as never;
    const chipFlow = {
      ensureFreeChips: vi.fn((_userId: string, required: number) => ({
        required,
        freeBefore: 500,
        deposited: required - 500,
        freeAfter: required,
      })),
    } as never;
    const views = createSoloLiquidityViews(dailyRisk, chipFlow);

    views.dailyRisk.authorizeSoloStart({
      userId: "alice",
      operationId: "bj1",
      game: "ブラックジャック",
      bet: 500,
      maxPlayerLoss: 1_000,
    });
    views.chipFlow.ensureFreeChips("alice", 500, "bj1");

    expect(chipFlow.ensureFreeChips).toHaveBeenCalledWith("alice", 1_000, "bj1");
  });

  it("別operationやソロ以外のensureFreeChipsは要求額を勝手に増やさない", () => {
    const dailyRisk = { authorizeSoloStart: vi.fn(() => undefined) } as never;
    const chipFlow = {
      ensureFreeChips: vi.fn((_userId: string, required: number) => ({
        required,
        freeBefore: 0,
        deposited: required,
        freeAfter: required,
      })),
    } as never;
    const views = createSoloLiquidityViews(dailyRisk, chipFlow);

    views.dailyRisk.authorizeSoloStart({
      userId: "alice",
      operationId: "solo-op",
      game: "ホールデム",
      bet: 1_000,
      maxPlayerLoss: 5_000,
    });
    views.chipFlow.ensureFreeChips("alice", 700, "shop-op");

    expect(chipFlow.ensureFreeChips).toHaveBeenLastCalledWith("alice", 700, "shop-op");
  });

  it("authorizeSoloStartが失敗した操作には流動性目標を残さない", () => {
    const dailyRisk = {
      authorizeSoloStart: vi.fn(() => {
        throw new Error("risk rejected");
      }),
    } as never;
    const chipFlow = { ensureFreeChips: vi.fn() } as never;
    const views = createSoloLiquidityViews(dailyRisk, chipFlow);

    expect(() =>
      views.dailyRisk.authorizeSoloStart({
        userId: "alice",
        operationId: "denied",
        game: "ホールデム",
        bet: 1_000,
        maxPlayerLoss: 5_000,
      }),
    ).toThrow("risk rejected");
    expect(chipFlow.ensureFreeChips).not.toHaveBeenCalled();
  });

  it("一度consumeした目標は別operationの後続ensureへ漏れない", () => {
    const dailyRisk = { authorizeSoloStart: vi.fn(() => undefined) } as never;
    const chipFlow = {
      ensureFreeChips: vi.fn((_userId: string, required: number) => ({
        required,
        freeBefore: 0,
        deposited: required,
        freeAfter: required,
      })),
    } as never;
    const views = createSoloLiquidityViews(dailyRisk, chipFlow);

    views.dailyRisk.authorizeSoloStart({
      userId: "alice",
      operationId: "once",
      game: "ホールデム",
      bet: 1_000,
      maxPlayerLoss: 5_000,
    });
    views.chipFlow.ensureFreeChips("alice", 1_000, "once");
    views.chipFlow.ensureFreeChips("alice", 500, "later");

    expect(chipFlow.ensureFreeChips).toHaveBeenNthCalledWith(1, "alice", 5_000, "once");
    expect(chipFlow.ensureFreeChips).toHaveBeenNthCalledWith(2, "alice", 500, "later");
  });
});
