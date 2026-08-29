import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/index.js";

/**
 * claim 台帳を足すマイグレーション。
 *
 * **既存の purchase へ claim を推測で作らない。** 旧デプロイで配送途中だったものが
 * あったとしても、それを DB から復元する手段は無い。開いただけで何かが「配送中」に
 * なると、返金も失効も止まってしまう。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function freshPath() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-external-migration-"));
  dirs.push(dir);
  return join(dir, "bot.db");
}

function seedPurchase(db: ReturnType<typeof openDb>, status = "active"): number {
  const itemId = db
    .prepare(
      `INSERT INTO shop_items (name,price_land,kind,delivery,delivery_kind,delivery_data,stock,enabled,created_at,updated_at)
       VALUES ('裏口',100,'monthly','auto','add_role','{"role_id":"r-vip"}',NULL,1,0,0) RETURNING id`,
    )
    .pluck()
    .get() as number;
  return db
    .prepare(
      `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
       VALUES (?, 'u1', 0, 100, ?, 'pending') RETURNING id`,
    )
    .pluck()
    .get(itemId, status) as number;
}

describe("claim 台帳のマイグレーション", () => {
  it("既存の購入へ claim を作らない（開くだけで配送中にならない）", () => {
    const path = freshPath();
    const first = openDb(path);
    const active = seedPurchase(first, "active");
    const refunded = seedPurchase(first, "refunded");
    first.close();

    const db = openDb(path);

    expect(db.prepare("SELECT COUNT(*) FROM shop_external_delivery_attempts").pluck().get()).toBe(0);
    // 返金も失効も止まっていない
    expect(
      db.prepare("SELECT COUNT(*) FROM shop_external_delivery_attempts WHERE purchase_id IN (?,?)").pluck().get(active, refunded),
    ).toBe(0);
    db.close();
  });

  it("同時に生きている claim は1つだけ（DB側で縛る）", () => {
    const path = freshPath();
    const db = openDb(path);
    const purchaseId = seedPurchase(db);
    const insert = db.prepare(
      `INSERT INTO shop_external_delivery_attempts
         (purchase_id, attempt_token, delivery_kind, state, started_at, updated_at, detail)
       VALUES (?,?, 'add_role', ?, 0, 0, NULL)`,
    );
    insert.run(purchaseId, "tok-1", "in_flight");

    // 2本目の in_flight / uncertain は入らない
    expect(() => insert.run(purchaseId, "tok-2", "in_flight")).toThrow();
    expect(() => insert.run(purchaseId, "tok-3", "uncertain")).toThrow();
    // 決着したものは何本でも履歴として残せる
    insert.run(purchaseId, "tok-4", "released");
    insert.run(purchaseId, "tok-5", "settled");
    expect(db.prepare("SELECT COUNT(*) FROM shop_external_delivery_attempts").pluck().get()).toBe(3);
    db.close();
  });

  it("claim は消せない（append-only）", () => {
    const path = freshPath();
    const db = openDb(path);
    const purchaseId = seedPurchase(db);
    db.prepare(
      `INSERT INTO shop_external_delivery_attempts
         (purchase_id, attempt_token, delivery_kind, state, started_at, updated_at, detail)
       VALUES (?, 'tok', 'add_role', 'in_flight', 0, 0, NULL)`,
    ).run(purchaseId);

    expect(() => db.prepare("DELETE FROM shop_external_delivery_attempts").run()).toThrow(/append-only/);
    db.close();
  });

  it("再オープンしても trigger と index は重複しない", () => {
    const path = freshPath();
    openDb(path).close();
    const db = openDb(path);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='shop_external_delivery_attempts'",
        )
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='uq_shop_external_delivery_open'")
        .pluck()
        .get(),
    ).toBe(1);
    db.close();
  });
});
