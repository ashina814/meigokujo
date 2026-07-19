import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Confessions } from "../src/confession/service.js";

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const confessions = new Confessions(db, events);
  return { db, events, confessions };
}

describe("Confessions", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("受付番号を発行し、種別・返信希望・本文を保存する（§4/§5/§18）", () => {
    const row = ctx.confessions.create("user:alice", {
      type: "houkoku",
      replyWish: "yes",
      body: "規約違反を見ました",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.status).toBe("open");
    expect(row.type).toBe("houkoku");
    expect(row.reply_wish).toBe("yes");
    expect(row.body).toBe("規約違反を見ました");
    // 投稿者IDはDBには保持されるが（匿名中継のため）UI表示は別責務
    expect(row.user_id).toBe("user:alice");
  });

  it("メタ未指定でも従来通り受け付けられる（後方互換）", () => {
    const row = ctx.confessions.create("user:bob");
    expect(row.type).toBeNull();
    expect(row.reply_wish).toBeNull();
    expect(row.body).toBeNull();
    expect(row.status).toBe("open");
  });

  it("claim でスレッドを紐付け、byThread で引ける", () => {
    const row = ctx.confessions.create("user:carol", { type: "soudan" });
    const claimed = ctx.confessions.claim(row.id, "thread:123", "user:staff");
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.thread_id).toBe("thread:123");
    expect(claimed?.claimed_by).toBe("user:staff");
    // claim後もメタは保持される
    expect(claimed?.type).toBe("soudan");
    expect(ctx.confessions.byThread("thread:123")?.id).toBe(row.id);
  });

  it("close で終結し、closed_at が入る", () => {
    const row = ctx.confessions.create("user:dave");
    const closed = ctx.confessions.close(row.id, "user:staff");
    expect(closed?.status).toBe("closed");
    expect(closed?.closed_at).not.toBeNull();
  });

  it("出禁はサイレントに記録・照会できる（裏機能として維持）", () => {
    expect(ctx.confessions.isBlocked("user:evil")).toBe(false);
    ctx.confessions.block("user:evil", "user:staff");
    expect(ctx.confessions.isBlocked("user:evil")).toBe(true);
    ctx.confessions.unblock("user:evil", "user:staff");
    expect(ctx.confessions.isBlocked("user:evil")).toBe(false);
  });

  it("旧スキーマ（type/reply_wish/body 列なし）のDBに後付けマイグレーションできる", () => {
    // 旧バージョン相当の最小テーブルを持つDBを用意
    const db = openDb(":memory:") as unknown as Database.Database;
    db.exec(`
      CREATE TABLE confession_tickets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        thread_id   TEXT,
        claimed_by  TEXT,
        created_at  INTEGER NOT NULL,
        claimed_at  INTEGER,
        closed_at   INTEGER
      );
    `);
    db.prepare("INSERT INTO confession_tickets (user_id, status, created_at) VALUES ('user:old', 'open', 1)").run();

    // コンストラクタで列が後付けされる
    const events = new EventLog(db);
    const confessions = new Confessions(db, events);

    // 既存行は新列がNULLで読める
    const cols = db.prepare("PRAGMA table_info(confession_tickets)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["type", "reply_wish", "body"]));
    const old = confessions.get(1);
    expect(old?.type).toBeNull();

    // 新規作成はメタ込みで通る
    const fresh = confessions.create("user:new", { type: "iken", replyWish: "no", body: "要望です" });
    expect(fresh.type).toBe("iken");
    expect(fresh.body).toBe("要望です");
  });
});
