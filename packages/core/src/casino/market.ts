import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "./exchange.js";
import { JACKPOT_HOLDER } from "./service.js";

/**
 * 賭場の板（公開賭け市場・casino-bot 完全準拠版）。
 *
 * フロー: 立てる → 賭ける → 締切(手動/自動) → 結果報告 → 承認/異議 → 精算
 *   配分方式: parimutuel（賭け額比例） / winner_take_all（的中者で均等頭割り）
 *   異議が出たら status=disputed → 管理者裁定で確定 or 返金
 *
 * 1人1口・張り直しは上書き（bet()）。
 * 議題立て手数料は JPプールへ。
 * 再起動時の未精算板は refundAllPending() で全額返金 & void 化（呼び出しは起動側）。
 */
const HOUSE_CUT = 0.03;
const DEFAULT_FEE = 500;
export const DISPUTE_WINDOW_SEC = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

export type MarketStatus = "open" | "closed" | "reported" | "disputed" | "settled" | "void";
export type PayoutMode = "parimutuel" | "winner_take_all";

export interface Market {
  id: number;
  guild_id: string;
  creator_id: string;
  title: string;
  options_json: string;
  deadline_at: number;
  status: MarketStatus;
  result_option: number | null;
  channel_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  payout_mode: PayoutMode;
  fee: number;
  reported_at: number | null;
  settled_at: number | null;
  created_at: number;
}
export interface MarketBet {
  market_id: number;
  user_id: string;
  option_index: number;
  amount: number;
}
export interface MarketApproval {
  market_id: number;
  user_id: string;
  vote: "approve" | "dispute";
  created_at: number;
}

export type MarketErrorCode =
  | "ERR_UNKNOWN_MARKET"
  | "ERR_NOT_OPEN"
  | "ERR_NOT_CLOSED"
  | "ERR_NOT_REPORTED"
  | "ERR_NOT_DISPUTED"
  | "ERR_NOT_CREATOR"
  | "ERR_NOT_BETTOR"
  | "ERR_BAD_OPTION"
  | "ERR_INSUFFICIENT_ETHER"
  | "ERR_BAD_AMOUNT"
  | "ERR_BAD_MODE";
export class MarketError extends Error {
  constructor(readonly code: MarketErrorCode, readonly meta: Record<string, unknown> = {}) {
    super(code);
    this.name = "MarketError";
  }
}

