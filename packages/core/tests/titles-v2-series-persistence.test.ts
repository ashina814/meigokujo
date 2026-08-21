import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { defineBehaviorTitle, type BehaviorTitleDefinition } from "../src/titles/v2-contract.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import type { TitleSeriesManifest } from "../src/titles/v2-series.js";

/** JST 2026-08-20 00:00:00 を秒0とする、series永続化テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const NO_FACTS = { version: 1, data: {} };

function setup() {
  const db = openDb(":memory:");
  let clock = BASE;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "v1", actor: "test-setup" });
  clock = BASE + 1000;
  const setClock = (value: number) => {
    clock = value;
  };
  return { db, store, setClock };
}

function stage(key: `v2.${string}`, seriesKey: string, stageNum: number, overrides: Partial<BehaviorTitleDefinition> = {}) {
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
    themeKey: "series-test-theme",
    groupKey: "series-test-group",
    collectionDomainKey: "series-test-domain",
    scope: { type: "global" as const },
    progression: { seriesKey, stage: stageNum },
    ...overrides,
  });
}

function ladder(seriesKey: string, n: number): BehaviorTitleDefinition[] {
  return Array.from({ length: n }, (_, i) => stage(`v2.test.${seriesKey}-${i + 1}` as `v2.${string}`, seriesKey, i + 1));
}

function manifestOf(seriesKey: string, members: readonly BehaviorTitleDefinition[], masteryEligible = true): TitleSeriesManifest {
  return { catalog: "v1", seriesKey, label: `${seriesKey}ラベル`, masteryEligible, members: members.map((d) => d.key) };
}

function awardAll(store: TitleV2Store, userId: string, defs: readonly BehaviorTitleDefinition[], observedAt: number) {
  for (const def of defs) {
    const scope = resolveTitleScope(store, def, observedAt);
    store.award({ userId, titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
  }
}

describe("series manifest registration（§25）", () => {
  it("first registration", () => {
    const { store } = setup();
    const members = ladder("ignite", 3);
    const manifest = manifestOf("ignite", members);
    const result = store.registerSeriesManifests([manifest], members);
    expect(result.registered).toEqual([{ catalogKey: "v1", seriesKey: "ignite" }]);
    expect(result.idempotent).toEqual([]);

    const stored = store.seriesManifest("v1", "ignite");
    expect(stored?.masteryEligible).toBe(true);
    expect(stored?.members).toEqual([
      { titleKey: "v2.test.ignite-1", stage: 1 },
      { titleKey: "v2.test.ignite-2", stage: 2 },
      { titleKey: "v2.test.ignite-3", stage: 3 },
    ]);
  });

  it("exact same registrationはidempotent", () => {
    const { store } = setup();
    const members = ladder("ignite", 3);
    const manifest = manifestOf("ignite", members);
    store.registerSeriesManifests([manifest], members);

    const before = store.seriesManifest("v1", "ignite")!;
    const second = store.registerSeriesManifests([manifest], members);
    expect(second.registered).toEqual([]);
    expect(second.idempotent).toEqual([{ catalogKey: "v1", seriesKey: "ignite" }]);

    const after = store.seriesManifest("v1", "ignite")!;
    expect(after).toEqual(before);
  });

  it("same series identity・changed member → reject", () => {
    const { store } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    const swappedMember = stage("v2.test.ignite-3-alt" as `v2.${string}`, "ignite", 3);
    const changedManifest: TitleSeriesManifest = {
      catalog: "v1",
      seriesKey: "ignite",
      label: "ignite別ラベル",
      masteryEligible: true,
      members: [members[0]!.key, members[1]!.key, swappedMember.key],
    };
    expect(() => store.registerSeriesManifests([changedManifest], [...members, swappedMember])).toThrow(
      /different semantic hash/,
    );
  });

  it("stage変更 → hash mismatch reject", () => {
    const { store } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    // titleKey集合・stage集合({1,2,3})自体は変えず（構造validationは通す）、
    // member-1とmember-2でどちらがstage1/stage2を名乗るかだけ入れ替えた別definition
    // を渡す——「同じtitleKey集合でも意味が変わった」ケースをsemantic hashで検出する。
    const swappedMembers = [
      stage(members[0]!.key, "ignite", 2),
      stage(members[1]!.key, "ignite", 1),
      members[2]!,
    ];
    expect(() => store.registerSeriesManifests([manifestOf("ignite", members)], swappedMembers)).toThrow(
      /different semantic hash/,
    );
  });

  it("one title in another series → reject（DB上の既存series全体との重複を確認する）", () => {
    const { store } = setup();
    const igniteMembers = ladder("ignite", 2);
    store.registerSeriesManifests([manifestOf("ignite", igniteMembers)], igniteMembers);

    // 既にignite(v1)へ登録済みのtitleKeyを、"other"という別seriesのmemberとして
    // 再定義してしまった事故パターン（titleKey文字列を誤って使い回した）。
    const redefinedAsOther = stage(igniteMembers[0]!.key, "other", 1);
    const otherSecond = stage("v2.test.other-2" as `v2.${string}`, "other", 2);
    const otherManifest: TitleSeriesManifest = {
      catalog: "v1",
      seriesKey: "other",
      label: "other",
      masteryEligible: true,
      members: [redefinedAsOther.key, otherSecond.key],
    };
    expect(() => store.registerSeriesManifests([otherManifest], [redefinedAsOther, otherSecond])).toThrow(
      /already belongs to a different registered series/,
    );
  });

  it("restartしてもpersist（新しいStoreインスタンスで読み直せる）", () => {
    const { db, store } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    const restarted = new TitleV2Store(db, () => BASE + 2000);
    const stored = restarted.seriesManifest("v1", "ignite");
    expect(stored?.members.length).toBe(3);
  });
});

describe("series mastery reconcile（§25）", () => {
  it("全member ownershipありならmastery作成", () => {
    const { store, setClock } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 2000);
    awardAll(store, "alice", members, BASE + 2000);

    const result = store.reconcileSeriesMasteriesForUser("alice");
    expect(result.newlyMastered).toEqual([
      { catalogKey: "v1", seriesKey: "ignite", memberCount: 3, recordedAt: BASE + 2000 },
    ]);
    expect(store.hasSeriesMastery("alice", "v1", "ignite")).toBe(true);
  });

  it("1 member不足ならmastery無し", () => {
    const { store, setClock } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 2000);
    awardAll(store, "bob", members.slice(0, 2), BASE + 2000);

    const result = store.reconcileSeriesMasteriesForUser("bob");
    expect(result.newlyMastered).toEqual([]);
    expect(store.hasSeriesMastery("bob", "v1", "ignite")).toBe(false);
  });

  it("masteryEligible=falseならmastery無し", () => {
    const { store, setClock } = setup();
    const members = ladder("side", 2);
    store.registerSeriesManifests([manifestOf("side", members, false)], members);

    setClock(BASE + 2000);
    awardAll(store, "carol", members, BASE + 2000);

    const result = store.reconcileSeriesMasteriesForUser("carol");
    expect(result.newlyMastered).toEqual([]);
    expect(store.hasSeriesMastery("carol", "v1", "side")).toBe(false);
  });

  it("second reconcileはidempotent", () => {
    const { store, setClock } = setup();
    const members = ladder("ignite", 2);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 2000);
    awardAll(store, "dave", members, BASE + 2000);
    const first = store.reconcileSeriesMasteriesForUser("dave");
    expect(first.newlyMastered.length).toBe(1);

    const second = store.reconcileSeriesMasteriesForUser("dave");
    expect(second.newlyMastered).toEqual([]);
  });

  it("historical later ownershipで後からmastery可能（新規series manifest登録の後で揃うケースも含む）", () => {
    const { store, setClock } = setup();
    const members = ladder("ignite", 3);

    setClock(BASE + 2000);
    // series manifest登録より前にownershipが揃っているケース: 先にaward、後でmanifest登録。
    awardAll(store, "erin", members, BASE + 2000);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    const result = store.reconcileSeriesMasteriesForUser("erin");
    expect(result.newlyMastered.length).toBe(1);
    expect(store.hasSeriesMastery("erin", "v1", "ignite")).toBe(true);
  });

  it("title retired後も既存masteryは消えない（再構築後も残る）", () => {
    const { db, store, setClock } = setup();
    const members = ladder("ignite", 2);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 2000);
    awardAll(store, "frank", members, BASE + 2000);
    store.reconcileSeriesMasteriesForUser("frank");
    expect(store.hasSeriesMastery("frank", "v1", "ignite")).toBe(true);

    // title lifecycleがretiredになっても（DBには影響しない——lifecycleはruntime
    // definitionの属性でありDB永続化されない）、mastery削除APIは存在しない。
    const restarted = new TitleV2Store(db, () => BASE + 3000);
    expect(restarted.hasSeriesMastery("frank", "v1", "ignite")).toBe(true);
  });
});

describe("assertSeriesPersistenceIntegrity() semantic integrity検証（§9, §28）", () => {
  it("corrupt manifest hash → constructor reject", () => {
    const { db, store } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    db.prepare(`UPDATE title_series_manifests SET manifest_hash = 'corrupted' WHERE catalog_key = 'v1' AND series_key = 'ignite'`).run();

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/does not match the hash recomputed/);
  });

  it("corrupt mastery（全ownershipが揃っていないのに直接INSERTされた行）→ constructor reject", () => {
    const { db, store, setClock } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 2000);
    awardAll(store, "grace", members.slice(0, 1), BASE + 2000); // 1件しかownershipしていない

    db.prepare(
      `INSERT INTO title_series_masteries (user_id, catalog_key, series_key, recorded_at) VALUES (?, ?, ?, ?)`,
    ).run("grace", "v1", "ignite", BASE + 2000);

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/without owning all series member titles/);
  });

  it("mastery_eligible=falseなseriesへの直接masteryINSERT → constructor reject", () => {
    const { db, store, setClock } = setup();
    const members = ladder("side", 2);
    store.registerSeriesManifests([manifestOf("side", members, false)], members);

    setClock(BASE + 2000);
    awardAll(store, "heidi", members, BASE + 2000);
    db.prepare(
      `INSERT INTO title_series_masteries (user_id, catalog_key, series_key, recorded_at) VALUES (?, ?, ?, ?)`,
    ).run("heidi", "v1", "side", BASE + 2000);

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/non-mastery-eligible series/);
  });

  it("stage欠番（member行を直接削除）→ constructor reject", () => {
    const { db, store } = setup();
    const members = ladder("ignite", 3);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    db.pragma("foreign_keys = OFF");
    db.prepare(`DELETE FROM title_series_members WHERE catalog_key='v1' AND series_key='ignite' AND stage=2`).run();
    db.pragma("foreign_keys = ON");

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/not a contiguous 1..N sequence/);
  });

  it("recorded_atが非整数（直接SQL改竄）→ constructor reject", () => {
    const { db, store, setClock } = setup();
    const members = ladder("ignite", 2);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 2000);
    awardAll(store, "ivan", members, BASE + 2000);
    store.reconcileSeriesMasteriesForUser("ivan");

    // CHECK(recorded_at >= 0)は満たすが整数ではない値へ改竄する
    // （facts_versionの1.5パターンと同じ手法）。
    db.prepare(`UPDATE title_series_masteries SET recorded_at = 1.5 WHERE user_id = 'ivan'`).run();

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/invalid recorded_at/);
  });
});

describe("series mastery processing chronology（レビュー追加分・§8相当）", () => {
  it("recordedAtがmanifest.registered_atより前ならreconcileはfail-closed", () => {
    const { store, setClock } = setup();
    const members = ladder("ignite", 2);
    setClock(BASE + 5000);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    // clockを登録時刻より前へ巻き戻してからaward+reconcileを試みる
    // （通常運用では起こらないが、誤ったclock注入やclock逆行を想定）。
    setClock(BASE + 1000);
    awardAll(store, "alice", members, BASE + 1000);

    expect(() => store.reconcileSeriesMasteriesForUser("alice")).toThrow(/chronology violation/);
    expect(store.hasSeriesMastery("alice", "v1", "ignite")).toBe(false);
  });

  it("recordedAtが最後のmember first_awarded_atより前ならreconcileはfail-closed", () => {
    const { store, setClock } = setup();
    const members = ladder("ignite", 2);
    setClock(BASE + 1000);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 9000);
    awardAll(store, "bob", members, BASE + 9000);

    // このreconcile呼び出し自体のclockを、直前のawardedAtより前へ巻き戻す。
    setClock(BASE + 2000);
    expect(() => store.reconcileSeriesMasteriesForUser("bob")).toThrow(/chronology violation/);
    expect(store.hasSeriesMastery("bob", "v1", "ignite")).toBe(false);
  });

  it("正常なchronology（registered_at/ownership.first_awarded_atの後）ならmastery成立", () => {
    const { store, setClock } = setup();
    const members = ladder("ignite", 2);
    setClock(BASE + 1000);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    setClock(BASE + 2000);
    awardAll(store, "carol", members, BASE + 2000);

    setClock(BASE + 3000);
    const result = store.reconcileSeriesMasteriesForUser("carol");
    expect(result.newlyMastered.length).toBe(1);
    expect(result.newlyMastered[0]!.recordedAt).toBe(BASE + 3000);
  });

  it("constructor integrityでも同じchronology契約を再検証する（直接SQL改竄）", () => {
    const { db, store, setClock } = setup();
    const members = ladder("ignite", 2);
    setClock(BASE + 5000);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);
    setClock(BASE + 6000);
    awardAll(store, "dave", members, BASE + 6000);
    setClock(BASE + 7000);
    store.reconcileSeriesMasteriesForUser("dave");

    // recorded_atを、manifest.registered_at(5000)より前の値へ直接改竄する。
    db.prepare(`UPDATE title_series_masteries SET recorded_at = ? WHERE user_id = 'dave'`).run(BASE + 100);

    expect(() => new TitleV2Store(db, () => BASE + 8000)).toThrow(/is before the required minimum/);
  });
});

describe("structural integrity（manifest_hashとは独立、レビュー追加分・§5相当）", () => {
  it("member titleKeyがv2.*namespaceでない状態（直接SQL改竄）→ constructor reject", () => {
    const { db, store } = setup();
    const members = ladder("ignite", 2);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    db.pragma("foreign_keys = OFF");
    db.prepare(`UPDATE title_series_members SET title_key = 'not-v2-namespaced' WHERE catalog_key = 'v1' AND series_key = 'ignite' AND stage = 1`).run();
    db.pragma("foreign_keys = ON");

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/member titleKey must use v2\.\* namespace/);
  });

  it("members < 2（直接SQL削除）→ constructor reject", () => {
    const { db, store } = setup();
    const members = ladder("ignite", 2);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    db.pragma("foreign_keys = OFF");
    db.prepare(`DELETE FROM title_series_members WHERE catalog_key = 'v1' AND series_key = 'ignite' AND stage = 2`).run();
    db.pragma("foreign_keys = ON");

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/must have at least 2 members/);
  });

  it("catalog_keyがslugでない（直接SQL改竄。DB層にslug形式のCHECKは無いため、app-level structural checkだけが検出する）→ constructor reject", () => {
    const { db, store } = setup();
    const members = ladder("ignite", 2);
    store.registerSeriesManifests([manifestOf("ignite", members)], members);

    // title_series_membersのcatalog_keyも一緒に書き換え、FK参照整合を保ったまま
    // catalog_key自体を不正なslugへ改竄する（片方だけ変えるとFK孤立child行として
    // 別のfail-closed経路（foreign_key_check）で先に検出されてしまうため）。PKを
    // またぐ更新なのでforeign_keysを一時的に無効化する。
    db.pragma("foreign_keys = OFF");
    db.prepare(`UPDATE title_series_manifests SET catalog_key = 'bad catalog' WHERE series_key = 'ignite'`).run();
    db.prepare(`UPDATE title_series_members SET catalog_key = 'bad catalog' WHERE series_key = 'ignite'`).run();
    db.pragma("foreign_keys = ON");

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/catalog_key is not a valid slug/);
  });
});

describe("atomicity（§21）", () => {
  it("series registration: manifest insert成功 → member insert失敗 → manifestもrollback", () => {
    const { db, store } = setup();
    db.exec(`
      CREATE TRIGGER sabotage_series_member_insert
      BEFORE INSERT ON title_series_members
      WHEN NEW.title_key = 'v2.test.sabotage-3'
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for series registration atomicity test');
      END;
    `);
    const ok1 = stage("v2.test.sabotage-1" as `v2.${string}`, "sabotage-series", 1);
    const ok2 = stage("v2.test.sabotage-2" as `v2.${string}`, "sabotage-series", 2);
    const bad = stage("v2.test.sabotage-3" as `v2.${string}`, "sabotage-series", 3);
    const manifest = manifestOf("sabotage-series", [ok1, ok2, bad]);

    expect(() => store.registerSeriesManifests([manifest], [ok1, ok2, bad])).toThrow(/sabotaged for series/);
    expect(store.seriesManifest("v1", "sabotage-series")).toBeNull();
    const memberRows = db.prepare(`SELECT COUNT(*) AS n FROM title_series_members WHERE series_key = 'sabotage-series'`).get() as {
      n: number;
    };
    expect(memberRows.n).toBe(0);
  });

  it("series mastery: 複数series同時成立中に1件のINSERTが失敗すると、全部rollbackされる（half stateなし）", () => {
    const { db, store, setClock } = setup();
    const seriesA = ladder("aaa-series", 2);
    const seriesB = ladder("zzz-series", 2);
    store.registerSeriesManifests(
      [manifestOf("aaa-series", seriesA), manifestOf("zzz-series", seriesB)],
      [...seriesA, ...seriesB],
    );

    setClock(BASE + 2000);
    awardAll(store, "sabotage-user", [...seriesA, ...seriesB], BASE + 2000);

    db.exec(`
      CREATE TRIGGER sabotage_series_mastery_insert
      BEFORE INSERT ON title_series_masteries
      WHEN NEW.series_key = 'zzz-series'
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for series mastery atomicity test');
      END;
    `);

    expect(() => store.reconcileSeriesMasteriesForUser("sabotage-user")).toThrow(/sabotaged for series mastery/);
    // aaa-seriesが先に処理されていても、同じtransaction内なので一緒にrollbackされる。
    expect(store.hasSeriesMastery("sabotage-user", "v1", "aaa-series")).toBe(false);
    expect(store.hasSeriesMastery("sabotage-user", "v1", "zzz-series")).toBe(false);
  });
});
