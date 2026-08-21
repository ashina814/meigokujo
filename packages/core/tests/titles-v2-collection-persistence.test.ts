import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { defineBehaviorTitle, type TitleDefinition } from "../src/titles/v2-contract.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import type { TitleCollectionEdition } from "../src/titles/v2-collection.js";

/** JST 2026-08-20 00:00:00 を秒0とする、collection永続化テスト用の基準時刻。 */
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

function domainTitle(key: `v2.${string}`, domainKey: string, lifecycle: "active" | "retired" | "disabled" = "active") {
  return defineBehaviorTitle({
    kind: "behavior",
    key,
    catalog: "v1",
    name: key,
    emoji: "x",
    description: "テスト用",
    sources: ["bump_events"],
    triggers: ["daily"],
    lifecycle,
    hidden: false,
    publicAnnounce: false,
    themeKey: "collection-test-theme",
    groupKey: "collection-test-group",
    collectionDomainKey: domainKey,
    scope: { type: "global" as const },
  });
}

const VALID_MILESTONES = {
  startedCollecting: 1,
  collectorHabit: 2,
  stillCollecting: 3,
  thousandMarks: { count: 5, domains: 2 },
  almostComplete: { remaining: 1 },
};

/**
 * a/bはdomain-a・fullClearRequired、cはdomain-a・collectionCreditのみ、
 * d/eはdomain-b・collectionCreditのみ。countableCount=5、countableDomains=2、
 * fullClearCount=2——既存titles-v2-collection.test.tsのfiveMemberFixture()と同じ
 * milestone連鎖が成立するスケール。
 */
function fiveMemberEdition(editionKey: string) {
  const a = domainTitle("v2.test.a", "domain-a");
  const b = domainTitle("v2.test.b", "domain-a");
  const c = domainTitle("v2.test.c", "domain-a");
  const d = domainTitle("v2.test.d", "domain-b");
  const e = domainTitle("v2.test.e", "domain-b");
  const defs = [a, b, c, d, e];
  const edition: TitleCollectionEdition = {
    editionKey,
    members: [
      { titleKey: a.key, collectionDomainKey: "domain-a", collectionCredit: true, fullClearRequired: true },
      { titleKey: b.key, collectionDomainKey: "domain-a", collectionCredit: true, fullClearRequired: true },
      { titleKey: c.key, collectionDomainKey: "domain-a", collectionCredit: true, fullClearRequired: false },
      { titleKey: d.key, collectionDomainKey: "domain-b", collectionCredit: true, fullClearRequired: false },
      { titleKey: e.key, collectionDomainKey: "domain-b", collectionCredit: true, fullClearRequired: false },
    ],
    milestones: VALID_MILESTONES,
  };
  const definitionsMap: ReadonlyMap<string, TitleDefinition> = new Map(defs.map((d) => [d.key, d]));
  return { defs, edition, definitionsMap, a, b, c, d, e };
}

function award(store: TitleV2Store, userId: string, def: TitleDefinition, observedAt: number, earnedAt: number | null) {
  const scope = resolveTitleScope(store, def as never, observedAt);
  return store.award({ userId, titleKey: def.key, scope, earnedAt, awardFacts: NO_FACTS });
}

describe("collection edition activation（§12, §26）", () => {
  it("activate first edition", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    const result = store.activateCollectionEdition(edition, definitionsMap, "admin");
    expect(result.status).toBe("activated");
    expect(result.edition.activatedAt).toBe(BASE + 2000);
    expect(result.edition.activatedBy).toBe("admin");

    const active = store.activeCollectionEdition();
    expect(active?.editionKey).toBe("v1-edition");
    expect(active?.members.length).toBe(5);
  });

  it("second active edition → reject", () => {
    const { store, setClock } = setup();
    const first = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(first.edition, first.definitionsMap, "admin");

    const second = fiveMemberEdition("v2-edition");
    expect(() => store.activateCollectionEdition(second.edition, second.definitionsMap, "admin")).toThrow(
      /another edition is already active/,
    );
  });

  it("同じedition・同じmanifestでのactivateはidempotent", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    const second = store.activateCollectionEdition(edition, definitionsMap, "someone-else");
    expect(second.status).toBe("already_active");
    // activatedBy/activatedAtは最初のactivateのまま書き換わらない。
    expect(second.edition.activatedBy).toBe("admin");
    expect(second.edition.activatedAt).toBe(BASE + 2000);
  });

  it("同editionKeyだがsemantic hashが異なる → reject（editionは書き換えない）", () => {
    const { store, setClock } = setup();
    const original = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(original.edition, original.definitionsMap, "admin");

    // 同じeditionKeyのまま、milestoneだけ変えた別内容。
    const mutated: TitleCollectionEdition = {
      ...original.edition,
      milestones: { ...original.edition.milestones, thousandMarks: { count: 4, domains: 2 } },
    };
    expect(() => store.activateCollectionEdition(mutated, original.definitionsMap, "admin")).toThrow(
      /different semantic hash/,
    );
  });

  it("retired memberを含むeditionはactivateできない（activatable eligibilityを通す）", () => {
    const { store, setClock } = setup();
    const base = fiveMemberEdition("v1-edition");
    const retiredA = domainTitle("v2.test.a", "domain-a", "retired");
    const retiredDefs = base.defs.map((d) => (d.key === "v2.test.a" ? retiredA : d));
    const retiredMap: ReadonlyMap<string, TitleDefinition> = new Map(retiredDefs.map((d) => [d.key, d]));
    setClock(BASE + 2000);
    expect(() => store.activateCollectionEdition(base.edition, retiredMap, "admin")).toThrow(/cannot activate/);
  });
});

