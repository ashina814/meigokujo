import { HOUSE_HOLDER, JACKPOT_HOLDER } from "@meigokujo/core";
import type { Services } from "../services.js";

/**
 * PvP ゲームの共通経済ルール。
 * - エスクロー: 両者のエテルを内部的に確保（実際は既に取ってきた bet を保持するだけ）
 * - 場代: pot（賭け合計）の 3% を胴元の JP プールへ（マモンの取り分）
 * - 勝敗確定後、pot × (1 - 場代率) を勝者へ、負けは既に徴収済み
 * - 総量保存（一時的に house に置くことでカウンタの矛盾を防ぐ）
 */
const HOUSE_CUT = 0.03;

/** 両者から bet を徴収して house 一時保管。全員から取れなかったら false（呼び出し側で全額返金） */
export function collectStakes(services: Services, userIds: string[], bet: number): boolean {
  const insufficient = userIds.find((u) => services.ether.balanceOf(u) < bet);
  if (insufficient) return false;
  for (const u of userIds) services.ether.transfer(u, HOUSE_HOLDER, bet);
  return true;
}

/** 全参加者に均等返金（勝負不成立時など） */
export function refundAll(services: Services, userIds: string[], bet: number): void {
  for (const u of userIds) services.ether.transfer(HOUSE_HOLDER, u, bet);
}

/**
 * 勝負確定: pot から場代を差し引いて勝者に分配。
 * @param winners 勝者のユーザID配列（複数なら山分け・端数は最初の1人）
 * @param pot 総賭け合計（houseに一時的にある）
 * @returns { payout: 実際に払われた総額, houseCut: 場代 }
 */
export function settlePvp(
  services: Services,
  winners: string[],
  pot: number,
): { payout: number; houseCut: number } {
  const houseCut = Math.floor(pot * HOUSE_CUT);
  const distributable = pot - houseCut;
  // 場代は JP へ（胴元の取り分＝プレイヤーに間接的に還元される）
  if (houseCut > 0) services.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, houseCut);

  if (winners.length === 0) {
    // 引き分け or 該当者なし → 場代だけ取って残りを分割対象がいないので国庫（実装的にはこのケースは呼ばれない）
    return { payout: 0, houseCut };
  }
  const share = Math.floor(distributable / winners.length);
  const remainder = distributable - share * winners.length;
  for (const w of winners) services.ether.transfer(HOUSE_HOLDER, w, share);
  if (remainder > 0) services.ether.transfer(HOUSE_HOLDER, winners[0]!, remainder);
  return { payout: distributable, houseCut };
}

/**
 * 賭け額比の按分（多人数丁半用: 勝ち側が負け側の賭けを比例分配）。
 * @param winners 勝ち側のユーザIDと bet
 * @param losers 負け側のユーザIDと bet
 */
export function settleProportional(
  services: Services,
  winners: Array<{ userId: string; bet: number }>,
  losers: Array<{ userId: string; bet: number }>,
): { totalHouseCut: number } {
  const winnerPot = winners.reduce((s, w) => s + w.bet, 0);
  const loserPot = losers.reduce((s, l) => s + l.bet, 0);
  const houseCut = Math.floor((winnerPot + loserPot) * HOUSE_CUT);
  if (houseCut > 0) services.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, houseCut);
  const distributable = winnerPot + loserPot - houseCut;

  // 勝ち側に賭け額比で分配（元本 + 負け側からの取り分）
  let remaining = distributable;
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i]!;
    const isLast = i === winners.length - 1;
    const share = isLast ? remaining : Math.floor((distributable * w.bet) / winnerPot);
    if (share > 0) services.ether.transfer(HOUSE_HOLDER, w.userId, share);
    remaining -= share;
  }
  return { totalHouseCut: houseCut };
}
