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
import { MARKET_HOUSE_CUT } from "./game-models.js";
/** 板の場代率。単一の真実源は game-models.MARKET_HOUSE_CUT */
const HOUSE_CUT = MARKET_HOUSE_CUT;
const DEFAULT_FEE = 500;
export const DISPUTE_WINDOW_SEC = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

/** 板ごとの預り所（保有者ID）。胴元(house)とは完全に分離して置く。 */
export const marketEscrowHolder = (id: number): string => `escrow:market:${id}`;

/**
 * 板の状態。
 * - open/closed/reported/disputed: 進行中
 * - settled/void: 終端（精算済み・無効化済み）
 * - frozen: **資金不整合による凍結**。返金失敗（underfunded/overfunded/mismatch）や
 *   bet 時の整合性エラーで到達する終端状態。新規ベット・張り直し・報告・承認・自動精算すべて不可。
 *   帳簿とエスクロー残高は保持され、運営の手動調査・補正後にのみ返金/無効化できる。
 */
export type MarketStatus = "open" | "closed" | "reported" | "disputed" | "settled" | "void" | "frozen";
export type PayoutMode = "parimutuel" | "winner_take_all";
/**
 * 板の資金源。DB に明示保存する（残高から推測しない）。
 * - "escrow":       新方式。賭け金は escrow:market:<id> に分離。精算は必ずそこから。
 * - "legacy_house": 分離前の既存板。賭け金は house 直接。新規ベット禁止・起動時返金のみ。
 */
