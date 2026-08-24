import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { PublicEvents } from "../src/public-events/service.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

const DAY = 86_400;
const BASE = Math.floor(Date.UTC(2026, 6, 31, 15, 0, 0) / 1000); // JST 2026-08-01 00:00
const RULE = defineTitleRule({
  kind: "behavior",
  key: "v2.test.public-event-calendar-involvement",
  name: "test",
  description: "test",
  catalog: "test",
  emoji: "x",
  hidden: false,
  publicAnnounce: false,
  themeKey: "test-theme",
  groupKey: "test-group",
  collectionDomainKey: "test-domain",
  scope: { type: "global" },
  sources: ["public_event_calendar_involvement_safe"],
  triggers: ["event_completed"],
  lifecycle: "active",
}, { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) });

function setup() {
  const db = openDb(":memory:");
  let now = BASE;
  let storeNow = BASE - 100;
  const store = new TitleV2Store(db, () => storeNow);
  store.applyCatalog({ catalogKey: "test", actor: "test" });
  storeNow = BASE + 40 * DAY;
  const events = new PublicEvents(db, () => now);
  return {
    db,
    events,
    setNow: (value: number) => { now = value; },
    scope: (observedAt = BASE + 40 * DAY) => resolveTitleScope(store, RULE.definition, observedAt),
  };
}

function record(
  context: ReturnType<typeof setup>,
  input: {
    key: string;
    date?: string;
    participants?: readonly string[];
    staff?: readonly string[];
    organizers?: readonly string[];
    primary?: string;
    recordedBy?: string;
    complete?: boolean;
    recordedAt?: number;
    completedAt?: number;
    completedBy?: string;
  },
) {
  const recordedAt = input.recordedAt ?? BASE + 20 * DAY;
  context.setNow(recordedAt);
  context.events.recordFinalizedEvent({
    eventKey: input.key,
    name: `Event ${input.key}`,
    eventDate: input.date ?? "2026-08-20",
    participantUserIds: input.participants ?? ["general"],
    organizerUserIds: input.organizers ?? [],
    staffUserIds: input.staff ?? [],
    primaryOrganizerUserId: input.primary ?? "primary",
    recordedBy: input.recordedBy ?? "recorder",
  });
  if (input.complete !== false) {
    context.setNow(input.completedAt ?? recordedAt + 10);
    context.events.recordCompletedEvent({ eventKey: input.key, completedBy: input.completedBy ?? "completer" });
  }
}

function payload(context: ReturnType<typeof setup>, userId: string, observedAt?: number) {
  return readTitleSource(context.db, "public_event_calendar_involvement_safe", userId, context.scope(observedAt));
}

function hasDifferentEventDualRole(events: ReturnType<typeof payload>["events"]): boolean {
  return events.some((participant, participantIndex) =>
    participant.generalParticipant && events.some((involved, involvedIndex) =>
      involvedIndex !== participantIndex && (involved.staff || involved.organizer)));
}

describe("No.82 actual event calendar + completion snapshot fence", () => {
  it("completed event datesをoriginal JST dateのまま公開し、separated/same-date分布を保持する", () => {
    const context = setup();
    record(context, { key: "early", date: "2026-08-01", participants: ["subject"] });
    record(context, { key: "late", date: "2026-08-20", participants: ["subject"] });
    record(context, { key: "same-day", date: "2026-08-20", participants: ["subject"] });
    expect(payload(context, "subject").events.map((event) => event.eventDate)).toEqual([
      "2026-08-01", "2026-08-20", "2026-08-20",
    ]);
  });

  it("late completion前snapshotは0、完了後はbackdateせずoriginal eventDateをcalendar dimensionにする", () => {
    const context = setup();
    const completedAt = BASE + 10 * DAY;
    record(context, {
      key: "late-completion",
      date: "2026-08-01",
      participants: ["subject"],
      recordedAt: BASE + 9 * DAY,
      completedAt,
    });
    expect(payload(context, "subject", completedAt).events).toEqual([]); // effective endはexclusive
    expect(payload(context, "subject", completedAt + 1).events).toEqual([{
      eventDate: "2026-08-01",
      generalParticipant: true,
      staff: false,
      organizer: false,
      primaryOrganizer: false,
    }]);
  });

  it("uncompleted eventはcalendar evidenceにしない", () => {
    const context = setup();
    record(context, { key: "uncompleted", participants: ["subject"], complete: false });
    expect(payload(context, "subject").events).toEqual([]);
  });
});