describe("collection edition close（§13, §26）", () => {
  it("close", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    setClock(BASE + 5000);
    const result = store.closeCollectionEdition("v1-edition", "admin", "retiring for v2 catalog");
    expect(result.status).toBe("closed");
    expect(result.edition.closedAt).toBe(BASE + 5000);
    expect(result.edition.closedBy).toBe("admin");

    expect(store.activeCollectionEdition()).toBeNull();
  });

  it("close metadataはimmutable（2回目closeは書き換えない）", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin", "first close note");

    setClock(BASE + 9000);
    const second = store.closeCollectionEdition("v1-edition", "someone-else", "second close note");
    expect(second.status).toBe("already_closed");
    expect(second.edition.closedAt).toBe(BASE + 5000);
    expect(second.edition.closedBy).toBe("admin");
    expect(second.edition.closeNote).toBe("first close note");
  });

  it("closed editionのreopenをreject", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    expect(() => store.activateCollectionEdition(edition, definitionsMap, "admin")).toThrow(
      /already closed; cannot reopen/,
    );
  });

  it("close後に新しいeditionをactivate可能", () => {
    const { store, setClock } = setup();
    const first = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(first.edition, first.definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    const second = fiveMemberEdition("v2-edition");
    setClock(BASE + 6000);
    const result = store.activateCollectionEdition(second.edition, second.definitionsMap, "admin");
    expect(result.status).toBe("activated");
    expect(store.activeCollectionEdition()?.editionKey).toBe("v2-edition");
  });

  it("old editionのmanifestはclose後も読み取り可能", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    const stored = store.collectionEdition("v1-edition");
    expect(stored?.members.length).toBe(5);
    expect(stored?.closedAt).toBe(BASE + 5000);
  });

  it("activeでないeditionをcloseしようとするとreject", () => {
    const { store, setClock } = setup();
    const first = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(first.edition, first.definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    const second = fiveMemberEdition("v2-edition");
    setClock(BASE + 6000);
    store.activateCollectionEdition(second.edition, second.definitionsMap, "admin");

    // v1-editionは既にclosed済み（already_closedとして返る）。
    // 未activateの全く新しいeditionKeyをcloseしようとするとnot foundになる別ケースも確認。
    expect(() => store.closeCollectionEdition("v3-edition-never-activated", "admin")).toThrow(/not found/);
  });
});

