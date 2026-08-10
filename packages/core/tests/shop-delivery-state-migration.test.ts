import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/index.js";

/**
 * 既存購入への配送状態の割り当て。
 *
 * `delivered_at` は**手動配送のスタッフ完了マークでしか埋まらない**運用だったので、
 * 「NULL = 未配送」ではない。そのまま pending にすると過去の自動配送が
 * 一斉に再実行され、ロール付与や期限延長が二度走る。移行では
 * **再配送を発生させない**ことを優先する。
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows のハンドル解放待ち */
    }
  }
});

function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-shop-mig-"));
  tempDirs.push(dir);
  const path = join(dir, "bot.db");
  const db = openDb(path);
  const item = db.prepare(
    `INSERT INTO shop_items (name, price_land, kind, delivery, delivery_kind, enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,1)`,
  );
  const autoId = Number(item.run("自動商品", 100, "one_shot", "auto", "add_role").lastInsertRowid);
  const manualId = Number(item.run("手動商品", 100, "one_shot", "manual", null).lastInsertRowid);
  const revokeId = Number(item.run("再評価チャレンジ", 100, "one_shot", "auto", "revoke_meirei").lastInsertRowid);
  const buy = db.prepare(
    "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivered_at) VALUES (?,?,?,?,?,?)",
  );
  buy.run(autoId, "auto_undelivered", 100, 100, "active", null);
  buy.run(autoId, "auto_delivered", 100, 100, "active", 200);
  buy.run(manualId, "manual_undelivered", 100, 100, "active", null);
  buy.run(manualId, "manual_delivered", 100, 100, "active", 200);
  // 再評価チャレンジ: 本人が waiting（＝DBのresetは済んでいる）と、meirei に戻っている場合
  buy.run(revokeId, "revoke_now_waiting", 100, 100, "active", null);
  buy.run(revokeId, "revoke_now_meirei", 100, 100, "active", null);
  const soul = db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES (?,?,1)");
  soul.run("revoke_now_waiting", "waiting");
  soul.run("revoke_now_meirei", "meirei");
  // 移行前の状態にする（この列は今回の変更で入る）
  db.prepare("UPDATE shop_purchases SET delivery_state = NULL").run();
  db.close();
  return path;
}

const stateOf = (db: ReturnType<typeof openDb>, user: string) =>
  (db.prepare("SELECT delivery_state FROM shop_purchases WHERE user_id = ?").get(user) as { delivery_state: string }).delivery_state;

describe("既存購入への配送状態の割り当て", () => {
  it("delivered_at がある行は delivered", () => {
    const db = openDb(seeded());
    expect(stateOf(db, "auto_delivered")).toBe("delivered");
    expect(stateOf(db, "manual_delivered")).toBe("delivered");
    db.close();
  });

  it("自動配送で未マークの行は delivered 扱い（一斉再配送を起こさない）", () => {
    const db = openDb(seeded());
    expect(stateOf(db, "auto_undelivered")).toBe("delivered");
    db.close();
  });

  it("再評価チャレンジは本人が waiting のときだけ pending にする（ロール修復の余地を残す）", () => {
    const db = openDb(seeded());
    // DBのresetは済んでロールだけ残っている可能性がある行 → 回収対象にできる
    expect(stateOf(db, "revoke_now_waiting")).toBe("pending");
    // 後から再降格された人は触らない（再実行でその降格を巻き戻さない）
    expect(stateOf(db, "revoke_now_meirei")).toBe("delivered");
    db.close();
  });

  it("過去分が回収一覧を埋め尽くさない（対象は手動待ち1件 + 再評価チャレンジ1件だけ）", () => {
    const db = openDb(seeded());
    const rows = db.prepare("SELECT user_id FROM shop_purchases WHERE delivery_state <> 'delivered' ORDER BY user_id").all();
    expect(rows).toEqual([{ user_id: "manual_undelivered" }, { user_id: "revoke_now_waiting" }]);
    db.close();
  });

  it("手動配送で未マークの行は pending（元から人手待ちなので意味が変わらない）", () => {
    const db = openDb(seeded());
    expect(stateOf(db, "manual_undelivered")).toBe("pending");
    db.close();
  });

  it("2回目の起動で再割り当てしない（冪等）", () => {
    const path = seeded();
    const first = openDb(path);
    first.prepare("UPDATE shop_purchases SET delivery_state='failed' WHERE user_id='auto_undelivered'").run();
    first.close();

    const second = openDb(path);
    // 一度割り当てた後の状態を移行が塗り替えない
    expect(stateOf(second, "auto_undelivered")).toBe("failed");
    second.close();
  });
});