export type MarketFundMode = "escrow" | "legacy_house";

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
  fund_mode: MarketFundMode;
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
  | "ERR_BAD_MODE"
  | "ERR_UNDERFUNDED_ESCROW"
  | "ERR_ESCROW_MISMATCH"
  | "ERR_LEGACY_BET_FORBIDDEN";
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
    // 資金源を DB に明示。既存の板は 'legacy_house'（分離前データ）として扱う。
    // 起動時 refundAllPending() で返金・void 化されるので、以降 legacy は残らないのが正常。
    this.addColumnIfMissing("casino_markets", "fund_mode", "TEXT NOT NULL DEFAULT 'legacy_house'");
  }

  private addColumnIfMissing(table: string, column: string, spec: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  }

  /**
   * この板の精算資金源を DB の fund_mode に従って決める（残高から推測しない）。
   *
   * fund_mode='escrow'（新方式）:
   *   - エスクロー残高が pot と **完全一致** の場合のみ escrow:market:<id> を返す
   *   - balance != pot（多い/少ない/0 いずれも）は ERR_ESCROW_MISMATCH で停止
   *     → house に黙ってフォールバックしない。呼び出し側で void → 隔離させる
   *
   * fund_mode='legacy_house'（分離前データ）:
   *   - エスクロー残高 0 の場合のみ house から返金を許可
   *   - エスクローに残高があるのは異常（新方式のはず）→ ERR_ESCROW_MISMATCH
   *
   * @param m  板（fund_mode を含む）
   * @param pot 現在の pot（賭け合計）
   */
  private fundHolder(m: Market, pot: number): string {
    const esc = marketEscrowHolder(m.id);
    const bal = this.ether.balanceOf(esc);
    if (m.fund_mode === "escrow") {
      if (pot === 0) {
        // pot=0 は精算しても何も動かない。ただしエスクローに残があるのは異常
        if (bal !== 0) throw new MarketError("ERR_ESCROW_MISMATCH", { marketId: m.id, pot, escrowBalance: bal, mode: m.fund_mode });
        return esc;
      }
      if (bal === pot) return esc; // 正常: 完全一致のみ許可
      // 不一致（0/pot未満/pot超）はすべて整合性エラーで停止
      if (bal < pot) throw new MarketError("ERR_UNDERFUNDED_ESCROW", { marketId: m.id, pot, escrowBalance: bal });
      throw new MarketError("ERR_ESCROW_MISMATCH", { marketId: m.id, pot, escrowBalance: bal, mode: m.fund_mode });
    } else if (m.fund_mode === "legacy_house") {
      // legacy_house: エスクロー残高 0 の場合のみ house から動かせる
      if (bal !== 0) {
        throw new MarketError("ERR_ESCROW_MISMATCH", { marketId: m.id, pot, escrowBalance: bal, mode: m.fund_mode });
      }
      return HOUSE_HOLDER;
    } else {
      // fail-closed: DB 破損・予期しない fund_mode 値は legacy 扱いせず必ず例外。
      // house から誤って支払う経路を塞ぐ。
      throw new MarketError("ERR_BAD_MODE", { marketId: m.id, fundMode: m.fund_mode });
    }
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
      // 新規板は必ず fund_mode='escrow'（賭け金を escrow:market:<id> に分離する）
      const info = this.db
        .prepare(
          `INSERT INTO casino_markets (guild_id, creator_id, title, options_json, deadline_at, status, payout_mode, fee, fund_mode, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'escrow', ?)`,
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
   * 資金不整合により市場を凍結する（独立トランザクション・資金は動かさない）。
   * frozen 市場は新規ベット/張り直し/報告/承認/自動精算がすべて不可になり、
   * 帳簿とエスクロー残高を保持して運営の手動調査を待つ。
   */
  private freeze(id: number, actor: string, reason: string, meta: Record<string, unknown>): void {
    try {
      this.db.transaction(() => {
        this.db.prepare("UPDATE casino_markets SET status = 'frozen' WHERE id = ?").run(id);
      })();
    } catch {
      /* frozen 化に失敗しても後続の throw は行う（次回起動時 refundAllPending でも再検出される） */
    }
    this.events.log("market_frozen", { actor, payload: { id, reason, ...meta } });
  }

  /**
   * 1人1口の原則。既に張っていたら前額を返金してから新額を徴収する（casino-bot 準拠「張り直しは上書き」）。
   *
   * 資金整合ガード（PR#6 レビュー指摘）: fund_mode='escrow' かつ既存 pot がある場合、
   * escrow 残高 === 既存 pot でなければベットを受け付けず、市場を frozen にする。
   * これで起動時以外に資金不整合が生じても、追加利用者の資金を巻き込まない。
   */
  bet(marketId: number, userId: string, optionIndex: number, amount: number): { previous: number | null; net: number } {
    if (!Number.isInteger(amount) || amount <= 0) throw new MarketError("ERR_BAD_AMOUNT", { amount });
    const m = this.get(marketId);
    if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { marketId });
    if (m.status !== "open") throw new MarketError("ERR_NOT_OPEN", { marketId, status: m.status });
    if (m.deadline_at <= now()) throw new MarketError("ERR_NOT_OPEN", { marketId, deadline: m.deadline_at });
    // 旧方式（legacy_house）や未知の fund_mode には新規ベットを受け付けない（escrow のみ）
    if (m.fund_mode !== "escrow") throw new MarketError("ERR_LEGACY_BET_FORBIDDEN", { marketId, mode: m.fund_mode });
    const options = JSON.parse(m.options_json) as string[];
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      throw new MarketError("ERR_BAD_OPTION", { optionIndex, count: options.length });
    }

    // ── 資金整合ガード: escrow 残高 === 既存 pot（全ベット合計）を検証 ──
    const escHolder = marketEscrowHolder(marketId);
    const existingPot = (
      this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_market_bets WHERE market_id = ?").get(marketId) as { s: number }
    ).s;
    if (existingPot > 0) {
      const escBal = this.ether.balanceOf(escHolder);
      if (escBal !== existingPot) {
        // 不整合 → 市場を凍結し、資金を一切動かさず例外。監査ログに記録。
        this.freeze(marketId, "system:bet-guard", "escrow_mismatch_on_bet", { existingPot, escrowBalance: escBal });
        if (escBal < existingPot) {
          throw new MarketError("ERR_UNDERFUNDED_ESCROW", { marketId, pot: existingPot, escrowBalance: escBal });
        }
        throw new MarketError("ERR_ESCROW_MISMATCH", { marketId, pot: existingPot, escrowBalance: escBal, mode: m.fund_mode });
      }
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
        // 張り直し: 既存分は escrow に入っているのでそこから返す（fund_mode='escrow' 確定済み）
        this.ether.transfer(escHolder, userId, existingTotal);
        this.db.prepare("DELETE FROM casino_market_bets WHERE market_id = ? AND user_id = ?").run(marketId, userId);
      }
      // 新規徴収は必ず板ごとの分離保有者へ（胴元の配当余力から切り離す）
      this.ether.transfer(userId, escHolder, amount);
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
      const pot = bets.reduce((s, b) => s + b.amount, 0);
      const src = this.fundHolder(m, pot);
      for (const b of bets) this.ether.transfer(src, b.user_id, b.amount);
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

      // 精算の資金源: fund_mode に従い決定（escrow は balance===pot 厳格一致のみ許可）
      const src = this.fundHolder(m, pot);

      // 的中者なし → 全額返金 & void
      if (winners.length === 0) {
        for (const b of bets) this.ether.transfer(src, b.user_id, b.amount);
        this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), id);
        this.events.log("market_settle_void", { actor: "system", payload: { id, pot } });
        return { id, pot, houseCut: 0, distributable: 0, winnerCount: 0, payouts: [], mode: m.payout_mode, resultOption: m.result_option, void: true };
      }

      // 場代（勝者精算の前に JP へ抜く）
      const houseCut = Math.floor(pot * HOUSE_CUT);
      if (houseCut > 0) this.ether.transfer(src, JACKPOT_HOLDER, houseCut);
      const distributable = pot - houseCut;

      const payouts: Array<{ userId: string; amount: number }> = [];
      if (m.payout_mode === "parimutuel") {
        // 賭け額比例
        let remaining = distributable;
        for (let i = 0; i < winners.length; i++) {
          const w = winners[i]!;
          const isLast = i === winners.length - 1;
          const share = isLast ? remaining : Math.floor((distributable * w.amount) / winnersPot);
          if (share > 0) this.ether.transfer(src, w.user_id, share);
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
          if (share > 0) this.ether.transfer(src, uid, share);
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
      const pot = bets.reduce((s, b) => s + b.amount, 0);
      const src = this.fundHolder(m, pot);
      for (const b of bets) this.ether.transfer(src, b.user_id, b.amount);
      this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), id);
    })();
    this.events.log("market_void", { actor, payload: { id } });
  }

  /**
   * 起動時: open/closed/reported/disputed の未精算板を全部返金 & void。
   * 個別の板でエラー（underfunded/overfunded/mismatch）が出ても他の板を止めない。
   * **返金に失敗した板は frozen に変更**して新規ベットを止め、帳簿とエスクロー残高を保持する。
   * エラーは events に記録して呼び出し側でログ出力できるようにする。
   */
  refundAllPending(actor: string): {
    total: number;
    refunded: number;
    frozen: number;
    failed: Array<{ id: number; error: string }>;
  } {
    const rows = this.db
      .prepare("SELECT id FROM casino_markets WHERE status IN ('open','closed','reported','disputed')")
      .all() as Array<{ id: number }>;
    let refunded = 0;
    let frozen = 0;
    const failed: Array<{ id: number; error: string }> = [];
    for (const r of rows) {
      try {
        this.refund(r.id, actor);
        refunded++;
      } catch (e) {
        const err = e instanceof MarketError ? `${e.code}:${JSON.stringify(e.meta)}` : (e as Error).message;
        failed.push({ id: r.id, error: err });
        // 返金失敗市場は frozen へ（独立トランザクション）。
        // - open のまま放置すると起動後に新規ベットを受け付けてしまう
        // - house からの自動補填はしない・帳簿とエスクロー残高は保持する
        // - frozen のエスクローは所有者情報が残るので孤児として自動隔離しない（調査完了まで市場専用holderに保持）
        try {
          this.db.transaction(() => {
            this.db.prepare("UPDATE casino_markets SET status = 'frozen' WHERE id = ?").run(r.id);
          })();
          frozen++;
        } catch (fe) {
          // frozen 化にも失敗（DB異常）→ ログのみ。他市場の処理は続行
          this.events.log("market_freeze_failed", { actor, payload: { id: r.id, error: (fe as Error).message } });
        }
        // 個別イベントログ（起動時掃除の失敗は必ず監査に残す）
        this.events.log("market_refund_failed", { actor, payload: { id: r.id, error: err, frozen: true } });
      }
    }
    return { total: rows.length, refunded, frozen, failed };
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
