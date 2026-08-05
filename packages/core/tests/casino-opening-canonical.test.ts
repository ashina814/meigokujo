import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import {
  canonicalHash,
  canonicalStringify,
  schemaFingerprint,
  tableFingerprint,
} from "../src/casino/opening-canonical.js";

describe("canonicalStringify", () => {
  it("オブジェクトのキー順に依存しない", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("配列の要素順はそのまま保持する（呼び出し側の責務）", () => {
    const a = [1, 2, 3];
    const b = [3, 2, 1];
    expect(canonicalStringify(a)).not.toBe(canonicalStringify(b));
  });

  it("ネストしたオブジェクトの参加者順(配列)は保持し、キー順だけ正規化する", () => {
    const a = { participants: ["u1", "u2"], game: "table_hold", z: true };
    const b = { z: true, game: "table_hold", participants: ["u1", "u2"] };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
    const c = { participants: ["u2", "u1"], game: "table_hold", z: true };
    expect(canonicalStringify(a)).not.toBe(canonicalStringify(c));
  });

  it("Map/Setを直接渡すとエラーになる（先にソート済み配列へ変換させる）", () => {
    expect(() => canonicalStringify(new Map([["a", 1]]))).toThrow();
    expect(() => canonicalStringify(new Set([1, 2]))).toThrow();
  });

  it("同じ内容は同じhashになる（固定時計・繰り返し呼び出し）", () => {
    const value = { a: 1, b: [1, 2, 3], c: { nested: true } };
    const h1 = canonicalHash(value);
    const h2 = canonicalHash(JSON.parse(JSON.stringify(value)));
    expect(h1).toBe(h2);
  });

  it("1単位の値変化でhashが変わる", () => {
    const base = canonicalHash({ balances: { house: 1000, jackpot: 500 } });
    const changed = canonicalHash({ balances: { house: 1001, jackpot: 500 } });
    expect(base).not.toBe(changed);
  });

  it("同一総額の付け替え（内訳が変わる）でhashが変わる", () => {
    const before = canonicalHash({ balances: { house: 1000, jackpot: 500 } });
    const after = canonicalHash({ balances: { house: 999, jackpot: 501 } });
    expect(before).not.toBe(after);
  });

  it("statusだけの変化でhashが変わる", () => {
    const before = canonicalHash({ status: "pending", amount: 100 });
    const after = canonicalHash({ status: "completed", amount: 100 });
    expect(before).not.toBe(after);
  });

  it("undefinedなプロパティはJSON.stringifyと同じくキーごと消える", () => {
    const a = canonicalStringify({ a: 1, b: undefined });
    const b = canonicalStringify({ a: 1 });
    expect(a).toBe(b);
  });
});

describe("tableFingerprint", () => {
  function setup() {
    const db = openDb(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_rows (id INTEGER PRIMARY KEY, holder TEXT NOT NULL, amount INTEGER NOT NULL);
    `);
    return db;
  }

  it("存在しないテーブルは exists:false、決定的なhashを返す", () => {
    const db = setup();
    const fp1 = tableFingerprint(db, "does_not_exist");
    const fp2 = tableFingerprint(db, "does_not_exist");
    expect(fp1.exists).toBe(false);
    expect(fp1.sha256).toBe(fp2.sha256);
  });

  it("行の挿入順(rowid順)に依存しない — 逆順で入れても同じhash", () => {
    const db1 = setup();
    db1.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (1,'a',10)").run();
    db1.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (2,'b',20)").run();
    const fp1 = tableFingerprint(db1, "test_rows");

    const db2 = setup();
    db2.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (2,'b',20)").run();
    db2.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (1,'a',10)").run();
    const fp2 = tableFingerprint(db2, "test_rows");

    expect(fp1.sha256).toBe(fp2.sha256);
    expect(fp1.rows).toBe(2);
  });

  it("1 Ld相当の値変化でhashが変わる", () => {
    const db1 = setup();
    db1.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (1,'house',1000)").run();
    const fp1 = tableFingerprint(db1, "test_rows");

    const db2 = setup();
    db2.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (1,'house',1001)").run();
    const fp2 = tableFingerprint(db2, "test_rows");

    expect(fp1.sha256).not.toBe(fp2.sha256);
  });

  it("行数は同じでも内容が違えばhashが変わる（重複行の混入を検出する）", () => {
    const db1 = setup();
    db1.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (1,'a',10)").run();
    db1.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (2,'b',20)").run();
    const fp1 = tableFingerprint(db1, "test_rows");

    const db2 = setup();
    db2.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (1,'a',10)").run();
    db2.prepare("INSERT INTO test_rows (id, holder, amount) VALUES (2,'a',10)").run();
    const fp2 = tableFingerprint(db2, "test_rows");

    expect(fp1.sha256).not.toBe(fp2.sha256);
  });
});

describe("schemaFingerprint", () => {
  it("スキーマが同じなら同じhash、テーブル追加で変わる", () => {
    const db1 = openDb(":memory:");
    const fp1 = schemaFingerprint(db1);
    const db2 = openDb(":memory:");
    const fp2 = schemaFingerprint(db2);
    expect(fp1).toBe(fp2);

    db2.exec("CREATE TABLE extra_unknown_table (id INTEGER PRIMARY KEY)");
    const fp3 = schemaFingerprint(db2);
    expect(fp3).not.toBe(fp2);
  });

  it("列追加でhashが変わる(unknown column検知の基盤)", () => {
    const db1 = openDb(":memory:");
    db1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const fp1 = schemaFingerprint(db1);

    const db2 = openDb(":memory:");
    db2.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, extra TEXT)");
    const fp2 = schemaFingerprint(db2);

    expect(fp1).not.toBe(fp2);
  });
});
