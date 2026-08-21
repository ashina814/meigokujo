import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { defineBehaviorTitle, type BehaviorTitleDefinition } from "../src/titles/v2-contract.js";
import { resolveTitleScope, type ResolvedTitleScope, type TitleEventScopeProvider } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

/** JST 2026-08-20 00:00:00 を秒0とする、テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);

function titleWith(overrides: Partial<BehaviorTitleDefinition>): BehaviorTitleDefinition {
  return defineBehaviorTitle({
    kind: "behavior",
    key: "v2.test.scope-sample",
    catalog: "v1",
    name: "test",
    emoji: "x",
    description: "テスト用",
    sources: ["bump_events"],
    triggers: ["daily"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey: "sample",
    groupKey: "sample",
    scope: { type: "global" },
    ...overrides,
  });
}

describe("scope resolution（§5, §6, §7）", () => {
  it("global: start=SYSTEM_EPOCH、open-ended", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const scope = resolveTitleScope(store, titleWith({ scope: { type: "global" } }), BASE + 500);
    expect(scope.scopeKey).toBe("global");
    expect(scope.start).toBe(BASE);
    expect(scope.endExclusive).toBeNull();
    expect(scope.observedAt).toBe(BASE + 500);
  });

  it("catalog: start=CATALOG_EPOCH、open-ended", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const scope = resolveTitleScope(store, titleWith({ scope: { type: "catalog" } }), BASE + 500);
    expect(scope.scopeKey).toBe("catalog:v1");
    expect(scope.start).toBe(BASE);
    expect(scope.endExclusive).toBeNull();
  });

  it("month: JST暦月、start=max(月初,CATALOG_EPOCH)、end=翌月初", () => {
    const db = openDb(":memory:");
    // catalog epochを8月10日にする → 8月分はepochでclipされる
    const catalogEpoch = Math.floor(new Date("2026-08-10T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const observedAt = Math.floor(new Date("2026-08-20T12:00:00+09:00").getTime() / 1000);
    const scope = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt);
    const monthStart = Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1000);
    const nextMonthStart = Math.floor(new Date("2026-09-01T00:00:00+09:00").getTime() / 1000);

    expect(scope.scopeKey).toBe("month:v1:2026-08");
    // catalog開始月のclip: 月初(8/1)ではなくcatalog epoch(8/10)が使われる
    expect(scope.start).toBe(catalogEpoch);
    expect(scope.start).not.toBe(monthStart);
    expect(scope.endExclusive).toBe(nextMonthStart);
  });

  it("month: catalog施行が月初より前ならclipされず月初がstartになる", () => {
    const db = openDb(":memory:");
    const catalogEpoch = Math.floor(new Date("2026-07-01T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const observedAt = Math.floor(new Date("2026-08-20T12:00:00+09:00").getTime() / 1000);
    const scope = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt);
    const monthStart = Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1000);
    expect(scope.start).toBe(monthStart);
  });

  it("month: JST暦月境界をまたぐ（12月→1月）", () => {
    const db = openDb(":memory:");
    const catalogEpoch = Math.floor(new Date("2026-01-01T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const observedAt = Math.floor(new Date("2026-12-15T12:00:00+09:00").getTime() / 1000);
    const scope = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt);
    const decStart = Math.floor(new Date("2026-12-01T00:00:00+09:00").getTime() / 1000);
    const janStart = Math.floor(new Date("2027-01-01T00:00:00+09:00").getTime() / 1000);
    expect(scope.scopeKey).toBe("month:v1:2026-12");
    expect(scope.start).toBe(decStart);
    expect(scope.endExclusive).toBe(janStart);
  });

  it("month: JST暦月境界ちょうど（23:59:59 JSTと翌0:00:00 JSTで別月）", () => {
    const db = openDb(":memory:");
    const catalogEpoch = Math.floor(new Date("2026-01-01T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const lastSecondOfAug = Math.floor(new Date("2026-08-31T23:59:59+09:00").getTime() / 1000);
    const firstSecondOfSep = lastSecondOfAug + 1;

    const augScope = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), lastSecondOfAug);
    const sepScope = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), firstSecondOfSep);
    expect(augScope.scopeKey).toBe("month:v1:2026-08");
    expect(sepScope.scopeKey).toBe("month:v1:2026-09");
  });

  it("event: providerが返すcanonical windowをCATALOG_EPOCHでclipする", () => {
    const db = openDb(":memory:");
    const catalogEpoch = BASE + 50;
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const provider: TitleEventScopeProvider = {
      resolveEvent: (catalogKey, eventKey) => {
        expect(catalogKey).toBe("v1");
        expect(eventKey).toBe("summer");
        return { start: BASE, completedAt: BASE + 1000 }; // イベント開始(BASE)はcatalog epochより前
      },
    };

    const scope = resolveTitleScope(
      store,
      titleWith({ scope: { type: "event", eventKey: "summer" } }),
      BASE + 2000,
      { eventProvider: provider },
    );
    expect(scope.scopeKey).toBe("event:v1:summer");
    expect(scope.start).toBe(catalogEpoch); // max(BASE, catalogEpoch) = catalogEpoch
    expect(scope.endExclusive).toBe(BASE + 1000);
  });

  it("event: providerが未登録eventを示すnullを返したらfail-closedする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    const provider: TitleEventScopeProvider = { resolveEvent: () => null };

    expect(() =>
      resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "unknown" } }), BASE + 10, {
        eventProvider: provider,
      }),
    ).toThrow(/unknown event/);
  });

  it("event: providerが非整数timestampを返したらfail-closedする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    const provider: TitleEventScopeProvider = { resolveEvent: () => ({ start: BASE, completedAt: BASE + 10.5 }) };

    expect(() =>
      resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "x" } }), BASE + 100, {
        eventProvider: provider,
      }),
    ).toThrow(/non-integer timestamps/);
  });

  it("event: providerがstart>=completedAtを返したらfail-closedする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    const provider: TitleEventScopeProvider = { resolveEvent: () => ({ start: BASE + 10, completedAt: BASE + 10 }) };

    expect(() =>
      resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "x" } }), BASE + 100, {
        eventProvider: provider,
      }),
    ).toThrow(/start >= completedAt/);
  });

  it("event: CATALOG_EPOCHでclipした後にstart>=completedAtとなる場合もfail-closedする", () => {
    const db = openDb(":memory:");
    const catalogEpoch = BASE + 500;
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    // canonical windowはcatalog epochより前で終わる → clip後は空window
    const provider: TitleEventScopeProvider = { resolveEvent: () => ({ start: BASE, completedAt: BASE + 100 }) };

    expect(() =>
      resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "x" } }), catalogEpoch + 1000, {
        eventProvider: provider,
      }),
    ).toThrow(/event window is empty after CATALOG_EPOCH clip/);
  });

  it("event: 未完了（completedAt > observedAt）のeventを部分windowでawardしない", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    const provider: TitleEventScopeProvider = { resolveEvent: () => ({ start: BASE, completedAt: BASE + 1000 }) };

    expect(() =>
      // observedAtがcompletedAtより前 → eventはまだ終わっていない
      resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "x" } }), BASE + 500, {
        eventProvider: provider,
      }),
    ).toThrow(/has not completed as of observedAt/);

    // completedAtちょうど（=以後）なら解決できる
    const scope = resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "x" } }), BASE + 1000, {
      eventProvider: provider,
    });
    expect(scope.endExclusive).toBe(BASE + 1000);
  });

  it("event: providerを渡さないとfail-closedする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    expect(() => resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "summer" } }), BASE + 10)).toThrow(
      /requires a TitleEventScopeProvider/,
    );
  });

  it("catalog epoch未施行ならcatalog/month scopeはfail-closedする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE); // applyCatalog未実行
    expect(() => resolveTitleScope(store, titleWith({ scope: { type: "catalog" } }), BASE + 10)).toThrow(
      /catalog epoch not applied yet/,
    );
    expect(() => resolveTitleScope(store, titleWith({ scope: { type: "month" } }), BASE + 10)).toThrow(
      /catalog epoch not applied yet/,
    );
  });

  it("SYSTEM_EPOCH未確定ならglobal scopeはfail-closedする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE); // applyCatalog未実行 → SYSTEM_EPOCHも無い
    expect(() => resolveTitleScope(store, titleWith({ scope: { type: "global" } }), BASE + 10)).toThrow(
      /SYSTEM_EPOCH is not established/,
    );
  });
});

describe("month scope selector（historical reconcile）", () => {
  it("selector省略時はcurrent（observedAtが属する月）と同じ結果になる", () => {
    const db = openDb(":memory:");
    const catalogEpoch = Math.floor(new Date("2026-01-01T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const observedAt = Math.floor(new Date("2026-08-20T12:00:00+09:00").getTime() / 1000);
    const omitted = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt);
    const explicit = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt, {
      monthSelector: { type: "current" },
    });
    expect(omitted.scopeKey).toBe(explicit.scopeKey);
    expect(omitted.start).toBe(explicit.start);
    expect(omitted.endExclusive).toBe(explicit.endExclusive);
  });

  it("specific selectorで、月をまたいだ後（9月）でも閉じた8月のscopeをresolveできる（historical repair）", () => {
    const db = openDb(":memory:");
    const catalogEpoch = Math.floor(new Date("2026-01-01T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    // 9/1 に評価しても、8月分のwindowを正しく取り戻せる。observedAtの意味
    // （実際の観測上限）はここでは9/1のまま——対象月だけをselectorでズラす。
    const observedAt = Math.floor(new Date("2026-09-01T12:00:00+09:00").getTime() / 1000);
    const scope = resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt, {
      monthSelector: { type: "specific", month: "2026-08" },
    });
    const augStart = Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1000);
    const sepStart = Math.floor(new Date("2026-09-01T00:00:00+09:00").getTime() / 1000);
    expect(scope.scopeKey).toBe("month:v1:2026-08");
    expect(scope.start).toBe(augStart);
    expect(scope.endExclusive).toBe(sepStart);
    // effectiveEndは8月分のendExclusive（9/1）——observedAt(9/1 12:00)より前なので
    // 8月は完全に閉じたwindowとして読める。
    expect(Math.min(scope.endExclusive!, scope.observedAt)).toBe(sepStart);
  });

  it("specific selectorのmonth文字列は厳格にvalidateする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    for (const bad of ["2026-13", "2026-00", "26-08", "2026/08", "2026-8", ""]) {
      expect(() =>
        resolveTitleScope(store, titleWith({ scope: { type: "month" } }), BASE + 10, {
          monthSelector: { type: "specific", month: bad },
        }),
      ).toThrow(/must be a "YYYY-MM" month label/);
    }
  });

  it("CATALOG_EPOCHより完全に前のspecific monthはreject", () => {
    const db = openDb(":memory:");
    const catalogEpoch = Math.floor(new Date("2026-08-01T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const observedAt = Math.floor(new Date("2026-09-15T00:00:00+09:00").getTime() / 1000);
    expect(() =>
      resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt, {
        monthSelector: { type: "specific", month: "2026-07" },
      }),
    ).toThrow(/entirely precedes CATALOG_EPOCH/);
  });

  it("未来のspecific monthを指定するとobservedAt<startでfail-closedする", () => {
    const db = openDb(":memory:");
    const catalogEpoch = Math.floor(new Date("2026-01-01T00:00:00+09:00").getTime() / 1000);
    const store = new TitleV2Store(db, () => catalogEpoch);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const observedAt = Math.floor(new Date("2026-08-15T00:00:00+09:00").getTime() / 1000);
    expect(() =>
      resolveTitleScope(store, titleWith({ scope: { type: "month" } }), observedAt, {
        monthSelector: { type: "specific", month: "2026-09" },
      }),
    ).toThrow(/observedAt .* is before the resolved scope start/);
  });
});

describe("observedAt fail-closed / zero-width window（§6）", () => {
  it("observedAtがscope.startより前ならfail-closedする", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE + 1000);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    expect(() => resolveTitleScope(store, titleWith({ scope: { type: "global" } }), BASE)).toThrow(
      /observedAt .* is before the resolved scope start/,
    );
  });

  it("CATALOG_EPOCH===observedAtのzero-width windowはエラーにならず解決できる", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });

    const scope = resolveTitleScope(store, titleWith({ scope: { type: "catalog" } }), BASE);
    expect(scope.start).toBe(BASE);
    expect(scope.observedAt).toBe(BASE);
  });
});

describe("callerがscopeを偽造できない（§7）", () => {
  it("手書きのプレーンobjectはResolvedTitleScopeの型に合致しない", () => {
    const handWritten = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: BASE + 10 };
    // @ts-expect-error ResolvedTitleScopeはbranded symbolを要求するため、
    // 手書きのプレーンobjectはこの型へ代入できない——callerが任意のscopeKeyを
    // 注入する経路を型レベルで塞いでいることの直接的な証明。
    const forged: ResolvedTitleScope = handWritten;
    expect(forged).toBeDefined();
  });

  it("as unknown as で型を迂回しても、runtimeのbrand検証で弾かれる", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    void store; // このテストはreadTitleSource側のruntime guardだけを見る

    const forged = {
      scopeKey: "global",
      start: BASE,
      endExclusive: null,
      observedAt: BASE + 10,
    } as unknown as ResolvedTitleScope;

    expect(() => readTitleSource(db, "bump_events", "alice", forged)).toThrow(/not produced by resolveTitleScope/);
  });

  it("resolveTitleScope()が作った本物のscopeは検証を通る", () => {
    const db = openDb(":memory:");
    new BumpCounter(db);
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    const scope = resolveTitleScope(store, titleWith({ scope: { type: "global" } }), BASE + 10);
    expect(() => readTitleSource(db, "bump_events", "alice", scope)).not.toThrow();
  });

  it("cache hit経由でも偽造scopeは弾かれる（正規scopeを先にcacheした後、同じfieldsを持つ偽造scopeを渡す）", () => {
    const db = openDb(":memory:");
    new BumpCounter(db);
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    const legit = resolveTitleScope(store, titleWith({ scope: { type: "global" } }), BASE + 10);

    const cache = new TitleSourceCache();
    // 正規scopeで1回読み、(userId, sourceKey, scopeKey, start, endExclusive, observedAt)を
    // cacheへ載せる。
    expect(() => cache.get(db, "bump_events", "alice", legit)).not.toThrow();

    // legitと全く同じfields（scopeKey/start/endExclusive/observedAt）を持つが、
    // resolveTitleScope()を経由していない偽造scope。cache keyだけを見ると
    // legitと区別が付かないため、hit判定より前にbrand検証しないとすり抜けてしまう。
    const forgedWithSameFields = {
      scopeKey: legit.scopeKey,
      start: legit.start,
      endExclusive: legit.endExclusive,
      observedAt: legit.observedAt,
    } as unknown as ResolvedTitleScope;

    expect(() => cache.get(db, "bump_events", "alice", forgedWithSameFields)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });
});

describe("zero-width windowはVC readerでエラーにならない（§6）", () => {
  it("CATALOG_EPOCH===observedAtのvc_empty_start_then_joinedは0件を返す（例外にならない）", () => {
    const db = openDb(":memory:");
    const store = new TitleV2Store(db, () => BASE);
    store.applyCatalog({ catalogKey: "v1", actor: "test" });
    const scope = resolveTitleScope(store, titleWith({ scope: { type: "catalog" } }), BASE);

    expect(() => readTitleSource(db, "vc_empty_start_then_joined", "alice", scope)).not.toThrow();
    const payload = readTitleSource(db, "vc_empty_start_then_joined", "alice", scope);
    expect(payload.facts).toEqual([]);
  });
});
