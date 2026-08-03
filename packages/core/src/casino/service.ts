import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { ChipLedgerError as EtherError, ChipLedger, HOUSE_HOLDER } from "./chip-ledger.js";
import { ChipTxError } from "./chip-tx.js";
import type { Items } from "./items.js";
import type { HouseReservations } from "./reservations.js";

/**
 * マモンの賭場の共通土台。
 * - 賭け/配当はチップ残高の移動のみ（Land 台帳は動かない・総量保存）
 * - 胴元(house)が全ゲームの相手方。配当可能額 = 胴元残高（テーブルリミット）
 * - 胴元の元手・売上は ChipLedger 経由で賭博場の部署口座と往復する
 * - 戦績は casino_stats に集計（通行証・賭場番付の材料）
 * - ジャックポットは専用保有者(jackpot)に積む
 */
export const JACKPOT_HOLDER = "jackpot";
/** 救済プール（福の重みの半分が入る。デイリー福分けの原資） */
export const RELIEF_HOLDER = "relief";

export const CHAIN_TIERS: ReadonlyArray<{ min: number; mult: number; label: string }> = [
  { min: 1, mult: 1.0, label: "" },
  { min: 2, mult: 1.05, label: "🔥" },
  { min: 3, mult: 1.1, label: "🔥" },
  { min: 5, mult: 1.2, label: "🔥🔥" },
  { min: 7, mult: 1.35, label: "🔥🔥" },
  { min: 10, mult: 1.5, label: "🔥🔥🔥" },
  { min: 15, mult: 1.75, label: "✦🔥🔥🔥" },
  { min: 20, mult: 2.0, label: "✦✦🔥🔥🔥" },
];

export function chainMultiplier(streak: number): { mult: number; label: string } {
  let mult = 1.0;
  let label = "";
  for (const tier of CHAIN_TIERS) {
    if (streak >= tier.min) {
      mult = tier.mult;
      label = tier.label;
    }
  }
  return { mult, label };
}

export function fukuRate(balance: number, scale: number): number {
  if (balance <= 10_000 * scale) return 0;
  if (balance <= 50_000 * scale) return 0.05;
  if (balance <= 100_000 * scale) return 0.1;
  if (balance <= 300_000 * scale) return 0.2;
  return 0.3;
}

export interface CasinoStatsRow {
  user_id: string;
  games: number;
  wins: number;
  losses: number;
  total_wagered: number;
  total_earned: number;
  total_lost: number;
  biggest_win: number;
  current_win_streak: number;
  best_win_streak: number;
  current_lose_streak: number;
  updated_at: number;
}

export function soloGroupKey(game: string, userId: string, operationId: string): string {
  return `solo:${game}:${userId}:${operationId}`;
}

/**
 * すでに最大損失を預けてあるソロゲームの徴収元。
 * `heldAmount`全額がholderにあり、`chargedAmount`だけをhouseへ移し、残りを利用者へ返す。
 */
export interface PreheldSoloWager {
  holderId: string;
  heldAmount: number;
  chargedAmount: number;
  sessionId: string;
}

export interface SettleOptions {
  operationId: string;
  chain?: boolean;
  fuku?: boolean;
  reservationKey?: string;
  preheld?: PreheldSoloWager;
}

export interface SettleResult {
  wagered: number;
  payout: number;
  net: number;
  chainBonus: number;
  chainStreak: number;
  chainMult: number;
  chainLabel: string;
  fukuTax: number;
  fukuRate: number;
  jackpotContributed: number;
  jackpotUnfunded: number;
}

export interface CasinoOptions {
  fukuScale?: number | (() => number);
  items?: Items;
  reservations?: HouseReservations;
}

export interface SoloRoundResult extends SettleResult {
  rawPayout: number;
  amuletNote?: string;
}