describe("active edition integrity（§14, §28）", () => {
  it("active pointerがclosed済みeditionを指すとconstructor reject（FK自体は満たすが構造として不整合）", () => {
    const { db, store, setClock } = setup();
    const closedOne = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(closedOne.edition, closedOne.definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    const activeOne = fiveMemberEdition("v2-edition");
    setClock(BASE + 6000);
    store.activateCollectionEdition(activeOne.edition, activeOne.definitionsMap, "admin");

    // active pointerを、既にclosed済みのv1-editionへ書き換える——FK自体は
    // v1-editionが実在するため満たすが、「activeがclosed editionを指している」
    // という構造矛盾はforeign_key_checkでは検出できず、collection integrityだけが拾う。
    db.prepare(`UPDATE title_collection_state SET active_edition_key = 'v1-edition' WHERE id = 1`).run();

    expect(() => new TitleV2Store(db, () => BASE + 7000)).toThrow(/does not reference an existing unclosed edition/);
  });

  it("unclosed editionが複数存在するとconstructor reject", () => {
    const { db, store, setClock } = setup();
    const first = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(first.edition, first.definitionsMap, "admin");

    // 直接SQLで2つ目のunclosed editionを作る（通常APIでは作れない状態）。
    db.prepare(
      `INSERT INTO title_collection_editions
         (edition_key, manifest_hash, started_collecting, collector_habit, still_collecting,
          thousand_marks_count, thousand_marks_domains, almost_complete_remaining, activated_at, activated_by)
       VALUES ('rogue-edition', 'x', 1, 2, 3, 5, 2, 1, ?, 'test')`,
    ).run(BASE + 2000);

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/unclosed editions exist/);
  });

  it("manifest_hashの改竄をconstructor reject", () => {
    const { db, store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    db.prepare(`UPDATE title_collection_editions SET manifest_hash = 'corrupted' WHERE edition_key = 'v1-edition'`).run();

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/does not match the hash recomputed/);
  });
});

describe("runtime compatibility API（§15）", () => {
  it("active editionとruntime manifestが一致すればthrowしない", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    expect(() => store.assertActiveCollectionEditionMatchesRuntime(edition, definitionsMap)).not.toThrow();
  });

  it("editionKeyが食い違えばthrow", () => {
    const { store, setClock } = setup();
    const activated = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(activated.edition, activated.definitionsMap, "admin");

    const different = fiveMemberEdition("v2-edition");
    expect(() => store.assertActiveCollectionEditionMatchesRuntime(different.edition, different.definitionsMap)).toThrow(
      /active collection edition mismatch/,
    );
  });

  it("同editionKeyでもruntime側のmanifestが食い違えばthrow（drift検知）", () => {
    const { store, setClock } = setup();
    const activated = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(activated.edition, activated.definitionsMap, "admin");

    const driftedRuntime: TitleCollectionEdition = {
      ...activated.edition,
      milestones: { ...activated.edition.milestones, thousandMarks: { count: 4, domains: 2 } },
    };
    expect(() =>
      store.assertActiveCollectionEditionMatchesRuntime(driftedRuntime, activated.definitionsMap),
    ).toThrow(/does not match the runtime contract/);
  });

  it("active editionが無いのにruntimeがactiveを期待するとthrow", () => {
    const { store } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    expect(() => store.assertActiveCollectionEditionMatchesRuntime(edition, definitionsMap)).toThrow(
      /no active collection edition persisted/,
    );
  });
});

