import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog,
  Ledger,
  OriginalRoleCaseError,
  OriginalRoleCases,
  OriginalRoles,
  Shop,
  ShopError,
  Tickets,
  TREASURY,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();
const USER = "111111111111111111";
const OTHER = "222222222222222222";

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const ledger = new Ledger(db);
  const tickets = new Tickets(db, events);
  const roles = new OriginalRoles(db, ledger, events);
  const cases = new OriginalRoleCases(db, events);
  let itemId = 0;
  const shop = new Shop(db, ledger, events, { originalRoleItemId: () => itemId || null });
  const item = shop.createItem({
    name: "オリジナルロール",
    price_land: 750_000,
    kind: "one_shot",
    delivery: "auto",
    delivery_kind: "create_original_role",
  }, "test");
  itemId = item.id;
  for (const user of [USER, OTHER]) ledger.ensureAccount(`user:${user}`, "user");
  ledger.transfer({ from: TREASURY, to: `user:${USER}`, amount: 3_000_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "seed:user" });
  ledger.transfer({ from: TREASURY, to: `user:${OTHER}`, amount: 3_000_000, type: "adjust", actor: "test", approvedBy: "test", idempotencyKey: "seed:other" });
  const panel = tickets.defaultPanel("original_role")!;
  tickets.create("thread-1", USER, "original_role", { id: panel.id, name: panel.name, notifyRoleIds: [], staffRoleIds: [] });
  const serviceCase = cases.ensureCase("thread-1", USER, "user:staff");
  return { db, events, ledger, tickets, roles, cases, shop, item, serviceCase };
}

describe("original role service invoices", () => {
  it("請求種別はスタッフの明示値が正本で、同じ金額でも意味を推測しない", () => {
    const ctx = setup();
    const invoice = ctx.cases.issueInvoice({ threadId: "thread-1", kind: "continuation", amount: 750_000, actor: "user:staff" });
    expect(invoice.kind).toBe("continuation");
    expect(invoice.amount).toBe(750_000);
    ctx.db.close();
  });

  it("例外金額は理由必須", () => {
    const ctx = setup();
    expect(() => ctx.cases.issueInvoice({ threadId: "thread-1", kind: "exception", amount: 123_456, actor: "user:staff" })).toThrow(OriginalRoleCaseError);
    const invoice = ctx.cases.issueInvoice({ threadId: "thread-1", kind: "exception", amount: 123_456, reason: "個別調整", actor: "user:staff" });
    expect(invoice.reason).toBe("個別調整");
    ctx.db.close();
  });

  it("本人だけが支払い、purchase/transaction/staff/timeを請求へ残す", () => {
    const ctx = setup();
    const invoice = ctx.cases.issueInvoice({ threadId: "thread-1", kind: "new", amount: 750_000, actor: "user:staff" });
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    expect(() => ctx.shop.purchaseOriginalRoleInvoice({ invoiceId: invoice.id, userId: OTHER, actor: `user:${OTHER}`, memberRoleIds: [], idempotencyKey: `invoice:${invoice.id}` })).toThrow(ShopError);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before);

    const paid = ctx.shop.purchaseOriginalRoleInvoice({ invoiceId: invoice.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], idempotencyKey: `invoice:${invoice.id}` });
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before - 750_000);
    expect(paid.purchase.paid_land).toBe(750_000);
    expect(paid.purchase.delivery_state).toBe("delivered");
    const stored = ctx.cases.invoice(invoice.id)!;
    expect(stored.status).toBe("paid");
    expect(stored.paid_by).toBe(`user:${USER}`);
    expect(stored.issued_by).toBe("user:staff");
    expect(stored.purchase_id).toBe(paid.purchase.id);
    expect(stored.transaction_id).toBe(paid.transactionId);
    expect(stored.paid_at).toBeTypeOf("number");
    expect(ctx.ledger.getTx(paid.transactionId)?.ref_type).toBe("original_role_invoice");
    const outbox = ctx.db.prepare("SELECT kind FROM outbox WHERE delivered_at IS NULL ORDER BY id").all() as Array<{kind:string}>;
    expect(outbox.map((r) => r.kind)).toContain("shop_purchase_log");
    expect(outbox.map((r) => r.kind)).toContain("original_role_ticket_receipt");
    const purchaseLog = ctx.db.prepare("SELECT payload FROM outbox WHERE kind='shop_purchase_log'").get() as {payload:string};
    const payload = JSON.parse(purchaseLog.payload) as Record<string, unknown>;
    expect(payload.purchaseId).toBe(paid.purchase.id);
    expect(payload.transactionId).toBe(paid.transactionId);
    expect(payload.ticketThreadId).toBe("thread-1");
    expect(payload.staffId).toBe("user:staff");
    expect(payload.workType).toBe("original_role_invoice:new");
    ctx.db.close();
  });

  it("同じ請求の再送は二重課金しない", () => {
    const ctx = setup();
    const invoice = ctx.cases.issueInvoice({ threadId: "thread-1", kind: "new", amount: 750_000, actor: "user:staff" });
    const before = ctx.ledger.balanceOf(`user:${USER}`);
    const first = ctx.shop.purchaseOriginalRoleInvoice({ invoiceId: invoice.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], idempotencyKey: `invoice:${invoice.id}` });
    const second = ctx.shop.purchaseOriginalRoleInvoice({ invoiceId: invoice.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [], idempotencyKey: `invoice:${invoice.id}` });
    expect(second.replayed).toBe(true);
    expect(second.purchase.id).toBe(first.purchase.id);
    expect(ctx.ledger.balanceOf(`user:${USER}`)).toBe(before - 750_000);
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
    const ctx = setup();
    expect(() => ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [] })).toThrowError(ShopError);
    try {
      ctx.shop.purchase({ itemId: ctx.item.id, userId: USER, actor: `user:${USER}`, memberRoleIds: [] });
    } catch (error) {
      expect((error as ShopError).code).toBe("ERR_ORIGINAL_ROLE_SPECIAL_PURCHASE_REQUIRED");
    }
    ctx.db.close();
  });

  it("購入履歴なしの既存実ロールを再課金せずカルテへ引き継げる", () => {
    const ctx = setup();
    const beforePurchases = ctx.shop.countPurchases();
    const imported = ctx.roles.importExisting({ userId: USER, roleId: "legacy-role", name: "旧オリロ", expiresAt: null, actor: "user:staff" });
    const linked = ctx.cases.linkOriginalRole(ctx.serviceCase.id, imported.id, "user:staff");
    expect(linked.original_role_id).toBe(imported.id);
    expect(ctx.roles.get(imported.id)?.expires_at).toBeNull();
    expect(ctx.shop.countPurchases()).toBe(beforePurchases);
    ctx.db.close();
  });
});

