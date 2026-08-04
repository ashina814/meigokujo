import type Database from "better-sqlite3";
import { Ledger } from "../ledger/service.js";
import { EventLog } from "../events/service.js";
import { ChipTx, LEGACY_OPENING_VERSION, FORMAL_OPENING_VERSION } from "./chip-tx.js";

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

/**
 * `ChipLedgerError` の公開エラーコード（PR8監査・項目11）。
 *
 * 賭場チップ台帳が投げる失敗の**唯一の正本**。`ERR_CASINO_OPENING_NOT_COMPLETE` は
 * `chip-ledger.ts` の正式開業ロックが投げる値だが、型はここで一元管理する
 * （`as never` でコード側の型検査を迂回させない）。
 *
 * エテル時代の名前（`ERR_INSUFFICIENT_ETHER`）はこの union には**含めない**。
 * 残すと `e.code === "ERR_INSUFFICIENT_ETHER"` が新コードでも型検査を通ってしまい、
 * 旧名称への依存が静かに増える。互換が要る箇所は下の deprecated 定数だけを使う。
 */
export type ChipLedgerErrorCode =
  /** 金額が正の safe integer でない（0・負数・小数・NaN・Infinity・safe範囲外・演算後の桁溢れ） */
  | "ERR_BAD_AMOUNT"
  /** userId/holderId/account/actor/idempotencyKey が空・空白のみ・非string（PR8監査・項目10） */
  | "ERR_BAD_IDENTIFIER"
  /** 保有チップが足りない */
  | "ERR_INSUFFICIENT_CHIPS"
  /** 別の操作が同じ Land 冪等キーを使った（資金は一切動かさない） */
  | "ERR_DUPLICATE"
  /** 予約済み債務の裏付けまで精算しようとした（PR5） */
  | "ERR_RESERVED_FUNDS"
  /** 同一保有者への内部移動（from === to）（PR8監査・項目10） */
  | "ERR_SELF_TRANSFER"
  /** 正式開業（opening_v1）確定前に資金グループを開こうとした（PR8監査・ブロッカーA） */
  | "ERR_CASINO_OPENING_NOT_COMPLETE"
  /** opening_version が legacy_pre_reset / opening_v1 のどちらでもない（PR8監査・ブロッカーC） */
  | "ERR_UNKNOWN_OPENING_VERSION"
  /** DB上の残高・発行総量・準備額が safe integer でない／負数（DB破損・PR8監査・項目10） */
  | "ERR_CORRUPT_BALANCE";

/** @deprecated `ChipLedgerErrorCode` を使うこと。名前だけの後方互換。 */
export type EtherErrorCode = ChipLedgerErrorCode;

/** @deprecated `"ERR_INSUFFICIENT_CHIPS"` を直接使うこと。旧名称からの移行用エイリアス。 */
export const ERR_INSUFFICIENT_ETHER: ChipLedgerErrorCode = "ERR_INSUFFICIENT_CHIPS";
/** @deprecated `"ERR_BAD_IDENTIFIER"` を直接使うこと。旧名称からの移行用エイリアス。 */
export const ERR_BAD_INPUT: ChipLedgerErrorCode = "ERR_BAD_IDENTIFIER";
/** @deprecated `"ERR_CORRUPT_BALANCE"` を直接使うこと。旧名称からの移行用エイリアス。 */
export const ERR_CORRUPTED_BALANCE: ChipLedgerErrorCode = "ERR_CORRUPT_BALANCE";

export class ChipLedgerError extends Error {
  constructor(
    readonly code: ChipLedgerErrorCode,
    readonly meta: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "ChipLedgerError";
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

/**
 * 金額の入力検証（PR8監査・項目10）。`Number.isInteger` だけでは
 * `Number.MAX_SAFE_INTEGER` 超の値を弾けない（浮動小数点の精度限界で整数に見えてしまう）ため、
 * 常に正の safe integer を要求する。0・負数・NaN・Infinity・小数もここで拒否する。
 */
function assertSafeAmount(amount: unknown, field: string): asserts amount is number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new ChipLedgerError("ERR_BAD_AMOUNT", { field, [field]: amount });
  }
}

/**
 * 文字列引数の入力検証（PR8監査・項目10）。空・空白のみ・非stringを fail-closed で拒否する。
 *
 * `"__proto__"` `"constructor"` のような文字列は**通常の識別子として通す**。
 * この層は保有者IDを SQLite の bind パラメータとしてしか使わず、JS オブジェクトの
 * キーには一度もしない（残高の集約は `Object` リテラルではなく `Map`）ので、
 * プロトタイプ汚染の経路が存在しない。ここで弾くと逆に
 * 「その ID の保有者だけ資金操作できない」不具合になる。
 */
