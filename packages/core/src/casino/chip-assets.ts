import type Database from "better-sqlite3";
import { ChipLedger, ChipLedgerError, isPlayerHolder } from "./chip-ledger.js";
import { escrowHolderFor } from "./escrow.js";
import { MARKET_LIVE_STATUSES, marketEscrowHolder } from "./market.js";

export interface UserChipAssets {
  userId: string;
  freeChips: number;
  escrowed: number;
  total: number;
}

export type EscrowAssetSourceKind = "session" | "market";
export type EscrowAssetMismatchScope = "global" | "holder" | "user";

export interface EscrowAssetRow {
  userId: string;
  holder: string;
  amount: number;
  sourceKind: EscrowAssetSourceKind;
  sourceId: string;
}

export interface EscrowAssetHolderTotal {
  holder: string;
  expected: number;
  userIds: readonly string[];
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
  scope: EscrowAssetMismatchScope;
  affectedUserIds?: readonly string[];
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

export interface EscrowAssetInspection extends EscrowAssetVerification {
  rows: readonly EscrowAssetRow[];
  holders: readonly EscrowAssetHolderTotal[];
  knownUserIds: readonly string[];
}

interface EscrowAssetSnapshot extends EscrowAssetInspection {
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

interface MarketRecord {
  id: number;
  status: string;
  fundMode: string;
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

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function mismatchKey(row: EscrowAssetMismatch): string {
  return [
    row.code,
    row.scope,
    row.holder,
    row.sourceKind ?? "",
    row.sourceId ?? "",
    row.userId ?? "",
    (row.affectedUserIds ?? []).join(","),
    row.detail ?? "",
  ].join("\u0000");
}

export class CasinoChipAssets {
  constructor(
    private readonly db: Database.Database,
    private readonly chips: ChipLedger,
  ) {}

  freeChips(userId: string): number {
    this.assertUserId(userId);
    return this.chips.freeChips(userId);
  }

  escrowed(userId: string): number {
    this.assertUserId(userId);
    return this.readSnapshot(() => {
      const snapshot = this.buildSnapshot();
      this.assertVerifiableForUser(snapshot, userId);
      return snapshot.byUser.get(userId) ?? 0;
    });
  }

  forUser(userId: string): UserChipAssets {
    this.assertUserId(userId);
    return this.readSnapshot(() => {
      const freeChips = this.chips.freeChips(userId);
      const snapshot = this.buildSnapshot();
      this.assertVerifiableForUser(snapshot, userId);
      const escrowed = snapshot.byUser.get(userId) ?? 0;
      const total = checkedAdd(freeChips, escrowed, "userTotal", { userId });
      return { userId, freeChips, escrowed, total };
    });
  }

  verifyEscrowed(): EscrowAssetVerification {
    return this.readSnapshot(() => {
      const { ok, mismatches } = this.buildSnapshot();
      return { ok, mismatches };
    });
  }

