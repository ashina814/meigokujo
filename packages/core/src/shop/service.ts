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
}

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
  | "ERR_PURCHASE_NOT_FOUND"
  | "ERR_NOT_OWNER"
  | "ERR_NOT_ACTIVE"
  | "ERR_NOT_EXTENDABLE"
  | "ERR_TERMS_CHANGED"
  | "ERR_SALES_LOCKED"
  | "ERR_ALREADY_DELIVERED"
  | "ERR_REFUND_RACE"
  | "ERR_REEVAL_SPECIAL_PURCHASE_REQUIRED"
  | "ERR_REEVAL_ITEM_CONFIG"
  | "ERR_REEVAL_STATUS"
  | "ERR_REEVAL_RIGHT_EXISTS"
  | "ERR_REEVAL_INVITES_INSUFFICIENT"
  | "ERR_REEVAL_NOT_CONSUMED"
  | "ERR_REEVAL_ALREADY_COMPENSATED"
  | "ERR_REEVAL_COMPENSATION_UNAVAILABLE";

export class ShopError extends Error {
  constructor(readonly code: ShopErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ShopError";
  }
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** 期限商品の既定の期間。旧「月額」もここへ寄せる（暦月ではなく購入から30日） */
export const DEFAULT_TERM_DAYS = 30;
export const REEVAL_PRICE_LAND = 500_000;
export const REEVAL_INVITE_COUNT = 5;

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
  /** 例外補償の部署支出に使用する。未注入なら補償は fail-closed。 */
  departments?: Departments;
}

