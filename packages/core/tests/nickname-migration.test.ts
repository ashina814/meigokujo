import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/bootstrap.js";

/**
 * **本番を落とした回帰。**
 *
 * 列を参照する索引を DDL ブロック（`CREATE TABLE IF NOT EXISTS` と同じ塊）へ書くと、
 * 既にテーブルがある本番では `CREATE TABLE` が何もせず、**列が無いまま索引だけ**
 * 作りにいって `no such column` で起動に失敗する。列を足す移行より前に索引を
 * 張ってはいけない。新規DBだけで試すと気づけないので、ここで旧スキーマから確かめる。
 */
describe("既存DB（staged_for_purchase 列が無い）からの移行", () => {
  it("openDb が通り、列と索引が張られ、既存行が残る", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mig-")), "old.db");
    const old = new Database(path);
    old.exec(`CREATE TABLE nickname_reservations (
      name_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('member','legacy_conflict')),
      user_id TEXT, display TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK ((kind='member' AND user_id IS NOT NULL) OR (kind='legacy_conflict' AND user_id IS NULL)));
    CREATE UNIQUE INDEX idx_nickname_res_user ON nickname_reservations(user_id) WHERE user_id IS NOT NULL;`);
    old.prepare("INSERT INTO nickname_reservations VALUES ('えー','member','u1','えー',0,0)").run();
    old.close();

    const db = openDb(path);

    const cols = (db.prepare("PRAGMA table_info(nickname_reservations)").all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toContain("staged_for_purchase");
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='nickname_reservations'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(idx).toContain("idx_nickname_res_user_committed");
    expect(idx).not.toContain("idx_nickname_res_user"); // 旧索引は張り替え済み
    expect((db.prepare("SELECT COUNT(*) c FROM nickname_reservations").get() as { c: number }).c).toBe(1);
    db.close();
  });
});
