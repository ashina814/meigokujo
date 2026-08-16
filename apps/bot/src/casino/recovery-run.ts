import { recoverCasino, type RecoverCasinoResult } from "@meigokujo/core";
import type { Services } from "../services.js";

/**
 * 起動時・運営操作からの賭場復旧（正本 §8.2 S1〜S12）。
 *
 * 順位卓の廃止で S11（永続卓のメッセージ復旧）は対象が無くなったため、
 * 復旧は同期の {@link recoverCasino} だけで閉じる。S1〜S12 の順序は core 側が持つ。
 */
export function runCasinoRecovery(services: Services): RecoverCasinoResult {
  const result = recoverCasino({
    db: services.db,
    status: services.casinoStatus,
    integrity: services.casinoIntegrity,
    chipTx: services.chipTx,
    escrow: services.escrow,
    reservations: services.reservations,
    registry: services.recoveryRegistry,
    events: services.events,
    chipFlow: services.chipFlow,
  });
  logCasinoRecovery(result);
  return result;
}

export function logCasinoRecovery(r: RecoverCasinoResult): void {
  const reservations = r.releasedReservations.released
    ? `reservations released ${r.releasedReservations.count}`
    : "reservations not released";
  const summary =
    `kept ${r.keptHolders} / refunded ${r.refundedSessions}(${r.refundedTotal.toLocaleString("ja-JP")}Ld) / ` +
    `quarantined ${r.quarantined} / mismatched ${r.mismatched.length} / refund failed ${r.failedSessions.length} / ${reservations}`;
  switch (r.outcome) {
    case "opened":
      console.log(`[casino] startup recovery completed and opened: ${summary}`);
      break;
    case "held":
    case "manual":
      console.warn(`[casino] startup recovery held: ${r.reason} / ${summary}`);
      break;
    default:
      console.error(`[casino] startup recovery stopped (${r.outcome}): ${r.reason} / ${summary}`);
      break;
  }
}
