import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";
import { ChipTx } from "./chip-tx.js";

/**
 * エテル為替（カジノ第二通貨）。Land を 100% 準備する二通貨制。
 * エテルは魔法のお金ではなく「準備プール(sys:escrow:ether)の Land の引換券」で、
 *   1エテルの価値 = プールLand ÷ 発行エテル数（＝変動レート、板なし）。
 * 新規発行はしないので非インフレ。
 *
 * スプレッド設計（DESIGN_v2「入りやすく出にくい賭場」）:
 * - 入場（Land→エテル）: フェアレート・手数料なし
 * - 退場（エテル→Land）: 20% 奉納 = 80% 着地 / 10% 焼却（→国庫＝Landシンク）/ 10% プール残留（→残った人のエテルが値上がり）
 * これにより churn ぶんだけ Land 総量はゆっくり縮む（能動的なシンク）。
 */
export const ETHER_ESCROW = "sys:escrow:ether";
const ETHER_APPROVER = "system:ether";
/** 胴元（マモンの賭場）のエテル保有者ID */
export const HOUSE_HOLDER = "house";

export type EtherErrorCode = "ERR_BAD_AMOUNT" | "ERR_INSUFFICIENT_ETHER" | "ERR_DUPLICATE";

export class EtherError extends Error {
  constructor(
    readonly code: EtherErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "EtherError";
  }
}

export interface EtherQuote {
  /** 入力（買い=Land / 売り=エテル） */
  input: number;
  /** 受取り（買い=エテル / 売り=Land） */
  output: number;
  /** 焼却された Land（シンク） */
  burned: number;
}

export interface EtherExchangeOptions {
  /** 準備が空のときの初期レート（1 Land = 何エテルか）。関数なら毎回評価＝設定変更が即反映 */
  baseRate?: number | (() => number);
  /** 取引監査。賭場の全サービスで同じインスタンスを共有する（実行中グループを共有するため） */
  chipTx?: ChipTx;
}

/** チップ移動に必ず添える情報。理由の無い取引を作らないための必須引数 */
export interface ChipMoveInfo {
  reason: string;
  game?: string | null;
  sessionId?: string | null;
}

const now = () => Math.floor(Date.now() / 1000);
/** floor(a * b / c) を安全に（オーバーフロー回避） */
const muldiv = (a: number, b: number, c: number) => Number((BigInt(a) * BigInt(b)) / BigInt(c));

