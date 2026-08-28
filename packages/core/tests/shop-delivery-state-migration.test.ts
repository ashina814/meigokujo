import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/index.js";

/**
 * 既存購入への配送状態の割り当て。
 *
 * `delivered_at` は**手動配送のスタッフ完了マークでしか埋まらない**運用だったので、
 * 「NULL = 未配送」ではない。購入時スナップショットを持つ自動配送の行をそのまま
 * pending にすると、過去の自動配送が一斉に再実行され、ロール付与や期限延長が二度走る。
 * そこはいまも **再配送を発生させない** ことを優先して delivered に置く。
 *
 * ただしスナップショットを持たない行は別。当時の提供方式を示す証拠が何も無いので、
 * 移行時点の `shop_items.delivery` から delivered / pending を決めていた。これは
 * 「購入時の状態を現在の商品設定から推測しない」に反するうえ、既定値が delivered
 * だったため**配送していない購入が提供済みとして静かに消える**経路になっていた。
 * いまは pending に置き、提供済みかどうかは読み手が独立した記録
 * （`delivered_at` / `shop_delivered` event）で判断する。
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
    "INSERT INTO shop_purchases (item_id,user_id,purchased_at,paid_land,status,delivered_at,delivery_snapshot_json) VALUES (?,?,?,?,?,?,?)",
  );
  const snap = (kind: string) => JSON.stringify({ delivery: "auto", delivery_kind: kind, delivery_data: null, captured_at: 1 });
  buy.run(autoId, "auto_undelivered", 100, 100, "active", null, snap("add_role"));
  buy.run(autoId, "auto_delivered", 100, 100, "active", 200, snap("add_role"));
  buy.run(manualId, "manual_undelivered", 100, 100, "active", null, null);
  buy.run(manualId, "manual_delivered", 100, 100, "active", 200, null);
  // 再評価チャレンジ: 本人が waiting（＝DBのresetは済んでいる）と、meirei に戻っている場合
  buy.run(revokeId, "revoke_now_waiting", 100, 100, "active", null, snap("revoke_meirei"));
  buy.run(revokeId, "revoke_now_meirei", 100, 100, "active", null, snap("revoke_meirei"));
  // スナップショットを持たない旧購入。現在の商品定義が revoke_meirei でも根拠にしない
  buy.run(revokeId, "legacy_no_snapshot", 100, 100, "active", null, null);
  const soul = db.prepare("INSERT INTO souls (user_id,status,updated_at) VALUES (?,?,1)");
  soul.run("revoke_now_waiting", "waiting");
  soul.run("revoke_now_meirei", "meirei");
  soul.run("legacy_no_snapshot", "waiting");
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

  it("自動配送で未マークの行を「提供済み」と書かない（結末は分からない）", () => {
    // 購入時autoのスナップショットは**配送方式**の証拠であって、成功した証拠ではない。
    // 以前は「再配送させない」を delivered と書いて表現していたが、それは記録としては嘘で、
    // 返金や期限付きアクセスがその嘘を信じてしまう。
    const db = openDb(seeded());
    expect(stateOf(db, "auto_undelivered")).not.toBe("delivered");
    db.close();
  });

  it("それでも自動再配送はしない（抑止は別の台帳に記録する）", () => {
    const db = openDb(seeded());
    const suppressed = db
      .prepare("SELECT reason FROM shop_delivery_replay_suppressions s JOIN shop_purchases p ON p.id=s.purchase_id WHERE p.user_id=?")
      .get("auto_undelivered") as { reason: string } | undefined;
    expect(suppressed?.reason).toBe("legacy_auto_outcome_unknown");
    db.close();
  });

  it("自動配送を取りやめた再評価チャレンジは failed として残す（自動でも回収導線でも実行しない）", () => {
    const db = openDb(seeded());
    // 「配送は終わっていない」という事実は残す。ただし delivered とは言わない
    expect(stateOf(db, "revoke_now_waiting")).toBe("failed");
    expect(stateOf(db, "revoke_now_meirei")).toBe("failed");
    const errors = db
      .prepare("SELECT DISTINCT delivery_error AS e FROM shop_purchases WHERE user_id IN ('revoke_now_waiting','revoke_now_meirei')")
      .all();
    expect(errors).toEqual([{ e: "auto_delivery_withdrawn:revoke_meirei" }]);
    db.close();
  });

  it("自動再配送の候補に、結末が不明な旧auto行を入れない", () => {
    const db = openDb(seeded());
    // pending になるのは「人手待ちの手動配送」と「購入時の提供方式を証明できない旧購入」。
    // どちらも購入時スナップショットを持たないので、自動再配送の候補には入らない
    // （`listUndeliveredAuto` はスナップショット必須）。
    const rows = db
      .prepare("SELECT user_id FROM shop_purchases WHERE delivery_state = 'pending' ORDER BY user_id")
      .all();
    expect(rows).toEqual([
      { user_id: "auto_undelivered" },
      { user_id: "legacy_no_snapshot" },
      { user_id: "manual_undelivered" },
    ]);
    // pending でも、スナップショットを持つ旧auto行は抑止台帳に載っているので
    // 自動再配送の候補にはならない。
    const replayable = db
      .prepare(
        `SELECT COUNT(*) AS c FROM shop_purchases p
          WHERE p.delivery_state='pending' AND p.delivery_snapshot_json IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM shop_delivery_replay_suppressions r WHERE r.purchase_id=p.id)`,
      )
      .get() as { c: number };
    expect(replayable.c).toBe(0);
    db.close();
  });

  it("スナップショットの無い旧購入は、現在の商品定義から提供済みと決めない", () => {
    // 以前はここで移行時点の `shop_items.delivery` を見て delivered にしていた。
    // それは「購入時の状態を現在の商品設定から推測しない」に反するうえ、
    // **配送していない購入が提供済みとして静かに消える**経路だった。
    const db = openDb(seeded());
    // 提供済みと言い切らない
    expect(stateOf(db, "legacy_no_snapshot")).not.toBe("delivered");
    // かといって自動再配送の候補にもしない（スナップショットが無いので候補に入らない）
    const row = db
      .prepare("SELECT delivery_snapshot_json AS snap FROM shop_purchases WHERE user_id='legacy_no_snapshot'")
      .get() as { snap: string | null };
    expect(row.snap).toBeNull();
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
