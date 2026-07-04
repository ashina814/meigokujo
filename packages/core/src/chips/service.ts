import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";

/**
 * チップ為替（カジノ通貨）。Land を 100% 準備する二通貨制。
 * チップは魔法のお金ではなく「準備プール(sys:escrow:chips)の Land の引換券」で、
 *   1チップの価値 = プールLand ÷ 発行チップ数（＝変動レート、板なし）。
 * 新規発行はしないので非インフレ。両替スプレッド20%を
 *   80% 着地 / 10% 焼却（→国庫＝シンク）/ 10% プール残留（→チップ値上がり）に分ける。
 * これにより churn ぶんだけ通貨総量はゆっくり縮む（能動的なシンク）。
 */
export const CHIP_ESCROW = "sys:escrow:chips";
const CHIP_APPROVER = "system:chips";
/** 準備が空のときの初期レート（1チップ = 1 Land） */
const BASE_RATE = 1;

export type ChipErrorCode = "ERR_BAD_AMOUNT" | "ERR_INSUFFICIENT_CHIPS";

export class ChipError extends Error {
  constructor(
    readonly code: ChipErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ChipError";
  }
}

export interface ChipQuote {
  /** 入力（買い=Land / 売り=チップ） */
  input: number;
  /** 受取り（買い=チップ / 売り=Land） */
  output: number;
  /** 焼却された Land（シンク） */
  burned: number;
}

const now = () => Math.floor(Date.now() / 1000);
/** floor(a * b / c) を安全に（オーバーフロー回避） */
const muldiv = (a: number, b: number, c: number) => Number((BigInt(a) * BigInt(b)) / BigInt(c));

