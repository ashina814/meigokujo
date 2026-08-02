import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { EventLog } from "../events/service.js";
import { ChipTx } from "./chip-tx.js";

/**
 * 賭場チップ台帳。Land を 100% 準備し、預入・返還とも常に 1:1 で処理する。
 *
 * 旧エテル為替の変動レート・奉納・残余プール掃除はここには存在しない。正式開業前は
 * 旧準備口座を読み、opening_v1 から新しい casino 準備口座へ切り替える。これにより
 * PR12 が旧制度を明示的に清算するまで、既存残高の裏付けを勝手に動かさない。
 */
export const ETHER_ESCROW = "sys:escrow:ether";
/** 正式開業後の、発行済みチップを100%裏付ける Land 準備口座。 */
export const CHIP_ESCROW = "sys:escrow:casino";
/** 準備口座を動かす取引の承認者・実行者。検算Bの経路監査もこの値で照合する */
export const ETHER_APPROVER = "system:ether";
/** 胴元（マモンの賭場）のエテル保有者ID */
export const HOUSE_HOLDER = "house";
/**
 * 準備プールの端数回収（孤児Land防止）の理由文。
 * 検算Bは「プールは預入・返還とこの回収でしか動かない」を確かめるので、
 * 回収を識別できるようにここを唯一の真実源にしておく。
 */
export const POOL_SWEEP_REASON = "準備プール残の回収";

/** 賭場が自分で持つ保有者（利用者ではない）。プレフィクスで判定できないものだけ列挙する */
const NON_PLAYER_HOLDERS: ReadonlySet<string> = new Set([HOUSE_HOLDER, "jackpot", "relief", "house_escrow_legacy"]);

/**
 * 保有者IDが**利用者本人**かどうか（PR3・通算損益の宛先判定）。
 *
 * チップ層の利用者IDは Discord のスノーフレークそのままなので、
 * `sys:` / `escrow:` / `system:` で始まるものと胴元・JP・救済を除けば利用者になる。
 * 戦績へ載せてよいのはここが true の保有者だけ。
 */
export function isPlayerHolder(holderId: string): boolean {
  if (!holderId) return false;
  if (NON_PLAYER_HOLDERS.has(holderId)) return false;
  return !/^(sys:|system:|escrow:)/.test(holderId);
}

export type EtherErrorCode =
  | "ERR_BAD_AMOUNT"
  | "ERR_INSUFFICIENT_ETHER"
  | "ERR_DUPLICATE"
  /** 予約済み債務の裏付けまで精算しようとした（PR5） */
  | "ERR_RESERVED_FUNDS";

export class EtherError extends Error {
  constructor(
    readonly code: EtherErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "EtherError";
  }
}

export interface ChipQuote {
  /** 入力（預入=Land / 返還=chip） */
  input: number;
  /** 受取り（預入=chip / 返還=Land） */
  output: number;
  /** 常に0。旧レスポンス形との互換用で、チップ制度では焼却しない。 */
  burned: 0;
}

export interface ChipLedgerOptions {
  /** 取引監査。賭場の全サービスで同じインスタンスを共有する（実行中グループを共有するため） */
  chipTx?: ChipTx;
  /**
   * その保有者について**いま予約されている債務**を返す（PR5）。
   *
   * `redeemToAccount`（売上精算）が「house 残高 − 予約総額」しか出せないようにするために使う。
   * 予約は `HouseReservations` が持っており、そちらは `EtherExchange` を必要とするので、
   * 循環を避けるために関数で受け取る（未設定なら予約なし＝従来どおり）。
   */
  reservedOf?: (holderId: string) => number;
}

/** チップ移動に必ず添える情報。理由の無い取引を作らないための必須引数 */
export interface ChipMoveInfo {
  reason: string;
  game?: string | null;
  sessionId?: string | null;
}

