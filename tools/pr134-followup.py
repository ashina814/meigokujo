from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


# 1) Long-lived original-role case/invoice history must not cascade-delete.
bootstrap = "packages/core/src/db/bootstrap.ts"
replace_once(
    bootstrap,
    "ticket_thread_id TEXT NOT NULL UNIQUE REFERENCES tickets(thread_id) ON DELETE CASCADE,",
    "ticket_thread_id TEXT NOT NULL UNIQUE REFERENCES tickets(thread_id) ON DELETE RESTRICT,",
)
replace_once(
    bootstrap,
    "case_id INTEGER NOT NULL REFERENCES original_role_cases(id) ON DELETE CASCADE,",
    "case_id INTEGER NOT NULL REFERENCES original_role_cases(id) ON DELETE RESTRICT,",
)

# 2) One generic purchase-log payload/enqueue path for every shop_purchases creator.
shop_path = "packages/core/src/shop/service.ts"
replace_once(
    shop_path,
    """export class Shop {\n""",
    """interface ShopPurchaseLogExtra {
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
""",
)

replace_once(
    shop_path,
    """      CREATE INDEX IF NOT EXISTS idx_shop_role_revocations_status ON shop_role_revocations(status, updated_at);\n""",
    """      CREATE INDEX IF NOT EXISTS idx_shop_role_revocations_status ON shop_role_revocations(status, updated_at);
      -- shop_purchases が正本。1 purchase につき Discord購入ログoutboxは1件だけ積む。
      CREATE TABLE IF NOT EXISTS shop_purchase_log_enqueues (
        purchase_id INTEGER PRIMARY KEY REFERENCES shop_purchases(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
      );
""",
)

replace_once(
    shop_path,
    """  private roleIdFromDelivery(snapshotJson: string | null | undefined, item?: ShopItemRow): { roleId?: string; error?: string } {\n""",
    """  private shopPurchaseLogPayload(
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
""",
)

# Original-role invoice: generic shop log + keep ticket receipt with invoice-specific aliases.
old_invoice_log = """      const logPayload = JSON.stringify({
        purchaseId: purchase.id,
        transactionId: transferred.tx.id,
        itemId: item.id,
        itemName: item.name,
        userId: input.userId,
        amount: invoice.amount,
        invoiceId: invoice.id,
        invoiceKind: invoice.kind,
        invoiceReason: invoice.reason,
        issuedBy: invoice.issued_by,
        paidBy: input.actor,
        ticketThreadId: invoice.ticket_thread_id,
        purchasedAt: ts,
      });
      this.db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('shop_purchase_log', ?, ?)").run(logPayload, ts);
      this.db.prepare("INSERT INTO outbox (kind, payload, created_at) VALUES ('original_role_ticket_receipt', ?, ?)").run(logPayload, ts);
"""
new_invoice_log = """      const genericLog = this.enqueueShopPurchaseLog(purchase, item, {
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
"""
replace_once(shop_path, old_invoice_log, new_invoice_log)

# Normal purchase: retain the Land transaction id for the readable purchase log.
replace_once(
    shop_path,
    """    let paidAltAmount: number | null = null;
    const useAlt = input.payAlt && item.price_alt_kind && item.price_alt_amount;
""",
    """    let paidAltAmount: number | null = null;
    let transactionId: number | null = null;
    const useAlt = input.payAlt && item.price_alt_kind && item.price_alt_amount;
""",
)
replace_once(
    shop_path,
    """      this.ledger.transfer({
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
""",
    """      const transferred = this.ledger.transfer({
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
""",
)
replace_once(
    shop_path,
    """    this.events.log("shop_purchased", {
      actor: input.userId,
      payload: { itemId: item.id, purchaseId: purchase.id, paidLand, paidAltKind, paidAltAmount, expiresAt },
    });
    return { purchase, item, needsManualDelivery: item.delivery === "manual" };
""",
    """    this.events.log("shop_purchased", {
      actor: input.userId,
      payload: { itemId: item.id, purchaseId: purchase.id, paidLand, paidAltKind, paidAltAmount, expiresAt },
    });
    this.enqueueShopPurchaseLog(purchase, item, { transactionId });
    return { purchase, item, needsManualDelivery: item.delivery === "manual" };
""",
)

# Legacy timed-access import is the third direct shop_purchases creator. It is free but still appears in purchase history.
replace_once(
    shop_path,
    """          insertImport.run(
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
          this.events.log("shop_timed_access_legacy_imported", {
""",
    """          insertImport.run(
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
""",
)