function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new ChipLedgerError("ERR_BAD_IDENTIFIER", { field, [field]: value });
}

/**
 * DBから読んだ残高・発行総量・準備額の健全性検査（PR8監査・項目10）。
 *
 * 負数・非整数・safe integer 範囲外は**DB破損**として fail-closed にする。
 * そのまま信じて計算を続けると、破損値を土台にした資金移動を成立させてしまう。
 */
function assertSafeBalance(amount: unknown, field: string, meta: Record<string, unknown> = {}): number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw new ChipLedgerError("ERR_CORRUPT_BALANCE", { field, [field]: amount, ...meta });
  }
  return amount;
}

/**
 * 加算結果が safe integer に収まることを確かめる（PR8監査・項目10）。
 *
 * 個々の入力が safe でも `残高 + 入金` が 2^53 を超えると、以後その残高は
 * 1 単位の精度を失う。桁が溢れる操作は成立させない。
 */
function assertSafeSum(total: number, field: string, meta: Record<string, unknown> = {}): number {
  if (!Number.isSafeInteger(total)) throw new ChipLedgerError("ERR_BAD_AMOUNT", { field, [field]: total, ...meta });
  return total;
}

/**
 * 賭場チップ台帳の**唯一の実装**（PR8監査・ブロッカーA）。
 *
 * 正式開業ロックはこのクラスに**組み込まれていて、外せない**。
 * ロックなしの派生・ロックを解除するコンストラクタオプションは提供しない。
 * かつてはロックなしの実装を別名で公開し、「production の call site が
 * 0 件であること」をソース検査で担保していたが、迂回経路が存在するかぎり
 * 新しいコードが 1 行足すだけでロックを外せてしまう。**経路そのものを消す**。
 *
 * 唯一の例外は chipTx の runMaintenance 区間（起動時の復旧・正式開業初期化）。
 * ここだけは版が `opening_v1` でなくても資金を動かせる。許可経路を actor 文字列では
 * なく「その区間を通ったかどうか」にしてあるので、呼び出し側が
 * 名乗るだけでは素通りできない。
 */
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
    assertNonEmptyString(holderId, "holderId");
    const reserved = this.reservedOfFn(holderId);
    // 予約額そのものが壊れていたら「予約 0」に丸めない。丸めると破損時に
    // 予約されているはずの資金を全額精算できてしまう（fail-open）。
    assertSafeBalance(reserved, "reservedAmount", { holderId });
    return Math.max(0, this.balanceOf(holderId) - reserved);
  }

  /**
   * 業務操作を1グループとして実行する（仕様書 I5）。
   * チップを動かす処理は必ずこの中で行う。すでに外側のグループがあれば合流する。
   *
   * **正式開業ロックはここで効く**（PR8監査・ブロッカーA）。判定を `runGroup` の
   * 本体側へ置くのは、`chipTx.runGroup` が「処理済みグループなら本体を実行せず
   * 保存済み結果を返す」ためで、そうしておくと**成功済み操作の再試行**は
   * 版が変わっても同じ結果を返し続ける（資金は動かないので安全）。
   */
  runGroup<T>(input: { groupKey: string; kind: string; actorId: string }, body: () => T): T {
    return this.chipTx.runGroup(input, () => {
      this.assertOpeningReady(input);
      return body();
    });
  }

  /**
   * 正式開業（`opening_v1`）が確定するまで、新しい資金グループを開かせない。
   *
   * 復旧・正式開業初期化は chipTx の runMaintenance 区間として明示的に通る。
   * それ以外の経路（利用者操作・運営卓・scheduler・進行中のゲーム）は、
   * 版が `opening_v1` になるまで一律で断る。
   */
  private assertOpeningReady(input: { groupKey: string; kind: string; actorId: string }): void {
    if (this.chipTx.isMaintenance()) return;
    const version = this.chipTx.currentVersion();
    if (version === FORMAL_OPENING_VERSION) return;
    throw new ChipLedgerError("ERR_CASINO_OPENING_NOT_COMPLETE", {
      version,
      requiredVersion: FORMAL_OPENING_VERSION,
      ...input,
    });
  }

  /** 準備プールの Land 残高 */
  pool(): number {
    const holder = this.reserveHolder();
    return assertSafeBalance(this.ledger.balanceOf(holder), "reserveAmount", { holder });
  }
  /**
   * 現在のチップ制度が使う準備口座。opening_v1 は PR12 が確定する。
   *
   * **fail-closed**（PR8監査・ブロッカーC）。対応する版を明示的に列挙し、
   * 空文字・typo・DB破損・`opening_v2`・将来未対応版など未知の版を
   * 「旧制度（legacy_pre_reset）」として扱わない。未知版では準備口座そのものが
   * 決まらない以上、預入・返還・精算・pool読み取りのいずれも進めてはいけない。
   */
  reserveHolder(): string {
    const version = this.chipTx.currentVersion();
    if (version === LEGACY_OPENING_VERSION) return ETHER_ESCROW;
    if (version === FORMAL_OPENING_VERSION) return CHIP_ESCROW;
    throw new ChipLedgerError("ERR_UNKNOWN_OPENING_VERSION", { version });
  }
  /**
   * 発行済みチップ総数。
   *
   * 100%準備の検算（検算B）の左辺そのものなので、SUM が壊れていたら
   * 「準備は足りている」と誤認する前に落とす（PR8監査・項目10）。
   */
  outstanding(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM ether_balances").get() as { s: number };
    return assertSafeBalance(row.s, "outstanding");
  }
  balanceOf(holderId: string): number {
    assertNonEmptyString(holderId, "holderId");
    const row = this.db.prepare("SELECT amount FROM ether_balances WHERE user_id = ?").get(holderId) as { amount: number } | undefined;
    if (row === undefined) return 0;
    return assertSafeBalance(row.amount, "balance", { holderId });
  }

  /**
   * Land 取引が実際に成立したかを確かめる。Ledger は重複キーで例外を出さず no-op を返すので、
   * それを見逃すと「Land を動かさずチップだけ発行/消却」の不整合になる。
   *
   * 同じ操作の再実行は `runGroup` が保存済みの結果で返す（ここへ来ない）。ここへ来るのは
   * **別の操作が同じ Land 冪等キーを使った**場合なので、資金を動かさず失敗させる。
   */
  private assertLandMoved(result: { duplicate: boolean }, idempotencyKey: string): void {
    if (result.duplicate) throw new ChipLedgerError("ERR_DUPLICATE", { idempotencyKey });
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
    assertNonEmptyString(holderId, "holderId");
    const ts = now();
    this.db
      .prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, 0, ?) ON CONFLICT(user_id) DO NOTHING")
      .run(holderId, ts);
  }

  /**
   * Land を預け、同額の自由チップを受け取る。
   *
   * 見積りでも入力検証を省かない（PR8監査・項目10）。素通しにすると UI が
   * `-1` や `1e30` をそのまま「受け取れる額」として表示し、実際の `deposit()` で
   * 初めて失敗する——という食い違いが生まれる。
   */
  quoteDeposit(landIn: number): ChipQuote {
    assertSafeAmount(landIn, "landIn");
    return { input: landIn, output: landIn, burned: 0 };
  }

  /** 自由チップを返還し、同額の Land を受け取る。 */
  quoteRedeem(chipsIn: number): ChipQuote {
    assertSafeAmount(chipsIn, "chipsIn");
    return { input: chipsIn, output: chipsIn, burned: 0 };
  }

  /** Land を預けて自由チップを発行する（常に 1:1）。 */
  deposit(userId: string, landIn: number, idempotencyKey: string): ChipQuote {
    assertNonEmptyString(userId, "userId");
    assertNonEmptyString(idempotencyKey, "idempotencyKey");
    assertSafeAmount(landIn, "landIn");
    return this.runGroup({ groupKey: idempotencyKey, kind: "deposit", actorId: `user:${userId}` }, (): ChipQuote => {
      const q = this.quoteDeposit(landIn);
      assertSafeSum(this.balanceOf(userId) + q.output, "chipBalanceAfter", { holderId: userId });
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
    assertNonEmptyString(userId, "userId");
    assertNonEmptyString(idempotencyKey, "idempotencyKey");
    assertSafeAmount(chipsIn, "chipsIn");
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: `user:${userId}` }, (): ChipQuote => {
      // 残高の検査はグループの中で行う。外でやると、成功後の再試行が
      // 「保存済みの結果を返す」前に残高不足で落ちてしまう
      const held = this.balanceOf(userId);
      if (held < chipsIn) throw new ChipLedgerError("ERR_INSUFFICIENT_CHIPS", { held, chipsIn });
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

  /**
   * 胴元などのチップを、システム口座の Land へ 1:1 で精算する。
   *
   * **予約済み債務は出せない**（PR5 / PR8監査・ブロッカーB）。進行中ゲームの最大配当の
   * 裏付けをシステム口座へ移せてしまうと、予約が支払保証にならない。`settleableBalance()`
   * を超える要求は `ERR_RESERVED_FUNDS` で断る（1 Ldも1 chipも動かさない）。
   * 予約の再確認は `runGroup` と同じ IMMEDIATE トランザクションの中で行う
   * （成功後の再試行を、その後に増減した予約状態で誤って落とさないため）。
   */
  redeemToAccount(holderId: string, chipsIn: number, destAccount: string, actor: string, idempotencyKey: string): ChipQuote {
    assertNonEmptyString(holderId, "holderId");
    assertNonEmptyString(destAccount, "destAccount");
    assertNonEmptyString(actor, "actor");
    assertNonEmptyString(idempotencyKey, "idempotencyKey");
    assertSafeAmount(chipsIn, "chipsIn");
    return this.runGroup({ groupKey: idempotencyKey, kind: "redeem", actorId: actor }, (): ChipQuote => {
      const held = this.balanceOf(holderId);
      if (held < chipsIn) throw new ChipLedgerError("ERR_INSUFFICIENT_CHIPS", { held, chipsIn });
      const settleable = this.settleableBalance(holderId);
      if (settleable < chipsIn) {
        throw new ChipLedgerError("ERR_RESERVED_FUNDS", { held, settleable, reserved: held - settleable, chipsIn });
      }
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
    assertNonEmptyString(srcAccount, "srcAccount");
    assertNonEmptyString(holderId, "holderId");
    assertNonEmptyString(idempotencyKey, "idempotencyKey");
    assertSafeAmount(landIn, "landIn");
    return this.runGroup({ groupKey: idempotencyKey, kind: "deposit", actorId: ETHER_APPROVER }, () => {
      const q = this.quoteDeposit(landIn);
      assertSafeSum(this.balanceOf(holderId) + q.output, "chipBalanceAfter", { holderId });
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
   * @deprecated `redeemToAccount` を使うこと。1:1化により、旧「fair」区別は不要。
   *
   * **独自のロジックは持たない**（PR8監査・ブロッカーB）。予約保護は `redeemToAccount`
   * 自身が常に行うため、ここは actor を `ETHER_APPROVER` に固定した単純な委譲にする。
   * 資金処理ロジックを2本持つと、どちらか一方だけ直した場合に保護が食い違う。
   */
  redeemFairToAccount(holderId: string, etherIn: number, destAccount: string, idempotencyKey: string): { ether: number; land: number } {
    // 入力検証も `redeemToAccount` に一本化する（ここで先回りして検査すると、
    // 2本の検証が食い違ったときにどちらが正かが分からなくなる）。
    const q = this.redeemToAccount(holderId, etherIn, destAccount, ETHER_APPROVER, idempotencyKey);
    return { ether: q.input, land: q.output };
  }

  /**
   * カジノ内のエテル移動（賭け・配当）。台帳(Land)は動かさず総量保存。
   * 理由の指定は必須で、グループの外では動かせない（記録できない移動を作らないため）。
   */
  transfer(fromHolderId: string, toHolderId: string, amount: number, move: ChipMoveInfo): void {
    assertNonEmptyString(fromHolderId, "fromHolderId");
    assertNonEmptyString(toHolderId, "toHolderId");
    assertSafeAmount(amount, "amount");
    // 自分から自分への移動は、総量は変わらないのに明細だけが増える。
    // 「移動した」という記録が残ると戦績・検算の解釈が濁るので、成立させない。
    if (fromHolderId === toHolderId) throw new ChipLedgerError("ERR_SELF_TRANSFER", { holderId: fromHolderId, amount });
    // 検査も更新も1つのトランザクションに入れる。外で検査すると、別接続が
    // その隙に残高を減らした場合に残高不足のまま更新へ進んでしまう。
    this.db.transaction(() => {
      const held = this.balanceOf(fromHolderId);
      if (held < amount) throw new ChipLedgerError("ERR_INSUFFICIENT_CHIPS", { held, amount });
      assertSafeSum(this.balanceOf(toHolderId) + amount, "chipBalanceAfter", { holderId: toHolderId });
      this.setBalance(fromHolderId, -amount);
      this.setBalance(toHolderId, amount);
      this.chipTx.record({ txKind: "internal_transfer", from: fromHolderId, to: toHolderId, amount, ...move });
    })();
  }

}

/**
 * @deprecated PR8後の新規コードでは使わない。既存の呼び出しを段階移行させるための
 * 互換コンストラクタであり、変動レートの振る舞いは復活させない。
 */
export interface EtherExchangeOptions extends ChipLedgerOptions {
  /** @deprecated 無視される。チップの交換比率は常に1:1。 */
  baseRate?: number | (() => number);
}

/**
 * @deprecated `ChipLedger` を使うこと。名前だけの後方互換で、**同じ正式開業ロックを通る**。
 * ロックを外した派生は存在しない（PR8監査・ブロッカーA）。
 */
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
