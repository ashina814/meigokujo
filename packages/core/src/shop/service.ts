import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";
import type { Departments } from "../departments/service.js";

/**
 * 公式ショップ（冥界商館）。
 * Land支払いは焼却（tip_burn 型で TREASURY へ）。**自動再課金はしない**（期限が来たら失効）。
 * 商品ごとに階級ロール制限・在庫・自動/手動配送を持たせられる。
 */

export type ItemKind = "one_shot" | "monthly";
export type DeliveryMode = "auto" | "manual";
export type DeliveryKind =
  | "add_role"
  | "extend_deadline"
  | "set_nickname"
  | "create_original_role"
  | "activate_sub_account"
  | "revoke_meirei"
  | null;
export type PurchaseStatus = "active" | "expired" | "refunded" | "cancelled";
export type ShopPurchaseTitleOrigin =
  | "storefront"
  | "original_role_application"
  | "original_role_invoice"
  | "evaluation_extension"
  | "reevaluation"
  | "legacy_timed_access_import";

export interface ShopItemInput {
  name: string;
  description?: string | null;
  price_land: number | null;
  price_alt_kind?: string | null;
  price_alt_amount?: number | null;
  kind: ItemKind;
  duration_days?: number | null;
  require_role_id?: string | null;
  delivery: DeliveryMode;
  delivery_kind?: DeliveryKind;
  delivery_data?: string | null;
  stock?: number | null;
  enabled?: boolean;
}

export interface ShopItemRow {
  id: number;
  name: string;
  description: string | null;
  price_land: number | null;
  price_alt_kind: string | null;
  price_alt_amount: number | null;
  kind: ItemKind;
  duration_days: number | null;
  require_role_id: string | null;
  delivery: DeliveryMode;
  delivery_kind: DeliveryKind;
  delivery_data: string | null;
  stock: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface PurchaseRow {
  id: number;
  item_id: number;
  user_id: string;
  purchased_at: number;
  expires_at: number | null;
  paid_land: number | null;
  paid_alt_kind: string | null;
  paid_alt_amount: number | null;
  status: PurchaseStatus;
  delivered_at: number | null;
  auto_renew: number;
  delivery_snapshot_json: string | null;
  /** 本人が入力した内容（希望ニックネームなど） */
  request_json: string | null;
  delivery_state: DeliveryState | null;
  delivery_attempts: number;
  delivery_error: string | null;
  delivery_updated_at: number | null;
}

/**
 * 配送状態。**課金の成否とは独立**に持つ。
 *
 * 課金が通ってから配送が失敗する経路が実在し（迷霊ロールの剥奪失敗）、
 * 「購入は成立したが配送は終わっていない」を表せないと、再配送も検知もできなかった。
 */
export type DeliveryState = "pending" | "delivered" | "failed";

/** 購入時に凍結した配送内容。**再配送はこれだけを正本にする** */
export interface DeliverySnapshot {
  delivery: DeliveryMode;
  delivery_kind: Exclude<DeliveryKind, null>;
  delivery_data: Record<string, unknown>;
  captured_at?: number;
}

export interface TimedAccessConfig {
  roleId: string;
  channelId: string | null;
}

export interface TimedAccessGrant extends TimedAccessConfig {
  purchase: PurchaseRow;
  item: ShopItemRow;
}

export interface TimedAccessLegacyMigrationExpectation {
  itemId: number;
  roleId: string;
  expectedCount: number;
  roleHolderIds: readonly string[];
}

export interface TimedAccessLegacyMigrationPlanItem {
  itemId: number;
  roleId: string;
  expectedCount: number;
  actualCount: number;
  candidateUserIds: string[];
}

export interface TimedAccessLegacyMigrationPlan {
  items: TimedAccessLegacyMigrationPlanItem[];
  expectedTotal: number;
  actualTotal: number;
  matchesExpected: boolean;
}

export interface TimedAccessLegacyImportRow {
  purchase_id: number;
  migration_key: string;
  item_id: number;
  user_id: string;
  role_id: string;
  started_at: number;
  expires_at: number;
  reason: string;
  actor_id: string;
  created_at: number;
}

export interface TimedAccessLegacyMigrationResult {
  alreadyApplied: boolean;
  plan: TimedAccessLegacyMigrationPlan;
  imports: TimedAccessLegacyImportRow[];
}

/**
 * いま自動配送してよい種別。
 *
 * `revoke_meirei` は**意図的に外してある**。再評価チャレンジは
 * 「購入 → 再評価面談チケット → 人間が面談 → OKなら亡霊へ復帰」へ仕様変更され、
 * 購入時点では status もロールも評価期間も動かさない。過去に売った購入も
 * 自動では実行しない（面談を経ずに復帰させないため）。
 */
export const AUTO_DELIVERABLE_KINDS: ReadonlySet<string> = new Set([
  "add_role",
  "extend_deadline",
  "set_nickname",
  "create_original_role",
  "activate_sub_account",
]);
/** 過去に自動配送として売られたが、いまは自動実行しない種別 */
export const WITHDRAWN_DELIVERY_KINDS: ReadonlySet<string> = new Set(["revoke_meirei"]);

/**
 * **まだ結果が確定していない claim の状態。**
 *
 * 「外部へ投げている最中」と「投げたが結果が分からない」は扱いが同じ——どちらも
 * 返金・失効・再配送を止める。
 *
 * この集合は Core の判定だけでなく、**DBの部分ユニーク索引**
 * （`uq_shop_external_delivery_open`: 1 purchase につき生きた claim は1つ）
 * の定義にも使う。片方だけ書き換えると、Coreが「生きている」と見なす集合と
 * DBが1件に縛る集合がズレて、守りに穴が開く。
 *
 * **索引はDBに焼き付くので、この集合を変えるときはmigrationが要る。**
 * 定数を書き換えただけでは、既存DBの索引は古い集合のまま残る。
 */
export const EXTERNAL_CLAIM_LIVE_STATES = ["in_flight", "uncertain"] as const;

export type ExternalClaimLiveState = (typeof EXTERNAL_CLAIM_LIVE_STATES)[number];

/** 上の集合を SQL の `IN (...)` リテラルにしたもの。DDLとCore queryが同じ文字列を使う */
export const EXTERNAL_CLAIM_LIVE_STATES_SQL = `(${EXTERNAL_CLAIM_LIVE_STATES.map((v) => `'${v}'`).join(",")})`;
const KNOWN_DELIVERY_KINDS: ReadonlySet<string> = new Set([...AUTO_DELIVERABLE_KINDS, ...WITHDRAWN_DELIVERY_KINDS]);

/**
 * 購入行の配送スナップショットを読む。
 *
 * **商品の現在定義へフォールバックしない。** 「購入時の配送内容だけを再実行する」という
 * 設計なので、スナップショットが無い・壊れている・知らない種別なら `null` を返し、
 * 呼び出し側は何もしない（legacy unknown として扱う）。
 */
export function parseDeliverySnapshot(raw: string | null | undefined): DeliverySnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { delivery?: unknown; delivery_kind?: unknown; delivery_data?: unknown; captured_at?: unknown };
    if (parsed.delivery !== "auto") return null; // 自動配送として売った記録が無い
    if (typeof parsed.delivery_kind !== "string" || !KNOWN_DELIVERY_KINDS.has(parsed.delivery_kind)) return null;
    let data: Record<string, unknown> = {};
    if (typeof parsed.delivery_data === "string" && parsed.delivery_data.trim()) {
      data = JSON.parse(parsed.delivery_data) as Record<string, unknown>;
    } else if (parsed.delivery_data && typeof parsed.delivery_data === "object") {
      data = parsed.delivery_data as Record<string, unknown>;
    }
    return {
      delivery: "auto",
      delivery_kind: parsed.delivery_kind as Exclude<DeliveryKind, null>,
      delivery_data: data,
      captured_at: typeof parsed.captured_at === "number" ? parsed.captured_at : undefined,
    };
  } catch {
    return null; // 壊れている。現在の商品定義で代用しない
  }
}

/**
 * `delivery_data` から `role_id` を厳密に取り出す。
 *
 * 商品側はJSON文字列、購入時スナップショット側は既にパース済みのオブジェクトで来る。
 * どちらも受けるが、**文字列として入っている role_id 以外は認めない**——数値や真偽値を
 * ロールIDへ変換して剥奪対象にしない。
 */
function parseRoleIdFromDeliveryData(raw: unknown): string | null {
  let data: Record<string, unknown> | null = null;
  if (typeof raw === "string" && raw.trim()) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    data = raw as Record<string, unknown>;
  }
  if (!data) return null;
  const roleId = data.role_id;
  return typeof roleId === "string" && roleId.trim() ? roleId.trim() : null;
}

export interface ShopRoleRevocationRow {
  purchase_id: number;
  user_id: string;
  role_id: string | null;
  status: "pending" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  /**
   * このworkerがDiscordの `roles.remove()` を呼びにいった時刻。
   *
   * **remove の直前に書く。** 呼んだ直後にプロセスが落ちても、再起動後に
   * 「自分が外したかもしれない」と分かるようにするため。ここが立っている行は、
   * 有効な契約があるという理由だけで done にしてはいけない——Discordの実体を見て、
   * roleが無ければ戻してから完了する。
   */
  remove_attempted_at: number | null;
}

/** 購入した時点で「どのロールを与える契約だったか」。append-only。 */
export interface RoleGrantProvenanceRow {
  readonly purchase_id: number;
  /** role=対象を特定できた / non_role=ロール契約ではない / invalid=add_roleだが対象不明 */
  readonly grant_kind: "role" | "non_role" | "invalid";
  readonly role_id: string | null;
  readonly delivery_mode: "auto" | "manual";
  readonly source: string;
  readonly captured_at: number;
}

/**
 * 失効時にどのロールを剥がすべきか。**現在の商品設定は一切見ない。**
 *
 * - `proven`         … 購入時のimmutableな記録からロールを特定できる
 * - `proven_non_role`… 購入時にロールを与える契約ではなかったと証明できる
 * - `legacy_unknown` … 購入時の契約を証明できない（推測して剥がさない）
 */
/**
 * 同じロールを与える「有効な別契約」の強さ。
 *
 * - `delivered` … 提供済みの証拠がある。古い失効を完了してよい
 * - `unsettled` … 契約はあるが提供されたか未確定。**剥がさないが、完了もしない**
 * - `none`      … 守る契約が無い。通常どおり剥奪してよい
 *
 * `unsettled` を `delivered` と同じ扱いにすると、未配送の新規購入を見て古い失効を
 * 完了させたあとにその購入が返金され、**誰も持っていないはずのロールだけが残る**。
 */
export type RoleEntitlementState = "delivered" | "unsettled" | "none";

export type RoleGrantTarget =
  | { readonly kind: "proven"; readonly roleId: string; readonly source: string }
  | { readonly kind: "proven_non_role" }
  | { readonly kind: "legacy_unknown" };

/** 購入した時点の提供のしかた。append-only。 */
export interface FulfillmentProvenanceRow {
  readonly purchase_id: number;
  readonly delivery_mode: "auto" | "manual";
  readonly stock_consumed: 0 | 1;
  readonly captured_at: number;
  readonly source: string;
}

/** 在庫を戻した記録。purchase_idが主キーなので二度戻らない。 */
/**
 * 外部（Discord）へ副作用を投げているあいだの durable な場所取り。
 *
 * `in_flight` / `uncertain` のあいだは、返金も失効もこの購入を動かせない。
 * `uncertain` は「投げたが結果を確認できていない」——**推測で返金も剥奪もしない**ため、
 * 解決するまで生き続ける。
 */
/**
 * 運営が下せる決着。
 *
 * - `delivered`     … 提供済みだと確認した
 * - `no_effect`     … 提供されていないと確認した（返金・再試行へ進める）
 * - `still_unknown` … まだ判断できない。**状態を変えない**
 */
export type OperatorDecision = "delivered" | "no_effect" | "still_unknown";

/** 何が原因で止まっている案件か。 */
export type UnresolvedCaseKind = "uncertain_delivery" | "legacy_unknown";

export interface OperatorResolutionRow {
  id: number;
  purchase_id: number;
  kind: UnresolvedCaseKind;
  decision: OperatorDecision;
  operator_id: string;
  note: string | null;
  before_state: string;
  after_state: string;
  attempt_token: string | null;
  refunded: number;
  resolved_at: number;
}

/**
 * 決着画面を開いた時点の事実と、選べる決着。
 *
 * `token` は**その時点の事実の指紋**。確定時に作り直して一致しなければ、
 * 画面を開いたあとに状況が変わったということなので1つも書かずに止める。
 */
export interface OperatorResolutionQuote {
  readonly purchaseId: number;
  readonly kind: UnresolvedCaseKind | null;
  readonly userId: string;
  readonly itemName: string;
  readonly purchasedAt: number;
  readonly status: PurchaseStatus;
  readonly deliveryState: DeliveryState | null;
  readonly deliveryKind: string | null;
  /** 止まっている理由（利用者へは出さない運営向けの説明） */
  readonly reason: string;
  readonly stuckSince: number | null;
  readonly refundableAmount: number;
  /** 返金まで一気に確定してよいか（代替支払など、generic refund が扱えないものは false） */
  readonly refundSupported: boolean;
  /**
   * 「提供できていない → もう一度配る」を出してよいか。
   * **決着後に実際に配送やり直しキューへ載る購入だけ** true。
   */
  readonly retrySupported: boolean;
  readonly allowedDecisions: readonly OperatorDecision[];
  readonly token: string;
}

export interface OperatorResolutionResult {
  readonly purchaseId: number;
  readonly decision: OperatorDecision;
  readonly refunded: boolean;
  readonly refundedAmount: number;
  readonly deliveryState: DeliveryState | null;
  readonly status: PurchaseStatus;
}

export type ExternalDeliveryState = "in_flight" | "settled" | "released" | "uncertain";

export interface ExternalDeliveryAttemptRow {
  purchase_id: number;
  attempt_token: string;
  delivery_kind: string;
  state: ExternalDeliveryState;
  started_at: number;
  updated_at: number;
  detail: string | null;
}

export type ExternalDeliveryClaim =
  | { ok: true; token: string }
  | { ok: false; reason: "not_active" | "already_delivered" | "in_flight" | "not_found"; status?: PurchaseStatus };

export interface StockRestorationSettlementRow {
  purchase_id: number;
  item_id: number;
  quantity: number;
  disposition: "applied" | "absorbed";
  settled_at: number;
  actor_id: string;
}

export interface StockRestorationRow {
  readonly purchase_id: number;
  readonly item_id: number;
  readonly quantity: number;
  readonly restored_at: number;
  readonly reason: string;
  /** 1=shop_items.stockを実際に+1した / 0=現在は無制限なので数値は動かさず義務だけ残した */
  readonly applied: 0 | 1;
}

/**
 * 手動対応の完了を試みた結果。
 *
 * `void` を返していた頃は、UPDATEが0件でもBotが「完了しました」と言えてしまった。
 * 何が起きたのかを呼び出し側が必ず受け取る。
 */
export type ManualCompletionReason =
  | "completed"
  | "already_delivered"
  | "not_active"
  | "not_manual"
  | "legacy_unknown";

export interface ManualCompletionResult {
  readonly completed: boolean;
  readonly reason: ManualCompletionReason;
}

/**
 * 購入1件について、**いま安全上効いている事実**をひとまとめにしたもの。
 *
 * 巨大な1本のenumにはしない。ここに並ぶのは互いに直交する事実で、たとえば
 * 同じ `active` でも「提供済み・期限内」と「配送失敗・返金の復旧待ち・期限超過」は
 * まったく別物になる。1本の名前へ潰すと、その違いが消える。
 *
 * **新しい判定はここで作らない。** どの欄も既存の authority をそのまま呼んだ結果で、
 * 一覧SQL・巡回・運営操作と食い違わないことが唯一の存在意義。
 */
export interface ShopSafetySnapshot {
  purchaseId: number;
  /** 契約そのもの */
  contract: {
    status: PurchaseStatus;
    userId: string;
    itemId: number;
    paidLand: number | null;
    paidAltKind: string | null;
    expiresAt: number | null;
  };
  /** 提供したかどうか。`evidence` が authoritative で、`state` は経過にすぎない */
  fulfillment: {
    state: string | null;
    deliveredAt: number | null;
    evidence: boolean;
    provenance: boolean;
    roleGrant: RoleGrantTarget;
  };
  /** 外部へ投げた副作用の場所取り。生きている間は返金も失効も止まる */
  externalClaim: { token: string; state: "in_flight" | "uncertain"; startedAt: number } | null;
  /**
   * 返金。**4つの別々の事実**を分けて持つ。1つの語へ潰さない。
   *
   * - `failureHistory` … 過去に返金処理が失敗した durable evidence（append-only）
   * - `settlementPending` … 利用者への金銭決着が**まだ終わっていない**。
   *   失効を止める authority はこれ。商館が処理できるかは問わない
   * - `recoveryOpen` … **商館**が「返金をやり直す」で終わらせられる
   *   （settlement pending ＋ live claim なし ＋ generic refund 可）
   * - `operationsHandoff` … **運営**へ渡すしかない
   *   （settlement pending ＋ live claim なし ＋ generic refund 不可）
   *
   * **`recoveryOpen === false` を「決着が済んだ」と読んではいけない。**
   * 代替支払では `recoveryOpen=false` / `settlementPending=true` /
   * `operationsHandoff=true` が正しい状態として同時に成り立つ。
   */
  refund: {
    failureHistory: number;
    settlementPending: boolean;
    recoveryOpen: boolean;
    operationsHandoff: boolean;
  };
  /** 人が確認して決着させる案件かどうか */
  operatorCase: { unresolved: boolean; decided: "delivered" | "no_effect" | null };
  /** 期限。止まっているなら、その理由まで */
  expiry: { expiresAt: number | null; due: boolean; blockedBy: ExpiryBlockedReason | null };
  /** 失効後のロール剥奪 */
  revocation: { status: "pending" | "done" | "failed" | null; roleId: string | null; lastError: string | null };
  /**
   * 同時に成り立ってはいけない事実の組み合わせ。**見つけても直さない。**
   * legacyや事故で実在しうるので、「理論上あり得ない」で隠さず数え上げる。
   */
  contradictions: string[];
}

/** 期限が来ていても失効させてはいけない理由 */
export type ExpiryBlockedReason = "delivery_in_flight" | "refund_pending";

export type ShopErrorCode =
  | "ERR_ITEM_NOT_FOUND"
  | "ERR_ITEM_DISABLED"
  | "ERR_NO_STOCK"
  | "ERR_ROLE_REQUIRED"
  | "ERR_NO_PRICE"
  | "ERR_ALREADY_ACTIVE"
  | "ERR_TIMED_ACCESS_CONFIG"
  | "ERR_TIMED_ACCESS_ROLE_PRESENT"
  | "ERR_TIMED_ACCESS_STATE_UNAVAILABLE"
  | "ERR_TIMED_ACCESS_LEGACY_CONFIG"
  | "ERR_TIMED_ACCESS_LEGACY_COUNT"
  | "ERR_TIMED_ACCESS_LEGACY_CONFLICT"
  | "ERR_PURCHASE_NOT_FOUND"
  | "ERR_NOT_OWNER"
  | "ERR_NOT_ACTIVE"
  | "ERR_NOT_EXTENDABLE"
  | "ERR_TERMS_CHANGED"
  | "ERR_SALES_LOCKED"
  | "ERR_ALREADY_DELIVERED"
  | "ERR_REFUND_RACE"
  | "ERR_ORIGINAL_ROLE_SPECIAL_PURCHASE_REQUIRED"
  | "ERR_ORIGINAL_ROLE_ITEM_CONFIG"
  | "ERR_ORIGINAL_ROLE_INVOICE_NOT_FOUND"
  | "ERR_ORIGINAL_ROLE_INVOICE_NOT_PAYABLE"
  | "ERR_REEVAL_SPECIAL_PURCHASE_REQUIRED"
  | "ERR_REEVAL_ITEM_CONFIG"
  | "ERR_REEVAL_STATUS"
  | "ERR_REEVAL_RIGHT_EXISTS"
  | "ERR_REEVAL_INVITES_INSUFFICIENT"
  | "ERR_REEVAL_NOT_CONSUMED"
  | "ERR_REEVAL_ALREADY_COMPENSATED"
  | "ERR_REEVAL_COMPENSATION_UNAVAILABLE"
  | "ERR_REEVAL_INTAKE_UNAVAILABLE"
  | "ERR_ALT_PAYMENT_UNSUPPORTED"
  | "ERR_ALT_REFUND_UNSUPPORTED"
  | "ERR_TERMS_TOKEN_REQUIRED"
  | "ERR_FULFILLMENT_UNKNOWN"
  | "ERR_STOCK_TERMS_CHANGED"
  | "ERR_STOCK_RECONCILIATION_REQUIRED"
  | "ERR_STOCK_RECONCILIATION_NOT_APPLICABLE"
  | "ERR_STOCK_CHANGE_REQUIRES_API"
  | "ERR_STOCK_VALUE_INVALID"
  | "ERR_DELIVERY_IN_FLIGHT"
  | "ERR_CLAIM_UNKNOWN"
  | "ERR_CLAIM_CONFLICT"
  | "ERR_CLAIM_SUPERSEDED"
  | "ERR_CLAIM_STALE"
  | "ERR_RESOLUTION_STALE"
  | "ERR_RESOLUTION_NOT_APPLICABLE"
  | "ERR_RESOLUTION_EVIDENCE_REQUIRED"
  | "ERR_EVAL_EXTENSION_SPECIAL_PURCHASE_REQUIRED"
  | "ERR_EVAL_EXTENSION_ITEM_CONFIG"
  | "ERR_EVAL_EXTENSION_STATUS"
  | "ERR_EVAL_EXTENSION_CYCLE"
  | "ERR_EVAL_EXTENSION_EXPIRED"
  | "ERR_EVAL_EXTENSION_LIMIT";

export class ShopError extends Error {
  constructor(readonly code: ShopErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ShopError";
  }
}

/**
 * 利用者が画面で確認した「購入契約」の正本。generic storefrontで課金する前に、この内容が
 * 表示時と同じであることを確認する。
 *
 * **含めるもの** — 表示した内容そのもの: 商品ID / 支払方法 / Land価格 / 名前 / 説明 /
 * 種別 / 期間 / 必要ロール / 配送方法・種別・設定。同じ価格でも「30日→7日」「role A→role B」
 * のように**中身が変われば別の契約**なので、価格だけを見る実装では足りない。
 *
 * **含めないもの**:
 *   - `stock` の表示時個数 — 他人が1個買っただけで全員の確認をstaleにする必要はない。
 *     確定時に「まだ在庫がある」ことだけ確認する。
 *   - `enabled` — 確定時に現在もenabledかを見れば足りる。
 *   - `updated_at` — 秒単位で、同一秒の複数更新を区別できず、在庫減でも動く。
 *     「どの条件が契約なのか」と一致しないので identity には使わない。
 */
export interface GenericPurchaseTerms {
  readonly itemId: number;
  readonly mode: "land";
  readonly priceLand: number | null;
  readonly name: string;
  readonly description: string | null;
  readonly kind: string;
  readonly durationDays: number | null;
  readonly requireRoleId: string | null;
  readonly delivery: string;
  readonly deliveryKind: string | null;
  readonly deliveryData: string | null;
}

export interface GenericPurchaseQuote {
  readonly terms: GenericPurchaseTerms;
  /** 表示時termsのopaqueな指紋。Discord custom IDへ全termsを埋め込まないための identity。 */
  readonly termsToken: string;
}

/**
 * canonicalization と token生成は**ここ1箇所だけ**。Bot側で同じJSON/hashロジックを
 * 複製すると、片方だけ変えたときに「表示は通るのに課金で落ちる」ような食い違いが生まれる。
 */
function canonicalGenericTerms(item: ShopItemRow): GenericPurchaseTerms {
  return {
    itemId: item.id,
    mode: "land",
    priceLand: item.price_land ?? null,
    name: item.name,
    description: item.description ?? null,
    kind: item.kind,
    durationDays: item.duration_days ?? null,
    requireRoleId: item.require_role_id ?? null,
    delivery: item.delivery,
    deliveryKind: item.delivery_kind ?? null,
    deliveryData: item.delivery_data ?? null,
  };
}

/**
 * 表示した契約の指紋の長さ（文字数）。Discordのcustom ID上限は100文字で、名前変更の
 * 確定ボタンには商品ID・確認ID(19桁)・料金・指紋・希望する名前(最長32文字)が同居する。
 * ここを伸ばすとボタンごとDiscordに拒否されるので、文字数は動かさない。
 */
const GENERIC_TERMS_TOKEN_LENGTH = 16;

/** 指紋のbit幅。base64urlは1文字6bitなので、16文字 = 12バイト = 96bit。 */
const GENERIC_TERMS_TOKEN_BYTES = 12;

/**
 * 生成した指紋が取りうる形（base64urlの文字だけ・決まった長さ）。長さの定数から作るので、
 * 片方だけ変えて「検証は通るのに実際の指紋と形が違う」がおきない。
 */
