import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { TITLE_SOURCES, defineTitle } from "../src/titles/v2-contract.js";

afterEach(() => vi.useRealTimers());

describe("称号v2 source contract", () => {
  it("writer / caller / Discord event wiring がrepo内で全部生きている", () => {
    const readRepoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

    for (const [sourceKey, source] of Object.entries(TITLE_SOURCES)) {
      expect(readRepoFile(source.writtenBy.file), `${sourceKey} writer`).toContain(source.writtenBy.needle);
      expect(readRepoFile(source.calledFrom.file), `${sourceKey} caller`).toContain(source.calledFrom.needle);
      expect(readRepoFile(source.wiredFrom.file), `${sourceKey} wiring`).toContain(source.wiredFrom.needle);
    }
  });

  it("BUMP称号は時刻付きbump_eventsを使い、bump_countsは直接参照させない", () => {
    expect(TITLE_SOURCES.bump_events).toMatchObject({
      kind: "history",
      orderable: true,
      titleUsable: true,
      epochPolicy: { type: "point", at: "created_at" },
      rawUnit: "successful_bump_event",
    });
    expect(TITLE_SOURCES.bump_counts.titleUsable).toBe(false);

    expect(() =>
      defineTitle({
        key: "v2.bad-bump-counter",
        catalog: "v1",
        name: "bad",
        emoji: "x",
        description: "counterを直接参照してはいけない",
        sources: ["bump_counts"] as any,
        trigger: "bump_success",
        lifecycle: "active",
        hidden: false,
        countsForCompletion: false,
        publicAnnounce: false,
      }),
    ).toThrow(/source is not usable by titles/);
  });

  it("bump_eventsはDiscord成功レスポンスの時刻を保存し、処理遅延後も達成時刻を復元できる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T11:00:11+09:00"));

    const db = openDb(":memory:");
    const bump = new BumpCounter(db);
    const occurredAt = Math.floor(new Date("2026-08-20T11:00:00+09:00").getTime() / 1000);
    expect(bump.addOnce("message-1", "alice", occurredAt)).toBe(true);

    const row = db.prepare("SELECT user_id, created_at FROM bump_events WHERE message_id = ?").get("message-1") as {
      user_id: string;
      created_at: number;
    };
    expect(row.user_id).toBe("alice");
    expect(row.created_at).toBe(occurredAt);
    expect(row.created_at).not.toBe(Math.floor(Date.now() / 1000));
  });
});
