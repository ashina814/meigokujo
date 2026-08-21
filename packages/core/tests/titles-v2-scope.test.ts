import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { BumpCounter } from "../src/rank/bump.js";
import { defineBehaviorTitle, type BehaviorTitleDefinition } from "../src/titles/v2-contract.js";
import { resolveTitleScope, type ResolvedTitleScope, type TitleEventScopeProvider } from "../src/titles/v2-scope.js";
import { readTitleSource } from "../src/titles/v2-sources.js";
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
      provider,
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
      resolveTitleScope(store, titleWith({ scope: { type: "event", eventKey: "unknown" } }), BASE + 10, provider),
    ).toThrow(/unknown event/);
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
});