describe("openDb migration", () => {
  it("旧production相当DBのoriginal_rolesを保持したままcase/invoice tableを追加する", () => {
    const dir = mkdtempSync(join(tmpdir(), "orole-case-"));
    const path = join(dir, "old.sqlite");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE original_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, role_id TEXT, name TEXT NOT NULL, color INTEGER,
        status TEXT NOT NULL, expires_at INTEGER, approved_by TEXT, approved_at INTEGER, decided_by TEXT, decided_at INTEGER,
        decide_reason TEXT, purchase_id INTEGER, notified_expiry_at INTEGER, role_removed_at INTEGER,
        role_creation_started_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO original_roles (user_id, role_id, name, status, expires_at, created_at, updated_at)
      VALUES ('${USER}', 'legacy-real-role', '旧契約', 'active', 2000000000, 1, 1);
    `);
    old.close();
    const db = openDb(path);
    expect((db.prepare("SELECT name FROM original_roles WHERE role_id='legacy-real-role'").get() as {name:string}).name).toBe("旧契約");
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='original_role_cases'").get() as {name:string}).name).toBe("original_role_cases");
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='original_role_invoices'").get() as {name:string}).name).toBe("original_role_invoices");
    const caseFks = db.prepare("PRAGMA foreign_key_list(original_role_cases)").all() as Array<{table:string;from:string;on_delete:string}>;
    const invoiceFks = db.prepare("PRAGMA foreign_key_list(original_role_invoices)").all() as Array<{table:string;from:string;on_delete:string}>;
    expect(caseFks.find((fk) => fk.from === "ticket_thread_id")).toMatchObject({ table: "tickets", on_delete: "RESTRICT" });
    expect(invoiceFks.find((fk) => fk.from === "case_id")).toMatchObject({ table: "original_role_cases", on_delete: "RESTRICT" });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
