import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { ChipTx } from "./chip-tx.js";
import { ETHER_ESCROW, EtherExchange, HOUSE_HOLDER, POOL_SWEEP_REASON } from "./exchange.js";
import { Escrow, ESCROW_QUARANTINE } from "./escrow.js";
import { JACKPOT_HOLDER, RELIEF_HOLDER } from "./service.js";

/**
 * 賭場の検算A〜D（大型UPD PR2）。
 *
 * PR1 で「いつ・誰が・なぜ動かしたか」が残るようになったので、ここでは
 * **記録と実体が合っているか**を4つの角度から確かめる。1つでも合わなければ賭場を止める。
 *
 * | | 何を確かめるか |
 * |---|---|
 * | A | 記録どおりの残高か（開始残高 + その版の取引 == 実残高） |
 * | B | チップに Land の裏付けがあるか（準備プールが記録どおりに動いたか） |
 * | C | 預かっている資金が帳簿と合っているか（卓・板のエスクロー） |
 * | D | すべてのチップが誰かに帰属しているか（宙に浮いた保有者がいないか） |
 *
 * A〜C が通れば D は自動的に成立するはずだが、**D は独立に実装する**
 * （A〜C のどれかにバグがあっても D で気づける・仕様書2.2）。
 *
 * ## 1チップ = 1 Land 化（PR8）との関係
 * いまのチップは準備プールに対する変動レートの引換券なので、検算Bは
 * 「プールの Land が、記録された預入・返還・端数回収**でしか**動いていない」を確かめる。
 * PR8 で 1:1 になると、この式はそのまま
 * 「Σチップ == 準備口座の Land」（仕様書2.2 の検算B）に一致する。
 */

export type CasinoCheckId = "A" | "B" | "C" | "D";

export interface CasinoCheckMismatch {
  /** 何が合わないか（保有者ID・セッションID・板ID など） */
  subject: string;
  expected: number;
  actual: number;
}

export interface CasinoCheckResult {
  id: CasinoCheckId;
  name: string;
  ok: boolean;
  /** 人が読む1行。ダッシュボード・監査通知にそのまま出す */
  detail: string;
  mismatches: CasinoCheckMismatch[];
}

export interface CasinoIntegrityReport {
  ok: boolean;
  checks: CasinoCheckResult[];
  /** NG だった検算のID（停止理由の組み立てに使う） */
  failed: CasinoCheckId[];
  checkedAt: number;
}

/** 賭場が持つ「利用者ではない」保有者。帰属先が決まっているのでDの分類に含める */
const SYSTEM_HOLDERS = [HOUSE_HOLDER, JACKPOT_HOLDER, RELIEF_HOLDER, ESCROW_QUARANTINE] as const;

/** 差分を最大何件まで持ち回るか（通知が壊れないように） */
const MAX_MISMATCHES = 20;

const now = () => Math.floor(Date.now() / 1000);