describe("No.83 different-event joint role proof", () => {
  it.each([
    ["staff", { staff: ["subject"] }],
    ["organizer", { organizers: ["subject"] }],
    ["primary organizer", { primary: "subject" }],
  ])("participant event A + %s event Bは別profileとしてdual-roleを証明する", (_label, involvement) => {
    const context = setup();
    record(context, { key: "participant-a", participants: ["subject"] });
    record(context, { key: "involvement-b", participants: ["other"], ...involvement });
    const events = payload(context, "subject").events;
    expect(events).toHaveLength(2);
    expect(hasDifferentEventDualRole(events)).toBe(true);
  });

  it("participant+staffが同一eventだけなら1 profileで、No.83 different-event条件を満たせない", () => {
    const context = setup();
    record(context, { key: "same-event", participants: ["subject"], staff: ["subject"] });
    const events = payload(context, "subject").events;
    expect(events).toEqual([expect.objectContaining({ generalParticipant: true, staff: true })]);
    expect(hasDifferentEventDualRole(events)).toBe(false);
  });

  it("staff-only / participant-onlyを取り違えず、legacy・audit actorsからroleを推測しない", () => {
    const context = setup();
    record(context, { key: "staff-only", participants: ["other"], staff: ["staff-subject"] });
    record(context, { key: "participant-only", participants: ["participant-subject"] });
    expect(payload(context, "staff-subject").events).toEqual([
      expect.objectContaining({ generalParticipant: false, staff: true }),
    ]);
    expect(payload(context, "participant-subject").events).toEqual([
      expect.objectContaining({ generalParticipant: true, staff: false, organizer: false }),
    ]);

    context.db.prepare(`INSERT INTO public_events VALUES (?, ?, ?, ?, ?)`).run(
      "legacy", "Legacy", "2026-08-01", "audit-subject", BASE,
    );
    context.db.prepare(`INSERT INTO public_event_participations VALUES (?, ?, ?)`).run("legacy", "legacy-participant", BASE);
    context.db.prepare(`INSERT INTO public_event_completions VALUES (?, ?, ?, ?)`).run(
      "legacy", BASE, "audit-subject", BASE + 1,
    );
    expect(payload(context, "legacy-participant").events).toEqual([
      expect.objectContaining({ generalParticipant: true, staff: false, organizer: false, primaryOrganizer: false }),
    ]);
    expect(payload(context, "audit-subject").events).toEqual([]);
  });
});

describe("No.84 primary organizer + same-event completion", () => {
  it("primary organizer completedだけがevidenceになり、uncompleted/staff/non-primary/recordedByはならない", () => {
    const context = setup();
    record(context, { key: "primary-completed", participants: ["other"], primary: "primary-good" });
    record(context, { key: "primary-open", participants: ["other"], primary: "primary-open", complete: false });
    record(context, { key: "other-roles", participants: ["other"], primary: "someone", organizers: ["co"], staff: ["staff"] });
    record(context, { key: "audit", participants: ["other"], recordedBy: "recorder-subject", completedBy: "completion-subject" });
    expect(payload(context, "primary-good").events).toEqual([
      expect.objectContaining({ organizer: true, primaryOrganizer: true }),
    ]);
    for (const userId of ["primary-open", "staff", "co", "recorder-subject", "completion-subject"]) {
      expect(payload(context, userId).events.some((event) => event.primaryOrganizer), userId).toBe(false);
    }
  });

  it("multiple/missing primary、wrong roster revision、completion-before-rosterはevent全体をfail closedする", () => {
    const context = setup();
    record(context, { key: "multi-primary", participants: ["subject"], primary: "primary-a" });
    record(context, { key: "missing-primary", participants: ["subject"], primary: "primary-missing" });
    record(context, { key: "wrong-revision", participants: ["subject"], primary: "primary-b" });
    record(context, { key: "backward-completion", participants: ["subject"], primary: "primary-d" });
    context.db.pragma("foreign_keys = OFF");
    context.db.pragma("ignore_check_constraints = ON");
    context.db.exec(`DROP INDEX idx_public_event_exactly_one_primary`);
    context.db.prepare(`INSERT INTO public_event_involvements VALUES (?, ?, ?, ?)`).run(
      "multi-primary", "primary-c", "primary_organizer", BASE + 20 * DAY,
    );
    context.db.prepare(`UPDATE public_event_completions SET roster_recorded_at = roster_recorded_at + 1 WHERE event_key = ?`)
      .run("wrong-revision");
    context.db.prepare(`DELETE FROM public_event_involvements WHERE event_key = ? AND role = 'primary_organizer'`)
      .run("missing-primary");
    context.db.prepare(`UPDATE public_event_completions SET completed_at = roster_recorded_at - 1 WHERE event_key = ?`)
      .run("backward-completion");
    expect(payload(context, "subject").events).toEqual([]);
  });

  it("invalid/future date、corrupt role enum、empty role identityもfail closedする", () => {
    const context = setup();
    for (const key of ["invalid-date", "future-date", "invalid-role", "empty-role"]) {
      record(context, { key, participants: ["subject"], date: "2026-08-01" });
    }
    context.db.pragma("ignore_check_constraints = ON");
    context.db.prepare(`UPDATE public_events SET event_date = '2026-02-30' WHERE event_key = 'invalid-date'`).run();
    context.db.prepare(`UPDATE public_events SET event_date = '2099-01-01' WHERE event_key = 'future-date'`).run();
    context.db.prepare(`UPDATE public_event_involvements SET role = 'corrupt' WHERE event_key = 'invalid-role'`).run();
    context.db.prepare(`UPDATE public_event_involvements SET user_id = '' WHERE event_key = 'empty-role'`).run();
    expect(payload(context, "subject").events).toEqual([]);
  });

  it("event missingのorphan involvementを証拠へしない", () => {
    const context = setup();
    context.db.pragma("foreign_keys = OFF");
    context.db.prepare(`INSERT INTO public_event_involvement_revisions VALUES (?, ?)`).run("orphan", BASE);
    context.db.prepare(`INSERT INTO public_event_involvements VALUES (?, ?, ?, ?)`).run(
      "orphan", "subject", "primary_organizer", BASE,
    );
    context.db.prepare(`INSERT INTO public_event_completions VALUES (?, ?, ?, ?)`).run("orphan", BASE, "x", BASE + 1);
    expect(payload(context, "subject").events).toEqual([]);
  });
});

