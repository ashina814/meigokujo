import type Database from "better-sqlite3";
import { ChipLedger, ChipLedgerError, isPlayerHolder } from "./chip-ledger.js";
import { escrowHolderFor } from "./escrow.js";
import { MARKET_LIVE_STATUSES, marketEscrowHolder } from "./market.js";

export interface UserChipAssets {
  userId: string;
  /** いま賭場で使えるチップ。 */
  freeChips: number;
  /** 卓・板に拘束され、返還または精算を待つチップ。 */
  escrowed: number;
  /** 自由チップ + 利用者帰属が確定している拘束チップ。 */
  total: number;
}

export type EscrowAssetSourceKind = "session" | "market";

export interface EscrowAssetRow {
  userId: string;
  holder: string;
  amount: number;
  sourceKind: EscrowAssetSourceKind;
  sourceId: string;
}

export type EscrowAssetMismatchCode =
  | "balance_mismatch"
  | "missing_ledger_rows"
  | "unknown_escrow_holder"
  | "invalid_legacy_source"
  | "duplicate_ownership"
  | "corrupt_amount"
  | "schema_incomplete"
  | "invalid_user_id"
  | "unknown_market_status"
  | "invalid_fund_mode";

export interface EscrowAssetMismatch {
  code: EscrowAssetMismatchCode;
  holder: string;
  expected: number | null;
  actual: number | null;
  sourceKind?: EscrowAssetSourceKind;
  sourceId?: string;
  userId?: string;
  detail?: string;
}

export interface EscrowAssetVerification {
  ok: boolean;
  mismatches: EscrowAssetMismatch[];
}

interface EscrowAssetSnapshot extends EscrowAssetVerification {
  rows: EscrowAssetRow[];
  byUser: Map<string, number>;
}

interface RawSessionRow {
  session_id: unknown;
  user_id: unknown;
  amount: unknown;
  source: unknown;
}

interface RawMarketRow {
  id: unknown;
  status: unknown;
  fund_mode: unknown;
}

interface RawMarketBetRow {
  market_id: unknown;
  user_id: unknown;
  amount: unknown;
}

interface RawBalanceRow {
  user_id: unknown;
  amount: unknown;
}

const SESSION_PREFIX = "escrow:session:";
const MARKET_PREFIX = "escrow:market:";
const TERMINAL_MARKET_STATUSES: ReadonlySet<string> = new Set(["settled", "void"]);
const LIVE_MARKET_STATUSES: ReadonlySet<string> = new Set(MARKET_LIVE_STATUSES);
const RESERVED_USER_IDS: ReadonlySet<string> = new Set([
  "house",
  "jackpot",
  "relief",
  "quarantine",
  "house_escrow_legacy",
]);

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function checkedAdd(left: number, right: number, field: string, meta: Record<string, unknown> = {}): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ChipLedgerError("ERR_CORRUPT_BALANCE", { field, left, right, value, ...meta });
  }
  return value;
}

function mismatchKey(row: EscrowAssetMismatch): string {
  return [
    row.code,
    row.holder,
    row.sourceKind ?? "",
    row.sourceId ?? "",
    row.userId ?? "",
    row.detail ?? "",
  ].join("\u0000");
}

/**
 * 利用者視点のチップ残高（PR9）。
 *
 * - freeChips: `userId` holder にあり、いま利用できるチップ
 * - escrowed: 現行の卓・板台帳と実holder残高が一致し、本人帰属を一意に決められる拘束額
 * - total: freeChips + escrowed
 *
 * 旧 `source='house'`、未知形式、帳簿不一致、孤児holder、破損schema/金額は推測配分しない。
 * 読み取りAPIは自動返金・隔離・migrationを一切行わない。
 */
export class CasinoChipAssets {
  constructor(
    private readonly db: Database.Database,
    private readonly chips: ChipLedger,
  ) {}

  freeChips(userId: string): number {
    this.assertUserId(userId);
    // `ChipLedger.freeChips()` は balanceOf の読み取り別名に留め、この集約層だけが使用する。
    return this.chips.freeChips(userId);
  }

  escrowed(userId: string): number {
    this.assertUserId(userId);
    return this.readSnapshot(() => {
      const snapshot = this.inspectEscrowed();
      this.assertVerifiable(snapshot);
      return snapshot.byUser.get(userId) ?? 0;
    });
  }