  inspectEscrowed(): EscrowAssetInspection {
    return this.readSnapshot(() => {
      const { ok, mismatches, rows, holders, knownUserIds } = this.buildSnapshot();
      return { ok, mismatches, rows, holders, knownUserIds };
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

  private assertVerifiableForUser(snapshot: EscrowAssetSnapshot, userId: string): void {
    const relevant = snapshot.mismatches.filter((mismatch) => {
      if (mismatch.scope === "global") return true;
      if (mismatch.affectedUserIds?.includes(userId)) return true;
      return mismatch.scope === "user" && mismatch.userId === userId;
    });
    if (relevant.length === 0) return;
    throw new ChipLedgerError("ERR_CORRUPT_BALANCE", {
      field: "escrowed",
      userId,
      mismatches: relevant,
    });
  }

  private buildSnapshot(): EscrowAssetSnapshot {
    const mismatches: EscrowAssetMismatch[] = [];
    const rows: EscrowAssetRow[] = [];
    const expectedByHolder = new Map<string, number>();
    const usersByHolder = new Map<string, Set<string>>();
    const byUser = new Map<string, number>();
    const invalidHolders = new Set<string>();
    const invalidUsers = new Set<string>();

    const addMismatch = (input: EscrowAssetMismatch): void => {
      const affectedUserIds = input.affectedUserIds ? uniqueSorted(input.affectedUserIds) : undefined;
      mismatches.push({ ...input, ...(affectedUserIds && affectedUserIds.length > 0 ? { affectedUserIds } : {}) });
    };

    const knownUsers = this.knownUserIds(addMismatch);

    const addAsset = (row: EscrowAssetRow): void => {
      rows.push(row);
      const holderUsers = usersByHolder.get(row.holder) ?? new Set<string>();
      holderUsers.add(row.userId);
      usersByHolder.set(row.holder, holderUsers);

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
          scope: "holder",
          affectedUserIds: [...holderUsers],
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
          checkedAdd(byUser.get(row.userId) ?? 0, row.amount, "userEscrowed", { userId: row.userId }),
        );
      } catch (error) {
        invalidUsers.add(row.userId);
        addMismatch({
          code: "corrupt_amount",
          scope: "user",
          affectedUserIds: [row.userId],
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

    const actualByHolder = this.readEscrowBalances(addMismatch, usersByHolder);
    const compared = new Set<string>();

    for (const [holder, expected] of expectedByHolder) {
      compared.add(holder);
      if (invalidHolders.has(holder)) continue;
      const actual = actualByHolder.get(holder) ?? 0;
      if (expected !== actual) {
        addMismatch({
          code: "balance_mismatch",
          scope: "holder",
          affectedUserIds: [...(usersByHolder.get(holder) ?? [])],
          holder,
          expected,
          actual,
          ...(this.describeHolder(holder) ?? {}),
        });
      }
    }

    for (const [holder, actual] of actualByHolder) {
      if (actual <= 0 || compared.has(holder)) continue;
      const description = this.describeHolder(holder);
      if (description) {
        addMismatch({
          code: "missing_ledger_rows",
          scope: "holder",
          holder,
          expected: 0,
          actual,
          ...description,
          detail: "escrow holder に正の残高があるが、対応する本人帰属帳簿がない",
        });
      } else {
        addMismatch({
          code: "unknown_escrow_holder",
          scope: "holder",
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
    const holders: EscrowAssetHolderTotal[] = [...expectedByHolder.entries()]
      .filter(([holder]) => !invalidHolders.has(holder))
      .map(([holder, expected]) => {
        const description = this.describeHolder(holder);
        if (!description) throw new ChipLedgerError("ERR_CORRUPT_BALANCE", { field: "holder", holder });
        return {
          holder,
          expected,
          userIds: uniqueSorted(usersByHolder.get(holder) ?? []),
          ...description,
        };
      })
      .sort((a, b) => a.holder.localeCompare(b.holder));

    return {
      ok: sorted.length === 0,
      mismatches: sorted,
      rows: rows.slice(),
      holders,
      knownUserIds: uniqueSorted(knownUsers),
      byUser,
    };
  }

  private knownUserIds(addMismatch: (mismatch: EscrowAssetMismatch) => void): Set<string> {
    if (!this.requireColumns("accounts", ["id", "kind"], addMismatch)) return new Set();
    const rows = this.db
      .prepare("SELECT id FROM accounts WHERE kind = 'user' AND id LIKE 'user:%'")
      .all() as Array<{ id: unknown }>;
    const users = new Set<string>();
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id.startsWith("user:") || row.id.length <= "user:".length) {
        addMismatch({
          code: "invalid_user_id",
          scope: "global",
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
          scope: "global",
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
    knownUsers: ReadonlySet<string>,
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
    addAsset: (row: EscrowAssetRow) => void,
  ): void {
    const columns = this.tableColumns("casino_escrow");
    if (columns === null) return;
    const required = ["session_id", "user_id", "amount", "source"];
    if (!this.hasColumns(columns, required)) {
      addMismatch({
        code: "schema_incomplete",
        scope: "global",
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
      const affected = typeof raw.user_id === "string" && raw.user_id.length > 0 ? [raw.user_id] : [];
      const canonicalHolder =
        typeof raw.session_id === "string" && raw.session_id.length > 0
          ? escrowHolderFor(raw.session_id)
          : "casino_escrow";

      if (
        typeof raw.session_id !== "string" ||
        raw.session_id.length === 0 ||
        typeof raw.user_id !== "string" ||
        raw.user_id.length === 0 ||
        !knownUsers.has(raw.user_id)
      ) {
        addMismatch({
          code: "invalid_user_id",
          scope: "user",
          affectedUserIds: affected,
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
          scope: "user",
          affectedUserIds: [raw.user_id],
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
          scope: "user",
          affectedUserIds: [raw.user_id],
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
          scope: "user",
          affectedUserIds: [raw.user_id],
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
    knownUsers: ReadonlySet<string>,
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
    addAsset: (row: EscrowAssetRow) => void,
  ): void {
    const marketColumns = this.tableColumns("casino_markets");
    const betColumns = this.tableColumns("casino_market_bets");
    if (marketColumns === null && betColumns === null) return;
    if (marketColumns === null || betColumns === null) {
      addMismatch({
        code: "schema_incomplete",
        scope: "global",
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
        scope: "global",
        holder: "casino_markets/casino_market_bets",
        expected: null,
        actual: null,
        detail: `必要列不足: ${missing.join(",")}`,
      });
      return;
    }

    const rawMarkets = this.db.prepare("SELECT id, status, fund_mode FROM casino_markets").all() as RawMarketRow[];
    const markets = new Map<number, MarketRecord>();
    for (const raw of rawMarkets) {
      if (!isSafePositiveInteger(raw.id) || typeof raw.status !== "string" || typeof raw.fund_mode !== "string") {
        addMismatch({
          code: "schema_incomplete",
          scope: "global",
          holder: "casino_markets",
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.id),
          detail: "market id/status/fund_mode の型が不正",
        });
        continue;
      }
      if (markets.has(raw.id)) {
        addMismatch({
          code: "duplicate_ownership",
          scope: "holder",
          holder: marketEscrowHolder(raw.id),
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.id),
          detail: "同一market idが複数ある",
        });
        continue;
      }
      markets.set(raw.id, { id: raw.id, status: raw.status, fundMode: raw.fund_mode });
    }

    const rawBets = this.db
      .prepare("SELECT market_id, user_id, amount FROM casino_market_bets")
      .all() as RawMarketBetRow[];
    const betsByMarket = new Map<number, RawMarketBetRow[]>();
    for (const raw of rawBets) {
      if (!isSafePositiveInteger(raw.market_id)) {
        const userId = typeof raw.user_id === "string" ? raw.user_id : String(raw.user_id);
        addMismatch({
          code: "missing_ledger_rows",
          scope: "user",
          affectedUserIds: typeof raw.user_id === "string" ? [raw.user_id] : [],
          holder: "casino_market_bets",
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(raw.market_id),
          userId,
          detail: "betのmarket_idが正のsafe integerではない",
        });
        continue;
      }
      const list = betsByMarket.get(raw.market_id) ?? [];
      list.push(raw);
      betsByMarket.set(raw.market_id, list);
    }

    for (const [marketId, bets] of betsByMarket) {
      if (markets.has(marketId)) continue;
      for (const raw of bets) {
        const userId = typeof raw.user_id === "string" ? raw.user_id : String(raw.user_id);
        addMismatch({
          code: "missing_ledger_rows",
          scope: "user",
          affectedUserIds: typeof raw.user_id === "string" ? [raw.user_id] : [],
          holder: marketEscrowHolder(marketId),
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(marketId),
          userId,
          detail: "対応するcasino_markets行がないbet",
        });
      }
    }

    for (const market of markets.values()) {
      const bets = betsByMarket.get(market.id) ?? [];
      const participants = uniqueSorted(
        bets.flatMap((bet) => (typeof bet.user_id === "string" && knownUsers.has(bet.user_id) ? [bet.user_id] : [])),
      );
      const holder = marketEscrowHolder(market.id);

      if (!LIVE_MARKET_STATUSES.has(market.status) && !TERMINAL_MARKET_STATUSES.has(market.status)) {
        addMismatch({
          code: "unknown_market_status",
          scope: "holder",
          affectedUserIds: participants,
          holder,
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(market.id),
          detail: `未知のstatus: ${market.status}`,
        });
        continue;
      }
      if (market.fundMode !== "escrow" && market.fundMode !== "legacy_house") {
        addMismatch({
          code: "invalid_fund_mode",
          scope: "holder",
          affectedUserIds: participants,
          holder,
          expected: null,
          actual: null,
          sourceKind: "market",
          sourceId: String(market.id),
          detail: `未知のfund_mode: ${market.fundMode}`,
        });
        continue;
      }
      if (TERMINAL_MARKET_STATUSES.has(market.status)) continue;
      if (market.fundMode === "legacy_house") {
        if (bets.length > 0) {
          addMismatch({
            code: "invalid_legacy_source",
            scope: "holder",
            affectedUserIds: participants,
            holder: "house",
            expected: null,
            actual: null,
            sourceKind: "market",
            sourceId: String(market.id),
            detail: "legacy_house板はhouse混在勘定のため本人資産へ配分しない",
          });
        }
        continue;
      }

      const ownership = new Set<string>();
      for (const raw of bets) {
        const userId = typeof raw.user_id === "string" ? raw.user_id : String(raw.user_id);
        if (typeof raw.user_id !== "string" || raw.user_id.length === 0 || !knownUsers.has(raw.user_id)) {
          addMismatch({
            code: "invalid_user_id",
            scope: "user",
            affectedUserIds: typeof raw.user_id === "string" ? [raw.user_id] : [],
            holder,
            expected: null,
            actual: null,
            sourceKind: "market",
            sourceId: String(market.id),
            userId,
            detail: "betの本人帰属をLand利用者口座から確定できない",
          });
          continue;
        }
        if (!isSafePositiveInteger(raw.amount)) {
          addMismatch({
            code: "corrupt_amount",
            scope: "user",
            affectedUserIds: [raw.user_id],
            holder,
            expected: null,
            actual: typeof raw.amount === "number" ? raw.amount : null,
            sourceKind: "market",
            sourceId: String(market.id),
            userId: raw.user_id,
            detail: "casino_market_bets.amount が正のsafe integerではない",
          });
          continue;
        }

        const key = `${market.id}\u0000${raw.user_id}`;
        if (ownership.has(key)) {
          addMismatch({
            code: "duplicate_ownership",
            scope: "user",
            affectedUserIds: [raw.user_id],
            holder,
            expected: raw.amount,
            actual: null,
            sourceKind: "market",
            sourceId: String(market.id),
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
          sourceId: String(market.id),
        });
      }
    }
  }

  private readEscrowBalances(
    addMismatch: (mismatch: EscrowAssetMismatch) => void,
    usersByHolder: ReadonlyMap<string, ReadonlySet<string>>,
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
          scope: "holder",
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
          scope: "holder",
          affectedUserIds: [...(usersByHolder.get(row.user_id) ?? [])],
          holder: row.user_id,
          expected: null,
          actual: typeof row.amount === "number" ? row.amount : null,
          ...(this.describeHolder(row.user_id) ?? {}),
          detail: "holder実残高が非負のsafe integerではない",
        });
        continue;
      }
      if (balances.has(row.user_id)) {
        addMismatch({
          code: "corrupt_amount",
          scope: "holder",
          affectedUserIds: [...(usersByHolder.get(row.user_id) ?? [])],
          holder: row.user_id,
          expected: null,
          actual: row.amount,
          ...(this.describeHolder(row.user_id) ?? {}),
          detail: "同一holderの実残高行が複数ある",
        });
        continue;
      }
      balances.set(row.user_id, row.amount);
    }
    return balances;
  }

  private describeHolder(holder: string): { sourceKind: EscrowAssetSourceKind; sourceId: string } | null {
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
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
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
      scope: "global",
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