export class EtherExchange {
  private readonly baseRateOpt: number | (() => number);
  /** チップ移動の追記先。賭場の他サービスもここ経由で同じグループに乗る */
  readonly chipTx: ChipTx;

  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
    options: EtherExchangeOptions = {},
  ) {
    this.baseRateOpt = options.baseRate ?? 10;
    this.chipTx = options.chipTx ?? new ChipTx(db);
    this.ledger.ensureAccount(ETHER_ESCROW, "system");
  }

  /**
   * 業務操作を1グループとして実行する（仕様書 I5）。
   * チップを動かす処理は必ずこの中で行う。すでに外側のグループがあれば合流する。
   */
  runGroup<T>(input: { groupKey: string; kind: string; actorId: string }, body: () => T): T {
    return this.chipTx.runGroup(input, body);
  }

  /** 準備が空のときの初期レート（1 Land = 何エテル） */
  baseRate(): number {
    const r = typeof this.baseRateOpt === "function" ? this.baseRateOpt() : this.baseRateOpt;
    return Number.isFinite(r) && r > 0 ? r : 10;
  }

  /** 準備プールの Land 残高 */
  pool(): number {
    return this.ledger.balanceOf(ETHER_ESCROW);
  }
  /** 発行済みエテル総数 */
  outstanding(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ether_balances").get() as { s: number }).s;
  }
  balanceOf(holderId: string): number {
    const row = this.db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(holderId) as { amount: number } | undefined;
    return row?.amount ?? 0;
  }
  /** 1 Land = 何エテルか（表示用）。準備が空なら初期レート */
  rate(): number {
    const P = this.pool();
    const C = this.outstanding();
    return C === 0 || P === 0 ? this.baseRate() : C / P;
  }

  /**
   * Land 取引が実際に成立したかを確かめる。Ledger は重複キーで例外を出さず no-op を返すので、
   * それを見逃すと「Land を動かさずチップだけ発行/消却」の不整合になる。
   *
   * 同じ操作の再実行は `runGroup` が保存済みの結果で返す（ここへ来ない）。ここへ来るのは
   * **別の操作が同じ Land 冪等キーを使った**場合なので、資金を動かさず失敗させる。
   */
  private assertLandMoved(result: { duplicate: boolean }, idempotencyKey: string): void {
    if (result.duplicate) throw new EtherError("ERR_DUPLICATE", { idempotencyKey });
  }

  private setBalance(holderId: string, delta: number): void {
    const ts = now();
    // 先に行を 0 で確保してから加減算する。upsert の VALUES に負値を置くと
    // SQLite は INSERT 値にも CHECK(amount>=0) を効かせて弾くため、この2段構えにする。
    this.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING").run(holderId, ts);
    this.db.prepare("UPDATE ether_balances SET amount = amount + ?, updated_at = ? WHERE user_id = ?").run(delta, ts, holderId);
  }

  /** 残高行が無い保有者を 0 で作る（宛先が未初期化の system 口座でも `transfer` が通るように） */
  ensureHolder(holderId: string): void {
    const ts = now();
    this.db
      .prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING")
      .run(holderId, ts);
  }

  /** Land→エテルの見積り（実行せず）。フェアレート・手数料なし */
  quoteBuy(landIn: number): EtherQuote {
    const P = this.pool();
    const C = this.outstanding();
    const minted = C === 0 || P === 0 ? landIn * this.baseRate() : muldiv(landIn, C, P);
    return { input: landIn, output: Math.floor(minted), burned: 0 };
  }

  /** エテル→Land の見積り（実行せず）。現レートの80%が着地・10%焼却・10%残留 */
  quoteSell(etherIn: number): EtherQuote {
    const P = this.pool();
    const C = this.outstanding();
    const gross = C === 0 ? 0 : muldiv(etherIn, P, C);
    const payout = Math.floor((gross * 8) / 10);
    const burned = Math.floor(gross / 10);
    return { input: etherIn, output: payout, burned };
  }

  /** Land を払ってエテルを買う（入場・フェア） */
  buy(userId: string, landIn: number, idempotencyKey: string): EtherQuote {
    if (!Number.isInteger(landIn) || landIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { landIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "deposit", actorId: `user:${userId}` }, (): EtherQuote => {
      const q = this.quoteBuy(landIn);
      this.ledger.ensureAccount(`user:${userId}`, "user");
      const land = this.ledger.transfer({
        from: `user:${userId}`, to: ETHER_ESCROW, amount: landIn, type: "ether_buy", actor: `user:${userId}`,
        approvedBy: ETHER_APPROVER, reason: "エテル購入", refType: "ether", refId: userId, idempotencyKey,
      });
      this.assertLandMoved(land, idempotencyKey);
      this.setBalance(userId, q.output);
      this.chipTx.record({
        txKind: "deposit", to: userId, amount: q.output, reason: "チップ預入",
        landAmount: landIn, ledgerTxId: land.tx.id,
      });
      this.events.log("ether_buy", { actor: userId, payload: { landIn, ether: q.output } });
      return q;
    });
  }

  /** エテルを売って Land を受け取る（退場・20%奉納） */
  sell(userId: string, etherIn: number, idempotencyKey: string): EtherQuote {
    if (!Number.isInteger(etherIn) || etherIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { etherIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: `user:${userId}` }, (): EtherQuote => {
      // 残高の検査はグループの中で行う。外でやると、成功後の再試行が
      // 「保存済みの結果を返す」前に残高不足で落ちてしまう
      const held = this.balanceOf(userId);
      if (held < etherIn) throw new EtherError("ERR_INSUFFICIENT_ETHER", { held, etherIn });
      const q = this.quoteSell(etherIn);
      let landTxId: number | null = null;
      if (q.output > 0) {
        const payout = this.ledger.transfer({
          from: ETHER_ESCROW, to: `user:${userId}`, amount: q.output, type: "ether_sell", actor: `user:${userId}`,
          approvedBy: ETHER_APPROVER, reason: "エテル換金", refType: "ether", refId: userId, idempotencyKey,
        });
        this.assertLandMoved(payout, idempotencyKey);
        landTxId = payout.tx.id;
      }
      if (q.burned > 0) {
        const burn = this.ledger.transfer({
          from: ETHER_ESCROW, to: TREASURY, amount: q.burned, type: "ether_burn", actor: ETHER_APPROVER,
          approvedBy: ETHER_APPROVER, reason: "退場奉納の焼却", refType: "ether", refId: userId, idempotencyKey: `${idempotencyKey}:burn`,
        });
        this.assertLandMoved(burn, `${idempotencyKey}:burn`);
        landTxId = landTxId ?? burn.tx.id;
      }
      this.setBalance(userId, -etherIn);
      // 端数で Land が 1 Ld も出ない返還（現行の変動レート由来）はそのまま通す。
      // 資金の動きを変えずに「Land が動かなかった返還」として記録に残す。
      this.chipTx.record({
        txKind: "redeem", from: userId, amount: etherIn, reason: "チップ返還",
        landAmount: q.output + q.burned, ledgerTxId: landTxId,
      });
      this.sweepOrphanPool(userId, idempotencyKey);
      this.events.log("ether_sell", { actor: userId, payload: { etherIn, land: q.output, burned: q.burned } });
      return q;
    });
  }

  /**
   * 保有エテルを換金し、Land を「システム口座（部署など）」へ着地させる。
   * カジノ収益(house のエテル)を賭博場の部署口座へ精算するのに使う。
   * 為替と同じスプレッド（80%着地/10%焼却/10%残留）。
   */
  redeemToAccount(holderId: string, etherIn: number, destAccount: string, actor: string, idempotencyKey: string): EtherQuote {
    if (!Number.isInteger(etherIn) || etherIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { etherIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: actor }, (): EtherQuote => {
      const held = this.balanceOf(holderId);
      if (held < etherIn) throw new EtherError("ERR_INSUFFICIENT_ETHER", { held, etherIn });
      const q = this.quoteSell(etherIn);
      let landTxId: number | null = null;
      if (q.output > 0) {
        const settle = this.ledger.transfer({
          from: ETHER_ESCROW, to: destAccount, amount: q.output, type: "ether_settle", actor,
          approvedBy: ETHER_APPROVER, reason: "カジノ収益の精算", refType: "ether", refId: holderId, idempotencyKey,
        });
        this.assertLandMoved(settle, idempotencyKey);
        landTxId = settle.tx.id;
      }
      if (q.burned > 0) {
        const burn = this.ledger.transfer({
          from: ETHER_ESCROW, to: TREASURY, amount: q.burned, type: "ether_burn", actor,
          approvedBy: ETHER_APPROVER, reason: "精算奉納の焼却", refType: "ether", refId: holderId, idempotencyKey: `${idempotencyKey}:burn`,
        });
        this.assertLandMoved(burn, `${idempotencyKey}:burn`);
        landTxId = landTxId ?? burn.tx.id;
      }
      this.setBalance(holderId, -etherIn);
      this.chipTx.record({
        txKind: "redeem", from: holderId, amount: etherIn, reason: "賭場収益の精算",
        landAmount: q.output + q.burned, ledgerTxId: landTxId,
      });
      this.sweepOrphanPool(holderId, idempotencyKey);
      this.events.log("ether_settle", { actor, payload: { holderId, etherIn, land: q.output, dest: destAccount } });
      return q;
    });
  }

  /**
   * システム口座(部署など)の Land を元手に、フェアレート（奉納なし）でエテルを holder へ発行。
   * 胴元(マモン)の開帳資金を賭博場口座から入れる用。プレイヤーの両替と違い損得ゼロで往復できる。
   */
  fundFromAccount(srcAccount: string, landIn: number, holderId: string, idempotencyKey: string): { land: number; ether: number } {
    if (!Number.isInteger(landIn) || landIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { landIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "deposit", actorId: ETHER_APPROVER }, () => {
      const q = this.quoteBuy(landIn); // 入場は元々フェアなので同じ計算
      const land = this.ledger.transfer({
        from: srcAccount, to: ETHER_ESCROW, amount: landIn, type: "ether_house_fund", actor: ETHER_APPROVER,
        approvedBy: ETHER_APPROVER, reason: "胴元の元手", refType: "ether", refId: holderId, idempotencyKey,
      });
      this.assertLandMoved(land, idempotencyKey);
      this.setBalance(holderId, q.output);
      this.chipTx.record({
        txKind: "deposit", to: holderId, amount: q.output, reason: "胴元の元手",
        landAmount: landIn, ledgerTxId: land.tx.id,
      });
      this.events.log("ether_house_fund", { actor: holderId, payload: { land: landIn, ether: q.output, src: srcAccount } });
      return { land: landIn, ether: q.output };
    });
  }

  /**
   * holder のエテルをフェアレート（奉納なし）で system 口座(部署)へ Land 精算。
   * 胴元の売上を賭博場口座へ戻す用。全部戻すと準備プールもちょうど空になる。
   */
  redeemFairToAccount(holderId: string, etherIn: number, destAccount: string, idempotencyKey: string): { ether: number; land: number } {
    if (!Number.isInteger(etherIn) || etherIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { etherIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: ETHER_APPROVER }, () => {
      const held = this.balanceOf(holderId);
      if (held < etherIn) throw new EtherError("ERR_INSUFFICIENT_ETHER", { held, etherIn });
      const P = this.pool();
      const C = this.outstanding();
      const land = C === 0 ? 0 : muldiv(etherIn, P, C); // フェア gross（80%引きなし）
      let landTxId: number | null = null;
      if (land > 0) {
        const settle = this.ledger.transfer({
          from: ETHER_ESCROW, to: destAccount, amount: land, type: "ether_settle", actor: ETHER_APPROVER,
          approvedBy: ETHER_APPROVER, reason: "胴元の売上精算", refType: "ether", refId: holderId, idempotencyKey,
        });
        this.assertLandMoved(settle, idempotencyKey);
        landTxId = settle.tx.id;
      }
      this.setBalance(holderId, -etherIn);
      this.chipTx.record({
        txKind: "redeem", from: holderId, amount: etherIn, reason: "胴元の売上精算",
        landAmount: land, ledgerTxId: landTxId,
      });
      this.sweepOrphanPool(holderId, idempotencyKey);
      this.events.log("ether_settle", { actor: holderId, payload: { ether: etherIn, land, dest: destAccount, fair: true } });
      return { ether: etherIn, land };
    });
  }

  /**
   * カジノ内のエテル移動（賭け・配当）。台帳(Land)は動かさず総量保存。
   * 理由の指定は必須で、グループの外では動かせない（記録できない移動を作らないため）。
   */
  transfer(fromHolderId: string, toHolderId: string, amount: number, move: ChipMoveInfo): void {
    if (!Number.isInteger(amount) || amount <= 0) throw new EtherError("ERR_BAD_AMOUNT", { amount });
    if (this.balanceOf(fromHolderId) < amount) throw new EtherError("ERR_INSUFFICIENT_ETHER", { held: this.balanceOf(fromHolderId), amount });
    this.db.transaction(() => {
      this.setBalance(fromHolderId, -amount);
      this.setBalance(toHolderId, amount);
      this.chipTx.record({ txKind: "internal_transfer", from: fromHolderId, to: toHolderId, amount, ...move });
    })();
  }

  /** 全エテルが引き上げられたら、残留した端数プールを国庫へ掃く（孤児Land防止） */
  private sweepOrphanPool(refId: string, idempotencyKey: string): void {
    if (this.outstanding() === 0 && this.pool() > 0) {
      this.ledger.transfer({
        from: ETHER_ESCROW, to: TREASURY, amount: this.pool(), type: "ether_burn", actor: ETHER_APPROVER,
        approvedBy: ETHER_APPROVER, reason: "準備プール残の回収", refType: "ether", refId, idempotencyKey: `${idempotencyKey}:sweep`,
      });
    }
  }
}