export class Chips {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
  ) {
    this.ledger.ensureAccount(CHIP_ESCROW, "system");
  }

  /** 準備プールの Land 残高 */
  pool(): number {
    return this.ledger.balanceOf(CHIP_ESCROW);
  }
  /** 発行済みチップ総数 */
  outstanding(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM chip_balances").get() as { s: number }).s;
  }
  balanceOf(userId: string): number {
    const row = this.db.prepare("SELECT amount FROM chip_balances WHERE user_id = ?").get(userId) as { amount: number } | undefined;
    return row?.amount ?? 0;
  }
  /** 1チップ = 何 Land か（表示用）。準備が空なら初期レート */
  rate(): number {
    const c = this.outstanding();
    return c === 0 ? BASE_RATE : this.pool() / c;
  }

  private setBalance(userId: string, delta: number): void {
    const ts = now();
    // 先に行を 0 で確保してから加減算する。upsert の VALUES に負値を置くと
    // SQLite は INSERT 値にも CHECK(amount>=0) を効かせて弾くため、この2段構えにする。
    this.db.prepare("INSERT INTO chip_balances (user_id, amount, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING").run(userId, ts);
    this.db.prepare("UPDATE chip_balances SET amount = amount + ?, updated_at = ? WHERE user_id = ?").run(delta, ts, userId);
  }

  /** Land→チップの見積り（実行せず）。80%相当を現レートでチップ化 */
  quoteBuy(landIn: number): ChipQuote {
    const P = this.pool();
    const C = this.outstanding();
    const usable = landIn - Math.floor(landIn / 10); // 焼却10%を除いた分がプールへ
    void usable;
    const burned = Math.floor(landIn / 10);
    const minted = C === 0 || P === 0 ? Math.floor((landIn * 8) / 10) : muldiv(landIn * 8, C, P * 10);
    return { input: landIn, output: minted, burned };
  }

  /** チップ→Land の見積り（実行せず）。現レートの80%が着地 */
  quoteSell(chipsIn: number): ChipQuote {
    const P = this.pool();
    const C = this.outstanding();
    const gross = C === 0 ? 0 : muldiv(chipsIn, P, C);
    const payout = Math.floor((gross * 8) / 10);
    const burned = Math.floor(gross / 10);
    return { input: chipsIn, output: payout, burned };
  }

  /** Land を払ってチップを買う */
  buy(userId: string, landIn: number, idempotencyKey: string): ChipQuote {
    if (!Number.isInteger(landIn) || landIn <= 0) throw new ChipError("ERR_BAD_AMOUNT", { landIn });
    return this.db.transaction((): ChipQuote => {
      const q = this.quoteBuy(landIn);
      this.ledger.ensureAccount(`user:${userId}`, "user");
      this.ledger.transfer({
        from: `user:${userId}`, to: CHIP_ESCROW, amount: landIn, type: "chip_buy", actor: `user:${userId}`,
        approvedBy: CHIP_APPROVER, reason: "チップ購入", refType: "chips", refId: userId, idempotencyKey,
      });
      if (q.burned > 0) {
        this.ledger.transfer({
          from: CHIP_ESCROW, to: TREASURY, amount: q.burned, type: "chip_burn", actor: CHIP_APPROVER,
          approvedBy: CHIP_APPROVER, reason: "両替スプレッド焼却", refType: "chips", refId: userId, idempotencyKey: `${idempotencyKey}:burn`,
        });
      }
      this.setBalance(userId, q.output);
      this.events.log("chip_buy", { actor: userId, payload: { landIn, chips: q.output, burned: q.burned } });
      return q;
    })();
  }

  /** チップを売って Land を受け取る */
  sell(userId: string, chipsIn: number, idempotencyKey: string): ChipQuote {
    if (!Number.isInteger(chipsIn) || chipsIn <= 0) throw new ChipError("ERR_BAD_AMOUNT", { chipsIn });
    const held = this.balanceOf(userId);
    if (held < chipsIn) throw new ChipError("ERR_INSUFFICIENT_CHIPS", { held, chipsIn });
    return this.db.transaction((): ChipQuote => {
      const q = this.quoteSell(chipsIn);
      if (q.output > 0) {
        this.ledger.transfer({
          from: CHIP_ESCROW, to: `user:${userId}`, amount: q.output, type: "chip_sell", actor: `user:${userId}`,
          approvedBy: CHIP_APPROVER, reason: "チップ換金", refType: "chips", refId: userId, idempotencyKey,
        });
      }
      if (q.burned > 0) {
        this.ledger.transfer({
          from: CHIP_ESCROW, to: TREASURY, amount: q.burned, type: "chip_burn", actor: CHIP_APPROVER,
          approvedBy: CHIP_APPROVER, reason: "両替スプレッド焼却", refType: "chips", refId: userId, idempotencyKey: `${idempotencyKey}:burn`,
        });
      }
      this.setBalance(userId, -chipsIn);
      // 全チップが引き上げられたら、残留した端数プールを国庫へ掃く（孤児Land防止）
      if (this.outstanding() === 0 && this.pool() > 0) {
        this.ledger.transfer({
          from: CHIP_ESCROW, to: TREASURY, amount: this.pool(), type: "chip_burn", actor: CHIP_APPROVER,
          approvedBy: CHIP_APPROVER, reason: "準備プール残の回収", refType: "chips", refId: userId, idempotencyKey: `${idempotencyKey}:sweep`,
        });
      }
      this.events.log("chip_sell", { actor: userId, payload: { chipsIn, land: q.output, burned: q.burned } });
      return q;
    })();
  }

  /** カジノ内のチップ移動（賭け・配当）。台帳(Land)は動かさず総量保存 */
  transfer(fromUserId: string, toUserId: string, amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) throw new ChipError("ERR_BAD_AMOUNT", { amount });
    if (this.balanceOf(fromUserId) < amount) throw new ChipError("ERR_INSUFFICIENT_CHIPS", { held: this.balanceOf(fromUserId), amount });
    this.db.transaction(() => {
      this.setBalance(fromUserId, -amount);
      this.setBalance(toUserId, amount);
    })();
  }
}