const now = () => Math.floor(Date.now() / 1000);
/** floor(a * b / c) を安全に（オーバーフロー回避） */
export class ChipLedger {
  /** チップ移動の追記先。賭場の他サービスもここ経由で同じグループに乗る */
  readonly chipTx: ChipTx;

  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
    options: ChipLedgerOptions = {},
  ) {
    this.chipTx = options.chipTx ?? new ChipTx(db);
    if (options.reservedOf) this.reservedOfFn = options.reservedOf;
    this.ledger.ensureAccount(ETHER_ESCROW, "system");
    this.ledger.ensureAccount(CHIP_ESCROW, "system");
  }

  /** @see ChipLedgerOptions.reservedOf */
  private reservedOfFn: (holderId: string) => number = () => 0;

  /**
   * 予約の出所を後から繋ぐ（PR5）。
   * `HouseReservations` は `ChipLedger` を要求するので、構築順の都合でこちらから繋ぐ。
   */
  setReservedProvider(fn: (holderId: string) => number): void {
    this.reservedOfFn = fn;
  }

  /**
   * その保有者から**いま外へ出してよい額**（PR5・正本 I7）。
   *
   * ```text
   * 精算可能額 = 残高 − 予約済み債務
   * ```
   *
   * 進行中のゲームの最大配当は予約として押さえてある。その裏付けまで部署口座へ
   * 戻せてしまうと、予約が支払保証にならない。UI 側の制限では不十分なので**ここで止める**。
   */
  settleableBalance(holderId: string): number {
    return Math.max(0, this.balanceOf(holderId) - Math.max(0, this.reservedOfFn(holderId)));
  }

  /**
   * 業務操作を1グループとして実行する（仕様書 I5）。
   * チップを動かす処理は必ずこの中で行う。すでに外側のグループがあれば合流する。
   */
  runGroup<T>(input: { groupKey: string; kind: string; actorId: string }, body: () => T): T {
    return this.chipTx.runGroup(input, body);
  }

  /** 準備プールの Land 残高 */
  pool(): number {
    return this.ledger.balanceOf(this.reserveHolder());
  }
  /** 現在のチップ制度が使う準備口座。opening_v1 は PR12 が確定する。 */
  reserveHolder(): string {
    return this.chipTx.currentVersion() === "opening_v1" ? CHIP_ESCROW : ETHER_ESCROW;
  }
  /** 発行済みエテル総数 */
  outstanding(): number {
    return (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ether_balances").get() as { s: number }).s;
  }
  balanceOf(holderId: string): number {
    const row = this.db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(holderId) as { amount: number } | undefined;
    return row?.amount ?? 0;
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

  /** Land を預け、同額の自由チップを受け取る。 */
  quoteDeposit(landIn: number): ChipQuote {
    return { input: landIn, output: landIn, burned: 0 };
  }
  /** PR9: いまゲームに使える自由チップ。拘束中資金は含まない。 */
  freeChips(userId: string): number {
    return this.balanceOf(userId);
  }

  /** 自由チップを返還し、同額の Land を受け取る。 */
  quoteRedeem(chipsIn: number): ChipQuote {
    return { input: chipsIn, output: chipsIn, burned: 0 };
  }

  /** Land を預けて自由チップを発行する（常に 1:1）。 */
  deposit(userId: string, landIn: number, idempotencyKey: string): ChipQuote {
    if (!Number.isInteger(landIn) || landIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { landIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "deposit", actorId: `user:${userId}` }, (): ChipQuote => {
      const q = this.quoteDeposit(landIn);
      this.ledger.ensureAccount(`user:${userId}`, "user");
      const land = this.ledger.transfer({
        from: `user:${userId}`, to: this.reserveHolder(), amount: landIn, type: "chip_deposit", actor: `user:${userId}`,
        approvedBy: ETHER_APPROVER, reason: "賭場チップ預入", refType: "casino_chip", refId: userId, idempotencyKey,
      });
      this.assertLandMoved(land, idempotencyKey);
      this.setBalance(userId, q.output);
      this.chipTx.record({
        txKind: "deposit", to: userId, amount: q.output, reason: "チップ預入",
        landAmount: landIn, ledgerTxId: land.tx.id,
      });
      this.events.log("chip_deposit", { actor: userId, payload: { landIn, chips: q.output } });
      return q;
    });
  }

  /** 自由チップを Land へ返還する（常に 1:1）。 */
  redeem(userId: string, chipsIn: number, idempotencyKey: string): ChipQuote {
    if (!Number.isInteger(chipsIn) || chipsIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { chipsIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: `user:${userId}` }, (): ChipQuote => {
      // 残高の検査はグループの中で行う。外でやると、成功後の再試行が
      // 「保存済みの結果を返す」前に残高不足で落ちてしまう
      const held = this.balanceOf(userId);
      if (held < chipsIn) throw new EtherError("ERR_INSUFFICIENT_ETHER", { held, chipsIn });
      const q = this.quoteRedeem(chipsIn);
      const payout = this.ledger.transfer({
        from: this.reserveHolder(), to: `user:${userId}`, amount: q.output, type: "chip_redeem", actor: `user:${userId}`,
        approvedBy: ETHER_APPROVER, reason: "賭場チップ返還", refType: "casino_chip", refId: userId, idempotencyKey,
      });
      this.assertLandMoved(payout, idempotencyKey);
      this.setBalance(userId, -chipsIn);
      this.chipTx.record({
        txKind: "redeem", from: userId, amount: chipsIn, reason: "チップ返還",
        landAmount: q.output, ledgerTxId: payout.tx.id,
      });
      this.events.log("chip_redeem", { actor: userId, payload: { chipsIn, land: q.output } });
      return q;
    });
  }

  /** 胴元などのチップを、システム口座の Land へ 1:1 で精算する。 */
  redeemToAccount(holderId: string, chipsIn: number, destAccount: string, actor: string, idempotencyKey: string): ChipQuote {
    if (!Number.isInteger(chipsIn) || chipsIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { chipsIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: actor }, (): ChipQuote => {
      const held = this.balanceOf(holderId);
      if (held < chipsIn) throw new EtherError("ERR_INSUFFICIENT_ETHER", { held, chipsIn });
      const q = this.quoteRedeem(chipsIn);
      const settle = this.ledger.transfer({
        from: this.reserveHolder(), to: destAccount, amount: q.output, type: "chip_settle", actor,
        approvedBy: ETHER_APPROVER, reason: "賭場収益の精算", refType: "casino_chip", refId: holderId, idempotencyKey,
      });
      this.assertLandMoved(settle, idempotencyKey);
      this.setBalance(holderId, -chipsIn);
      this.chipTx.record({
        txKind: "redeem", from: holderId, amount: chipsIn, reason: "賭場収益の精算",
        landAmount: q.output, ledgerTxId: settle.tx.id,
      });
      this.events.log("chip_settle", { actor, payload: { holderId, chipsIn, land: q.output, dest: destAccount } });
      return q;
    });
  }

  /**
   * システム口座(部署など)の Land を元手に、1:1でチップを holder へ発行する。
   */
  fundFromAccount(srcAccount: string, landIn: number, holderId: string, idempotencyKey: string): { land: number; ether: number } {
    if (!Number.isInteger(landIn) || landIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { landIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "deposit", actorId: ETHER_APPROVER }, () => {
      const q = this.quoteDeposit(landIn);
      const land = this.ledger.transfer({
        from: srcAccount, to: this.reserveHolder(), amount: landIn, type: "chip_fund", actor: ETHER_APPROVER,
        approvedBy: ETHER_APPROVER, reason: "胴元の元手", refType: "casino_chip", refId: holderId, idempotencyKey,
      });
      this.assertLandMoved(land, idempotencyKey);
      this.setBalance(holderId, q.output);
      this.chipTx.record({
        txKind: "deposit", to: holderId, amount: q.output, reason: "胴元の元手",
        landAmount: landIn, ledgerTxId: land.tx.id,
      });
      this.events.log("chip_fund", { actor: holderId, payload: { land: landIn, chips: q.output, src: srcAccount } });
      return { land: landIn, ether: q.output };
    });
  }

  /**
   * @deprecated `redeemToAccount` を使う。1:1化により、旧「fair」区別は不要。
   *
   * **予約済み債務は出せない**（PR5）。進行中ゲームの最大配当の裏付けを部署口座へ
   * 移せてしまうと、予約が支払保証にならない。`settleableBalance()` を超える要求は
   * `ERR_RESERVED_FUNDS` で断る。予約が無ければ従来どおり全額戻せる
   * （＝全部戻すと準備プールもちょうど空になる）。
   */
  redeemFairToAccount(holderId: string, etherIn: number, destAccount: string, idempotencyKey: string): { ether: number; land: number } {
    if (!Number.isInteger(etherIn) || etherIn <= 0) throw new EtherError("ERR_BAD_AMOUNT", { etherIn });
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: ETHER_APPROVER }, () => {
      const held = this.balanceOf(holderId);
      if (held < etherIn) throw new EtherError("ERR_INSUFFICIENT_ETHER", { held, etherIn });
      // 予約の再確認もグループ（＝同一トランザクション）の中で行う
      const settleable = this.settleableBalance(holderId);
      if (settleable < etherIn) {
        throw new EtherError("ERR_RESERVED_FUNDS", { held, settleable, reserved: held - settleable, etherIn });
      }
      const land = etherIn;
      const settle = this.ledger.transfer({
        from: this.reserveHolder(), to: destAccount, amount: land, type: "chip_settle", actor: ETHER_APPROVER,
        approvedBy: ETHER_APPROVER, reason: "胴元の売上精算", refType: "casino_chip", refId: holderId, idempotencyKey,
      });
      this.assertLandMoved(settle, idempotencyKey);
      this.setBalance(holderId, -etherIn);
      this.chipTx.record({
        txKind: "redeem", from: holderId, amount: etherIn, reason: "胴元の売上精算",
        landAmount: land, ledgerTxId: settle.tx.id,
      });
      this.events.log("chip_settle", { actor: holderId, payload: { chips: etherIn, land, dest: destAccount } });
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

}

/**
 * @deprecated PR8後の新規コードでは使わない。内部テストと既存プラグインを段階移行させる
 * 互換コンストラクタであり、変動レートの振る舞いは復活させない。
 */
export interface EtherExchangeOptions extends ChipLedgerOptions {
  /** @deprecated 無視される。チップの交換比率は常に1:1。 */
  baseRate?: number | (() => number);
}

/** @deprecated `ChipLedger` を使うこと。 */
export class EtherExchange extends ChipLedger {
  constructor(db: Database.Database, ledger: Ledger, events: EventLog, options: EtherExchangeOptions = {}) {
    super(db, ledger, events, options);
  }

  /** @deprecated `deposit` を使うこと。常に1:1で処理される。 */
  buy(userId: string, landIn: number, idempotencyKey: string): ChipQuote {
    return this.deposit(userId, landIn, idempotencyKey);
  }
  /** @deprecated `redeem` を使うこと。常に1:1で処理される。 */
  sell(userId: string, chipsIn: number, idempotencyKey: string): ChipQuote {
    return this.redeem(userId, chipsIn, idempotencyKey);
  }
  /** @deprecated `quoteDeposit` を使うこと。 */
  quoteBuy(landIn: number): ChipQuote {
    return this.quoteDeposit(landIn);
  }
  /** @deprecated `quoteRedeem` を使うこと。 */
  quoteSell(chipsIn: number): ChipQuote {
    return this.quoteRedeem(chipsIn);
  }
  /** @deprecated 交換比率は常に1。 */
  rate(): number {
    return 1;
  }
}
