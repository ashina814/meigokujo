import { afterEach, describe, expect, it, vi } from "vitest";
import { BumpCounter, openDb } from "../src/index.js";

const db = openDb(":memory:");

afterEach(() => {
  vi.useRealTimers();
  db.exec("DELETE FROM bump_events; DELETE FROM bump_counts;");
});

describe("BumpCounter.addOnce", () => {
  it("同じメッセージIDを二重加算しない", () => {
    const counter = new BumpCounter(db);

    expect(counter.addOnce("message-1", "user-1", 100)).toBe(true);
    expect(counter.addOnce("message-1", "user-1", 100)).toBe(false);
    expect(counter.get("user-1")).toBe(1);
  });

  it("別メッセージなら同じユーザーへ加算する", () => {
    const counter = new BumpCounter(db);

    expect(counter.addOnce("message-1", "user-1", 100)).toBe(true);
    expect(counter.addOnce("message-2", "user-1", 200)).toBe(true);
    expect(counter.get("user-1")).toBe(2);
  });

  it("同じメッセージIDを別ユーザーへ付け替えない", () => {
    const counter = new BumpCounter(db);

    expect(counter.addOnce("message-1", "user-1", 100)).toBe(true);
    expect(counter.addOnce("message-1", "user-2", 100)).toBe(false);
    expect(counter.get("user-1")).toBe(1);
    expect(counter.get("user-2")).toBe(0);
  });

  it("イベント時刻とDB処理時刻を分離して保存する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T11:00:11+09:00"));
    const counter = new BumpCounter(db);
    const occurredAt = Math.floor(new Date("2026-08-20T11:00:00+09:00").getTime() / 1000);
    const processedAt = Math.floor(Date.now() / 1000);

    expect(counter.addOnce("message-1", "user-1", occurredAt)).toBe(true);

    const event = db.prepare("SELECT created_at FROM bump_events WHERE message_id = ?").get("message-1") as {
      created_at: number;
    };
    const count = db.prepare("SELECT last_at, updated_at FROM bump_counts WHERE user_id = ?").get("user-1") as {
      last_at: number;
      updated_at: number;
    };

    expect(event.created_at).toBe(occurredAt);
    expect(count.last_at).toBe(occurredAt);
    expect(count.updated_at).toBe(processedAt);
  });

  it("古い成功イベントを遅れて処理してもlast_atを巻き戻さない", () => {
    vi.useFakeTimers();
    const counter = new BumpCounter(db);

    vi.setSystemTime(new Date("2026-08-20T11:10:01+09:00"));
    expect(counter.addOnce("newer-message", "user-1", 2_000)).toBe(true);

    vi.setSystemTime(new Date("2026-08-20T11:10:10+09:00"));
    expect(counter.addOnce("older-message", "user-1", 1_000)).toBe(true);

    const row = db.prepare("SELECT count, last_at, updated_at FROM bump_counts WHERE user_id = ?").get("user-1") as {
      count: number;
      last_at: number;
      updated_at: number;
    };

    expect(row.count).toBe(2);
    expect(row.last_at).toBe(2_000);
    expect(row.updated_at).toBe(Math.floor(Date.now() / 1000));
  });

  it("不正なイベント時刻を拒否する", () => {
    const counter = new BumpCounter(db);
    expect(() => counter.addOnce("message-1", "user-1", Number.NaN)).toThrow(/occurredAt/);
    expect(() => counter.addOnce("message-2", "user-1", -1)).toThrow(/occurredAt/);
  });
});
