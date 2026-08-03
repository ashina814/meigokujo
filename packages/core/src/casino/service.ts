import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherError, EtherExchange, HOUSE_HOLDER } from "./exchange.js";
import { ChipTxError } from "./chip-tx.js";
import type { Items } from "./items.js";
import type { HouseReservations } from "./reservations.js";

/**
 * マモンの賭場の共通土台。
 * - 賭け/配当はエテル残高の移動のみ（Land 台帳は動かない・総量保存）
 * - 胴元(house)が全ゲームの相手方。配当可能額 = 胴元残高（テーブルリミット）
 * - 胴元の元手・売上は EtherExchange 経由で賭博場の部署口座と往復する
 * - 戦績は casino_stats に集計（通行証・賭場番付の材料）
 * - ジャックポットは専用保有者(jackpot)に積む
 */
export const JACKPOT_HOLDER = "jackpot";
/** 救済プール（福の重みの半分が入る。デイリー福分けの原資） */
export const RELIEF_HOLDER = "relief";

/** 連鎖ボーナス（連勝チェーン）。casino-bot の CHAIN_TIERS 準拠 */
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
  for (const t of CHAIN_TIERS)
    if (streak >= t.min) {
      mult = t.mult;
      label = t.label;
    }
  return { mult, label };
}

/**
 * 福の重み（勝ち分への累進奉納率）。casino-bot 準拠のしきい値 × scale。
 * scale はエテル物価に合わせる係数（既定10 = 冥獄城レート 1Ld=10◈ 相当）。
 */
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
  /**
   * ゲーム由来の**実現利益**の総和（PR3）。
   *
   * 含む: 配当、連鎖ボーナス、福の重み（差し引く側）、フリースピン配当、JP当選、
   * 対人戦の純勝ち。
   * 含まない: VIP、賭場商店、通常の送金、胴元への元手投入・売上精算。
   * 返金・無効試合・冪等再試行では 1 Ld も増減しない。
   */
  total_earned: number;
  /**
   * ゲーム由来の**実現損失**の総和（PR3）。含む/含まないは {@link total_earned} と同じ。
   * 対人戦の場代もここに入る（負けた側の実支出なので）。
   *
   * 通算損益 = total_earned − total_lost で、その利用者の残高の増減と一致する。
   */
  total_lost: number;
  biggest_win: number;
  current_win_streak: number;
  best_win_streak: number;
  current_lose_streak: number;
  updated_at: number;
}

/**
 * ソロゲーム1回の業務グループ鍵。`Casino.settle` / `settleSolo` と
 * 胴元債務予約（PR5）が**同じ文字列**を使う（予約鍵 = 精算グループ鍵）。
 */
export function soloGroupKey(game: string, userId: string, operationId: string): string {
  return `solo:${game}:${userId}:${operationId}`;
}

export interface SettleOptions {
  /**
   * この精算を一意に指す値。**同じ操作の再試行では同じ値**を渡すこと
   * （Discordの操作ID・卓のセッションIDなど）。ランダム値を渡すと二重精算を防げない。
   */
  operationId: string;
  /** 連鎖ボーナス（既定ON。共有卓はOFF） */
  chain?: boolean;
  /** 福の重み（既定ON。共有卓はOFF） */
  fuku?: boolean;
  /**
   * 胴元債務予約の鍵（PR5）。渡すと**精算と同じトランザクションの中で解放**する。
   * 予約はゲーム開始時に取ってあり、この精算が通った時点で債務が確定するので不要になる。
   */
  reservationKey?: string;
}

export interface SettleResult {
  /** 賭け額 */
  wagered: number;
  /** 受け取った配当（0 = 負け・チェーン込み・福の重み控除後） */
  payout: number;
  /** 純損益 */
  net: number;
  /** 連鎖ボーナス（勝ち時のみ・胴元残高が上限） */
  chainBonus: number;
  /** この勝ちで何連勝目か */
  chainStreak: number;
  chainMult: number;
  chainLabel: string;
  /** 福の重みで奉納された額（半分JP・半分救済へ） */
  fukuTax: number;
  fukuRate: number;
  /** 実際に house → jackpot へ積めた額（PR4） */
  jackpotContributed: number;
  /**
   * 積むべきだったのに house の資金が足りず**積めなかった**額（PR4）。
   * 予約が正しければ 0 のまま。0 でないなら会計上の異常で、events にも残している。
   */
  jackpotUnfunded: number;
}