const GENERIC_TERMS_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${GENERIC_TERMS_TOKEN_LENGTH}}$`);

function genericTermsToken(terms: GenericPurchaseTerms): string {
  // 順序固定のtuple。JSON.stringifyのkey順に依存させない。
  const canonical = JSON.stringify([
    terms.itemId, terms.mode, terms.priceLand, terms.name, terms.description,
    terms.kind, terms.durationDays, terms.requireRoleId,
    terms.delivery, terms.deliveryKind, terms.deliveryData,
  ]);
  // **衝突は「契約が変わったのに気づかない」＝まさに防ぎたい結果**なので、
  // 「衝突しても安全」ではない。文字数は変えられないため、同じ16文字で情報量を上げる。
  // hexは1文字4bitで16文字=64bit。base64urlは1文字6bitなので16文字=96bit。
  // これは認可のための秘密ではない（利用者にも見えるcustom IDに載る）。あくまで
  // 表示した契約と現在の契約が同じかを確かめるための指紋。
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest()
    .subarray(0, GENERIC_TERMS_TOKEN_BYTES)
    .toString("base64url");
}

/**
 * 在庫を有限へ確定するとき、未処理の返金義務をどう扱うか。
 *
 * - `none`             … 未処理の義務が無い（または無制限のまま）。始末する対象が無い
 * - `final_stock`      … 入力した N を**最終販売可能数**とする。義務は N の中に含める
 * - `add_restorations` … 入力した N に返金分を**上乗せ**する。義務は実際に在庫へ戻す
 *
 * **既定値を置かない。** 「黙って N+X にする」も「黙って N にする」も、運営が
 * 入力した数の意味を勝手に決めることになる。有限へ確定するときは必ず選ばせる。
 */
export type StockReconciliationMode = "none" | "final_stock" | "add_restorations";

/** まだ始末されていない返金在庫。 */
export interface PendingStockRestorations {
  readonly count: number;
  readonly quantity: number;
  readonly purchaseIds: readonly number[];
}

export interface StockChangeQuote {
  readonly itemId: number;
  readonly currentStock: number | null;
  readonly requestedStock: number | null;
  readonly pending: PendingStockRestorations;
  /** 有限へ確定するのに未処理の義務があるか。true なら2択が必須 */
  readonly requiresReconciliation: boolean;
  /** 確定後に実際に入る在庫数（モード別）。UIはこれをそのまま見せる */
  readonly resultingStock: Readonly<Partial<Record<StockReconciliationMode, number | null>>>;
  readonly allowedModes: readonly StockReconciliationMode[];
  /** モードごとの指紋。確定時はこのどれかをそのまま渡す */
  readonly tokens: Readonly<Partial<Record<StockReconciliationMode, string>>>;
}

export interface StockChangeResult {
  readonly itemId: number;
  readonly previousStock: number | null;
  readonly newStock: number | null;
  readonly mode: StockReconciliationMode;
  readonly settledPurchaseIds: readonly number[];
  readonly settledQuantity: number;
}

/**
 * 在庫変更の指紋。
 *
 * **未処理の義務の中身まで含める。** 件数と合計だけだと、1件始末されて別の返金が
 * 1件増えた場合に同じ指紋になり、運営が見ていない義務を巻き込んで確定してしまう。
 */
function stockTermsToken(facts: {
  itemId: number;
  currentStock: number | null;
  requestedStock: number | null;
  pendingIds: readonly number[];
  pendingQuantity: number;
  mode: StockReconciliationMode;
}): string {
  const canonical = JSON.stringify([
    facts.itemId,
    facts.currentStock,
    facts.requestedStock,
    [...facts.pendingIds].sort((a, b) => a - b),
    facts.pendingQuantity,
    facts.mode,
  ]);
  return createHash("sha256")
    .update(canonical, "utf8")
    .digest()
    .subarray(0, GENERIC_TERMS_TOKEN_BYTES)
    .toString("base64url");
}

/** 在庫として受け付ける値。負の在庫や小数はここで止める。 */
function assertStockValue(stock: number | null): void {
  if (stock === null) return;
  if (!Number.isInteger(stock) || stock < 0) {
    throw new ShopError("ERR_STOCK_VALUE_INVALID", { stock });
  }
}

/**
 * 確定後に入る在庫数。**`add_restorations` のときだけ上乗せする。**
 * 既定で上乗せしてはいけない——運営が入力した N の意味を勝手に決めることになる。
 */
function resolveStockForMode(
  requestedStock: number | null,
  pendingQuantity: number,
  mode: StockReconciliationMode,
): number | null {
  if (requestedStock === null) return null;
  return mode === "add_restorations" ? requestedStock + pendingQuantity : requestedStock;
}

/** 外部配送の確定が競合したときの内部シグナル。transaction を巻き戻すためだけに使う。 */
class SettlementConflict extends Error {}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** 期限商品の既定の期間。旧「月額」もここへ寄せる（暦月ではなく購入から30日） */
export const DEFAULT_TERM_DAYS = 30;
export const REEVAL_PRICE_LAND = 500_000;
export const REEVAL_INVITE_COUNT = 5;
export const EVAL_EXTENSION_PRICE_LAND = 50_000;
export const EVAL_EXTENSION_MAX_USES = 5;

export interface ReevalInviteUseRow {
  invite_id: number;
  purchase_id: number;
  user_id: string;
  used_at: number;
}

export interface ReevalCompensationRow {
  id: number;
  purchase_id: number;
  user_id: string;
  department_key: string;
  amount: number;
  reason: string;
  actor_id: string;
  ledger_transaction_id: number;
  created_at: number;
}

export interface EvaluationExtensionQuote {
  cycleStartedAt: number;
  currentDeadlineAt: number;
  nextDeadlineAt: number;
  usedCount: number;
  remainingCount: number;
  /**
   * `shop_eval_extension_uses.sequence` the next purchase in THIS cycle would take.
   * Derived from the same cycle-wide count the limit is judged from, so the application's
   * decision and the table's `UNIQUE(user_id, eval_started_at, sequence)` always agree.
   */
  nextSequence: number;
}

export interface EvaluationExtensionUseRow {
  purchase_id: number;
  item_id: number;
  user_id: string;
  eval_started_at: number;
  previous_deadline_at: number;
  new_deadline_at: number;
  sequence: number;
  created_at: number;
}

/**
 * その商品の有効期間（日）。期限を持たない単発商品は null。
 *
 * 暦月（当月末まで・毎月1日一括）は廃止した。月末に買った人が数日で切れて
 * すぐ再課金される、という不公平がそのまま料金になっていたため。
 */
export function termDays(item: Pick<ShopItemRow, "kind" | "duration_days">): number | null {
  if (item.duration_days && item.duration_days > 0) return item.duration_days;
  // 旧データの保険。移行で duration_days=30 を埋めるが、取りこぼしても月額扱いを続けない
  return item.kind === "monthly" ? DEFAULT_TERM_DAYS : null;
}

/**
 * 延長後の期限。**残り期間を損しない。**
 * 期限前に延長しても切り捨てず、切れた後なら今から数え直す。
 */
export function extendedExpiry(currentExpiresAt: number | null, days: number, from: number = now()): number {
  return Math.max(currentExpiresAt ?? 0, from) + days * DAY;
}

/** Botが期限とDiscordロールをともに正本管理する、汎用の期限付きアクセス商品。 */
export function isTimedAccessItem(
  item: Pick<ShopItemRow, "kind" | "duration_days" | "delivery" | "delivery_kind">,
): boolean {
  return termDays(item as ShopItemRow) !== null && item.delivery === "auto" && item.delivery_kind === "add_role";
}

/** 評価期限を1日延ばす即時商品。商品IDではなく配送の意味で特定する。 */
export function isEvaluationExtensionItem(
  item: Pick<ShopItemRow, "kind" | "delivery" | "delivery_kind">,
): boolean {
  return item.kind === "one_shot" && item.delivery === "auto" && item.delivery_kind === "extend_deadline";
}

function evaluationExtensionDays(item: Pick<ShopItemRow, "delivery_data">): number | null {
  try {
    const data = item.delivery_data ? JSON.parse(item.delivery_data) as Record<string, unknown> : {};
    return typeof data.days === "number" ? data.days : null;
  } catch {
    return null;
  }
}

/** 商品設定からアクセス先を読む。商品IDやチャンネルIDはコードへ持ち込まない。 */
export function timedAccessConfig(item: ShopItemRow): TimedAccessConfig | null {
  if (!isTimedAccessItem(item)) return null;
  try {
    const data = item.delivery_data ? JSON.parse(item.delivery_data) as Record<string, unknown> : {};
    const roleId = typeof data.role_id === "string" ? data.role_id.trim() : "";
    if (!roleId) return null;
    const channelId = typeof data.channel_id === "string" && data.channel_id.trim()
      ? data.channel_id.trim()
      : null;
    return { roleId, channelId };
  } catch {
    return null;
  }
}

export interface ShopOptions {
  /**
   * 階級要件の判定。既定は「そのロールを持っているか」の完全一致。
   * bot 側から階層対応（「〇〇以上」= 上位階級も可）の判定を注入できる。
   */
  roleCheck?: (memberRoleIds: readonly string[], requireRoleId: string) => boolean;
  /** 設定済みの再評価商品。null の間は旧挙動を維持する。 */
  reevalItemId?: () => number | null;
  /**
   * 再評価**面談受付**が今すぐ使えるかを、Landや招待実績を動かす直前に確認する。
   * 使えなければ throw する（`ERR_REEVAL_INTAKE_UNAVAILABLE` 相当）。
   *
   * UI側のpreflightだけでは足りない——表示してから確認ボタンを押すまでに受付panelが
   * 停止される余地がある。purchase transactionの中から呼ぶことで、charge pathに
   * preflightが1箇所しか無い状態を避ける。未注入なら受付確認は行われない（既存構成互換）。
   */
  assertReevaluationIntakeAvailable?: () => void;
  /** 設定済みのオリジナルロール新規作成商品。 */
  originalRoleItemId?: () => number | null;
  /** 専用購入の課金直前に、承認済みの本人申請か再確認する。 */
  assertOriginalRolePayable?: (applicationId: number, userId: string) => void;
  /** 例外補償の部署支出に使用する。未注入なら補償は fail-closed。 */
  departments?: Departments;
}

interface ShopPurchaseLogExtra {
  transactionId?: number | null;
  deliveryMode?: DeliveryMode;
  deliveryKind?: DeliveryKind;
  workType?: string | null;
  ticketThreadId?: string | null;
  staffId?: string | null;
  invoiceId?: number | null;
  invoiceKind?: string | null;
  invoiceReason?: string | null;
  paidBy?: string | null;
  source?: string;
  migrationKey?: string | null;
}

interface ShopPurchaseLogPayload {
  purchaseId: number;
  transactionId: number | null;
  itemId: number;
  itemName: string;
  userId: string;
  paidLand: number | null;
  paidAltKind: string | null;
  paidAltAmount: number | null;
  purchasedAt: number;
  deliveryMode: DeliveryMode;
  deliveryKind: DeliveryKind;
  workType: string | null;
  ticketThreadId: string | null;
  staffId: string | null;
  invoiceId: number | null;
  invoiceKind: string | null;
  invoiceReason: string | null;
  paidBy: string | null;
  source: string;
  migrationKey: string | null;
}

export class Shop {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
    private readonly options: ShopOptions = {},
  ) {
    this.ensureSchema();
    this.syncReevaluationSaleItem();
  }

  /**
   * Titles v2へ渡すpurchase origin/product identityを購入時点で凍結する。
   * item名・現在設定・request/reasonから後で推測しない。通常の`purchase()`だけが
   * eligible storefrontで、special serviceとlegacy importはprovenanceを残しつつ除外する。
   */
  private recordTitlePurchaseProvenance(purchase: PurchaseRow, origin: ShopPurchaseTitleOrigin): void {
    this.db.prepare(
      `INSERT INTO shop_purchase_title_provenance
         (purchase_id,user_id,product_key,purchased_at,origin,title_eligible)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      purchase.id,
      purchase.user_id,
      `shop-item:${purchase.item_id}`,
      purchase.purchased_at,
      origin,
      origin === "storefront" ? 1 : 0,
    );
  }

  /**
   * 購入した時点の「提供のしかた」を凍結する。**stock decrementと同じtransactionで書く。**
   *
   * `stockConsumed` は呼び出し側が「実際に在庫を1減らしたか」をそのまま渡す。
   * item.stock を見て推測しない——推測すると、あとから在庫設定を変えただけで
   * 過去の購入の事実が書き換わったように見えてしまう。
   */
  private recordFulfillmentProvenance(
    purchase: PurchaseRow,
    input: { deliveryMode: "auto" | "manual"; stockConsumed: boolean; source: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO shop_purchase_fulfillment_provenance
           (purchase_id, delivery_mode, stock_consumed, captured_at, source)
         VALUES (?,?,?,?,?)`,
      )
      .run(purchase.id, input.deliveryMode, input.stockConsumed ? 1 : 0, now(), input.source);
  }

  /**
   * 購入時の「与えるロール」を凍結する。**purchase commit と同じtransactionで書く。**
   *
   * 自動配送のスナップショットは auto 購入しか持たないので、手動配送の add_role 商品も
   * ここに記録する。そうしないと Phase E 以降に売った手動 add_role 商品の剥奪対象を、
   * 後から現在の商品設定に頼って引くことになる。
   */
  private recordRoleGrantProvenance(
    purchase: PurchaseRow,
    item: ShopItemRow,
    source: string,
  ): void {
    // **すべての購入について書く。** 行が無いことを「ロール契約ではなかった」の証拠に
    // すると、add_role なのに role_id が壊れている購入と区別できない。
    const roleId = item.delivery_kind === "add_role" ? parseRoleIdFromDeliveryData(item.delivery_data) : null;
    const grantKind =
      item.delivery_kind !== "add_role" ? "non_role" : roleId ? "role" : "invalid";
    this.db
      .prepare(
        `INSERT OR IGNORE INTO shop_purchase_role_grant_provenance
           (purchase_id, grant_kind, role_id, delivery_mode, source, captured_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(purchase.id, grantKind, roleId, item.delivery === "manual" ? "manual" : "auto", source, now());
  }

  /** 購入時に凍結した「与えるロール」。無ければ legacy。 */
  roleGrantProvenance(purchaseId: number): RoleGrantProvenanceRow | undefined {
    return this.db
      .prepare("SELECT * FROM shop_purchase_role_grant_provenance WHERE purchase_id = ?")
      .get(purchaseId) as RoleGrantProvenanceRow | undefined;
  }

  /**
   * この購入の剥奪対象ロール。**唯一の authority。**
   *
   * 優先順位:
   *   1. 購入時 role grant provenance（新しい購入）
   *   2. 購入時スナップショット（auto購入のimmutable evidence）
   *   3. 期限つきアクセスの明示的な移行記録
   * どれも無ければ `legacy_unknown`。現在の `shop_items` へは絶対に落とさない——
   * 商品のロール設定を後から変えただけで、過去の購入の剥奪対象が変わってしまう。
   */
  roleGrantTarget(purchase: PurchaseRow): RoleGrantTarget {
    const provenance = this.roleGrantProvenance(purchase.id);
    if (provenance) {
      if (provenance.grant_kind === "role" && provenance.role_id) {
        return { kind: "proven", roleId: provenance.role_id, source: provenance.source };
      }
      if (provenance.grant_kind === "non_role") return { kind: "proven_non_role" };
      // invalid: 購入時に add_role だったが対象を特定できなかった。推測しない。
      return { kind: "legacy_unknown" };
    }

    // **明示的な移行記録を先に見る。** Phase D 時代の購入は fulfillment provenance を
    // 持つが Phase E の role provenance を持たない。そこで「行が無い＝ロール契約では
    // なかった」と早合点すると、移行でロールを配った購入を非ロール扱いにしてしまう。
    const imported = this.db
      .prepare("SELECT role_id FROM shop_timed_access_legacy_imports WHERE purchase_id = ?")
      .get(purchase.id) as { role_id: string } | undefined;
    if (imported && typeof imported.role_id === "string" && imported.role_id.trim()) {
      return { kind: "proven", roleId: imported.role_id.trim(), source: "timed_access_legacy_import" };
    }

    const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
    if (snapshot) {
      // スナップショットがある＝購入時autoの契約が残っている。add_role でなければ
      // 「ロールを与える契約ではなかった」と**証明できる**。
      if (snapshot.delivery_kind !== "add_role") return { kind: "proven_non_role" };
      const roleId = parseRoleIdFromDeliveryData(snapshot.delivery_data);
      if (roleId) return { kind: "proven", roleId, source: "purchase_snapshot" };
      // add_role なのに対象を取り出せない。推測しない。
      return { kind: "legacy_unknown" };
    }

    // 購入時の契約を示す記録が何も無い。**現在の商品設定へは落とさない。**
    return { kind: "legacy_unknown" };
  }

  /** 購入時に凍結した提供のしかた。無ければ legacy（購入時の事実が残っていない）。 */
  fulfillmentProvenance(purchaseId: number): FulfillmentProvenanceRow | undefined {
    return this.db
      .prepare("SELECT * FROM shop_purchase_fulfillment_provenance WHERE purchase_id = ?")
      .get(purchaseId) as FulfillmentProvenanceRow | undefined;
  }

  /**
   * 現在指定されている再評価販売商品。**参照した時点でregistryへ記録する**。
   *
   * 「この商品は再評価サービスの販売商品だ」と認識できた瞬間が、その事実を永続化できる
   * 最も早い地点。購入成立を待つと、実績0件のまま設定がA→Bへ移ったときに最初の利用者が
   * 事故対象になる。冪等なINSERT OR IGNOREなので何度参照しても副作用は1回だけ。
   */
  private currentReevaluationSaleItemId(): number | null {
    const configured = this.options.reevalItemId?.() ?? null;
    if (configured !== null) this.registerReevaluationSaleItem(configured, "sale_setting");
    return configured;
  }

  /** 構築時に、現在の指定をregistryへ焼き付ける（最初の利用者を待たない）。 */
  private syncReevaluationSaleItem(): void {
    this.currentReevaluationSaleItemId();
  }

  private ensureSchema(): void {
    this.ensureColumn("shop_purchases", "delivery_snapshot_json", "TEXT");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shop_role_revocations (
        purchase_id INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
        user_id     TEXT NOT NULL,
        role_id     TEXT,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_shop_role_revocations_status ON shop_role_revocations(status, updated_at);
      -- shop_purchases が正本。1 purchase につき Discord購入ログoutboxは1件だけ積む。
      CREATE TABLE IF NOT EXISTS shop_purchase_log_enqueues (
        purchase_id INTEGER PRIMARY KEY REFERENCES shop_purchases(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shop_timed_access_legacy_runs (
        migration_key TEXT PRIMARY KEY,
        plan_json TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shop_timed_access_legacy_imports (
        purchase_id INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
        migration_key TEXT NOT NULL REFERENCES shop_timed_access_legacy_runs(migration_key),
        item_id INTEGER NOT NULL REFERENCES shop_items(id),
        user_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(item_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_shop_timed_access_legacy_imports_run
        ON shop_timed_access_legacy_imports(migration_key, item_id);
      CREATE TABLE IF NOT EXISTS shop_reeval_invite_uses (
        invite_id INTEGER PRIMARY KEY REFERENCES invites(id),
        purchase_id INTEGER NOT NULL REFERENCES shop_purchases(id),
        user_id TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        UNIQUE(purchase_id, invite_id)
      );
      CREATE INDEX IF NOT EXISTS idx_shop_reeval_invite_uses_purchase ON shop_reeval_invite_uses(purchase_id);
      CREATE TABLE IF NOT EXISTS shop_reeval_compensations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL UNIQUE REFERENCES shop_purchases(id),
        user_id TEXT NOT NULL,
        department_key TEXT NOT NULL,
        amount INTEGER NOT NULL CHECK(amount > 0),
        reason TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        ledger_transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_shop_reeval_compensations_user ON shop_reeval_compensations(user_id, created_at);
      -- 「この商品は再評価サービスの販売商品として確定された」という事実そのもの。
      -- 購入実績とは独立に持つ——実績0件のまま設定がA→Bへ移っても、Aをgeneric storefrontの
      -- 普通の商品へ落とさないため（現在の設定は正本にできない）。
      CREATE TABLE IF NOT EXISTS shop_reevaluation_sale_items (
        item_id       INTEGER PRIMARY KEY REFERENCES shop_items(id),
        first_seen_at INTEGER NOT NULL,
        source        TEXT NOT NULL
      );
      -- **write authorityで記録する。** 守りたいのは「一度でも再評価sale itemとして
      -- 指定されたitem」であって、「一度でもShopがその指定を観測したitem」ではない。
      -- 設定を書いた直後にShopが再評価APIを1度も呼ばないまま次の設定へ移ると、read-time
      -- syncでは取りこぼす。設定の書き込みそのものをtriggerで捕まえれば、Settings.set()・
      -- 将来のdedicated UI・別の管理経路・正規のdirect SQLのどれでも同じ不変条件が成立する。
      --
      -- 不正値guard: 正の整数として往復一致し（'12abc'のようなCAST事故を弾く）、かつ
      -- 実在する shop_items.id のときだけ記録する。不正な設定を書いただけでtransaction全体を
      -- 壊さない——記録しないだけ。trigger内のINSERT OR IGNOREは外側statementのconflict
      -- 解決に上書きされる（Settings.set()のUPSERTがABORTを強いる）ので、重複行を
      -- そもそも作らないNOT EXISTS guardにしてある。
      CREATE TRIGGER IF NOT EXISTS trg_shop_reeval_sale_item_insert
      AFTER INSERT ON settings
      WHEN NEW.key = 'shop:reeval_item_id'
      BEGIN
        INSERT INTO shop_reevaluation_sale_items (item_id, first_seen_at, source)
        SELECT CAST(NEW.value AS INTEGER), unixepoch(), 'setting_write'
         WHERE CAST(NEW.value AS INTEGER) > 0
           AND CAST(CAST(NEW.value AS INTEGER) AS TEXT) = NEW.value
           AND EXISTS (SELECT 1 FROM shop_items WHERE id = CAST(NEW.value AS INTEGER))
           AND NOT EXISTS (SELECT 1 FROM shop_reevaluation_sale_items
                            WHERE item_id = CAST(NEW.value AS INTEGER));
      END;
      -- Settings.set() はUPSERTなので、既存keyの変更はUPDATE側で発火する。
      -- A→Bという更新そのものが「Aは過去のsale item」「Bは現在のsale item」の両方を残す。
      CREATE TRIGGER IF NOT EXISTS trg_shop_reeval_sale_item_update
      AFTER UPDATE OF value ON settings
      WHEN NEW.key = 'shop:reeval_item_id'
      BEGIN
        INSERT INTO shop_reevaluation_sale_items (item_id, first_seen_at, source)
        SELECT CAST(NEW.value AS INTEGER), unixepoch(), 'setting_write'
         WHERE CAST(NEW.value AS INTEGER) > 0
           AND CAST(CAST(NEW.value AS INTEGER) AS TEXT) = NEW.value
           AND EXISTS (SELECT 1 FROM shop_items WHERE id = CAST(NEW.value AS INTEGER))
           AND NOT EXISTS (SELECT 1 FROM shop_reevaluation_sale_items
                            WHERE item_id = CAST(NEW.value AS INTEGER));
        INSERT INTO shop_reevaluation_sale_items (item_id, first_seen_at, source)
        SELECT CAST(OLD.value AS INTEGER), unixepoch(), 'setting_write_previous'
         WHERE CAST(OLD.value AS INTEGER) > 0
           AND CAST(CAST(OLD.value AS INTEGER) AS TEXT) = OLD.value
           AND EXISTS (SELECT 1 FROM shop_items WHERE id = CAST(OLD.value AS INTEGER))
           AND NOT EXISTS (SELECT 1 FROM shop_reevaluation_sale_items
                            WHERE item_id = CAST(OLD.value AS INTEGER));
      END;
      CREATE TABLE IF NOT EXISTS shop_eval_extension_uses (
        purchase_id INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
        item_id INTEGER NOT NULL REFERENCES shop_items(id),
        user_id TEXT NOT NULL,
        eval_started_at INTEGER NOT NULL,
        previous_deadline_at INTEGER NOT NULL,
        new_deadline_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 5),
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, eval_started_at, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_shop_eval_extension_uses_cycle
        ON shop_eval_extension_uses(user_id, eval_started_at, sequence);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private roleSatisfied(memberRoleIds: readonly string[], requireRoleId: string): boolean {
    const check = this.options.roleCheck ?? ((ids, req) => ids.includes(req));
    return check(memberRoleIds, requireRoleId);
  }

  private deliverySnapshot(item: ShopItemRow): string | null {
    if (item.delivery !== "auto" || !item.delivery_kind) return null;
    return JSON.stringify({
      delivery: item.delivery,
      delivery_kind: item.delivery_kind,
      delivery_data: item.delivery_data,
      captured_at: now(),
    });
  }

  private shopPurchaseLogPayload(
    purchase: PurchaseRow,
    item: ShopItemRow,
    extra: ShopPurchaseLogExtra = {},
  ): ShopPurchaseLogPayload {
    return {
      purchaseId: purchase.id,
      transactionId: extra.transactionId ?? null,
      itemId: item.id,
      itemName: item.name,
      userId: purchase.user_id,
      paidLand: purchase.paid_land,
      paidAltKind: purchase.paid_alt_kind,
      paidAltAmount: purchase.paid_alt_amount,
      purchasedAt: purchase.purchased_at,
      deliveryMode: extra.deliveryMode ?? item.delivery,
      deliveryKind: extra.deliveryKind === undefined ? item.delivery_kind : extra.deliveryKind,
      workType: extra.workType ?? null,
      ticketThreadId: extra.ticketThreadId ?? null,
      staffId: extra.staffId ?? null,
      invoiceId: extra.invoiceId ?? null,
      invoiceKind: extra.invoiceKind ?? null,
      invoiceReason: extra.invoiceReason ?? null,
      paidBy: extra.paidBy ?? null,
      source: extra.source ?? "shop_purchase",
      migrationKey: extra.migrationKey ?? null,
    };
  }

  /**
   * 購入ログを purchase ID 単位で一度だけ outbox へ積む。
   * Discord配送は別workerなので、API失敗で購入/支払いを巻き戻さない。
   */
  private enqueueShopPurchaseLog(
    purchase: PurchaseRow,
    item: ShopItemRow,
    extra: ShopPurchaseLogExtra = {},
  ): ShopPurchaseLogPayload {
    const payload = this.shopPurchaseLogPayload(purchase, item, extra);
    const body = () => {
      const claimed = this.db
        .prepare("INSERT OR IGNORE INTO shop_purchase_log_enqueues (purchase_id, created_at) VALUES (?, ?)")
        .run(purchase.id, purchase.purchased_at);
      if (claimed.changes === 1) {
        this.db
          .prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('shop_purchase_log', ?, ?)")
          .run(JSON.stringify(payload), purchase.purchased_at);
      }
    };
    if (this.db.inTransaction) body();
    else this.db.transaction(body).immediate();
    return payload;
  }

  private roleIdFromDelivery(snapshotJson: string | null | undefined, item?: ShopItemRow): { roleId?: string; error?: string } {
    const raw = snapshotJson ?? (item ? this.deliverySnapshot(item) : null);
    if (!raw) return {};
    try {
      const snapshot = JSON.parse(raw) as { delivery_kind?: string; delivery_data?: string | null };
      if (snapshot.delivery_kind !== "add_role") return {};
      const dataRaw = snapshot.delivery_data;
      if (!dataRaw) return { error: "delivery_data_missing" };
      const data = JSON.parse(dataRaw) as { role_id?: unknown };
      return typeof data.role_id === "string" && data.role_id.trim()
        ? { roleId: data.role_id.trim() }
        : { error: "role_id_missing" };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---- 商品CRUD ----

  createItem(input: ShopItemInput, actor: string): ShopItemRow {
    const ts = now();
    const info = this.db
      .prepare(
        `INSERT INTO shop_items
         (name, description, price_land, price_alt_kind, price_alt_amount, kind,
          duration_days, require_role_id, delivery, delivery_kind, delivery_data, stock, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.description ?? null,
        input.price_land,
        input.price_alt_kind ?? null,
        input.price_alt_amount ?? null,
        input.kind,
        input.duration_days ?? null,
        input.require_role_id ?? null,
        input.delivery,
        input.delivery_kind ?? null,
        input.delivery_data ?? null,
        input.stock ?? null,
        input.enabled === false ? 0 : 1,
        ts,
        ts,
      );
    this.events.log("shop_item_created", { actor, payload: { id: info.lastInsertRowid, name: input.name } });
    return this.getItem(Number(info.lastInsertRowid))!;
  }

  updateItem(id: number, patch: Partial<ShopItemInput>, actor: string): void {
    const ts = now();
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.name !== undefined) push("name", patch.name);
    if (patch.description !== undefined) push("description", patch.description);
    if (patch.price_land !== undefined) push("price_land", patch.price_land);
    if (patch.price_alt_kind !== undefined) push("price_alt_kind", patch.price_alt_kind);
    if (patch.price_alt_amount !== undefined) push("price_alt_amount", patch.price_alt_amount);
    if (patch.kind !== undefined) push("kind", patch.kind);
    if (patch.duration_days !== undefined) push("duration_days", patch.duration_days);
    if (patch.require_role_id !== undefined) push("require_role_id", patch.require_role_id);
    if (patch.delivery !== undefined) push("delivery", patch.delivery);
    if (patch.delivery_kind !== undefined) push("delivery_kind", patch.delivery_kind);
    if (patch.delivery_data !== undefined) push("delivery_data", patch.delivery_data);
    // **在庫はここでは動かせない。** 未処理の返金義務がある商品で有限在庫を確定するとき、
    // 汎用の更新経路だと「運営が入力した N」の意味（最終数か上乗せ前か）を誰も
    // 決めないまま確定してしまう。在庫は applyStockChange() だけが動かす。
    if (patch.stock !== undefined) {
      throw new ShopError("ERR_STOCK_CHANGE_REQUIRES_API", { itemId: id });
    }
    if (patch.enabled !== undefined) push("enabled", patch.enabled ? 1 : 0);
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(ts);
    params.push(id);
    this.db.prepare(`UPDATE shop_items SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.events.log("shop_item_updated", { actor, payload: { id, keys: Object.keys(patch) } });
  }

  /**
   * 販売を再開してはいけない商品か。
   *
   * **手動配送の期限商品**（旧「オリジナルロール継続」）が該当する。契約の実体が
   * どのDiscordロールなのかDBが知らないため、売っても期限だけが伸びて権利は伸びない。
   * 専用台帳へ移すまでは、停止したものを戻せないようにしておく。
   */
  isSalesLocked(item: Pick<ShopItemRow, "kind" | "duration_days" | "delivery">): boolean {
    return termDays(item as ShopItemRow) !== null && item.delivery !== "auto";
  }

  setEnabled(id: number, enabled: boolean, actor: string): void {
    const item = this.getItem(id);
    if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId: id });
    if (enabled && !item.enabled && this.isSalesLocked(item)) {
      throw new ShopError("ERR_SALES_LOCKED", { itemId: id });
    }
    this.updateItem(id, { enabled }, actor);
  }

  getItem(id: number): ShopItemRow | undefined {
    return this.db.prepare("SELECT * FROM shop_items WHERE id = ?").get(id) as ShopItemRow | undefined;
  }

  listItems(opts: { enabledOnly?: boolean } = {}): ShopItemRow[] {
    const where = opts.enabledOnly ? "WHERE enabled = 1" : "";
    return this.db.prepare(`SELECT * FROM shop_items ${where} ORDER BY id`).all() as ShopItemRow[];
  }

  // ---- 購入 ----

  /**
   * generic storefrontの購入契約を表示時に確定する。Botはここで得た `termsToken` だけを
   * ボタンへ持たせ、確定時にCoreが現在の商品から再生成して比較する。
   */
  quoteGenericPurchase(itemId: number): GenericPurchaseQuote {
    const item = this.getItem(itemId);
    if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId });
    const terms = canonicalGenericTerms(item);
    return { terms, termsToken: genericTermsToken(terms) };
  }

  /**
   * generic storefrontで代替支払（invite等）が実際に使えるか。
   *
   * `price_alt_kind != null` は「使える」の根拠にならない——**その資源を実際に消費できる
   * 専用writerがあるか**が authority。現状、資源を消費する経路を持つのは再評価チャレンジの
   * invite払い（`purchaseReevaluation`）だけで、それは専用商品なのでgenericには出さない。
   *
   * **`true` を返してよくなる条件**（3つ揃うまでは false のまま）:
   *   1. その資源を実際に減らす writer があること（`paid_alt_*` を書くだけは支払いではない）
   *   2. 失敗したときの後始末が決まっていること——巻き戻し・返金・取り消しのどれで、
   *      誰がやるのか。`refund()` が戻せない資源は generic refund の対象外のままなので、
   *      「配送に失敗したらどうするか」を先に決めていないと課金だけが残る
   *   3. 1と2を固定するテストがあること
   * 支払方法ごとの handler registry のような一般化は、実際に2つ目が現れてから考える。
   */
  genericAltPaymentSupported(_itemId: number): boolean {
    return false;
  }

  /**
   * 商品を購入する。
   * - 権限（require_role_id）は bot 側で事前チェック（このメソッドには memberRoleIds を渡す）
   * - Land支払いは tip_burn で TREASURY 焼却（インフレ抑制）
   * - 月額は expires_at を当月末に（30日制へ移行するまでの暫定）、one_shot で duration_days ありなら期限付きに
   * - 同一 item の月額でアクティブがあれば ERR_ALREADY_ACTIVE
   */
  purchase(input: {
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    payAlt?: boolean; // 代替支払いを使うか（Landの代わりに price_alt を消費）
    /**
     * 本人が入力した内容（希望ニックネームなど）。**課金と同じトランザクションで残す。**
     * ここに無いと、課金後にBotが落ちたとき「何をする約束だったか」が分からなくなる。
     */
    request?: Record<string, unknown>;
    /**
     * 課金の冪等鍵。**同じ人が同じ商品を1秒以内にもう一度買うことがある**呼び出し
     * （返金後のやり直し・巡回からの再実行）では、必ず操作ごとに違う値を渡すこと。
     * 既定値は秒までしか分けないので、同じ秒の2回目が「同じ課金の再送」と見なされ、
     * 購入行だけができて Land が動かない。
     */
    idempotencyKey?: string;
    /**
     * 表示時に確定した契約の指紋（`quoteGenericPurchase()` の `termsToken`）。
     *
     * **必須**。「先に契約を見せた」証拠なしにgeneric購入は成立させない。省略できる
     * ようにしておくと、Bot以外のcallerが quote を取らずに現在の条件でそのまま課金
     * できてしまい、「Coreが最後の関門」という前提が崩れる。
     *
     * 専用商品（再評価・評価延長・オリジナルロール・請求）はそれぞれ専用writerが
     * 固有の事前条件を持つので、この経路は通らない。
     */
    expectedTermsToken: string;
  }): { purchase: PurchaseRow; item: ShopItemRow; needsManualDelivery: boolean } {
    if (this.options.originalRoleItemId?.() === input.itemId) {
      throw new ShopError("ERR_ORIGINAL_ROLE_SPECIAL_PURCHASE_REQUIRED", { itemId: input.itemId });
    }
    // 現在の販売設定だけでなく、**一度でも再評価権として売られた商品**をgenericから守る。
    // A→B差し替え後もAがenabledなら、旧Aがstorefrontの普通の商品として買われかねない。
    if (this.isHistoricalReevaluationItem(input.itemId)) {
      throw new ShopError("ERR_REEVAL_SPECIAL_PURCHASE_REQUIRED", { itemId: input.itemId });
    }
    const item = this.getItem(input.itemId);
    if (item && isEvaluationExtensionItem(item)) {
      throw new ShopError("ERR_EVAL_EXTENSION_SPECIAL_PURCHASE_REQUIRED", { itemId: input.itemId });
    }
    // 専用商品のguardを通り抜けた「普通の商品」について、代替支払は成立させない。
    // 旧実装は`paid_alt_*`を書くだけで資源を消費しておらず、**払っていないのに支払済み購入**が
    // 成立しえた。altが使えないからLandへ落とす、も禁止——利用者はinviteで払うと言っている。
    if (input.payAlt) {
      throw new ShopError("ERR_ALT_PAYMENT_UNSUPPORTED", { itemId: input.itemId });
    }
    // 型を迂回するcaller（JSからの呼び出し・any経由）にも効かせる。undefined・空文字・
    // 形の違う値は「契約を見せた証拠が無い」であって、現在の条件で課金してよい理由にはならない。
    if (typeof input.expectedTermsToken !== "string" || !GENERIC_TERMS_TOKEN_PATTERN.test(input.expectedTermsToken)) {
      throw new ShopError("ERR_TERMS_TOKEN_REQUIRED", { itemId: input.itemId });
    }
    const run = () => this.purchaseInternal({ ...input, titleOrigin: "storefront" });
    return this.db.inTransaction ? run() : this.db.transaction(run).immediate();
  }

  /**
   * オリジナルロールの承認済み申請専用購入。
   * 申請の再検査、applicationIdの購入行への記録、課金を同じIMMEDIATE transactionで確定する。
   */
  purchaseOriginalRole(input: {
    itemId: number;
    applicationId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    idempotencyKey: string;
  }): { purchase: PurchaseRow; item: ShopItemRow; needsManualDelivery: boolean } {
    const run = () => {
      const item = this.getItem(input.itemId);
      if (
        this.options.originalRoleItemId?.() !== input.itemId ||
        !this.options.assertOriginalRolePayable ||
        !item ||
        item.kind !== "one_shot" ||
        item.delivery !== "auto" ||
        item.delivery_kind !== "create_original_role" ||
        item.price_land === null ||
        !Number.isSafeInteger(input.applicationId) ||
        input.applicationId <= 0
      ) {
        throw new ShopError("ERR_ORIGINAL_ROLE_ITEM_CONFIG", {
          itemId: input.itemId,
          configuredId: this.options.originalRoleItemId?.() ?? null,
          applicationId: input.applicationId,
        });
      }
      this.options.assertOriginalRolePayable(input.applicationId, input.userId);
      return this.purchaseInternal({
        itemId: input.itemId,
        userId: input.userId,
        actor: input.actor,
        memberRoleIds: input.memberRoleIds,
        request: { applicationId: input.applicationId },
        idempotencyKey: input.idempotencyKey,
        titleOrigin: "original_role_application",
      });
    };
    return this.db.inTransaction ? run() : this.db.transaction(run).immediate();
  }

  /**
   * スタッフがチケットで発行したオリジナルロール請求を本人が支払う。
   *
   * - 請求種別は invoice.kind が正本。金額から意味を推測しない。
   * - 購入行は /商館 → 購入履歴 の正本へ必ず残す。
   * - 新方式は実Discordロールを自動配送しないため、購入行は payment record として
   *   delivery_state=delivered で閉じ、旧 create_original_role purchase の復旧経路には載せない。
   * - Discordログ/チケット領収書は outbox。配送失敗でこのトランザクションを巻き戻さない。
   */
  purchaseOriginalRoleInvoice(input: {
    invoiceId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    idempotencyKey: string;
  }): { purchase: PurchaseRow; item: ShopItemRow; transactionId: number; replayed: boolean } {
    const run = () => {
      const invoice = this.db.prepare(
        `SELECT i.*, c.ticket_thread_id
           FROM original_role_invoices i
           JOIN original_role_cases c ON c.id = i.case_id
          WHERE i.id = ?`,
      ).get(input.invoiceId) as
        | {
            id: number; case_id: number; user_id: string; kind: string; amount: number; reason: string | null;
            status: string; issued_by: string; purchase_id: number | null; transaction_id: number | null;
            ticket_thread_id: string;
          }
        | undefined;
      if (!invoice) throw new ShopError("ERR_ORIGINAL_ROLE_INVOICE_NOT_FOUND", { invoiceId: input.invoiceId });
      if (invoice.user_id !== input.userId) {
        throw new ShopError("ERR_ORIGINAL_ROLE_INVOICE_NOT_PAYABLE", { invoiceId: input.invoiceId, reason: "owner" });
      }
      if (invoice.status === "paid" && invoice.purchase_id !== null && invoice.transaction_id !== null) {
        const purchase = this.getPurchase(invoice.purchase_id);
        const item = purchase ? this.getItem(purchase.item_id) : undefined;
        if (!purchase || !item) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId: invoice.purchase_id });
        return { purchase, item, transactionId: invoice.transaction_id, replayed: true };
      }
      if (invoice.status !== "pending") {
        throw new ShopError("ERR_ORIGINAL_ROLE_INVOICE_NOT_PAYABLE", { invoiceId: input.invoiceId, status: invoice.status });
      }

      const itemId = this.options.originalRoleItemId?.() ?? null;
      const item = itemId ? this.getItem(itemId) : undefined;
      if (!itemId || !item || !item.enabled || item.kind !== "one_shot") {
        throw new ShopError("ERR_ORIGINAL_ROLE_ITEM_CONFIG", { configuredId: itemId });
      }
      if (item.require_role_id && !this.roleSatisfied(input.memberRoleIds, item.require_role_id)) {
        throw new ShopError("ERR_ROLE_REQUIRED", { roleId: item.require_role_id });
      }
      if (item.stock !== null && item.stock <= 0) throw new ShopError("ERR_NO_STOCK", { itemId: item.id });

      const ts = now();
      const account = `user:${input.userId}`;
      this.ledger.ensureAccount(account, "user");
      const transferred = this.ledger.transfer({
        from: account,
        to: TREASURY,
        amount: invoice.amount,
        type: "tip_burn",
        actor: input.actor,
        reason: `オリジナルロール請求 #${invoice.id} (${invoice.kind})`,
        refType: "original_role_invoice",
        refId: String(invoice.id),
        idempotencyKey: input.idempotencyKey,
      });

      const request = {
        originalRoleInvoiceId: invoice.id,
        originalRoleCaseId: invoice.case_id,
        ticketThreadId: invoice.ticket_thread_id,
        invoiceKind: invoice.kind,
        invoiceAmount: invoice.amount,
        invoiceReason: invoice.reason,
        issuedBy: invoice.issued_by,
      };
      const info = this.db.prepare(
        `INSERT INTO shop_purchases
         (item_id, user_id, purchased_at, expires_at, paid_land, paid_alt_kind, paid_alt_amount,
          status, delivered_at, auto_renew, delivery_snapshot_json, request_json,
          delivery_state, delivery_attempts, delivery_error, delivery_updated_at)
         VALUES (?, ?, ?, NULL, ?, NULL, NULL, 'active', ?, 0, NULL, ?, 'delivered', 0, NULL, ?)`,
      ).run(item.id, input.userId, ts, invoice.amount, ts, JSON.stringify(request), ts);
      const stockConsumed = item.stock !== null;
      if (stockConsumed) {
        this.db.prepare("UPDATE shop_items SET stock = stock - 1, updated_at = ? WHERE id = ?").run(ts, item.id);
      }
      const purchase = this.getPurchase(Number(info.lastInsertRowid))!;
      this.recordTitlePurchaseProvenance(purchase, "original_role_invoice");
      // 請求払いは発行時点で提供済みとして確定する（delivered_atを入れている）。
      // genericな手動対応キューの仕事ではない。
      this.recordFulfillmentProvenance(purchase, {
        deliveryMode: "auto",
        stockConsumed,
        source: "original_role_invoice",
      });
      this.recordRoleGrantProvenance(purchase, item, "original_role_invoice");
      const changed = this.db.prepare(
        `UPDATE original_role_invoices
            SET status='paid', paid_by=?, paid_at=?, purchase_id=?, transaction_id=?
          WHERE id=? AND status='pending'`,
      ).run(input.actor, ts, purchase.id, transferred.tx.id, invoice.id);
      if (changed.changes !== 1) {
        throw new ShopError("ERR_ORIGINAL_ROLE_INVOICE_NOT_PAYABLE", { invoiceId: invoice.id, reason: "race" });
      }

      this.events.log("shop_purchased", {
        actor: input.userId,
        payload: {
          itemId: item.id,
          purchaseId: purchase.id,
          paidLand: invoice.amount,
          originalRoleInvoiceId: invoice.id,
          invoiceKind: invoice.kind,
          transactionId: transferred.tx.id,
        },
      });
      this.events.log("original_role_invoice_paid", {
        actor: input.actor,
        target: input.userId,
        payload: {
          invoiceId: invoice.id,
          caseId: invoice.case_id,
          kind: invoice.kind,
          amount: invoice.amount,
          issuedBy: invoice.issued_by,
          purchaseId: purchase.id,
          transactionId: transferred.tx.id,
          ticketThreadId: invoice.ticket_thread_id,
        },
      });

      const genericLog = this.enqueueShopPurchaseLog(purchase, item, {
        transactionId: transferred.tx.id,
        deliveryMode: "manual",
        deliveryKind: null,
        workType: `original_role_invoice:${invoice.kind}`,
        ticketThreadId: invoice.ticket_thread_id,
        staffId: invoice.issued_by,
        invoiceId: invoice.id,
        invoiceKind: invoice.kind,
        invoiceReason: invoice.reason,
        paidBy: input.actor,
        source: "original_role_invoice",
      });
      // チケット内の領収記録は購入ログとは別用途なので、そのまま維持する。
      const receiptPayload = JSON.stringify({
        ...genericLog,
        amount: invoice.amount,
        issuedBy: invoice.issued_by,
      });
      this.db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('original_role_ticket_receipt', ?, ?)").run(receiptPayload, ts);
      return { purchase, item, transactionId: transferred.tx.id, replayed: false };
    };
    return this.db.inTransaction ? run() : this.db.transaction(run).immediate();
  }

  private purchaseInternal(input: {
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    payAlt?: boolean;
    request?: Record<string, unknown>;
    idempotencyKey?: string;
    expectedTermsToken?: string;
    titleOrigin: Exclude<ShopPurchaseTitleOrigin, "original_role_invoice" | "legacy_timed_access_import">;
  }): { purchase: PurchaseRow; item: ShopItemRow; needsManualDelivery: boolean } {
    const item = this.getItem(input.itemId);
    if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId: input.itemId });
    // 表示時に確定した契約と、いま課金しようとしている契約が同じかを、Landを動かす前に見る。
    // enabled / stock は identity ではなく現在値で確認する（下の既存チェック）。
    if (input.expectedTermsToken !== undefined) {
      const currentToken = genericTermsToken(canonicalGenericTerms(item));
      if (currentToken !== input.expectedTermsToken) {
        throw new ShopError("ERR_TERMS_CHANGED", { itemId: item.id });
      }
    }
    if (!item.enabled) throw new ShopError("ERR_ITEM_DISABLED", { itemId: item.id });
    if (item.require_role_id && !this.roleSatisfied(input.memberRoleIds, item.require_role_id)) {
      throw new ShopError("ERR_ROLE_REQUIRED", { roleId: item.require_role_id });
    }
    if (item.stock !== null && item.stock <= 0) throw new ShopError("ERR_NO_STOCK", { itemId: item.id });
    // 期限商品を二重に契約させない（UI側はこの場合「延長」を出す）
    if (termDays(item) !== null) {
      const existing = this.db
        .prepare("SELECT id FROM shop_purchases WHERE item_id = ? AND user_id = ? AND status = 'active'")
        .get(item.id, input.userId) as { id: number } | undefined;
      if (existing) throw new ShopError("ERR_ALREADY_ACTIVE", { itemId: item.id, purchaseId: existing.id });
    }
    if (isTimedAccessItem(item)) {
      const access = timedAccessConfig(item);
      if (!access) throw new ShopError("ERR_TIMED_ACCESS_CONFIG", { itemId: item.id });
      // 契約根拠が不明な既存ロールを30日契約と推測しない。権利を残したまま無課金で止める。
      if (input.memberRoleIds.includes(access.roleId)) {
        throw new ShopError("ERR_TIMED_ACCESS_ROLE_PRESENT", { itemId: item.id, roleId: access.roleId });
      }
    }

    const ts = now();
    let paidLand: number | null = null;
    let paidAltKind: string | null = null;
    let paidAltAmount: number | null = null;
    let transactionId: number | null = null;
    const useAlt = input.payAlt && item.price_alt_kind && item.price_alt_amount;
    if (useAlt) {
      paidAltKind = item.price_alt_kind;
      paidAltAmount = item.price_alt_amount;
    } else {
      if (item.price_land === null) throw new ShopError("ERR_NO_PRICE", { itemId: item.id });
      // Land を焼却
      const account = `user:${input.userId}`;
      this.ledger.ensureAccount(account, "user");
      const transferred = this.ledger.transfer({
        from: account,
        to: TREASURY,
        amount: item.price_land,
        type: "tip_burn",
        actor: input.actor,
        reason: `公式ショップ購入: ${item.name}`,
        refType: "shop",
        refId: String(item.id),
        idempotencyKey: input.idempotencyKey ?? `shop:purchase:${input.userId}:${item.id}:${ts}`,
      });
      transactionId = transferred.tx.id;
      paidLand = item.price_land;
    }

    // 期限計算: 買った時点から数える（暦月ではない）
    const days = termDays(item);
    const expiresAt = days === null ? null : ts + days * DAY;

    const info = this.db
      .prepare(
        `INSERT INTO shop_purchases
         (item_id, user_id, purchased_at, expires_at, paid_land, paid_alt_kind, paid_alt_amount, status, auto_renew, delivery_snapshot_json, request_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
      )
      .run(
        item.id,
        input.userId,
        ts,
        expiresAt,
        paidLand,
        paidAltKind,
        paidAltAmount,
        this.deliverySnapshot(item),
        input.request ? JSON.stringify(input.request) : null,
      );
    // 在庫を実際に減らしたかどうかを**この場で覚える**。あとで item.stock を見ても、
    // その時点の設定しか分からない（運営が有限/無制限を切り替えられる）。
    const stockConsumed = item.stock !== null;
    if (stockConsumed) {
      this.db.prepare("UPDATE shop_items SET stock = stock - 1, updated_at = ? WHERE id = ?").run(ts, item.id);
    }
    const purchase = this.getPurchase(Number(info.lastInsertRowid))!;
    this.recordTitlePurchaseProvenance(purchase, input.titleOrigin);
    this.recordFulfillmentProvenance(purchase, {
      deliveryMode: item.delivery === "manual" ? "manual" : "auto",
      stockConsumed,
      source: input.titleOrigin,
    });
    this.recordRoleGrantProvenance(purchase, item, input.titleOrigin);
    this.events.log("shop_purchased", {
      actor: input.userId,
      payload: { itemId: item.id, purchaseId: purchase.id, paidLand, paidAltKind, paidAltAmount, expiresAt },
    });
    this.enqueueShopPurchaseLog(purchase, item, { transactionId });
    return { purchase, item, needsManualDelivery: item.delivery === "manual" };
  }

  /**
   * 現在の評価サイクルで既に使った延長回数。**商品IDからは完全に独立**。
   *
   * 利用者が見ている契約は「この評価サイクルでは最大5回」であって、「この商品で5回」では
   * ない。運営が延長商品を作り直してもIDが変わるだけで、利用者の5回枠は同じサイクルの
   * 同じ枠である。数え方のidentityは `user_id + eval_started_at` だけ——`item_id` は
   * 「どの商品から買ったか」というaudit情報として`shop_eval_extension_uses`へ残すが、
   * 「あと何回使えるか」の判断には一切使わない。
   *
   * この関数が返す1つの数が、表示・上限判断・次のsequenceの**全て**の正本になる。
   * 「画面に出す回数」と「DB保護用のsequence」を別々に持たない——別々に持つと、
   * 購入前に 2/5 と見せて実際には3件目として書く、という食い違いが起こりうる。
   *
   * 内訳:
   *   1. V2 SSOT: `shop_eval_extension_uses` のこのサイクル分。
   *   2. legacy: V2台帳が無い時代の購入のうち、**購入時に確定したdelivery snapshot**が
   *      `delivery=auto` かつ `delivery_kind=extend_deadline` だと証明できるものだけ。
   *   3. 上記で直接証明できた数と、**このサイクルで既に発行済みのsequenceの最大値**の
   *      大きい方を採る。
   *
   * legacyの判定にitem名・説明文・現在の商品IDは使わない——商品名からの推測は、
   * 名前を変えただけで意味が変わってしまう。`delivery_snapshot_json`は購入時点の
   * 商品定義を固定した不変記録で、`parseDeliverySnapshot()`（壊れていれば現在の商品定義で
   * 代用せずnullを返す）だけを正本にする。
   *
   * **3の理由**: snapshotが無い行を「延長だった」と推測はしないが、単に数えないだけだと
   * 5回上限に対してはむしろ緩くなる（fail-closedではない）。PR #131時代のwriterは
   * snapshotの有無に関係なく同一itemのdelivered購入を数えていたので、
   * 「snapshot無しV1購入 → その後のV2購入が sequence=2」という状態は旧実装でも
   * schema上も成立し得た。発行済みのsequence Nは「少なくともN件目の使用が発行された」
   * という**不変の保守的な下限**なので、直接証明できる数より大きければそちらを採る。
   * 直接は証明できない使用を推測で無かったことにして追加購入を許すより安全側。
   *
   * 正常な新規データでは 直接証明数 === 最大sequence。台帳外のlegacyがあれば
   * 直接証明数 > 最大sequence も正常。逆に 最大sequence > 直接証明数 のときだけ、
   * 過去writerが現在は直接証明できない使用をsequenceへ織り込んでいたことを意味する。
   *
   * 同じpurchaseをV2台帳とlegacy側で二重に数えない。
   */
  private evaluationExtensionUsedCount(userId: string, cycleStartedAt: number): number {
    const ledgerCount = (this.db
      .prepare("SELECT COUNT(*) AS n FROM shop_eval_extension_uses WHERE user_id = ? AND eval_started_at = ?")
      .get(userId, cycleStartedAt) as { n: number }).n;

    // V2台帳に載っていない、このサイクル中の配送済み購入だけを候補にする。
    const legacyCandidates = this.db
      .prepare(
        `SELECT p.delivery_snapshot_json AS snapshot
           FROM shop_purchases p
          WHERE p.user_id = ? AND p.purchased_at >= ?
            AND COALESCE(p.delivery_state, CASE WHEN p.delivered_at IS NOT NULL THEN 'delivered' END) = 'delivered'
            AND p.delivery_snapshot_json IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM shop_eval_extension_uses u WHERE u.purchase_id = p.id)`,
      )
      .all(userId, cycleStartedAt) as { snapshot: string | null }[];

    // 判定はSQLのjson_extractではなく既存の`parseDeliverySnapshot()`で行う——delivery_kindの
    // 妥当性検査（KNOWN_DELIVERY_KINDS）や壊れたJSONの扱いを二重実装して食い違わせない。
    const legacyCount = legacyCandidates.filter((row) => {
      const snapshot = parseDeliverySnapshot(row.snapshot);
      return snapshot !== null && snapshot.delivery_kind === "extend_deadline";
    }).length;
    const directlyProvenCount = ledgerCount + legacyCount;

    // 発行済みsequenceは「少なくともここまで使用が進んでいた」というimmutableな下限。
    const maxSequence = (this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS n FROM shop_eval_extension_uses WHERE user_id = ? AND eval_started_at = ?",
      )
      .get(userId, cycleStartedAt) as { n: number }).n;

    return Math.max(directlyProvenCount, maxSequence);
  }

  /**
   * 評価期限延長の購入前表示と、課金直前の同じ判定。
   *
   * 旧V1購入は書き換えない。現在サイクル中に配送済みで、購入時snapshotが延長だと
   * 証明できる購入は既に1日を受け取った事実なので上限へ含め、V2化で回数が0へ戻らない
   * ようにする（PR #131のcompatibility契約）。
   */
  checkEvaluationExtensionPurchase(input: {
    itemId: number;
    userId: string;
    expected?: Pick<EvaluationExtensionQuote, "cycleStartedAt" | "currentDeadlineAt" | "usedCount"> & {
      priceLand: number;
    };
  }): EvaluationExtensionQuote {
    const item = this.getItem(input.itemId);
    if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId: input.itemId });
    if (!item.enabled) throw new ShopError("ERR_ITEM_DISABLED", { itemId: item.id });
    if (
      !isEvaluationExtensionItem(item) ||
      evaluationExtensionDays(item) !== 1 ||
      item.price_land !== EVAL_EXTENSION_PRICE_LAND ||
      item.price_alt_kind !== null ||
      item.price_alt_amount !== null ||
      item.duration_days !== null ||
      item.require_role_id !== null ||
      item.stock !== null
    ) {
      throw new ShopError("ERR_EVAL_EXTENSION_ITEM_CONFIG", { itemId: item.id });
    }

    const soul = this.db
      .prepare("SELECT status, eval_started_at, eval_deadline_at FROM souls WHERE user_id = ?")
      .get(input.userId) as
      | { status: string; eval_started_at: number | null; eval_deadline_at: number | null }
      | undefined;
    if (soul?.status !== "ghost") {
      throw new ShopError("ERR_EVAL_EXTENSION_STATUS", { userId: input.userId, status: soul?.status ?? null });
    }
    if (soul.eval_started_at === null || soul.eval_deadline_at === null) {
      throw new ShopError("ERR_EVAL_EXTENSION_CYCLE", { userId: input.userId });
    }
    if (soul.eval_deadline_at <= now()) {
      throw new ShopError("ERR_EVAL_EXTENSION_EXPIRED", { userId: input.userId, deadlineAt: soul.eval_deadline_at });
    }

    // 商品IDではなく評価サイクルで数える。商品を作り直しても枠は同じ（上のdoc comment参照）。
    // 表示・上限判断・次のsequenceは全てこの1つの値から出る。
    const usedCount = this.evaluationExtensionUsedCount(input.userId, soul.eval_started_at);
    if (usedCount >= EVAL_EXTENSION_MAX_USES) {
      throw new ShopError("ERR_EVAL_EXTENSION_LIMIT", { usedCount, maxUses: EVAL_EXTENSION_MAX_USES });
    }
    // 上限判断を通った時点で usedCount <= 4 なので、必ず 1..5 に収まる。application側の
    // 判断とDB側の`UNIQUE(user_id, eval_started_at, sequence)`/`CHECK(1..5)`が同じ
    // cycle countを見るため、constraint例外へ落ちる経路が残らない。
    const nextSequence = usedCount + 1;
    if (
      input.expected &&
      (input.expected.priceLand !== item.price_land ||
        input.expected.cycleStartedAt !== soul.eval_started_at ||
        input.expected.currentDeadlineAt !== soul.eval_deadline_at ||
        input.expected.usedCount !== usedCount)
    ) {
      throw new ShopError("ERR_TERMS_CHANGED", {
        expected: input.expected,
        actual: {
          priceLand: item.price_land,
          cycleStartedAt: soul.eval_started_at,
          currentDeadlineAt: soul.eval_deadline_at,
          usedCount,
        },
      });
    }
    return {
      cycleStartedAt: soul.eval_started_at,
      currentDeadlineAt: soul.eval_deadline_at,
      nextDeadlineAt: soul.eval_deadline_at + DAY,
      usedCount,
      remainingCount: EVAL_EXTENSION_MAX_USES - usedCount,
      nextSequence,
    };
  }

  /** 資格・上限、Land課金、購入、期限更新、使用台帳を1つのIMMEDIATE transactionで確定する。 */
  purchaseEvaluationExtension(input: {
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    expected: Pick<EvaluationExtensionQuote, "cycleStartedAt" | "currentDeadlineAt" | "usedCount"> & {
      priceLand: number;
    };
    request?: Record<string, unknown>;
    idempotencyKey: string;
  }): {
    purchase: PurchaseRow;
    item: ShopItemRow;
    needsManualDelivery: false;
    extension: EvaluationExtensionUseRow;
  } {
    const body = () => {
      // 画面表示時とは別に、Landを動かす直前のDB正本を読む。
      const quote = this.checkEvaluationExtensionPurchase({
        itemId: input.itemId,
        userId: input.userId,
        expected: input.expected,
      });
      const result = this.purchaseInternal({
        itemId: input.itemId,
        userId: input.userId,
        actor: input.actor,
        memberRoleIds: input.memberRoleIds,
        request: {
          ...input.request,
          evaluationExtension: {
            cycleStartedAt: quote.cycleStartedAt,
            previousDeadlineAt: quote.currentDeadlineAt,
            newDeadlineAt: quote.nextDeadlineAt,
            sequence: quote.nextSequence,
          },
        },
        idempotencyKey: input.idempotencyKey,
        titleOrigin: "evaluation_extension",
      });
      const ts = now();
      const changed = this.db
        .prepare(
          `UPDATE souls
              SET eval_deadline_at = ?, updated_at = ?
            WHERE user_id = ? AND status = 'ghost'
              AND eval_started_at = ? AND eval_deadline_at = ? AND eval_deadline_at > ?`,
        )
        .run(
          quote.nextDeadlineAt,
          ts,
          input.userId,
          quote.cycleStartedAt,
          quote.currentDeadlineAt,
          ts,
        ).changes;
      if (changed !== 1) throw new ShopError("ERR_TERMS_CHANGED", { itemId: input.itemId });

      const delivered = this.db
        .prepare(
          `UPDATE shop_purchases
              SET delivered_at = ?, delivery_state = 'delivered', delivery_error = NULL, delivery_updated_at = ?
            WHERE id = ? AND status = 'active' AND COALESCE(delivery_state, 'pending') <> 'delivered'`,
        )
        .run(ts, ts, result.purchase.id).changes;
      if (delivered !== 1) throw new ShopError("ERR_TERMS_CHANGED", { purchaseId: result.purchase.id });
      // 課金直前に読み直したquoteの値をそのまま使う——ここで再計算すると、判定した値と
      // 書き込む値がずれる余地が生まれる。
      const sequence = quote.nextSequence;
      this.db
        .prepare(
          `INSERT INTO shop_eval_extension_uses
             (purchase_id,item_id,user_id,eval_started_at,previous_deadline_at,new_deadline_at,sequence,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          result.purchase.id,
          result.item.id,
          input.userId,
          quote.cycleStartedAt,
          quote.currentDeadlineAt,
          quote.nextDeadlineAt,
          sequence,
          ts,
        );
      this.events.log("shop_eval_extension_purchased", {
        actor: input.actor,
        target: input.userId,
        payload: {
          purchaseId: result.purchase.id,
          itemId: result.item.id,
          evalStartedAt: quote.cycleStartedAt,
          previousDeadlineAt: quote.currentDeadlineAt,
          newDeadlineAt: quote.nextDeadlineAt,
          sequence,
          maxUses: EVAL_EXTENSION_MAX_USES,
        },
      });
      return {
        purchase: this.getPurchase(result.purchase.id)!,
        item: result.item,
        needsManualDelivery: false as const,
        extension: this.getEvaluationExtensionUse(result.purchase.id)!,
      };
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  getEvaluationExtensionUse(purchaseId: number): EvaluationExtensionUseRow | undefined {
    return this.db
      .prepare("SELECT * FROM shop_eval_extension_uses WHERE purchase_id = ?")
      .get(purchaseId) as EvaluationExtensionUseRow | undefined;
  }

  /**
   * 「このpurchaseは再評価サービス権として発行されたか」を、**購入時点で確定した記録だけ**から
   * 判定するSQL述語。呼び出し側は `shop_purchases` を別名 `p` で束ねること。
   *
   * 利用者が買っているのは「商品ID #A」ではなく「再評価面談を1回受けて結果を出してもらう権利」
   * なので、購入が成立した後は現在の商品設定をidentityに使わない。運営が商品を作り直しても、
   * `shop:reeval_item_id` を変えても、商品をdisabledにしても、既に買った権利は消えない。
   *
   * 使ってよい証拠（いずれも購入時に確定し、後から書き換わらない専用記録）:
   *   1. `shop_purchase_title_provenance.origin='reevaluation'` — 購入時に凍結されたorigin
   *   2. `shop_reeval_invite_uses` — 再評価専用のinvite消費台帳
   *   3. purchase-time delivery snapshot が `revoke_meirei` を証明する
   *   4. 再評価専用writerがpurchase ID付きで残したappend-only event
   *
   * 使ってはいけないもの: 現在の `shop:reeval_item_id`、現在の商品名/description、金額だけ、
   * invite5という数だけ、item IDの推測。これらは後から変更できるので、運営操作で過去の購入の
   * 意味が変わってしまう。
   *
   * **壊れた証拠は「証明できない」であって「lookup全体の失敗」ではない。** `json_extract()` は
   * malformed JSONに対してSQLite errorを投げる（`COALESCE`では防げない）ので、必ず
   * `json_valid()` で先に守る。壊れた1行のせいでShop全体の検索が落ちてはいけないし、
   * かといって壊れた記録から意味を推測して現在の商品定義へfallbackすることもしない
   * ——NULL・malformed・valid but non-reeval はすべて「証拠なし」に倒す。
   */
  /** `EXTERNAL_CLAIM_LIVE_STATES` の SQL 形。DDLの部分ユニーク索引と同じ文字列 */
  private static readonly CLAIM_LIVE_STATES = EXTERNAL_CLAIM_LIVE_STATES_SQL;

  private static readonly REEVALUATION_EVIDENCE_SQL = `COALESCE(
       EXISTS (SELECT 1 FROM shop_purchase_title_provenance v
                WHERE v.purchase_id = p.id AND v.origin = 'reevaluation')
    OR EXISTS (SELECT 1 FROM shop_reeval_invite_uses u WHERE u.purchase_id = p.id)
    OR CASE
         WHEN p.delivery_snapshot_json IS NULL THEN 0
         WHEN NOT json_valid(p.delivery_snapshot_json) THEN 0
         ELSE COALESCE(json_extract(p.delivery_snapshot_json, '$.delivery_kind') = 'revoke_meirei', 0)
       END
    OR EXISTS (SELECT 1 FROM events e
                WHERE e.type IN ('shop_reeval_right_purchased','reeval_legacy_purchase_recovery','reeval_legacy_rollback')
                  AND CASE
                        WHEN e.payload_json IS NULL THEN 0
                        WHEN NOT json_valid(e.payload_json) THEN 0
                        ELSE COALESCE(json_extract(e.payload_json, '$.purchaseId') = p.id, 0)
                      END)
  , 0)`;

  /** 未消費（面談サービス未提供）の再評価権であることを表す条件。消費済みは delivered で表す。 */
  private static readonly REEVALUATION_UNCONSUMED_SQL = `
    p.status = 'active' AND p.delivered_at IS NULL
    AND COALESCE(p.delivery_state, 'pending') <> 'delivered'`;

  /**
   * この購入は再評価サービス権として発行されたか。現在の商品設定は一切参照しない。
   */
  /**
   * 「まだ人が終わらせていない購入」の共通部分。list と count で二度書かない。
   *
   * 条件を二箇所に書くと、片方だけ直したときに「一覧は0件なのにバッジは3」のような
   * 食い違いが生まれる。完了APIの判定ともここで揃える——**一覧に出るものは必ず完了でき、
   * 完了APIが断るものは一覧に出さない**。
   */
  /**
   * **実際に提供したと証明できる記録。**
   *
   * `delivery_state = 'delivered'` を証拠として使えるのは、購入時provenanceを持つ
   * 新しい購入だけ。旧行の移行（`backfillShopDeliveryState`）は既定値が `delivered` で、
   * 配送スナップショットを持たない行は**移行時点の商品設定**次第でそのまま `delivered` が
   * 残る。つまり旧行の `delivered` は「配送に成功した」の一次証拠ではない。
   *
   * 旧行では `delivered_at` か `shop_delivered` event という独立した記録だけを根拠にする。
   */
  /**
   * 「この購入を配送した」と言える `shop_delivered` event の照合。**SQL側とJS側で同じ意味**に
   * するため、比較する購入IDの式だけを差し替えて使う1箇所の定義。
   *
   * `json_type(...) = 'integer'` を要求するのが要点。SQLiteの比較はaffinityで寄せるので、
   * これが無いと `{"purchaseId":"5"}`（文字列）も `{"purchaseId":5.0}`（実数）も 5 に
   * 一致してしまう。このeventは返金拒否・期限つきアクセスの復元・legacy分類の
   * **証拠境界**なので、「5に見える値」ではなく「purchaseIdという整数が正確に5」を要求する。
   *
   * 壊れたJSONで例外を投げないよう、CASEで評価順序を固定する（`json_type`/`json_extract`は
   * 不正JSONに対して throw する。SQLiteは AND を並べ替えるので CASE でなければ守れない）。
   */
  private static deliveredEventSql(idExpr: string): string {
    return `EXISTS (
      SELECT 1 FROM events e
       WHERE e.type = 'shop_delivered'
         AND CASE
               WHEN e.payload_json IS NULL THEN 0
               WHEN NOT json_valid(e.payload_json) THEN 0
               WHEN json_type(e.payload_json, '$.purchaseId') <> 'integer' THEN 0
               ELSE COALESCE(json_extract(e.payload_json, '$.purchaseId') = ${idExpr}, 0)
             END
    )`;
  }

  private static readonly DELIVERED_EVENT_SQL = Shop.deliveredEventSql("p.id");

  private static readonly DELIVERED_EVIDENCE_SQL = `(
    p.delivered_at IS NOT NULL
    OR ${Shop.DELIVERED_EVENT_SQL}
    OR EXISTS (
      SELECT 1 FROM shop_purchase_fulfillment_provenance f
       WHERE f.purchase_id = p.id AND p.delivery_state = 'delivered'
    )
  )`;

  /**
   * 上の判定を**purchase 1件へ当てるための包み**。
   *
   * 同じ「提供済みか」をJSで書き直すと、片方だけ緩い実装が残って一覧と個別判定が
   * 食い違う。渡された行の値をそのまま束ねて、SQL側の定義に判断させる。
   */
  private static readonly DELIVERED_EVIDENCE_ROW_SQL = `WITH p(id, delivered_at, delivery_state) AS (
    VALUES (CAST(? AS INTEGER), ?, ?)
  ) SELECT ${Shop.DELIVERED_EVIDENCE_SQL} AS hit FROM p`;

  /**
   * 購入時autoだと証明できるのに、**配送の結末が証明できない**旧購入。
   *
   * スナップショットがあることは「自動配送のつもりだった」の証拠でしかない。
   * 実行が成功したかは別の話で、それを示す記録が無ければ結末は不明のまま。
   * 不明を `delivered` と書いて片付けない——書けば返金も期限付きアクセスも
   * その嘘を信じてしまう。
   */
  private static readonly LEGACY_AUTO_OUTCOME_UNKNOWN_SQL = `(
    p.status = 'active'
    AND p.delivered_at IS NULL
    AND p.delivery_snapshot_json IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM shop_purchase_fulfillment_provenance f WHERE f.purchase_id = p.id)
    AND NOT ${Shop.DELIVERED_EVENT_SQL}
    AND NOT ${Shop.REEVALUATION_EVIDENCE_SQL}
  )`;

  /**
   * まだ終わっていない購入の共通部分。
   *
   * `excludeItemIds` は**現在の設定**由来なので、既存purchaseのidentityには使わない
   * （普通の商品を後から専用商品に指定しただけで、過去の仕事が消えてしまう）。
   * 専用サービスの除外はpurchase固有の証拠で行う。
   */
  private static openSql(): string {
    return `p.status = 'active'
      AND p.delivered_at IS NULL
      AND NOT ${Shop.DELIVERED_EVIDENCE_SQL}
      AND NOT ${Shop.REEVALUATION_EVIDENCE_SQL}`;
  }

  /** 購入時に「手動配送のstorefront商品」だったと証明できる、未完了の購入。 */
  private static pendingManualSql(): string {
    return `${Shop.openSql()}
      AND EXISTS (
        SELECT 1 FROM shop_purchase_fulfillment_provenance f
         WHERE f.purchase_id = p.id
           AND f.delivery_mode = 'manual'
           AND f.source = 'storefront'
      )`;
  }

  /**
   * 購入時の提供方式を証明できない未完了の購入（旧購入）。
   *
   * 配送スナップショットがある行はここに含めない。スナップショットは
   * `delivery === 'auto'` のときしか作られないので、**あることは購入時autoの証明**になる。
   * （逆に、無いことは手動の証明にならない——それがこのバケットの存在理由。）
   *
   * `delivery_state = 'delivered'` だけでは除外しない。旧行の移行では既定値が
   * `delivered` なので、それを提供済みの証拠に使うと**未対応の仕事が黙って消える**。
   * 除外できるのは `delivered_at` か `shop_delivered` event がある行だけ。
   */
  private static legacyUnknownSql(): string {
    return `${Shop.openSql()}
      AND p.delivery_snapshot_json IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM shop_purchase_fulfillment_provenance f WHERE f.purchase_id = p.id
      )`;
  }

  isReevaluationPurchase(purchaseId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM shop_purchases p
          WHERE p.id = ? AND ${Shop.REEVALUATION_EVIDENCE_SQL} LIMIT 1`,
      )
      .get(purchaseId) as { ok: number } | undefined;
    return row !== undefined;
  }

  /**
   * userの**未消費**再評価権。ticketへ予約済みかどうかは問わない——予約中でも権利は
   * まだ消費されていないので、重複購入のブロックにはこちらを使う。
   */
  findUnconsumedReevaluationRight(userId: string): { id: number } | null {
    return (this.db
      .prepare(
        `SELECT p.id FROM shop_purchases p
          WHERE p.user_id = ? AND ${Shop.REEVALUATION_UNCONSUMED_SQL}
            AND ${Shop.REEVALUATION_EVIDENCE_SQL}
          ORDER BY p.purchased_at, p.id LIMIT 1`,
      )
      .get(userId) as { id: number } | undefined) ?? null;
  }

  /**
   * ticketへ新しく**予約**できる再評価権。未消費かつ、どのticketにも予約されていないもの。
   * 「権利そのものがあるか」（上）と「今ticketへ予約できるか」（ここ）は別の問い。
   */
  findUnreservedReevaluationRight(userId: string): { id: number } | null {
    return (this.db
      .prepare(
        `SELECT p.id FROM shop_purchases p
          WHERE p.user_id = ? AND ${Shop.REEVALUATION_UNCONSUMED_SQL}
            AND ${Shop.REEVALUATION_EVIDENCE_SQL}
            AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.linked_purchase_id = p.id)
          ORDER BY p.purchased_at, p.id LIMIT 1`,
      )
      .get(userId) as { id: number } | undefined) ?? null;
  }

  /**
   * 「この商品は再評価サービスの販売商品である」という指定を永続化する。冪等。
   *
   * 記録は3層:
   *   1. **write-time trigger（primary guarantee）** — `settings` への書き込みそのもの。
   *      Shopが一度も観測しなくても、指定された事実が残る（`ensureSchema()` 参照）。
   *   2. **read-time sync（repair / compatibility）** — 構築時と、現在の指定を参照した時。
   *      trigger導入前のDBや、triggerを持たない経路で書かれた設定を後から回収する。
   *   3. **purchase evidence（pre-registry legacy fallback）** — registry以前の履歴。
   *
   * **購入が成立した時点では遅い**——実績0件のまま設定がA→Bへ移ると、最初の利用者が
   * 「昨日まで再評価商品だったものが普通の商品に化けた」事故に遭う。
   */
  registerReevaluationSaleItem(itemId: number, source = "sale_setting"): void {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) return;
    if (!this.getItem(itemId)) return; // 実在しないIDは記録しない
    this.db
      .prepare(
        "INSERT OR IGNORE INTO shop_reevaluation_sale_items (item_id, first_seen_at, source) VALUES (?,?,?)",
      )
      .run(itemId, now(), source);
  }

  /**
   * この商品は「再評価サービス商品」として一度でも確定したか。
   * 現在の販売設定から外れた旧商品Aを、generic storefrontへ落とさないための判定。
   *
   * 判定材料は3つとも現在の商品名・価格・descriptionから独立している:
   *   1. 現在の販売設定（今まさに指定されている）
   *   2. 販売商品registry（過去に指定された事実。購入実績0でも残る）
   *   3. その商品でのsemantic reevaluation purchase（registry導入前の履歴を拾う）
   */
  isHistoricalReevaluationItem(itemId: number): boolean {
    if (this.currentReevaluationSaleItemId() === itemId) return true;
    const registered = this.db
      .prepare("SELECT 1 AS ok FROM shop_reevaluation_sale_items WHERE item_id = ? LIMIT 1")
      .get(itemId) as { ok: number } | undefined;
    if (registered !== undefined) return true;
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM shop_purchases p
          WHERE p.item_id = ? AND ${Shop.REEVALUATION_EVIDENCE_SQL} LIMIT 1`,
      )
      .get(itemId) as { ok: number } | undefined;
    return row !== undefined;
  }

  /**
   * 例外補償の候補——面談で消費済みで、まだ補償されていない再評価権。
   * 現在の `shop:reeval_item_id` も現在の商品IDも要件にしない（A→B後・設定未設定でも出る）。
   */
  private static readonly REEVALUATION_COMPENSABLE_SQL = `
    p.status = 'active' AND p.delivered_at IS NOT NULL AND p.delivery_state = 'delivered'
    AND NOT EXISTS (SELECT 1 FROM shop_reeval_compensations c WHERE c.purchase_id = p.id)`;

  listCompensableReevaluationPurchases(opts: { limit?: number; offset?: number } = {}): PurchaseRow[] {
    return this.db
      .prepare(
        `SELECT p.* FROM shop_purchases p
          WHERE ${Shop.REEVALUATION_COMPENSABLE_SQL} AND ${Shop.REEVALUATION_EVIDENCE_SQL}
          ORDER BY p.delivered_at DESC, p.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(opts.limit ?? 25, opts.offset ?? 0) as PurchaseRow[];
  }

  countCompensableReevaluationPurchases(): number {
    return (this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM shop_purchases p
          WHERE ${Shop.REEVALUATION_COMPENSABLE_SQL} AND ${Shop.REEVALUATION_EVIDENCE_SQL}`,
      )
      .get() as { c: number }).c;
  }

  /**
   * 再評価権を購入する。資格確認、支払い、購入行、招待使用台帳を同じ IMMEDIATE transaction で確定する。
   */
  checkReevaluationPurchase(input: {
    itemId: number;
    userId: string;
    mode: "land" | "invite";
  }): { availableInvites: number } {
    const configuredId = this.currentReevaluationSaleItemId();
    const item = this.getItem(input.itemId);
    if (
      configuredId !== input.itemId ||
      !item ||
      !item.enabled ||
      item.price_land !== REEVAL_PRICE_LAND ||
      item.price_alt_kind !== "invite" ||
      item.price_alt_amount !== REEVAL_INVITE_COUNT ||
      item.kind !== "one_shot" ||
      item.delivery !== "manual"
    ) {
      throw new ShopError("ERR_REEVAL_ITEM_CONFIG", { itemId: input.itemId, configuredId });
    }
    // ここまで来た＝この商品は再評価販売商品として現在指定されている。購入の成否に関わらず
    // その事実を残す（実績0件のまま設定が移っても、旧商品がgenericへ落ちない）。
    this.registerReevaluationSaleItem(item.id, "sale_check");
    // 面談を受けられない状態なら新しい権利を売らない。UI表示前・chip返還retry・課金直前の
    // すべてがこの1つの前提条件を通るので、charge pathにpreflightが1箇所しか無い状態にならない。
    this.options.assertReevaluationIntakeAvailable?.();
    const soul = this.db.prepare("SELECT status FROM souls WHERE user_id = ?").get(input.userId) as
      | { status: string }
      | undefined;
    if (soul?.status !== "meirei") {
      throw new ShopError("ERR_REEVAL_STATUS", { userId: input.userId, status: soul?.status ?? null });
    }
    // 商品IDではなく「未消費の再評価権を持っているか」で重複を判定する。旧商品Aの権利を
    // 持ったまま新商品Bを買えてはいけない。予約中でも権利は未消費なので除外しない。
    const existing = this.findUnconsumedReevaluationRight(input.userId);
    if (existing) throw new ShopError("ERR_REEVAL_RIGHT_EXISTS", { purchaseId: existing.id });
    const availableInvites = input.mode === "invite"
      ? (this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM invites i
              LEFT JOIN shop_reeval_invite_uses u ON u.invite_id = i.id
             WHERE i.inviter_id = ? AND u.invite_id IS NULL`,
          )
          .get(input.userId) as { n: number }).n
      : 0;
    if (input.mode === "invite" && availableInvites < REEVAL_INVITE_COUNT) {
      throw new ShopError("ERR_REEVAL_INVITES_INSUFFICIENT", {
        available: availableInvites,
        required: REEVAL_INVITE_COUNT,
      });
    }
    return { availableInvites };
  }

  purchaseReevaluation(input: {
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    mode: "land" | "invite";
    request?: Record<string, unknown>;
    idempotencyKey: string;
  }): { purchase: PurchaseRow; item: ShopItemRow; needsManualDelivery: boolean } {
    const configuredId = this.currentReevaluationSaleItemId();
    if (configuredId !== input.itemId) {
      throw new ShopError("ERR_REEVAL_ITEM_CONFIG", { itemId: input.itemId, configuredId });
    }
    const body = () => {
      // UIでの事前確認とは別に、支払い確定の直前にもDBの正本を再読する。
      // 500,000Ld / 招待5件を動かす直前に、資格・重複・受付可用性をまとめて再確認する
      // （`checkReevaluationPurchase` が受付可用性も見る）。表示から確認ボタンまでの間に
      // panelが停止される余地があるため、UI側のpreflightだけに任せない。
      this.checkReevaluationPurchase({ itemId: input.itemId, userId: input.userId, mode: input.mode });

      let inviteIds: number[] = [];
      if (input.mode === "invite") {
        inviteIds = (
          this.db
            .prepare(
              `SELECT i.id
                 FROM invites i
                 LEFT JOIN shop_reeval_invite_uses u ON u.invite_id = i.id
                WHERE i.inviter_id = ? AND u.invite_id IS NULL
                ORDER BY i.credited_at, i.id
                LIMIT ?`,
            )
            .all(input.userId, REEVAL_INVITE_COUNT) as Array<{ id: number }>
        ).map((row) => row.id);
        if (inviteIds.length < REEVAL_INVITE_COUNT) {
          throw new ShopError("ERR_REEVAL_INVITES_INSUFFICIENT", {
            available: inviteIds.length,
            required: REEVAL_INVITE_COUNT,
          });
        }
      }

      const result = this.purchaseInternal({
        itemId: input.itemId,
        userId: input.userId,
        actor: input.actor,
        memberRoleIds: input.memberRoleIds,
        payAlt: input.mode === "invite",
        request: input.request,
        idempotencyKey: input.idempotencyKey,
        titleOrigin: "reevaluation",
      });
      if (input.mode === "invite") {
        const insert = this.db.prepare(
          "INSERT INTO shop_reeval_invite_uses (invite_id,purchase_id,user_id,used_at) VALUES (?,?,?,?)",
        );
        const ts = now();
        for (const inviteId of inviteIds) insert.run(inviteId, result.purchase.id, input.userId, ts);
      }
      this.events.log("shop_reeval_right_purchased", {
        actor: input.actor,
        payload: { purchaseId: result.purchase.id, userId: input.userId, mode: input.mode, inviteIds },
      });
      return result;
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  listReevalInviteUses(purchaseId: number): ReevalInviteUseRow[] {
    return this.db
      .prepare("SELECT * FROM shop_reeval_invite_uses WHERE purchase_id = ? ORDER BY invite_id")
      .all(purchaseId) as ReevalInviteUseRow[];
  }

  getReevalCompensation(purchaseId: number): ReevalCompensationRow | undefined {
    return this.db.prepare("SELECT * FROM shop_reeval_compensations WHERE purchase_id = ?").get(purchaseId) as
      | ReevalCompensationRow
      | undefined;
  }

  /** 消費済み再評価権への例外補償。購入・結果・招待使用は一切巻き戻さない。 */
  compensateReevaluation(input: {
    /** @deprecated 権威ではない。semantic判定が正本——A→B後でもsetting未設定でも補償できる。 */
    itemId?: number;
    purchaseId: number;
    departmentKey: string;
    amount: number;
    reason: string;
    actor: string;
    approvedBy?: string;
    idempotencyKey: string;
  }): ReevalCompensationRow {
    const departments = this.options.departments;
    if (!departments) {
      throw new ShopError("ERR_REEVAL_COMPENSATION_UNAVAILABLE", { purchaseId: input.purchaseId });
    }
    const body = () => {
      const purchase = this.getPurchase(input.purchaseId);
      if (!purchase) {
        throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId: input.purchaseId });
      }
      // 現在の商品IDではなく、その購入が再評価権として発行されたかで判断する。
      if (!this.isReevaluationPurchase(purchase.id)) {
        throw new ShopError("ERR_REEVAL_COMPENSATION_UNAVAILABLE", { purchaseId: input.purchaseId });
      }
      if (purchase.status !== "active" || purchase.delivered_at === null || purchase.delivery_state !== "delivered") {
        throw new ShopError("ERR_REEVAL_NOT_CONSUMED", { purchaseId: input.purchaseId });
      }
      if (this.getReevalCompensation(input.purchaseId)) {
        throw new ShopError("ERR_REEVAL_ALREADY_COMPENSATED", { purchaseId: input.purchaseId });
      }
      const reason = input.reason.trim();
      if (!reason || !Number.isInteger(input.amount) || input.amount <= 0) {
        throw new ShopError("ERR_REEVAL_COMPENSATION_UNAVAILABLE", { amount: input.amount });
      }
      const transfer = departments.withdraw(purchase.user_id, {
        key: input.departmentKey,
        amount: input.amount,
        actor: input.actor,
        approvedBy: input.approvedBy,
        idempotencyKey: input.idempotencyKey,
        reason: `再評価チャレンジ例外補償 #${purchase.id}: ${reason}`,
        refType: "shop_reeval_compensation",
        refId: String(purchase.id),
      });
      const ts = now();
      const info = this.db
        .prepare(
          `INSERT INTO shop_reeval_compensations
             (purchase_id,user_id,department_key,amount,reason,actor_id,ledger_transaction_id,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(purchase.id, purchase.user_id, input.departmentKey, input.amount, reason, input.actor, transfer.tx.id, ts);
      this.events.log("shop_reeval_compensated", {
        actor: input.actor,
        payload: {
          compensationId: info.lastInsertRowid,
          purchaseId: purchase.id,
          userId: purchase.user_id,
          departmentKey: input.departmentKey,
          amount: input.amount,
          ledgerTransactionId: transfer.tx.id,
          reason,
        },
      });
      return this.getReevalCompensation(purchase.id)!;
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /**
   * 本人の入力（`request_json`）で購入を引く。**二重課金を止めるための照会。**
   *
   * 同じ申請に対して既に返金されていない購入があるなら、もう一度課金してはいけない。
   * 逆に、返金済みのものは残っていても「まだ払っていない」ので、ここには出さない。
   */
  findActivePurchaseByRequest(userId: string, itemId: number, key: string, value: unknown): PurchaseRow | undefined {
    const rows = this.db
      .prepare(
        "SELECT * FROM shop_purchases WHERE user_id = ? AND item_id = ? AND status = 'active' AND request_json IS NOT NULL ORDER BY id DESC",
      )
      .all(userId, itemId) as PurchaseRow[];
    return rows.find((row) => {
      try {
        return (JSON.parse(row.request_json!) as Record<string, unknown>)[key] === value;
      } catch {
        return false;
      }
    });
  }

  getPurchase(id: number): PurchaseRow | undefined {
    return this.db.prepare("SELECT * FROM shop_purchases WHERE id = ?").get(id) as PurchaseRow | undefined;
  }

  /**
   * 汎用の30日延長を受け付けてよい商品か。
   *
   * **Botが利用権そのものを管理している商品だけ**（自動でロールを付け、失効で剥がす）。
   * 手動配送の期限商品は、Landを取っても実際の権利が伸びる保証がない
   * （旧「オリジナルロール継続」は、どのDiscordロールが契約の実体かDBが知らない）。
   * そこへ汎用の延長ボタンを出すと、**払わせただけで何も起きない**を作ってしまう。
   */
  isExtendable(item: Pick<ShopItemRow, "kind" | "duration_days" | "delivery" | "delivery_kind" | "enabled">): boolean {
    if (termDays(item as ShopItemRow) === null) return false;
    if (!item.enabled) return false;
    return item.delivery === "auto" && item.delivery_kind === "add_role";
  }

  /**
   * 期限を30日延ばす。**自動更新ではない**（本人が押したときだけ動く）。
   *
   * 課金・期限更新・記録を1トランザクションで確定させる。分けると
   * 「Landだけ減って期限が伸びない」が作れてしまう。
   *
   * `expected` は確認画面に出した条件。確定までの間に価格・期間・期限が動いていたら
   * **無課金で拒否**する（勝手に新しい条件で課金しない）。ただし同じ確認画面の二度押しは
   * 条件検査より先に replay として返すので、正常な連打が「条件が変わった」にはならない。
   */
  extend(input: {
    purchaseId: number;
    userId: string;
    actor: string;
    /** 同じ確認画面からの実行は同じ値になること（二度押しの冪等はこれで決まる） */
    operationId: string;
    memberRoleIds: readonly string[];
    expected: { priceLand: number; days: number; expiresAt: number | null };
  }): { purchase: PurchaseRow; item: ShopItemRow; extended: boolean; addedDays: number } {
    const idempotencyKey = `shop:extend:${input.purchaseId}:${input.operationId}`;
    const run = this.db.transaction(() => {
      const purchase = this.getPurchase(input.purchaseId);
      if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId: input.purchaseId });
      if (purchase.user_id !== input.userId) throw new ShopError("ERR_NOT_OWNER", { purchaseId: input.purchaseId });
      const item = this.getItem(purchase.item_id);
      if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId: purchase.item_id });

      // **同じ確認画面の二度押しが先。** 1回目で期限が動いているので、
      // 条件検査を先にすると正常な連打が「内容が変わった」になってしまう
      const alreadyPaid = this.db
        .prepare("SELECT id FROM transactions WHERE idempotency_key = ?")
        .get(idempotencyKey) as { id: number } | undefined;
      if (alreadyPaid) return { purchase, item, extended: false, addedDays: 0 };

      if (purchase.status !== "active") throw new ShopError("ERR_NOT_ACTIVE", { status: purchase.status });
      if (!item.enabled) throw new ShopError("ERR_ITEM_DISABLED", { itemId: item.id });
      if (!this.isExtendable(item)) throw new ShopError("ERR_NOT_EXTENDABLE", { itemId: item.id });
      if (item.price_land === null) throw new ShopError("ERR_NO_PRICE", { itemId: item.id });
      // 階級要件は**課金の直前**にもう一度見る（購入後に落ちた人へ売り続けない）
      if (item.require_role_id && !this.roleSatisfied(input.memberRoleIds, item.require_role_id)) {
        throw new ShopError("ERR_ROLE_REQUIRED", { roleId: item.require_role_id });
      }

      const days = termDays(item)!;
      // 確認画面に出した条件と一致しているか。1つでも動いていたら課金しない
      if (
        input.expected.priceLand !== item.price_land ||
        input.expected.days !== days ||
        input.expected.expiresAt !== purchase.expires_at
      ) {
        throw new ShopError("ERR_TERMS_CHANGED", {
          expected: input.expected,
          actual: { priceLand: item.price_land, days, expiresAt: purchase.expires_at },
        });
      }

      const account = `user:${input.userId}`;
      this.ledger.ensureAccount(account, "user");
      this.ledger.transfer({
        from: account,
        to: TREASURY,
        amount: item.price_land,
        type: "tip_burn",
        actor: input.actor,
        reason: `公式ショップ延長: ${item.name}`,
        refType: "shop_extend",
        refId: String(purchase.id),
        idempotencyKey,
      });

      const nextExpires = extendedExpiry(purchase.expires_at, days);
      this.db.prepare("UPDATE shop_purchases SET expires_at = ? WHERE id = ?").run(nextExpires, purchase.id);
      this.events.log("shop_extended", {
        actor: input.actor,
        target: input.userId,
        payload: { purchaseId: purchase.id, itemId: item.id, days, from: purchase.expires_at, to: nextExpires },
      });
      return { purchase: this.getPurchase(purchase.id)!, item, extended: true, addedDays: days };
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  listUserPurchases(userId: string, opts: { activeOnly?: boolean } = {}): PurchaseRow[] {
    const where = opts.activeOnly ? "AND status = 'active'" : "";
    return this.db
      .prepare(`SELECT * FROM shop_purchases WHERE user_id = ? ${where} ORDER BY purchased_at DESC`)
      .all(userId) as PurchaseRow[];
  }

  /** 全ユーザの購入履歴（新しい順・アイテム名/配送設定を JOIN） */
  listRecentPurchases(
    limit: number = 20,
    offset: number = 0,
  ): Array<PurchaseRow & { item_name: string; item_delivery: DeliveryMode }> {
    return this.db
      .prepare(
        `SELECT p.*, i.name AS item_name, i.delivery AS item_delivery
         FROM shop_purchases p
         JOIN shop_items i ON i.id = p.item_id
         ORDER BY p.purchased_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<PurchaseRow & { item_name: string; item_delivery: DeliveryMode }>;
  }

  countPurchases(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM shop_purchases").get() as { c: number }).c;
  }


  /**
   * 課金を取り消して返す。**サービスを提供できなかったときの収束先。**
   *
   * 二重返金は2つで止める: Land取引の冪等キー（UNIQUE）と、`active` からの条件付き更新。
   * どちらかが先に成立していれば2回目は何も動かさない。
   * 返金そのものに失敗したら例外を投げる。**そこだけが人の出番**になる。
   */
  refund(purchaseId: number, reason: string, actor: string): { refunded: boolean; amount: number } {
    return this.refundWith(purchaseId, reason, actor, {});
  }

  /**
   * 返金の本体。
   *
   * `operatorNoEffect` は「運営がいま**この transaction の中で**『提供されていない』と
   * 確認した」という authority。台帳へ書いてから読み直す循環に頼らずに済むので、
   * 決着の結果（返金できたか）を確定してから監査行を1回だけ積める。
   */
  private refundWith(
    purchaseId: number,
    reason: string,
    actor: string,
    opts: { operatorNoEffect?: boolean },
  ): { refunded: boolean; amount: number } {
    const run = this.db.transaction(() => {
      const purchase = this.getPurchase(purchaseId);
      if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId });
      if (purchase.status === "refunded") return { refunded: false, amount: purchase.paid_land ?? 0 };
      if (purchase.status !== "active") throw new ShopError("ERR_NOT_ACTIVE", { status: purchase.status });
      // **外部へ副作用を投げている最中は返金しない。**
      //
      // いま Discord 側でロールが付きつつある購入を返金すると、「返金済みなのに
      // ロールだけ残る」が成立する。DBの条件付き更新は書き込みの二重化までしか
      // 止められないので、外部副作用そのものを durable な claim で表す。
      // 資産も status も1つも動かさずに止める。
      if (this.externalDeliveryInFlight(purchaseId)) {
        throw new ShopError("ERR_DELIVERY_IN_FLIGHT", { purchaseId });
      }
      // 提供済みのものは返さない（ニックネームが変わったのに返金する、を防ぐ）。
      //
      // **根拠は強い証拠だけ。** 旧行の `delivery_state='delivered'` は移行時の既定値の
      // ことがあるので、それだけで「提供済みだから返さない」とは言えない。運営が外部で
      // 確認して「提供していない」と判断した購入に対して、システムが移行推定を理由に
      // 返金を拒み続けるのは矛盾している。
      if (this.hasDeliveredEvidence(purchase)) {
        throw new ShopError("ERR_ALREADY_DELIVERED", { purchaseId });
      }
      // 代替支払を含む購入は generic refund の対象外。何をどこへ戻すべきかを generic refund は
      // 知らないし、`paid_alt_*` は「実際にその資源が減った」証拠でもない（旧実装は資源を
      // 消費していなかった）。amount=0 のまま status='refunded' にすると、**資産を戻して
      // いないのに「返金完了」という嘘**を台帳へ書くことになる。人へ escalate する。
      //
      // **提供状況より先に見る。** どちらも資産を動かさずに止めるが、こちらの方が
      // 理由として具体的（何で払ったかは提供状況と無関係に分かっている）。
      if (!Shop.genericRefundSupportedRow(purchase)) {
        throw new ShopError("ERR_ALT_REFUND_UNSUPPORTED", { purchaseId });
      }
      // 「証拠が無い＝未提供」でもない。**不明は不明として止める。**
      // 自動で返金すると、実際には提供済みだったものまで払い戻してしまう。
      // 人が確認してから決める（この経路では資産を1つも動かさない）。
      if (this.fulfillmentUnknown(purchase, opts)) {
        throw new ShopError("ERR_FULFILLMENT_UNKNOWN", { purchaseId });
      }
      const amount = purchase.paid_land ?? 0;
      if (amount > 0) {
        const account = `user:${purchase.user_id}`;
        this.ledger.ensureAccount(account, "user");
        this.ledger.transfer({
          from: TREASURY,
          to: account,
          amount,
          type: "adjust",
          actor,
          reason: `公式ショップ返金: ${reason}`,
          refType: "shop_refund",
          refId: String(purchase.id),
          idempotencyKey: `shop:refund:${purchase.id}`,
        });
      }
      const statusChangedAt = now();
      this.db.prepare(
        `INSERT OR IGNORE INTO shop_purchase_status_history (purchase_id,status,occurred_at)
         VALUES (?,'refunded',?)`,
      ).run(purchase.id, statusChangedAt);
      const updated = this.db
        .prepare(
          `UPDATE shop_purchases
              SET status = 'refunded', delivery_state = 'failed', delivery_error = ?, delivery_updated_at = ?
            WHERE id = ? AND status = 'active'`,
        )
        .run(`refunded:${reason}`.slice(0, 500), statusChangedAt, purchase.id).changes;
      if (updated !== 1) throw new ShopError("ERR_REFUND_RACE", { purchaseId });
      // 売買そのものを取り消したので、提供されなかった1枠を販売可能在庫へ戻す。
      this.restoreStockForRefund(purchase, reason, actor);
      this.events.log("shop_refunded", {
        actor,
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, amount, reason },
      });
      return { refunded: true, amount };
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  /**
   * 未提供のまま返金した購入について、消費した在庫を一度だけ戻す。
   *
   * 戻す根拠は**購入時に記録した事実**（`stock_consumed=1`）だけ。現在の
   * `shop_items.stock` は根拠にしない——運営はいつでも有限/無制限を切り替えられるので、
   * 「いま有限だから、あの購入も1枠使ったはず」は証明になっていない。逆に
   * 「いま無制限だから消費していなかった」も違う。
   *
   * 二度戻さないのは `shop_purchase_stock_restorations.purchase_id` が主キーだから。
   * 返金が再実行されても、2行目のINSERTがそこで弾かれる。
   *
   * 現在この商品が無制限販売（`stock IS NULL`）なら、数値は動かさない。`NULL + 1` に
   * 意味は無いし、無制限の商品に在庫数を作ってしまうのは別の変更になる。ただし
   * 「1枠を戻すべきだった」という事実は台帳へ残す（`applied=0`）。あとで有限へ戻す
   * ときの判断材料になる——その扱いは今回は決めない。
   */
  private restoreStockForRefund(purchase: PurchaseRow, reason: string, actor: string): void {
    const provenance = this.fulfillmentProvenance(purchase.id);
    // 購入時の事実が無い旧購入は unknown のまま。推測で在庫を増やさない。
    if (!provenance || provenance.stock_consumed !== 1) return;

    const item = this.getItem(purchase.item_id);
    const finiteNow = item !== undefined && item.stock !== null;
    const restoredAt = now();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO shop_purchase_stock_restorations
           (purchase_id,item_id,quantity,restored_at,reason,applied)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(purchase.id, purchase.item_id, 1, restoredAt, reason.slice(0, 500), finiteNow ? 1 : 0);
    // 既に戻していたなら、ここで在庫を触らない（=exactly once）。
    if (inserted.changes !== 1) return;

    if (finiteNow) {
      this.db
        .prepare("UPDATE shop_items SET stock = stock + 1, updated_at = ? WHERE id = ? AND stock IS NOT NULL")
        .run(restoredAt, purchase.item_id);
    }
    this.events.log("shop_stock_restored", {
      actor,
      target: purchase.user_id,
      payload: { purchaseId: purchase.id, itemId: purchase.item_id, quantity: 1, applied: finiteNow ? 1 : 0 },
    });
  }

  /**
   * まだ始末していない返金在庫。
   *
   * `applied=0`（返金時に無制限だったので数値を動かさなかった）のうち、決済台帳に
   * 行が無いものだけ。`applied=1` は返金時にもう戻しているので、ここには出さない
   * ——出すと同じ1枠を二度戻すことになる。
   */
  pendingStockRestorations(itemId: number): PendingStockRestorations {
    const rows = this.db
      .prepare(
        `SELECT r.purchase_id AS purchaseId, r.quantity AS quantity
           FROM shop_purchase_stock_restorations r
          WHERE r.item_id = ?
            AND r.applied = 0
            AND NOT EXISTS (
              SELECT 1 FROM shop_stock_restoration_settlements s WHERE s.purchase_id = r.purchase_id
            )
          ORDER BY r.purchase_id`,
      )
      .all(itemId) as { purchaseId: number; quantity: number }[];
    return {
      count: rows.length,
      quantity: rows.reduce((sum, r) => sum + r.quantity, 0),
      purchaseIds: rows.map((r) => r.purchaseId),
    };
  }

  /**
   * 在庫変更を表示時に確定する。**Botはここで得た指紋だけを確定へ渡す。**
   *
   * 未処理の返金義務があるまま有限へ確定する場合は、`final_stock` と
   * `add_restorations` の2つの指紋を返す。運営がどちらを選んだかが指紋に載るので、
   * 「Nを最終数のつもりで押したのに N+X になっていた」が起きない。
   */
  quoteStockChange(itemId: number, requestedStock: number | null): StockChangeQuote {
    const item = this.getItem(itemId);
    if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId });
    assertStockValue(requestedStock);
    const pending = this.pendingStockRestorations(itemId);
    // **結果が有限になるときだけ**2択が要る。無制限のままなら義務は据え置く。
    const requiresReconciliation = requestedStock !== null && pending.quantity > 0;
    const allowedModes: StockReconciliationMode[] = requiresReconciliation
      ? ["final_stock", "add_restorations"]
      : ["none"];
    const base = {
      itemId,
      currentStock: item.stock,
      requestedStock,
      pendingIds: pending.purchaseIds,
      pendingQuantity: pending.quantity,
    };
    const tokens: Partial<Record<StockReconciliationMode, string>> = {};
    const resultingStock: Partial<Record<StockReconciliationMode, number | null>> = {};
    for (const mode of allowedModes) {
      tokens[mode] = stockTermsToken({ ...base, mode });
      resultingStock[mode] = resolveStockForMode(requestedStock, pending.quantity, mode);
    }
    return { itemId, currentStock: item.stock, requestedStock, pending, requiresReconciliation, resultingStock, allowedModes, tokens };
  }

  /**
   * 在庫を変更し、未処理の返金義務に始末をつける。**在庫を動かす唯一の運営経路。**
   *
   * 確定transactionの中で事実を読み直し、表示したときの指紋と一致しなければ
   * 1つも書かずに `ERR_STOCK_TERMS_CHANGED` で止まる。表示のあとに返金が増えた
   * 場合も、別の確定が先に通った場合も、ここで弾かれる。
   */
  applyStockChange(input: {
    itemId: number;
    requestedStock: number | null;
    reconciliationMode: StockReconciliationMode;
    expectedToken: string;
    actor: string;
  }): StockChangeResult {
    assertStockValue(input.requestedStock);
    if (!GENERIC_TERMS_TOKEN_PATTERN.test(input.expectedToken)) {
      throw new ShopError("ERR_STOCK_TERMS_CHANGED", { itemId: input.itemId });
    }
    const body = (): StockChangeResult => {
      const item = this.getItem(input.itemId);
      if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId: input.itemId });
      const pending = this.pendingStockRestorations(input.itemId);
      const requiresReconciliation = input.requestedStock !== null && pending.quantity > 0;

      // **指紋を先に見る。** 状況が変わっていたなら、理由は常に「変わった」であって
      // 「そのモードは使えない」ではない。順序を逆にすると、別の確定が先に通って
      // 義務が無くなっただけの行が `NOT_APPLICABLE` として返り、運営には
      // 「押し方が悪かった」ように見えてしまう。
      const expected = stockTermsToken({
        itemId: input.itemId,
        currentStock: item.stock,
        requestedStock: input.requestedStock,
        pendingIds: pending.purchaseIds,
        pendingQuantity: pending.quantity,
        mode: input.reconciliationMode,
      });
      if (expected !== input.expectedToken) {
        throw new ShopError("ERR_STOCK_TERMS_CHANGED", { itemId: input.itemId });
      }

      // ここから先は「表示した事実と現在の事実が同じ」ことが確かめられている。
      // それでも意味の通らない組み合わせは通さない——`quoteStockChange()` は
      // こういう指紋を配らないので、通るのはAPIを直接叩いた場合だけ。
      if (requiresReconciliation && input.reconciliationMode === "none") {
        throw new ShopError("ERR_STOCK_RECONCILIATION_REQUIRED", {
          itemId: input.itemId,
          pendingQuantity: pending.quantity,
        });
      }
      if (!requiresReconciliation && input.reconciliationMode !== "none") {
        throw new ShopError("ERR_STOCK_RECONCILIATION_NOT_APPLICABLE", { itemId: input.itemId });
      }

      const newStock = resolveStockForMode(input.requestedStock, pending.quantity, input.reconciliationMode);
      const ts = now();
      this.db.prepare("UPDATE shop_items SET stock = ?, updated_at = ? WHERE id = ?").run(newStock, ts, input.itemId);

      // 義務の始末。主キー衝突で二度目は必ず落ちる（=exactly once）。
      const disposition = input.reconciliationMode === "add_restorations" ? "applied" : "absorbed";
      if (input.reconciliationMode !== "none") {
        const insert = this.db.prepare(
          `INSERT INTO shop_stock_restoration_settlements
             (purchase_id,item_id,quantity,disposition,settled_at,actor_id)
           VALUES (?,?,?,?,?,?)`,
        );
        for (const purchaseId of pending.purchaseIds) {
          const restoration = this.stockRestoration(purchaseId);
          insert.run(purchaseId, input.itemId, restoration?.quantity ?? 1, disposition, ts, input.actor);
        }
      }

      this.events.log("shop_stock_changed", {
        actor: input.actor,
        payload: {
          itemId: input.itemId,
          previousStock: item.stock,
          newStock,
          mode: input.reconciliationMode,
          settledCount: input.reconciliationMode === "none" ? 0 : pending.count,
          settledQuantity: input.reconciliationMode === "none" ? 0 : pending.quantity,
        },
      });

      return {
        itemId: input.itemId,
        previousStock: item.stock,
        newStock,
        mode: input.reconciliationMode,
        settledPurchaseIds: input.reconciliationMode === "none" ? [] : pending.purchaseIds,
        settledQuantity: input.reconciliationMode === "none" ? 0 : pending.quantity,
      };
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }


  // ── 外部配送の durable claim ────────────────────────────────────────────────

  /** いま生きている claim（`in_flight` / `uncertain`）。無ければ undefined。 */
  externalDeliveryClaim(purchaseId: number): ExternalDeliveryAttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM shop_external_delivery_attempts
          WHERE purchase_id = ? AND state IN ${Shop.CLAIM_LIVE_STATES}`,
      )
      .get(purchaseId) as ExternalDeliveryAttemptRow | undefined;
  }

  /** 外部配送が進行中で、status を動かしてはいけない購入か。 */
  externalDeliveryInFlight(purchaseId: number): boolean {
    return this.externalDeliveryClaim(purchaseId) !== undefined;
  }

  /** 生きている claim があるか。候補選択と最終判断で同じ意味を使う。 */
  private static externalDeliveryLiveSql(): string {
    return `EXISTS (
      SELECT 1 FROM shop_external_delivery_attempts a
       WHERE a.purchase_id = p.id AND a.state IN ${Shop.CLAIM_LIVE_STATES}
    )`;
  }

  /**
   * Discord へ副作用を投げる**前に**、durable に場所を取る。
   *
   * 取れた purchase は、解決するまで返金も失効も通らない。取得と同じ transaction で
   * `active` と未配送を確かめるので、「確認したあとに返金された purchase へ投げる」が
   * 起きない。同時に生きている claim は部分ユニーク索引がDB側で1つに縛る。
   */
  claimExternalDelivery(input: { purchaseId: number; deliveryKind: string; actor: string }): ExternalDeliveryClaim {
    const body = (): ExternalDeliveryClaim => {
      const row = this.db
        .prepare("SELECT status, delivery_state FROM shop_purchases WHERE id = ?")
        .get(input.purchaseId) as { status: PurchaseStatus; delivery_state: DeliveryState | null } | undefined;
      if (!row) return { ok: false, reason: "not_found" };
      if (row.delivery_state === "delivered") return { ok: false, reason: "already_delivered", status: row.status };
      if (row.status !== "active") return { ok: false, reason: "not_active", status: row.status };
      if (this.externalDeliveryClaim(input.purchaseId)) return { ok: false, reason: "in_flight", status: row.status };

      const token = randomBytes(12).toString("base64url");
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO shop_external_delivery_attempts
             (purchase_id, attempt_token, delivery_kind, state, started_at, updated_at, detail)
           VALUES (?,?,?, 'in_flight', ?, ?, NULL)`,
        )
        .run(input.purchaseId, token, input.deliveryKind, ts, ts);
      this.events.log("shop_external_delivery_claimed", {
        actor: input.actor,
        payload: { purchaseId: input.purchaseId, deliveryKind: input.deliveryKind },
      });
      return { ok: true, token };
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /**
   * 外部の目的状態を確認できたので、配送済みまで**同じ transaction で**確定する。
   *
   * `active` かつ claim が一致することを書き込みと同じ文で確かめる。合わなければ
   * 1つも書かずに false を返す。**呼び出し側は false を無視してはいけない**——
   * 無視すると「Discordでは提供済みなのにDBでは未確定」を成功として流してしまう。
   */
  settleExternalDelivery(input: { purchaseId: number; token: string; actor: string }): boolean {
    const body = (): boolean => {
      const claimed = this.db
        .prepare(
          `UPDATE shop_external_delivery_attempts
              SET state = 'settled', updated_at = ?
            WHERE purchase_id = ? AND attempt_token = ? AND state IN ${Shop.CLAIM_LIVE_STATES}`,
        )
        .run(now(), input.purchaseId, input.token).changes;
      if (claimed !== 1) return false;
      // status が動いていれば delivered にはしない（返金済みへ配送済みを書かない）。
      //
      // **claim も一緒に巻き戻す。** ここで claim だけ settled のまま残すと、
      // 「Discordにはロールが有るのに、返金も失効も素通りする」購入ができてしまう。
      // better-sqlite3 は false を返しただけでは巻き戻さないので、投げて戻す。
      if (!this.markDeliverySucceeded(input.purchaseId, input.actor)) throw new SettlementConflict();
      return true;
    };
    try {
      return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
    } catch (error) {
      if (error instanceof SettlementConflict) return false;
      throw error;
    }
  }

  /**
   * 副作用が起きていないと**確認できた**ので claim を解放する。ここまで来て初めて
   * 「失敗だった」と言える＝返金してよい。
   */
  releaseExternalDelivery(input: { purchaseId: number; token: string; reason: string; actor: string }): boolean {
    const body = (): boolean => {
      const changed = this.db
        .prepare(
          `UPDATE shop_external_delivery_attempts
              SET state = 'released', updated_at = ?, detail = ?
            WHERE purchase_id = ? AND attempt_token = ? AND state IN ${Shop.CLAIM_LIVE_STATES}`,
        )
        .run(now(), input.reason.slice(0, 500), input.purchaseId, input.token).changes;
      if (changed !== 1) return false;
      this.events.log("shop_external_delivery_released", {
        actor: input.actor,
        payload: { purchaseId: input.purchaseId, reason: input.reason.slice(0, 200) },
      });
      return true;
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /**
   * 投げたが結果を確認できない。**claim を消さない。**
   *
   * ここで解放すると「失敗だった」と断定したことになり、実際には提供済みなのに
   * 返金する経路が開く。再起動を跨いで残し、収束処理と運営の目に触れさせる。
   */
  markExternalDeliveryUncertain(input: { purchaseId: number; token: string; reason: string; actor: string }): boolean {
    const body = (): boolean => {
      const changed = this.db
        .prepare(
          `UPDATE shop_external_delivery_attempts
              SET state = 'uncertain', updated_at = ?, detail = ?
            WHERE purchase_id = ? AND attempt_token = ? AND state IN ${Shop.CLAIM_LIVE_STATES}`,
        )
        .run(now(), input.reason.slice(0, 500), input.purchaseId, input.token).changes;
      if (changed !== 1) return false;
      this.events.log("shop_external_delivery_uncertain", {
        actor: input.actor,
        payload: { purchaseId: input.purchaseId, reason: input.reason.slice(0, 200) },
      });
      return true;
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /** 決着していない外部配送。再起動後の収束と、運営画面の両方から使う。 */
  listUnresolvedExternalDeliveries(limit = 50): Array<ExternalDeliveryAttemptRow & { user_id: string; status: PurchaseStatus }> {
    return this.db
      .prepare(
        `SELECT a.*, p.user_id, p.status
           FROM shop_external_delivery_attempts a
           JOIN shop_purchases p ON p.id = a.purchase_id
          WHERE a.state IN ${Shop.CLAIM_LIVE_STATES}
          ORDER BY a.started_at ASC
          LIMIT ?`,
      )
      .all(limit) as Array<ExternalDeliveryAttemptRow & { user_id: string; status: PurchaseStatus }>;
  }

  countUnresolvedExternalDeliveries(): number {
    return this.db
      .prepare(`SELECT COUNT(*) FROM shop_external_delivery_attempts WHERE state IN ${Shop.CLAIM_LIVE_STATES}`)
      .pluck()
      .get() as number;
  }


  // ── 運営による決着（Phase H）────────────────────────────────────────────────

  /** 運営が「提供されていない」と確認した記録があるか。 */
  operatorConfirmedNoEffect(purchaseId: number): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM shop_operator_resolutions WHERE purchase_id = ? AND decision = 'no_effect' LIMIT 1",
      )
      .get(purchaseId);
    return row !== undefined;
  }

  /** この購入に対する決着の履歴（新しい順）。 */
  operatorResolutions(purchaseId: number): OperatorResolutionRow[] {
    return this.db
      .prepare("SELECT * FROM shop_operator_resolutions WHERE purchase_id = ? ORDER BY resolved_at DESC, id DESC")
      .all(purchaseId) as OperatorResolutionRow[];
  }

  /**
   * いま決着待ちの案件か。決着済み・自動収束済みなら null。
   *
   * **一覧と同じSQLを1件へ当てる。** 片方だけ緩い判定を持つと、キューに出ているのに
   * 開くと「決着済み」になる（またはその逆）が起きる。
   */
  unresolvedCaseKind(purchaseId: number): UnresolvedCaseKind | null {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) return null;
    if (this.externalDeliveryClaim(purchaseId)) return "uncertain_delivery";
    const legacy = this.db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM shop_purchases p
                    WHERE p.id = ? AND ${Shop.legacyUnknownSql()} AND NOT ${Shop.OPERATOR_DECIDED_SQL}) AS unknown_kind,
           EXISTS (SELECT 1 FROM shop_purchases p
                    WHERE p.id = ? AND ${Shop.LEGACY_AUTO_OUTCOME_UNKNOWN_SQL} AND NOT ${Shop.OPERATOR_DECIDED_SQL}) AS unknown_outcome`,
      )
      .get(purchaseId, purchaseId) as { unknown_kind: number; unknown_outcome: number };
    if (legacy.unknown_kind === 1 || legacy.unknown_outcome === 1) return "legacy_unknown";
    return null;
  }

  /**
   * 決着画面を開いたときの事実。**確定はこの `token` を持ってくること。**
   */
  quoteOperatorResolution(purchaseId: number): OperatorResolutionQuote {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId });
    const kind = this.unresolvedCaseKind(purchaseId);
    const claim = this.externalDeliveryClaim(purchaseId);
    const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
    const item = this.getItem(purchase.item_id);
    const amount = purchase.paid_land ?? 0;
    // 代替支払を含む購入は generic refund の対象外（Phase C）。ここでも返金は出さない。
    const refundSupported = Shop.genericRefundSupportedRow(purchase) && purchase.status === "active";
    // **「もう一度配る」は、実際に配れるときだけ。** `delivery_kind` が読めることは
    // 「配り直せる」の証明ではない（購入時 provenance が無い旧購入でも読める）。
    const retrySupported = this.deliveryRetryEligible(purchaseId);
    // **決着済みには何も足せない。** UIがボタンを出さないことは authority ではないので、
    // ここで空にしたうえで確定側でも拒む。
    const allowed: OperatorDecision[] = kind === null ? [] : ["delivered", "no_effect", "still_unknown"];
    return {
      purchaseId,
      kind,
      userId: purchase.user_id,
      itemName: item?.name ?? `#${purchase.item_id}`,
      purchasedAt: purchase.purchased_at,
      status: purchase.status,
      deliveryState: purchase.delivery_state,
      deliveryKind: snapshot?.delivery_kind ?? claim?.delivery_kind ?? null,
      reason:
        kind === null
          ? "resolved"
          : kind === "uncertain_delivery"
            ? `external_${claim?.state ?? "unknown"}`
            : "legacy_unknown",
      stuckSince: claim?.started_at ?? purchase.purchased_at,
      refundableAmount: amount,
      refundSupported,
      retrySupported,
      allowedDecisions: allowed,
      token: this.operatorResolutionToken(purchase, kind, claim),
    };
  }

  /**
   * 決着の指紋。**画面を開いたあとに動きうるものを全部入れる。**
   * 1つでも違えば、その画面からの決定は通さない。
   */
  private operatorResolutionToken(
    purchase: PurchaseRow,
    kind: UnresolvedCaseKind | null,
    claim: ExternalDeliveryAttemptRow | undefined,
  ): string {
    const canonical = JSON.stringify([
      purchase.id,
      kind,
      purchase.status,
      purchase.delivery_state,
      purchase.delivered_at,
      purchase.paid_land,
      purchase.paid_alt_kind,
      purchase.paid_alt_amount,
      claim?.attempt_token ?? null,
      claim?.state ?? null,
      this.operatorResolutions(purchase.id).length,
    ]);
    return createHash("sha256").update(canonical, "utf8").digest().subarray(0, GENERIC_TERMS_TOKEN_BYTES).toString("base64url");
  }

  /**
   * 運営の決着を確定する。
   *
   * **確定した結果を読み直してから、台帳へ1回だけ積む。** 先に台帳を書くと、
   * そのあとの返金の成否を書き残せない（append-onlyなので後から直せない）。
   *
   * `still_unknown` は状態を変えない（分からないものを false へ倒さない）。
   * `refund: true` は「提供なしを確認したうえで返金まで一気に行う」ためのもので、
   * `no_effect` のときだけ許す。
   */
  resolveOperatorCase(input: {
    purchaseId: number;
    decision: OperatorDecision;
    expectedToken: string;
    actor: string;
    note?: string;
    refund?: boolean;
  }): OperatorResolutionResult {
    // **根拠の検証は何よりも先。** UIが止めていることは authority ではない。
    // ここを通さないと、claim も delivery も ledger も台帳も1つも動かない。
    const note = (input.note ?? "").trim();
    if (input.decision !== "still_unknown" && note.length === 0) {
      throw new ShopError("ERR_RESOLUTION_EVIDENCE_REQUIRED", {
        purchaseId: input.purchaseId,
        decision: input.decision,
      });
    }
    const body = (): OperatorResolutionResult => {
      const purchase = this.getPurchase(input.purchaseId);
      if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId: input.purchaseId });
      const kind = this.unresolvedCaseKind(input.purchaseId);
      const claim = this.externalDeliveryClaim(input.purchaseId);

      // **画面を開いたときの事実と一致しなければ、1つも書かずに止める。**
      if (this.operatorResolutionToken(purchase, kind, claim) !== input.expectedToken) {
        throw new ShopError("ERR_RESOLUTION_STALE", { purchaseId: input.purchaseId });
      }
      if (kind === null) {
        // もう決着している（別の運営が処理した／自動収束した）。
        // **`still_unknown` も含めて拒む。** 通すと、決着済みの購入へ偽の
        // `legacy_unknown / still_unknown` という監査行を後から足せてしまう。
        throw new ShopError("ERR_RESOLUTION_NOT_APPLICABLE", { purchaseId: input.purchaseId });
      }
      if (input.refund && input.decision !== "no_effect") {
        throw new ShopError("ERR_RESOLUTION_NOT_APPLICABLE", { purchaseId: input.purchaseId });
      }

      const before = {
        status: purchase.status,
        deliveryState: purchase.delivery_state,
        claim: claim ? { state: claim.state, deliveryKind: claim.delivery_kind } : null,
        kind,
      };
      const ts = now();
      let refunded = false;
      let refundedAmount = 0;

      if (input.decision === "delivered") {
        if (purchase.status !== "active") {
          throw new ShopError("ERR_RESOLUTION_NOT_APPLICABLE", { purchaseId: input.purchaseId, status: purchase.status });
        }
        if (claim) {
          // claim と delivered を同じ transaction で確定する
          const settled = this.db
            .prepare(
              `UPDATE shop_external_delivery_attempts
                  SET state = 'settled', updated_at = ?, detail = ?
                WHERE purchase_id = ? AND attempt_token = ? AND state IN ${Shop.CLAIM_LIVE_STATES}`,
            )
            .run(ts, "operator_confirmed_delivered", input.purchaseId, claim.attempt_token).changes;
          if (settled !== 1) throw new ShopError("ERR_RESOLUTION_STALE", { purchaseId: input.purchaseId });
        }
        if (!this.markDeliverySucceeded(input.purchaseId, input.actor)) {
          throw new ShopError("ERR_RESOLUTION_STALE", { purchaseId: input.purchaseId });
        }
      } else if (input.decision === "no_effect") {
        if (claim) {
          const released = this.db
            .prepare(
              `UPDATE shop_external_delivery_attempts
                  SET state = 'released', updated_at = ?, detail = ?
                WHERE purchase_id = ? AND attempt_token = ? AND state IN ${Shop.CLAIM_LIVE_STATES}`,
            )
            .run(ts, "operator_confirmed_no_effect", input.purchaseId, claim.attempt_token).changes;
          if (released !== 1) throw new ShopError("ERR_RESOLUTION_STALE", { purchaseId: input.purchaseId });
        }
        this.markDeliveryFailed(input.purchaseId, "operator_confirmed_no_effect", input.actor);
      }

      if (input.refund && input.decision === "no_effect") {
        // **運営の「提供なし」確認をそのまま authority として渡す。**
        // 台帳へ先に書いてから読み直す循環にすると、監査行を「返金前の姿」で
        // 積むことになり、実際の結果と食い違う。
        const outcome = this.refundWith(input.purchaseId, "運営確認: 提供なし", input.actor, {
          operatorNoEffect: true,
        });
        refunded = outcome.refunded;
        refundedAmount = outcome.amount;
      }

      const after = this.getPurchase(input.purchaseId)!;
      const finalClaim = this.db
        .prepare("SELECT state FROM shop_external_delivery_attempts WHERE purchase_id = ? AND attempt_token = ?")
        .get(input.purchaseId, claim?.attempt_token ?? "") as { state: string } | undefined;

      // **この transaction が実際に確定した結果を、1回だけ積む。**
      // append-only なので「仮の行を入れて後で直す」はできない。だから最後に書く。
      this.db
        .prepare(
          `INSERT INTO shop_operator_resolutions
             (purchase_id, kind, decision, operator_id, note, before_state, after_state, attempt_token, refunded, resolved_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.purchaseId,
          kind,
          input.decision,
          input.actor,
          note.slice(0, 1000) || null,
          JSON.stringify(before),
          JSON.stringify({
            decision: input.decision,
            status: after.status,
            deliveryState: after.delivery_state,
            claimState: finalClaim?.state ?? null,
            refunded,
            refundedAmount,
          }),
          claim?.attempt_token ?? null,
          refunded ? 1 : 0,
          ts,
        );
      this.events.log("shop_operator_resolution", {
        actor: input.actor,
        target: purchase.user_id,
        payload: {
          purchaseId: input.purchaseId,
          kind,
          decision: input.decision,
          refunded,
        },
      });
      return {
        purchaseId: input.purchaseId,
        decision: input.decision,
        refunded,
        refundedAmount,
        deliveryState: after.delivery_state,
        status: after.status,
      };
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /**
   * 決着待ちの候補を**1本のストリーム**として定義する。
   *
   * 一覧も件数もこの定義だけを使う。バケットごとに `LIMIT` を掛けてからJS側で
   * 重複を除く方式だと、同じ購入が2つの条件に当たったときに1ページの件数が
   * 足りなくなるし、件数と一覧の集合もずれる。
   *
   * 並びは **古い案件優先**（`stuckSince ASC, purchaseId ASC`）で固定する。
   * 順序が安定していないとページを跨いだときに取りこぼす。
   */
  private static unresolvedCandidateSql(): string {
    return `SELECT id, MIN(stuck_since) AS stuck_since FROM (
      SELECT a.purchase_id AS id, a.started_at AS stuck_since
        FROM shop_external_delivery_attempts a
       WHERE a.state IN ${Shop.CLAIM_LIVE_STATES}
      UNION ALL
      SELECT p.id, p.purchased_at FROM shop_purchases p
       WHERE ${Shop.legacyUnknownSql()} AND NOT ${Shop.OPERATOR_DECIDED_SQL}
      UNION ALL
      SELECT p.id, p.purchased_at FROM shop_purchases p
       WHERE ${Shop.LEGACY_AUTO_OUTCOME_UNKNOWN_SQL} AND NOT ${Shop.OPERATOR_DECIDED_SQL}
    ) GROUP BY id`;
  }

  /**
   * 運営が**提供状況を確定させた**購入か。
   *
   * `delivered` / `no_effect` は「提供されたか分からない」を終わらせる判断なので、
   * そのあとで同じ購入を「不明」として出し直すのは事実と矛盾する。
   * `still_unknown` は決着していないので対象外。
   */
  private static readonly OPERATOR_DECIDED_SQL = `EXISTS (
    SELECT 1 FROM shop_operator_resolutions o
     WHERE o.purchase_id = p.id AND o.decision IN ('delivered','no_effect')
  )`;

  /**
   * 決着待ちの案件。**全件を辿れるようにページで返す。**
   *
   * 先頭数件を保留し続けると、それより後ろの案件へ永久に到達できない。
   * `offset` で先へ進める。
   */
  listUnresolvedCases(opts: { limit?: number; offset?: number } = {}): Array<{
    purchaseId: number;
    kind: UnresolvedCaseKind;
    userId: string;
    itemName: string;
    purchasedAt: number;
    deliveryKind: string | null;
    reason: string;
    stuckSince: number;
  }> {
    const limit = opts.limit ?? 25;
    const offset = Math.max(0, opts.offset ?? 0);
    const ids = this.db
      .prepare(`${Shop.unresolvedCandidateSql()} ORDER BY stuck_since ASC, id ASC LIMIT ? OFFSET ?`)
      .all(limit, offset) as Array<{ id: number; stuck_since: number }>;
    const out: Array<{
      purchaseId: number;
      kind: UnresolvedCaseKind;
      userId: string;
      itemName: string;
      purchasedAt: number;
      deliveryKind: string | null;
      reason: string;
      stuckSince: number;
    }> = [];
    for (const row of ids) {
      const quote = this.quoteOperatorResolution(row.id);
      if (quote.kind === null) continue;
      out.push({
        purchaseId: row.id,
        kind: quote.kind,
        userId: quote.userId,
        itemName: quote.itemName,
        purchasedAt: quote.purchasedAt,
        deliveryKind: quote.deliveryKind,
        reason: quote.reason,
        stuckSince: row.stuck_since,
      });
    }
    return out;
  }

  /** 決着待ちの件数。**一覧とまったく同じ集合定義で数える。** */
  countUnresolvedCases(): number {
    return this.db
      .prepare(`SELECT COUNT(*) FROM (${Shop.unresolvedCandidateSql()})`)
      .pluck()
      .get() as number;
  }

  // ── 返金の復旧（Phase H）──────────────────────────────────────────────────

  /**
   * 返金を**実際に試して失敗した**ことを残す。
   *
   * 「確認できないので試していない」(withheld) では呼ばない。ここに載るのは
   * 利用者の資産が戻っていない購入だけ。
   */
  recordRefundFailure(input: { purchaseId: number; amount: number; reason: string; detail?: string; actor: string }): void {
    this.db
      .prepare(
        `INSERT INTO shop_refund_failures (purchase_id, amount, reason, detail, actor_id, failed_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        input.purchaseId,
        input.amount,
        input.reason.slice(0, 200),
        (input.detail ?? "").slice(0, 500) || null,
        input.actor,
        now(),
      );
  }

  /**
   * 「副作用は無いと確認できた失敗」を、**切れ目なく**決着させる。
   *
   * claim の解放と返金（または義務の記録）を別々にすると、その隙に失効が入れる。
   * 失効してしまうと `refund()` は active からしか動けないので復旧不能になる——
   * 「金は返っていない・失効済み・キューにも出ない」が完成する。
   *
   * 1つの IMMEDIATE transaction に閉じるので、外から見える状態は
   * 「claimで守られている」か「返金済み」か「義務が立っている」のどれかしかない。
   */
  settleVerifiedFailure(input: {
    purchaseId: number;
    claimToken: string | null;
    reason: string;
    actor: string;
  }): { refunded: boolean; amount: number } | { failed: true; code: string | null; message: string } {
    const body = ():
      | { refunded: boolean; amount: number }
      | { failed: true; code: string | null; message: string } => {
      if (input.claimToken !== null) {
        const converged = this.releaseSettlementClaim(input);
        // 既に同じ結末へ収束済みなら、上から何も書かずにその事実を返す
        if (converged !== null) return converged;
      }
      this.markDeliveryFailed(input.purchaseId, input.reason, input.actor);
      return this.refundOrRecordFailure(input.purchaseId, input.reason, input.actor);
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /**
   * 決着が閉じようとしている claim が、**本当にいま生きているそれか**を確かめる。
   *
   * `refundClaimToken` を持ち越すようにした以上、その token は
   * 「この決着がどの claim を閉じるのか」という authority です。合っているかを見ずに
   * 続けると、古い呼び出し元が新しい状態へ配送失敗や返金を書き込めてしまう。
   * 「purchase が active だから続けてよい」は authority になりません——
   * その active は、**別の生きている claim が守っている** active かもしれない。
   *
   * 返り値
   *   - `null` … ちょうど1件の live claim を閉じた。決着を続けてよい
   *   - 決着結果 … 既に同じ結末へ収束済み。**何も書かずに**その事実を返す
   *   - throw … stale / 別の live claim / 説明できない状態。**1つも書かない**
   */
  private releaseSettlementClaim(input: {
    purchaseId: number;
    claimToken: string | null;
    reason: string;
    actor: string;
  }): { refunded: boolean; amount: number } | { failed: true; code: string | null; message: string } | null {
    const token = input.claimToken;
    if (token === null) return null;
    const attempt = this.db
      .prepare("SELECT state FROM shop_external_delivery_attempts WHERE purchase_id = ? AND attempt_token = ?")
      .get(input.purchaseId, token) as { state: string } | undefined;
    if (attempt === undefined) {
      // そんな claim は存在しない。取り違えなので、この呼び出しには何も書かせない
      throw new ShopError("ERR_CLAIM_UNKNOWN", { purchaseId: input.purchaseId });
    }

    if (attempt.state === "in_flight" || attempt.state === "uncertain") {
      const changed = this.db
        .prepare(
          `UPDATE shop_external_delivery_attempts
              SET state = 'released', updated_at = ?, detail = ?
            WHERE purchase_id = ? AND attempt_token = ? AND state IN ${Shop.CLAIM_LIVE_STATES}`,
        )
        .run(now(), "verified_no_effect", input.purchaseId, token).changes;
      // 同時に生きている claim は部分ユニーク索引で1つに縛られている。
      // それでも1件で無いなら、こちらの前提が崩れている＝書かずに止める
      if (changed !== 1) throw new ShopError("ERR_CLAIM_CONFLICT", { purchaseId: input.purchaseId });
      return null;
    }

    // ここから先、渡された token は既に閉じている。
    // **別の claim が生きているなら、この決着は過去のもの。** 触らせない
    const live = this.externalDeliveryClaim(input.purchaseId);
    if (live !== undefined) throw new ShopError("ERR_CLAIM_SUPERSEDED", { purchaseId: input.purchaseId });

    // 同じ結末へ既に収束しているなら、二重に書かずにその事実を返す
    const purchase = this.getPurchase(input.purchaseId);
    if (purchase === undefined || purchase === null) {
      throw new ShopError("ERR_CLAIM_STALE", { purchaseId: input.purchaseId });
    }
    if (purchase.status === "refunded") return { refunded: true, amount: purchase.paid_land ?? 0 };
    // **「収束したか」であって「商館が返せるか」ではない。** 代替支払の購入も、
    // 決着が義務を記録した時点で収束している。商館の予約語で見ると「収束していない」
    // ことになり、説明できない状態として弾いてしまう。
    if (this.refundSettlementPending(input.purchaseId)) {
      return { failed: true, code: "ERR_REFUND_PENDING", message: "refund obligation already recorded" };
    }
    // 閉じた claim なのに、決着もされていない。何が起きたか説明できないので書かない
    throw new ShopError("ERR_CLAIM_STALE", { purchaseId: input.purchaseId });
  }

  /**
   * 返金を試し、駄目なら**同じ transaction の中で**義務を記録する。
   *
   * 別々にすると、失敗してから記録するまでの隙に失効が割り込める。割り込まれると
   * purchase が expired になったあとで記録が積まれ、`refund()` は active からしか
   * 動けないので復旧不能になる。IMMEDIATE で囲って、その窓を無くす。
   *
   * 返金本体は入れ子 transaction（SAVEPOINT）なので、失敗しても記録だけが残る。
   */
  refundOrRecordFailure(
    purchaseId: number,
    reason: string,
    actor: string,
  ): { refunded: boolean; amount: number } | { failed: true; code: string | null; message: string } {
    const body = ():
      | { refunded: boolean; amount: number }
      | { failed: true; code: string | null; message: string } => {
      try {
        return this.refundWith(purchaseId, reason, actor, {});
      } catch (error) {
        const code = error instanceof ShopError ? error.code : null;
        // 提供済みだったので返さない、は「義務」ではない。記録しない。
        if (code === "ERR_ALREADY_DELIVERED") throw error;
        const purchase = this.getPurchase(purchaseId);
        this.recordRefundFailure({
          purchaseId,
          amount: purchase?.paid_land ?? 0,
          reason,
          detail: error instanceof Error ? error.message : String(error),
          actor,
        });
        return { failed: true, code, message: error instanceof Error ? error.message : String(error) };
      }
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /**
   * 返金に失敗した**履歴**があるか。`refundFailureSql()`（いま復旧キューに載るか）
   * とは別物で、こちらの方が広い——復旧キューから外れた購入も履歴は持ったまま残る。
   *
   * 配送やり直しキューはこちらを使う。**再配送してよいか**の判断なので、
   * 一度でも返金を試した購入は自動の再配送から外す方が安全側になる。
   * 意味が違うものに同じ名前を付けないために、別の関数として名前を持たせている。
   */
  private static refundFailureHistorySql(): string {
    return "EXISTS (SELECT 1 FROM shop_refund_failures f WHERE f.purchase_id = p.id)";
  }

  /**
   * **いま返金のやり直しキューに載る購入か。**
   *
   * これは復旧導線の述語であって、「利用者へ返す義務があるか」という普遍的な
   * financial truth ではない。`status = 'active'` を条件に含むので、
   * `expired` / `cancelled` になれば false へ落ちる——`refund()` が active からしか
   * 動けない以上、復旧キューへ載せても押せるボタンが無いからそうしている。
   *
   * したがって **false を「金銭的な義務が無い」と読んではいけない。**
   * この一覧から外れることと、金銭の決着が済んだことは別の事実で、
   * 前者を後者の証明に使うと未返金が黙って消える。金が戻ったと言えるのは
   * `status = 'refunded'` だけ。terminal へ落ちたまま失敗履歴だけが残っている購入は、
   * `safetySnapshot().contradictions` が監査対象として surface する。
   */
  /**
   * **商館の generic refund で返せる支払いか。**
   *
   * `paid_alt_*` を含む購入は generic refund の対象外——何をどこへ戻すべきかを
   * generic refund は知らないし、`paid_alt_*` は「実際にその資源が減った」証拠でもない。
   * `refundWith()` の拒否条件と**同じ定義**を、一覧・件数・画面でも使う。
   * `paid_land` の値から推測しない。
   */
  private static genericRefundSupportedSql(): string {
    return "(p.paid_alt_kind IS NULL AND p.paid_alt_amount IS NULL)";
  }

  /** 上と同じ判定を1行へ当てる */
  private static genericRefundSupportedRow(purchase: PurchaseRow): boolean {
    return purchase.paid_alt_kind === null && purchase.paid_alt_amount === null;
  }

  /**
   * **利用者への金銭的な決着がまだ終わっていない購入。**
   *
   * ここに当てはまる間は、**期限が来ても `expired` へ動かしてはいけない**。
   * `refund()` は active からしか動けないので、失効させると復旧導線そのものが消える。
   *
   * **「商館で返せるか」は条件にしない。** 代替支払のように商館の generic refund が
   * 扱えない購入でも、利用者から見れば「払ったのに何も受け取れていない」ことは同じで、
   * 決着が終わっていないという事実は変わらない。誰が処理するかと、
   * 決着が済んだかどうかは別の問いなので、authority も分ける。
   *
   * live claim は `expireIfDue()` 側の `delivery_in_flight` guard が先に止めるので、
   * ここでは見ない（claim が解ければそのままこちらの保護へ引き継がれる）。
   */
  private static refundSettlementPendingSql(): string {
    return `p.status = 'active'
      AND p.delivered_at IS NULL
      AND NOT ${Shop.DELIVERED_EVIDENCE_SQL}
      AND ${Shop.refundFailureHistorySql()}`;
  }

  /** 上と同じ判定を1件へ。失効の guard と候補選択が同じ意味を使う */
  private refundSettlementPending(purchaseId: number): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM shop_purchases p WHERE p.id = ? AND ${Shop.refundSettlementPendingSql()} LIMIT 1`)
        .get(purchaseId) !== undefined
    );
  }

  /**
   * **商館スタッフが「返金をやり直す」で終わらせられる購入。**
   *
   * 金銭の決着が未了（`refundSettlementPendingSql()`）のうち、
   *   - 生きている claim が無い … claim 中の返金は必ず `ERR_DELIVERY_IN_FLIGHT` で拒まれる
   *   - 商館の generic refund で戻せる支払い … 代替支払は必ず拒まれる
   * ものだけ。どちらも「押しても絶対に成功しないボタン」を作らないための条件で、
   * **決着が済んだかどうかとは関係がない**。外れたものは §handoff 側で人へ渡す。
   */
  private static refundFailureSql(): string {
    return `${Shop.refundSettlementPendingSql()}
      AND NOT ${Shop.externalDeliveryLiveSql()}
      AND ${Shop.genericRefundSupportedSql()}`;
  }

  /**
   * **返すべき金が残っているが、商館では返せない購入。**
   *
   * 代替支払を含むので generic refund が扱えない。商館スタッフに処理 authority が
   * 無いので「対応が必要な仕事」には数えないが、**黙って消さない**——誰も知らないまま
   * 利用者の資産が戻らない、が最悪の結末なので、運営判断が必要な案件として出す。
   *
   * 剥奪の `blocked` とは別物。あちらは「与えたか証明できないので取り消せない」、
   * こちらは「返す先の資源を generic refund が知らない」。
   */
  private static refundHandoffSql(): string {
    return `${Shop.refundSettlementPendingSql()}
      AND NOT ${Shop.externalDeliveryLiveSql()}
      AND NOT ${Shop.genericRefundSupportedSql()}`;
  }

  /** 商館では返せない返金案件。運営へ渡すために出す */
  listRefundHandoffs(opts: { limit?: number; offset?: number } = {}): Array<{
    purchaseId: number;
    userId: string;
    itemName: string;
    paidAltKind: string | null;
    paidAltAmount: number | null;
    paidLand: number | null;
    failedAt: number;
  }> {
    return this.db
      .prepare(
        `SELECT p.id AS purchaseId, p.user_id AS userId, i.name AS itemName,
                p.paid_alt_kind AS paidAltKind, p.paid_alt_amount AS paidAltAmount, p.paid_land AS paidLand,
                (SELECT MIN(f.failed_at) FROM shop_refund_failures f WHERE f.purchase_id = p.id) AS failedAt
           FROM shop_purchases p
           JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.refundHandoffSql()}
          ORDER BY failedAt ASC, p.id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(opts.limit ?? 25, Math.max(0, opts.offset ?? 0)) as Array<{
      purchaseId: number;
      userId: string;
      itemName: string;
      paidAltKind: string | null;
      paidAltAmount: number | null;
      paidLand: number | null;
      failedAt: number;
    }>;
  }

  countRefundHandoffs(): number {
    return this.db
      .prepare(`SELECT COUNT(*) FROM shop_purchases p WHERE ${Shop.refundHandoffSql()}`)
      .pluck()
      .get() as number;
  }

  /**
   * 上と**同じ判定**を1件へ当てる。一覧・件数・確認・確定で条件を分けない。
   *
   * 意味は「**いま商館が返金をやり直せるか**」。`false` は
   * 「返す義務が無い」でも「金銭の決着が済んだ」でもない——代替支払や claim 保持中も
   * `false` になる。失効を止めてよいかは `refundSettlementPending()` の方で判断する。
   */
  private refundFailureOpen(purchaseId: number): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM shop_purchases p WHERE p.id = ? AND ${Shop.refundFailureSql()} LIMIT 1`)
      .get(purchaseId);
    return row !== undefined;
  }

  listRefundFailures(opts: { limit?: number; offset?: number } = {}): Array<{
    purchaseId: number;
    userId: string;
    itemName: string;
    amount: number;
    reason: string;
    failedAt: number;
  }> {
    return this.db
      .prepare(
        `SELECT p.id AS purchaseId, p.user_id AS userId, i.name AS itemName,
                COALESCE(p.paid_land, 0) AS amount,
                (SELECT f.reason FROM shop_refund_failures f WHERE f.purchase_id = p.id ORDER BY f.failed_at DESC, f.id DESC LIMIT 1) AS reason,
                (SELECT MIN(f.failed_at) FROM shop_refund_failures f WHERE f.purchase_id = p.id) AS failedAt
           FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.refundFailureSql()}
          ORDER BY failedAt ASC, p.id ASC
          LIMIT ? OFFSET ?`,
      )
      .all(opts.limit ?? 25, Math.max(0, opts.offset ?? 0)) as Array<{
      purchaseId: number;
      userId: string;
      itemName: string;
      amount: number;
      reason: string;
      failedAt: number;
    }>;
  }

  countRefundFailures(): number {
    return this.db
      .prepare(`SELECT COUNT(*) FROM shop_purchases p WHERE ${Shop.refundFailureSql()}`)
      .pluck()
      .get() as number;
  }

  /** 返金やり直しの確認。`token` は確定時に作り直して照合する。 */
  quoteRefundRetry(purchaseId: number): {
    purchaseId: number;
    userId: string;
    itemName: string;
    amount: number;
    open: boolean;
    token: string;
  } {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId });
    const item = this.getItem(purchase.item_id);
    const open = this.refundFailureOpen(purchaseId);
    return {
      purchaseId,
      userId: purchase.user_id,
      itemName: item?.name ?? `#${purchase.item_id}`,
      amount: purchase.paid_land ?? 0,
      open,
      token: this.refundRetryToken(purchase, open),
    };
  }

  private countRefundFailuresFor(purchaseId: number): number {
    return this.db
      .prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id = ?")
      .pluck()
      .get(purchaseId) as number;
  }

  private refundRetryToken(purchase: PurchaseRow, open: boolean): string {
    const canonical = JSON.stringify([
      purchase.id,
      purchase.status,
      purchase.delivery_state,
      purchase.delivered_at,
      purchase.paid_land,
      open,
      this.countRefundFailuresFor(purchase.id),
    ]);
    return createHash("sha256").update(canonical, "utf8").digest().subarray(0, GENERIC_TERMS_TOKEN_BYTES).toString("base64url");
  }

  /**
   * 返金をやり直す。**既存の返金 authority をそのまま使う**ので二重返金にならない。
   *
   * 画面を開いたあとに状況が変わっていれば1つも書かずに止める。
   */
  retryRefund(input: { purchaseId: number; expectedToken: string; actor: string }): { refunded: boolean; amount: number } {
    const purchase = this.getPurchase(input.purchaseId);
    if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId: input.purchaseId });
    const open = this.refundFailureOpen(input.purchaseId);
    if (this.refundRetryToken(purchase, open) !== input.expectedToken) {
      throw new ShopError("ERR_RESOLUTION_STALE", { purchaseId: input.purchaseId });
    }
    if (!open) throw new ShopError("ERR_RESOLUTION_NOT_APPLICABLE", { purchaseId: input.purchaseId });

    // **返金の本体と、失敗の記録は別の transaction にする。**
    // 同じ transaction の中で記録してから throw すると、その記録ごと巻き戻る——
    // 「やり直して、また失敗した」という事実が durable に残らない。
    // 二重返金の防止は `refund()` 自身（status条件付きUPDATE）が持っているので、
    // ここで包み直す必要はない。
    try {
      return this.refund(input.purchaseId, "運営: 返金のやり直し", input.actor);
    } catch (error) {
      // **「返してはいけない／ここでは返せない」は、返金の失敗ではない。**
      //
      // `refundWith()` が投げる `ShopError` は**すべて事前条件の拒否**で、資産は1つも
      // 動いていない（提供済み・代替支払・配送中・結末が不明・既に終わっている・
      // 別経路が先に確定した）。それを `retry_failed` として積むと、追記専用の監査に
      // 「返金を試して失敗した」という嘘の証拠が残る。
      //
      // 逆に、台帳側の失敗（`LedgerError` や予期しない例外）は**本当に返せなかった**
      // ということなので、必ず記録する。`ShopError` かどうかが境界で、コードを
      // 個別に whitelist しているわけではない——`Ledger` は `ShopError` を投げない。
      if (error instanceof ShopError) throw error;
      this.recordRefundFailure({
        purchaseId: input.purchaseId,
        amount: purchase.paid_land ?? 0,
        reason: "retry_failed",
        detail: error instanceof Error ? error.message : String(error),
        actor: input.actor,
      });
      throw error;
    }
  }

  /** 始末の記録。無ければまだ始末していない。 */
  stockRestorationSettlement(purchaseId: number): StockRestorationSettlementRow | undefined {
    return this.db
      .prepare("SELECT * FROM shop_stock_restoration_settlements WHERE purchase_id = ?")
      .get(purchaseId) as StockRestorationSettlementRow | undefined;
  }

  /** 在庫を戻した記録。無ければ戻していない。 */
  stockRestoration(purchaseId: number): StockRestorationRow | undefined {
    return this.db
      .prepare("SELECT * FROM shop_purchase_stock_restorations WHERE purchase_id = ?")
      .get(purchaseId) as StockRestorationRow | undefined;
  }

  /**
   * 手動対応の完了を記録する。**人が外部作業を終えたあと、帳簿へ「終わった」と書くだけ。**
   * ここでロール付与などの副作用は起こさない（それは自動配送の状態機械の仕事）。
   *
   * 以前は無条件UPDATEだった。そのため、
   *   1. 一覧を開いて完了ボタンが作られる
   *   2. 別経路でその購入を返金する
   *   3. 古いボタンを押す
   * で `status='refunded'` かつ `delivery_state='delivered'` という矛盾を作れたし、
   * 存在しない購入IDでもUPDATE 0件のあとに `shop_delivered` を積めた。
   *
   * 判定と書き込みを同じ条件付きUPDATEに閉じ込め、**実際に遷移した1件だけ**が
   * eventを生む。`changes` を見てから記録するので、競合しても二重には積まれない。
   */
  completeManualDelivery(purchaseId: number, actor: string): ManualCompletionResult {
    const run = (): ManualCompletionResult => {
      const purchase = this.getPurchase(purchaseId);
      if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId });

      // 返金・取消・失効は、証拠の強さに関わらずここで確定する。
      if (purchase.status !== "active") return { completed: false, reason: "not_active" };

      const eligibility = this.manualCompletionEligibility(purchase);
      // **順序が効く。** 旧購入の `delivery_state='delivered'` は移行時の既定値でしか
      // ないことがあるので、先に already_delivered を返すと「分からない」が
      // 「対応済み」に化ける。分類を先に見て、legacy は legacy のまま返す。
      if (eligibility === "legacy_unknown") return { completed: false, reason: "legacy_unknown" };

      // 既に届いているものを二度配ったことにしない。
      if (this.hasDeliveredEvidence(purchase)) return { completed: false, reason: "already_delivered" };
      if (eligibility !== "eligible") return { completed: false, reason: eligibility };

      const ts = now();
      const changed = this.db
        .prepare(
          `UPDATE shop_purchases
              SET delivered_at = ?, delivery_state = 'delivered', delivery_error = NULL, delivery_updated_at = ?
            WHERE id = ?
              AND status = 'active'
              AND delivered_at IS NULL
              AND (delivery_state IS NULL OR delivery_state <> 'delivered')`,
        )
        .run(ts, ts, purchaseId);
      // 実際に遷移した時だけ記録する。0件なら誰かが先に確定させている。
      if (changed.changes !== 1) return { completed: false, reason: "already_delivered" };
      this.events.log("shop_delivered", { actor, payload: { purchaseId } });
      return { completed: true, reason: "completed" };
    };
    return this.db.inTransaction ? run() : this.db.transaction(run).immediate();
  }

  /**
   * この購入を「普通の手動対応」として完了してよいか。
   *
   * 判断の根拠は**購入時に凍結した事実**だけ。現在の商品設定は見ない。
   * - provenanceがある → その時 manual だったか、そして専用サービスでないか
   * - provenanceが無い（旧購入） → `legacy_unknown`。当時のことが分からないものを
   *   現在の商品設定から推測して「手動だった」ことにしない。
   */
  /**
   * 実際に提供したと証明できるか。
   *
   * 新しい購入（provenanceあり）なら `delivery_state='delivered'` を信頼してよい——
   * いまのwriterは `delivered_at` と同時にしか書かない。旧購入では信頼できない：
   * 移行の既定値が `delivered` で、スナップショットを持たない行は移行時点の商品設定
   * 次第でそのまま残るため、「配送に成功した」の一次証拠にならない。
   */
  private hasDeliveredEvidence(purchase: PurchaseRow): boolean {
    // **一覧SQLと同じ定義で判断する。** 渡された行の値を束ねて評価するので、
    // 呼び出し側が持っている行の内容と食い違うこともない。
    const row = this.db
      .prepare(Shop.DELIVERED_EVIDENCE_ROW_SQL)
      .get(purchase.id, purchase.delivered_at, purchase.delivery_state) as { hit: number };
    return row.hit === 1;
  }

  /**
   * 提供したかどうかを**証明できない**購入か。
   *
   * 購入時provenanceがあれば、その購入は今のコードが作ったものなので状態を信頼できる。
   * provenanceが無い旧購入は、配送スナップショットの有無にかかわらず結末が分からない
   * （スナップショットは方式の証拠であって成功の証拠ではない）。
   * 独立した配送記録があるならそれは `hasDeliveredEvidence` 側で拾われる。
   */
  private fulfillmentUnknown(purchase: PurchaseRow, opts: { operatorNoEffect?: boolean } = {}): boolean {
    if (this.fulfillmentProvenance(purchase.id)) return false;
    if (this.hasDeliveredEvidence(purchase)) return false;
    // **運営が「提供されていない」と確認した記録は、欠けている証拠の代わりになる。**
    // 推測ではなく、人が外部状態を見て残した事実なので、これを根拠に返金してよい。
    // いま決着中なら、その判断を直接受け取る（台帳へ書いてから読み直す循環を避ける）。
    if (opts.operatorNoEffect) return false;
    if (this.operatorConfirmedNoEffect(purchase.id)) return false;
    // 専用サービスの権利は、それぞれのフローが消費状態を持っている。
    if (this.isReevaluationPurchase(purchase.id)) return false;
    return true;
  }

  /**
   * 購入時autoは証明できるが、配送の結末が証明できない旧購入か。
   *
   * この状態では2つが同時に成り立つ。
   *   - 提供済みだと言えない（返金や期限付きアクセスの根拠にしない）
   *   - 自動で再実行してよいとも言えない（古いロール付与や期限延長を流し直さない）
   */
  isLegacyAutoOutcomeUnknown(purchaseId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT ${Shop.LEGACY_AUTO_OUTCOME_UNKNOWN_SQL} AS unknown
           FROM shop_purchases p WHERE p.id = ?`,
      )
      .get(purchaseId) as { unknown: number } | undefined;
    return row?.unknown === 1;
  }

  private manualCompletionEligibility(
    purchase: PurchaseRow,
  ): "eligible" | "not_manual" | "legacy_unknown" {
    const provenance = this.fulfillmentProvenance(purchase.id);
    if (!provenance) {
      // 購入時の記録が無くても、配送スナップショットがあれば**購入時autoだと証明できる**
      // （スナップショットは delivery='auto' のときしか作られない）。
      // 証明できるものを「不明」にしない。
      if (purchase.delivery_snapshot_json !== null) return "not_manual";
      // 専用サービスは実績（semantic evidence）で判別する。現在の商品IDでは決めない。
      if (this.isReevaluationPurchase(purchase.id)) return "not_manual";
      // 実際に提供した独立記録があるなら、旧購入でも「不明」ではない。
      if (this.hasDeliveredEvidence(purchase)) return "not_manual";
      return "legacy_unknown";
    }
    if (provenance.delivery_mode !== "manual") return "not_manual";
    // 専用サービス（再評価・評価延長・オリジナルロール・移行）は、それぞれの
    // 専用writerが完了条件を持っている。genericな「配送完了」で消費させない。
    if (provenance.source !== "storefront") return "not_manual";
    // 商品IDではなく実績で見る再評価判定（Phase B）はここでも維持する。
    if (this.isReevaluationPurchase(purchase.id)) return "not_manual";
    return "eligible";
  }

  // ---- 自動配送の状態機械 ----
  //
  // 配送は「課金の後始末」ではなく独立した工程として扱う。購入は一度きり、
  // 配送は成功するまで何度でも試せる、という非対称をここで表現する。

  /**
   * 配送を始めてよいか判定し、試行回数を進める。
   *
   * 既に `delivered` なら `already_delivered` を返す。**呼び出し側はここで打ち切る**ので、
   * 二度押し・再起動・再配送要求のいずれでも副作用が二度走らない。
   *
   * **返金・取消・失効した購入も打ち切る。** 課金の冪等は「同じ確認画面から二度課金しない」
   * までしか保証しない。返金まで済んだ購入の確認画面が後から再送されると、課金は起きないまま
   * 配送だけが走り、「返したのにサービスは提供した」が成立してしまう。status は配送の
   * 直前に、この1文の中で確かめる。
   */
  beginDelivery(purchaseId: number): {
    proceed: boolean;
    state: DeliveryState;
    attempts: number;
    reason?: "delivered" | "not_active";
    status?: PurchaseStatus;
  } {
    const begin = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT status, delivery_state, delivery_attempts FROM shop_purchases WHERE id = ?")
        .get(purchaseId) as
        | { status: PurchaseStatus; delivery_state: DeliveryState | null; delivery_attempts: number }
        | undefined;
      if (!row) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId });
      if (row.delivery_state === "delivered") {
        return {
          proceed: false,
          state: "delivered" as DeliveryState,
          attempts: row.delivery_attempts,
          reason: "delivered" as const,
          status: row.status,
        };
      }
      if (row.status !== "active") {
        return {
          proceed: false,
          state: row.delivery_state ?? ("pending" as DeliveryState),
          attempts: row.delivery_attempts,
          reason: "not_active" as const,
          status: row.status,
        };
      }
      const attempts = row.delivery_attempts + 1;
      this.db
        .prepare(
          "UPDATE shop_purchases SET delivery_state = 'pending', delivery_attempts = ?, delivery_updated_at = ? WHERE id = ?",
        )
        .run(attempts, now(), purchaseId);
      return { proceed: true, state: "pending" as DeliveryState, attempts };
    });
    return begin.immediate();
  }

  /**
   * 配送失敗を記録する。握り潰さずここへ落とすことで、再配送の対象として拾える。
   *
   * **確定した成功を上書きしない。** 同じ購入に複数の試行が並走したとき、
   * 先に成功した試行が `delivered` にした後で、古い試行の失敗が届くことがある。
   * それで `failed` へ戻すと、配送済みの購入が回収一覧へ再登場し、
   * 運営が二度目を撃つことになる。`delivered` なら何も書かない。
   */
  markDeliveryFailed(purchaseId: number, reason: string, actor: string): boolean {
    const changed = this.db
      .prepare(
        `UPDATE shop_purchases
            SET delivery_state = 'failed', delivery_error = ?, delivery_updated_at = ?
          WHERE id = ? AND COALESCE(delivery_state, 'pending') <> 'delivered'`,
      )
      .run(reason, now(), purchaseId).changes;
    if (changed !== 1) {
      // 既に成功が確定している。事実として記録だけ残し、状態は動かさない
      this.events.log("shop_delivery_failure_ignored", { actor, payload: { purchaseId, reason } });
      return false;
    }
    this.events.log("shop_delivery_failed", { actor, payload: { purchaseId, reason } });
    return true;
  }

  /**
   * 配送の副作用と完了マークを**同じトランザクションで**確定する。
   *
   * `extend_deadline` のように冪等でない配送があるので、効果とマークが割れると
   * 再試行で二重に効いてしまう。効果の書き込みを `effect` に渡してもらい、まとめて確定する。
   *
   * **有効な購入にしか配送済みの印を付けない。** 返金・取消・失効した購入が
   * `delivered` になると、「返したのに提供した」が帳簿の上で成立してしまう。
   */
  completeDeliveryWith(purchaseId: number, actor: string, effect: () => void): boolean {
    const run = this.db.transaction(() => {
      const row = this.db.prepare("SELECT status, delivery_state FROM shop_purchases WHERE id = ?").get(purchaseId) as
        | { status: PurchaseStatus; delivery_state: DeliveryState | null }
        | undefined;
      if (!row) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId });
      if (row.delivery_state === "delivered") return false; // 競合した二重実行。効果を走らせない
      if (row.status !== "active") return false; // 返金・取消・失効した購入。効果を走らせない
      effect();
      this.db
        .prepare(
          "UPDATE shop_purchases SET delivered_at = ?, delivery_state = 'delivered', delivery_error = NULL, delivery_updated_at = ? WHERE id = ?",
        )
        .run(now(), now(), purchaseId);
      return true;
    });
    const transitioned = run.immediate();
    // **実際に pending/failed → delivered へ動いたときだけ**記録する。
    // 競合した二重実行でも event を積むと、配送回数を事件録から数えられなくなる
    if (transitioned) this.events.log("shop_delivered", { actor, payload: { purchaseId } });
    return transitioned;
  }

  /** 完了マークだけ（効果が外部＝Discord側にあり、既にやり切った場合） */
  markDeliverySucceeded(purchaseId: number, actor: string): boolean {
    return this.completeDeliveryWith(purchaseId, actor, () => undefined);
  }

  /**
   * 人手のサービス提供（再評価面談など）として購入を消費する。
   *
   * **条件付き UPDATE で1行だけ動かす。** 確認してから書くまでの間に返金・取消・
   * 二重消費が挟まる余地を残さないため、`active` かつ未消費であることを
   * 書き込みと同じ文で確かめる。呼び出し側は `false` を「消費できなかった」として
   * トランザクションごと巻き戻す。
   */
  consumePurchaseForService(purchaseId: number, actor: string, meta: Record<string, unknown> = {}): boolean {
    const changed = this.db
      .prepare(
        `UPDATE shop_purchases
            SET delivered_at = ?, delivery_state = 'delivered', delivery_error = NULL, delivery_updated_at = ?
          WHERE id = ?
            AND status = 'active'
            AND delivered_at IS NULL
            AND COALESCE(delivery_state, 'pending') <> 'delivered'`,
      )
      .run(now(), now(), purchaseId).changes;
    if (changed !== 1) return false;
    this.events.log("shop_delivered", { actor, payload: { purchaseId, via: "service", ...meta } });
    return true;
  }

  /**
   * 人が対応しないと終わらない購入（運営の作業キュー）。
   *
   * 「**購入した時点で**手動対応だった購入のうち、まだ完了していないもの」。
   * 商品の現在設定では決めない。あとから商品を自動化しても、**それ以前の購入は
   * 人が終わらせるしかない**（当時の希望内容が残っていないため）ので、
   * 自動化のたびに過去の仕事がキューから消えるのは誤り。
   *
   * 専用サービス（再評価など）の除外は**purchase固有の証拠**で行う。現在の設定に
   * 入っている商品IDで除外すると、普通の商品を後から専用商品へ指定しただけで
   * 過去の普通の購入までキューから消えてしまう。
   */
  /**
   * 手動配送待ちキュー。再評価権は「配送物」ではなく面談で消費するサービス権なので、
   * **実績（semantic evidence）**で除外する。A→B差し替え後の未消費Aが
   * 「終わらせる方法が無い仕事」としてキューに居座らないように。
   * list と count は同じSQL断片を使う（表示だけ絞ってcountがズレる形にしない）。
   */
  listPendingManual(opts: { limit?: number } = {}): Array<PurchaseRow & { item_name: string }> {
    return this.db
      .prepare(
        `SELECT p.*, i.name AS item_name
           FROM shop_purchases p
           JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.pendingManualSql()}
          ORDER BY p.purchased_at
          LIMIT ?`,
      )
      .all(opts.limit ?? 25) as Array<PurchaseRow & { item_name: string }>;
  }

  /** 手動対応が残っている件数。表示の上限とは無関係に正確な数を返す */
  countPendingManual(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.pendingManualSql()}`,
      )
      .get() as { c: number };
    return row.c;
  }

  /**
   * 購入時の提供方式が分からない旧購入（互換バケット）。
   *
   * 旧購入は `delivery_snapshot_json` がNULLでも「手動配送だった」とは限らない。
   * snapshot列より前のauto購入もNULLになるからで、現在の商品設定から遡って
   * 決めることもできない。**だから普通の作業キューへは混ぜない。**
   * かといって黙って消すと、本当に人の対応が要る購入が見えなくなる。
   * 別枠で見せて、運営に提供状況を確かめてもらう。
   */
  listLegacyUnknownFulfillment(opts: { limit?: number } = {}): Array<PurchaseRow & { item_name: string }> {
    return this.db
      .prepare(
        `SELECT p.*, i.name AS item_name
           FROM shop_purchases p
           JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.legacyUnknownSql()}
          ORDER BY p.purchased_at
          LIMIT ?`,
      )
      .all(opts.limit ?? 25) as Array<PurchaseRow & { item_name: string }>;
  }

  /**
   * 購入時autoは分かるが、配送の結末が分からない旧購入。
   *
   * `listLegacyUnknownFulfillment()`（=購入時の**提供方式**が分からない）とは別の不明。
   * こちらは方式だけ分かっていて結末が分からない。どちらも
   *   - 提供済みとは言えない
   *   - 自動で流し直してもいけない
   * ので、運営に見せて外部で確認してもらう。ワンクリックの操作は用意しない。
   */
  listLegacyAutoOutcomeUnknown(opts: { limit?: number } = {}): Array<PurchaseRow & { item_name: string }> {
    return this.db
      .prepare(
        `SELECT p.*, i.name AS item_name
           FROM shop_purchases p
           JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.LEGACY_AUTO_OUTCOME_UNKNOWN_SQL}
          ORDER BY p.purchased_at
          LIMIT ?`,
      )
      .all(opts.limit ?? 25) as Array<PurchaseRow & { item_name: string }>;
  }

  /** 上と同じ判定の件数（上限なし） */
  countLegacyAutoOutcomeUnknown(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.LEGACY_AUTO_OUTCOME_UNKNOWN_SQL}`,
      )
      .get() as { c: number };
    return row.c;
  }

  /** 互換バケットの件数（`listLegacyUnknownFulfillment` と同じ判定・上限なし） */
  countLegacyUnknownFulfillment(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.legacyUnknownSql()}`,
      )
      .get() as { c: number };
    return row.c;
  }

  /** 未完了の自動配送の件数（`listUndeliveredAuto` と同じ判定・上限なし） */
  countUndeliveredAuto(): number {
    return this.listUndeliveredAuto(Number.MAX_SAFE_INTEGER).length;
  }

  /**
   * 未完了の自動配送（運営の回収導線用）。
   *
   * **対象かどうかは購入時スナップショットで決める。** 商品の現在設定を根拠にすると、
   * 買った後に商品を自動配送へ変えただけで過去の購入が再配送候補になってしまう。
   * スナップショットを持たない旧購入（手動配送・列の導入前）はここに出さない。
   *
   * `kinds` を指定すると、その配送種別だけを返す。**絞り込みは `limit` より先に効く。**
   * 呼び出し側が全種別を取ってから種別で filter すると、他種別の失敗が上限ぶん溜まった
   * だけで対象が1件も残らず、その種別の収束が永久に止まる。
   */
  /**
   * **配送のやり直しキューへ載る条件のうち、決着で動かない部分。**
   *
   * `delivery_state` と live claim は決着（`no_effect`）で必ず動くので、ここには
   * 入れない。「いま出ているか」ではなく「**この購入は再配送してよい種類か**」を表す。
   *
   * 「もう一度配る」を画面に出してよいかの判断は、この定義をそのまま使う——
   * `delivery_kind` が読めるかどうかで決めると、購入時の provenance が無い旧購入に
   * 対して**実行されない約束**を出すことになる（決着させても
   * `LEGACY_AUTO_OUTCOME_UNKNOWN_SQL` が真のままで、キューへ載らない）。
   */
  private static autoRetryBaseSql(): string {
    return `p.status = 'active'
      AND p.delivery_snapshot_json IS NOT NULL
      -- 「再実行してよいか」は「配送したか」とは別の判断。結末が証明できない
      -- 旧購入は、状態がどうであれ自動では流し直さない。
      AND NOT EXISTS (
        SELECT 1 FROM shop_delivery_replay_suppressions r WHERE r.purchase_id = p.id
      )
      -- **返金の復旧待ちを配送再試行へ混ぜない。** 返金しようとして失敗した購入は
      -- 「もう一度配る」ではなく「返金をやり直す」案件。別のキューで扱う。
      -- ここは**履歴**の方を使う（再配送してよいかの判断なので、一度でも返金を
      -- 試した購入は自動の再配送から外す方が安全側）。
      AND NOT ${Shop.refundFailureHistorySql()}
      AND NOT ${Shop.LEGACY_AUTO_OUTCOME_UNKNOWN_SQL}`;
  }

  /**
   * この購入を「もう一度配る」と言ってよいか。
   *
   * **決着した後に、実際に配送やり直しキューへ載るか**で決める。載らないなら、
   * 画面にその選択肢を出してはいけない。決着だけ進んで再配送されず、確認キューからも
   * 消える——つまり未処理のまま全部の仕事一覧から静かに消える、が起きる。
   *
   * live claim と `delivery_state` は決着で解ける／変わるので条件に入れない。
   * 種別の判定は一覧と同じく購入時スナップショットだけを見る（現在の商品設定から
   * 過去の配送内容を推測しない）。
   */
  deliveryRetryEligible(purchaseId: number): boolean {
    const row = this.db
      .prepare(`SELECT p.delivery_snapshot_json AS snap FROM shop_purchases p WHERE p.id = ? AND ${Shop.autoRetryBaseSql()}`)
      .get(purchaseId) as { snap: string | null } | undefined;
    if (row === undefined) return false;
    const snapshot = parseDeliverySnapshot(row.snap);
    // 撤回された種別は運営にも再配送させない（面談を経ない復帰を作らない）
    return snapshot !== null && AUTO_DELIVERABLE_KINDS.has(snapshot.delivery_kind);
  }

  listUndeliveredAuto(
    limit = 50,
    opts: { kinds?: readonly string[] } = {},
  ): Array<PurchaseRow & { item_name: string }> {
    const rows = this.db
      .prepare(
        `SELECT p.*, i.name AS item_name
           FROM shop_purchases p
           JOIN shop_items i ON i.id = p.item_id
          WHERE ${Shop.autoRetryBaseSql()}
            AND COALESCE(p.delivery_state, 'pending') IN ('pending','failed')
            -- **確認待ちも混ぜない。** 外部へ投げたまま結果が分からない購入は、
            -- そもそも重ねて配れない（claimが塞ぐ）。両方のキューに出すと
            -- 「対応が必要」の件数が同じ購入を二重に数えることになる。
            AND NOT ${Shop.externalDeliveryLiveSql()}
          ORDER BY p.purchased_at DESC`,
      )
      .all() as Array<PurchaseRow & { item_name: string }>;
    return rows
      .filter((p) => {
        const snapshot = parseDeliverySnapshot(p.delivery_snapshot_json);
        // 撤回された種別は運営にも再配送させない（面談を経ない復帰を作らない）
        if (snapshot === null || !AUTO_DELIVERABLE_KINDS.has(snapshot.delivery_kind)) return false;
        return opts.kinds ? opts.kinds.includes(snapshot.delivery_kind) : true;
      })
      .slice(0, limit);
  }

  /**
   * 期限内の汎用アクセス契約。購入時スナップショットを正本にし、スナップショット導入前の
   * delivered契約だけは、現在も同じ期限付きadd_role商品である場合に限り互換維持する。
   */
  listActiveTimedAccess(userId?: string): TimedAccessGrant[] {
    const params: unknown[] = [now()];
    let userClause = "";
    if (userId !== undefined) {
      userClause = " AND user_id = ?";
      params.push(userId);
    }
    const purchases = this.db
      .prepare(
        `SELECT * FROM shop_purchases
          WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at > ?${userClause}
          ORDER BY id`,
      )
      .all(...params) as PurchaseRow[];

    const grants: TimedAccessGrant[] = [];
    for (const purchase of purchases) {
      const item = this.getItem(purchase.item_id);
      if (!item) continue;
      const current = timedAccessConfig(item);
      const snapshot = parseDeliverySnapshot(purchase.delivery_snapshot_json);
      let roleId: string | null = null;
      let channelId: string | null = null;
      if (snapshot?.delivery_kind === "add_role") {
        roleId = typeof snapshot.delivery_data.role_id === "string"
          ? snapshot.delivery_data.role_id.trim()
          : null;
        channelId = typeof snapshot.delivery_data.channel_id === "string" && snapshot.delivery_data.channel_id.trim()
          ? snapshot.delivery_data.channel_id.trim()
          : null;
        if (!channelId && current?.roleId === roleId) channelId = current.channelId;
      } else if (
        purchase.delivery_snapshot_json === null &&
        current &&
        this.hasDeliveredEvidence(purchase)
      ) {
        // スナップショット導入前の購入。**実際に配送した証拠があるときだけ**現在の
        // ロール/チャンネルで互換維持する。`delivery_state='delivered'` 単独では
        // 移行時の推定でしかなく、それを根拠にロールを配り直すことはできない。
        roleId = current.roleId;
        channelId = current.channelId;
      }
      if (roleId) grants.push({ purchase, item, roleId, channelId });
    }
    return grants;
  }

  activeTimedAccessGrantsRole(userId: string, roleId: string): boolean {
    return this.listActiveTimedAccess(userId).some((grant) => grant.roleId === roleId);
  }

  hasTimedAccessLegacyMigration(migrationKey: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM shop_timed_access_legacy_runs WHERE migration_key = ?")
      .get(migrationKey.trim());
  }

  /**
   * Discordでroleを持つ一方、同商品のactive契約が無い利用者だけを列挙する。
   * これは明示的な一回限り移行の事前確認用で、通常起動・購入処理からは呼ばない。
   */
  planTimedAccessLegacyMigration(
    expectations: readonly TimedAccessLegacyMigrationExpectation[],
  ): TimedAccessLegacyMigrationPlan {
    const seenItems = new Set<number>();
    const items: TimedAccessLegacyMigrationPlanItem[] = [];
    for (const expectation of [...expectations].sort((a, b) => a.itemId - b.itemId)) {
      if (
        seenItems.has(expectation.itemId) ||
        !Number.isSafeInteger(expectation.itemId) ||
        expectation.itemId <= 0 ||
        !Number.isSafeInteger(expectation.expectedCount) ||
        expectation.expectedCount < 0
      ) {
        throw new ShopError("ERR_TIMED_ACCESS_LEGACY_CONFIG", { itemId: expectation.itemId });
      }
      seenItems.add(expectation.itemId);
      const item = this.getItem(expectation.itemId);
      const access = item ? timedAccessConfig(item) : null;
      if (!item || !access || access.roleId !== expectation.roleId || termDays(item) !== DEFAULT_TERM_DAYS) {
        throw new ShopError("ERR_TIMED_ACCESS_LEGACY_CONFIG", {
          itemId: expectation.itemId,
          reason: !item
            ? "item_missing"
            : !access
              ? "timed_access_config_invalid"
              : access.roleId !== expectation.roleId
                ? "role_changed_after_fetch"
                : "duration_not_30_days",
        });
      }
      const active = new Set(
        (this.db
          .prepare("SELECT user_id FROM shop_purchases WHERE item_id = ? AND status = 'active'")
          .all(item.id) as Array<{ user_id: string }>).map((row) => row.user_id),
      );
      const candidateUserIds = [...new Set(expectation.roleHolderIds.map((id) => id.trim()).filter(Boolean))]
        .filter((userId) => !active.has(userId))
        .sort();
      items.push({
        itemId: item.id,
        roleId: access.roleId,
        expectedCount: expectation.expectedCount,
        actualCount: candidateUserIds.length,
        candidateUserIds,
      });
    }
    const expectedTotal = items.reduce((sum, item) => sum + item.expectedCount, 0);
    const actualTotal = items.reduce((sum, item) => sum + item.actualCount, 0);
    return {
      items,
      expectedTotal,
      actualTotal,
      matchesExpected: items.every((item) => item.expectedCount === item.actualCount),
    };
  }

  /**
   * role-only利用者を無償30日契約へ一度だけ取り込む。
   * 件数照合・購入行・専用台帳・audit eventを同じIMMEDIATE transactionで確定する。
   */
  migrateTimedAccessLegacy(input: {
    migrationKey: string;
    expectations: readonly TimedAccessLegacyMigrationExpectation[];
    actor: string;
    reason: string;
    startedAt?: number;
  }): TimedAccessLegacyMigrationResult {
    const migrationKey = input.migrationKey.trim();
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    const startedAt = input.startedAt ?? now();
    if (!migrationKey || !actor || !reason || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
      throw new ShopError("ERR_TIMED_ACCESS_LEGACY_CONFIG", { migrationKey, actor, startedAt });
    }
    const planKey = JSON.stringify(
      [...input.expectations]
        .map(({ itemId, roleId, expectedCount }) => ({ itemId, roleId, expectedCount }))
        .sort((a, b) => a.itemId - b.itemId),
    );
    const body = (): TimedAccessLegacyMigrationResult => {
      const existingRun = this.db
        .prepare("SELECT plan_json FROM shop_timed_access_legacy_runs WHERE migration_key = ?")
        .get(migrationKey) as { plan_json: string } | undefined;
      if (existingRun) {
        if (existingRun.plan_json !== planKey) {
          throw new ShopError("ERR_TIMED_ACCESS_LEGACY_CONFLICT", { migrationKey });
        }
        const imports = this.db
          .prepare("SELECT * FROM shop_timed_access_legacy_imports WHERE migration_key = ? ORDER BY item_id, user_id")
          .all(migrationKey) as TimedAccessLegacyImportRow[];
        const plan: TimedAccessLegacyMigrationPlan = {
          items: [...input.expectations]
            .sort((a, b) => a.itemId - b.itemId)
            .map((expectation) => {
              const rows = imports.filter((row) => row.item_id === expectation.itemId);
              return {
                itemId: expectation.itemId,
                roleId: rows[0]?.role_id ?? "",
                expectedCount: expectation.expectedCount,
                actualCount: rows.length,
                candidateUserIds: rows.map((row) => row.user_id),
              };
            }),
          expectedTotal: input.expectations.reduce((sum, item) => sum + item.expectedCount, 0),
          actualTotal: imports.length,
          matchesExpected: true,
        };
        return { alreadyApplied: true, plan, imports };
      }

      // Discord取得後にactive契約が増えた場合も、ここで再計算して件数不一致として全件止める。
      const plan = this.planTimedAccessLegacyMigration(input.expectations);
      if (!plan.matchesExpected) {
        throw new ShopError("ERR_TIMED_ACCESS_LEGACY_COUNT", {
          expected: plan.items.map((item) => ({ itemId: item.itemId, count: item.expectedCount })),
          actual: plan.items.map((item) => ({ itemId: item.itemId, count: item.actualCount })),
        });
      }
      this.db
        .prepare(
          `INSERT INTO shop_timed_access_legacy_runs
             (migration_key,plan_json,actor_id,reason,started_at,completed_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(migrationKey, planKey, actor, reason, startedAt, startedAt);
      const insertPurchase = this.db.prepare(
        `INSERT INTO shop_purchases
           (item_id,user_id,purchased_at,expires_at,paid_land,paid_alt_kind,paid_alt_amount,status,
            delivered_at,auto_renew,delivery_snapshot_json,request_json,delivery_state,
            delivery_attempts,delivery_error,delivery_updated_at)
         VALUES (?,?,?, ?,NULL,NULL,NULL,'active', ?,0,?,?,'delivered',0,NULL,?)`,
      );
      const insertImport = this.db.prepare(
        `INSERT INTO shop_timed_access_legacy_imports
           (purchase_id,migration_key,item_id,user_id,role_id,started_at,expires_at,reason,actor_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const planned of plan.items) {
        const item = this.getItem(planned.itemId)!;
        const expiresAt = startedAt + DEFAULT_TERM_DAYS * DAY;
        const snapshot = JSON.stringify({
          delivery: "auto",
          delivery_kind: "add_role",
          delivery_data: item.delivery_data,
          captured_at: startedAt,
        });
        for (const userId of planned.candidateUserIds) {
          const request = JSON.stringify({
            source: "legacy_role_only_import",
            migrationKey,
            roleId: planned.roleId,
            startedAt,
            expiresAt,
            reason,
          });
          const purchaseInfo = insertPurchase.run(
            item.id,
            userId,
            startedAt,
            expiresAt,
            startedAt,
            snapshot,
            request,
            startedAt,
          );
          const purchaseId = Number(purchaseInfo.lastInsertRowid);
          this.recordTitlePurchaseProvenance(this.getPurchase(purchaseId)!, "legacy_timed_access_import");
          // 移行importは既存のロール保有を購入行として写しているだけで、在庫を1つも
          // 消費していない。勝手に stock_consumed=1 を作らない（返金で在庫が湧く）。
          this.recordFulfillmentProvenance(this.getPurchase(purchaseId)!, {
            deliveryMode: "auto",
            stockConsumed: false,
            source: "legacy_timed_access_import",
          });
          this.recordRoleGrantProvenance(this.getPurchase(purchaseId)!, item, "legacy_timed_access_import");
          insertImport.run(
            purchaseId,
            migrationKey,
            item.id,
            userId,
            planned.roleId,
            startedAt,
            expiresAt,
            reason,
            actor,
            startedAt,
          );
          const importedPurchase = this.getPurchase(purchaseId)!;
          this.enqueueShopPurchaseLog(importedPurchase, item, {
            workType: "legacy_timed_access_import",
            source: "legacy_timed_access_import",
            migrationKey,
          });
          this.events.log("shop_timed_access_legacy_imported", {
            actor,
            target: userId,
            payload: {
              userId,
              itemId: item.id,
              purchaseId,
              roleId: planned.roleId,
              startedAt,
              expiresAt,
              reason,
              migrationKey,
            },
          });
        }
      }
      this.events.log("shop_timed_access_legacy_migration_completed", {
        actor,
        payload: { migrationKey, startedAt, reason, items: plan.items, imported: plan.actualTotal },
      });
      const imports = this.db
        .prepare("SELECT * FROM shop_timed_access_legacy_imports WHERE migration_key = ? ORDER BY item_id, user_id")
        .all(migrationKey) as TimedAccessLegacyImportRow[];
      return { alreadyApplied: false, plan, imports };
    };
    return this.db.inTransaction ? body() : this.db.transaction(body).immediate();
  }

  /**
   * 期限が来た購入を失効させる。**課金とは完全に独立している。**
   *
   * 以前は失効判定が月次一括請求の中にしか無かった。つまり「請求を止めると
   * 期限切れが永久に来ない」構造で、自動更新をやめた瞬間に権利が剥がれなくなる。
   * 失効は「期限を過ぎた」という事実だけで決まるので、請求から切り離して
   * 短い周期で巡回させ、取りこぼしても次の周回で拾えるようにする。
   *
   * 1件ずつトランザクションで確定させる。status の更新と剥奪キューへの登録は
   * 必ず一緒に成立させ、途中で失敗した1件が他の件を巻き添えにしないため。
   */
  /**
   * まもなく期限が切れる契約（既定は3日以内）。
   *
   * 自動更新をやめた以上、**黙って権利が消える**のが一番の不利益になる。
   * 「残りが少ない」ことだけ知らせて、延長するかは本人に委ねる。
   */
  expiringSoon(withinDays = 3): PurchaseRow[] {
    const ts = now();
    return this.db
      .prepare(
        `SELECT * FROM shop_purchases
          WHERE status = 'active' AND expires_at IS NOT NULL
            AND expires_at > ? AND expires_at <= ?
          ORDER BY expires_at`,
      )
      .all(ts, ts + withinDays * DAY) as PurchaseRow[];
  }

  expireOverdue(actor: string, limit = 200): { expired: PurchaseRow[]; failed: Array<{ purchaseId: number; error: string }> } {
    const ts = now();
    // **動かせない行で LIMIT を埋めない。**
    //
    // `refund_pending` や配送中の行は、運営が片付けるまで overdue のまま残り続ける。
    // それを候補に含めたまま LIMIT を掛けると、古い順に並んだ「絶対に失効しない行」が
    // 毎回枠を占有し、その後ろの普通の期限切れへ永久に到達できない。
    // ここで先に外してから LIMIT を掛ける。**最終判断は `expireIfDue()` のまま。**
    //
    // 除外条件は `expireIfDue()` が使うものと**同じ関数から作る**。
    // 「返金失敗の履歴が1件でもあるか」を手書きすると意味がズレる——提供が後から
    // 成功して復旧キューから外れた購入まで永久に候補から外れ、失効も剥奪判断も
    // 進まなくなる。
    // **商館の述語（`refundFailureSql()`）ではなく金銭決着の方**を使う。前者は
    // 「商館が返せるか」なので、代替支払の購入が候補に入って失効してしまう。
    const due = this.db
      .prepare(
        `SELECT p.id FROM shop_purchases p
          WHERE p.status = 'active' AND p.expires_at IS NOT NULL AND p.expires_at <= ?
            AND NOT ${Shop.externalDeliveryLiveSql()}
            AND NOT (${Shop.refundSettlementPendingSql()})
          ORDER BY p.expires_at
          LIMIT ?`,
      )
      .all(ts, limit) as Array<{ id: number }>;
    const expired: PurchaseRow[] = [];
    const failed: Array<{ purchaseId: number; error: string }> = [];
    for (const row of due) {
      try {
        // 一覧を取ってから実行するまでの間に返金・取消が入りうる。**遷移そのものが
        // 期限と状態を確かめる**ので、ここでは結果を受け取るだけでよい。
        const outcome = this.expireIfDue(row.id, actor, ts);
        if (!outcome.expired) continue;
        const purchase = this.getPurchase(row.id);
        if (purchase) expired.push(purchase);
      } catch (error) {
        // **1件の失敗で巡回を止めない。** 止めると、失敗した1件より後ろに並んでいる
        // 期限切れが永久に処理されない（status='active' のままなので次回も先頭に来る）。
        // その件は記録だけ残し、次の巡回で再試行する
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ purchaseId: row.id, error: message });
        this.events.log("shop_expire_failed", { actor, payload: { purchaseId: row.id, error: message.slice(0, 500) } });
      }
    }
    return { expired, failed };
  }

  /**
   * 期限が来ていれば失効させる。**判定と書き込みを同じ条件付きUPDATEに閉じ込める。**
   *
   * 以前は「期限切れ一覧を先に取り、後から `UPDATE ... WHERE id=?`」だった。その隙に
   * 返金がcommitすると、`refunded` を `expired` で上書きできてしまう（返金した購入が
   * 「期限切れ」として記録され、剥奪キューにも載る）。
   * `changes === 1` のときだけ event と剥奪判断を確定する。
   */
  /**
   * 購入1件の「いま何がどうなっているか」を、**1回で**説明する。
   *
   * ここは read model であって authority ではない。どの欄も既存の判定をそのまま
   * 呼んだ結果で、独自の解釈を挟まない。画面・運営・巡回が別々の理屈で状態を
   * 説明し始めると、「なぜ返金できないのか」に3通りの答えが出てしまう。
   */
  safetySnapshot(purchaseId: number): ShopSafetySnapshot | null {
    // **9本のSELECTを1つのsnapshotから読む。**
    //
    // 別接続が途中でcommitすると、「古いpurchase行＋新しいclaim/返金/決着」という
    // **実際には一度も存在しなかった状態**を返せてしまう。ここは運営と監査へ事実を
    // 説明する土台なので、資産を動かさなくても不正確な説明は許されない。
    //
    // DEFERRED で始めるので書き込みロックは取らない（読み取りだけのため）。
    // 既に transaction の中なら、その snapshot をそのまま使う。
    const body = (): ShopSafetySnapshot | null => this.safetySnapshotUnlocked(purchaseId);
    return this.db.inTransaction ? body() : this.db.transaction(body)();
  }

  private safetySnapshotUnlocked(purchaseId: number): ShopSafetySnapshot | null {
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) return null;

    const claimRow = this.externalDeliveryClaim(purchaseId);
    const evidence = this.hasDeliveredEvidence(purchase);
    const recoveryOpen = this.refundFailureOpen(purchaseId);
    const settlementPending = this.refundSettlementPending(purchaseId);
    const operationsHandoff =
      this.db
        .prepare(`SELECT 1 FROM shop_purchases p WHERE p.id = ? AND ${Shop.refundHandoffSql()} LIMIT 1`)
        .get(purchaseId) !== undefined;
    const failureHistory = this.db
      .prepare("SELECT COUNT(*) FROM shop_refund_failures WHERE purchase_id = ?")
      .pluck()
      .get(purchaseId) as number;
    const decided = this.db
      .prepare(
        `SELECT decision FROM shop_operator_resolutions
          WHERE purchase_id = ? AND decision IN ('delivered','no_effect')
          ORDER BY id DESC LIMIT 1`,
      )
      .pluck()
      .get(purchaseId) as "delivered" | "no_effect" | undefined;
    const unresolved = this.db
      .prepare(`SELECT 1 FROM (${Shop.unresolvedCandidateSql()}) WHERE id = ? LIMIT 1`)
      .get(purchaseId) !== undefined;
    const revocation = this.db
      .prepare("SELECT status, role_id, last_error FROM shop_role_revocations WHERE purchase_id = ?")
      .get(purchaseId) as { status: "pending" | "done" | "failed"; role_id: string | null; last_error: string | null } | undefined;

    const due = purchase.expires_at !== null && purchase.expires_at <= now();
    const blockedBy = this.expiryBlockedBy(purchaseId);

    const contradictions: string[] = [];
    if (purchase.status !== "active" && claimRow !== undefined) {
      // 終わった購入に生きた場所取りが残っている。次の配送も返金も塞がれ続ける
      contradictions.push(`terminal_purchase_with_live_claim:${purchase.status}`);
    }
    if ((purchase.status === "expired" || purchase.status === "cancelled") && failureHistory > 0 && !evidence) {
      // **終わった購入に、返金を試して失敗した記録だけが残っている。**
      //
      // `refunded` ではないので「返った」とは言えない。かといって履歴だけから
      // 「未返金が確定した」とも言えない（別経路で戻した可能性を否定できない）。
      // 言えるのは **金の決着を人が監査する必要がある** ということだけ。
      // `refund()` は active からしか動けないので、通常の復旧導線には載らない。
      contradictions.push(`terminal_with_refund_failure_history_without_delivery_evidence:${purchase.status}`);
    }
    if (evidence && decided === "no_effect") {
      // 「提供済み」の証拠と「提供されていない」という人の判断が同時に立っている
      contradictions.push("delivered_evidence_vs_operator_no_effect");
    }
    if (evidence && (recoveryOpen || settlementPending || operationsHandoff)) {
      // 正本の定義上ありえない組み合わせ。出たら定義がどこかでズレている
      contradictions.push("delivered_evidence_vs_open_refund_recovery");
    }
    if (recoveryOpen && operationsHandoff) {
      // 商館の仕事と運営への引き継ぎは排他。両方に出るなら述語がズレている
      contradictions.push("refund_recovery_and_handoff_both_open");
    }
    if ((recoveryOpen || operationsHandoff) && !settlementPending) {
      // どちらも settlement pending の派生なので、親が false なのはありえない
      contradictions.push("refund_actionable_without_settlement_pending");
    }
    if (evidence && unresolved) {
      contradictions.push("delivered_evidence_vs_unresolved_case");
    }
    if (revocation?.status === "pending" && purchase.status === "active") {
      // 有効な契約からロールを剥がそうとしている
      contradictions.push("active_purchase_with_pending_revocation");
    }

    return {
      purchaseId,
      contract: {
        status: purchase.status,
        userId: purchase.user_id,
        itemId: purchase.item_id,
        paidLand: purchase.paid_land,
        paidAltKind: purchase.paid_alt_kind,
        expiresAt: purchase.expires_at,
      },
      fulfillment: {
        state: purchase.delivery_state ?? null,
        deliveredAt: purchase.delivered_at,
        evidence,
        provenance: this.fulfillmentProvenance(purchaseId) !== undefined,
        roleGrant: this.roleGrantTarget(purchase),
      },
      externalClaim:
        claimRow === undefined
          ? null
          : {
              token: claimRow.attempt_token,
              state: claimRow.state as "in_flight" | "uncertain",
              startedAt: claimRow.started_at,
            },
      refund: { failureHistory, settlementPending, recoveryOpen, operationsHandoff },
      operatorCase: { unresolved, decided: decided ?? null },
      expiry: { expiresAt: purchase.expires_at, due, blockedBy },
      revocation: {
        status: revocation?.status ?? null,
        roleId: revocation?.role_id ?? null,
        lastError: revocation?.last_error ?? null,
      },
      contradictions,
    };
  }

  /**
   * 期限が来ていても**失効させてはいけない理由**。無ければ `null`。
   *
   * 説明（snapshot）と実際の判断（`expireIfDue()`）で同じ関数を使う。別々に書くと、
   * 画面が「返金の復旧待ちだから止まっています」と説明しているのに巡回は失効させる、
   * のような食い違いが起きる。
   *
   * - `delivery_in_flight` … いま外部へ投げている最中／結果が分からない。ここで
   *   expired へ落とすと「失効済みなのにロールだけ付く」が成立する
   * - `refund_pending` … 金銭の決着がまだ終わっていない。**期限より先に金の決着を
   *   終わらせる。** `refund()` は active からしか動けないので、ここで expired に
   *   すると復旧導線そのものが消える（義務が消えるのではなく、押せるボタンが無くなる）
   *
   * **見るのは「商館で返せるか」ではなく「決着が済んだか」。** 商館の
   * `refundFailureOpen()` を使うと、代替支払のように商館では返せない購入が
   * 「商館の仕事ではない」という理由だけで失効し、運営への引き継ぎ一覧
   * （`status='active'` を要求する）からも消える——未返金のまま導線が全部消える。
   */
  expiryBlockedBy(purchaseId: number): ExpiryBlockedReason | null {
    if (this.externalDeliveryInFlight(purchaseId)) return "delivery_in_flight";
    if (this.refundSettlementPending(purchaseId)) return "refund_pending";
    return null;
  }

  expireIfDue(
    purchaseId: number,
    actor: string,
    observedNow: number = now(),
  ): {
    expired: boolean;
    reason: "expired" | "not_active" | "not_due" | "not_found" | "delivery_in_flight" | "refund_pending";
  } {
    const run = (): {
      expired: boolean;
      reason: "expired" | "not_active" | "not_due" | "not_found" | "delivery_in_flight" | "refund_pending";
    } => {
      const before = this.getPurchase(purchaseId);
      if (!before) return { expired: false, reason: "not_found" };
      const blocked = this.expiryBlockedBy(purchaseId);
      if (blocked !== null) return { expired: false, reason: blocked };

      const changed = this.db
        .prepare(
          `UPDATE shop_purchases SET status = 'expired'
            WHERE id = ?
              AND status = 'active'
              AND expires_at IS NOT NULL
              AND expires_at <= ?`,
        )
        .run(purchaseId, observedNow).changes;
      if (changed !== 1) {
        // 何も動いていない。なぜ動かなかったかを、いまの行から説明する。
        if (before.status !== "active") return { expired: false, reason: "not_active" };
        return { expired: false, reason: "not_due" };
      }

      const purchase = this.getPurchase(purchaseId)!;
      this.decideRoleRevocation(purchase, actor);
      this.events.log("shop_expired", { actor, payload: { purchaseId } });
      return { expired: true, reason: "expired" };
    };
    return this.db.inTransaction ? run() : this.db.transaction(run).immediate();
  }

  /**
   * 失効した購入からロールを剥がすかどうかを決める。
   *
   * **自動で剥がすには独立した2つの事実が要る。**
   *   A. この購入がそのロールを与える契約だった（`roleGrantTarget`）
   *   B. この購入が実際に提供済みだった（`hasDeliveredEvidence`）
   *
   * Aだけでは足りない。購入時autoのスナップショットは「そのロールを与えるつもりだった」
   * を示すだけで、「実際にDiscordへ付与した」ことは示さない（Phase Dの truth/replay 分離）。
   * 提供していない購入の終了でロールを剥がすのは、与えていないものを取り上げる操作になる。
   */
  private decideRoleRevocation(purchase: PurchaseRow, actor: string): void {
    const target = this.roleGrantTarget(purchase);
    if (target.kind === "proven_non_role") return; // ロール商品ではない。剥奪する物が無い

    if (target.kind === "legacy_unknown") {
      // 現在の商品設定から推測しない。人が確認するまで自動では触らない。
      this.events.log("shop_role_revocation_unresolved", {
        actor,
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, reason: "role_target_unknown" },
      });
      return;
    }

    if (!this.hasDeliveredEvidence(purchase)) {
      // 与えた証拠が無い。剥がす対象も無い。
      this.events.log("shop_role_revocation_unresolved", {
        actor,
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, reason: "delivery_unproven" },
      });
      return;
    }

    const ts = now();
    this.db
      .prepare(
        `INSERT INTO shop_role_revocations
         (purchase_id, user_id, role_id, status, attempts, last_error, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)
         ON CONFLICT(purchase_id) DO UPDATE SET
           role_id=COALESCE(shop_role_revocations.role_id, excluded.role_id),
           status=CASE WHEN shop_role_revocations.status='done' THEN 'done' ELSE 'pending' END,
           updated_at=excluded.updated_at`,
      )
      .run(purchase.id, purchase.user_id, target.roleId, ts, ts);
  }

  /**
   * この失効行の保存済み `role_id` は、購入時の事実として裏が取れるか。
   *
   * 古いキュー行は現在の商品設定から作られている可能性がある。Discordへ
   * `roles.remove()` を投げる**直前に**ここで再検証し、証明できないものは実行しない。
   */
  roleRevocationTargetProven(purchaseId: number, savedRoleId: string | null): boolean {
    if (!savedRoleId) return false;
    const purchase = this.getPurchase(purchaseId);
    if (!purchase) return false;
    const target = this.roleGrantTarget(purchase);
    if (target.kind !== "proven" || target.roleId !== savedRoleId) return false;
    return this.hasDeliveredEvidence(purchase);
  }

  /**
   * まだ有効な別契約が、購入時の事実としてこのロールを与えているか。
   *
   * **現在の `shop_items` は見ない。** 商品のロール設定を変えただけで
   * 「この契約はこのロールを与えている」という判定まで変わってしまうため。
   */
  activeRoleEntitlementState(
    userId: string,
    roleId: string,
    excludePurchaseId?: number,
  ): RoleEntitlementState {
    const rows = this.db
      .prepare("SELECT * FROM shop_purchases WHERE user_id = ? AND status = 'active'")
      .all(userId) as PurchaseRow[];
    let unsettled = false;
    for (const purchase of rows) {
      if (excludePurchaseId !== undefined && purchase.id === excludePurchaseId) continue;
      const target = this.roleGrantTarget(purchase);
      if (target.kind !== "proven" || target.roleId !== roleId) continue;
      // 提供済みの証拠がある契約が1つでもあれば、それが最も強い根拠になる。
      if (this.hasDeliveredEvidence(purchase)) return "delivered";
      unsettled = true;
    }
    return unsettled ? "unsettled" : "none";
  }

  /**
   * 古い失効を完了してよいほど強い契約があるか。
   *
   * **未確定（`unsettled`）は false。** 提供されたか分からない購入を根拠に古い失効を
   * 完了させると、その購入が後で返金されたときに、有効な契約が無いのにロールだけ
   * Discordに残る。
   */
  activePurchaseProvesRoleEntitlement(userId: string, roleId: string, excludePurchaseId?: number): boolean {
    return this.activeRoleEntitlementState(userId, roleId, excludePurchaseId) === "delivered";
  }

  /**
   * 剥奪対象を確定できない失効購入（運営の確認待ち）。
   *
   * 推測で剥がさない代わりに、黙って消しもしない。
   */
  listUnresolvedExpiryRevocations(opts: { limit?: number } = {}): Array<
    PurchaseRow & { item_name: string; unresolved_reason: "role_target_unknown" | "delivery_unproven" }
  > {
    const rows = this.db
      .prepare(
        `SELECT p.*, i.name AS item_name
           FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
          WHERE p.status = 'expired'
            AND NOT EXISTS (SELECT 1 FROM shop_role_revocations r WHERE r.purchase_id = p.id AND r.status = 'done')
          ORDER BY p.purchased_at`,
      )
      .all() as Array<PurchaseRow & { item_name: string }>;
    const out: Array<PurchaseRow & { item_name: string; unresolved_reason: "role_target_unknown" | "delivery_unproven" }> = [];
    for (const row of rows) {
      const target = this.roleGrantTarget(row);
      if (target.kind === "proven_non_role") continue;
      if (target.kind === "legacy_unknown") {
        out.push({ ...row, unresolved_reason: "role_target_unknown" });
      } else if (!this.hasDeliveredEvidence(row)) {
        out.push({ ...row, unresolved_reason: "delivery_unproven" });
      }
      if (out.length >= (opts.limit ?? 25)) break;
    }
    return out;
  }

  /**
   * 自動では二度と再試行されない剥奪。
   *
   * worker は `status='pending'` しか拾わない。`blocked:*` として `failed` に落ちた行は
   * **どの巡回も触らない**ので、人が見なければ永久に残る。「本番で今0件」は
   * 到達不能の証明にならないので、件数として出せるようにする。
   */
  listBlockedRoleRevocations(opts: { limit?: number } = {}): Array<{
    purchaseId: number;
    userId: string;
    itemName: string;
    reason: string;
    updatedAt: number;
  }> {
    return this.db
      .prepare(
        `SELECT r.purchase_id AS purchaseId, p.user_id AS userId, i.name AS itemName,
                COALESCE(r.last_error, 'blocked') AS reason, r.updated_at AS updatedAt
           FROM shop_role_revocations r
           JOIN shop_purchases p ON p.id = r.purchase_id
           JOIN shop_items i ON i.id = p.item_id
          WHERE r.status = 'failed'
          ORDER BY r.updated_at ASC, r.purchase_id ASC
          LIMIT ?`,
      )
      .all(opts.limit ?? 25) as Array<{
      purchaseId: number;
      userId: string;
      itemName: string;
      reason: string;
      updatedAt: number;
    }>;
  }

  countBlockedRoleRevocations(): number {
    return this.db
      .prepare("SELECT COUNT(*) FROM shop_role_revocations WHERE status = 'failed'")
      .pluck()
      .get() as number;
  }

  /** 上と同じ判定の件数（上限なし） */
  countUnresolvedExpiryRevocations(): number {
    return this.listUnresolvedExpiryRevocations({ limit: Number.MAX_SAFE_INTEGER }).length;
  }

  /**
   * Discordの `roles.remove()` を呼ぶ直前に、その事実をDBへ残す。
   *
   * これを呼ばずに remove すると、remove 成功後・完了記録前にプロセスが落ちた場合に
   * 「roleを外した」という事実がどこにも残らない。次回は有効な契約を見つけて done に
   * してしまい、**roleが無いまま失効が完了扱い**になる。
   */
  markRoleRevocationRemoveAttempt(purchaseId: number): void {
    this.db
      .prepare("UPDATE shop_role_revocations SET remove_attempted_at = ?, updated_at = ? WHERE purchase_id = ?")
      .run(now(), now(), purchaseId);
  }

  /** このworkerがroleを外しにいった可能性があるか（=完了前にDiscordの実体確認が要る） */
  roleRevocationRemoveAttempted(purchaseId: number): boolean {
    const row = this.db
      .prepare("SELECT remove_attempted_at FROM shop_role_revocations WHERE purchase_id = ?")
      .get(purchaseId) as { remove_attempted_at: number | null } | undefined;
    return row?.remove_attempted_at != null;
  }

  pendingRoleRevocations(limit = 100): ShopRoleRevocationRow[] {
    return this.db
      .prepare("SELECT * FROM shop_role_revocations WHERE status = 'pending' ORDER BY updated_at, purchase_id LIMIT ?")
      .all(limit) as ShopRoleRevocationRow[];
  }


  markRoleRevocationDone(purchaseId: number, actor: string, reason: string): void {
    const ts = now();
    this.db
      .prepare("UPDATE shop_role_revocations SET status='done', last_error=NULL, updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE purchase_id=? AND status!='done'")
      .run(ts, ts, purchaseId);
    this.events.log("shop_role_revocation_done", { actor, payload: { purchaseId, reason } });
  }

  markRoleRevocationRetry(purchaseId: number, actor: string, error: string): void {
    const ts = now();
    this.db
      .prepare("UPDATE shop_role_revocations SET attempts=attempts+1, last_error=?, updated_at=? WHERE purchase_id=? AND status='pending'")
      .run(error.slice(0, 500), ts, purchaseId);
    this.events.log("shop_role_revocation_retry", { actor, payload: { purchaseId, error: error.slice(0, 500) } });
  }
}
