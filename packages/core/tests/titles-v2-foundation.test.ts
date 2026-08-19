import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { TITLE_SOURCES, TITLE_TIME_ZONE, defineTitle } from "../src/titles/v2-contract.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { VcTracker } from "../src/vc/service.js";

afterEach(() => vi.useRealTimers());

describe("称号v2 foundation", () => {
  it("旧titlesとは別のadditive schemaを作り、earned_atはNULLを許す", () => {
    const db = openDb(":memory:");
    new TitleV2Store(db);

    for (const table of ["title_catalog_epochs", "title_source_baselines", "title_awards", "title_equips"]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { name?: string } | undefined;
      expect(row?.name).toBe(table);
    }

    const cols = db.prepare("PRAGMA table_info(title_awards)").all() as Array<{ name: string; notnull: number }>;
    expect(cols.find((c) => c.name === "earned_at")?.notnull).toBe(0);

    // 移行期間は旧称号を消さない。
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='titles'").get()).toBeTruthy();
  });

  it("catalog epochとcounter baselineを同じBEGIN IMMEDIATEで一度だけ確定する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00+09:00"));

    const db = openDb(":memory:");
    const bump = new BumpCounter(db);
    bump.addOnce("msg-1", "alice");
    bump.addOnce("msg-2", "alice");

    const store = new TitleV2Store(db);
    const applied = store.applyCatalog({
      catalogKey: "v1",
      actor: "admin",
      note: "称号v2施行",
      snapshotBaselines: (lockedDb) => {
        const row = lockedDb
          .prepare("SELECT count FROM bump_counts WHERE user_id = ?")
          .get("alice") as { count: number };
        return [{ userId: "alice", source: "bump_counts", metric: "count", value: row.count }];
      },
    });

    expect(applied.catalog_key).toBe("v1");
    expect(store.systemEpoch()).toBe(applied.epoch);
    expect(store.baseline("alice", "bump_counts", "count", "v1")).toBe(2);
    expect(() =>
      store.applyCatalog({
        catalogKey: "v1",
        actor: "admin",
        snapshotBaselines: () => [],
      }),
    ).toThrow(/already applied/);
  });

  it("baseline対象ではないhistory sourceをsnapshotへ混ぜると全施行をrollbackする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db);

    expect(() =>
      store.applyCatalog({
        catalogKey: "broken",
        actor: "admin",
        snapshotBaselines: () => [
          { userId: "alice", source: "vc_segments", metric: "seconds", value: 10 },
        ],
      }),
    ).toThrow(/does not use a baseline/);

    expect(store.catalogEpoch("broken")).toBeNull();
    expect(store.listBaselines("broken")).toEqual([]);
  });

  it("awardはscope単位で冪等、達成時刻不明はNULLのまま保存する", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => 200);

    expect(
      store.award({
        userId: "alice",
        titleKey: "v2.example",
        scopeKey: "global",
        earnedAt: null,
      }),
    ).toBe(true);
    expect(
      store.award({
        userId: "alice",
        titleKey: "v2.example",
        scopeKey: "global",
        earnedAt: 100,
      }),
    ).toBe(false);
    expect(
      store.award({
        userId: "alice",
        titleKey: "v2.example",
        scopeKey: "month:2026-08",
        earnedAt: 150,
      }),
    ).toBe(true);

    expect(store.listAwards("alice")).toEqual([
      {
        user_id: "alice",
        title_key: "v2.example",
        scope_key: "month:2026-08",
        earned_at: 150,
        awarded_at: 200,
      },
      {
        user_id: "alice",
        title_key: "v2.example",
        scope_key: "global",
        earned_at: null,
        awarded_at: 200,
      },
    ]);
  });

  it("装備は0〜3枠を本人が選び、未所持は不可・同じ印は別scopeでも1枠だけ", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => 100);

    store.award({ userId: "alice", titleKey: "v2.moon", scopeKey: "month:2026-08", earnedAt: 90 });
    store.award({ userId: "alice", titleKey: "v2.moon", scopeKey: "month:2026-09", earnedAt: 95 });
    store.award({ userId: "alice", titleKey: "v2.table", scopeKey: "global", earnedAt: 96 });

    expect(store.listEquips("alice")).toEqual([]); // 自動装備しない
    store.equip("alice", 1, "v2.moon", "month:2026-08");
    store.equip("alice", 2, "v2.table", "global");
    expect(store.listEquips("alice").map((r) => [r.slot, r.title_key, r.scope_key])).toEqual([
      [1, "v2.moon", "month:2026-08"],
      [2, "v2.table", "global"],
    ]);

    // 同じ印の9月版へ替えると、古いslotから移動して1枠だけ残る。
    store.equip("alice", 3, "v2.moon", "month:2026-09");
    expect(store.listEquips("alice").map((r) => [r.slot, r.title_key, r.scope_key])).toEqual([
      [2, "v2.table", "global"],
      [3, "v2.moon", "month:2026-09"],
    ]);

    expect(() => store.equip("alice", 1, "v2.unknown", "global")).toThrow(/unowned/);
    expect(() => store.equip("alice", 4, "v2.table", "global")).toThrow(/slot/);
  });

  it("source registryのwriter/callerは実ファイルに存在する", () => {
    const readRepoFile = (path: string) =>
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

    for (const [sourceKey, source] of Object.entries(TITLE_SOURCES)) {
      expect(readRepoFile(source.writtenBy.file), `${sourceKey} writer`).toContain(source.writtenBy.needle);
      expect(readRepoFile(source.calledFrom.file), `${sourceKey} caller`).toContain(source.calledFrom.needle);
    }
  });

  it("source contractはVC生行を『入室回数』として扱わない", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T01:00:00+09:00"));
    vc.open("alice", "vc1", "cat1", false, false);

    vi.setSystemTime(new Date("2026-08-20T01:10:00+09:00"));
    // 同じVCでmute状態が変わるだけでもopen()は前segmentを閉じて新しい行を作る。
    vc.open("alice", "vc1", "cat1", true, false);

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM vc_segments WHERE user_id = ?")
      .get("alice") as { n: number };
    expect(rows.n).toBe(2);
    expect(TITLE_SOURCES.vc_segments.rawUnit).toBe("voice_state_segment");
    expect(TITLE_SOURCES.vc_segments.epochPolicy).toEqual({
      type: "interval",
      start: "started_at",
      end: "ended_at",
      clip: true,
    });
  });

  it("定義guardはv2名前空間・登録source・隠し完遂除外を守る", () => {
    expect(TITLE_TIME_ZONE).toBe("Asia/Tokyo");
    expect(
      defineTitle({
        key: "v2.sample",
        catalog: "v1",
        name: "サンプル",
        emoji: "🕯",
        description: "テスト",
        sources: ["vc_segments"],
        trigger: "vc_leave",
        lifecycle: "active",
        hidden: false,
        countsForCompletion: true,
        publicAnnounce: false,
      }).key,
    ).toBe("v2.sample");

    expect(() =>
      defineTitle({
        key: "v2.secret",
        catalog: "v1",
        name: "???",
        emoji: "🔒",
        description: "hidden",
        sources: ["vc_segments"],
        trigger: "vc_leave",
        lifecycle: "active",
        hidden: true,
        countsForCompletion: true,
        publicAnnounce: false,
      }),
    ).toThrow(/hidden titles cannot count/);
  });
});
