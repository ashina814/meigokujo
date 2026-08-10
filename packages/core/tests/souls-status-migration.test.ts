import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/index.js";

/**
 * `souls.status` の CHECK 制約へ `kenma`（眷魔）を足す移行。
 *
 * **DDL を書き換えるだけでは本番に効かない。** `CREATE TABLE IF NOT EXISTS` は
 * 表がある限り何もしないので、既に souls を持つDBは旧CHECKのまま残り、
 * `status='kenma'` の書き込みが CHECK 違反で落ちる。
 * SQLite は CHECK だけを後から変えられないので表を作り直す必要があり、
 * そのとき**評価スナップショットや招待メタデータを落とさない**ことが要点になる。
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows のハンドル解放待ち。後始末の失敗で結果を汚さない */
    }
  }
});

/** 旧CHECK（kenma 無し）の souls を持つDBを、openDb を通さずに作る */
function legacyDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-souls-mig-"));
  tempDirs.push(dir);
  const path = join(dir, "bot.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE souls (
      user_id             TEXT PRIMARY KEY,
      status              TEXT NOT NULL DEFAULT 'waiting'
                          CHECK (status IN ('waiting','ghost','majin','mazoku','meirei','departed')),
      joined_at           INTEGER,
      ghost_at            INTEGER,
      eval_deadline_at    INTEGER,
      eval_extension_days INTEGER NOT NULL DEFAULT 0,
      eval_started_at     INTEGER,
      eval_policy_version TEXT,
      eval_promotion_required INTEGER,
      eval_demotion_threshold INTEGER,
      eval_invite_mark_per_person REAL,
      eval_invite_mark_cap REAL,
      inviter_user_id     TEXT,
      inviter_source      TEXT,
      inviter_hint_user_id TEXT,
      inviter_hint_source  TEXT,
      inviter_hint_origin  TEXT,
      inviter_hint_at      INTEGER,
      updated_at          INTEGER NOT NULL
    );
  `);
  // 実データ: 評価・招待メタデータが埋まっている行と、NULL だらけの行の両方
  db.prepare(
    `INSERT INTO souls (
       user_id, status, joined_at, ghost_at, eval_deadline_at, eval_extension_days,
       eval_started_at, eval_policy_version, eval_promotion_required, eval_demotion_threshold,
       eval_invite_mark_per_person, eval_invite_mark_cap,
       inviter_user_id, inviter_source, inviter_hint_user_id, inviter_hint_source,
       inviter_hint_origin, inviter_hint_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "1463201396567441441", "ghost", 1_700_000_000, 1_700_000_100, 1_700_600_000, 3,
    1_700_000_200, "policy-v2", 5, 2, 1.5, 9.5,
    "9876543210987654321", "user", "8765432109876543210", "invite", "auto", 1_700_000_300, 1_700_000_400,
  );
  db.prepare("INSERT INTO souls (user_id, status, updated_at) VALUES (?,?,?)").run("2222222222222222222", "majin", 1);
  db.prepare("INSERT INTO souls (user_id, status, updated_at) VALUES (?,?,?)").run("3333333333333333333", "meirei", 2);
  db.close();
  return path;
}

describe("souls.status CHECK 移行（眷魔の追加）", () => {
  it("旧CHECKのDBでも、全データを保持したまま kenma を書けるようになる", () => {
    const path = legacyDbPath();

    const before = (() => {
      const raw = new Database(path);
      const row = raw.prepare("SELECT * FROM souls WHERE user_id = ?").get("1463201396567441441");
      const count = (raw.prepare("SELECT COUNT(*) AS n FROM souls").get() as { n: number }).n;
      raw.close();
      return { row, count };
    })();

    const db = openDb(path);

    // 行数・全列の値が一致（評価スナップショットと招待メタデータを落としていない）
    expect((db.prepare("SELECT COUNT(*) AS n FROM souls").get() as { n: number }).n).toBe(before.count);
    expect(db.prepare("SELECT * FROM souls WHERE user_id = ?").get("1463201396567441441")).toEqual(before.row);
    // NULL のままの行も保たれる
    expect(db.prepare("SELECT status, updated_at FROM souls WHERE user_id = ?").get("2222222222222222222")).toEqual({
      status: "majin",
      updated_at: 1,
    });

    // 眷魔が書ける
    db.prepare("UPDATE souls SET status = 'kenma' WHERE user_id = ?").run("2222222222222222222");
    expect((db.prepare("SELECT status FROM souls WHERE user_id = ?").get("2222222222222222222") as { status: string }).status).toBe("kenma");

    // 既存の6値も引き続き書ける
    for (const status of ["waiting", "ghost", "majin", "mazoku", "meirei", "departed"]) {
      db.prepare("UPDATE souls SET status = ? WHERE user_id = ?").run(status, "3333333333333333333");
      expect((db.prepare("SELECT status FROM souls WHERE user_id = ?").get("3333333333333333333") as { status: string }).status).toBe(status);
    }

    // 不正な値は引き続き拒否（CHECK が消えていない）
    expect(() => db.prepare("UPDATE souls SET status = ? WHERE user_id = ?").run("kaijin", "3333333333333333333")).toThrow();
    db.close();
  });

  it("openDb を2回呼んでも壊れない（冪等）", () => {
    const path = legacyDbPath();

    const first = openDb(path);
    first.prepare("UPDATE souls SET status = 'kenma' WHERE user_id = ?").run("2222222222222222222");
    const snapshot = first.prepare("SELECT * FROM souls ORDER BY user_id").all();
    first.close();

    const second = openDb(path);
    // 2回目は移行済みなので何もしない。データも変わらない
    expect(second.prepare("SELECT * FROM souls ORDER BY user_id").all()).toEqual(snapshot);
    // 眷魔も既存値も引き続き書ける
    second.prepare("UPDATE souls SET status = 'mazoku' WHERE user_id = ?").run("2222222222222222222");
    expect(() => second.prepare("UPDATE souls SET status = ? WHERE user_id = ?").run("bogus", "2222222222222222222")).toThrow();
    second.close();
  });

  it("新規DBは最初から眷魔を受け付ける", () => {
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-souls-new-"));
    tempDirs.push(dir);
    const db = openDb(join(dir, "bot.db"));
    db.prepare("INSERT INTO souls (user_id, status, updated_at) VALUES (?,?,?)").run("4444444444444444444", "kenma", 1);
    expect((db.prepare("SELECT status FROM souls WHERE user_id = ?").get("4444444444444444444") as { status: string }).status).toBe("kenma");
    expect(() => db.prepare("INSERT INTO souls (user_id, status, updated_at) VALUES (?,?,?)").run("5", "nope", 1)).toThrow();
    db.close();
  });
});
