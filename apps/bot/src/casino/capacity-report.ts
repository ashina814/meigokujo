import { liabilityModelFor, type LiabilityContext } from "@meigokujo/core";
import { MAX_BET, MIN_BET } from "./common.js";

export interface GameCapacityRow {
  game: string;
  maximumReservation: number;
  users: Record<2 | 5 | 10, number>;
}
export interface HouseCapacityReport {
  /** `null` = 開業設定未確定（最低運転資金が読めない）。0として計算に使わない */
  minimumWorkingCapital: number | null;
  /** `minimumWorkingCapital` が `null` のときは推奨額を計算しない（`null`） */
  recommendedOpeningHouse: number | null;
  games: GameCapacityRow[];
}

/**
 * PR13 operating-capital worksheet. Values are in Land and include each game's maximum reservation.
 *
 * PR13監査: 未知ゲーム名（タイポ・モデル未登録）を`MAX_BET`へfallbackさせず、運転資金の
 * 安全計算として推測せず即座に停止する（fail-closed）。`minimumWorkingCapital`が`null`
 * （開業設定未確定）の場合は、0として計算せず`recommendedOpeningHouse`も`null`にする。
 */
export function houseCapacityReport(minimumWorkingCapital: number | null, games: string[]): HouseCapacityReport {
  const context: Omit<LiabilityContext, "bet"> = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
  const rows = games.map((game) => {
    const model = liabilityModelFor(game);
    if (!model) throw new Error(`Unknown liability model: ${game}`);
    const maximumReservation = model.maxHouseLiability({ ...context, bet: MAX_BET });
    return { game, maximumReservation, users: { 2: maximumReservation * 2, 5: maximumReservation * 5, 10: maximumReservation * 10 } };
  });
  const worstTen = Math.max(0, ...rows.map((row) => row.users[10]));
  return {
    minimumWorkingCapital,
    recommendedOpeningHouse: minimumWorkingCapital === null ? null : minimumWorkingCapital + worstTen,
    games: rows,
  };
}

export const LAND_SCALE = { minBet: MIN_BET, maxBet: MAX_BET, etherFukuScale: 10 } as const;
