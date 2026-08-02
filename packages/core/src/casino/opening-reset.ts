import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { FREE_SPIN_JACKPOT_CLAIMS_HOLDER } from "./free-spins.js";

export interface CasinoOpeningConfig {
  configured: true;
  casinoOpeningCapital: number;
  houseCapital: number;
  jackpotCapital: number;
  reliefCapital: number;
  minimumWorkingCapital: number;
  remittanceBps: number;
}

export interface OpeningResetPlan {
  mode: "dry-run";
  planHash: string;
  blockers: string[];
  freeSpinClaims: { pendingIds: number[]; expected: number; actual: number; matches: boolean };
  activeEscrowRows: number;
  protectedRows: Record<string, number>;
  configuration: CasinoOpeningConfig;
}

/**
 * PR12 正式開業初期化の読み取り専用 preflight。
 *
 * 実運用DBを初期化する入口ではない。pending free spin が1件でもあれば必ず blocker
 * とし、専用JP請求holderは plan の検査対象にするだけで移動・隔離・返還しない。
 */
export class CasinoOpeningReset {
  constructor(private readonly db: Database.Database) {}

  dryRun(configuration: CasinoOpeningConfig): OpeningResetPlan {
    this.assertConfig(configuration);
    const table = (name: string) => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const pending = table("casino_pending_free_spins")
      ? (this.db.prepare("SELECT id, jackpot_claim FROM casino_pending_free_spins WHERE status != 'settled' ORDER BY id").all() as Array<{ id: number; jackpot_claim: number }>)
      : [];
    const expected = pending.reduce((sum, row) => sum + row.jackpot_claim, 0);
    const actual = table("ether_balances")
      ? ((this.db.prepare("SELECT amount FROM ether_balances WHERE user_id=?").get(FREE_SPIN_JACKPOT_CLAIMS_HOLDER) as { amount: number } | undefined)?.amount ?? 0)
      : 0;
    const activeEscrowRows = table("casino_escrow")
      ? ((this.db.prepare("SELECT COUNT(*) AS n FROM casino_escrow").get() as { n: number }).n)
      : 0;
    const protectedRows: Record<string, number> = {};
    for (const name of ["vip_members", "stocks", "casino_stats", "casino_market_bets", "quarantine_assets"]) {
      protectedRows[name] = table(name) ? ((this.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n) : 0;
    }
    const blockers: string[] = [];
    if (pending.length > 0) blockers.push(`未精算無料スピン ${pending.length}件（先に精算または運営判断が必要）`);
    if (expected !== actual) blockers.push(`無料スピンJP請求不一致: pending合計=${expected}, holder実残高=${actual}, 行=${pending.map((x) => x.id).join(",") || "なし"}`);
    if (activeEscrowRows > 0) blockers.push(`稼働中エスクロー ${activeEscrowRows}件`);
    const unsigned = { mode: "dry-run" as const, blockers, freeSpinClaims: { pendingIds: pending.map((x) => x.id), expected, actual, matches: expected === actual }, activeEscrowRows, protectedRows, configuration };
    return { ...unsigned, planHash: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
  }

  private assertConfig(c: CasinoOpeningConfig): void {
    for (const [key, value] of Object.entries(c)) {
      if (key === "configured") continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`開業設定 ${key} は0以上の整数が必要`);
    }
    if (c.minimumWorkingCapital <= 0 || c.casinoOpeningCapital <= 0) throw new Error("開業資本・最低運転資金を0または未指定にはできない");
    if (c.remittanceBps > 10_000) throw new Error("remittanceBps は0〜10000");
  }
}