# Generic Discord formatter for shop_purchase_log; original-role ticket receipt keeps its dedicated formatter.
outbox_path = "apps/bot/src/outbox.ts"
replace_once(
    outbox_path,
    """function formatOriginalRolePurchase(raw: string): string {\n""",
    """export function formatShopPurchaseLog(raw: string): string {
  const p = JSON.parse(raw) as {
    purchaseId: number;
    transactionId?: number | null;
    itemName: string;
    userId: string;
    paidLand?: number | null;
    paidAltKind?: string | null;
    paidAltAmount?: number | null;
    amount?: number | null; // pre-generalization original-role payload compatibility
    purchasedAt: number;
    deliveryMode?: string | null;
    deliveryKind?: string | null;
    workType?: string | null;
    ticketThreadId?: string | null;
    staffId?: string | null;
    issuedBy?: string | null;
    invoiceId?: number | null;
    invoiceKind?: string | null;
    invoiceReason?: string | null;
    source?: string | null;
    migrationKey?: string | null;
  };
  const land = typeof p.paidLand === "number" ? p.paidLand : (typeof p.amount === "number" ? p.amount : null);
  const payment = land !== null
    ? `Land / ${land.toLocaleString()} Ld`
    : p.paidAltKind && typeof p.paidAltAmount === "number"
      ? `代替（${p.paidAltKind}） / ${p.paidAltAmount.toLocaleString()}`
      : p.source === "legacy_timed_access_import"
        ? "無償 / legacy import"
        : "無償 / 記録のみ";
  const work = p.workType ?? [p.deliveryMode, p.deliveryKind].filter(Boolean).join(" / ") || "未指定";
  const staffRaw = p.staffId ?? p.issuedBy ?? null;
  const staff = staffRaw ? (staffRaw.startsWith("user:") ? `<@${staffRaw.slice(5)}>` : staffRaw) : null;
  const kind = p.invoiceKind
    ? (({ new: "新規", continuation: "継続", restart: "再開", exception: "例外" } as Record<string,string>)[p.invoiceKind] ?? p.invoiceKind)
    : null;
  return [
    `🧾 **公式ショップ購入** — 購入 #${p.purchaseId}${p.transactionId ? ` / 取引 #${p.transactionId}` : ""}`,
    `<@${p.userId}> / **${p.itemName}**`,
    `支払: **${payment}**`,
    `処理: \`${work}\``,
    p.invoiceId ? `請求 #${p.invoiceId}${kind ? ` / ${kind}` : ""}${staff ? ` / 担当 ${staff}` : ""}` : (staff ? `担当: ${staff}` : ""),
    p.ticketThreadId ? `チケット: <#${p.ticketThreadId}>` : "",
    p.invoiceReason ? `理由: ${p.invoiceReason}` : "",
    p.migrationKey ? `移行キー: \`${p.migrationKey}\`` : "",
    `<t:${p.purchasedAt}:F>`,
  ].filter(Boolean).join("\n");
}

function formatOriginalRolePurchase(raw: string): string {
""",
)
replace_once(
    outbox_path,
    """              : entry.kind === "shop_purchase_log"
                ? formatOriginalRolePurchase(entry.payload)
                : formatAudit(entry.kind, entry.payload);
""",
    """              : entry.kind === "shop_purchase_log"
                ? formatShopPurchaseLog(entry.payload)
                : formatAudit(entry.kind, entry.payload);
""",
)

