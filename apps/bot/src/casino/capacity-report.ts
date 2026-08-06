import {
  CHAIN_TIERS,
  CONSUMABLES,
  SETTING_DEFAULTS,
  liabilityModelFor,
  type LiabilityContext,
} from "@meigokujo/core";
import { MAX_BET, MIN_BET } from "./common.js";

export interface CapacityAssumptions {
  /** 通常利用者とVIP利用者を合わせた、設定上取り得る最大賭け額 */
  maximumBet: number;
  /** 実行時のVIP賭け上限倍率 */
  vipBetCapMult: number;
  /** 最大連鎖倍率へ到達する直前の現在連勝数（次の勝ちに倍率が掛かる） */
  maximumWinStreak: number;
  /** CHAIN_TIERSから導出した最大連鎖倍率 */
  maximumChainMultiplier: number;
  /** armed_win系お守りのcap合計 */
  maximumWinBonusCap: number;
}

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
  assumptions: CapacityAssumptions;
  games: GameCapacityRow[];
}

let runtimeVipBetCapMultProvider: (() => number) | null = null;

/**
 * productionの管理導線から、現在のVIP倍率を読むproviderを接続する。
 * 読み取り専用で、設定・台帳・statusは変更しない。
 */
export function bindCapacityVipBetCapMultProvider(provider: () => number): void {
  runtimeVipBetCapMultProvider = provider;
}

function currentVipBetCapMult(): number {
  return runtimeVipBetCapMultProvider?.() ?? SETTING_DEFAULTS.vip_bet_cap_mult;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer: ${String(value)}`);
  }
  return value;
}

function checkedMultiply(value: number, multiplier: number, label: string): number {
  return requireNonNegativeSafeInteger(value * multiplier, label);
}

function checkedAdd(left: number, right: number, label: string): number {
  return requireNonNegativeSafeInteger(left + right, label);
}

function maximumChainContext(): { maximumWinStreak: number; maximumChainMultiplier: number } {
  if (CHAIN_TIERS.length === 0) throw new Error("CHAIN_TIERS is empty");
  const tier = CHAIN_TIERS.reduce((best, current) => {
    if (!Number.isSafeInteger(current.min) || current.min < 1 || !Number.isFinite(current.mult) || current.mult < 1) {
      throw new Error(`Invalid chain tier: min=${String(current.min)} mult=${String(current.mult)}`);
    }
    if (current.mult > best.mult) return current;
    if (current.mult === best.mult && current.min > best.min) return current;
    return best;
  });
  return {
    // liabilityモデルは chainMultiplier(winStreak + 1) を使う。
    maximumWinStreak: tier.min - 1,
    maximumChainMultiplier: tier.mult,
  };
}

function maximumArmedWinBonusCap(): number {
  let total = 0;
  for (const item of CONSUMABLES) {
    if (item.kind !== "armed_win") continue;
    // cap無し/0は「無制限」を意味するため、運転資金表では推測せず停止する。
    if (item.cap === undefined || !Number.isSafeInteger(item.cap) || item.cap <= 0) {
      throw new Error(`armed_win item has no finite positive cap: ${item.key}`);
    }
    total = checkedAdd(total, item.cap, "maximumWinBonusCap");
  }
  return total;
}

function maximumConfiguredBet(vipBetCapMult: number): number {
  if (!Number.isFinite(vipBetCapMult) || vipBetCapMult <= 0) {
    throw new Error(`vipBetCapMult must be finite and positive: ${String(vipBetCapMult)}`);
  }
  // configuredMaxBet()と同じくVIP側はfloorする。倍率が1未満でも通常利用者のMAX_BETを下回らせない。
  const vipMaximumBet = Math.floor(MAX_BET * vipBetCapMult);
  requireNonNegativeSafeInteger(vipMaximumBet, "vipMaximumBet");
  return Math.max(MAX_BET, vipMaximumBet);
}

/**
 * PR13 operating-capital worksheet.
 *
 * 最大予約額は「通常上限」ではなく、実際に受け付け得る最悪条件で計算する。
 * - 最大賭け額: 通常MAX_BETと現在のVIP倍率適用後の大きい方
 * - 連鎖: CHAIN_TIERSの最大倍率
 * - 勝利お守り: armed_win系の有限cap合計
 *
 * 未知ゲーム・無制限お守り・不正倍率・safe integer超過はすべてfail-closed。
 */
export function houseCapacityReport(
  minimumWorkingCapital: number | null,
  games: string[],
  vipBetCapMult: number = currentVipBetCapMult(),
): HouseCapacityReport {
  if (minimumWorkingCapital !== null) {
    requireNonNegativeSafeInteger(minimumWorkingCapital, "minimumWorkingCapital");
  }
  if (games.length === 0) throw new Error("capacity report requires at least one game");

  const maximumBet = maximumConfiguredBet(vipBetCapMult);
  const chain = maximumChainContext();
  const maximumWinBonusCap = maximumArmedWinBonusCap();
  const context: Omit<LiabilityContext, "bet"> = {
    playerState: { winStreak: chain.maximumWinStreak },
    activeEffects: { winBonusCap: maximumWinBonusCap },
  };

  const rows = games.map((game) => {
    const model = liabilityModelFor(game);
    if (!model) throw new Error(`Unknown liability model: ${game}`);
    const maximumReservation = requireNonNegativeSafeInteger(
      model.maxHouseLiability({ ...context, bet: maximumBet }),
      `${game}.maximumReservation`,
    );
    return {
      game,
      maximumReservation,
      users: {
        2: checkedMultiply(maximumReservation, 2, `${game}.users[2]`),
        5: checkedMultiply(maximumReservation, 5, `${game}.users[5]`),
        10: checkedMultiply(maximumReservation, 10, `${game}.users[10]`),
      },
    };
  });

  const worstTen = Math.max(...rows.map((row) => row.users[10]));
  return {
    minimumWorkingCapital,
    recommendedOpeningHouse:
      minimumWorkingCapital === null
        ? null
        : checkedAdd(minimumWorkingCapital, worstTen, "recommendedOpeningHouse"),
    assumptions: {
      maximumBet,
      vipBetCapMult,
      maximumWinStreak: chain.maximumWinStreak,
      maximumChainMultiplier: chain.maximumChainMultiplier,
      maximumWinBonusCap,
    },
    games: rows,
  };
}

export const LAND_SCALE = { minBet: MIN_BET, maxBet: MAX_BET, etherFukuScale: 10 } as const;
