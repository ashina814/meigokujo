import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "./exchange.js";
import { JACKPOT_HOLDER } from "./service.js";

/**
 * 賭場の板（公開賭け市場）。casino-bot 準拠のシンプル版。
 * - 立てる: 題目 + 選択肢2〜4 + 締切分
 * - 賭ける: 各選択肢に額を張る（エスクロー = 胴元一時保管）
 * - 締切後: 作成者が結果報告 → 精算
 * - 精算: parimutuel（賭け額比例で分配）、場代3%は JP プールへ
 * - 再起動時の未精算板は refundAllOpen() で全額返金＆ void 化
 */
const HOUSE_CUT = 0.03;
const now = () => Math.floor(Date.now() / 1000);

export type MarketStatus = "open" | "closed" | "reported" | "settled" | "void";
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
  created_at: number;
}
export interface MarketBet {
  market_id: number;
  user_id: string;
  option_index: number;
  amount: number;
}

export type MarketErrorCode =
  | "ERR_UNKNOWN_MARKET"
  | "ERR_NOT_OPEN"
  | "ERR_NOT_CREATOR"
  | "ERR_BAD_OPTION"
  | "ERR_INSUFFICIENT_ETHER"
  | "ERR_BAD_AMOUNT";
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
        status         TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','reported','settled','void')),
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
    `);
  }

  create(input: {
    guildId: string;
    creatorId: string;
    title: string;
    options: string[];
    durationMin: number;
  }): Market {
    if (input.options.length < 2 || input.options.length > 4) {
      throw new MarketError("ERR_BAD_OPTION", { count: input.options.length });
    }
    if (!Number.isInteger(input.durationMin) || input.durationMin < 1 || input.durationMin > 1440) {
      throw new MarketError("ERR_BAD_AMOUNT", { durationMin: input.durationMin });
    }
    const t = now();
    const deadline = t + input.durationMin * 60;
    const info = this.db
      .prepare(
        `INSERT INTO casino_markets (guild_id, creator_id, title, options_json, deadline_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(input.guildId, input.creatorId, input.title.slice(0, 200), JSON.stringify(input.options), deadline, t);
    const id = Number(info.lastInsertRowid);
    this.events.log("market_create", { actor: input.creatorId, payload: { id, title: input.title, options: input.options, deadline } });
    return this.get(id)!;
  }

  get(id: number): Market | undefined {
    return this.db.prepare("SELECT * FROM casino_markets WHERE id = ?").get(id) as Market | undefined;
  }
  setMessage(id: number, channelId: string, messageId: string): void {
    this.db.prepare("UPDATE casino_markets SET channel_id = ?, message_id = ? WHERE id = ?").run(channelId, messageId, id);
  }

  listOpen(): Market[] {
    return this.db.prepare("SELECT * FROM casino_markets WHERE status = 'open' ORDER BY deadline_at ASC").all() as Market[];
  }
  listPastDeadline(): Market[] {
    const t = now();
    return this.db
      .prepare("SELECT * FROM casino_markets WHERE status = 'open' AND deadline_at <= ? ORDER BY deadline_at ASC")
      .all(t) as Market[];
  }
  bets(id: number): MarketBet[] {
    return this.db.prepare("SELECT * FROM casino_market_bets WHERE market_id = ?").all(id) as MarketBet[];
  }

  /**
   * 1人1口の原則。既に張っていたら前額を返金してから新額を徴収する（casino-bot 準拠「張り直しは上書き」）。
   * - 同一選択肢/別選択肢どちらの張り直しにも対応
   * - 減額の場合は差額が返金される
   * - 途中で残高不足を検出したら例外を投げ、DB トランザクションでロールバック
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
    // 張り直し後の追加徴収額 = amount - existingTotal（負なら差額返金）
    const additionalRequired = Math.max(0, amount - existingTotal);
    if (this.ether.balanceOf(userId) < additionalRequired) {
      throw new MarketError("ERR_INSUFFICIENT_ETHER", { held: this.ether.balanceOf(userId), additionalRequired, amount, existingTotal });
    }

    return this.db.transaction((): { previous: number | null; net: number } => {
      // 既存張りを全額返金 → 削除
      if (existingTotal > 0) {
        this.ether.transfer(HOUSE_HOLDER, userId, existingTotal);
        this.db.prepare("DELETE FROM casino_market_bets WHERE market_id = ? AND user_id = ?").run(marketId, userId);
      }
      // 新規張り
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

  /** 締切を過ぎたら close 状態にする。呼び出し側は scheduler tick から */
  autoClose(id: number): void {
    const m = this.get(id);
    if (!m || m.status !== "open") return;
    if (m.deadline_at > now()) return;
    this.db.prepare("UPDATE casino_markets SET status = 'closed' WHERE id = ?").run(id);
  }

  /**
   * 作成者が結果を報告 → parimutuel で即精算。
   * 場代3%を JP プールへ、残りを的中者に賭け額比で分配。
   * 的中者がいなければ全額 JP プールへ。
   */
  reportAndSettle(id: number, actor: string, winningOption: number): { pot: number; houseCut: number; distributable: number; winnerCount: number } {
    const m = this.get(id);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
    if (m.creator_id !== actor) throw new MarketError("ERR_NOT_CREATOR", { creator: m.creator_id, actor });
    if (m.status !== "open" && m.status !== "closed") throw new MarketError("ERR_NOT_OPEN", { status: m.status });
    const options = JSON.parse(m.options_json) as string[];
    if (winningOption < 0 || winningOption >= options.length) throw new MarketError("ERR_BAD_OPTION", { winningOption });

    return this.db.transaction((): { pot: number; houseCut: number; distributable: number; winnerCount: number } => {
      const bets = this.bets(id);
      const pot = bets.reduce((s, b) => s + b.amount, 0);
      const houseCut = Math.floor(pot * HOUSE_CUT);
      if (houseCut > 0) this.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, houseCut);
      const distributable = pot - houseCut;
      const winners = bets.filter((b) => b.option_index === winningOption);
      const winnerCount = winners.length;
      const winnersPot = winners.reduce((s, b) => s + b.amount, 0);

      if (winnersPot > 0) {
        let remaining = distributable;
        for (let i = 0; i < winners.length; i++) {
          const w = winners[i]!;
          const isLast = i === winners.length - 1;
          const share = isLast ? remaining : Math.floor((distributable * w.amount) / winnersPot);
          if (share > 0) this.ether.transfer(HOUSE_HOLDER, w.user_id, share);
          remaining -= share;
        }
      } else if (distributable > 0) {
        // 的中者ゼロ → 全額 JP へ
        this.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, distributable);
      }

      this.db.prepare("UPDATE casino_markets SET status = 'settled', result_option = ? WHERE id = ?").run(winningOption, id);
      this.events.log("market_settle", { actor, payload: { id, winningOption, pot, houseCut, winnerCount } });
      return { pot, houseCut, distributable, winnerCount };
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
      this.db.prepare("UPDATE casino_markets SET status = 'void' WHERE id = ?").run(id);
    })();
    this.events.log("market_void", { actor, payload: { id } });
  }

  /** 起動時: open/closed の未精算板を全部返金 & void。エスクロー整合維持 */
  refundAllPending(actor: string): number {
    const rows = this.db.prepare("SELECT id FROM casino_markets WHERE status IN ('open','closed','reported')").all() as Array<{ id: number }>;
    for (const r of rows) this.refund(r.id, actor);
    return rows.length;
  }
}