# Strengthen original-role invoice and FK retention regressions.
test_path = "packages/core/tests/original-role-service-case.test.ts"
replace_once(
    test_path,
    """    expect(outbox.map((r) => r.kind)).toContain("shop_purchase_log");
    expect(outbox.map((r) => r.kind)).toContain("original_role_ticket_receipt");
""",
    """    expect(outbox.map((r) => r.kind)).toContain("shop_purchase_log");
    expect(outbox.map((r) => r.kind)).toContain("original_role_ticket_receipt");
    const purchaseLog = ctx.db.prepare("SELECT payload FROM outbox WHERE kind='shop_purchase_log'").get() as {payload:string};
    const payload = JSON.parse(purchaseLog.payload) as Record<string, unknown>;
    expect(payload.purchaseId).toBe(paid.purchase.id);
    expect(payload.transactionId).toBe(paid.transactionId);
    expect(payload.ticketThreadId).toBe("thread-1");
    expect(payload.staffId).toBe("user:staff");
    expect(payload.workType).toBe("original_role_invoice:new");
""",
)
replace_once(
    test_path,
    """    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before - 750_000);
    ctx.db.close();
  });

  it("generic shop経由では設定済みオリロ商品を買えない", () => {
""",
    """    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before - 750_000);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='shop_purchase_log'").get() as {n:number}).n).toBe(1);
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='original_role_ticket_receipt'").get() as {n:number}).n).toBe(1);
    ctx.db.close();
  });

  it("支払い済みinvoiceとカルテはticket/case削除からRESTRICTで保護する", () => {
    const ctx = setup();
    const invoice = ctx.cases.issueInvoice({ threadId: "thread-1", kind: "new", amount: 750_000, actor: "user:staff" });
    ctx.shop.purchaseOriginalRoleInvoice({ invoiceId: invoice.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], idempotencyKey: `invoice:${invoice.id}` });
    expect(() => ctx.db.prepare("DELETE FROM tickets WHERE thread_id='thread-1'").run()).toThrow();
    expect(() => ctx.db.prepare("DELETE FROM original_role_cases WHERE id=?").run(ctx.serviceCase.id)).toThrow();
    const kept = ctx.cases.invoice(invoice.id)!;
    expect(kept.status).toBe("paid");
    expect(kept.purchase_id).toBeTypeOf("number");
    expect(kept.transaction_id).toBeTypeOf("number");
    ctx.db.close();
  });

  it("generic shop経由では設定済みオリロ商品を買えない", () => {
""",
)
replace_once(
    test_path,
    """    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='original_role_invoices'").get() as {name:string}).name).toBe("original_role_invoices");
    db.close();
""",
    """    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='original_role_invoices'").get() as {name:string}).name).toBe("original_role_invoices");
    const caseFks = db.prepare("PRAGMA foreign_key_list(original_role_cases)").all() as Array<{table:string;from:string;on_delete:string}>;
    const invoiceFks = db.prepare("PRAGMA foreign_key_list(original_role_invoices)").all() as Array<{table:string;from:string;on_delete:string}>;
    expect(caseFks.find((fk) => fk.from === "ticket_thread_id")).toMatchObject({ table: "tickets", on_delete: "RESTRICT" });
    expect(invoiceFks.find((fk) => fk.from === "case_id")).toMatchObject({ table: "original_role_cases", on_delete: "RESTRICT" });
    db.close();
""",
)

# Focused core coverage for normal Land, alternate payment, and the direct legacy-import creator.
Path("packages/core/tests/shop-purchase-log.test.ts").write_text(r'''import { describe, expect, it } from "vitest";
import { EventLog, Ledger, Shop, TREASURY, openDb, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();
const USER = "333333333333333333";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const shop = new Shop(db, ledger, events);
  ledger.ensureAccount(`user:${USER}`, "user");
  ledger.transfer({
    from: TREASURY,
    to: `user:${USER}`,
    amount: 1_000_000,
    type: "adjust",
    actor: "test",
    approvedBy: "test",
    idempotencyKey: "seed:shop-log",
  });
  return { db, ledger, events, shop };
}

function logs(db: ReturnType<typeof openDb>) {
  return (db.prepare("SELECT payload FROM outbox WHERE kind='shop_purchase_log' ORDER BY id").all() as Array<{payload:string}>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("official shop purchase log outbox", () => {
  it("通常Land購入をshop_purchasesと同じpurchase IDで1件だけ積む", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({
      name: "通常Land商品",
      price_land: 120_000,
      kind: "one_shot",
      delivery: "manual",
    }, "staff");
    const result = ctx.shop.purchase({ itemId: item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [] });
    const rows = logs(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purchaseId: result.purchase.id,
      itemId: item.id,
      itemName: "通常Land商品",
      userId: USER,
      paidLand: 120_000,
      paidAltKind: null,
      paidAltAmount: null,
      purchasedAt: result.purchase.purchased_at,
      deliveryMode: "manual",
      deliveryKind: null,
      source: "shop_purchase",
    });
    expect(rows[0]?.transactionId).toBeTypeOf("number");
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM shop_purchase_log_enqueues WHERE purchase_id=?").get(result.purchase.id) as {n:number}).n).toBe(1);
    ctx.db.close();
  });

  it("代替支払いも方法・kind・amountを残す", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({
      name: "代替支払い商品",
      price_land: null,
      price_alt_kind: "invite",
      price_alt_amount: 3,
      kind: "one_shot",
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "role-x" }),
    }, "staff");
    const result = ctx.shop.purchase({ itemId: item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], payAlt: true });
    expect(logs(ctx.db)).toEqual([
      expect.objectContaining({
        purchaseId: result.purchase.id,
        itemName: "代替支払い商品",
        paidLand: null,
        paidAltKind: "invite",
        paidAltAmount: 3,
        deliveryMode: "auto",
        deliveryKind: "add_role",
        transactionId: null,
      }),
    ]);
    ctx.db.close();
  });

  it("shop_purchasesを直接作るlegacy移行も無償移行として1件だけ積む", () => {
    const ctx = setup();
    const item = ctx.shop.createItem({
      name: "期限アクセス",
      price_land: 50_000,
      kind: "monthly",
      duration_days: 30,
      delivery: "auto",
      delivery_kind: "add_role",
      delivery_data: JSON.stringify({ role_id: "legacy-role" }),
    }, "staff");
    const result = ctx.shop.migrateTimedAccessLegacy({
      migrationKey: "legacy-2026-08",
      expectations: [{ itemId: item.id, roleId: "legacy-role", expectedCount: 1, roleHolderIds: [USER] }],
      actor: "user:staff",
      reason: "既存ロール移行",
      startedAt: 1_800_000_000,
    });
    expect(result.imports).toHaveLength(1);
    const rows = logs(ctx.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purchaseId: result.imports[0]?.purchase_id,
      itemName: "期限アクセス",
      paidLand: null,
      paidAltKind: null,
      paidAltAmount: null,
      source: "legacy_timed_access_import",
      workType: "legacy_timed_access_import",
      migrationKey: "legacy-2026-08",
    });
    // migration replay creates neither another purchase nor another Discord log.
    const replay = ctx.shop.migrateTimedAccessLegacy({
      migrationKey: "legacy-2026-08",
      expectations: [{ itemId: item.id, roleId: "legacy-role", expectedCount: 1, roleHolderIds: [USER] }],
      actor: "user:staff",
      reason: "既存ロール移行",
      startedAt: 1_800_000_000,
    });
    expect(replay.alreadyApplied).toBe(true);
    expect(logs(ctx.db)).toHaveLength(1);
    ctx.db.close();
  });
});
''')

