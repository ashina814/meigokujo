/**
 * ClientReadyのsafety-critical ordering。
 *
 * casino recoveryはlocal DBだけで同期完了し、外部Discord APIを待つrole-family
 * startup observationより必ず先に実行する。role coverage自体は後者のfull member
 * fetch完了時刻から始まるため、F3aのUNKNOWN-gap semanticsは変えない。
 */
export async function runCasinoRecoveryBeforeRoleFamilyTracking(
  runCasinoRecovery: () => void,
  initializeRoleFamilyTracking: () => Promise<void>,
): Promise<void> {
  runCasinoRecovery();
  await initializeRoleFamilyTracking();
}
