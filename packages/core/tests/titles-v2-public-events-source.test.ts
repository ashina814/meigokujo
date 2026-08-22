import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { PublicEvents } from "../src/public-events/service.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

/** JST 2026-08-20 00:00:00 を秒0とする、E3テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const OBSERVED_AT = BASE + 100_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" }); // SYSTEM_EPOCH = BASE-100_000
  clock = BASE + 10_000_000;
  let peClock = BASE;
  const publicEvents = new PublicEvents(db, () => peClock);
  const setPeClock = (t: number) => {
    peClock = t;
  };
  const events = new EventLog(db);
  return { db, store, publicEvents, setPeClock, events };
}

const COMMON_FIXTURE_FIELDS = {
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  collectionDomainKey: "test-domain",
  scope: { type: "global" as const },
};

const PUBLIC_EVENT_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.public-event-participations",
    name: "test",
    description: "テスト用fixture",
    sources: ["public_event_participations"] as const,
    triggers: ["event_completed"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

function recordEvent(
  publicEvents: PublicEvents,
  opts: { eventKey: string; participantUserIds: readonly string[]; name?: string; eventDate?: string; recordedBy?: string },
) {
  return publicEvents.recordFinalizedEvent({
    eventKey: opts.eventKey,
    name: opts.name ?? "テストイベント",
    eventDate: opts.eventDate ?? "2026-08-20",
    participantUserIds: opts.participantUserIds,
    recordedBy: opts.recordedBy ?? "staff-1",
  });
}

// ─────────────────────────────────────────────────────────────

describe("source contract（§42）", () => {
  it("public_event_participations: persisted / safe / titleUsable:true / orderable:false / point at recorded_at", () => {
    expect(TITLE_SOURCES.public_event_participations).toMatchObject({
      origin: "persisted",
      kind: "history",
      privacy: "safe",
      titleUsable: true,
      orderable: false,
      epochPolicy: { type: "point", at: "recorded_at" },
    });
  });
});

describe("A/B. 参加者・不参加者（§67 A,B）", () => {
  it("A. aliceが参加したeventはalice payloadへ1件現れる", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice", "bob"] });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "public_event_participations", "alice", scope);
    expect(payload.participations).toEqual([{ eventKey: "gf-2026-08-22", recordedAt: BASE - 50_000 }]);
  });

  it("B. 不参加のcarolは[]", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice", "bob"] });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "public_event_participations", "carol", scope)).toEqual({ participations: [] });
  });
});

describe("C. 同eventでalice row1件だけ（§67 C）", () => {
  it("同じeventKeyの再送でもaliceの参加factは1件のまま", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice", "bob"] });
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice", "bob"] }); // idempotent再送
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "public_event_participations", "alice", scope);
    expect(payload.participations).toHaveLength(1);
  });
});

describe("D. eventKey payloadあり / E. name・date・recordedByなし（§67 D,E）", () => {
  it("payloadにeventKey/recordedAtだけ含まれ、name/eventDate/recordedByは含まれない", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, {
      eventKey: "gf-2026-08-22",
      participantUserIds: ["alice"],
      name: "LEAK_EVENT_NAME_SECRET",
      recordedBy: "LEAK_STAFF_SECRET",
    });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "public_event_participations", "alice", scope);
    expect(payload.participations).toEqual([{ eventKey: "gf-2026-08-22", recordedAt: BASE - 50_000 }]);
    expect(Object.keys(payload.participations[0]!).sort()).toEqual(["eventKey", "recordedAt"]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("LEAK_EVENT_NAME_SECRET");
    expect(serialized).not.toContain("LEAK_STAFF_SECRET");
    expect(serialized).not.toContain("bob"); // 他参加者も含まれていない
  });
});

describe("F. single-vs-bulk equivalence（§67 F）", () => {
  it("fresh single get == bulk prefetch → get（複数user）", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice", "bob"] });
    setPeClock(BASE - 30_000);
    recordEvent(publicEvents, { eventKey: "bingo-2026-08-25", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);

    const single = new TitleSourceCache();
    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "public_event_participations", ["alice", "bob"], scope);
    for (const userId of ["alice", "bob"]) {
      expect(bulk.get(db, "public_event_participations", userId, scope)).toEqual(
        single.get(db, "public_event_participations", userId, scope),
      );
    }
  });
});

describe("G. scope [start,end)（§67 G）", () => {
  it("scope開始前は除外・開始ちょうどは含む・終了ちょうどは除外", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);

    setPeClock(scope.start - 1);
    recordEvent(publicEvents, { eventKey: "before-start", participantUserIds: ["alice"] });
    setPeClock(scope.start);
    recordEvent(publicEvents, { eventKey: "at-start", participantUserIds: ["alice"] });
    setPeClock(OBSERVED_AT - 1);
    recordEvent(publicEvents, { eventKey: "before-end", participantUserIds: ["alice"] });
    setPeClock(OBSERVED_AT);
    recordEvent(publicEvents, { eventKey: "at-end", participantUserIds: ["alice"] });

    const payload = readTitleSource(db, "public_event_participations", "alice", scope);
    expect(payload.participations.map((p) => p.eventKey)).toEqual(["at-start", "before-end"]);
  });
});

describe("H. deep freeze（§67 H）", () => {
  it("payload/participations array/entryまでfreezeされる", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "public_event_participations", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.participations)).toBe(true);
    expect(Object.isFrozen(payload.participations[0])).toBe(true);
    expect(() => {
      (payload.participations as unknown[]).push({});
    }).toThrow();
  });
});

describe("I. forged scope rejection（§67 I、既存provenance契約を維持）", () => {
  it("手書きscopeはfail-closed", () => {
    const { db } = setup();
    const forged = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    expect(() => readTitleSource(db, "public_event_participations", "alice", forged as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });
});

describe("zero-result normalization（§30相当）", () => {
  it("0件userはparticipations:[]を明示的に返す", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "public_event_participations", "nobody", scope)).toEqual({ participations: [] });
  });
});

describe("§48 requested users以外を返さない", () => {
  it("rosterに他100人いても、requestしたuserだけがpayloadへ入る", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    const others = Array.from({ length: 100 }, (_, i) => `other-${i}`);
    recordEvent(publicEvents, { eventKey: "big-event", participantUserIds: ["alice", ...others] });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);

    const cache = new TitleSourceCache();
    cache.prefetch(db, "public_event_participations", ["alice"], scope);
    // otherIdはcacheへ勝手に入っていない——別scopeでの再prefetchが必要になるはず。
    const readCalls = cache.prefetch(db, "public_event_participations", ["other-5"], scope);
    expect(readCalls.loaded).toBe(1); // 既にcache済みでなく、新規に読み込まれた
  });
});

describe("§55 EventLog non-use regression", () => {
  it("generic eventsへpublicっぽい/privateっぽいtypeを大量に入れても、sourceは0のまま", () => {
    const { db, store, events } = setup();
    events.log("public_event_participation", { actor: "alice", target: "gf-2026-08-22" });
    events.log("public_announcement", { actor: "alice" });
    events.log("private_ticket_opened", { actor: "alice" });
    events.log("confession_submitted", { actor: "alice" });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "public_event_participations", "alice", scope)).toEqual({ participations: [] });
  });

  it("source readerがeventsテーブルへ一切SELECTしていない", () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice"] });
    const scope = resolveTitleScope(store, PUBLIC_EVENT_RULE.definition, OBSERVED_AT);

    const prepareSpy = vi.spyOn(db, "prepare");
    readTitleSource(db, "public_event_participations", "alice", scope);
    const eventsQueries = prepareSpy.mock.calls.map((c) => String(c[0])).filter((sql) => /\bFROM\s+events\b/i.test(sql));
    expect(eventsQueries).toHaveLength(0);
  });
});

describe("§68 non-orderability: orderable:falseのruleはearnedAtを主張できない", () => {
  it("orderable:falseのsourceに依存するruleがearnedAt!=nullを返すとevaluatorがfail-closed", async () => {
    const { db, store, publicEvents, setPeClock } = setup();
    setPeClock(BASE - 50_000);
    recordEvent(publicEvents, { eventKey: "gf-2026-08-22", participantUserIds: ["alice"] });
    const { evaluateTitle } = await import("../src/titles/v2-evaluator.js");
    const badRule = defineTitleRule(
      {
        kind: "behavior",
        key: "v2.test.public-event-bad-orderable",
        name: "test",
        description: "テスト用fixture",
        sources: ["public_event_participations"] as const,
        triggers: ["event_completed"],
        lifecycle: "active",
        ...COMMON_FIXTURE_FIELDS,
      },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: 12345, awardFacts: {} }) },
    );
    expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(/non-orderable/);
  });
});
