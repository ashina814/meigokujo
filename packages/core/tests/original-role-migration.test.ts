import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog, Ledger, OriginalRoles, TREASURY, registerDefaultTxTypes } from "../src/index.js";

registerDefaultTxTypes();

/**
 * 旧production相当のDBから起動できることを確かめる。
 *
 * `original_roles` が既にある本番では `CREATE TABLE IF NOT EXISTS` は何もしないので、
 * 後から足した列は**移行で足さないと存在しない**。新規DBだけで試すと必ず通ってしまい、
 * 本番だけが起動に失敗する（一度やった）。ここは旧スキーマから確かめる場所。
 */
describe("既存DB（role_creation_started_at 列・更新台帳が無い）からの移行", () => {
  function oldDb(): string {
    const path = join(mkdtempSync(join(tmpdir(), "orole-mig-")), "old.db");
    const old = new Database(path);
    // 前回deploy時点の original_roles（新しい列と original_role_renewals が無い）
    old.exec(`CREATE TABLE original_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL, role_id TEXT, name TEXT NOT NULL, color INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at INTEGER, approved_by TEXT, approved_at INTEGER,
      decided_by TEXT, decided_at INTEGER, decide_reason TEXT,
      purchase_id INTEGER, notified_expiry_at INTEGER, role_removed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    old.prepare(
      "INSERT INTO original_roles (user_id, role_id, name, status, expires_at, created_at, updated_at) VALUES ('u1','r1','旧ロール','active',9999999999,0,0)",
    ).run();
    old.close();
    return path;
  }

  it("openDb が通り、列と更新台帳が足され、既存行が残る", () => {
    const db = openDb(oldDb());

    const cols = (db.prepare("PRAGMA table_info(original_roles)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain("role_creation_started_at");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(tables).toContain("original_role_renewals");
    expect((db.prepare("SELECT COUNT(*) c FROM original_roles").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("移行後のDBで、既存契約がそのまま更新できる", () => {
    const db = openDb(oldDb());
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const roles = new OriginalRoles(db, ledger, events);
    ledger.ensureAccount("user:u1", "user");
    ledger.transfer({
      from: TREASURY,
      to: "user:u1",
      amount: 1_000_000,
      type: "adjust",
      actor: "t",
      approvedBy: "t",
      idempotencyKey: "seed",
    });

    const renewed = roles.renew({ id: 1, userId: "u1", price: 250_000, actor: "t", operationId: "op" });

    expect(renewed.status).toBe("active");
    expect(ledger.balanceOf("user:u1")).toBe(750_000);
    db.close();
  });
});