export class CasinoIntegrity {
  private readonly chipTx: ChipTx;

  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly ether: EtherExchange,
    private readonly escrow: Escrow,
  ) {
    this.chipTx = ether.chipTx;
  }

  /** 4つ全部を走らせる。1つでもNGなら ok=false */
  run(): CasinoIntegrityReport {
    const checks = [this.checkA(), this.checkB(), this.checkC(), this.checkD()];
    const failed = checks.filter((c) => !c.ok).map((c) => c.id);
    return { ok: failed.length === 0, checks, failed, checkedAt: now() };
  }

  /** 停止理由の1行（監査通知・状態の reason に入れる） */
  static describeFailure(report: CasinoIntegrityReport): string {
    const bad = report.checks.filter((c) => !c.ok);
    if (bad.length === 0) return "検算はすべて正常";
    return bad.map((c) => `検算${c.id}(${c.name}): ${c.detail}`).join(" / ");
  }

  // ── A: 記録と残高 ──────────────────────────────────────

  /** 開始残高 + その版の取引 == いまのチップ残高（1 Ld の差も見逃さない） */
  checkA(): CasinoCheckResult {
    const r = this.chipTx.verifyBalances();
    return {
      id: "A",
      name: "記録と残高",
      ok: r.ok,
      detail: r.ok
        ? "開始残高と取引から現在残高を再現できる"
        : `${r.mismatches.length}件の保有者で記録と残高が食い違う`,
      mismatches: r.mismatches.slice(0, MAX_MISMATCHES).map((m) => ({
        subject: m.holder,
        expected: m.expected,
        actual: m.actual,
      })),
    };
  }

  // ── B: チップの裏付け ──────────────────────────────────

  /**
   * 準備プールの Land が記録どおりに動いたか。
   *
   * 期待値 = 版の開始プール + Σ預入のLand − Σ返還のLand − Σ端数回収
   * プールを動かす経路はこの3つしかない（`EtherExchange` の deposit / redeem / sweep）。
   * 一致しなければ、記録を通さずに準備 Land が動いた＝チップの裏付けが崩れている。
   *
   * 開始プールが未確定の版（PR1 より前から動いていたDB）は、**現在値から一度だけ逆算して**
   * 基準を置く。以後はその基準からの差分で見る。
   */
  checkB(): CasinoCheckResult {
    const version = this.chipTx.currentVersion();
    const flow = this.chipTx.landFlow(version);
    const swept = this.sweptLand();
    const actual = this.ether.pool();
    let opening = this.chipTx.openingPoolLand(version);
    if (opening === null) {
      // 基準未設定 → いまのプールから逆算して置く（開始残高と同じ「ここを出発点にする」宣言）
      opening = actual - flow.net + swept;
      this.chipTx.setOpeningPoolLand(version, opening);
    }
    const expected = opening + flow.net - swept;
    const ok = expected === actual;
    return {
      id: "B",
      name: "チップの裏付け",
      ok,
      detail: ok
        ? `準備プール ${actual.toLocaleString()} Ld は記録どおり（預入 ${flow.deposited.toLocaleString()} / 返還 ${flow.redeemed.toLocaleString()} / 回収 ${swept.toLocaleString()}）`
        : `準備プールが記録と ${(actual - expected).toLocaleString()} Ld ずれている`,
      mismatches: ok ? [] : [{ subject: ETHER_ESCROW, expected, actual }],
    };
  }

  /** 端数回収（孤児Land防止）で準備プールから抜けた Land の総額 */
  private sweptLand(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
         WHERE from_account = ? AND reason = ?`,
      )
      .get(ETHER_ESCROW, POOL_SWEEP_REASON) as { s: number };
    return row.s;
  }

  // ── C: 預託 ────────────────────────────────────────────

  /**
   * 預かっている資金が帳簿と合っているか。
   * - 卓・競馬: `casino_escrow` の合計 == `escrow:session:<sid>` の残高（既存の `escrow.verify()`）
   * - 板: 未確定の板の pot == `escrow:market:<id>` の残高
   */
  checkC(): CasinoCheckResult {
    const session = this.escrow.verify();
    const mismatches: CasinoCheckMismatch[] = session.mismatches.map((m) => ({
      subject: `session:${m.sessionId}`,
      expected: m.expected,
      actual: m.actual,
    }));
    for (const m of this.marketEscrowMismatches()) mismatches.push(m);
    const ok = mismatches.length === 0;
    return {
      id: "C",
      name: "預託",
      ok,
      detail: ok ? "卓・板の預り金は帳簿どおり" : `${mismatches.length}件の預り所で帳簿と残高が食い違う`,
      mismatches: mismatches.slice(0, MAX_MISMATCHES),
    };
  }

  /** 未確定の板について pot と預り所残高を突き合わせる（fund_mode='escrow' のみ） */
  private marketEscrowMismatches(): CasinoCheckMismatch[] {
    if (!this.tableExists("casino_markets") || !this.tableExists("casino_market_bets")) return [];
    const rows = this.db
      .prepare(
        `SELECT m.id AS id,
                COALESCE(SUM(b.amount), 0) AS pot,
                COALESCE(eb.amount, 0) AS escrow_balance
           FROM casino_markets m
           LEFT JOIN casino_market_bets b ON b.market_id = m.id
           LEFT JOIN ether_balances eb ON eb.user_id = 'escrow:market:' || m.id
          WHERE m.status IN ('open','closed','reported','disputed','frozen')
            AND m.fund_mode = 'escrow'
          GROUP BY m.id`,
      )
      .all() as Array<{ id: number; pot: number; escrow_balance: number }>;
    return rows
      .filter((r) => r.pot !== r.escrow_balance)
      .map((r) => ({ subject: `market:${r.id}`, expected: r.pot, actual: r.escrow_balance }));
  }

  // ── D: 帰属 ────────────────────────────────────────────

  /**
   * 発行済みチップが全部「誰かのもの」になっているか。
   *
   * 内訳 = 利用者の自由チップ + 卓/板への預託 + 胴元 + JP + 救済 + 隔離
   * これが発行総量と一致しなければ、**帰属先の分からないチップ**が居る。
   * 分類できない保有者（`escrow:` でも system でもない未知のID）も列挙する。
   */
  checkD(): CasinoCheckResult {
    const holders = this.db.prepare("SELECT user_id, amount FROM ether_balances WHERE amount != 0").all() as Array<{
      user_id: string;
      amount: number;
    }>;
    const system = new Set<string>(SYSTEM_HOLDERS);
    const escrowLedger = this.escrowLedgerByHolder();

    let outstanding = 0;
    let classified = 0;
    const mismatches: CasinoCheckMismatch[] = [];
    for (const h of holders) {
      outstanding += h.amount;
      if (system.has(h.user_id)) {
        classified += h.amount;
        continue;
      }
      if (h.user_id.startsWith("escrow:")) {
        // 預り所は「帳簿に載っている預託」だけが帰属先を持つ
        const booked = escrowLedger.get(h.user_id) ?? 0;
        classified += booked;
        if (booked !== h.amount) {
          mismatches.push({ subject: `帰属不明の預り所 ${h.user_id}`, expected: booked, actual: h.amount });
        }
        continue;
      }
      if (h.user_id.startsWith("sys:")) {
        // 賭場が使わないはずの system 保有者にチップが乗っている
        mismatches.push({ subject: `未分類の system 保有者 ${h.user_id}`, expected: 0, actual: h.amount });
        continue;
      }
      // それ以外は利用者の自由チップ
      classified += h.amount;
    }

    if (classified !== outstanding) {
      mismatches.push({ subject: "発行総量", expected: outstanding, actual: classified });
    }
    const ok = mismatches.length === 0;
    return {
      id: "D",
      name: "帰属",
      ok,
      detail: ok
        ? `発行済み ${outstanding.toLocaleString()} ◈ はすべて帰属先がある`
        : `${mismatches.length}件の帰属不明がある`,
      mismatches: mismatches.slice(0, MAX_MISMATCHES),
    };
  }

  /** 預り所ごとの「帳簿に載っている預託額」（卓・競馬 + 板） */
  private escrowLedgerByHolder(): Map<string, number> {
    const map = new Map<string, number>();
    const add = (holder: string, amount: number) => map.set(holder, (map.get(holder) ?? 0) + amount);
    if (this.tableExists("casino_escrow")) {
      const rows = this.db
        .prepare("SELECT session_id, SUM(amount) AS s FROM casino_escrow GROUP BY session_id")
        .all() as Array<{ session_id: string; s: number }>;
      for (const r of rows) add(`escrow:session:${r.session_id}`, r.s);
    }
    if (this.tableExists("casino_markets") && this.tableExists("casino_market_bets")) {
      const rows = this.db
        .prepare(
          `SELECT b.market_id AS id, SUM(b.amount) AS s
             FROM casino_market_bets b
             JOIN casino_markets m ON m.id = b.market_id
            WHERE m.status IN ('open','closed','reported','disputed','frozen')
            GROUP BY b.market_id`,
        )
        .all() as Array<{ id: number; s: number }>;
      for (const r of rows) add(`escrow:market:${r.id}`, r.s);
    }
    return map;
  }

  private tableExists(table: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(table),
    );
  }

  /** Land 台帳そのものの健全性（起動時に検算より先に見る・仕様書 S1） */
  checkLedger(): { ok: boolean; detail: string } {
    const r = this.ledger.verifyIntegrity();
    return {
      ok: r.ok,
      detail: r.ok ? "Land台帳は正常" : `Land台帳の残高キャッシュが ${r.mismatches.length}件 不一致`,
    };
  }
}
