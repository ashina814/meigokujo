import type Database from "better-sqlite3";
import { EventLog } from "../events/service.js";
import { ChipLedger, HOUSE_HOLDER } from "./chip-ledger.js";
import { JACKPOT_HOLDER } from "./service.js";
import { Ledger } from "../ledger/service.js";

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
/**
 * 板の最終処理（返金・無効化）の実行者ID。
 *
 * `runGroup` は同じ鍵で kind / actorId が違うと鍵の取り違えとして拒否する。
 * 返金・無効化は「管理者A → 別の管理者B → 起動時掃除」と別々の主体から再試行されうるので、
 * actor を鍵の同一性に混ぜない。誰が実行したかは events 側に残す。
 */
export const MARKET_FINALIZER = "system:market";
export const DISPUTE_WINDOW_SEC = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

/** 板ごとの預り所（保有者ID）。胴元(house)とは完全に分離して置く。 */
export const marketEscrowHolder = (id: number): string => `escrow:market:${id}`;

/**
 * イベントLand板（緊急イベント用・PR12とは独立の hotfix）の設計。
 *
 * 通常板の資金は `ChipLedger`（賭場チップ・別台帳・別 holder 名前空間・opening lock 対象）を通す。
 * イベント板は Land 決済で、生の `Ledger`（packages/core/src/ledger/service.ts）を直接使う。
 * 通貨も台帳もホルダー名前空間も完全に分離し、混同を防ぐため命名を変える:
 *   - 通常板: `escrow:market:<id>`（ChipLedger 保有者・sys: 接頭辞なし）
 *   - イベント板: `sys:escrow:market:<id>`（生 Ledger の system 口座・sys: 接頭辞あり）
 * この2つは別の台帳・別のテーブル（chip_accounts 系 / accounts）に属する別物であり、
 * 文字列が似ていても混同してはいけない。
 */
export const eventMarketEscrowHolder = (id: number): string => `sys:escrow:market:${id}`;
/** イベント板の手数料・場代の一時保管口座。ここから国庫・部署等への送金は今回のPRでは行わない（所有先は本線PRで決定）。 */
export const EVENT_MARKET_FEES_HOLDER = "sys:escrow:market:fees";
/** イベント板の開設手数料（Ld）。通常板の DEFAULT_FEE とは別の値として明示管理する。 */
export const EVENT_MARKET_CREATE_FEE = 500;
/** イベント板: 個人の1口上限（張り直し後の合計額として判定・Ld）。 */
export const EVENT_MARKET_PERSONAL_CAP = 100_000;
/** イベント板: 板全体のpot上限（Ld）。 */
export const EVENT_MARKET_POT_CAP = 900_000;
/** イベント板が受け付ける選択肢の最大数。通常板は 4 のまま変更しない。 */
export const EVENT_MARKET_MAX_OPTIONS = 32;

/**
 * 起動時の復旧で「返してはいけない」板のエスクロー保有者（PR7・正本 §8.1）。
 *
 * frozen も含める。返金に失敗して調査待ちの板は、所有者情報が `casino_market_bets` に
 * 残っているので孤児ではない。
 */
export const MARKET_LIVE_STATUSES = ["open", "closed", "reported", "disputed", "frozen"] as const;

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
/**
 * 板の種別。既存行はすべて 'standard'（通常板・ChipLedger決済）として扱う。
 * 'event' はイベント専用板（Land決済・ロール制限・承認なし即時精算）。
 */
export type MarketMode = "standard" | "event";
/** 精算の承認方式。'participant'=既存の参加者承認/異議、'instant'=本人最終確認のみで即時精算。 */
export type ApprovalMode = "participant" | "instant";
/** 板の決済通貨。'chip'=賭場チップ（ChipLedger）、'land'=生Land（Ledger）。 */
export type CurrencyMode = "chip" | "land";

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
  /** 板の種別。旧行は 'standard'。 */
  market_mode: MarketMode;
  /** イベント板の参加許可ロールID（Discord snowflake）のJSON配列。旧行・通常板は '[]'。 */
  allowed_role_ids_json: string;
  /** 精算の承認方式。旧行・通常板は 'participant'。イベント板は 'instant'。 */
  approval_mode: ApprovalMode;
  /** 決済通貨。旧行・通常板は 'chip'。イベント板は 'land'。 */
  currency_mode: CurrencyMode;
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
  | "ERR_LEGACY_BET_FORBIDDEN"
  // ── イベントLand板専用 ──
  /** イベント板の bet を、指定ロールをどれも持たない利用者が試みた */
  | "ERR_ROLE_NOT_ALLOWED"
  /** 参加ロール指定が 1〜5個・重複除去後の形式を満たさない */
  | "ERR_BAD_ROLE_LIST"
  /** イベント板専用APIを通常板（またはその逆）へ使おうとした */
  | "ERR_NOT_EVENT_MARKET"
  /** Markets に landLedger（生Ledger）が注入されていない状態でイベント板APIを呼んだ */
  | "ERR_LAND_LEDGER_NOT_CONFIGURED"
  /** Land残高が足りない（ChipLedgerのERR_INSUFFICIENT_ETHERとは別コード） */
  | "ERR_INSUFFICIENT_LAND"
  /** 個人の1口上限（張り直し後合計）を超える */
  | "ERR_PERSONAL_CAP_EXCEEDED"
  /** 板全体のpot上限を超える */
  | "ERR_POT_CAP_EXCEEDED"
  /** 同じ operationId を別の市場・種別で再利用しようとした（event_market_ops の鍵衝突） */
  | "ERR_OPERATION_CONFLICT";
export class MarketError extends Error {
  constructor(readonly code: MarketErrorCode, readonly meta: Record<string, unknown> = {}) {
    super(code);
    this.name = "MarketError";
  }
}

export interface MarketsOptions {
  /**
   * **確定精算のときだけ**呼ばれる、利用者ごとの実現損益（PR3・通算損益）。
   *
   * ```text
   * net = その板で受け取った配当 − その板へ張った総額
   * ```
   *
   * 参加（bet）時には呼ばない。的中者なしの全額返金・強制 void も呼ばない
   * （どちらも差引 0 で、まだ／もう何も確定していない）。
   * `settle()` の資金グループの中から呼ばれるので、再試行で二度は呼ばれない。
   */
  onPlayerNet?: (userId: string, net: number) => void;
  /**
   * イベントLand板が資金を動かすのに使う、生の `Ledger`（Land・packages/core/src/ledger/service.ts）。
   *
   * 通常板の資金は一切これを経由しない（`ether: ChipLedger` のみを使い続ける）。
   * 未指定のままイベント板専用APIを呼ぶと `ERR_LAND_LEDGER_NOT_CONFIGURED` で fail-closed する。
   * casino chip 経済の開業ロック（legacy_pre_reset / opening_v1）・稼働状態（casinoStatus）は
   * 生 Ledger には存在しない別レイヤーの概念であり、イベント板の Land 決済はこれらの影響を受けない
   * （意図的な設計判断。他の給与・VC報酬などの Land 取引と同じ扱い）。
   */
  landLedger?: Ledger;
}

