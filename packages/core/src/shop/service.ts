import type Database from "better-sqlite3";
import { Ledger, TREASURY } from "../ledger/service.js";
import { EventLog } from "../events/service.js";

/**
 * 公式ショップ（冥界商館）。
 * Land支払いは焼却（tip_burn 型で TREASURY へ）。月額は毎月1日一括で自動再課金。
 * 商品ごとに階級ロール制限・在庫・自動/手動配送を持たせられる。
 */

export type ItemKind = "one_shot" | "monthly";
export type DeliveryMode = "auto" | "manual";
export type DeliveryKind = "add_role" | "extend_deadline" | "revoke_meirei" | null;
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
  | "ERR_ALREADY_ACTIVE";

export class ShopError extends Error {
  constructor(readonly code: ShopErrorCode, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ShopError";
  }
}

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** 「翌月1日 00:00 JST」の unix秒（毎月1日一括請求で有効期限を切る用） */
export function nextFirstOfMonthJst(fromUnixSec: number = now()): number {
  const d = new Date((fromUnixSec + 9 * 3600) * 1000); // JSTに寄せる
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0..11
  const next = Date.UTC(y, m + 1, 1, 0, 0, 0);
  return Math.floor(next / 1000) - 9 * 3600;
}

/** 「当月末 23:59:59 JST」の unix秒 */
export function endOfMonthJst(fromUnixSec: number = now()): number {
  return nextFirstOfMonthJst(fromUnixSec) - 1;
}

export interface ShopOptions {
  /**
   * 階級要件の判定。既定は「そのロールを持っているか」の完全一致。
   * bot 側から階層対応（「〇〇以上」= 上位階級も可）の判定を注入できる。
   */
  roleCheck?: (memberRoleIds: readonly string[], requireRoleId: string) => boolean;
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

  setEnabled(id: number, enabled: boolean, actor: string): void {
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
   * - 月額は expires_at を当月末に、one_shot で duration_days ありなら期限付きに
   * - 同一 item の月額でアクティブがあれば ERR_ALREADY_ACTIVE
   */
  purchase(input: {
    itemId: number;
    userId: string;
    actor: string;
    memberRoleIds: readonly string[];
    payAlt?: boolean; // 代替支払いを使うか（Landの代わりに price_alt を消費）
  }): { purchase: PurchaseRow; item: ShopItemRow; needsManualDelivery: boolean } {
    const item = this.getItem(input.itemId);
    if (!item) throw new ShopError("ERR_ITEM_NOT_FOUND", { itemId: input.itemId });
    if (!item.enabled) throw new ShopError("ERR_ITEM_DISABLED", { itemId: item.id });
    if (item.require_role_id && !this.roleSatisfied(input.memberRoleIds, item.require_role_id)) {
      throw new ShopError("ERR_ROLE_REQUIRED", { roleId: item.require_role_id });
    }
    if (item.stock !== null && item.stock <= 0) throw new ShopError("ERR_NO_STOCK", { itemId: item.id });
    // 月額の重複防止
    if (item.kind === "monthly") {
      const existing = this.db
        .prepare("SELECT id FROM shop_purchases WHERE item_id = ? AND user_id = ? AND status = 'active'")
        .get(item.id, input.userId) as { id: number } | undefined;
      if (existing) throw new ShopError("ERR_ALREADY_ACTIVE", { itemId: item.id, purchaseId: existing.id });
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
        idempotencyKey: `shop:purchase:${input.userId}:${item.id}:${ts}`,
      });
      paidLand = item.price_land;
    }

    // 期限計算
    let expiresAt: number | null = null;
    if (item.kind === "monthly") {
      expiresAt = endOfMonthJst(ts);
    } else if (item.duration_days) {
      expiresAt = ts + item.duration_days * DAY;
    }

    const info = this.db
      .prepare(
        `INSERT INTO shop_purchases
         (item_id, user_id, purchased_at, expires_at, paid_land, paid_alt_kind, paid_alt_amount, status, auto_renew, delivery_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`,
      )
      .run(item.id, input.userId, ts, expiresAt, paidLand, paidAltKind, paidAltAmount, this.deliverySnapshot(item));
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

  getPurchase(id: number): PurchaseRow | undefined {
    return this.db.prepare("SELECT * FROM shop_purchases WHERE id = ?").get(id) as PurchaseRow | undefined;
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

  /** 月額購読の解約（次月から自動更新しない・当月末までは有効） */
  cancelSubscription(purchaseId: number, actor: string): void {
    this.db
      .prepare("UPDATE shop_purchases SET auto_renew = 0 WHERE id = ? AND status = 'active'")
      .run(purchaseId);
    this.events.log("shop_cancelled", { actor, payload: { purchaseId } });
  }

  /** 手動配送の完了マーク */
  markDelivered(purchaseId: number, actor: string): void {
    this.db.prepare("UPDATE shop_purchases SET delivered_at = ? WHERE id = ?").run(now(), purchaseId);
    this.events.log("shop_delivered", { actor, payload: { purchaseId } });
  }

  /**
   * 毎月1日の一括請求スキャン。
   * - active + monthly + expired過ぎ + auto_renew=1 の購読を巡回
   * - 残高チェック → Land焼却 → expires_at を当月末に更新
   * - 残高不足 or 商品無効なら purchase.status = 'expired'（権利剥奪はbot側でロール解除）
   */
  chargeMonthlySubscriptions(actor: string): {
    charged: PurchaseRow[];
    lapsed: Array<{ purchase: PurchaseRow; item: ShopItemRow; reason: string }>;
  } {
    const ts = now();
    const rows = this.db
      .prepare(
        `SELECT p.* FROM shop_purchases p
         JOIN shop_items i ON p.item_id = i.id
         WHERE p.status = 'active' AND i.kind = 'monthly'
           AND p.expires_at IS NOT NULL AND p.expires_at <= ?`,
      )
      .all(ts) as PurchaseRow[];
    const charged: PurchaseRow[] = [];
    const lapsed: Array<{ purchase: PurchaseRow; item: ShopItemRow; reason: string }> = [];
    for (const p of rows) {
      const item = this.getItem(p.item_id)!;
      if (!p.auto_renew || !item.enabled) {
        this.expire(p.id, actor);
        lapsed.push({ purchase: this.getPurchase(p.id)!, item, reason: p.auto_renew ? "商品が無効化されています" : "解約済み" });
        continue;
      }
      if (item.price_land === null) {
        this.expire(p.id, actor);
        lapsed.push({ purchase: this.getPurchase(p.id)!, item, reason: "商品の Land 価格が未設定" });
        continue;
      }
      const account = `user:${p.user_id}`;
      const bal = this.ledger.balanceOf(account);
      if (bal < item.price_land) {
        this.expire(p.id, actor);
        lapsed.push({ purchase: this.getPurchase(p.id)!, item, reason: `残高不足（所持 ${bal} / 必要 ${item.price_land}）` });
        continue;
      }
      // 焼却
      this.ledger.transfer({
        from: account,
        to: TREASURY,
        amount: item.price_land,
        type: "tip_burn",
        actor,
        reason: `月額課金: ${item.name}`,
        refType: "shop_monthly",
        refId: String(p.id),
        idempotencyKey: `shop:monthly:${p.id}:${new Date().toISOString().slice(0, 7)}`,
      });
      const nextExpires = endOfMonthJst(ts);
      this.db.prepare("UPDATE shop_purchases SET expires_at = ? WHERE id = ?").run(nextExpires, p.id);
      charged.push(this.getPurchase(p.id)!);
    }
    return { charged, lapsed };
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
