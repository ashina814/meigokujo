import { liabilityModelFor, type LiabilityContext } from "@meigokujo/core";
import { MAX_BET, MIN_BET } from "./common.js";

export interface GameCapacityRow {
  game: string;
  maximumReservation: number;
  users: Record<2 | 5 | 10, number>;
}
export interface HouseCapacityReport {
  minimumWorkingCapital: number;
  recommendedOpeningHouse: number;
  games: GameCapacityRow[];
}

/** PR13 operating-capital worksheet. Values are in Land and include each game's maximum reservation. */
export function houseCapacityReport(minimumWorkingCapital: number, games: string[]): HouseCapacityReport {
  const context: Omit<LiabilityContext, "bet"> = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
  const rows = games.map((game) => {
    const model = liabilityModelFor(game);
    const maximumReservation = model ? model.maxHouseLiability({ ...context, bet: MAX_BET }) : MAX_BET;
    return { game, maximumReservation, users: { 2: maximumReservation * 2, 5: maximumReservation * 5, 10: maximumReservation * 10 } };
  });
  const worstTen = Math.max(0, ...rows.map((row) => row.users[10]));
  return { minimumWorkingCapital, recommendedOpeningHouse: minimumWorkingCapital + worstTen, games: rows };
}

export const LAND_SCALE = { minBet: MIN_BET, maxBet: MAX_BET, etherFukuScale: 10 } as const;