describe("historical repair proof（§16, §27）", () => {
  it("closedAt以前にawarded_atがある（earned_atはNULL）→ old editionでowned扱い", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap, a } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    setClock(BASE + 2500); // < closedAt
    award(store, "alice", a, BASE + 2500, null);

    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    const progress = store.collectionEditionProgress("alice", "v1-edition");
    expect(progress.state).toBe("closed");
    expect(progress.collectionOwnedCount).toBe(1);
  });

  it("close後award・earned_atがclosedAt以前 → historical repairとしてowned扱い", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap, b } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    setClock(BASE + 6000); // awarded_at > closedAt
    award(store, "bob", b, BASE + 6000, BASE + 2500); // earned_at <= closedAt

    const progress = store.collectionEditionProgress("bob", "v1-edition");
    expect(progress.collectionOwnedCount).toBe(1);
  });

  it("close後award・earned_at=NULL → owned扱いしない", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap, c } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    setClock(BASE + 6000);
    award(store, "carol", c, BASE + 6000, null);

    const progress = store.collectionEditionProgress("carol", "v1-edition");
    expect(progress.collectionOwnedCount).toBe(0);
    // 通常のownershipとしては成立している（closed edition proofだけが対象外）。
    expect(store.hasOwnership("carol", c.key)).toBe(true);
  });

  it("close後award・earned_atがclosedAtより後 → owned扱いしない", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap, d } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    setClock(BASE + 7000);
    award(store, "dave", d, BASE + 7000, BASE + 6000); // earned_at(6000) > closedAt(5000)

    const progress = store.collectionEditionProgress("dave", "v1-edition");
    expect(progress.collectionOwnedCount).toBe(0);
  });

  it("close後の通常取得はold edition collection/full-clear countを増やさない（§5相当）", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap, a, b, c, d, e } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");
    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    const before = store.collectionEditionProgress("erin", "v1-edition");
    expect(before.collectionOwnedCount).toBe(0);
    expect(before.fullClearOwnedCount).toBe(0);

    // close後、fullClearRequiredなa/bを含む全メンバーを普通に取得する（earned_at無し）。
    setClock(BASE + 6000);
    for (const def of [a, b, c, d, e]) award(store, "erin", def, BASE + 6000, null);

    const after = store.collectionEditionProgress("erin", "v1-edition");
    expect(after.collectionOwnedCount).toBe(0);
    expect(after.fullClearOwnedCount).toBe(0);
    expect(after.fullClearComplete).toBe(false);
  });

  it("active editionでは現在のownershipがそのまま反映される", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap, a, b } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    setClock(BASE + 3000);
    award(store, "frank", a, BASE + 3000, null);
    award(store, "frank", b, BASE + 3000, null);

    const progress = store.collectionEditionProgress("frank", "v1-edition");
    expect(progress.state).toBe("active");
    expect(progress.collectionOwnedCount).toBe(2);
    expect(progress.fullClearOwnedCount).toBe(2);
    expect(progress.fullClearComplete).toBe(true);
  });

  it("domain breadthもclosed proofでfreezeする", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap, a, b, d } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    // a,bはdomain-aでclose前に取得。dはdomain-bだがclose後にearned_at無しで取得
    // ——closed proofの対象外なので、domain breadthはdomain-a(1件)のまま増えない。
    setClock(BASE + 2500);
    award(store, "grace", a, BASE + 2500, null);
    award(store, "grace", b, BASE + 2500, null);

    setClock(BASE + 5000);
    store.closeCollectionEdition("v1-edition", "admin");

    setClock(BASE + 6000);
    award(store, "grace", d, BASE + 6000, null);

    const progress = store.collectionEditionProgress("grace", "v1-edition");
    expect(progress.collectionOwnedDomainCount).toBe(1); // domain-aだけ
    expect(progress.collectionTotalDomainCount).toBe(2); // domain-a/domain-b
  });
});

describe("collectionEditionProgress の hidden title leak防止（§18）", () => {
  it("返却オブジェクトはcount/domain/complete系のみで、titleKeyを含まない", () => {
    const { store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    const progress = store.collectionEditionProgress("henry", "v1-edition");
    expect(Object.keys(progress).sort()).toEqual(
      [
        "collectionOwnedCount",
        "collectionOwnedDomainCount",
        "collectionTotalCount",
        "collectionTotalDomainCount",
        "editionKey",
        "fullClearComplete",
        "fullClearOwnedCount",
        "fullClearRemainingCount",
        "fullClearRequiredCount",
        "state",
      ].sort(),
    );
    expect(JSON.stringify(progress)).not.toMatch(/v2\.test\./);
  });
});

describe("atomicity（§21）", () => {
  it("collection activation: edition insert成功 → member insert失敗 → edition/state pointer全部rollback", () => {
    const { db, store, setClock } = setup();
    db.exec(`
      CREATE TRIGGER sabotage_collection_member_insert
      BEFORE INSERT ON title_collection_members
      WHEN NEW.title_key = 'v2.test.e'
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for collection activation atomicity test');
      END;
    `);
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);

    expect(() => store.activateCollectionEdition(edition, definitionsMap, "admin")).toThrow(/sabotaged for collection activation/);
    expect(store.collectionEdition("v1-edition")).toBeNull();
    expect(store.activeCollectionEdition()).toBeNull();
  });

  it("collection close: edition close update成功 → state pointer clear失敗 → close自体rollback", () => {
    const { db, store, setClock } = setup();
    const { edition, definitionsMap } = fiveMemberEdition("v1-edition");
    setClock(BASE + 2000);
    store.activateCollectionEdition(edition, definitionsMap, "admin");

    db.exec(`
      CREATE TRIGGER sabotage_collection_state_clear
      BEFORE UPDATE ON title_collection_state
      WHEN OLD.active_edition_key = 'v1-edition'
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for collection close atomicity test');
      END;
    `);

    setClock(BASE + 5000);
    expect(() => store.closeCollectionEdition("v1-edition", "admin")).toThrow(/sabotaged for collection close/);

    // closed_at側だけが先に確定してactive pointerがrollbackされない、という
    // half stateになっていないことを確認する。
    expect(store.collectionEdition("v1-edition")?.closedAt).toBeNull();
    expect(store.activeCollectionEdition()?.editionKey).toBe("v1-edition");
  });
});