  forUser(userId: string): UserChipAssets {
    this.assertUserId(userId);
    return this.readSnapshot(() => {
      // 自由残高と拘束台帳を同一 SQLite スナップショットで読む。
      const freeChips = this.chips.freeChips(userId);
      const snapshot = this.inspectEscrowed();
      this.assertVerifiable(snapshot);
      const escrowed = snapshot.byUser.get(userId) ?? 0;
      const total = checkedAdd(freeChips, escrowed, "userTotal", { userId });
      return { userId, freeChips, escrowed, total };
    });
  }

  /**
   * 拘束チップを双方向に照合する。
   *
   * - 帳簿 → 実残高: holder別帳簿合計と実残高が一致すること
   * - 実残高 → 帳簿: 利用者預託holderに正の残高があるなら対応帳簿があること
   *
   * 不一致を補填・返金・隔離せず、理由コード付きで返す。
   */
  verifyEscrowed(): EscrowAssetVerification {
    return this.readSnapshot(() => {
      const { ok, mismatches } = this.inspectEscrowed();
      return { ok, mismatches };
    });
  }

  private readSnapshot<T>(read: () => T): T {
    if (this.db.inTransaction) return read();
    return this.db.transaction(read).deferred();
  }

  private assertUserId(userId: unknown): asserts userId is string {
    const valid =
      typeof userId === "string" &&
      userId.length > 0 &&
      userId.trim() === userId &&
      !userId.startsWith("user:") &&
      !RESERVED_USER_IDS.has(userId) &&
      isPlayerHolder(userId);
    if (!valid) throw new ChipLedgerError("ERR_BAD_IDENTIFIER", { field: "userId", userId });
  }

  private assertVerifiable(snapshot: EscrowAssetSnapshot): void {
    if (snapshot.ok) return;
    throw new ChipLedgerError("ERR_CORRUPT_BALANCE", {
      field: "escrowed",
      mismatches: snapshot.mismatches,
    });
  }

