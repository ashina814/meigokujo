import { liabilityModelFor, type LiabilityContext } from "@meigokujo/core";
import { MAX_BET, MIN_BET } from "./common.js";

export interface GameCapacityRow {
  game: string;
  supported: true;
  maximumReservation: number;
  users: Record<2 | 5 | 10, number>;
}

export interface HouseCapacityReport {
  minimumWorkingCapital: number;
  complete: boolean;
  unsupportedGames: string[];
  /** モデルが全件揃った場合だけ算出する。nullは開業判断に使ってはいけない。 */
  recommendedOpeningHouse: number | null;
  games: GameCapacityRow[];
}

/**
 * PR13 operating-capital worksheet. Values are in Land.
 * 債務モデルが無いゲームを1倍と推測すると必要house額を過小評価するため、1件でも未対応なら
 * reportを不完全として推奨額を返さない。
 */
export function houseCapacityReport(minimumWorkingCapital: number, games: string[]): HouseCapacityReport {
  if (!Number.isSafeInteger(minimumWorkingCapital) || minimumWorkingCapital < 0) {
    throw new Error("invalid minimum working capital");
  }
  const context: Omit<LiabilityContext, "bet"> = {
    playerState: { winStreak: 0 },
    activeEffects: { winBonusCap: 0 },
  };
  const rows: GameCapacityRow[] = [];
  const unsupportedGames: string[] = [];
  for (const game of [...new Set(games)]) {
    const model = liabilityModelFor(game);
    if (!model) {
      unsupportedGames.push(game);
      continue;
    }
    const maximumReservation = model.maxHouseLiability({ ...context, bet: MAX_BET });
    if (!Number.isSafeInteger(maximumReservation) || maximumReservation < 0) {
      throw new Error(`invalid liability model result: ${game}`);
    }
    rows.push({
      game,
      supported: true,
      maximumReservation,
      users: {
        2: maximumReservation * 2,
        5: maximumReservation * 5,
        10: maximumReservation * 10,
      },
    });
  }
  const complete = unsupportedGames.length === 0;
  const worstTen = Math.max(0, ...rows.map((row) => row.users[10]));
  return {
    minimumWorkingCapital,
    complete,
    unsupportedGames,
    recommendedOpeningHouse: complete ? minimumWorkingCapital + worstTen : null,
    games: rows,
  };
}

export const LAND_SCALE = { minBet: MIN_BET, maxBet: MAX_BET, etherFukuScale: 10 } as const;
