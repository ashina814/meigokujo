import { afterEach, describe, expect, it } from "vitest";
import { BumpCounter, openDb } from "../src/index.js";

const db = openDb(":memory:");

afterEach(() => {
  db.exec("DELETE FROM bump_events; DELETE FROM bump_counts;");
});

describe("BumpCounter.addOnce", () => {
  it("同じメッセージIDを二重加算しない", () => {
    const counter = new BumpCounter(db);

    expect(counter.addOnce("message-1", "user-1")).toBe(true);
    expect(counter.addOnce("message-1", "user-1")).toBe(false);
    expect(counter.get("user-1")).toBe(1);
  });

  it("別メッセージなら同じユーザーへ加算する", () => {
    const counter = new BumpCounter(db);

    expect(counter.addOnce("message-1", "user-1")).toBe(true);
    expect(counter.addOnce("message-2", "user-1")).toBe(true);
    expect(counter.get("user-1")).toBe(2);
  });

  it("同じメッセージIDを別ユーザーへ付け替えない", () => {
    const counter = new BumpCounter(db);

    expect(counter.addOnce("message-1", "user-1")).toBe(true);
    expect(counter.addOnce("message-1", "user-2")).toBe(false);
    expect(counter.get("user-1")).toBe(1);
    expect(counter.get("user-2")).toBe(0);
  });
});
