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

    for (const table of [
      "title_system_state",
      "title_catalog_epochs",
      "title_source_baselines",
      "title_source_baseline_runs",
      "title_awards",
      "title_equips",
    ]) {
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

  it("catalog施行は登録済みcounterを全件snapshotし、0件でも施行証跡を残す", () => {
    const db = openDb(":memory:");
    const bump = new BumpCounter(db);
    bump.addOnce("msg-1", "alice");
    bump.addOnce("msg-2", "alice");
    bump.addOnce("msg-3", "bob");

    const store = new TitleV2Store(db, () => 100);
    const applied = store.applyCatalog({ catalogKey: "v1", actor: "admin", note: "称号v2施行" });

    expect(applied).toMatchObject({ catalog_key: "v1", epoch: 100, applied_at: 100, actor: "admin" });
    expect(store.systemEpoch()).toBe(100);
    expect(store.baseline("alice", "bump_counts", "count", "v1")).toBe(2);
    expect(store.baseline("bob", "bump_counts", "count", "v1")).toBe(1);
    // snapshot自体が正常で、その時点にuser行が無かった場合だけ0。
    expect(store.baseline("charlie", "bump_counts", "count", "v1")).toBe(0);
    expect(store.listBaselines("v1").map((r) => [r.user_id, r.source, r.metric, r.value])).toEqual([
      ["alice", "bump_counts", "count", 2],
      ["bob", "bump_counts", "count", 1],
    ]);
    expect(store.baselineRun("v1", "bump_counts", "count")).toMatchObject({
      catalog_key: "v1",
      source: "bump_counts",
      metric: "count",
      row_count: 2,
      captured_at: 100,
    });

    const emptyDb = openDb(":memory:");
    const emptyStore = new TitleV2Store(emptyDb, () => 200);
    emptyStore.applyCatalog({ catalogKey: "empty", actor: "admin" });
    expect(emptyStore.listBaselines("empty")).toEqual([]);
    expect(emptyStore.baselineRun("empty", "bump_counts", "count")?.row_count).toBe(0);
    expect(emptyStore.baseline("new-user", "bump_counts", "count", "empty")).toBe(0);
  });

  it("baseline読み取りはmetric typo・非counter source・run欠損を0扱いしない", () => {
    const db = openDb(":memory:");
    const bump = new BumpCounter(db);
    bump.addOnce("msg-1", "alice");
    const store = new TitleV2Store(db, () => 100);
    store.applyCatalog({ catalogKey: "v1", actor: "admin" });

    expect(() => store.baseline("alice", "bump_counts", "counts", "v1")).toThrow(/unknown baseline metric/);
    expect(() => store.baseline("alice", "vc_segments", "seconds", "v1")).toThrow(/does not use a counter baseline/);

    db.prepare(
      "DELETE FROM title_source_baseline_runs WHERE catalog_key = ? AND source = ? AND metric = ?",
    ).run("v1", "bump_counts", "count");
    expect(() => store.baseline("alice", "bump_counts", "count", "v1")).toThrow(/missing baseline run/);
  });

  it("SYSTEM_EPOCHは最初の施行で固定し、CATALOG_EPOCHの巻き戻りを拒否する", () => {
    const db = openDb(":memory:");
    let ts = 200;
    const store = new TitleV2Store(db, () => ts);

    store.applyCatalog({ catalogKey: "v1", actor: "first" });
    expect(store.systemState()).toEqual({ id: 1, system_epoch: 200, established_at: 200, actor: "first" });

    ts = 100;
    expect(() => store.applyCatalog({ catalogKey: "v2", actor: "second" })).toThrow(/cannot move backwards/);
    expect(store.systemEpoch()).toBe(200);
    expect(store.catalogEpoch("v2")).toBeNull();

    ts = 300;
    store.applyCatalog({ catalogKey: "v2", actor: "second" });
    expect(store.systemEpoch()).toBe(200);
    expect(store.catalogEpoch("v2")?.epoch).toBe(300);
  });

  it("catalog施行は外側transaction内から呼べない", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => 100);
    const outer = db.transaction(() => store.applyCatalog({ catalogKey: "v1", actor: "admin" }));

    expect(() => outer()).toThrow(/outside an existing transaction/);
    expect(store.catalogEpoch("v1")).toBeNull();
    expect(store.systemEpoch()).toBeNull();
  });

  it("同じcatalogの二重施行を拒否する", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => 100);
    store.applyCatalog({ catalogKey: "v1", actor: "admin" });
    expect(() => store.applyCatalog({ catalogKey: "v1", actor: "admin" })).toThrow(/already applied/);
  });

  it("awardはscope単位で冪等、達成時刻不明はNULLのまま保存する", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => 200);

    expect(store.award({ userId: "alice", titleKey: "v2.example", scopeKey: "global", earnedAt: null })).toBe(true);
    expect(store.award({ userId: "alice", titleKey: "v2.example", scopeKey: "global", earnedAt: 100 })).toBe(false);
    expect(
      store.award({ userId: "alice", titleKey: "v2.example", scopeKey: "month:2026-08", earnedAt: 150 }),
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

  it("earned_atはawarded_atより未来にできない（runtime / DB双方）", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => 200);

    expect(() =>
      store.award({ userId: "alice", titleKey: "v2.future", scopeKey: "global", earnedAt: 201 }),
    ).toThrow(/cannot be after awardedAt/);

    expect(() =>
      db
        .prepare(
          "INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("alice", "v2.direct", "global", 201, 200),
    ).toThrow();
  });

  it("装備は0〜3枠を本人が選び、未所持は不可・同じ印は別scopeでも1枠だけ", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => 100);

    store.award({ userId: "alice", titleKey: "v2.moon", scopeKey: "month:2026-08", earnedAt: 90 });
    store.award({ userId: "alice", titleKey: "v2.moon", scopeKey: "month:2026-09", earnedAt: 95 });
    store.award({ userId: "alice", titleKey: "v2.table", scopeKey: "global", earnedAt: 96 });

    expect(store.listEquips("alice")).toEqual([]);
    store.equip("alice", 1, "v2.moon", "month:2026-08");
    store.equip("alice", 2, "v2.table", "global");
    expect(store.listEquips("alice").map((r) => [r.slot, r.title_key, r.scope_key])).toEqual([
      [1, "v2.moon", "month:2026-08"],
      [2, "v2.table", "global"],
    ]);

    store.equip("alice", 3, "v2.moon", "month:2026-09");
    expect(store.listEquips("alice").map((r) => [r.slot, r.title_key, r.scope_key])).toEqual([
      [2, "v2.table", "global"],
      [3, "v2.moon", "month:2026-09"],
    ]);

    expect(() => store.equip("alice", 1, "v2.unknown", "global")).toThrow(/unowned/);
    expect(() => store.equip("alice", 4, "v2.table", "global")).toThrow(/slot/);
  });

  it("source registryのwriter/callerは実ファイルに存在する", () => {
    const readRepoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

    for (const [sourceKey, source] of Object.entries(TITLE_SOURCES)) {
      expect(readRepoFile(source.writtenBy.file), `${sourceKey} writer`).toContain(source.writtenBy.needle);
      expect(readRepoFile(source.calledFrom.file), `${sourceKey} caller`).toContain(source.calledFrom.needle);
    }
  });

  it("VC raw sourceはstate segmentであり、クラッシュ補正があるためorderableではない", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T01:00:00+09:00"));
    vc.open("alice", "vc1", "cat1", false, false);

    vi.setSystemTime(new Date("2026-08-20T01:10:00+09:00"));
    // 同じVCでmute状態が変わるだけでもopen()は前segmentを閉じて新しい行を作る。
    vc.open("alice", "vc1", "cat1", true, false);

    const rows = db.prepare("SELECT COUNT(*) AS n FROM vc_segments WHERE user_id = ?").get("alice") as { n: number };
    expect(rows.n).toBe(2);
    expect(TITLE_SOURCES.vc_segments.rawUnit).toBe("voice_state_segment");
    expect(TITLE_SOURCES.vc_segments.orderable).toBe(false);

    vi.setSystemTime(new Date("2026-08-20T08:10:00+09:00"));
    expect(vc.closeAllDangling()).toBe(1);
    const dangling = db
      .prepare("SELECT started_at, ended_at FROM vc_segments WHERE user_id = ? ORDER BY id DESC LIMIT 1")
      .get("alice") as { started_at: number; ended_at: number };
    expect(dangling.ended_at).toBe(dangling.started_at + 6 * 3600);
  });

  it("counter baselineのmetric名はsource contractに固定される", () => {
    expect(TITLE_SOURCES.bump_counts.epochPolicy).toEqual({ type: "baseline", metrics: ["count"] });
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
