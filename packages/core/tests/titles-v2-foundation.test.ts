import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { TITLE_SOURCES, TITLE_TIME_ZONE, defineBehaviorTitle, type TitleScopePolicy } from "../src/titles/v2-contract.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { VcTracker } from "../src/vc/service.js";

afterEach(() => vi.useRealTimers());

/** JST 2026-08-20 00:00:00 を秒0とする、award系テスト用の基準時刻。 */
const AWARD_BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const NO_FACTS = { version: 1, data: {} };

function sampleTitle(key: `v2.${string}`, scope: TitleScopePolicy) {
  return defineBehaviorTitle({
    kind: "behavior",
    key,
    catalog: "v1",
    name: key,
    emoji: "x",
    description: "テスト用",
    sources: ["bump_events"],
    triggers: ["daily"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey: "t",
    groupKey: "t",
    collectionDomainKey: "t",
    scope,
  });
}

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
      "title_award_facts",
      "title_rarity_sequences",
      "title_ownerships",
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
    bump.addOnce("msg-1", "alice", 10);
    bump.addOnce("msg-2", "alice", 20);
    bump.addOnce("msg-3", "bob", 30);

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
    bump.addOnce("msg-1", "alice", 10);
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
    let clock = AWARD_BASE;
    const store = new TitleV2Store(db, () => clock);
    store.applyCatalog({ catalogKey: "v1", actor: "admin" }); // SYSTEM_EPOCH/CATALOG_EPOCH=AWARD_BASE
    clock = AWARD_BASE + 200;

    const globalDef = sampleTitle("v2.example", { type: "global" });
    const monthDef = sampleTitle("v2.example-monthly", { type: "month" });
    const globalScope = resolveTitleScope(store, globalDef, clock);
    const monthScope = resolveTitleScope(store, monthDef, clock);

    expect(
      store.award({ userId: "alice", titleKey: "v2.example", scope: globalScope, earnedAt: null, awardFacts: NO_FACTS })
        .status,
    ).toBe("awarded");
    expect(
      store.award({ userId: "alice", titleKey: "v2.example", scope: globalScope, earnedAt: AWARD_BASE + 100, awardFacts: NO_FACTS })
        .status,
    ).toBe("already_awarded");
    expect(
      store.award({
        userId: "alice",
        titleKey: "v2.example-monthly",
        scope: monthScope,
        earnedAt: AWARD_BASE + 150,
        awardFacts: NO_FACTS,
      }).status,
    ).toBe("awarded");

    expect(store.listAwards("alice")).toEqual([
      {
        user_id: "alice",
        title_key: "v2.example-monthly",
        scope_key: monthScope.scopeKey,
        earned_at: AWARD_BASE + 150,
        awarded_at: clock,
      },
      {
        user_id: "alice",
        title_key: "v2.example",
        scope_key: "global",
        earned_at: null,
        awarded_at: clock,
      },
    ]);
  });

  it("earned_atはawarded_atより未来にできない（runtime / DB双方）", () => {
    const db = openDb(":memory:");
    let clock = AWARD_BASE;
    const store = new TitleV2Store(db, () => clock);
    store.applyCatalog({ catalogKey: "v1", actor: "admin" });
    clock = AWARD_BASE + 200;

    const def = sampleTitle("v2.future", { type: "global" });
    const scope = resolveTitleScope(store, def, clock);

    expect(() =>
      store.award({ userId: "alice", titleKey: "v2.future", scope, earnedAt: clock + 1, awardFacts: NO_FACTS }),
    ).toThrow(/cannot be after awardedAt/);

    expect(() =>
      db
        .prepare(
          "INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("alice", "v2.direct", "global", clock + 1, clock),
    ).toThrow();
  });

  it("identity equipは0〜3枠を本人が選び、未所持は不可・同じidentityは1枠だけ（PR B3: 旧title_equips API退役に伴う置き換え）", () => {
    const db = openDb(":memory:");
    let clock = AWARD_BASE;
    const store = new TitleV2Store(db, () => clock);
    store.applyCatalog({ catalogKey: "v1", actor: "admin" });
    clock = AWARD_BASE + 500_000; // catalog epochよりだいぶ後（8月・9月どちらも施行後）

    const moonDef = sampleTitle("v2.moon", { type: "month" });
    const tableDef = sampleTitle("v2.table", { type: "global" });
    const augObservedAt = Math.floor(new Date("2026-08-25T00:00:00+09:00").getTime() / 1000);
    const sepObservedAt = Math.floor(new Date("2026-09-15T00:00:00+09:00").getTime() / 1000);
    const augScope = resolveTitleScope(store, moonDef, augObservedAt);
    const sepScope = resolveTitleScope(store, moonDef, sepObservedAt);
    const tableScope = resolveTitleScope(store, tableDef, clock);

    // awardedAtはcaller入力ではなくclock()のsnapshot——各awardの直前でclockを
    // そのscopeのobservedAt以降へ進めてから呼ぶ。
    clock = augObservedAt;
    store.award({ userId: "alice", titleKey: "v2.moon", scope: augScope, earnedAt: null, awardFacts: NO_FACTS });
    clock = sepObservedAt;
    store.award({ userId: "alice", titleKey: "v2.moon", scope: sepScope, earnedAt: null, awardFacts: NO_FACTS });
    clock = AWARD_BASE + 500_000;
    store.award({ userId: "alice", titleKey: "v2.table", scope: tableScope, earnedAt: null, awardFacts: NO_FACTS });

    // 旧scope-bound title_equips API（equip()/unequip()/listEquips()）はPR B3で
    // 退役し、新しいidentity equip API（equipIdentity()等）だけを使う——印の
    // identityはscopeKeyを含まないtitleKeyそのものであり、月/eventで何度awardして
    // いても関係ない（v2.moonは8月・9月の2 scopeへawardしたが、ownershipはtitleKey
    // 単位で1つだけ）。
    void augScope;
    void sepScope;
    void tableScope;
    expect(store.listIdentityEquips("alice")).toEqual([]);
    store.equipIdentity("alice", 1, { kind: "title", titleKey: "v2.moon" });
    store.equipIdentity("alice", 2, { kind: "title", titleKey: "v2.table" });
    expect(store.listIdentityEquips("alice")).toEqual([
      { userId: "alice", slot: 1, identity: { kind: "title", titleKey: "v2.moon" } },
      { userId: "alice", slot: 2, identity: { kind: "title", titleKey: "v2.table" } },
    ]);

    // 同じidentity（v2.moon）を別slotへ装備すると、元のslotからmoveする。
    store.equipIdentity("alice", 3, { kind: "title", titleKey: "v2.moon" });
    expect(store.listIdentityEquips("alice")).toEqual([
      { userId: "alice", slot: 2, identity: { kind: "title", titleKey: "v2.table" } },
      { userId: "alice", slot: 3, identity: { kind: "title", titleKey: "v2.moon" } },
    ]);

    expect(() => store.equipIdentity("alice", 1, { kind: "title", titleKey: "v2.unknown" })).toThrow(/unowned/);
    expect(() => store.equipIdentity("alice", 4, { kind: "title", titleKey: "v2.table" })).toThrow(/slot/);
  });

  it("source registryのwriter/caller、またはderivedByは実ファイルに存在する", () => {
    const readRepoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

    for (const [sourceKey, source] of Object.entries(TITLE_SOURCES)) {
      if (source.origin === "persisted") {
        expect(readRepoFile(source.writtenBy.file), `${sourceKey} writer`).toContain(source.writtenBy.needle);
        expect(readRepoFile(source.calledFrom.file), `${sourceKey} caller`).toContain(source.calledFrom.needle);
      } else {
        expect(readRepoFile(source.derivedBy.file), `${sourceKey} derivedBy`).toContain(source.derivedBy.needle);
      }
    }
  });

  it("VC raw sourceはstate segmentであり、クラッシュ補正があるためorderableではない", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T01:00:00+09:00"));
    vc.open("alice", "vc1", "cat1", false, false, "join");

    vi.setSystemTime(new Date("2026-08-20T01:10:00+09:00"));
    // 同じVCでmute状態が変わるだけでもopen()は前segmentを閉じて新しい行を作る。
    vc.open("alice", "vc1", "cat1", true, false, "state_change");

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

  it("定義guardはv2名前空間・登録sourceを守る", () => {
    expect(TITLE_TIME_ZONE).toBe("Asia/Tokyo");
    // vc_segments・vc_visits はどちらもtitleUsable:falseのraw/中間source。
    // vc_visitsのstartedAtはstate_changeの孤立観測を含み得るため「入室」を主張できない。
    // 個々の称号は安全に畳み込まれた derived source（vc_social_safe 等）を使う。
    expect(
      defineBehaviorTitle({
        kind: "behavior",
        key: "v2.sample",
        catalog: "v1",
        name: "サンプル",
        emoji: "🕯",
        description: "テスト",
        sources: ["vc_social_safe"],
        triggers: ["vc_activity"],
        lifecycle: "active",
        hidden: false,
        publicAnnounce: false,
        themeKey: "sample",
        groupKey: "sample",
        collectionDomainKey: "sample",
        scope: { type: "global" },
      }).key,
    ).toBe("v2.sample");

    expect(() =>
      defineBehaviorTitle({
        kind: "behavior",
        key: "v1.legacy" as never,
        catalog: "v1",
        name: "旧key",
        emoji: "🔒",
        description: "v2以外の名前空間",
        sources: ["vc_social_safe"],
        triggers: ["vc_activity"],
        lifecycle: "active",
        hidden: false,
        publicAnnounce: false,
        themeKey: "sample",
        groupKey: "sample",
        collectionDomainKey: "sample",
        scope: { type: "global" },
      }),
    ).toThrow(/v2\.\* namespace/);
  });
});
