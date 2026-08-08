import type { CasinoMetricEventInput } from "@meigokujo/core";
import type { Services } from "../services.js";

export type CasinoPlaySource = "home_primary" | "amount" | "retry" | "generic" | "advanced";

export interface CasinoPlayContext {
  source: CasinoPlaySource;
}

export function casinoPlayContext(context?: Partial<CasinoPlayContext>): CasinoPlayContext {
  return { source: context?.source ?? "advanced" };
}

/**
 * discord.js の awaitMessageComponent が「collector が time で終了した」場合だけ true。
 * API failure / messageDelete / channelDelete / system exception を timeout と推測しない。
 */
export function isCollectorTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "InteractionCollectorError"
    && typeof candidate.message === "string"
    && /reason:\s*time(?:\b|$)/i.test(candidate.message);
}

export function recordCasinoMetricBestEffort(services: Services, input: CasinoMetricEventInput): void {
  try {
    if (!services.casinoMetrics) return;
    services.casinoMetrics.record(input);
  } catch (error) {
    console.error("[casino-metrics] record failed", error);
  }
}

export function recordCasinoGameStartBestEffort(
  services: Services,
  input: { userId: string; game: string; operationId: string; wager: number; source: CasinoPlaySource },
): void {
  try {
    if (!services.casinoMetrics) return;
    services.casinoMetrics.gameStart(input);
    if (input.source === "retry") services.casinoMetrics.replay(input);
  } catch (error) {
    console.error("[casino-metrics] game_start failed", error);
  }
}

export function recordCasinoGameFinishBestEffort(
  services: Services,
  input: { userId: string; game: string; operationId: string; wager: number; payout: number; net: number; source: CasinoPlaySource },
): void {
  try {
    if (!services.casinoMetrics) return;
    services.casinoMetrics.gameFinish(input);
  } catch (error) {
    console.error("[casino-metrics] game_finish failed", error);
  }
}

export function reconcileSlotsGameFinishBestEffort(services: Services, userId: string, operationId: string): void {
  try {
    if (!services.casinoMetrics) return;
    services.casinoMetrics.reconcileSlotsFinish(userId, operationId);
  } catch (error) {
    console.error("[casino-metrics] slots finish reconcile failed", error);
  }
}

export function recordCasinoGameAbandonBestEffort(
  services: Services,
  input: { userId: string; game: string; operationId: string; wager: number; source: CasinoPlaySource; reason: string },
): void {
  try {
    if (!services.casinoMetrics) return;
    services.casinoMetrics.gameAbandon(input);
  } catch (error) {
    console.error("[casino-metrics] game_abandon failed", error);
  }
}
