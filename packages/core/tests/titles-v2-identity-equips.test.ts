import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { defineBehaviorTitle } from "../src/titles/v2-contract.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

/** JST 2026-08-20 00:00:00 を秒0とする、identity equipテスト用の基準時刻。 */
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

function titleDef(key: `v2.${string}`, lifecycle: "active" | "retired" | "disabled" = "active") {
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
    themeKey: "identity-test-theme",
    groupKey: "identity-test-group",
    collectionDomainKey: "identity-test-domain",
    scope: { type: "global" as const },
  });
}

function award(store: TitleV2Store, userId: string, key: `v2.${string}`, observedAt: number) {
  const def = titleDef(key);
  const scope = resolveTitleScope(store, def, observedAt);
  return store.award({ userId, titleKey: key, scope, earnedAt: null, awardFacts: NO_FACTS });
}

describe("3-slot identity equip（§35）", () => {
  it("owned title equip", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "alice", "v2.moon", BASE + 2000);

    const result = store.equipIdentity("alice", 1, { kind: "title", titleKey: "v2.moon" });
    expect(result).toEqual({ userId: "alice", slot: 1, identity: { kind: "title", titleKey: "v2.moon" } });
    expect(store.identityEquip("alice", 1)).toEqual(result);
  });

  it("unowned title reject", () => {
    const { store } = setup();
    expect(() => store.equipIdentity("bob", 1, { kind: "title", titleKey: "v2.ghost" })).toThrow(/unowned/);
  });

  it("unlocked rank title equip", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    store.reconcileRankTitleUnlocks("carol", "text", 5);

    const result = store.equipIdentity("carol", 1, { kind: "rank_title", rankTitleKey: "rank.text.lv005" });
    expect(result.identity).toEqual({ kind: "rank_title", rankTitleKey: "rank.text.lv005" });
  });

  it("locked rank title reject", () => {
    const { store } = setup();
    expect(() =>
      store.equipIdentity("dave", 1, { kind: "rank_title", rankTitleKey: "rank.text.lv100" }),
    ).toThrow(/locked rank title/);
  });

  it("title + rank title mixed slots", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "erin", "v2.moon", BASE + 2000);
    store.reconcileRankTitleUnlocks("erin", "text", 5);

    store.equipIdentity("erin", 1, { kind: "title", titleKey: "v2.moon" });
    store.equipIdentity("erin", 2, { kind: "rank_title", rankTitleKey: "rank.text.lv005" });
    expect(store.listIdentityEquips("erin")).toEqual([
      { userId: "erin", slot: 1, identity: { kind: "title", titleKey: "v2.moon" } },
      { userId: "erin", slot: 2, identity: { kind: "rank_title", rankTitleKey: "rank.text.lv005" } },
    ]);
  });

  it("same title cannot duplicate（同一identityが複数slotへ入らない、moveされる）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "frank", "v2.moon", BASE + 2000);

    store.equipIdentity("frank", 1, { kind: "title", titleKey: "v2.moon" });
    store.equipIdentity("frank", 2, { kind: "title", titleKey: "v2.moon" });
    expect(store.listIdentityEquips("frank")).toEqual([
      { userId: "frank", slot: 2, identity: { kind: "title", titleKey: "v2.moon" } },
    ]);
  });

  it("same rank title cannot duplicate", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    store.reconcileRankTitleUnlocks("grace", "text", 5);

    store.equipIdentity("grace", 1, { kind: "rank_title", rankTitleKey: "rank.text.lv005" });
    store.equipIdentity("grace", 3, { kind: "rank_title", rankTitleKey: "rank.text.lv005" });
    expect(store.listIdentityEquips("grace")).toEqual([
      { userId: "grace", slot: 3, identity: { kind: "rank_title", rankTitleKey: "rank.text.lv005" } },
    ]);
  });

  it("identity move slot1→slot3、target replacement（spec例: 火種/囁く者からmove）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "henry", "v2.moon", BASE + 2000); // 「火種」相当
    store.reconcileRankTitleUnlocks("henry", "text", 5); // 「囁く者」相当

    store.equipIdentity("henry", 1, { kind: "title", titleKey: "v2.moon" });
    store.equipIdentity("henry", 2, { kind: "rank_title", rankTitleKey: "rank.text.lv005" });

    store.equipIdentity("henry", 3, { kind: "title", titleKey: "v2.moon" });
    expect(store.listIdentityEquips("henry")).toEqual([
      { userId: "henry", slot: 2, identity: { kind: "rank_title", rankTitleKey: "rank.text.lv005" } },
      { userId: "henry", slot: 3, identity: { kind: "title", titleKey: "v2.moon" } },
    ]);
  });

  it("target replacement: slotに既に別identityがあればunequipされる", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "iris", "v2.moon", BASE + 2000);
    award(store, "iris", "v2.sun", BASE + 2000);

    store.equipIdentity("iris", 1, { kind: "title", titleKey: "v2.moon" });
    store.equipIdentity("iris", 1, { kind: "title", titleKey: "v2.sun" });
    expect(store.listIdentityEquips("iris")).toEqual([
      { userId: "iris", slot: 1, identity: { kind: "title", titleKey: "v2.sun" } },
    ]);
  });

  it("same identity same slot idempotent（no-op）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "jack", "v2.moon", BASE + 2000);

    store.equipIdentity("jack", 1, { kind: "title", titleKey: "v2.moon" });
    const second = store.equipIdentity("jack", 1, { kind: "title", titleKey: "v2.moon" });
    expect(second).toEqual({ userId: "jack", slot: 1, identity: { kind: "title", titleKey: "v2.moon" } });
    expect(store.listIdentityEquips("jack").length).toBe(1);
  });

  it("unequip", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "kelly", "v2.moon", BASE + 2000);
    store.equipIdentity("kelly", 1, { kind: "title", titleKey: "v2.moon" });

    store.unequipIdentity("kelly", 1);
    expect(store.listIdentityEquips("kelly")).toEqual([]);
    expect(store.identityEquip("kelly", 1)).toBeNull();
  });

  it("slots 0/4 reject", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "laura", "v2.moon", BASE + 2000);
    expect(() => store.equipIdentity("laura", 0, { kind: "title", titleKey: "v2.moon" })).toThrow(/slot/);
    expect(() => store.equipIdentity("laura", 4, { kind: "title", titleKey: "v2.moon" })).toThrow(/slot/);
    expect(() => store.unequipIdentity("laura", 0)).toThrow(/slot/);
  });

  it("list ordered 1→3", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "mallory", "v2.a", BASE + 2000);
    award(store, "mallory", "v2.b", BASE + 2000);
    award(store, "mallory", "v2.c", BASE + 2000);
    store.equipIdentity("mallory", 3, { kind: "title", titleKey: "v2.c" });
    store.equipIdentity("mallory", 1, { kind: "title", titleKey: "v2.a" });
    store.equipIdentity("mallory", 2, { kind: "title", titleKey: "v2.b" });
    expect(store.listIdentityEquips("mallory").map((e) => e.slot)).toEqual([1, 2, 3]);
  });

  it("title equipはscopeKeyを必要としない（awardが複数scopeでもtitleKey単位で1つ）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    const monthDef = defineBehaviorTitle({
      kind: "behavior",
      key: "v2.monthly",
      catalog: "v1",
      name: "monthly",
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
      scope: { type: "month" as const },
    });
    const augObservedAt = Math.floor(new Date("2026-08-25T00:00:00+09:00").getTime() / 1000);
    const sepObservedAt = Math.floor(new Date("2026-09-15T00:00:00+09:00").getTime() / 1000);
    const augScope = resolveTitleScope(store, monthDef, augObservedAt);
    const sepScope = resolveTitleScope(store, monthDef, sepObservedAt);
    setClock(augObservedAt);
    store.award({ userId: "nathan", titleKey: "v2.monthly", scope: augScope, earnedAt: null, awardFacts: NO_FACTS });
    setClock(sepObservedAt);
    store.award({ userId: "nathan", titleKey: "v2.monthly", scope: sepScope, earnedAt: null, awardFacts: NO_FACTS });

    // scopeKeyを一切渡さずequip可能——ownership(titleKey単位)だけを見る。
    const result = store.equipIdentity("nathan", 1, { kind: "title", titleKey: "v2.monthly" });
    expect(result.identity).toEqual({ kind: "title", titleKey: "v2.monthly" });
  });

  it("retired titleでも既存holderは引き続きequip可能（正本はtitle_ownershipsだけ）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "olivia", "v2.retiring", BASE + 2000);
    // retireするのはruntime definitionだけであり、Storeはtitle_ownershipsしか見ない
    // ——equipIdentity()はdefinitions mapを一切受け取らない。
    expect(() => store.equipIdentity("olivia", 1, { kind: "title", titleKey: "v2.retiring" })).not.toThrow();
  });

  it("現在rank levelはrank-title equipのauthorityではない（unlock済みなら現在levelを問わない）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    store.reconcileRankTitleUnlocks("peter", "text", 100); // 過去にLv100へ到達しunlock

    // 現在levelが再計算で下がっていても（このtestではlevelそのものを持ち出さない——
    // 正本はunlock行の有無だけ）equip可能。
    expect(() => store.equipIdentity("peter", 1, { kind: "rank_title", rankTitleKey: "rank.text.lv100" })).not.toThrow();
  });

  it("restart persistence", () => {
    const { db, store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "quinn", "v2.moon", BASE + 2000);
    store.equipIdentity("quinn", 1, { kind: "title", titleKey: "v2.moon" });

    const restarted = new TitleV2Store(db, () => BASE + 3000);
    expect(restarted.listIdentityEquips("quinn")).toEqual([
      { userId: "quinn", slot: 1, identity: { kind: "title", titleKey: "v2.moon" } },
    ]);
  });

  it("dangling title ownership FK/integrity reject", () => {
    const { db, store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "rachel", "v2.moon", BASE + 2000);
    store.equipIdentity("rachel", 1, { kind: "title", titleKey: "v2.moon" });

    // title_ownershipsだけでなくaward/facts一式も消し、B1の「award行はあるが
    // ownershipが無い」integrityがこの穴を先に拾わないようにする——
    // profile_identity_equips側のdangling ref checkを独立して働かせるため。
    db.pragma("foreign_keys = OFF");
    db.prepare(`DELETE FROM title_award_facts WHERE user_id = 'rachel' AND title_key = 'v2.moon'`).run();
    db.prepare(`DELETE FROM title_ownerships WHERE user_id = 'rachel' AND title_key = 'v2.moon'`).run();
    db.prepare(`DELETE FROM title_awards WHERE user_id = 'rachel' AND title_key = 'v2.moon'`).run();
    db.prepare(`DELETE FROM title_rarity_sequences WHERE title_key = 'v2.moon'`).run();
    db.pragma("foreign_keys = ON");

    expect(() => new TitleV2Store(db, () => BASE + 4000)).toThrow(/without title_ownerships/);
  });

  it("dangling rank unlock FK/integrity reject", () => {
    const { db, store, setClock } = setup();
    setClock(BASE + 2000);
    store.reconcileRankTitleUnlocks("sam", "text", 5);
    store.equipIdentity("sam", 1, { kind: "rank_title", rankTitleKey: "rank.text.lv005" });

    db.pragma("foreign_keys = OFF");
    db.prepare(`DELETE FROM rank_title_unlocks WHERE user_id = 'sam' AND rank_title_key = 'rank.text.lv005'`).run();
    db.pragma("foreign_keys = ON");

    expect(() => new TitleV2Store(db, () => BASE + 4000)).toThrow(/without rank_title_unlocks|foreign_key_check/);
  });
});

