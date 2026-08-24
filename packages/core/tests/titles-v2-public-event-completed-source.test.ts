import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { PublicEvents } from "../src/public-events/service.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule, evaluateTitle } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000); // JST 2026-08-20 00:00
const OBSERVED_AT = BASE + 100_000;
const COMMON = {
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  collectionDomainKey: "test-domain",
  scope: { type: "global" as const },
};
const RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.completed-public-events",
    name: "test",
    description: "test",
    sources: ["public_event_completed_participations"] as const,
    triggers: ["event_completed"],
    lifecycle: "active",
    ...COMMON,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

function setup() {
  const db = openDb(":memory:");
  let storeClock = BASE - 100_000;
  const store = new TitleV2Store(db, () => storeClock);
  store.applyCatalog({ catalogKey: "test", actor: "setup" });
  storeClock = OBSERVED_AT;
  let eventClock = BASE;
  const publicEvents = new PublicEvents(db, () => eventClock);
  return {
    db,
    store,
    publicEvents,
    setClock: (value: number) => {
      eventClock = value;
    },
    scope: () => resolveTitleScope(store, RULE.definition, OBSERVED_AT),
  };
}

function roster(
  publicEvents: PublicEvents,
  eventKey: string,
  users: readonly string[],
  extras: { name?: string; eventDate?: string; recordedBy?: string } = {},
) {
  return publicEvents.recordFinalizedEvent({
    eventKey,
    name: extras.name ?? "テスト公開イベント",
    eventDate: extras.eventDate ?? "2026-08-20",
    participantUserIds: users,
    organizerUserIds: [],
    staffUserIds: [],
    primaryOrganizerUserId: "primary-organizer",
    recordedBy: extras.recordedBy ?? "staff-recorder",
  });
}

describe("raw/safe source contracts", () => {
  it("raw completionはrestricted/titleUsable:false、safe derivedはorderable:false/titleUsable:true", () => {
    expect(TITLE_SOURCES.public_event_completions).toMatchObject({
      origin: "persisted",
      kind: "history",
      privacy: "restricted",
      orderable: false,
      titleUsable: false,
      restrictedUse: "public_event_safe_completion_classification",
      epochPolicy: { type: "point", at: "completed_at" },
      rawUnit: "staff_attested_public_event_completion",
    });
    expect(TITLE_SOURCES.public_event_completed_participations).toMatchObject({
      origin: "derived",
      derivedFrom: ["public_event_participations", "public_event_completions"],
      kind: "history",
      privacy: "safe",
      orderable: false,
      titleUsable: true,
      epochPolicy: { type: "point", at: "completedAt" },
    });
  });

  it("raw completionはgeneric readTitleSourceからreject", () => {
    const { db, scope } = setup();
    expect(() => readTitleSource(db, "public_event_completions" as never, "alice", scope())).toThrow(/not usable/);
  });

  it("既存E3 contractは変更されない", () => {
    expect(TITLE_SOURCES.public_event_participations).toMatchObject({
      origin: "persisted",
      privacy: "safe",
      titleUsable: true,
      orderable: false,
      epochPolicy: { type: "point", at: "recorded_at" },
    });
  });
});