  private inspectEscrowed(): EscrowAssetSnapshot {
    const mismatches: EscrowAssetMismatch[] = [];
    const rows: EscrowAssetRow[] = [];
    const expectedByHolder = new Map<string, number>();
    const byUser = new Map<string, number>();
    const invalidHolders = new Set<string>();
    const invalidUsers = new Set<string>();

    const addMismatch = (mismatch: EscrowAssetMismatch): void => {
      mismatches.push(mismatch);
    };

    const knownUsers = this.knownUserIds(addMismatch);
    const addAsset = (row: EscrowAssetRow): void => {
      rows.push(row);
      try {
        expectedByHolder.set(
          row.holder,
          checkedAdd(expectedByHolder.get(row.holder) ?? 0, row.amount, "holderExpected", {
            holder: row.holder,
            sourceKind: row.sourceKind,
            sourceId: row.sourceId,
          }),
        );
      } catch (error) {
        invalidHolders.add(row.holder);
        addMismatch({
          code: "corrupt_amount",
          holder: row.holder,
          expected: null,
          actual: null,
          sourceKind: row.sourceKind,
          sourceId: row.sourceId,
          userId: row.userId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        byUser.set(
          row.userId,
          checkedAdd(byUser.get(row.userId) ?? 0, row.amount, "userEscrowed", {
            userId: row.userId,
          }),
        );
      } catch (error) {
        invalidUsers.add(row.userId);
        addMismatch({
          code: "corrupt_amount",
          holder: row.holder,
          expected: null,
          actual: null,
          sourceKind: row.sourceKind,
          sourceId: row.sourceId,
          userId: row.userId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    };

    this.readSessionRows(knownUsers, addMismatch, addAsset);
    this.readMarketRows(knownUsers, addMismatch, addAsset);

    for (const userId of invalidUsers) byUser.delete(userId);

    const actualByHolder = this.readEscrowBalances(addMismatch);
    const compared = new Set<string>();

    for (const [holder, expected] of expectedByHolder) {
      compared.add(holder);
      if (invalidHolders.has(holder)) continue;
      const actual = actualByHolder.get(holder) ?? 0;
      if (expected !== actual) {
        const description = this.describeHolder(holder);
        addMismatch({
          code: "balance_mismatch",
          holder,
          expected,
          actual,
          ...(description ?? {}),
        });
      }
    }

    for (const [holder, actual] of actualByHolder) {
      if (actual <= 0 || compared.has(holder)) continue;
      const description = this.describeHolder(holder);
      if (description) {
        addMismatch({
          code: "missing_ledger_rows",
          holder,
          expected: 0,
          actual,
          ...description,
          detail: "escrow holder に正の残高があるが、対応する本人帰属帳簿がない",
        });
      } else {
        addMismatch({
          code: "unknown_escrow_holder",
          holder,
          expected: null,
          actual,
          detail: "利用者預託として分類できない escrow:* holder",
        });
      }
    }

    const unique = new Map<string, EscrowAssetMismatch>();
    for (const mismatch of mismatches) unique.set(mismatchKey(mismatch), mismatch);
    const sorted = [...unique.values()].sort((a, b) => mismatchKey(a).localeCompare(mismatchKey(b)));
    return { ok: sorted.length === 0, mismatches: sorted, rows, byUser };
  }

  private knownUserIds(
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
  ): Set<string> | null {
    if (!this.requireColumns("accounts", ["id", "kind"], addMismatch)) return null;
    const rows = this.db
      .prepare("SELECT id FROM accounts WHERE kind = 'user' AND id LIKE 'user:%'")
      .all() as Array<{ id: unknown }>;
    const users = new Set<string>();
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id.startsWith("user:") || row.id.length <= "user:".length) {
        addMismatch({
          code: "invalid_user_id",
          holder: "accounts",
          expected: null,
          actual: null,
          detail: `不正な利用者口座ID: ${String(row.id)}`,
        });
        continue;
      }
      const userId = row.id.slice("user:".length);
      if (userId.startsWith("user:") || RESERVED_USER_IDS.has(userId) || !isPlayerHolder(userId)) {
        addMismatch({
          code: "invalid_user_id",
          holder: row.id,
          expected: null,
          actual: null,
          userId,
          detail: "利用者口座がsystem/escrow/二重prefix形式",
        });
        continue;
      }
      users.add(userId);
    }
    return users;
  }

  private readSessionRows(
    knownUsers: ReadonlySet<string> | null,
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
    addAsset: (row: EscrowAssetRow) => void,
  ): void {
    const columns = this.tableColumns("casino_escrow");
    if (columns === null) return;
    const required = ["session_id", "user_id", "amount", "source"];
    if (!this.hasColumns(columns, required)) {
      addMismatch({
        code: "schema_incomplete",
        holder: "casino_escrow",
        expected: null,
        actual: null,
        detail: `必要列不足: ${required.filter((column) => !columns.has(column)).join(",")}`,
      });
      return;
    }

    const rawRows = this.db
      .prepare("SELECT session_id, user_id, amount, source FROM casino_escrow")
      .all() as RawSessionRow[];
    const ownership = new Set<string>();
    for (const raw of rawRows) {
      const sourceId = typeof raw.session_id === "string" ? raw.session_id : String(raw.session_id);
      const userId = typeof raw.user_id === "string" ? raw.user_id : String(raw.user_id);
      const canonicalHolder =
        typeof raw.session_id === "string" && raw.session_id.length > 0
          ? escrowHolderFor(raw.session_id)
          : "casino_escrow";

      if (
        typeof raw.session_id !== "string" ||
        raw.session_id.length === 0 ||
        typeof raw.user_id !== "string" ||
        raw.user_id.length === 0 ||
        !knownUsers?.has(raw.user_id)
      ) {
        addMismatch({
          code: "invalid_user_id",
          holder: canonicalHolder,
          expected: null,
          actual: null,
          sourceKind: "session",
          sourceId,
          userId,
          detail: "session・user・Land利用者口座の関係を確定できない",
        });
        continue;
      }
      if (!isSafePositiveInteger(raw.amount)) {
        addMismatch({
          code: "corrupt_amount",
          holder: canonicalHolder,
          expected: null,
          actual: typeof raw.amount === "number" ? raw.amount : null,
          sourceKind: "session",
          sourceId: raw.session_id,
          userId: raw.user_id,
          detail: "casino_escrow.amount が正のsafe integerではない",
        });
        continue;
      }
      if (typeof raw.source !== "string" || raw.source !== canonicalHolder) {
        addMismatch({
          code: "invalid_legacy_source",
          holder: typeof raw.source === "string" ? raw.source : canonicalHolder,
          expected: raw.amount,
          actual: null,
          sourceKind: "session",
          sourceId: raw.session_id,
          userId: raw.user_id,
          detail:
            raw.source === "house"
              ? "legacy source='house' は混在勘定のため本人資産へ配分しない"
              : `source が canonical holder ${canonicalHolder} と一致しない`,
        });
        continue;
      }

      const key = `${raw.session_id}\u0000${raw.user_id}`;
      if (ownership.has(key)) {
        addMismatch({
          code: "duplicate_ownership",
          holder: canonicalHolder,
          expected: raw.amount,
          actual: null,
          sourceKind: "session",
          sourceId: raw.session_id,
          userId: raw.user_id,
          detail: "同一session・userの預託行が複数ある",
        });
        continue;
      }
      ownership.add(key);
      addAsset({
        userId: raw.user_id,
        holder: canonicalHolder,
        amount: raw.amount,
        sourceKind: "session",
        sourceId: raw.session_id,
      });
    }
  }

  private readMarketRows(
    knownUsers: ReadonlySet<string> | null,
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
    addAsset: (row: EscrowAssetRow) => void,
  ): void {
    const marketColumns = this.tableColumns("casino_markets");
    const betColumns = this.tableColumns("casino_market_bets");
    if (marketColumns === null && betColumns === null) return;
    if (marketColumns === null || betColumns === null) {
      addMismatch({
        code: "schema_incomplete",
        holder: marketColumns === null ? "casino_markets" : "casino_market_bets",
        expected: null,
        actual: null,
        detail: "casino_markets と casino_market_bets は両方必要",
      });
      return;
    }

    const requiredMarkets = ["id", "status", "fund_mode"];
    const requiredBets = ["market_id", "user_id", "amount"];
    if (!this.hasColumns(marketColumns, requiredMarkets) || !this.hasColumns(betColumns, requiredBets)) {
      const missing = [
        ...requiredMarkets.filter((column) => !marketColumns.has(column)).map((column) => `casino_markets.${column}`),
        ...requiredBets.filter((column) => !betColumns.has(column)).map((column) => `casino_market_bets.${column}`),
      ];
      addMismatch({
        code: "schema_incomplete",
        holder: "casino_markets/casino_market_bets",
        expected: null,
        actual: null,
        detail: `必要列不足: ${missing.join(",")}`,
      });
      return;
    }

    const markets = this.db.prepare("SELECT id, status, fund_mode FROM casino_markets").all() as RawMarketRow[];
    const byId = new Map<number, { status: string; fundMode: string }>();
    for (const raw of markets) {
      if (
        !isSafePositiveInteger(raw.id) ||
        typeof raw.status !== "string" ||
        typeof raw.fund_mode !== "string"
      ) {
        addMismatch({
          code: "schema_incomplete",
          holder: "casino_markets",
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.id),
          detail: "market id/status/fund_mode の型が不正",
        });
        continue;
      }
      if (byId.has(raw.id)) {
        addMismatch({
          code: "duplicate_ownership",
          holder: marketEscrowHolder(raw.id),
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.id),
          detail: "同一market idが複数ある",
        });
        continue;
      }
      if (!LIVE_MARKET_STATUSES.has(raw.status) && !TERMINAL_MARKET_STATUSES.has(raw.status)) {
        addMismatch({
          code: "unknown_market_status",
          holder: marketEscrowHolder(raw.id),
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.id),
          detail: `未知のstatus: ${raw.status}`,
        });
      }
      if (raw.fund_mode !== "escrow" && raw.fund_mode !== "legacy_house") {
        addMismatch({
          code: "invalid_fund_mode",
          holder: marketEscrowHolder(raw.id),
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.id),
          detail: `未知のfund_mode: ${raw.fund_mode}`,
        });
      }
      byId.set(raw.id, { status: raw.status, fundMode: raw.fund_mode });
    }