export class Shop {
  constructor(
    private readonly db: Database.Database,
    private readonly ledger: Ledger,
    private readonly events: EventLog,
    private readonly options: ShopOptions = {},
  ) {
    this.ensureSchema();
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
    if (patch.stock !== undefined) push("stock", patch.stock);
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
  }): { purchase: PurchaseRow; item: ShopItemRow; needsManualDelivery: boolean } {
    if (this.options.reevalItemId?.() === input.itemId) {
      throw new ShopError("ERR_REEVAL_SPECIAL_PURCHASE_REQUIRED", { itemId: input.itemId });
    }
    return this.purchaseInternal(input);
  }

  private purchaseInternal(input: {
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    payAlt?: boolean;
    request?: Record<string, unknown>;
    idempotencyKey?: string;
  }): { purchase: PurchaseRow; item: ShopItemRow; needsManualDelivery: boolean } {
    const item = this.getItem(input.itemId);
    if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId: input.itemId });
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
    const useAlt = input.payAlt && item.price_alt_kind && item.price_alt_amount;
    if (useAlt) {
      paidAltKind = item.price_alt_kind;
      paidAltAmount = item.price_alt_amount;
    } else {
      if (item.price_land === null) throw new ShopError("ERR_NO_PRICE", { itemId: item.id });
      // Land を焼却
      const account = `user:${input.userId}`;
      this.ledger.ensureAccount(account, "user");
      this.ledger.transfer({
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
    if (item.stock !== null) {
      this.db.prepare("UPDATE shop_items SET stock = stock - 1, updated_at = ? WHERE id = ?").run(ts, item.id);
    }
    const purchase = this.getPurchase(Number(info.lastInsertRowid))!;
    this.events.log("shop_purchased", {
      actor: input.userId,
      payload: { itemId: item.id, purchaseId: purchase.id, paidLand, paidAltKind, paidAltAmount, expiresAt },
    });
    return { purchase, item, needsManualDelivery: item.delivery === "manual" };
  }

  /**
   * 再評価権を購入する。資格確認、支払い、購入行、招待使用台帳を同じ IMMEDIATE transaction で確定する。
   */
  checkReevaluationPurchase(input: {
    itemId: number;
    userId: string;
    mode: "land" | "invite";
  }): { availableInvites: number } {
    const configuredId = this.options.reevalItemId?.() ?? null;
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
    const soul = this.db.prepare("SELECT status FROM souls WHERE user_id = ?").get(input.userId) as
      | { status: string }
      | undefined;
    if (soul?.status !== "meirei") {
      throw new ShopError("ERR_REEVAL_STATUS", { userId: input.userId, status: soul?.status ?? null });
    }
    const existing = this.db
      .prepare(
        `SELECT id FROM shop_purchases
          WHERE item_id = ? AND user_id = ? AND status = 'active'
            AND delivered_at IS NULL
            AND COALESCE(delivery_state, 'pending') <> 'delivered'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(input.itemId, input.userId) as { id: number } | undefined;
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
    const configuredId = this.options.reevalItemId?.() ?? null;
    if (configuredId !== input.itemId) {
      throw new ShopError("ERR_REEVAL_ITEM_CONFIG", { itemId: input.itemId, configuredId });
    }
    const body = () => {
      // UIでの事前確認とは別に、支払い確定の直前にもDBの正本を再読する。
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
    itemId: number;
    purchaseId: number;
    departmentKey: string;
    amount: number;
    reason: string;
    actor: string;
    approvedBy?: string;
    idempotencyKey: string;
  }): ReevalCompensationRow {
    const departments = this.options.departments;
    if (this.options.reevalItemId?.() !== input.itemId || !departments) {
      throw new ShopError("ERR_REEVAL_COMPENSATION_UNAVAILABLE", { itemId: input.itemId });
    }
    const body = () => {
      const purchase = this.getPurchase(input.purchaseId);
      if (!purchase || purchase.item_id !== input.itemId) {
        throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId: input.purchaseId });
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
    const run = this.db.transaction(() => {
      const purchase = this.getPurchase(purchaseId);
      if (!purchase) throw new ShopError("ERR_PURCHASE_NOT_FOUND", { purchaseId });
      if (purchase.status === "refunded") return { refunded: false, amount: purchase.paid_land ?? 0 };
      if (purchase.status !== "active") throw new ShopError("ERR_NOT_ACTIVE", { status: purchase.status });
      // 提供済みのものは返さない（ニックネームが変わったのに返金する、を防ぐ）
      if (purchase.delivered_at !== null || purchase.delivery_state === "delivered") {
        throw new ShopError("ERR_ALREADY_DELIVERED", { purchaseId });
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
      const updated = this.db
        .prepare(
          `UPDATE shop_purchases
              SET status = 'refunded', delivery_state = 'failed', delivery_error = ?, delivery_updated_at = ?
            WHERE id = ? AND status = 'active'`,
        )
        .run(`refunded:${reason}`.slice(0, 500), now(), purchase.id).changes;
      if (updated !== 1) throw new ShopError("ERR_REFUND_RACE", { purchaseId });
      this.events.log("shop_refunded", {
        actor,
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, amount, reason },
      });
      return { refunded: true, amount };
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  /** 手動配送の完了マーク */
  markDelivered(purchaseId: number, actor: string): void {
    this.db
      .prepare(
        "UPDATE shop_purchases SET delivered_at = ?, delivery_state = 'delivered', delivery_error = NULL, delivery_updated_at = ? WHERE id = ?",
      )
      .run(now(), now(), purchaseId);
    this.events.log("shop_delivered", { actor, payload: { purchaseId } });
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
   * 除外する商品IDは呼び出し側が決める。再評価チャレンジのように
   * 「配送する物が無く、専用フローが権利を消費する」商品を、ここへ混ぜないため。
   */
  listPendingManual(
    opts: { excludeItemIds?: readonly number[]; limit?: number } = {},
  ): Array<PurchaseRow & { item_name: string }> {
    const exclude = opts.excludeItemIds ?? [];
    const placeholders = exclude.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT p.*, i.name AS item_name
           FROM shop_purchases p
           JOIN shop_items i ON i.id = p.item_id
          WHERE p.status = 'active'
            AND p.delivery_snapshot_json IS NULL
            AND p.delivered_at IS NULL
            ${exclude.length > 0 ? `AND p.item_id NOT IN (${placeholders})` : ""}
          ORDER BY p.purchased_at
          LIMIT ?`,
      )
      .all(...exclude, opts.limit ?? 25) as Array<PurchaseRow & { item_name: string }>;
  }

  /** 手動対応が残っている件数。表示の上限とは無関係に正確な数を返す */
  countPendingManual(opts: { excludeItemIds?: readonly number[] } = {}): number {
    const exclude = opts.excludeItemIds ?? [];
    const placeholders = exclude.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
          WHERE p.status = 'active' AND p.delivery_snapshot_json IS NULL AND p.delivered_at IS NULL
            ${exclude.length > 0 ? `AND p.item_id NOT IN (${placeholders})` : ""}`,
      )
      .get(...exclude) as { c: number };
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
  listUndeliveredAuto(
    limit = 50,
    opts: { kinds?: readonly string[] } = {},
  ): Array<PurchaseRow & { item_name: string }> {
    const rows = this.db
      .prepare(
        `SELECT p.*, i.name AS item_name
           FROM shop_purchases p
           JOIN shop_items i ON i.id = p.item_id
          WHERE p.status = 'active'
            AND p.delivery_snapshot_json IS NOT NULL
            AND COALESCE(p.delivery_state, 'pending') IN ('pending','failed')
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
      } else if (purchase.delivery_snapshot_json === null && purchase.delivery_state === "delivered" && current) {
        // legacyの購入ID・期限・配送完了は確定事実。ロールだけの人にはこの経路を使わない。
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
    const due = this.db
      .prepare(
        `SELECT id FROM shop_purchases
          WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
          ORDER BY expires_at
          LIMIT ?`,
      )
      .all(ts, limit) as Array<{ id: number }>;
    const expired: PurchaseRow[] = [];
    const failed: Array<{ purchaseId: number; error: string }> = [];
    for (const row of due) {
      try {
        const one = this.db.transaction(() => {
          this.expire(row.id, actor);
          return this.getPurchase(row.id);
        });
        const purchase = this.db.inTransaction ? one() : one.immediate();
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

  private expire(purchaseId: number, actor: string): void {
    const purchase = this.getPurchase(purchaseId);
    const item = purchase ? this.getItem(purchase.item_id) : undefined;
    this.db.prepare("UPDATE shop_purchases SET status = 'expired' WHERE id = ?").run(purchaseId);
    if (purchase) this.enqueueRoleRevocation(purchase, item, actor);
    this.events.log("shop_expired", { actor, payload: { purchaseId } });
  }

  private enqueueRoleRevocation(purchase: PurchaseRow, item: ShopItemRow | undefined, actor: string): void {
    const ts = now();
    const parsed = this.roleIdFromDelivery(purchase.delivery_snapshot_json, item);
    if (!parsed.roleId && !parsed.error) return;
    const status = parsed.roleId ? "pending" : "failed";
    const error = parsed.roleId ? null : `invalid_delivery:${parsed.error ?? "unknown"}`;
    this.db
      .prepare(
        `INSERT INTO shop_role_revocations
         (purchase_id, user_id, role_id, status, attempts, last_error, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(purchase_id) DO UPDATE SET
           role_id=COALESCE(shop_role_revocations.role_id, excluded.role_id),
           status=CASE WHEN shop_role_revocations.status='done' THEN 'done' ELSE excluded.status END,
           last_error=excluded.last_error,
           updated_at=excluded.updated_at`,
      )
      .run(purchase.id, purchase.user_id, parsed.roleId ?? null, status, status === "failed" ? 1 : 0, error, ts, ts, status === "failed" ? ts : null);
    if (status === "failed") {
      this.events.log("shop_role_revocation_invalid", {
        actor,
        target: purchase.user_id,
        payload: { purchaseId: purchase.id, error },
      });
    }
  }

  pendingRoleRevocations(limit = 100): ShopRoleRevocationRow[] {
    return this.db
      .prepare("SELECT * FROM shop_role_revocations WHERE status = 'pending' ORDER BY updated_at, purchase_id LIMIT ?")
      .all(limit) as ShopRoleRevocationRow[];
  }

  activePurchaseGrantsRole(userId: string, roleId: string, excludePurchaseId?: number): boolean {
    const rows = this.db
      .prepare(
        `SELECT p.*, i.delivery AS item_delivery, i.delivery_kind AS item_delivery_kind, i.delivery_data AS item_delivery_data
         FROM shop_purchases p
         JOIN shop_items i ON i.id = p.item_id
         WHERE p.user_id = ? AND p.status = 'active'`,
      )
      .all(userId) as Array<PurchaseRow & { item_delivery: DeliveryMode; item_delivery_kind: DeliveryKind; item_delivery_data: string | null }>;
    for (const p of rows) {
      if (excludePurchaseId !== undefined && p.id === excludePurchaseId) continue;
      const parsed = this.roleIdFromDelivery(
        p.delivery_snapshot_json,
        {
          id: p.item_id,
          name: "",
          description: null,
          price_land: null,
          price_alt_kind: null,
          price_alt_amount: null,
          kind: "monthly",
          duration_days: null,
          require_role_id: null,
          delivery: p.item_delivery,
          delivery_kind: p.item_delivery_kind,
          delivery_data: p.item_delivery_data,
          stock: null,
          enabled: 1,
          created_at: 0,
          updated_at: 0,
        },
      );
      if (parsed.roleId === roleId) return true;
    }
    return false;
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