# Readable Discord formatting coverage; no config/env dependency.
Path("apps/bot/tests/shop-purchase-log-format.test.ts").write_text(r'''import { describe, expect, it } from "vitest";
import { formatShopPurchaseLog } from "../src/outbox.js";

describe("shop purchase log formatting", () => {
  it("通常Land購入を読みやすく表示する", () => {
    const text = formatShopPurchaseLog(JSON.stringify({
      purchaseId: 42,
      transactionId: 99,
      itemName: "通話部屋30日",
      userId: "123",
      paidLand: 50000,
      paidAltKind: null,
      paidAltAmount: null,
      purchasedAt: 1800000000,
      deliveryMode: "auto",
      deliveryKind: "add_role",
      workType: null,
      source: "shop_purchase",
    }));
    expect(text).toContain("公式ショップ購入");
    expect(text).toContain("購入 #42 / 取引 #99");
    expect(text).toContain("<@123>");
    expect(text).toContain("通話部屋30日");
    expect(text).toContain("Land / 50,000 Ld");
    expect(text).toContain("auto / add_role");
    expect(text).toContain("<t:1800000000:F>");
  });

  it("代替支払いと特殊購入のticket/staff/work情報も表示する", () => {
    const alt = formatShopPurchaseLog(JSON.stringify({
      purchaseId: 43,
      transactionId: null,
      itemName: "再評価",
      userId: "123",
      paidLand: null,
      paidAltKind: "invite",
      paidAltAmount: 3,
      purchasedAt: 1800000001,
      deliveryMode: "manual",
      deliveryKind: null,
      workType: "special_work",
      source: "shop_purchase",
    }));
    expect(alt).toContain("代替（invite） / 3");
    expect(alt).toContain("special_work");

    const special = formatShopPurchaseLog(JSON.stringify({
      purchaseId: 44,
      transactionId: 100,
      itemName: "オリジナルロール",
      userId: "123",
      paidLand: 750000,
      paidAltKind: null,
      paidAltAmount: null,
      purchasedAt: 1800000002,
      deliveryMode: "manual",
      deliveryKind: null,
      workType: "original_role_invoice:new",
      ticketThreadId: "777",
      staffId: "user:555",
      invoiceId: 8,
      invoiceKind: "new",
      source: "original_role_invoice",
    }));
    expect(special).toContain("請求 #8 / 新規 / 担当 <@555>");
    expect(special).toContain("チケット: <#777>");
    expect(special).toContain("original_role_invoice:new");
  });
});
''')
