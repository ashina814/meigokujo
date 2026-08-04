import type Database from "better-sqlite3";
import { ChipLedger } from "./chip-ledger.js";
import { marketEscrowHolder } from "./market.js";

export interface UserChipAssets {
  userId: string;
  /** いま賭場で使えるチップ。 */
  freeChips: number;
  /** 卓・板に拘束され、返還または精算を待つチップ。 */
  escrowed: number;
  /** 自由チップ + 利用者帰属が分かっている拘束チップ。 */
  total: number;
}

export interface EscrowAssetMismatch {
  holder: string;
  expected: number;
  actual: number;
}

/**
 * 利用者視点のチップ残高（PR9）。
 *
 * holder 残高だけを財布に出すと、卓や板へ預けた資金が消えたように見える。一方で
 * 自由チップとして扱うと再利用できてしまうので、ここで明示的に二つへ分離する。
 */
export class CasinoChipAssets {
  constructor(
    private readonly db: Database.Database,
    private readonly chips: ChipLedger,
  ) {}

  freeChips(userId: string): number {
    return this.chips.balanceOf(userId);
  }

  escrowed(userId: string): number {
    return this.escrowRows(userId).reduce((sum, row) => sum + row.amount, 0);
  }

  forUser(userId: string): UserChipAssets {
    const freeChips = this.freeChips(userId);
    const escrowed = this.escrowed(userId);
    return { userId, freeChips, escrowed, total: freeChips + escrowed };
  }

  /**
   * 拘束チップの利用者別帳簿と、各holderの実残高を照合する。
   * 不一致を補填・隔離せず、そのまま停止判断に渡せる形で返す。
   */
  verifyEscrowed(): { ok: boolean; mismatches: EscrowAssetMismatch[] } {
    const expected = new Map<string, number>();
    for (const row of this.escrowRows()) {
      expected.set(row.holder, (expected.get(row.holder) ?? 0) + row.amount);
    }
    const mismatches = [...expected.entries()]
      .map(([holder, amount]) => ({ holder, expected: amount, actual: this.chips.balanceOf(holder) }))
      .filter((row) => row.expected !== row.actual);
    return { ok: mismatches.length === 0, mismatches };
  }

  private escrowRows(userId?: string): Array<{ holder: string; amount: number }> {
    const rows: Array<{ holder: string; amount: number }> = [];
    const userClause = userId ? " AND user_id = ?" : "";
    const userArgs = userId ? [userId] : [];
    const sessionRows = this.db
      .prepare(`SELECT source AS holder, amount FROM casino_escrow WHERE 1=1${userClause}`)
      .all(...userArgs) as Array<{ holder: string; amount: number }>;
    rows.push(...sessionRows);

    const hasMarkets = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'casino_markets'").get();
    if (!hasMarkets) return rows;
    const marketRows = this.db
      .prepare(
        `SELECT b.market_id, b.amount
           FROM casino_market_bets b
           JOIN casino_markets m ON m.id = b.market_id
          WHERE m.fund_mode = 'escrow' AND m.status IN ('open','closed','reported','disputed','frozen')${userClause.replaceAll("user_id", "b.user_id")}`,
      )
      .all(...userArgs) as Array<{ market_id: number; amount: number }>;
    rows.push(...marketRows.map((row) => ({ holder: marketEscrowHolder(row.market_id), amount: row.amount })));
    return rows;
  }
}
