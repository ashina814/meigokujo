import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { TITLE_SOURCES, assertDerivedSourceDependenciesResolve, defineTitle } from "../src/titles/v2-contract.js";

afterEach(() => vi.useRealTimers());

describe("称号v2 source contract", () => {
  it("persisted sourceはwriter/caller/Discord event wiringがrepo内で全部生きている", () => {
    const readRepoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

    for (const [sourceKey, source] of Object.entries(TITLE_SOURCES)) {
      if (source.origin !== "persisted") continue;
      expect(readRepoFile(source.writtenBy.file), `${sourceKey} writer`).toContain(source.writtenBy.needle);
      expect(readRepoFile(source.calledFrom.file), `${sourceKey} caller`).toContain(source.calledFrom.needle);
      expect(readRepoFile(source.wiredFrom.file), `${sourceKey} wiring`).toContain(source.wiredFrom.needle);
    }
  });

  it("derived sourceは実装ファイルが実在し、依存先が全て登録済みsourceを指す", () => {
    const readRepoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

    for (const [sourceKey, source] of Object.entries(TITLE_SOURCES)) {
      if (source.origin !== "derived") continue;
      expect(readRepoFile(source.derivedBy.file), `${sourceKey} derivedBy`).toContain(source.derivedBy.needle);
      expect(source.derivedFrom.length, `${sourceKey} は依存先を最低1つ持つ`).toBeGreaterThan(0);
      for (const dep of source.derivedFrom) {
        expect(TITLE_SOURCES, `${sourceKey} が未登録source ${dep} に依存している`).toHaveProperty(dep);
      }
    }
  });

  it("derived sourceのdependency chainは最終的にlive persisted sourceへ到達する", () => {
    expect(() => assertDerivedSourceDependenciesResolve()).not.toThrow();

    // わざと循環参照を作ると拒否される
    const cyclic = {
      a: { ...TITLE_SOURCES.vc_visits, derivedFrom: ["b"] },
      b: { ...TITLE_SOURCES.vc_visits, derivedFrom: ["a"] },
    };
    expect(() => assertDerivedSourceDependenciesResolve(cyclic as never)).toThrow(/cycle/);

    // 未登録sourceへの依存も拒否される
    const dangling = { a: { ...TITLE_SOURCES.vc_visits, derivedFrom: ["does_not_exist"] } };
    expect(() => assertDerivedSourceDependenciesResolve(dangling as never)).toThrow(/unknown source/);
  });

  it("raw vc_segmentsは称号から直接使えない。安全なderived sourceを使うこと", () => {
    expect(TITLE_SOURCES.vc_segments.titleUsable).toBe(false);
    expect(() =>
      defineTitle({
        key: "v2.bad-raw-vc",
        catalog: "v1",
        name: "bad",
        emoji: "x",
        description: "raw vc_segmentsを直接参照してはいけない",
        sources: ["vc_segments"] as any,
        trigger: "vc_leave",
        lifecycle: "active",
        hidden: false,
        countsForCompletion: false,
        publicAnnounce: false,
      }),
    ).toThrow(/source is not usable by titles/);
  });

  it("生pairwiseのvc_co_presenceは称号から直接使えない。vc_social_safeを使うこと", () => {
    expect(TITLE_SOURCES.vc_co_presence.titleUsable).toBe(false);
    expect(TITLE_SOURCES.vc_co_presence.privacy).toBe("restricted");
    expect(TITLE_SOURCES.vc_social_safe.titleUsable).toBe(true);
    expect(TITLE_SOURCES.vc_social_safe.privacy).toBe("safe");
  });

  it("vc_visitsも称号から直接使えない。startedAtが入室イベントとは限らないため", () => {
    // 孤立したstate_change（coalesceできなかったmute/deafen変化）から始まる訪問は
    // startKind:'partial_observation' で、本人が「その瞬間に入室した」わけではない。
    // これをそのままCOUNTさせないよう、vc_visits自体は中間source扱いにする。
    expect(TITLE_SOURCES.vc_visits.titleUsable).toBe(false);
    expect(() =>
      defineTitle({
        key: "v2.bad-vc-visits",
        catalog: "v1",
        name: "bad",
        emoji: "x",
        description: "vc_visitsを直接参照してはいけない",
        sources: ["vc_visits"] as any,
        trigger: "vc_leave",
        lifecycle: "active",
        hidden: false,
        countsForCompletion: false,
        publicAnnounce: false,
      }),
    ).toThrow(/source is not usable by titles/);
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