export interface SoloRoundOptions extends SettleOptions {
  jackpotCut?: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class Casino {
  private readonly fukuScaleOpt: number | (() => number);
  private readonly items?: Items;
  private readonly reservations?: HouseReservations;

  constructor(
    private readonly db: Database.Database,
    readonly ether: ChipLedger,
    private readonly events: EventLog,
    options: CasinoOptions = {},
  ) {
    this.fukuScaleOpt = options.fukuScale ?? 10;
    this.items = options.items;
    this.reservations = options.reservations;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_stats (
        user_id             TEXT PRIMARY KEY,
        games               INTEGER NOT NULL DEFAULT 0,
        wins                INTEGER NOT NULL DEFAULT 0,
        losses              INTEGER NOT NULL DEFAULT 0,
        total_wagered       INTEGER NOT NULL DEFAULT 0,
        total_earned        INTEGER NOT NULL DEFAULT 0,
        total_lost          INTEGER NOT NULL DEFAULT 0,
        biggest_win         INTEGER NOT NULL DEFAULT 0,
        current_win_streak  INTEGER NOT NULL DEFAULT 0,
        best_win_streak     INTEGER NOT NULL DEFAULT 0,
        current_lose_streak INTEGER NOT NULL DEFAULT 0,
        updated_at          INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(casino_stats)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "total_lost")) {
      this.db.exec("ALTER TABLE casino_stats ADD COLUMN total_lost INTEGER NOT NULL DEFAULT 0");
    }
  }

  houseBalance(): number {
    return this.ether.balanceOf(HOUSE_HOLDER);
  }

  jackpotPool(): number {
    return this.ether.balanceOf(JACKPOT_HOLDER);
  }

  canAccept(maxPayout: number): boolean {
    return this.availableForLiability() >= maxPayout;
  }

  availableForLiability(): number {
    return this.reservations ? this.reservations.available() : this.houseBalance();
  }

  private fukuScale(): number {
    const value = typeof this.fukuScaleOpt === "function" ? this.fukuScaleOpt() : this.fukuScaleOpt;
    return Number.isFinite(value) && value > 0 ? value : 10;
  }