export class Markets {
  private readonly onPlayerNet: (userId: string, net: number) => void;
  private readonly landLedger: Ledger | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly ether: ChipLedger,
    private readonly events: EventLog,
    options: MarketsOptions = {},
  ) {
    this.onPlayerNet = options.onPlayerNet ?? (() => undefined);
    this.landLedger = options.landLedger;
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
    // イベントLand板（緊急イベント用 hotfix）。既存行はすべて次の既定値で扱う:
    //   market_mode='standard' / currency_mode='chip' / approval_mode='participant' / allowed_role_ids_json='[]'
    // これにより通常板の既存データ・fund_mode・Chip escrow は一切変更しない。
    this.addColumnIfMissing("casino_markets", "market_mode", "TEXT NOT NULL DEFAULT 'standard'");
    this.addColumnIfMissing("casino_markets", "allowed_role_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("casino_markets", "approval_mode", "TEXT NOT NULL DEFAULT 'participant'");
    this.addColumnIfMissing("casino_markets", "currency_mode", "TEXT NOT NULL DEFAULT 'chip'");
    // 旧 DB は status に古い CHECK 制約（'disputed'/'frozen' を含まない）が付いている場合がある。
    // SQLite は CHECK を ALTER で変更できないため、必要ならテーブルを作り直して制約を外す。
    // ここより前に上の addColumnIfMissing がすべて完了している必要がある
    // （移行後の再構築テーブルは、その時点で存在する列だけを明示コピーするため）。
    this.migrateStatusCheckConstraint();

    // イベントLand板の冪等性・原子性テーブル（PR12とは独立のhotfix・正本は追加アーキ指針§B）。
    // create/bet/settle/void の全 Land 資金操作を runEventOp() でここへ記録する。
    // 既存の casino_markets 等と同じ場所・同じ流儀（CREATE TABLE IF NOT EXISTS）で冪等に作る。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_market_ops (
        operation_id TEXT PRIMARY KEY,
        market_id    INTEGER NOT NULL,
        kind         TEXT NOT NULL CHECK(kind IN ('create','bet','settle','void')),
        actor_id     TEXT NOT NULL,
        result_json  TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_market_ops_market ON event_market_ops(market_id, kind);

      -- Current casino_market_bets is intentionally overwritten by re-bets. Titles need an
      -- immutable successful-commitment fact that settlement/void/refund cannot erase.
      CREATE TABLE IF NOT EXISTS casino_market_participation_history (
        participation_key TEXT PRIMARY KEY,
        market_id         INTEGER NOT NULL,
        market_creator_id TEXT NOT NULL,
        participant_id    TEXT NOT NULL,
        market_mode       TEXT NOT NULL,
        market_created_at INTEGER NOT NULL,
        market_deadline_at INTEGER NOT NULL,
        occurred_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_casino_market_participant_time
        ON casino_market_participation_history(participant_id, occurred_at);
      CREATE TRIGGER IF NOT EXISTS casino_market_participation_no_update
      BEFORE UPDATE ON casino_market_participation_history
      BEGIN SELECT RAISE(ABORT, 'casino_market_participation_history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS casino_market_participation_no_delete
      BEFORE DELETE ON casino_market_participation_history
      BEGIN SELECT RAISE(ABORT, 'casino_market_participation_history is append-only'); END;
    `);
  }

  /**
   * 旧 casino_markets.status の CHECK 制約を撤去する冪等マイグレーション。
   *
   * 背景: 初期スキーマは `CHECK(status IN ('open','closed','reported','settled','void'))` で、
   * 後から追加された 'disputed'（既存コードで使用中）と 'frozen'（PR#6）を **書き込めない**。
   * その結果、資金不整合市場の frozen 化が黙って失敗し 'open' のまま残る（本番のみ再現・ステージングで検出）。
   *
   * SQLite は CHECK 制約を ALTER で変更できないので、テーブルを作り直して制約を外す。
   * status の妥当性はアプリ層（MarketStatus 型 + メソッドの status ガード）で保証する。
   *
   * 冪等性: CHECK が無い（新スキーマ）or 既に 'frozen' を含むなら何もしない。
   * 非破壊: 全列を明示コピー。id を保持するので子テーブル(bets/approvals)の参照は有効なまま。
   */
  private migrateStatusCheckConstraint(): void {
    const sql =
      (this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='casino_markets'").get() as
        | { sql?: string }
        | undefined)?.sql ?? "";
    // status 列に CHECK が無い（＝新スキーマ）なら何もしない
    if (!/CHECK\s*\(\s*status/i.test(sql)) return;
    // 既に 'frozen' を含む CHECK なら移行済み
    if (sql.includes("'frozen'")) return;

    // FK（bets/approvals → markets）を一時 OFF にして作り直す。id を保持するので参照は保たれる。
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.exec("BEGIN");
      this.db.exec(`
        CREATE TABLE casino_markets_new (
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
          thread_id      TEXT,
          payout_mode    TEXT NOT NULL DEFAULT 'parimutuel',
          fee            INTEGER NOT NULL DEFAULT 0,
          reported_at    INTEGER,
          settled_at     INTEGER,
          fund_mode      TEXT NOT NULL DEFAULT 'legacy_house',
          market_mode    TEXT NOT NULL DEFAULT 'standard',
          allowed_role_ids_json TEXT NOT NULL DEFAULT '[]',
          approval_mode  TEXT NOT NULL DEFAULT 'participant',
          currency_mode  TEXT NOT NULL DEFAULT 'chip',
          created_at     INTEGER NOT NULL
        );
      `);
      // この時点で market_mode 等の列がまだ無ければ（addColumnIfMissing 実行前に呼ばれた場合）
      // SELECT が失敗する。呼び出し順序はコンストラクタで固定しているが、fail-closed のため
      // 列の存在を明示確認してから SELECT 文を組み立てる。
      const hasEventColumns = (this.db.prepare("PRAGMA table_info(casino_markets)").all() as Array<{ name: string }>).some(
        (c) => c.name === "market_mode",
      );
      const eventCols = hasEventColumns
        ? "market_mode, allowed_role_ids_json, approval_mode, currency_mode"
        : "'standard' AS market_mode, '[]' AS allowed_role_ids_json, 'participant' AS approval_mode, 'chip' AS currency_mode";
      this.db.exec(`
        INSERT INTO casino_markets_new
          (id, guild_id, creator_id, title, options_json, deadline_at, status, result_option,
           channel_id, message_id, thread_id, payout_mode, fee, reported_at, settled_at, fund_mode,
           market_mode, allowed_role_ids_json, approval_mode, currency_mode, created_at)
        SELECT
           id, guild_id, creator_id, title, options_json, deadline_at, status, result_option,
           channel_id, message_id, thread_id, payout_mode, fee, reported_at, settled_at, fund_mode,
           ${eventCols}, created_at
        FROM casino_markets;
      `);
      this.db.exec("DROP TABLE casino_markets");
      this.db.exec("ALTER TABLE casino_markets_new RENAME TO casino_markets");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_casino_markets_open ON casino_markets(status, deadline_at)");
      // 子テーブルの参照整合性を確認（壊れていたら移行を巻き戻す）
      const violations = this.db.pragma("foreign_key_check(casino_markets)") as unknown[];
      if (violations.length > 0) {
        throw new Error(`foreign_key_check failed after casino_markets rebuild: ${JSON.stringify(violations)}`);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      this.db.pragma("foreign_keys = ON");
      throw e;
    }
    this.db.pragma("foreign_keys = ON");
    this.events.log("market_status_check_migrated", { actor: "system:migration", payload: { removedCheckConstraint: true } });
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
    /** この作成操作を一意に指す値。同じ操作の再試行では同じ値を渡す */
    operationId: string;
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
    const t = now();
    const deadline = t + input.durationMin * 60;
    return this.ether.runGroup(
      { groupKey: `market:create:${input.creatorId}:${input.operationId}`, kind: "market_bet", actorId: input.creatorId },
      (): Market => {
      // 残高判定はグループの中（作成成功後の再試行を残高不足で落とさない）
      if (fee > 0 && this.ether.balanceOf(input.creatorId) < fee) {
        throw new MarketError("ERR_INSUFFICIENT_ETHER", { held: this.ether.balanceOf(input.creatorId), fee });
      }
      if (fee > 0) {
        this.ether.transfer(input.creatorId, JACKPOT_HOLDER, fee, { reason: "板の開設手数料", game: "market" });
      }
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
    });
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
  bet(marketId: number, userId: string, optionIndex: number, amount: number, operationId: string): { previous: number | null; net: number } {
    // 引数の形だけ先に見る。板の状態・締切・既存 pot・エスクロー整合はすべてグループの中で見る
    // （成功済みの操作を再試行したとき、保存済みの結果を返す前に「もう締切だ」で落とさないため）
    if (!Number.isInteger(amount) || amount <= 0) throw new MarketError("ERR_BAD_AMOUNT", { amount });
    const escHolder = marketEscrowHolder(marketId);
    let freezeRequest: { reason: string; meta: Record<string, unknown> } | null = null;
    try {
      return this.ether.runGroup(
        { groupKey: `market:bet:${marketId}:${userId}:${operationId}`, kind: "market_bet", actorId: userId },
        (): { previous: number | null; net: number } => {
      const m = this.get(marketId);
      if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { marketId });
      if (m.status !== "open") throw new MarketError("ERR_NOT_OPEN", { marketId, status: m.status });
      const occurredAt = now();
      if (m.deadline_at <= occurredAt) throw new MarketError("ERR_NOT_OPEN", { marketId, deadline: m.deadline_at });
      // 旧方式（legacy_house）や未知の fund_mode には新規ベットを受け付けない（escrow のみ）
      if (m.fund_mode !== "escrow") throw new MarketError("ERR_LEGACY_BET_FORBIDDEN", { marketId, mode: m.fund_mode });
      const options = JSON.parse(m.options_json) as string[];
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
        throw new MarketError("ERR_BAD_OPTION", { optionIndex, count: options.length });
      }

      // ── 資金整合ガード: escrow 残高 === 既存 pot（全ベット合計）を検証 ──
      const existingPot = (
        this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_market_bets WHERE market_id = ?").get(marketId) as { s: number }
      ).s;
      if (existingPot > 0) {
        const escBal = this.ether.balanceOf(escHolder);
        if (escBal !== existingPot) {
          // 不整合 → 資金を一切動かさず例外。凍結はグループの外で行う
          //（グループの中で status を書いても、この例外で一緒に巻き戻ってしまう）
          freezeRequest = { reason: "escrow_mismatch_on_bet", meta: { existingPot, escrowBalance: escBal } };
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
      // 残高判定もグループの中（張った後の再試行を残高不足で落とさない）
      if (this.ether.balanceOf(userId) < additionalRequired) {
        throw new MarketError("ERR_INSUFFICIENT_ETHER", { held: this.ether.balanceOf(userId), additionalRequired, amount, existingTotal });
      }
      if (existingTotal > 0) {
        // 張り直し: 既存分は escrow に入っているのでそこから返す（fund_mode='escrow' 確定済み）
        this.ether.transfer(escHolder, userId, existingTotal, { reason: "板の賭け直しによる返金", game: "market", sessionId: `market:${marketId}` });
        this.db.prepare("DELETE FROM casino_market_bets WHERE market_id = ? AND user_id = ?").run(marketId, userId);
      }
      // 新規徴収は必ず板ごとの分離保有者へ（胴元の配当余力から切り離す）
      this.ether.transfer(userId, escHolder, amount, { reason: "板への賭け", game: "market", sessionId: `market:${marketId}` });
      this.db
        .prepare("INSERT INTO casino_market_bets (market_id, user_id, option_index, amount, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(marketId, userId, optionIndex, amount, occurredAt);
      // Fund transfer + current bet + immutable title fact are in the same runGroup transaction.
      // Store mode/context at commitment time so later mutable market state is never inferred.
      this.db.prepare(
        `INSERT INTO casino_market_participation_history
          (participation_key, market_id, market_creator_id, participant_id, market_mode,
           market_created_at, market_deadline_at, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `market:bet:${marketId}:${userId}:${operationId}`,
        marketId,
        m.creator_id,
        userId,
        m.market_mode,
        m.created_at,
        m.deadline_at,
        occurredAt,
      );
      this.events.log("market_bet", {
        actor: userId,
        payload: { marketId, optionIndex, amount, previous: existingTotal > 0 ? existingTotal : null },
      });
      return { previous: existingTotal > 0 ? existingTotal : null, net: amount - existingTotal };
        },
      );
    } catch (e) {
      // 資金不整合を見つけたときだけ、巻き戻した後に凍結する（凍結は残さないと次のベットを止められない）
      const req = freezeRequest as { reason: string; meta: Record<string, unknown> } | null;
      if (req) this.freeze(marketId, "system:bet-guard", req.reason, req.meta);
      throw e;
    }
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
   *
   * イベントLand板（market_mode='event'）は `reported` へ一切遷移しない設計
   * （closed → 本人確認後に直接 settled/void。`reportAndSettleEventLand()` 参照）。
   * そのため `listPastDisputeWindow()`（status='reported' のみ対象）にも
   * この `finalizeIfNoDispute()` にも、イベント板は構造上出現しない。
   * 追加のフィルタリングは不要（念のためここに明記する）。
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
   *
   * 状態判定・返金・status 更新・イベント記録をすべて同じグループに入れる。
   * 状態判定を外に置くと、成功後（status='void'）の再試行が保存済みの結果を返す前に
   * ERR_NOT_DISPUTED で落ちる。
   */
  adminVoid(id: number, actor: string): MarketRefundResult {
    return this.ether.runGroup(
      { groupKey: `market:void:${id}`, kind: "market_settle", actorId: MARKET_FINALIZER },
      (): MarketRefundResult => {
        const m = this.get(id);
        if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
        if (m.status !== "disputed") throw new MarketError("ERR_NOT_DISPUTED", { status: m.status });
        const refunded = this.refundAllBets(m, "板の返金");
        this.events.log("market_admin_void", { actor, payload: { id, refunded: refunded.refunded, users: refunded.users } });
        return refunded;
      },
    );
  }

  /**
   * 全ベットを資金源へ突き合わせて返し、板を void にする（呼び出し元のグループの中で使う）。
   * `_beforeStep` はテスト専用のフック（各返金の直前に呼ばれる）。本番呼び出しは省略する。
   */
  private refundAllBets(m: Market, reason: string, _beforeStep?: (index: number, bet: MarketBet) => void): MarketRefundResult {
    const bets = this.bets(m.id);
    const pot = bets.reduce((s, b) => s + b.amount, 0);
    const src = this.fundHolder(m, pot);
    for (let i = 0; i < bets.length; i++) {
      const b = bets[i]!;
      _beforeStep?.(i, b);
      this.ether.transfer(src, b.user_id, b.amount, { reason, game: "market", sessionId: `market:${m.id}` });
    }
    this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), m.id);
    return { id: m.id, refunded: pot, users: bets.length, alreadyClosed: false };
  }

  /**
   * 内部精算。reported → settled or void（的中者なし）。
   * approve 全員 / DISPUTE_WINDOW 経過 / adminResolve のいずれかから呼ばれる。
   */
  private settle(id: number): MarketSettleResult {
    return this.ether.runGroup(
      { groupKey: `market:settle:${id}`, kind: "market_settle", actorId: "system:market" },
      (): MarketSettleResult => {
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
        for (const b of bets) {
          this.ether.transfer(src, b.user_id, b.amount, { reason: "板の返金", game: "market", sessionId: `market:${id}` });
        }
        this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), id);
        this.events.log("market_settle_void", { actor: "system", payload: { id, pot } });
        return { id, pot, houseCut: 0, distributable: 0, winnerCount: 0, payouts: [], mode: m.payout_mode, resultOption: m.result_option, void: true };
      }

      // 場代（勝者精算の前に JP へ抜く）
      const houseCut = Math.floor(pot * HOUSE_CUT);
      if (houseCut > 0) {
        this.ether.transfer(src, JACKPOT_HOLDER, houseCut, { reason: "板の胴元取り分", game: "market", sessionId: `market:${id}` });
      }
      const distributable = pot - houseCut;

      // 通算損益は「配当 − 張った総額」（PR3）。参加時ではなくここで一度だけ記録する
      const staked = new Map<string, number>();
      for (const b of bets) staked.set(b.user_id, (staked.get(b.user_id) ?? 0) + b.amount);
      const received = new Map<string, number>();

      const payouts: Array<{ userId: string; amount: number }> = [];
      if (m.payout_mode === "parimutuel") {
        // 賭け額比例
        let remaining = distributable;
        for (let i = 0; i < winners.length; i++) {
          const w = winners[i]!;
          const isLast = i === winners.length - 1;
          const share = isLast ? remaining : Math.floor((distributable * w.amount) / winnersPot);
          if (share > 0) {
            this.ether.transfer(src, w.user_id, share, { reason: "板の配当", game: "market", sessionId: `market:${id}` });
          }
          remaining -= share;
          received.set(w.user_id, (received.get(w.user_id) ?? 0) + share);
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
          if (share > 0) {
            this.ether.transfer(src, uid, share, { reason: "板の配当", game: "market", sessionId: `market:${id}` });
          }
          received.set(uid, (received.get(uid) ?? 0) + share);
          payouts.push({ userId: uid, amount: share });
        }
      }

      // 張った本人だけを対象にする（JP へ抜けた場代は「受取 < 張った額」の形で損失に入る）
      for (const [userId, stake] of staked) {
        this.onPlayerNet(userId, (received.get(userId) ?? 0) - stake);
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
    });
  }

  /**
   * 板を強制返金 & void 化。管理者裁定 or 起動時未精算掃除に使う。
   *
   * 状態判定・返金・status 更新・イベント記録をすべて同じグループに入れる。
   * 外で「もう settled/void なら何もしない」と早期に返していたときは、
   * 成功後の再試行が保存済みの結果ではなく黙った no-op になっていた。
   */
  refund(id: number, actor: string, _beforeStep?: (index: number, bet: MarketBet) => void): MarketRefundResult {
    return this.ether.runGroup(
      { groupKey: `market:refund:${id}`, kind: "market_settle", actorId: MARKET_FINALIZER },
      (): MarketRefundResult => {
        const m = this.get(id);
        if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { id });
        if (m.status === "settled" || m.status === "void") {
          return { id, refunded: 0, users: 0, alreadyClosed: true };
        }
        const refunded = this.refundAllBets(m, "板の返金", _beforeStep);
        this.events.log("market_void", { actor, payload: { id, refunded: refunded.refunded, users: refunded.users } });
        return refunded;
      },
    );
  }

  /**
   * 起動時: open/closed/reported/disputed の未精算板を全部返金 & void。
   * 個別の板でエラー（underfunded/overfunded/mismatch）が出ても他の板を止めない。
   * **返金に失敗した板は frozen に変更**して新規ベットを止め、帳簿とエスクロー残高を保持する。
   * エラーは events に記録して呼び出し側でログ出力できるようにする。
   */
  /**
   * 復旧レジストリへの申告（PR7・正本 §8.1）。
   *
   * 「いま生きていて、預託を返してはいけない板」の保有者IDを返す。
   * 掃除の側が `casino_markets` を直接読むのをやめ、**所有元が自分で申告する**形にする。
   */
  liveEscrowHolders(): string[] {
    // market_mode='standard' に限定する（PR12とは独立のhotfix・追加アーキ指針§D）。
    // イベント板の Land escrow（sys:escrow:market:<id>、生Ledger所属）は ChipLedger の
    // 孤児検出とは完全に別経済圏なので、ここへ含めない（別途 auditPendingEventLand() が扱う）。
    const placeholders = MARKET_LIVE_STATUSES.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id FROM casino_markets WHERE market_mode = 'standard' AND status IN (${placeholders})`)
      .all(...MARKET_LIVE_STATUSES) as Array<{ id: number }>;
    return rows.map((r) => marketEscrowHolder(r.id));
  }

  refundAllPending(actor: string): {
    total: number;
    refunded: number;
    frozen: number;
    failed: Array<{ id: number; error: string }>;
  } {
    // market_mode='standard' に限定する。イベント板（Land・別台帳）は
    // auditPendingEventLand()（通常起動）/ adminRefundAllPendingEventLand()（明示的な管理者操作）
    // が別経路で扱う（chip 側の this.refund() を通さない）。
    const rows = this.db
      .prepare("SELECT id FROM casino_markets WHERE market_mode = 'standard' AND status IN ('open','closed','reported','disputed')")
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

  // ══════════════════════════════════════════════════════════════════
  // イベントLand板（緊急イベント用 hotfix・PR12とは独立）
  //
  // 通常板（上のメソッド群）は一切変更していない。以下はすべて
  // market_mode='event' の板だけを対象にする新しい経路で、資金は必ず
  // 生の Ledger（landLedger）を通す（ChipLedger は一切使わない）。
  // ══════════════════════════════════════════════════════════════════

  private requireLandLedger(): Ledger {
    if (!this.landLedger) throw new MarketError("ERR_LAND_LEDGER_NOT_CONFIGURED");
    return this.landLedger;
  }

  /** 参加ロールIDの正規化: 空白除去・空値除去・重複除去（順序保持）。1〜5個でなければ拒否。 */
  private normalizeRoleIds(raw: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of raw) {
      const id = typeof r === "string" ? r.trim() : "";
      if (!id || !/^\d{1,32}$/.test(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (out.length < 1 || out.length > 5) {
      throw new MarketError("ERR_BAD_ROLE_LIST", { count: out.length, raw });
    }
    return out;
  }

  /**
   * イベントLand板の資金操作（create/bet/settle/void）を冪等・原子的に包む共通ヘルパー
   * （追加アーキ指針§B）。
   *
   * - 同じ operationId が既にあれば、**現在のDB状態を一切読み直さず**保存済みの結果をそのまま返す。
   *   これが「現在の bet 行を『旧ベット』と誤認して返金処理を組み直す」問題を構造的に防ぐ。
   * - 同じ operationId を別の market_id / kind で再利用したら ERR_OPERATION_CONFLICT。
   * - `fn()` は `this.db.transaction()` の中で実行される。内部で呼ぶ `landLedger.transfer()` は
   *   それぞれ自前で `db.transaction()` を開くが、better-sqlite3 は同一接続上のネストした
   *   `Database.transaction()` 呼び出しを SAVEPOINT として正しく扱うため、`fn()` の途中で
   *   例外が飛べば SAVEPOINT を含めて丸ごと rollback される（片方だけ確定した窓を作らない）。
   * - `result_json` を書き込む前に例外が飛べば `event_market_ops` には何も残らない。
   *   次の同じ operationId での呼び出しはまっさらな状態から再実行される。
   */
  private runEventOp<T>(
    operationId: string,
    marketId: number,
    kind: "create" | "bet" | "settle" | "void",
    actorId: string,
    fn: () => T,
  ): T {
    if (typeof operationId !== "string" || operationId.trim().length === 0) {
      throw new MarketError("ERR_BAD_AMOUNT", { operationId });
    }
    const replayExisting = (): T | undefined => {
      const existing = this.db
        .prepare("SELECT market_id, kind, actor_id, result_json FROM event_market_ops WHERE operation_id = ?")
        .get(operationId) as { market_id: number; kind: string; actor_id: string; result_json: string } | undefined;
      if (!existing) return undefined;
      // market_id・kind に加えて actor_id も照合する。ここを素通りすると、別の actor が
      // 同じ operationId を使い回すだけで他人の保存済み結果（bet/settle/void の中身）を
      // 受け取れてしまう（監査指摘2）。この閉包は通常経路（後段の replayExisting() 呼び出し）と
      // UNIQUE制約競合後の再読込経路の両方から呼ばれる共通処理なので、ここ一箇所の修正で両方に効く。
      if (existing.market_id !== marketId || existing.kind !== kind || existing.actor_id !== actorId) {
        throw new MarketError("ERR_OPERATION_CONFLICT", {
          operationId,
          existingMarketId: existing.market_id,
          requestedMarketId: marketId,
          existingKind: existing.kind,
          requestedKind: kind,
          existingActorId: existing.actor_id,
          requestedActorId: actorId,
        });
      }
      return JSON.parse(existing.result_json) as T;
    };

    const cached = replayExisting();
    if (cached !== undefined) return cached;

    // IMMEDIATE で始める（chip-tx.ts の runGroup と同じ理由）。遅延トランザクションだと、
    // 後から書き込みへ昇格する時点で SQLITE_BUSY が busy handler を通らずに即失敗しうる
    // （複数接続・複数プロセスで同時に書き込もうとしたとき）。
    const tx = this.db.transaction((): T => {
      const result = fn();
      this.db
        .prepare(
          "INSERT INTO event_market_ops (operation_id, market_id, kind, actor_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(operationId, marketId, kind, actorId, JSON.stringify(result), now());
      return result;
    });
    try {
      return tx.immediate();
    } catch (e) {
      // 上の事前チェック（SELECT）と IMMEDIATE トランザクション開始の間には隙間がある。
      // 複数接続が同じ operationId を同時に叩いた場合、片方が先に確定した直後にもう片方が
      // fn() を実行すると（例: 板の状態が既に変わっていて ERR_NOT_CLOSED 等の業務エラーになる、
      // または event_market_ops.operation_id の PRIMARY KEY 制約違反になる）、
      // それは「自分が失敗した」のではなく「もう一方が正しく確定させた」ことを意味する。
      // 資金グループは runEventOp のトランザクションごと丸ごと rollback 済みなので、
      // ここで確定済みの結果を安全に読み直して返してよい（二重には何も実行していない）。
      const settled = replayExisting();
      if (settled !== undefined) return settled;
      throw e;
    }
  }

  /**
   * イベントLand板を立てる。creator の開設手数料 500Ld → `sys:escrow:market:fees` の徴収と
   * 板の作成を同一の `runEventOp`（＝同一SQLiteトランザクション）で行うので、
   * 「手数料だけ引かれて板が無い」「板はあるが手数料未収」は構造的に起きない。
   * 再送（同じ operationId）は保存済みの Market をそのまま返し、二重徴収しない。
   */
  createEvent(input: {
    guildId: string;
    creatorId: string;
    title: string;
    options: string[];
    durationMin: number;
    payoutMode?: PayoutMode;
    /** Discord role ID の一覧（重複可・ここで正規化する） */
    allowedRoleIds: string[];
    operationId: string;
  }): Market {
    if (input.options.length < 2 || input.options.length > EVENT_MARKET_MAX_OPTIONS) {
      throw new MarketError("ERR_BAD_OPTION", { count: input.options.length });
    }
    if (!Number.isInteger(input.durationMin) || input.durationMin < 1 || input.durationMin > 1440) {
      throw new MarketError("ERR_BAD_AMOUNT", { durationMin: input.durationMin });
    }
    const payoutMode: PayoutMode = input.payoutMode ?? "parimutuel";
    if (payoutMode !== "parimutuel" && payoutMode !== "winner_take_all") {
      throw new MarketError("ERR_BAD_MODE", { payoutMode });
    }
    const roleIds = this.normalizeRoleIds(input.allowedRoleIds);
    const ledger = this.requireLandLedger();
    const t = now();
    const deadline = t + input.durationMin * 60;
    // create には対象 marketId がまだ無い（INSERT で初めて採番される）ので、
    // runEventOp の marketId 引数には固定の sentinel（0・実IDは1始まり）を使う。
    return this.runEventOp(input.operationId, 0, "create", input.creatorId, (): Market => {
      ledger.ensureAccount(EVENT_MARKET_FEES_HOLDER, "system");
      const creatorAccount = `user:${input.creatorId}`;
      const held = ledger.balanceOf(creatorAccount);
      if (held < EVENT_MARKET_CREATE_FEE) {
        throw new MarketError("ERR_INSUFFICIENT_LAND", { held, fee: EVENT_MARKET_CREATE_FEE });
      }
      ledger.transfer({
        from: creatorAccount,
        to: EVENT_MARKET_FEES_HOLDER,
        amount: EVENT_MARKET_CREATE_FEE,
        type: "bet",
        actor: input.creatorId,
        idempotencyKey: `event-market:create-fee:${input.operationId}`,
        reason: "イベント板の開設手数料",
      });
      const info = this.db
        .prepare(
          `INSERT INTO casino_markets
             (guild_id, creator_id, title, options_json, deadline_at, status, payout_mode, fee, fund_mode,
              market_mode, allowed_role_ids_json, approval_mode, currency_mode, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 'escrow', 'event', ?, 'instant', 'land', ?)`,
        )
        .run(
          input.guildId,
          input.creatorId,
          input.title.slice(0, 200),
          JSON.stringify(input.options),
          deadline,
          payoutMode,
          EVENT_MARKET_CREATE_FEE,
          JSON.stringify(roleIds),
          t,
        );
      const id = Number(info.lastInsertRowid);
      ledger.ensureAccount(eventMarketEscrowHolder(id), "system");
      this.events.log("event_market_create", {
        actor: input.creatorId,
        payload: { id, title: input.title, options: input.options, deadline, payoutMode, allowedRoleIds: roleIds },
      });
      return this.get(id)!;
    });
  }

  /**
   * イベントLand板へ賭ける／張り直す。ChipLedger は一切使わず、生 Ledger の
   * `user:<userId>` ⇄ `sys:escrow:market:<marketId>` 間のみで資金を動かす。
   *
   * - roleIds（Discordから渡された「今この利用者が持っているロールID一覧」）と
   *   板の allowed_role_ids_json の積集合が空なら ERR_ROLE_NOT_ALLOWED（Land・bet行とも不変）。
   *   管理者フラグ・作成者フラグによるバイパスは存在しない（呼び出し側にも渡していない）。
   * - amount は「張り直し後の合計額」（既存の標準板 bet() と同じ意味論）。
   * - 個人上限（張り直し後合計）・板全体pot上限は資金移動の**前**に検証する。
   * - 資金整合ガード: 既存 pot がある場合、escrow 残高 === 既存 pot でなければ
   *   資金を一切動かさず例外＋市場を frozen 化する（標準板 bet() と同じ設計）。
   */
  betEventLand(
    marketId: number,
    userId: string,
    roleIds: string[],
    optionIndex: number,
    amount: number,
    operationId: string,
    /**
     * テスト専用フック。張り直しの「旧額返金」直後・「新額徴収」直前に呼ばれる
     * （`refundAllBets` の `_beforeStep` と同じ流儀）。本番呼び出しは省略する。
     * ここで例外を投げると crash window（片方だけ確定した状態）を再現でき、
     * `runEventOp` の transaction ごと全 rollback されることを確認できる。
     */
    _midStepFailure?: () => void,
  ): { previous: number | null; net: number } {
    if (!Number.isInteger(amount) || amount <= 0) throw new MarketError("ERR_BAD_AMOUNT", { amount });
    const ledger = this.requireLandLedger();
    const escHolder = eventMarketEscrowHolder(marketId);
    let freezeRequest: { reason: string; meta: Record<string, unknown> } | null = null;
    try {
      return this.runEventOp(operationId, marketId, "bet", userId, (): { previous: number | null; net: number } => {
        const m = this.get(marketId);
        if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { marketId });
        if (m.market_mode !== "event") throw new MarketError("ERR_NOT_EVENT_MARKET", { marketId, mode: m.market_mode });
        if (m.status !== "open") throw new MarketError("ERR_NOT_OPEN", { marketId, status: m.status });
        if (m.deadline_at <= now()) throw new MarketError("ERR_NOT_OPEN", { marketId, deadline: m.deadline_at });

        const allowedRoleIds = JSON.parse(m.allowed_role_ids_json) as string[];
        const hasRole = roleIds.some((r) => allowedRoleIds.includes(r));
        if (!hasRole) throw new MarketError("ERR_ROLE_NOT_ALLOWED", { marketId, allowedRoleIds, roleIds });

        const options = JSON.parse(m.options_json) as string[];
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
          throw new MarketError("ERR_BAD_OPTION", { optionIndex, count: options.length });
        }

        // ── 資金整合ガード: escrow 残高 === 既存 pot（全ベット合計）を検証 ──
        const existingPot = (
          this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_market_bets WHERE market_id = ?").get(marketId) as {
            s: number;
          }
        ).s;
        if (existingPot > 0) {
          const escBal = ledger.balanceOf(escHolder);
          if (escBal !== existingPot) {
            freezeRequest = { reason: "event_escrow_mismatch_on_bet", meta: { existingPot, escrowBalance: escBal } };
            if (escBal < existingPot) {
              throw new MarketError("ERR_UNDERFUNDED_ESCROW", { marketId, pot: existingPot, escrowBalance: escBal });
            }
            throw new MarketError("ERR_ESCROW_MISMATCH", { marketId, pot: existingPot, escrowBalance: escBal });
          }
        }

        const existingRows = this.db
          .prepare("SELECT amount FROM casino_market_bets WHERE market_id = ? AND user_id = ?")
          .all(marketId, userId) as Array<{ amount: number }>;
        const existingTotal = existingRows.reduce((s, r) => s + r.amount, 0);

        if (amount > EVENT_MARKET_PERSONAL_CAP) {
          throw new MarketError("ERR_PERSONAL_CAP_EXCEEDED", { amount, cap: EVENT_MARKET_PERSONAL_CAP });
        }
        const potAfter = existingPot - existingTotal + amount;
        if (potAfter > EVENT_MARKET_POT_CAP) {
          throw new MarketError("ERR_POT_CAP_EXCEEDED", { potAfter, cap: EVENT_MARKET_POT_CAP });
        }

        const additionalRequired = Math.max(0, amount - existingTotal);
        const userAccount = `user:${userId}`;
        const held = ledger.balanceOf(userAccount);
        if (held < additionalRequired) {
          throw new MarketError("ERR_INSUFFICIENT_LAND", { held, additionalRequired, amount, existingTotal });
        }

        if (existingTotal > 0) {
          // 張り直し: 旧額を escrow → 利用者へ返金してから bet 行を消す
          ledger.transfer({
            from: escHolder,
            to: userAccount,
            amount: existingTotal,
            type: "prize",
            actor: userId,
            idempotencyKey: `event-bet:refund:${operationId}`,
            reason: "イベント板の賭け直しによる返金",
          });
          this.db.prepare("DELETE FROM casino_market_bets WHERE market_id = ? AND user_id = ?").run(marketId, userId);
        }
        _midStepFailure?.();
        // 新額を利用者 → escrow へ徴収
        ledger.transfer({
          from: userAccount,
          to: escHolder,
          amount,
          type: "bet",
          actor: userId,
          idempotencyKey: `event-bet:charge:${operationId}`,
          reason: "イベント板への賭け",
        });
        this.db
          .prepare("INSERT INTO casino_market_bets (market_id, user_id, option_index, amount, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(marketId, userId, optionIndex, amount, now());
        this.events.log("event_market_bet", {
          actor: userId,
          payload: { marketId, optionIndex, amount, previous: existingTotal > 0 ? existingTotal : null },
        });
        return { previous: existingTotal > 0 ? existingTotal : null, net: amount - existingTotal };
      });
    } catch (e) {
      const req = freezeRequest as { reason: string; meta: Record<string, unknown> } | null;
      if (req) this.freeze(marketId, "system:event-bet-guard", req.reason, req.meta);
      throw e;
    }
  }

  /**
   * イベントLand板専用の原子的な結果確定＋精算API。
   *
   * closed のイベント板だけ受理し、creator または運営（isAdmin）だけが呼べる。
   * result_option の保存と Land 精算を同一 `runEventOp` の中で行うので、途中失敗は
   * 全部 rollback（reported へは一切止まらない・approvals 行は作らない・dispute window の
   * scheduler 対象にもならない＝status が reported にならないので構造的に対象外）。
   *
   * 精算前に「Land escrow残高 = casino_market_betsの合計」を完全一致確認し、
   * 不一致なら資金を一切動かさずイベント板を frozen にする。
   *
   * 同じ operationId の再試行（replay）は保存済みの結果をそのまま返すので二重配当しない。
   */
  reportAndSettleEventLand(
    marketId: number,
    actorId: string,
    winningOption: number,
    operationId: string,
    isAdmin = false,
  ): MarketSettleResult {
    const ledger = this.requireLandLedger();
    let freezeRequest: { reason: string; meta: Record<string, unknown> } | null = null;
    try {
      return this.runEventOp(operationId, marketId, "settle", actorId, (): MarketSettleResult => {
        const m = this.get(marketId);
        if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { marketId });
        if (m.market_mode !== "event") throw new MarketError("ERR_NOT_EVENT_MARKET", { marketId, mode: m.market_mode });
        if (!isAdmin && m.creator_id !== actorId) throw new MarketError("ERR_NOT_CREATOR", { creator: m.creator_id, actor: actorId });
        if (m.status !== "closed") throw new MarketError("ERR_NOT_CLOSED", { status: m.status });
        const options = JSON.parse(m.options_json) as string[];
        if (!Number.isInteger(winningOption) || winningOption < 0 || winningOption >= options.length) {
          throw new MarketError("ERR_BAD_OPTION", { winningOption, count: options.length });
        }

        const bets = this.bets(marketId);
        const pot = bets.reduce((s, b) => s + b.amount, 0);
        const escHolder = eventMarketEscrowHolder(marketId);
        const escBal = ledger.balanceOf(escHolder);
        if (escBal !== pot) {
          freezeRequest = { reason: "event_escrow_mismatch_on_settle", meta: { pot, escrowBalance: escBal } };
          throw new MarketError("ERR_ESCROW_MISMATCH", { marketId, pot, escrowBalance: escBal });
        }

        const winners = bets.filter((b) => b.option_index === winningOption);

        // 的中者なし → 全額返金 & void（場代は取らない）
        if (winners.length === 0) {
          for (const b of bets) {
            ledger.transfer({
              from: escHolder,
              to: `user:${b.user_id}`,
              amount: b.amount,
              type: "prize",
              actor: "system:event-market",
              idempotencyKey: `event-settle:refund:${operationId}:${b.user_id}`,
              reason: "イベント板の返金（的中者なし）",
            });
          }
          this.db
            .prepare("UPDATE casino_markets SET status = 'void', result_option = ?, settled_at = ? WHERE id = ?")
            .run(winningOption, now(), marketId);
          this.events.log("event_market_settle_void", { actor: actorId, payload: { id: marketId, pot, winningOption } });
          return {
            id: marketId,
            pot,
            houseCut: 0,
            distributable: 0,
            winnerCount: 0,
            payouts: [],
            mode: m.payout_mode,
            resultOption: winningOption,
            void: true,
          };
        }

        const winnersPot = winners.reduce((s, b) => s + b.amount, 0);
        // 場代（既存 MARKET_HOUSE_CUT の3%）。単独配当が承認閾値(既定100万Ld)を超えないことは
        // pot上限90万Ldから計算上保証される（900,000 × 0.97 = 873,000 < 1,000,000）。
        // テストで数値的に裏付ける（casino-market-land-event.test.ts）。
        const houseCut = Math.floor(pot * HOUSE_CUT);
        if (houseCut > 0) {
          ledger.transfer({
            from: escHolder,
            to: EVENT_MARKET_FEES_HOLDER,
            amount: houseCut,
            type: "market_house_fee",
            actor: "system:event-market",
            idempotencyKey: `event-settle:fee:${operationId}`,
            reason: "イベント板の場代",
          });
        }
        const distributable = pot - houseCut;

        const payouts: Array<{ userId: string; amount: number }> = [];
        if (m.payout_mode === "parimutuel") {
          let remaining = distributable;
          for (let i = 0; i < winners.length; i++) {
            const w = winners[i]!;
            const isLast = i === winners.length - 1;
            const share = isLast ? remaining : Math.floor((distributable * w.amount) / winnersPot);
            if (share > 0) {
              ledger.transfer({
                from: escHolder,
                to: `user:${w.user_id}`,
                amount: share,
                type: "prize",
                actor: "system:event-market",
                idempotencyKey: `event-settle:prize:${operationId}:${i}:${w.user_id}`,
                reason: "イベント板の配当",
              });
            }
            remaining -= share;
            payouts.push({ userId: w.user_id, amount: share });
          }
        } else {
          const uniqueWinners = Array.from(new Set(winners.map((w) => w.user_id)));
          const per = Math.floor(distributable / uniqueWinners.length);
          const leftover = distributable - per * uniqueWinners.length;
          for (let i = 0; i < uniqueWinners.length; i++) {
            const uid = uniqueWinners[i]!;
            const share = i === 0 ? per + leftover : per;
            if (share > 0) {
              ledger.transfer({
                from: escHolder,
                to: `user:${uid}`,
                amount: share,
                type: "prize",
                actor: "system:event-market",
                idempotencyKey: `event-settle:prize:${operationId}:${i}:${uid}`,
                reason: "イベント板の配当",
              });
            }
            payouts.push({ userId: uid, amount: share });
          }
        }

        // 通算損益（onPlayerNet）はここでは呼ばない: casino chip 経済の戦績集計は
        // ChipLedger 保有者ID（sys:/system:/escrow: を除く裸ID）を前提にしており、
        // Land 経済とは別レイヤー（追加アーキ指針§E）。混ぜると chip 側の戦績が
        // Land の勝敗で汚染されるため、意図的に呼ばない。

        this.db
          .prepare("UPDATE casino_markets SET status = 'settled', result_option = ?, settled_at = ? WHERE id = ?")
          .run(winningOption, now(), marketId);
        this.events.log("event_market_settle", {
          actor: actorId,
          payload: { id: marketId, pot, houseCut, winnerCount: winners.length, mode: m.payout_mode, winningOption },
        });
        return {
          id: marketId,
          pot,
          houseCut,
          distributable,
          winnerCount: winners.length,
          payouts,
          mode: m.payout_mode,
          resultOption: winningOption,
          void: false,
        };
      });
    } catch (e) {
      const req = freezeRequest as { reason: string; meta: Record<string, unknown> } | null;
      if (req) this.freeze(marketId, "system:event-settle-guard", req.reason, req.meta);
      throw e;
    }
  }

  /**
   * イベントLand板の管理者無効化: 全額Land返金 → void。
   *
   * open または closed のイベント板だけ対象。すでに settled/void なら
   * `alreadyClosed: true`（資金は動かさない）を返す（標準板 refund() と同じ設計）。
   * frozen・disputed・reported（構造上イベント板には出現しない）は ERR_NOT_OPEN で拒否し、
   * 「凍結中の市場を自動で無効化・返金する」経路を作らない（運営の手動調査を待つ）。
   *
   * 部分返金後に例外が飛べば `runEventOp` の `db.transaction()` ごと全rollbackされる。
   * escrow 残高と pot が不一致なら資金を動かさず frozen 化する。
   */
  adminVoidEventLand(marketId: number, actorId: string, operationId: string): MarketRefundResult {
    const ledger = this.requireLandLedger();
    let freezeRequest: { reason: string; meta: Record<string, unknown> } | null = null;
    try {
      return this.runEventOp(operationId, marketId, "void", actorId, (): MarketRefundResult => {
        const m = this.get(marketId);
        if (!m) throw new MarketError("ERR_UNKNOWN_MARKET", { marketId });
        if (m.market_mode !== "event") throw new MarketError("ERR_NOT_EVENT_MARKET", { marketId, mode: m.market_mode });
        if (m.status === "settled" || m.status === "void") {
          return { id: marketId, refunded: 0, users: 0, alreadyClosed: true };
        }
        if (m.status !== "open" && m.status !== "closed") {
          throw new MarketError("ERR_NOT_OPEN", { marketId, status: m.status });
        }

        const bets = this.bets(marketId);
        const pot = bets.reduce((s, b) => s + b.amount, 0);
        const escHolder = eventMarketEscrowHolder(marketId);
        const escBal = ledger.balanceOf(escHolder);
        if (escBal !== pot) {
          freezeRequest = { reason: "event_escrow_mismatch_on_void", meta: { pot, escrowBalance: escBal } };
          throw new MarketError("ERR_ESCROW_MISMATCH", { marketId, pot, escrowBalance: escBal });
        }

        for (const b of bets) {
          ledger.transfer({
            from: escHolder,
            to: `user:${b.user_id}`,
            amount: b.amount,
            type: "prize",
            actor: "system:event-market",
            idempotencyKey: `event-void:refund:${operationId}:${b.user_id}`,
            reason: "イベント板の無効化による返金",
          });
        }
        this.db.prepare("UPDATE casino_markets SET status = 'void', settled_at = ? WHERE id = ?").run(now(), marketId);
        this.events.log("event_market_admin_void", { actor: actorId, payload: { id: marketId, refunded: pot, users: bets.length } });
        return { id: marketId, refunded: pot, users: bets.length, alreadyClosed: false };
      });
    } catch (e) {
      const req = freezeRequest as { reason: string; meta: Record<string, unknown> } | null;
      if (req) this.freeze(marketId, "system:event-void-guard", req.reason, req.meta);
      throw e;
    }
  }

  /**
   * ⚠️ 明示的な管理者操作専用。通常のBot起動経路（`buildServices()`）から呼び出さないこと。
   *
   * market_mode='event' の未精算板（open/closed）を全部 Land 全額返金 & void。
   * frozen は対象外（既存同様・運営の手動調査を待つ）。settled/void はそもそも対象外。
   * 個別の板でエラーが出ても他の板を止めない。operationId は marketId から導出する
   * 安定値にして、再起動のたびに同じ板を二重返金しない（時刻を混ぜない）。
   *
   * 監査指摘1（PR#94独立監査）: 以前はこの関数を無条件に Bot 起動時へ配線していたため、
   * deploy・クラッシュ・自動再起動のたびに**正常な進行中イベント板**まで全額返金・void化
   * されてしまうバグがあった。通常起動からは資金を一切動かさない `auditPendingEventLand()`
   * を呼ぶこと。この関数は将来の明示的な管理者操作（運営コマンド等）用に残す。
   */
  adminRefundAllPendingEventLand(actor: string): {
    total: number;
    refunded: number;
    frozen: number;
    failed: Array<{ id: number; error: string }>;
  } {
    const rows = this.db
      .prepare("SELECT id FROM casino_markets WHERE market_mode = 'event' AND status IN ('open','closed')")
      .all() as Array<{ id: number }>;
    let refunded = 0;
    let frozen = 0;
    const failed: Array<{ id: number; error: string }> = [];
    for (const r of rows) {
      try {
        this.adminVoidEventLand(r.id, actor, `event-startup-void:${r.id}`);
        refunded++;
      } catch (e) {
        const err = e instanceof MarketError ? `${e.code}:${JSON.stringify(e.meta)}` : (e as Error).message;
        failed.push({ id: r.id, error: err });
        // adminVoidEventLand 内の catch で ERR_ESCROW_MISMATCH は既に frozen 化されている。
        // ここでの再カウントは frozen 化が実際に効いたかを確認してから行う。
        const fresh = this.get(r.id);
        if (fresh?.status === "frozen") frozen++;
        this.events.log("event_market_refund_failed", { actor, payload: { id: r.id, error: err } });
      }
    }
    return { total: rows.length, refunded, frozen, failed };
  }

  /**
   * 起動時: market_mode='event' の未精算板（open/closed）を**監査するだけ**の読み取り専用API。
   * 資金・statusを一切変更しない（監査指摘1・PR#94独立監査）。
   *
   * 各板について `casino_market_bets` の合計（pot）と `eventMarketEscrowHolder(id)` の
   * Land残高を突き合わせる。
   * - 一致（0=0を含む）: 健全。status・bet行・Land残高・event_market_opsのいずれも変更しない。
   *   open/closedのまま維持するので、再起動後もイベントは継続できる。
   * - 不一致: Landを一切動かさず、既存の `freeze()`（bet()の資金整合ガードで使われている
   *   独立トランザクション）で status を frozen にする。理由・pot・escrowBalance・marketId
   *   を event ログのメタ情報として残す。
   *
   * 冪等性: frozen化した板は次回以降 `status IN ('open','closed')` の対象から自然に外れるため、
   * 監査を繰り返しても再度書き込まない。健全な板はそもそも一切書き込まない。
   *
   * 個別の板で例外が出ても他の板の処理は続ける（`adminRefundAllPendingEventLand()` と同じ
   * 「1件の失敗で全体を止めない」流儀）。
   */
  auditPendingEventLand(actor: string): {
    total: number;
    healthy: number;
    frozen: number;
    failed: Array<{ id: number; error: string }>;
  } {
    const ledger = this.requireLandLedger();
    const rows = this.db
      .prepare("SELECT id FROM casino_markets WHERE market_mode = 'event' AND status IN ('open','closed')")
      .all() as Array<{ id: number }>;
    let healthy = 0;
    let frozen = 0;
    const failed: Array<{ id: number; error: string }> = [];
    for (const r of rows) {
      try {
        const pot = (
          this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM casino_market_bets WHERE market_id = ?").get(r.id) as {
            s: number;
          }
        ).s;
        const escBal = ledger.balanceOf(eventMarketEscrowHolder(r.id));
        if (escBal === pot) {
          healthy++;
          continue;
        }
        // 不一致: Landは一切動かさず frozen 化するだけ（返金・void はしない）。
        this.freeze(r.id, actor, "event_escrow_mismatch_on_audit", { pot, escrowBalance: escBal, marketId: r.id });
        frozen++;
      } catch (e) {
        const err = e instanceof MarketError ? `${e.code}:${JSON.stringify(e.meta)}` : (e as Error).message;
        failed.push({ id: r.id, error: err });
        this.events.log("event_market_audit_failed", { actor, payload: { id: r.id, error: err } });
      }
    }
    return { total: rows.length, healthy, frozen, failed };
  }
}

/** 返金・無効化の結果。同じ操作の再試行はこの値がそのまま再生される */
export interface MarketRefundResult {
  id: number;
  /** 返した総額 */
  refunded: number;
  /** 返金した人数 */
  users: number;
  /** すでに settled / void だったので何もしなかった */
  alreadyClosed: boolean;
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
