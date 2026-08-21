import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { defineBehaviorTitle, type TitleScopePolicy } from "../src/titles/v2-contract.js";
import { resolveTitleScope, type ResolvedTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import {
  assertValidAwardFacts,
  assertValidFactsVersion,
  MAX_AWARD_FACTS_BYTES,
} from "../src/titles/v2-award-facts.js";

/** JST 2026-08-20 00:00:00 を秒0とする、award永続化テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const NO_FACTS = { version: 1, data: {} };

function setup() {
  const db = openDb(":memory:");
  new BumpCounter(db);
  // catalog epochはBASEで施行する（既存のscope期待値と揃える）。施行後、clockを
  // BASE+1000へ進める——このファイルのシンプルなテストはobservedAt=BASE+100前後しか
  // 使わないため、常にawardedAt(=clock())>=scope.observedAtを満たす。8月/9月の実日付を
  // 使うテスト（同user・別scope、read API）だけは明示的にawardedAtを渡す。
  let clock = BASE;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "v1", actor: "test-setup" });
  clock = BASE + 1000;
  return { db, store };
}

function sampleDef(key: `v2.${string}`, scope: TitleScopePolicy = { type: "global" }) {
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
    scope,
  });
}

describe("schema（§25.A）: award/facts/ownership/rarity sequenceはadditive", () => {
  it("新tableが作られ、title_equipsは消えない", () => {
    const { db } = setup();
    for (const table of ["title_awards", "title_award_facts", "title_rarity_sequences", "title_ownerships", "title_equips"]) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as
        | { name?: string }
        | undefined;
      expect(row?.name, table).toBe(table);
    }
  });

  it("title_award_facts / title_ownershipsはtitle_awardsへFKする", () => {
    const { db } = setup();
    const fk = (table: string) => db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
    expect(fk("title_award_facts").some((r) => r.table === "title_awards")).toBe(true);
    expect(fk("title_ownerships").some((r) => r.table === "title_awards")).toBe(true);
  });
});

describe("first award（§25.B）", () => {
  it("award/facts/ownership rowが作られ、sequence=1・holderCount=1になる", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.first");
    const scope = resolveTitleScope(store, def, BASE + 100);

    const result = store.award({
      userId: "alice",
      titleKey: def.key,
      scope,
      earnedAt: BASE + 50,
      awardedAt: BASE + 100,
      awardFacts: { version: 1, data: { note: "first" } },
    });

    expect(result.status).toBe("awarded");
    expect(result.ownershipCreated).toBe(true);
    expect(result.award).toMatchObject({
      user_id: "alice",
      title_key: def.key,
      scope_key: "global",
      earned_at: BASE + 50,
    });
    expect(result.ownership).toMatchObject({
      user_id: "alice",
      title_key: def.key,
      first_scope_key: "global",
      first_earned_at: BASE + 50,
      acquisition_sequence: 1,
      holder_count_at_acquisition: 1,
    });
    expect(store.awardFacts("alice", def.key, "global")?.data).toEqual({ note: "first" });
    expect(store.hasOwnership("alice", def.key)).toBe(true);
  });
});

describe("second user same title（§25.C）", () => {
  it("別userが同じtitleを獲得するとsequence=2・holderCount=2になる", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.second-user");
    const scope = resolveTitleScope(store, def, BASE + 100);

    store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
    const bobResult = store.award({ userId: "bob", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });

    expect(bobResult.ownershipCreated).toBe(true);
    expect(bobResult.ownership.acquisition_sequence).toBe(2);
    expect(bobResult.ownership.holder_count_at_acquisition).toBe(2);
    // aliceのsequenceはbobの獲得で変わらない。
    expect(store.ownership("alice", def.key)?.acquisition_sequence).toBe(1);
  });
});

describe("same user / same title / second scope（§25.D）", () => {
  it("awardは2行、factsもscope別2行、ownershipは1行のまま、acquisitionSequenceは変わらない", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.repeat", { type: "month" });
    // catalog epochはBASE（2026-08-20 JST）。8月・9月どちらも施行後の時刻を使う。
    const augObservedAt = Math.floor(new Date("2026-08-25T00:00:00+09:00").getTime() / 1000);
    const sepObservedAt = Math.floor(new Date("2026-09-15T00:00:00+09:00").getTime() / 1000);
    const augScope = resolveTitleScope(store, def, augObservedAt);
    const sepScope = resolveTitleScope(store, def, sepObservedAt);
    expect(augScope.scopeKey).not.toBe(sepScope.scopeKey);

    const first = store.award({
      userId: "alice",
      titleKey: def.key,
      scope: augScope,
      earnedAt: null,
      awardedAt: augObservedAt,
      awardFacts: { version: 1, data: { month: "aug" } },
    });
    const second = store.award({
      userId: "alice",
      titleKey: def.key,
      scope: sepScope,
      earnedAt: null,
      awardedAt: sepObservedAt,
      awardFacts: { version: 1, data: { month: "sep" } },
    });

    expect(first.status).toBe("awarded");
    expect(first.ownershipCreated).toBe(true);
    expect(second.status).toBe("awarded");
    expect(second.ownershipCreated).toBe(false); // 2つ目のscopeではownershipは増えない

    const awards = store.listAwards("alice").filter((a) => a.title_key === def.key);
    expect(awards).toHaveLength(2);
    expect(store.awardFacts("alice", def.key, augScope.scopeKey)?.data).toEqual({ month: "aug" });
    expect(store.awardFacts("alice", def.key, sepScope.scopeKey)?.data).toEqual({ month: "sep" });

    const ownerships = store.listOwnerships("alice").filter((o) => o.title_key === def.key);
    expect(ownerships).toHaveLength(1);
    expect(ownerships[0]!.first_scope_key).toBe(augScope.scopeKey);
    expect(second.ownership.acquisition_sequence).toBe(first.ownership.acquisition_sequence);
  });
});

describe("duplicate same award（§25.E）", () => {
  it("同じ(user,title,scope)への再awardはalready_awarded。facts/ownership/sequenceは変わらない", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.dup");
    const scope = resolveTitleScope(store, def, BASE + 100);

    const first = store.award({
      userId: "alice",
      titleKey: def.key,
      scope,
      earnedAt: null,
      awardFacts: { version: 1, data: { v: 1 } },
    });
    // 2回目は違うfactsを渡してみても、先に成立したsnapshotが勝つ。
    const second = store.award({
      userId: "alice",
      titleKey: def.key,
      scope,
      earnedAt: null,
      awardFacts: { version: 1, data: { v: 2 } },
    });

    expect(second.status).toBe("already_awarded");
    expect(second.ownershipCreated).toBe(false);
    expect(store.awardFacts("alice", def.key, scope.scopeKey)?.data).toEqual({ v: 1 });
    expect(second.ownership).toEqual(first.ownership);
    expect(second.ownership.acquisition_sequence).toBe(first.ownership.acquisition_sequence);
  });
});

describe("award facts validator（§25.F）", () => {
  it("facts_versionは正の整数を要求する", () => {
    expect(() => assertValidFactsVersion(0)).toThrow(/positive integer/);
    expect(() => assertValidFactsVersion(-1)).toThrow(/positive integer/);
    expect(() => assertValidFactsVersion(1.5)).toThrow(/positive integer/);
    expect(() => assertValidFactsVersion(1)).not.toThrow();
  });

  it("{}はvalid", () => {
    expect(() => assertValidAwardFacts({})).not.toThrow();
  });

  it("nestedな安全なaggregateはvalid", () => {
    expect(() =>
      assertValidAwardFacts({ distinctUserCount: 3, buckets: { solo: 10, group: 5 }, tags: ["a", "b"] }),
    ).not.toThrow();
  });

  it("NaNをreject", () => {
    expect(() => assertValidAwardFacts({ n: NaN })).toThrow(/non-finite/);
  });

  it("Infinity / -Infinityをreject", () => {
    expect(() => assertValidAwardFacts({ n: Infinity })).toThrow(/non-finite/);
    expect(() => assertValidAwardFacts({ n: -Infinity })).toThrow(/non-finite/);
  });

  it("bigintをreject", () => {
    expect(() => assertValidAwardFacts({ n: 10n as never })).toThrow(/bigint/);
  });

  it("Dateをreject", () => {
    expect(() => assertValidAwardFacts({ d: new Date() })).toThrow(/Date/);
  });

  it("functionをreject", () => {
    expect(() => assertValidAwardFacts({ f: () => 1 })).toThrow(/function/);
  });

  it("undefinedをreject", () => {
    expect(() => assertValidAwardFacts({ u: undefined })).toThrow(/undefined/);
  });

  it("symbolをreject", () => {
    expect(() => assertValidAwardFacts({ s: Symbol("x") })).toThrow(/symbol/);
  });

  it("class instanceをreject", () => {
    class Foo {
      x = 1;
    }
    expect(() => assertValidAwardFacts({ foo: new Foo() })).toThrow(/plain object required/);
  });

  it("circular referenceをreject", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => assertValidAwardFacts(o)).toThrow(/circular reference/);
  });

  it("depth超過をreject", () => {
    // a(1) -> b(2) -> c(3) -> d(4) -> e(5): MAX_AWARD_FACTS_DEPTH(4)を超える
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(() => assertValidAwardFacts(deep)).toThrow(/exceeds max depth/);
  });

  it("4KB超過をreject", () => {
    const big = { blob: "x".repeat(MAX_AWARD_FACTS_BYTES) };
    expect(() => assertValidAwardFacts(big)).toThrow(/exceeds limit/);
  });

  it("明白なidentity-bearing keyをexact matchでreject", () => {
    for (const key of [
      "userId",
      "user_id",
      "counterpartUserId",
      "counterpart_user_id",
      "channelId",
      "channel_id",
      "messageId",
      "message_id",
    ]) {
      expect(() => assertValidAwardFacts({ [key]: "x" }), key).toThrow(/forbidden key/);
    }
  });

  it("__proto__/constructor/prototypeをprototype pollution対策としてreject", () => {
    // object literalの`{__proto__: ...}`はprototypeを変えるだけでown propertyにならないため、
    // JSON.parse経由（facts_jsonの往復を想定）で再現する。
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => assertValidAwardFacts(polluted)).toThrow(/forbidden key/);
    expect(() => assertValidAwardFacts({ constructor: "x" })).toThrow(/forbidden key/);
    expect(() => assertValidAwardFacts({ prototype: "x" })).toThrow(/forbidden key/);
  });

  it("安全なaggregate値（distinctUserCount等）まで雑にrejectしない", () => {
    expect(() => assertValidAwardFacts({ distinctUserCount: 5, friend: "Alice" })).not.toThrow();
    // ↑ note: genericなvalidatorだけではprivacyを完全保証できない実例——
    // `{ friend: "Alice" }` はJSONとして合法なのでvalidatorだけでは弾けない
    // （v2-award-facts.tsのdoc comment参照）。主防御はsafe source境界とrule review。
  });

  it("store.award()もawardFactsを検証し、違反時はDBへ何も書かない", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.bad-facts-store");
    const scope = resolveTitleScope(store, def, BASE + 100);
    expect(() =>
      store.award({
        userId: "alice",
        titleKey: def.key,
        scope,
        earnedAt: null,
        awardFacts: { version: 1, data: { userId: "alice" } as never },
      }),
    ).toThrow(/forbidden key/);
    expect(store.listAwards("alice")).toEqual([]);
  });
});

describe("scope guard（§25.G）", () => {
  it("legitimateなbranded scopeは通る", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.legit-scope");
    const scope = resolveTitleScope(store, def, BASE + 100);
    expect(() => store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS })).not.toThrow();
  });

  it("forgeされたscopeはStore.award()でfail-closedする", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.forged-scope");
    const legit = resolveTitleScope(store, def, BASE + 100);
    const forged = {
      scopeKey: legit.scopeKey,
      start: legit.start,
      endExclusive: legit.endExclusive,
      observedAt: legit.observedAt,
    } as unknown as ResolvedTitleScope;

    expect(() =>
      store.award({ userId: "alice", titleKey: def.key, scope: forged, earnedAt: null, awardFacts: NO_FACTS }),
    ).toThrow(/not produced by resolveTitleScope/);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("earnedAtがscope.startより前ならreject", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.early-earned");
    const scope = resolveTitleScope(store, def, BASE + 100);
    expect(() =>
      store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: scope.start - 1, awardFacts: NO_FACTS }),
    ).toThrow(/outside the resolved scope window/);
  });

  it("earnedAtがeffectiveEnd以降（境界含む）ならreject", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.late-earned");
    const scope = resolveTitleScope(store, def, BASE + 100); // global: effectiveEnd === observedAt === BASE+100
    expect(() =>
      store.award({
        userId: "alice",
        titleKey: def.key,
        scope,
        earnedAt: BASE + 100,
        awardedAt: BASE + 200,
        awardFacts: NO_FACTS,
      }),
    ).toThrow(/outside the resolved scope window/);
  });

  it("zero-width scope（CATALOG_EPOCH===observedAt）ではnon-null earnedAtは常にreject、nullは通る", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.zero-width", { type: "catalog" });
    const scope = resolveTitleScope(store, def, BASE); // observedAt===catalog epoch(BASE) -> start===observedAt
    expect(scope.start).toBe(scope.observedAt);

    expect(() =>
      store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: BASE, awardFacts: NO_FACTS }),
    ).toThrow(/outside the resolved scope window/);
    expect(() =>
      store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS }),
    ).not.toThrow();
  });
});

describe("atomicity（§25.H）", () => {
  it("facts INSERT失敗時、award/facts/ownership/sequenceが全部rollbackされる", () => {
    const { db, store } = setup();
    // title_award_factsへのINSERTを、特定のuser_idに対してのみ意図的に失敗させるtrigger
    // （実装コード自体は変更しない、テストDB限定のsabotage）。
    db.exec(`
      CREATE TRIGGER sabotage_facts_insert
      BEFORE INSERT ON title_award_facts
      WHEN NEW.user_id = 'sabotage-user'
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for atomicity test');
      END;
    `);

    const def = sampleDef("v2.test.atomic");
    const scope = resolveTitleScope(store, def, BASE + 100);

    expect(() =>
      store.award({ userId: "sabotage-user", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS }),
    ).toThrow(/sabotaged for atomicity test/);

    expect(store.listAwards("sabotage-user")).toEqual([]);
    expect(store.hasOwnership("sabotage-user", def.key)).toBe(false);
    expect(store.awardFacts("sabotage-user", def.key, scope.scopeKey)).toBeNull();

    // rarity sequenceも消費されていないこと: 別userが同titleを獲得するとsequence=1になる
    // （sabotageされた呼び出しがsequenceを1つ進めていれば2になってしまう）。
    const okResult = store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
    expect(okResult.ownership.acquisition_sequence).toBe(1);
  });
});

describe("migration / integrity（§25.I）", () => {
  it("旧foundation形式のaward rowだけ存在するDBでは、facts欠損をintegrity errorとして検出する（偽factsをbackfillしない）", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.legacy");
    const scope = resolveTitleScope(store, def, BASE + 100);
    // 旧形式を模して、title_awardsへ直接INSERT（facts/ownershipを経由しない）。
    db.prepare(`INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, ?, ?)`).run(
      "legacy-user",
      def.key,
      scope.scopeKey,
      null,
      BASE,
    );

    expect(() =>
      store.award({ userId: "legacy-user", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS }),
    ).toThrow(/award row exists.*without award facts/);
  });

  it("award行はあるがownership行が無い状態も、integrity errorとして検出する", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.legacy-ownership");
    const scope = resolveTitleScope(store, def, BASE + 100);
    db.prepare(`INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, ?, ?)`).run(
      "orphan-user",
      def.key,
      scope.scopeKey,
      null,
      BASE,
    );
    db.prepare(
      `INSERT INTO title_award_facts (user_id, title_key, scope_key, facts_version, facts_json, captured_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("orphan-user", def.key, scope.scopeKey, 1, "{}", BASE);

    expect(() =>
      store.award({ userId: "orphan-user", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS }),
    ).toThrow(/without an ownership row/);
  });

  it("award()は外側transaction内から呼べない（applyCatalog()と同じfail-closed）", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.outer-tx");
    const scope = resolveTitleScope(store, def, BASE + 100);
    const outer = db.transaction(() =>
      store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS }),
    );
    expect(() => outer()).toThrow(/outside an existing transaction/);
    expect(store.listAwards("alice")).toEqual([]);
  });
});

describe("ownership read API（§25.17）", () => {
  it("hasOwnership/ownership/listOwnershipsはscope別historyと混ざらない", () => {
    const { store } = setup();
    const monthDef = sampleDef("v2.test.read-api", { type: "month" });
    const augObservedAt = Math.floor(new Date("2026-08-25T00:00:00+09:00").getTime() / 1000);
    const sepObservedAt = Math.floor(new Date("2026-09-15T00:00:00+09:00").getTime() / 1000);
    const augScope = resolveTitleScope(store, monthDef, augObservedAt);
    const sepScope = resolveTitleScope(store, monthDef, sepObservedAt);

    expect(store.hasOwnership("alice", monthDef.key)).toBe(false);
    store.award({
      userId: "alice",
      titleKey: monthDef.key,
      scope: augScope,
      earnedAt: null,
      awardedAt: augObservedAt,
      awardFacts: NO_FACTS,
    });
    store.award({
      userId: "alice",
      titleKey: monthDef.key,
      scope: sepScope,
      earnedAt: null,
      awardedAt: sepObservedAt,
      awardFacts: NO_FACTS,
    });

    expect(store.hasOwnership("alice", monthDef.key)).toBe(true);
    expect(store.ownership("alice", monthDef.key)?.first_scope_key).toBe(augScope.scopeKey);
    // listOwnershipsは(user,title)単位——2 award行があってもownershipは1件だけ。
    expect(store.listOwnerships("alice")).toHaveLength(1);
    // listAwardsはscope別のhistoryのまま2件。
    expect(store.listAwards("alice")).toHaveLength(2);
  });
});

describe("scope title provenance（title substitution防止）", () => {
  it("title Aで正規resolveしたscopeをtitle Bのawardへ渡すとreject（scopeKeyが同じ'global'でも）", () => {
    const { store } = setup();
    const defA = sampleDef("v2.test.title-a");
    const defB = sampleDef("v2.test.title-b");
    // どちらもscope:{type:"global"}なので、scopeKeyの文字列は両方とも"global"で
    // 一致してしまう——scopeKeyの一致検査だけではsubstitutionを検出できない実例。
    const scopeForA = resolveTitleScope(store, defA, BASE + 100);
    expect(scopeForA.scopeKey).toBe("global");

    expect(() =>
      store.award({ userId: "alice", titleKey: defB.key, scope: scopeForA, earnedAt: null, awardFacts: NO_FACTS }),
    ).toThrow(/resolved for a different title/);
    expect(store.listAwards("alice")).toEqual([]);
  });

  it("同titleのために正規resolveしたscopeは通る", () => {
    const { store } = setup();
    const defA = sampleDef("v2.test.title-a2");
    const scopeForA = resolveTitleScope(store, defA, BASE + 100);
    expect(() =>
      store.award({ userId: "alice", titleKey: defA.key, scope: scopeForA, earnedAt: null, awardFacts: NO_FACTS }),
    ).not.toThrow();
  });
});

describe("Store construction時の全体integrity検証（lazy checkにしない）", () => {
  it("legacy award行だけ存在するDBへ新しいTitleV2Storeを構築すると、constructorでintegrity違反としてthrowする", () => {
    const { db } = setup();
    const def = sampleDef("v2.test.ctor-integrity");
    // 旧foundation形式を模して、Store.award()を経由せず直接INSERT。
    db.prepare(`INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, ?, ?)`).run(
      "legacy-user",
      def.key,
      "global",
      null,
      BASE,
    );
    expect(() => new TitleV2Store(db, () => BASE + 1000)).toThrow(/persistence integrity violation/);
  });

  it("retired titleのlegacy awardは、hasAward()経由でもalready_awarded扱いせずfail-closedする", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.retired-legacy");
    const scope = resolveTitleScope(store, def, BASE + 100);
    // 正規のaward()を経由せず、facts/ownershipを欠損させたaward行を直接作る
    // （retired titleがhasAward()だけを見て既存award有無を判定する経路を想定）。
    db.prepare(`INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, ?, ?)`).run(
      "alice",
      def.key,
      scope.scopeKey,
      null,
      BASE + 200,
    );
    expect(() => store.hasAward("alice", def.key, scope.scopeKey)).toThrow(/without award facts/);
  });
});

describe("awardedAt chronology（scope.observedAtとの整合、§3）", () => {
  it("awardedAt < scope.observedAtならreject", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.chrono-early");
    const scope = resolveTitleScope(store, def, BASE + 100);
    expect(() =>
      store.award({
        userId: "alice",
        titleKey: def.key,
        scope,
        earnedAt: null,
        awardedAt: BASE + 99,
        awardFacts: NO_FACTS,
      }),
    ).toThrow(/cannot be before the scope's observedAt/);
  });

  it("awardedAt === scope.observedAtならpass", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.chrono-equal");
    const scope = resolveTitleScope(store, def, BASE + 100);
    expect(() =>
      store.award({
        userId: "alice",
        titleKey: def.key,
        scope,
        earnedAt: null,
        awardedAt: BASE + 100,
        awardFacts: NO_FACTS,
      }),
    ).not.toThrow();
  });

  it("historical scope（monthSelector:specific）でも、awardedAtがそのscopeのobservedAt以降ならpass", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.chrono-historical", { type: "month" });
    // 9月に評価しつつ、8月分のhistorical scopeを修復評価する。
    const repairObservedAt = Math.floor(new Date("2026-09-05T00:00:00+09:00").getTime() / 1000);
    const historicalScope = resolveTitleScope(store, def, repairObservedAt, {
      monthSelector: { type: "specific", month: "2026-08" },
    });
    expect(() =>
      store.award({
        userId: "alice",
        titleKey: def.key,
        scope: historicalScope,
        earnedAt: null,
        awardedAt: repairObservedAt,
        awardFacts: NO_FACTS,
      }),
    ).not.toThrow();
  });
});

describe("title_ownerships DB constraints", () => {
  it("UNIQUE(title_key, acquisition_sequence)を直接INSERTで破ろうとするとreject", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.constraint-unique");
    const scope = resolveTitleScope(store, def, BASE + 100);
    store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS }); // sequence=1

    // carolのaward行だけ（FK満たすため）直接作り、aliceと同じsequence=1を主張しようとする。
    db.prepare(`INSERT INTO title_awards (user_id, title_key, scope_key, earned_at, awarded_at) VALUES (?, ?, ?, ?, ?)`).run(
      "carol",
      def.key,
      scope.scopeKey,
      null,
      BASE + 100,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO title_ownerships
             (user_id, title_key, first_scope_key, first_earned_at, first_awarded_at, acquisition_sequence, holder_count_at_acquisition)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("carol", def.key, scope.scopeKey, null, BASE + 100, 1, 2),
    ).toThrow();
  });

  it("CHECK(acquisition_sequence >= 1)を直接INSERTで破ろうとするとreject", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.constraint-seq");
    const scope = resolveTitleScope(store, def, BASE + 100);
    store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
    db.prepare(`DELETE FROM title_ownerships WHERE user_id = ? AND title_key = ?`).run("alice", def.key);

    expect(() =>
      db
        .prepare(
          `INSERT INTO title_ownerships
             (user_id, title_key, first_scope_key, first_earned_at, first_awarded_at, acquisition_sequence, holder_count_at_acquisition)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("alice", def.key, scope.scopeKey, null, BASE + 100, 0, 1),
    ).toThrow();
  });

  it("CHECK(holder_count_at_acquisition >= 1)を直接INSERTで破ろうとするとreject", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.constraint-holder");
    const scope = resolveTitleScope(store, def, BASE + 100);
    store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
    db.prepare(`DELETE FROM title_ownerships WHERE user_id = ? AND title_key = ?`).run("alice", def.key);

    expect(() =>
      db
        .prepare(
          `INSERT INTO title_ownerships
             (user_id, title_key, first_scope_key, first_earned_at, first_awarded_at, acquisition_sequence, holder_count_at_acquisition)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("alice", def.key, scope.scopeKey, null, BASE + 100, 1, 0),
    ).toThrow();
  });

  it("CHECK(first_earned_at <= first_awarded_at)を直接INSERTで破ろうとするとreject", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.constraint-earned");
    const scope = resolveTitleScope(store, def, BASE + 100);
    store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
    db.prepare(`DELETE FROM title_ownerships WHERE user_id = ? AND title_key = ?`).run("alice", def.key);

    expect(() =>
      db
        .prepare(
          `INSERT INTO title_ownerships
             (user_id, title_key, first_scope_key, first_earned_at, first_awarded_at, acquisition_sequence, holder_count_at_acquisition)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("alice", def.key, scope.scopeKey, BASE + 150, BASE + 100, 1, 1),
    ).toThrow();
  });
});

describe("Award Factsのvalidation/serialization単一pass化（TOCTOU防止）", () => {
  it("getterを持つobjectのプロパティはちょうど1回だけ読まれ、その値がそのまま永続化される", () => {
    const { store } = setup();
    const def = sampleDef("v2.test.single-pass");
    const scope = resolveTitleScope(store, def, BASE + 100);

    let reads = 0;
    const data = {
      get value() {
        reads += 1;
        return reads; // 呼び出しごとに違う値を返す、TOCTOUを狙った意地悪なgetter
      },
    };

    const result = store.award({
      userId: "alice",
      titleKey: def.key,
      scope,
      earnedAt: null,
      awardFacts: { version: 1, data: data as never },
    });

    // validationとserializationが別々のpassだと2回（またはそれ以上）読まれてしまうが、
    // 単一passなら1回しか読まれない——読んだ値と永続化される値が必ず一致する。
    expect(reads).toBe(1);
    expect(result.status).toBe("awarded");
    expect(store.awardFacts("alice", def.key, scope.scopeKey)?.data).toEqual({ value: 1 });
  });
});

describe("awardFacts() read integrity（§18）", () => {
  it("facts_versionがDB上で壊れているとintegrity error", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.corrupt-version");
    const scope = resolveTitleScope(store, def, BASE + 100);
    store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
    // DBのCHECK(facts_version >= 1)は非整数までは弾かない（SQLiteは動的型付けのため
    // 1.5 >= 1は真）——application層のassertValidFactsVersion()（整数チェック）が
    // ここを塞ぐことを確認する。
    db.prepare(`UPDATE title_award_facts SET facts_version = 1.5 WHERE user_id = ? AND title_key = ?`).run("alice", def.key);

    expect(() => store.awardFacts("alice", def.key, scope.scopeKey)).toThrow(/integrity violation/);
  });

  it("captured_atがDB上で壊れているとintegrity error", () => {
    const { db, store } = setup();
    const def = sampleDef("v2.test.corrupt-captured");
    const scope = resolveTitleScope(store, def, BASE + 100);
    store.award({ userId: "alice", titleKey: def.key, scope, earnedAt: null, awardFacts: NO_FACTS });
    db.prepare(`UPDATE title_award_facts SET captured_at = -1 WHERE user_id = ? AND title_key = ?`).run("alice", def.key);

    expect(() => store.awardFacts("alice", def.key, scope.scopeKey)).toThrow(/invalid captured_at/);
  });
});
