import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/index.js";

/**
 * 決済台帳を足すマイグレーション。
 *
 * **既存の `applied=0` を自動で在庫へ足さない。** その商品の現在の在庫数がどういう意図で
 * 設定されたかは証明できない（運営が返金分を織り込み済みで入力したかもしれない）。
 * DBを開いただけで在庫が動くと、運営が見ていないところで販売可能数が変わる。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function freshPath() {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-stock-migration-"));
  dirs.push(dir);
  return join(dir, "bot.db");
}

describe("決済台帳のマイグレーション", () => {
  it("applied=0 が残っていても、開くだけで在庫は動かない", () => {
    const path = freshPath();
    const first = openDb(path);
    const itemId = first
      .prepare(
        `INSERT INTO shop_items (name,price_land,kind,delivery,delivery_kind,stock,enabled,created_at,updated_at)
         VALUES ('限定札',100,'one_shot','manual','none',5,1,0,0) RETURNING id`,
      )
      .pluck()
      .get() as number;
    const purchaseId = first
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
         VALUES (?, 'u1', 0, 100, 'refunded', 'failed') RETURNING id`,
      )
      .pluck()
      .get(itemId) as number;
    // 「無制限のあいだに返金された」＝まだ戻していない義務
    first
      .prepare(
        `INSERT INTO shop_purchase_stock_restorations (purchase_id,item_id,quantity,restored_at,reason,applied)
         VALUES (?,?,1,0,'refund',0)`,
      )
      .run(purchaseId, itemId);
    first.close();

    // 再度開く＝マイグレーションが走る
    const db = openDb(path);

    // 現在すでに有限（5個）でも、勝手に6にしない
    expect(db.prepare("SELECT stock FROM shop_items WHERE id=?").pluck().get(itemId)).toBe(5);
    // 決済もしていない。未処理のまま運営に見せる
    expect(db.prepare("SELECT COUNT(*) FROM shop_stock_restoration_settlements").pluck().get()).toBe(0);
    expect(db.prepare("SELECT applied FROM shop_purchase_stock_restorations WHERE purchase_id=?").pluck().get(purchaseId)).toBe(0);
    db.close();
  });

  it("決済台帳は append-only（同じ接続で書き換え・削除できない）", () => {
    const path = freshPath();
    const db = openDb(path);
    const itemId = db
      .prepare(
        `INSERT INTO shop_items (name,price_land,kind,delivery,delivery_kind,stock,enabled,created_at,updated_at)
         VALUES ('限定札',100,'one_shot','manual','none',5,1,0,0) RETURNING id`,
      )
      .pluck()
      .get() as number;
    const purchaseId = db
      .prepare(
        `INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivery_state)
         VALUES (?, 'u1', 0, 100, 'refunded', 'failed') RETURNING id`,
      )
      .pluck()
      .get(itemId) as number;
    db.prepare(
      `INSERT INTO shop_purchase_stock_restorations (purchase_id,item_id,quantity,restored_at,reason,applied)
       VALUES (?,?,1,0,'refund',0)`,
    ).run(purchaseId, itemId);
    db.prepare(
      `INSERT INTO shop_stock_restoration_settlements (purchase_id,item_id,quantity,disposition,settled_at,actor_id)
       VALUES (?,?,1,'absorbed',0,'staff')`,
    ).run(purchaseId, itemId);

    expect(() => db.prepare("UPDATE shop_stock_restoration_settlements SET disposition='applied'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM shop_stock_restoration_settlements").run()).toThrow(/append-only/);
    // 同じ義務を二度始末できない
    expect(() =>
      db
        .prepare(
          `INSERT INTO shop_stock_restoration_settlements (purchase_id,item_id,quantity,disposition,settled_at,actor_id)
           VALUES (?,?,1,'applied',0,'staff')`,
        )
        .run(purchaseId, itemId),
    ).toThrow();
    db.close();
  });

  it("再オープンしても trigger と index は重複しない", () => {
    const path = freshPath();
    openDb(path).close();
    const db = openDb(path);
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='shop_stock_restoration_settlements' ORDER BY name",
      )
      .pluck()
      .all();
    expect(triggers).toEqual([
      "trg_shop_stock_restoration_settlements_no_delete",
      "trg_shop_stock_restoration_settlements_no_update",
    ]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_shop_stock_restoration_settlements_item'",
        )
        .pluck()
        .get(),
    ).toBe(1);
    db.close();
  });
});