describe("privacy, source contract and bulk", () => {
  it("restricted raw boundariesとsafe derived dependencyを登録する", () => {
    for (const key of ["public_event_records", "public_event_involvement_revisions", "public_event_involvements"] as const) {
      expect(TITLE_SOURCES[key]).toMatchObject({
        privacy: "restricted",
        titleUsable: false,
        restrictedUse: "public_event_safe_involvement_classification",
      });
    }
    expect(TITLE_SOURCES.public_event_calendar_involvement_safe).toMatchObject({
      privacy: "safe",
      titleUsable: true,
      rawUnit: "anonymous_completed_public_event_calendar_involvement_profile",
    });
  });

  it("safe JSONはsubject flags/dateだけでidentity・event/audit/exact timestampを漏らさない", () => {
    const context = setup();
    record(context, {
      key: "secret-event-key",
      date: "2026-08-20",
      participants: ["subject", "secret-other-participant"],
      staff: ["subject", "secret-other-staff"],
      organizers: ["secret-co-organizer"],
      primary: "secret-primary",
      recordedBy: "secret-recorder",
      completedBy: "secret-completer",
      completedAt: BASE + 20 * DAY + 123,
    });
    const safe = payload(context, "subject");
    expect(safe).toEqual({ events: [{
      eventDate: "2026-08-20",
      generalParticipant: true,
      staff: true,
      organizer: false,
      primaryOrganizer: false,
    }] });
    expect(Object.keys(safe.events[0]!).sort()).toEqual([
      "eventDate", "generalParticipant", "organizer", "primaryOrganizer", "staff",
    ]);
    const json = JSON.stringify(safe);
    for (const secret of ["subject", "secret-", "recorder", "completer", String(BASE + 20 * DAY + 123)]) {
      expect(json).not.toContain(secret);
    }
  });

  it("601 subjectsを300/300/1の3 readsでprefetchし、single readerと一致する", () => {
    const context = setup();
    const userIds = Array.from({ length: 601 }, (_, index) => `user-${index}`);
    const resolved = context.scope();
    const cache = new TitleSourceCache();
    expect(cache.prefetch(context.db, "public_event_calendar_involvement_safe", userIds, resolved)).toEqual({
      loaded: 601,
      readCalls: 3,
    });
    for (const userId of [userIds[0]!, userIds[300]!, userIds[600]!]) {
      expect(cache.get(context.db, "public_event_calendar_involvement_safe", userId, resolved)).toEqual(
        new TitleSourceCache().get(context.db, "public_event_calendar_involvement_safe", userId, resolved),
      );
    }
    const spy = vi.spyOn(context.db, "prepare");
    readTitleSource(context.db, "public_event_calendar_involvement_safe", userIds[0]!, resolved);
    expect(spy.mock.calls.map((call) => String(call[0])).filter((sql) => /public_event_involvements/.test(sql))).toHaveLength(1);
  });
});