export interface CasinoOptions {
  /** 福の重みしきい値のスケール（既定10）。関数なら毎回評価 */
  fukuScale?: number | (() => number);
  /**
   * お守り（消耗品）。渡すと `settleSolo()` が精算と同じグループの中でお守りを消費する。
   * 渡さない場合は「お守り無し」として扱う（テスト・移植前の経路）。
   */
  items?: Items;
  /**
   * 胴元債務予約（PR5）。渡すと `settle()` が `reservationKey` を精算と同じ
   * トランザクション内で解放する。渡さない場合は予約なしとして動く（移植前の経路・テスト）。
   */
  reservations?: HouseReservations;
}

/** ソロゲーム1回の結果。精算結果に「お守りが何をしたか」を添えたもの */
export interface SoloRoundResult extends SettleResult {
  /** お守り適用前の払戻総額（0=負け、bet=引き分け） */
  rawPayout: number;
  /** お守りが発動したときの表示文（未発動なら undefined） */
  amuletNote?: string;
}

export interface SoloRoundOptions extends SettleOptions {
  /** 賭け額のうちジャックポットへ積む額（スロット等） */
  jackpotCut?: number;
}

const now = () => Math.floor(Date.now() / 1000);

export class Casino {
  private readonly fukuScaleOpt: number | (() => number);
  private readonly items?: Items;
  private readonly reservations?: HouseReservations;

  constructor(
    private readonly db: Database.Database,
    readonly ether: EtherExchange,
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
    // 既存DBへの追加（PR3）。通算損益は total_earned − total_lost で出す。
    // 以前は total_earned − total_wagered で出していたが、total_earned が
    // 「勝ちの純益」なのに total_wagered が「勝ち負け問わぬ賭け総額」なので、
    // 勝った回の賭け額を二重に引いていた（負けが実際より大きく見える）。
    const cols = this.db.prepare("PRAGMA table_info(casino_stats)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "total_lost")) {
      this.db.exec("ALTER TABLE casino_stats ADD COLUMN total_lost INTEGER NOT NULL DEFAULT 0");
    }
  }

  /** 胴元のエテル残高（＝配当余力） */
  houseBalance(): number {
    return this.ether.balanceOf(HOUSE_HOLDER);
  }

  /** ジャックポット積立額 */
  jackpotPool(): number {
    return this.ether.balanceOf(JACKPOT_HOLDER);
  }

  /**
   * 賭けの受付可否。胴元が最悪ケースの配当を払えないなら卓を閉じる。
   * @param maxPayout このベットが当たったときの最大支払額（賭け額込み）
   */
  canAccept(maxPayout: number): boolean {
    return this.availableForLiability() >= maxPayout;
  }

  /**
   * いま新しい債務を引き受けられる額（PR5）。
   * 予約が繋がっていれば `house 残高 − 予約合計`、繋がっていなければ house 残高そのもの。
   */
  availableForLiability(): number {
    return this.reservations ? this.reservations.available() : this.houseBalance();
  }

  private fukuScale(): number {
    const s = typeof this.fukuScaleOpt === "function" ? this.fukuScaleOpt() : this.fukuScaleOpt;
    return Number.isFinite(s) && s > 0 ? s : 10;
  }

