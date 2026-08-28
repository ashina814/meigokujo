import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/index.js";

/**
 * 途中版のブランチで作られた旧形テーブルを作り直したあとも、
 * **append-only の保証が外れたままにならない**こと。
 *
 * DDLはこの移行より先に流れるので、移行の中で index と trigger を戻さないと
 * 「作り直した直後の1回だけ書き換えられる」DBができてしまう。
 */
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** grant_kind を持たない旧形テーブルのDBを作る */
function interimDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-role-grant-interim-"));
  tempDirs.push(dir);
  const path = join(dir, "bot.db");
  const db = openDb(path);
  db.exec("DROP TRIGGER IF EXISTS trg_shop_purchase_role_grant_provenance_no_update");
  db.exec("DROP TRIGGER IF EXISTS trg_shop_purchase_role_grant_provenance_no_delete");
  db.exec("DROP INDEX IF EXISTS idx_shop_purchase_role_grant_role");
  db.exec("DROP TABLE shop_purchase_role_grant_provenance");
  db.exec(
    `CREATE TABLE shop_purchase_role_grant_provenance (
       purchase_id   INTEGER PRIMARY KEY REFERENCES shop_purchases(id),
       role_id       TEXT NOT NULL,
       delivery_mode TEXT NOT NULL,
       source        TEXT NOT NULL,
       captured_at   INTEGER NOT NULL
     )`,
  );
  db.prepare(
    "INSERT INTO shop_items (name,price_land,kind,delivery,delivery_kind,delivery_data,enabled,created_at,updated_at)" +
      " VALUES ('月額',100,'monthly','auto','add_role',?,1,1,1)",
  ).run(JSON.stringify({ role_id: "R1" }));
  db.prepare(
    "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,auto_renew) VALUES (1,'u1',1,100,'active',0)",
  ).run();
  db.prepare(
    "INSERT INTO shop_purchase_role_grant_provenance (purchase_id,role_id,delivery_mode,source,captured_at)" +
      " VALUES (1,'R1','auto','storefront',1)",
  ).run();
  db.close();
  return path;
}

describe("旧形 role grant provenance の作り直し", () => {
  it("既存の行は grant_kind='role' として残る", () => {
    const db = openDb(interimDb());
    expect(db.prepare("SELECT * FROM shop_purchase_role_grant_provenance WHERE purchase_id=1").get()).toMatchObject({
      grant_kind: "role",
      role_id: "R1",
    });
    db.close();
  });

  it("作り直した**同じ接続**でも append-only が効いている", () => {
    const db = openDb(interimDb());

    expect(() =>
      db.prepare("UPDATE shop_purchase_role_grant_provenance SET role_id='R2' WHERE purchase_id=1").run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM shop_purchase_role_grant_provenance WHERE purchase_id=1").run(),
    ).toThrow(/append-only/);

    expect(db.prepare("SELECT role_id FROM shop_purchase_role_grant_provenance WHERE purchase_id=1").get()).toEqual({
      role_id: "R1",
    });
    db.close();
  });

  it("index も戻っている", () => {
    const db = openDb(interimDb());
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='shop_purchase_role_grant_provenance'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain("idx_shop_purchase_role_grant_role");
    db.close();
  });

  it("再オープンしても壊れない（冪等）", () => {
    const path = interimDb();
    openDb(path).close();
    const db = openDb(path);
    expect(() =>
      db.prepare("UPDATE shop_purchase_role_grant_provenance SET role_id='R3' WHERE purchase_id=1").run(),
    ).toThrow(/append-only/);
    db.close();
  });
});
