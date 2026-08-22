import type { CasinoActivityKey } from "@meigokujo/core";
import type { Services } from "../services.js";

/**
 * 賭場のneutral participation正本（PR E4）への薄いbest-effort writer。
 *
 * `CasinoMetrics`（`metrics.ts`、wager/payout/net等を持つanalytics正本）とは別module
 * ——ここは`services.casinoParticipation`（`CasinoParticipationHistory`）だけを呼ぶ。
 *
 * 称号用safe historyの障害でcasino gameplay自体を失敗させてはいけない——DB write失敗は
 * warning logだけに留め、呼び出し元のgame成立処理を継続させる。呼び出し位置は必ず
 * successful funded participation commit後（house reservation/escrow hold/collectStakes
 * 等が実際に成立した後）——validation失敗・reservation失敗・escrow不足等の経路では
 * 一切呼ばない。
 */
export function recordCasinoParticipationBestEffort(
  services: Services,
  input: { participationKey: string; activityKey: CasinoActivityKey; participantUserIds: readonly string[] },
): void {
  try {
    if (!services.casinoParticipation) return;
    services.casinoParticipation.recordCommittedParticipation(input);
  } catch (error) {
    console.error("[casino-participation] record failed", error);
  }
}