  /**
   * 1ゲームの精算（ソロゲーム用）。原子的に:
   * 賭け徴収 → 配当 → 連鎖ボーナス（勝ち・胴元残高が上限） →
   * 福の重み（勝ち利益への累進奉納・半分JP/半分救済） → JP積立 → 戦績更新
   * @param payout 配当（賭け額込みの受取総額。0=負け、bet=引き分け返金）
   * @param jackpotCut 賭け額のうちジャックポットへ積む額（スロット等。胴元取り分から回す）
   * @param opts chain/fuku はソロゲーム既定ON。ルーレット等の共有卓はOFFにする
   */
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
    const move = { game, sessionId: null };
    // 1ゲームの精算をひとまとまりの業務操作として記録する。`operationId` は
    // 「同じ操作の再試行なら同じ値になる」ものを呼び出し側が渡す（Discordの操作IDなど）
    const groupKey = soloGroupKey(game, userId, opts.operationId);
    return this.ether.runGroup({ groupKey, kind: "solo_game", actorId: userId }, (): SettleResult => {
      // 徴収
      this.ether.transfer(userId, HOUSE_HOLDER, bet, { ...move, reason: "賭け金" });
      // 配当
      if (payout > 0) this.ether.transfer(HOUSE_HOLDER, userId, payout, { ...move, reason: "配当" });

      const won = payout > bet;
      // 連鎖ボーナス: 「この勝ちで何連勝目か」= 現在の連勝 + 1（recordResult 前に読む）
      let chainBonus = 0;
      let chainStreak = 0;
      let chainMult = 1.0;
      let chainLabel = "";
      if (won && useChain) {
        chainStreak = this.stats(userId).current_win_streak + 1;
        const c = chainMultiplier(chainStreak);
        chainMult = c.mult;
        chainLabel = c.label;
        chainBonus = Math.min(Math.floor(payout * (c.mult - 1)), this.ether.balanceOf(HOUSE_HOLDER));
        if (chainBonus > 0) this.ether.transfer(HOUSE_HOLDER, userId, chainBonus, { ...move, reason: "連鎖ボーナス" });
      }

      // 福の重み: 勝ち利益（チェーン込み）への累進奉納。半分JP・半分救済
      let fukuTax = 0;
      let rate = 0;
      if (won && useFuku) {
        rate = fukuRate(this.ether.balanceOf(userId), this.fukuScale());
        fukuTax = Math.floor((payout - bet + chainBonus) * rate);
        if (fukuTax > 0) {
          const half = Math.floor(fukuTax / 2);
          if (half > 0) this.ether.transfer(userId, JACKPOT_HOLDER, half, { ...move, reason: "福の重み（JP積立）" });
          if (fukuTax - half > 0) {
            this.ether.transfer(userId, RELIEF_HOLDER, fukuTax - half, { ...move, reason: "福の重み（救済積立）" });
          }
        }
      }

      // JP積立（胴元から）。**黙って飛ばさない**（PR4 レビュー指摘）。
      // 積立は house からの支出なので PR5 の予約債務に含めてある。したがって
      // 予約が取れた賭けでは必ず払えるはずで、払えないなら会計上の異常として記録する。
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
      // 債務が確定したので予約を解放する。**精算と同じトランザクションの中**で行うので、
      // 精算が巻き戻れば予約も残る（払う前に枠だけ空くことがない）
      if (opts.reservationKey) this.reservations?.release(opts.reservationKey);
      const effectivePayout = payout + chainBonus - fukuTax;
      const net = effectivePayout - bet;
      // 戦績には**実際に残高が動いた額**を渡す（PR3）。素の payout を渡していたので、
      // 連鎖ボーナスは通算損益に乗らず、福の重みは引かれていなかった。
      // JP積立は胴元 → JP の移動なので利用者の損益には関係しない
      this.recordResult(userId, bet, effectivePayout);
      this.events.log("casino_game", { actor: userId, payload: { game, bet, payout: effectivePayout, net, chainBonus, fukuTax } });
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

  /**
   * ソロゲーム1回の資金処理（**全ソロゲームの入口**）。
   *
   * お守りの消費・賭けの徴収・配当・戦績を**ひとつの業務グループ**で行う。
   * お守りは DB 上の装備を消す副作用なので、精算より前に外で消費すると
   * 「精算だけ落ちてお守りだけ消えた」状態が残る。同じグループに入れておけば
   * 例外時にお守りも一緒に戻る。
   *
   * @param rawPayout お守り適用前の払戻総額（0=負け、bet=引き分け、>bet=勝ち）
   */
  settleSolo(userId: string, game: string, bet: number, rawPayout: number, opts: SoloRoundOptions): SoloRoundResult {
    const groupKey = soloGroupKey(game, userId, opts.operationId);
    return this.ether.runGroup({ groupKey, kind: "solo_game", actorId: userId }, (): SoloRoundResult => {
      const amulet = this.consumeAmulets(userId, bet, rawPayout);
      // settle は同じキーで runGroup を呼ぶが、すでにこのグループの中なので合流する
      const settled = this.settle(userId, game, bet, amulet.payout, opts.jackpotCut ?? 0, opts);
      return { ...settled, rawPayout, ...(amulet.note ? { amuletNote: amulet.note } : {}) };
    });
  }

  /**
   * お守りの適用: 勝ちなら勝利ボーナス、負けなら返金保護。
   *
   * 装備の消費は DB を書き換える副作用なので、**必ず資金グループの中から呼ぶ**
   * （外で消費すると、精算が落ちたときお守りだけ消える）。通常は `settleSolo()` 経由で、
   * 賭けを伴わない払い出し（スロットのフリースピン等）だけ直接呼ぶ。
   */
  consumeAmulets(userId: string, bet: number, rawPayout: number): { payout: number; note?: string } {
    if (!this.ether.chipTx.isActive()) {
      throw new ChipTxError("ERR_NO_GROUP", { reason: "お守りの消費はグループの中で行う", userId });
    }
    const items = this.items;
    if (!items) return { payout: rawPayout };
    if (rawPayout > bet) {
      const b = items.consumeWinBonus(userId, rawPayout, bet);
      return b.bonus > 0 ? { payout: rawPayout + b.bonus, note: b.note } : { payout: rawPayout };
    }
    if (rawPayout < bet) {
      const p = items.consumeLossProtection(userId, bet);
      if (p.refund > 0) return { payout: p.refund, note: p.note };
    }
    return { payout: rawPayout };
  }

  /**
   * ジャックポット払い出し（当選）。
   * @param share 取れる割合（既定 1 = 全額。スロットは 0.5 = 半分獲得・半分シード残留）
   */
  seizeJackpot(userId: string, game: string, operationId: string, share = 1): number {
    const key = `jackpot:${game}:${userId}:${operationId}`;
    return this.ether.runGroup({ groupKey: key, kind: "solo_game", actorId: userId }, (): number => {
      const pool = this.jackpotPool();
      const amount = Math.floor(pool * Math.min(1, Math.max(0, share)));
      if (amount <= 0) return 0;
      this.ether.transfer(JACKPOT_HOLDER, userId, amount, { game, reason: "ジャックポット当選" });
      // JP当選は settle を通らないので、ここで通算損益へ足す（PR3）。
      // 賭けを伴わない払い出しなので試合数は増やさない
      this.recordGameNet(userId, amount, { countAsBiggestWin: true });
      this.events.log("casino_jackpot", { actor: userId, payload: { game, amount, poolBefore: pool } });
      return amount;
    });
  }

  /**
   * `settle()` を通らないゲーム由来の実現損益を戦績へ足す（PR3）。
   *
   * 賭けを伴わない払い出し（スロットのフリースピン配当・JP当選）と、
   * 胴元を相手にしない対人戦の精算がここを通る。**試合数・連勝・賭け総額は動かさない**
   * （それらは `settle()` が1ゲーム1回だけ数える。ここで足すと1スピンが2ゲームになる）。
   *
   * 呼ぶのは「実際に残高が動いた額」だけ。返金・無効試合・冪等再試行では
   * 残高が動かないので `net = 0` になり、何も記録されない。
   *
   * @param net 利用者から見た純増減。プラスなら total_earned、マイナスなら total_lost へ
   * @param countAsBiggestWin JP当選のように「その回の勝ち」として最大単勝に載せるか
   */
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

  /** 戦績更新。payout > bet で勝ち、payout < bet で負け、同額はノーカウント（引き分け） */
  private recordResult(userId: string, bet: number, payout: number): void {
    const ts = now();
    this.db
      .prepare("INSERT INTO casino_stats (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
      .run(userId, ts);
    const win = payout > bet ? 1 : 0;
    const loss = payout < bet ? 1 : 0;
    const netWin = Math.max(0, payout - bet);
    const netLoss = Math.max(0, bet - payout);
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
    const row = this.db.prepare("SELECT * FROM casino_stats WHERE user_id = ?").get(userId) as CasinoStatsRow | undefined;
    return (
      row ?? {
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
      }
    );
  }

  /** 賭場番付用: 指標別 Top N */
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
        .all(HOUSE_HOLDER, JACKPOT_HOLDER, RELIEF_HOLDER, limit) as Array<{ user_id: string; value: number }>;
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