describe("atomicity（§36.2, §36.3）", () => {
  it("identity move: old slot DELETE成功 → new INSERT失敗 → old slot restore", () => {
    const { db, store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "tina", "v2.moon", BASE + 2000);
    store.equipIdentity("tina", 1, { kind: "title", titleKey: "v2.moon" });

    db.exec(`
      CREATE TRIGGER sabotage_identity_move_insert
      BEFORE INSERT ON profile_identity_equips
      WHEN NEW.slot = 3
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for identity move atomicity test');
      END;
    `);

    expect(() => store.equipIdentity("tina", 3, { kind: "title", titleKey: "v2.moon" })).toThrow(
      /sabotaged for identity move/,
    );
    // old slot(1)がDELETEされたままにならず、元の状態へrollbackされている。
    expect(store.listIdentityEquips("tina")).toEqual([
      { userId: "tina", slot: 1, identity: { kind: "title", titleKey: "v2.moon" } },
    ]);
  });

  it("identity replace: target deletion成功 → new INSERT失敗 → previous target restore", () => {
    const { db, store, setClock } = setup();
    setClock(BASE + 2000);
    award(store, "uma", "v2.moon", BASE + 2000);
    award(store, "uma", "v2.sun", BASE + 2000);
    store.equipIdentity("uma", 1, { kind: "title", titleKey: "v2.moon" });

    db.exec(`
      CREATE TRIGGER sabotage_identity_replace_insert
      BEFORE INSERT ON profile_identity_equips
      WHEN NEW.title_key = 'v2.sun'
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for identity replace atomicity test');
      END;
    `);

    expect(() => store.equipIdentity("uma", 1, { kind: "title", titleKey: "v2.sun" })).toThrow(
      /sabotaged for identity replace/,
    );
    // slot1のdeleteだけ先に走っていても、previous target（v2.moon）が復元されている
    // （transaction全体がrollbackされ、DELETE自体も取り消される）。
    expect(store.listIdentityEquips("uma")).toEqual([
      { userId: "uma", slot: 1, identity: { kind: "title", titleKey: "v2.moon" } },
    ]);
  });
});