describe("completion JOIN semantics / privacy", () => {
  it("roster onlyは旧sourceへ出るがcompleted sourceへは出ない", () => {
    const { db, publicEvents, scope } = setup();
    roster(publicEvents, "roster-only", ["alice"]);
    expect(readTitleSource(db, "public_event_participations", "alice", scope()).participations).toHaveLength(1);
    expect(readTitleSource(db, "public_event_completed_participations", "alice", scope())).toEqual({ participations: [] });
  });

  it("明示completion後はparticipantだけへ1 fact、retryしても1 fact", () => {
    const { db, publicEvents, setClock, scope } = setup();
    roster(publicEvents, "completed-event", ["alice", "bob"]);
    setClock(BASE + 100);
    publicEvents.recordCompletedEvent({ eventKey: "completed-event", completedBy: "staff-completer" });
    publicEvents.recordCompletedEvent({ eventKey: "completed-event", completedBy: "different-staff" });
    expect(readTitleSource(db, "public_event_completed_participations", "alice", scope()).participations).toEqual([
      { eventKey: "completed-event", completedAt: BASE + 100 },
    ]);
    expect(readTitleSource(db, "public_event_completed_participations", "carol", scope())).toEqual({ participations: [] });
  });

  it("payloadはeventKey/completedAtだけで、name/date/audit actors/count/他参加者を漏らさない", () => {
    const { db, publicEvents, setClock, scope } = setup();
    roster(publicEvents, "privacy-event", ["alice", "other-secret-user"], {
      name: "SECRET_EVENT_NAME",
      recordedBy: "SECRET_RECORDED_BY",
    });
    setClock(BASE + 100);
    publicEvents.recordCompletedEvent({ eventKey: "privacy-event", completedBy: "SECRET_COMPLETED_BY" });
    const payload = readTitleSource(db, "public_event_completed_participations", "alice", scope());
    expect(payload).toEqual({ participations: [{ eventKey: "privacy-event", completedAt: BASE + 100 }] });
    expect(Object.keys(payload.participations[0]!).sort()).toEqual(["completedAt", "eventKey"]);
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["SECRET_EVENT_NAME", "2026-08-20", "SECRET_RECORDED_BY", "SECRET_COMPLETED_BY", "other-secret-user"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("completion timestamp scope", () => {
  it("startを含みendを除外し、roster時刻ではなくcompletedAtでfilterする", () => {
    const { db, publicEvents, setClock, scope } = setup();
    const resolved = scope();
    const cases = [
      ["before-start", resolved.start - 1],
      ["at-start", resolved.start],
      ["before-end", OBSERVED_AT - 1],
      ["at-end", OBSERVED_AT],
    ] as const;
    // rosterは全件window開始より前。採否は後で記録するcompletion時刻だけで決まる。
    setClock(resolved.start - 10);
    for (const [eventKey] of cases) roster(publicEvents, eventKey, ["alice"], { eventDate: "2026-08-18" });
    for (const [eventKey, completedAt] of cases) {
      setClock(completedAt);
      publicEvents.recordCompletedEvent({ eventKey, completedBy: "staff" });
    }
    expect(readTitleSource(db, "public_event_completed_participations", "alice", resolved).participations).toEqual([
      { eventKey: "at-start", completedAt: resolved.start },
      { eventKey: "before-end", completedAt: OBSERVED_AT - 1 },
    ]);
  });
});

describe("D1/cache/freeze/EventLog", () => {
  it("single/bulk等価、zero normalization、requested user以外を先読みしない", () => {
    const { db, publicEvents, setClock, scope } = setup();
    roster(publicEvents, "bulk-event", ["alice", "bob", "other"]);
    setClock(BASE + 100);
    publicEvents.recordCompletedEvent({ eventKey: "bulk-event", completedBy: "staff" });
    const resolved = scope();
    const single = new TitleSourceCache();
    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "public_event_completed_participations", ["alice", "bob", "nobody"], resolved);
    for (const userId of ["alice", "bob", "nobody"]) {
      expect(bulk.get(db, "public_event_completed_participations", userId, resolved)).toEqual(
        single.get(db, "public_event_completed_participations", userId, resolved),
      );
    }
    expect(bulk.get(db, "public_event_completed_participations", "nobody", resolved)).toEqual({ participations: [] });
    expect(bulk.prefetch(db, "public_event_completed_participations", ["other"], resolved).loaded).toBe(1);
  });

  it("payloadをentryまでdeep freezeする", () => {
    const { db, publicEvents, setClock, scope } = setup();
    roster(publicEvents, "frozen-event", ["alice"]);
    setClock(BASE + 100);
    publicEvents.recordCompletedEvent({ eventKey: "frozen-event", completedBy: "staff" });
    const payload = readTitleSource(db, "public_event_completed_participations", "alice", scope());
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.participations)).toBe(true);
    expect(Object.isFrozen(payload.participations[0])).toBe(true);
  });

  it("generic EventLogを一切使わない", () => {
    const { db, scope } = setup();
    const eventLog = new EventLog(db);
    eventLog.log("public_event_completed", { actor: "alice", target: "fake" });
    const spy = vi.spyOn(db, "prepare");
    expect(readTitleSource(db, "public_event_completed_participations", "alice", scope())).toEqual({ participations: [] });
    expect(spy.mock.calls.map((call) => String(call[0])).filter((sql) => /\bFROM\s+events\b/i.test(sql))).toEqual([]);
  });
});

describe("reader corruption defense / bounded SQL", () => {
  it("roster_recorded_at mismatchとcompleted_at<rosterをsafe factへ昇格しない", () => {
    const { db, publicEvents, setClock, scope } = setup();
    roster(publicEvents, "mismatch", ["alice"]);
    roster(publicEvents, "backward", ["alice"]);
    setClock(BASE + 100);
    publicEvents.recordCompletedEvent({ eventKey: "mismatch", completedBy: "staff" });
    publicEvents.recordCompletedEvent({ eventKey: "backward", completedBy: "staff" });
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE public_event_completions SET roster_recorded_at = roster_recorded_at + 1 WHERE event_key = 'mismatch'`).run();
    db.prepare(`UPDATE public_event_completions SET completed_at = roster_recorded_at - 1 WHERE event_key = 'backward'`).run();
    expect(readTitleSource(db, "public_event_completed_participations", "alice", scope())).toEqual({ participations: [] });
  });

  it("大量eventKeysでもbind数はrequested users + windowだけ", () => {
    const { db, publicEvents, setClock, scope } = setup();
    for (let i = 0; i < 1200; i += 1) {
      const key = `event-${i}`;
      roster(publicEvents, key, ["alice"]);
      setClock(BASE + 1 + i);
      publicEvents.recordCompletedEvent({ eventKey: key, completedBy: "staff" });
    }
    const spy = vi.spyOn(db, "prepare");
    const payload = readTitleSource(db, "public_event_completed_participations", "alice", scope());
    expect(payload.participations).toHaveLength(1200);
    const joinSql = spy.mock.calls.map((call) => String(call[0])).find((sql) => /JOIN public_event_completions/.test(sql));
    expect(joinSql?.match(/\?/g)).toHaveLength(3); // user 1 + start/end。event数には依存しない。
  });
});

describe("non-orderability", () => {
  it("completed sourceだけのruleがearnedAtを返すとfail-closed", () => {
    const { db, store, publicEvents, setClock } = setup();
    roster(publicEvents, "non-orderable", ["alice"]);
    setClock(BASE + 100);
    publicEvents.recordCompletedEvent({ eventKey: "non-orderable", completedBy: "staff" });
    const badRule = defineTitleRule(
      { ...RULE.definition, key: "v2.test.bad-completed-event-order" },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE + 100, awardFacts: {} }) },
    );
    expect(() => evaluateTitle(db, store, badRule, "alice", OBSERVED_AT)).toThrow(/non-orderable/);
  });
});