  settle(
    userId: string,
    game: string,
    bet: number,
    payout: number,
    jackpotCut = 0,
    opts: SettleOptions,
  ): SettleResult {
    if (!Number.isInteger(bet) || bet <= 0) throw new EtherError("ERR_BAD_AMOUNT", { bet });
    if (!Number.isInteger(payout) || payout < 0) throw new EtherError("ERR_BAD_AMOUNT", { payout });

    const useChain = opts.chain ?? true;
    const useFuku = opts.fuku ?? true;
    const charge = opts.preheld?.chargedAmount ?? bet;
    if (!Number.isSafeInteger(charge) || charge < bet) {
      throw new EtherError("ERR_BAD_AMOUNT", { charge, bet });
    }
    if (opts.preheld) {
      const preheld = opts.preheld;
      if (
        !preheld.holderId
        || !preheld.sessionId
        || !Number.isSafeInteger(preheld.heldAmount)
        || preheld.heldAmount < charge
        || this.ether.balanceOf(preheld.holderId) !== preheld.heldAmount
      ) {
        throw new Error("preheld solo wager mismatch");
      }
    }

    const move = { game, sessionId: opts.preheld?.sessionId ?? null };
    const groupKey = soloGroupKey(game, userId, opts.operationId);
    return this.ether.runGroup({ groupKey, kind: "solo_game", actorId: userId }, (): SettleResult => {
      if (opts.preheld) {
        this.ether.transfer(opts.preheld.holderId, HOUSE_HOLDER, charge, {
          ...move,
          reason: charge === bet ? "賭け金" : "賭け金（倍付け損失を含む）",
        });
        const refund = opts.preheld.heldAmount - charge;
        if (refund > 0) {
          this.ether.transfer(opts.preheld.holderId, userId, refund, {
            ...move,
            reason: "事前預託残額返還",
          });
        }
      } else {
        this.ether.transfer(userId, HOUSE_HOLDER, bet, { ...move, reason: "賭け金" });
      }

      if (payout > 0) {
        this.ether.transfer(HOUSE_HOLDER, userId, payout, { ...move, reason: "配当" });
      }

      const won = payout > bet;
      let chainBonus = 0;
      let chainStreak = 0;
      let chainMult = 1.0;
      let chainLabel = "";
      if (won && useChain) {
        chainStreak = this.stats(userId).current_win_streak + 1;
        const chain = chainMultiplier(chainStreak);
        chainMult = chain.mult;
        chainLabel = chain.label;
        chainBonus = Math.min(
          Math.floor(payout * (chain.mult - 1)),
          this.ether.balanceOf(HOUSE_HOLDER),
        );
        if (chainBonus > 0) {
          this.ether.transfer(HOUSE_HOLDER, userId, chainBonus, { ...move, reason: "連鎖ボーナス" });
        }
      }

      let fukuTax = 0;
      let rate = 0;
      if (won && useFuku) {
        rate = fukuRate(this.ether.balanceOf(userId), this.fukuScale());
        fukuTax = Math.floor((payout - bet + chainBonus) * rate);
        if (fukuTax > 0) {
          const half = Math.floor(fukuTax / 2);
          if (half > 0) {
            this.ether.transfer(userId, JACKPOT_HOLDER, half, { ...move, reason: "福の重み（JP積立）" });
          }
          if (fukuTax - half > 0) {
            this.ether.transfer(userId, RELIEF_HOLDER, fukuTax - half, {
              ...move,
              reason: "福の重み（救済積立）",
            });
          }
        }
      }

      let jackpotContributed = 0;
      let jackpotUnfunded = 0;
      if (jackpotCut > 0) {
        if (this.ether.balanceOf(HOUSE_HOLDER) >= jackpotCut) {
          this.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, jackpotCut, { ...move, reason: "JP積立" });
          jackpotContributed = jackpotCut;
        } else {
          jackpotUnfunded = jackpotCut;
          this.events.log("casino_house_insufficient", {
            actor: userId,
            payload: {
              game,
              kind: "jackpot_contribution",
              wanted: jackpotCut,
              houseBalance: this.ether.balanceOf(HOUSE_HOLDER),
            },
          });
        }
      }

      if (opts.reservationKey) this.reservations?.release(opts.reservationKey);
      const effectivePayout = payout + chainBonus - fukuTax;
      const net = effectivePayout - charge;
      this.recordResult(userId, bet, effectivePayout, charge);
      this.events.log("casino_game", {
        actor: userId,
        payload: {
          game,
          bet,
          charged: charge,
          payout: effectivePayout,
          net,
          chainBonus,
          fukuTax,
          preheld: Boolean(opts.preheld),
        },
      });
      return {
        wagered: bet,
        payout: effectivePayout,
        net,
        chainBonus,
        chainStreak,
        chainMult,
        chainLabel,
        fukuTax,
        fukuRate: rate,
        jackpotContributed,
        jackpotUnfunded,
      };
    });
  }

  settleSolo(
    userId: string,
    game: string,
    bet: number,
    rawPayout: number,
    opts: SoloRoundOptions,
  ): SoloRoundResult {
    const groupKey = soloGroupKey(game, userId, opts.operationId);
    return this.ether.runGroup({ groupKey, kind: "solo_game", actorId: userId }, (): SoloRoundResult => {
      const amulet = this.consumeAmulets(userId, bet, rawPayout);
      const settled = this.settle(userId, game, bet, amulet.payout, opts.jackpotCut ?? 0, opts);
      return { ...settled, rawPayout, ...(amulet.note ? { amuletNote: amulet.note } : {}) };
    });
  }

  consumeAmulets(userId: string, bet: number, rawPayout: number): { payout: number; note?: string } {
    if (!this.ether.chipTx.isActive()) {
      throw new ChipTxError("ERR_NO_GROUP", {
        reason: "お守りの消費はグループの中で行う",
        userId,
      });
    }
    const items = this.items;
    if (!items) return { payout: rawPayout };
    if (rawPayout > bet) {
      const bonus = items.consumeWinBonus(userId, rawPayout, bet);
      return bonus.bonus > 0
        ? { payout: rawPayout + bonus.bonus, note: bonus.note }
        : { payout: rawPayout };
    }
    if (rawPayout < bet) {
      const protection = items.consumeLossProtection(userId, bet);
      if (protection.refund > 0) return { payout: protection.refund, note: protection.note };
    }
    return { payout: rawPayout };
  }

  seizeJackpot(userId: string, game: string, operationId: string, share = 1): number {
    const key = `jackpot:${game}:${userId}:${operationId}`;
    return this.ether.runGroup({ groupKey: key, kind: "solo_game", actorId: userId }, (): number => {
      const pool = this.jackpotPool();
      const amount = Math.floor(pool * Math.min(1, Math.max(0, share)));
      if (amount <= 0) return 0;
      this.ether.transfer(JACKPOT_HOLDER, userId, amount, { game, reason: "ジャックポット当選" });
      this.recordGameNet(userId, amount, { countAsBiggestWin: true });
      this.events.log("casino_jackpot", { actor: userId, payload: { game, amount, poolBefore: pool } });
      return amount;
    });
  }

  recordGameNet(userId: string, net: number, opts: { countAsBiggestWin?: boolean } = {}): void {
    if (!Number.isFinite(net) || net === 0) return;
    const ts = now();
    this.db
      .prepare("INSERT INTO casino_stats (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
      .run(userId, ts);
    const earned = Math.max(0, Math.trunc(net));
    const lost = Math.max(0, -Math.trunc(net));
    this.db
      .prepare(
        `UPDATE casino_stats SET
           total_earned = total_earned + ?,
           total_lost = total_lost + ?,
           biggest_win = MAX(biggest_win, ?),
           updated_at = ?
         WHERE user_id = ?`,
      )
      .run(earned, lost, opts.countAsBiggestWin ? earned : 0, ts, userId);
  }

  /**
   * 戦績の勝敗判定は元のbetを使い、実現損益だけは実際の徴収額を使う。
   * これによりチンチロの倍付け負けは「1ゲーム・賭けbet・実損失2bet」として残る。
   */
  private recordResult(userId: string, bet: number, payout: number, charged = bet): void {
    const ts = now();
    this.db
      .prepare("INSERT INTO casino_stats (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
      .run(userId, ts);
    const win = payout > bet ? 1 : 0;
    const loss = payout < bet ? 1 : 0;
    const netWin = Math.max(0, payout - charged);
    const netLoss = Math.max(0, charged - payout);
    this.db
      .prepare(
        `UPDATE casino_stats SET
           games = games + 1,
           wins = wins + ?,
           losses = losses + ?,
           total_wagered = total_wagered + ?,
           total_earned = total_earned + ?,
           total_lost = total_lost + ?,
           biggest_win = MAX(biggest_win, ?),
           current_win_streak = CASE WHEN ? = 1 THEN current_win_streak + 1 WHEN ? = 1 THEN 0 ELSE current_win_streak END,
           current_lose_streak = CASE WHEN ? = 1 THEN current_lose_streak + 1 WHEN ? = 1 THEN 0 ELSE current_lose_streak END,
           updated_at = ?
         WHERE user_id = ?`,
      )
      .run(win, loss, bet, netWin, netLoss, netWin, win, loss, loss, win, ts, userId);
    this.db
      .prepare("UPDATE casino_stats SET best_win_streak = MAX(best_win_streak, current_win_streak) WHERE user_id = ?")
      .run(userId);
  }

  stats(userId: string): CasinoStatsRow {
    const row = this.db.prepare("SELECT * FROM casino_stats WHERE user_id = ?").get(userId) as
      | CasinoStatsRow
      | undefined;
    return row ?? {
      user_id: userId,
      games: 0,
      wins: 0,
      losses: 0,
      total_wagered: 0,
      total_earned: 0,
      total_lost: 0,
      biggest_win: 0,
      current_win_streak: 0,
      best_win_streak: 0,
      current_lose_streak: 0,
      updated_at: 0,
    };
  }

  top(
    metric: "balance" | "biggest_win" | "total_earned" | "total_wagered" | "best_win_streak" | "win_rate",
    limit = 10,
  ): Array<{ user_id: string; value: number; sub?: number }> {
    if (metric === "balance") {
      return this.db
        .prepare(
          `SELECT user_id, amount AS value FROM ether_balances
           WHERE user_id NOT IN (?, ?, ?) AND amount > 0
           ORDER BY amount DESC LIMIT ?`,
        )
        .all(HOUSE_HOLDER, JACKPOT_HOLDER, RELIEF_HOLDER, limit) as Array<{
          user_id: string;
          value: number;
        }>;
    }
    if (metric === "win_rate") {
      return this.db
        .prepare(
          `SELECT user_id, CAST(wins AS REAL) * 100 / games AS value, games AS sub
           FROM casino_stats WHERE games >= 10
           ORDER BY value DESC LIMIT ?`,
        )
        .all(limit) as Array<{ user_id: string; value: number; sub: number }>;
    }
    return this.db
      .prepare(`SELECT user_id, ${metric} AS value FROM casino_stats WHERE ${metric} > 0 ORDER BY value DESC LIMIT ?`)
      .all(limit) as Array<{ user_id: string; value: number }>;
  }
}
