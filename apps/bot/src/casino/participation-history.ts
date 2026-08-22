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

/**
 * PR F2b: そのfunded participationについて、ゲーム固有のcanonical financial
 * resolution primitive（settlement、またはゲームルール上の正常なdraw/push等の
 * 解決）が成功した直後だけ呼ぶbest-effort writer。
 *
 * `recordCasinoParticipationBestEffort()`と同じく、称号用safe historyの障害で
 * casino gameplay/settlement結果を失敗・rollbackさせてはいけない——DB write失敗は
 * warning logだけに留める。
 *
 * 呼び出し位置は必ず「そのゲームの実際のsettlement primitiveが成功directly
 * observedした直後」——Discordの最終結果embed編集の前。Promiseがresolveした・
 * runnerを呼んだ・collectStakesが成功した・mode=solo/PVPだった、だけでは
 * completionの根拠にしない。異常系のvoidPvpTable/voidKeibaRace/
 * voidRouletteTable等（refundのみ）はcompletionではないため、その経路では
 * 一切呼ばない。
 */
export function recordCasinoCompletionBestEffort(
  services: Services,
  input: { participationKey: string; activityKey: CasinoActivityKey; participantUserIds: readonly string[] },
): void {
  try {
    if (!services.casinoParticipation) return;
    services.casinoParticipation.recordCompletedParticipation(input);
  } catch (error) {
    console.error("[casino-completion] record failed", error);
  }
}