    const bets = this.db
      .prepare("SELECT market_id, user_id, amount FROM casino_market_bets")
      .all() as RawMarketBetRow[];
    const ownership = new Set<string>();
    const legacyReported = new Set<number>();
    for (const raw of bets) {
      if (!isSafePositiveInteger(raw.market_id)) {
        addMismatch({
          code: "missing_ledger_rows",
          holder: "casino_market_bets",
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.market_id),
          detail: "betのmarket_idが正のsafe integerではない",
        });
        continue;
      }
      const holder = marketEscrowHolder(raw.market_id);
      const market = byId.get(raw.market_id);
      if (!market) {
        addMismatch({
          code: "missing_ledger_rows",
          holder,
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.market_id),
          userId: typeof raw.user_id === "string" ? raw.user_id : String(raw.user_id),
          detail: "対応するcasino_markets行がないbet",
        });
        continue;
      }
      // 終端状態では bet 行が残る設計だが、資金はholderから払い出し済みなので集計しない。
      if (TERMINAL_MARKET_STATUSES.has(market.status)) continue;
      // 未知status/fund_modeは上で不一致として記録済み。利用者へは推測配分しない。
      if (!LIVE_MARKET_STATUSES.has(market.status)) continue;
      if (market.fundMode === "legacy_house") {
        if (!legacyReported.has(raw.market_id)) {
          legacyReported.add(raw.market_id);
          addMismatch({
            code: "invalid_legacy_source",
            holder: "house",
            expected: null,
            actual: null,
            sourceKind: "market",
            sourceId: String(raw.market_id),
            detail: "legacy_house板はhouse混在勘定のため本人資産へ配分しない",
          });
        }
        continue;
      }
      if (market.fundMode !== "escrow") continue;
      if (
        typeof raw.user_id !== "string" ||
        raw.user_id.length === 0 ||
        !knownUsers?.has(raw.user_id)
      ) {
        addMismatch({
          code: "invalid_user_id",
          holder,
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.market_id),
          userId: typeof raw.user_id === "string" ? raw.user_id : String(raw.user_id),
          detail: "betの本人帰属をLand利用者口座から確定できない",
        });
        continue;
      }
      if (!isSafePositiveInteger(raw.amount)) {
        addMismatch({
          code: "corrupt_amount",
          holder,
          expected: null,
          actual: typeof raw.amount === "number" ? raw.amount : null,
          sourceKind: "market",
          sourceId: String(raw.market_id),
          userId: raw.user_id,
          detail: "casino_market_bets.amount が正のsafe integerではない",
        });
        continue;
      }

      const key = `${raw.market_id}\u0000${raw.user_id}`;
      if (ownership.has(key)) {
        addMismatch({
          code: "duplicate_ownership",
          holder,
          expected: raw.amount,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.market_id),
          userId: raw.user_id,
          detail: "同一market・userのbet行が複数ある",
        });
        continue;
      }
      ownership.add(key);
      addAsset({
        userId: raw.user_id,
        holder,
        amount: raw.amount,
        sourceKind: "market",
        sourceId: String(raw.market_id),
      });
    }
  }

  private readEscrowBalances(
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
  ): Map<string, number> {
    if (!this.requireColumns("ether_balances", ["user_id", "amount"], addMismatch)) return new Map();
    const rows = this.db
      .prepare("SELECT user_id, amount FROM ether_balances WHERE user_id LIKE 'escrow:%'")
      .all() as RawBalanceRow[];
    const balances = new Map<string, number>();
    for (const row of rows) {
      if (typeof row.user_id !== "string" || row.user_id.length === 0) {
        addMismatch({
          code: "unknown_escrow_holder",
          holder: String(row.user_id),
          expected: null,
          actual: typeof row.amount === "number" ? row.amount : null,
          detail: "holder IDが文字列ではない",
        });
        continue;
      }
      if (!isSafeNonNegativeInteger(row.amount)) {
        addMismatch({
          code: "corrupt_amount",
          holder: row.user_id,
          expected: null,
          actual: typeof row.amount === "number" ? row.amount : null,
          detail: "holder実残高が非負のsafe integerではない",
        });
        continue;
      }
      balances.set(row.user_id, row.amount);
    }
    return balances;
  }

  private describeHolder(
    holder: string,
  ): { sourceKind: EscrowAssetSourceKind; sourceId: string } | null {
    if (holder.startsWith(SESSION_PREFIX)) {
      const sourceId = holder.slice(SESSION_PREFIX.length);
      return sourceId.length > 0 ? { sourceKind: "session", sourceId } : null;
    }
    if (holder.startsWith(MARKET_PREFIX)) {
      const sourceId = holder.slice(MARKET_PREFIX.length);
      const id = Number(sourceId);
      return Number.isSafeInteger(id) && id > 0 && String(id) === sourceId
        ? { sourceKind: "market", sourceId }
        : null;
    }
    return null;
  }

  private tableColumns(table: string): Set<string> | null {
    const exists = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) return null;
    return new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
  }

  private requireColumns(
    table: string,
    required: readonly string[],
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
  ): boolean {
    const columns = this.tableColumns(table);
    if (columns && this.hasColumns(columns, required)) return true;
    addMismatch({
      code: "schema_incomplete",
      holder: table,
      expected: null,
      actual: null,
      detail:
        columns === null
          ? "必要tableが存在しない"
          : `必要列不足: ${required.filter((column) => !columns.has(column)).join(",")}`,
    });
    return false;
  }

  private hasColumns(columns: ReadonlySet<string>, required: readonly string[]): boolean {
    return required.every((column) => columns.has(column));
  }
}