export class Markets {
  constructor(
    private readonly db: Database.Database,
    private readonly ether: EtherExchange,
    private readonly events: EventLog,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS casino_markets (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id       TEXT NOT NULL,
        creator_id     TEXT NOT NULL,
        title          TEXT NOT NULL,
        options_json   TEXT NOT NULL,
        deadline_at    INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'open',
        result_option  INTEGER,
        channel_id     TEXT,
        message_id     TEXT,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_casino_markets_open ON casino_markets(status, deadline_at);
      CREATE TABLE IF NOT EXISTS casino_market_bets (
        market_id    INTEGER NOT NULL REFERENCES casino_markets(id),
        user_id      TEXT NOT NULL,
        option_index INTEGER NOT NULL,
        amount       INTEGER NOT NULL CHECK(amount > 0),
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_casino_market_bets ON casino_market_bets(market_id, option_index);
      CREATE TABLE IF NOT EXISTS casino_market_approvals (
        market_id  INTEGER NOT NULL REFERENCES casino_markets(id),
        user_id    TEXT NOT NULL,
        vote       TEXT NOT NULL CHECK(vote IN ('approve','dispute')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (market_id, user_id)
      );
    `);
    // カラム追加は idempotent（既存カラムがあれば ALTER が失敗 → 握り潰す）
    this.addColumnIfMissing("casino_markets", "thread_id", "TEXT");
    this.addColumnIfMissing("casino_markets", "payout_mode", "TEXT NOT NULL DEFAULT 'parimutuel'");
    this.addColumnIfMissing("casino_markets", "fee", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("casino_markets", "reported_at", "INTEGER");
    this.addColumnIfMissing("casino_markets", "settled_at", "INTEGER");
  }

  private addColumnIfMissing(table: string, column: string, spec: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  }

  create(input: {
    guildId: string;
    creatorId: string;
    title: string;
    options: string[];
    durationMin: number;
    payoutMode?: PayoutMode;
    fee?: number;
  }): Market {
    if (input.options.length < 2 || input.options.length > 4) {
      throw new MarketError("ERR_BAD_OPTION", { count: input.options.length });
    }
    if (!Number.isInteger(input.durationMin) || input.durationMin < 1 || input.durationMin > 1440) {
      throw new MarketError("ERR_BAD_AMOUNT", { durationMin: input.durationMin });
    }
    const payoutMode: PayoutMode = input.payoutMode ?? "parimutuel";
    if (payoutMode !== "parimutuel" && payoutMode !== "winner_take_all") {
      throw new MarketError("ERR_BAD_MODE", { payoutMode });
    }
    const fee = input.fee ?? DEFAULT_FEE;
    if (!Number.isInteger(fee) || fee < 0) throw new MarketError("ERR_BAD_AMOUNT", { fee });
    // 手数料徴収は呼び出し側が担保する前提（残高不足なら例外なしで通ってしまう）→ 呼び出し側で先に balance check
    if (fee > 0 && this.ether.balanceOf(input.creatorId) < fee) {
      throw new MarketError("ERR_INSUFFICIENT_ETHER", { held: this.ether.balanceOf(input.creatorId), fee });
    }
    const t = now();
    const deadline = t + input.durationMin * 60;
    return this.db.transaction((): Market => {
      if (fee > 0) this.ether.transfer(input.creatorId, JACKPOT_HOLDER, fee);
      const info = this.db
        .prepare(
          `INSERT INTO casino_markets (guild_id, creator_id, title, options_json, deadline_at, status, payout_mode, fee, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .run(input.guildId, input.creatorId, input.title.slice(0, 200), JSON.stringify(input.options), deadline, payoutMode, fee, t);
      const id = Number(info.lastInsertRowid);
      this.events.log("market_create", {
        actor: input.creatorId,
        payload: { id, title: input.title, options: input.options, deadline, payoutMode, fee },
      });
      return this.get(id)!;
    })();
  }

  get(id: number): Market | undefined {
    return this.db.prepare("SELECT * FROM casino_markets WHERE id = ?").get(id) as Market | undefined;
  }
  setMessage(id: number, channelId: string, messageId: string): void {
    this.db.prepare("UPDATE casino_markets SET channel_id = ?, message_id = ? WHERE id = ?").run(channelId, messageId, id);
  }
  setThread(id: number, threadId: string | null): void {
    this.db.prepare("UPDATE casino_markets SET thread_id = ? WHERE id = ?").run(threadId, id);
  }

  listOpen(): Market[] {
    return this.db.prepare("SELECT * FROM casino_markets WHERE status IN ('open','closed','reported','disputed') ORDER BY id DESC").all() as Market[];
  }
  listPastDeadline(): Market[] {
    const t = now();
    return this.db
      .prepare("SELECT * FROM casino_markets WHERE status = 'open' AND deadline_at <= ? ORDER BY deadline_at ASC")
      .all(t) as Market[];
  }
  listPastDisputeWindow(): Market[] {
    // reported → DISPUTE_WINDOW_SEC 経過で自動精算候補
    const t = now();
    return this.db
      .prepare("SELECT * FROM casino_markets WHERE status = 'reported' AND reported_at IS NOT NULL AND reported_at + ? <= ?")
      .all(DISPUTE_WINDOW_SEC, t) as Market[];
  }
  bets(id: number): MarketBet[] {
    return this.db.prepare("SELECT * FROM casino_market_bets WHERE market_id = ?").all(id) as MarketBet[];
  }
  approvals(id: number): MarketApproval[] {
    return this.db.prepare("SELECT * FROM casino_market_approvals WHERE market_id = ?").all(id) as MarketApproval[];
  }
  /** 自分の張り（1人1口） */
  betOf(id: number, userId: string): MarketBet | undefined {
    return this.db
      .prepare("SELECT * FROM casino_market_bets WHERE market_id = ? AND user_id = ?")
      .get(id, userId) as MarketBet | undefined;
  }

  /**
   * 1人1口の原則。既に張っていたら前額を返金してから新額を徴収する（casino-bot 準拠「張り直しは上書き」）。
   */
  bet(marketId: number, userId: string, optionIndex: number, amount: number): { previous: number | null; net: number } {
    if (!Number.isInteger(amount) || amount <= 0) throw new MarketError("ERR_BAD_AMOUNT", { amount });
    const m = this.get(marketId);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { marketId });
    if (m.status !== "open") throw new MarketError("ERR_NOT_OPEN", { marketId, status: m.status });
    if (m.deadline_at <= now()) throw new MarketError("ERR_NOT_OPEN", { marketId, deadline: m.deadline_at });
    const options = JSON.parse(m.options_json) as string[];
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      throw new MarketError("ERR_BAD_OPTION", { optionIndex, count: options.length });
    }
    const existingRows = this.db
      .prepare("SELECT amount FROM casino_market_bets WHERE market_id = ? AND user_id = ?")
      .all(marketId, userId) as Array<{ amount: number }>;
    const existingTotal = existingRows.reduce((s, r) => s + r.amount, 0);
    const additionalRequired = Math.max(0, amount - existingTotal);
    if (this.ether.balanceOf(userId) < additionalRequired) {
      throw new MarketError("ERR_INSUFFICIENT_ETHER", { held: this.ether.balanceOf(userId), additionalRequired, amount, existingTotal });
    }

    return this.db.transaction((): { previous: number | null; net: number } => {
      if (existingTotal > 0) {
        this.ether.transfer(HOUSE_HOLDER, userId, existingTotal);
        this.db.prepare("DELETE FROM casino_market_bets WHERE market_id = ? AND user_id = ?").run(marketId, userId);
      }
      this.ether.transfer(userId, HOUSE_HOLDER, amount);
      this.db
        .prepare("INSERT INTO casino_market_bets (market_id, user_id, option_index, amount, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(marketId, userId, optionIndex, amount, now());
      this.events.log("market_bet", {
        actor: userId,
        payload: { marketId, optionIndex, amount, previous: existingTotal > 0 ? existingTotal : null },
      });
      return { previous: existingTotal > 0 ? existingTotal : null, net: amount - existingTotal };
    })();
  }

  /**
   * 手動締切（creator or admin）。open → closed。
   * autoClose と実装を共用（呼び出し元で権限判定）。
   */
  close(id: number, actor: string): void {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (m.status !== "open") throw new MarketError("ERR_NOT_OPEN", { status: m.status });
    this.db.prepare("UPDATE casino_markets SET status = 'closed' WHERE id = ?").run(id);
    this.events.log("market_close", { actor, payload: { id, manual: true } });
  }

  /** 締切を過ぎたら close 状態にする。scheduler tick から。副作用: 状態のみ */
  autoClose(id: number): void {
    const m = this.get(id);
    if (!m || m.status !== "open") return;
    if (m.deadline_at > now()) return;
    this.db.prepare("UPDATE casino_markets SET status = 'closed' WHERE id = ?").run(id);
    this.events.log("market_close", { actor: "system", payload: { id, manual: false } });
  }

  /**
   * 作成者（or 管理者）が勝ちの選択肢を報告。closed → reported。
   * 実際の精算は approve 全員 or DISPUTE_WINDOW 経過で発火（別メソッド）。
   */
  report(id: number, actor: string, winningOption: number, isAdmin = false): void {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (!isAdmin && m.creator_id !== actor) throw new MarketError("ERR_NOT_CREATOR", { creator: m.creator_id, actor });
    if (m.status !== "closed") throw new MarketError("ERR_NOT_CLOSED", { status: m.status });
    const options = JSON.parse(m.options_json) as string[];
    if (winningOption < 0 || winningOption >= options.length) throw new MarketError("ERR_BAD_OPTION", { winningOption });
    this.db
      .prepare("UPDATE casino_markets SET status = 'reported', result_option = ?, reported_at = ? WHERE id = ?")
      .run(winningOption, now(), id);
    this.events.log("market_report", { actor, payload: { id, winningOption } });
  }

  /**
   * 賭けた人が承認。全員承認なら即精算。
   * @returns { settled: 精算が走った場合の内訳, approvalCount, bettorCount }
   */
  approve(id: number, userId: string): { settled: MarketSettleResult | null; approvalCount: number; bettorCount: number } {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (m.status !== "reported") throw new MarketError("ERR_NOT_REPORTED", { status: m.status });
    if (!this.betOf(id, userId)) throw new MarketError("ERR_NOT_BETTOR", { id, userId });

    this.db
      .prepare(
        `INSERT INTO casino_market_approvals (market_id, user_id, vote, created_at)
         VALUES (?, ?, 'approve', ?)
         ON CONFLICT (market_id, user_id) DO UPDATE SET vote = 'approve', created_at = excluded.created_at`,
      )
      .run(id, userId, now());
    this.events.log("market_approve", { actor: userId, payload: { id } });

    const bettors = this.db
      .prepare("SELECT COUNT(DISTINCT user_id) AS c FROM casino_market_bets WHERE market_id = ?")
      .get(id) as { c: number };
    const approves = this.db
      .prepare("SELECT COUNT(*) AS c FROM casino_market_approvals WHERE market_id = ? AND vote = 'approve'")
      .get(id) as { c: number };
    if (approves.c >= bettors.c) {
      const settled = this.settle(id);
      return { settled, approvalCount: approves.c, bettorCount: bettors.c };
    }
    return { settled: null, approvalCount: approves.c, bettorCount: bettors.c };
  }

  /** 賭けた人が異議。status → disputed。管理者裁定待ちに。 */
  dispute(id: number, userId: string): void {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (m.status !== "reported") throw new MarketError("ERR_NOT_REPORTED", { status: m.status });
    if (!this.betOf(id, userId)) throw new MarketError("ERR_NOT_BETTOR", { id, userId });

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO casino_market_approvals (market_id, user_id, vote, created_at)
           VALUES (?, ?, 'dispute', ?)
           ON CONFLICT (market_id, user_id) DO UPDATE SET vote = 'dispute', created_at = excluded.created_at`,
        )
        .run(id, userId, now());
      this.db.prepare("UPDATE casino_markets SET status = 'disputed' WHERE id = ?").run(id);
    })();
    this.events.log("market_dispute", { actor: userId, payload: { id } });
  }

  /**
   * 異議ウィンドウ経過（scheduler tick）で自動精算。既に精算 or 異議が入ってたら no-op。
   */
  finalizeIfNoDispute(id: number): MarketSettleResult | null {
    const m = this.get(id);
    if (!m || m.status !== "reported") return null;
    return this.settle(id);
  }

  /**
   * 管理者裁定: 勝ちの選択肢を確定 → 精算。
   */
  adminResolve(id: number, actor: string, winningOption: number): MarketSettleResult {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (m.status !== "disputed") throw new MarketError("ERR_NOT_DISPUTED", { status: m.status });
    const options = JSON.parse(m.options_json) as string[];
    if (winningOption < 0 || winningOption >= options.length) throw new MarketError("ERR_BAD_OPTION", { winningOption });
    this.db.prepare("UPDATE casino_markets SET result_option = ?, status = 'reported' WHERE id = ?").run(winningOption, id);
    this.events.log("market_admin_resolve", { actor, payload: { id, winningOption } });
    const settled = this.settle(id);
    return settled;
  }

  /**
   * 管理者裁定: 無効化 → 全額返金 & void。
   */
  adminVoid(id: number, actor: string): void {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (m.status !== "disputed") throw new MarketError("ERR_NOT_DISPUTED", { status: m.status });
    this.db.transaction(() => {
      const bets = this.bets(id);
      for (const b of bets) this.ether.transfer(HOUSE_HOLDER, b.user_id, b.amount);
      this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), id);
    })();
    this.events.log("market_admin_void", { actor, payload: { id } });
  }

  /**
   * 内部精算。reported → settled or void（的中者なし）。
   * approve 全員 / DISPUTE_WINDOW 経過 / adminResolve のいずれかから呼ばれる。
   */
  private settle(id: number): MarketSettleResult {
    return this.db.transaction((): MarketSettleResult => {
      const m = this.get(id)!;
      if (m.status !== "reported" || m.result_option == null) {
        return { id, pot: 0, houseCut: 0, distributable: 0, winnerCount: 0, payouts: [], mode: m.payout_mode, resultOption: m.result_option, void: true };
      }
      const bets = this.bets(id);
      const pot = bets.reduce((s, b) => s + b.amount, 0);
      const winners = bets.filter((b) => b.option_index === m.result_option);
      const winnersPot = winners.reduce((s, b) => s + b.amount, 0);

      // 的中者なし → 全額返金 & void
      if (winners.length === 0) {
        for (const b of bets) this.ether.transfer(HOUSE_HOLDER, b.user_id, b.amount);
        this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), id);
        this.events.log("market_settle_void", { actor: "system", payload: { id, pot } });
        return { id, pot, houseCut: 0, distributable: 0, winnerCount: 0, payouts: [], mode: m.payout_mode, resultOption: m.result_option, void: true };
      }

      // 場代
      const houseCut = Math.floor(pot * HOUSE_CUT);
      if (houseCut > 0) this.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, houseCut);
      const distributable = pot - houseCut;

      const payouts: Array<{ userId: string; amount: number }> = [];
      if (m.payout_mode === "parimutuel") {
        // 賭け額比例
        let remaining = distributable;
        for (let i = 0; i < winners.length; i++) {
          const w = winners[i]!;
          const isLast = i === winners.length - 1;
          const share = isLast ? remaining : Math.floor((distributable * w.amount) / winnersPot);
          if (share > 0) this.ether.transfer(HOUSE_HOLDER, w.user_id, share);
          remaining -= share;
          payouts.push({ userId: w.user_id, amount: share });
        }
      } else {
        // 総取り: 的中者で均等頭割り
        const uniqueWinners = Array.from(new Set(winners.map((w) => w.user_id)));
        const per = Math.floor(distributable / uniqueWinners.length);
        const leftover = distributable - per * uniqueWinners.length;
        for (let i = 0; i < uniqueWinners.length; i++) {
          const uid = uniqueWinners[i]!;
          const share = i === 0 ? per + leftover : per;
          if (share > 0) this.ether.transfer(HOUSE_HOLDER, uid, share);
          payouts.push({ userId: uid, amount: share });
        }
      }

      this.db.prepare("UPDATE casino_markets SET status = 'settled', settled_at = ? WHERE id = ?").run(now(), id);
      this.events.log("market_settle", {
        actor: "system",
        payload: { id, pot, houseCut, winnerCount: winners.length, mode: m.payout_mode },
      });
      return {
        id,
        pot,
        houseCut,
        distributable,
        winnerCount: winners.length,
        payouts,
        mode: m.payout_mode,
        resultOption: m.result_option,
        void: false,
      };
    })();
  }

  /**
   * 板を強制返金 & void 化。管理者裁定 or 起動時未精算掃除に使う。
   */
  refund(id: number, actor: string): void {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (m.status === "settled" || m.status === "void") return;
    this.db.transaction(() => {
      const bets = this.bets(id);
      for (const b of bets) this.ether.transfer(HOUSE_HOLDER, b.user_id, b.amount);
      this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), id);
    })();
    this.events.log("market_void", { actor, payload: { id } });
  }

  /** 起動時: open/closed/reported/disputed の未精算板を全部返金 & void。エスクロー整合維持 */
  refundAllPending(actor: string): number {
    const rows = this.db
      .prepare("SELECT id FROM casino_markets WHERE status IN ('open','closed','reported','disputed')")
      .all() as Array<{ id: number }>;
    for (const r of rows) this.refund(r.id, actor);
    return rows.length;
  }
}

export interface MarketSettleResult {
  id: number;
  pot: number;
  houseCut: number;
  distributable: number;
  winnerCount: number;
  payouts: Array<{ userId: string; amount: number }>;
  mode: PayoutMode;
  resultOption: number | null;
  void: boolean;
}
