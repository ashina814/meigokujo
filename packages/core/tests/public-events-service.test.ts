import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { PublicEvents, PublicEventsError } from "../src/public-events/service.js";

const BASE = Math.floor(Date.UTC(2026, 7, 20, 0, 0, 0) / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  const events = new PublicEvents(db);
  return { db, events };
}

function baseInput(overrides: Partial<Parameters<PublicEvents["recordFinalizedEvent"]>[0]> = {}) {
  return {
    eventKey: "gf-2026-08-22",
    name: "God Field大会",
    eventDate: "2026-08-22",
    participantUserIds: ["alice", "bob", "carol"],
    recordedBy: "staff-1",
    ...overrides,
  };
}

describe("recordFinalizedEvent() — positive / atomicity", () => {
  it("正常入力で1回だけ記録される", () => {
    const { db, events } = setup();
    const result = events.recordFinalizedEvent(baseInput());
    expect(result).toEqual({
      eventKey: "gf-2026-08-22",
      participantCount: 3,
      recordedAt: BASE,
      alreadyRecorded: false,
    });
    const eventRow = db.prepare(`SELECT * FROM public_events WHERE event_key = ?`).get("gf-2026-08-22");
    expect(eventRow).toMatchObject({ name: "God Field大会", event_date: "2026-08-22", recorded_by: "staff-1", recorded_at: BASE });
    const rows = db.prepare(`SELECT user_id FROM public_event_participations WHERE event_key = ? ORDER BY user_id`).all("gf-2026-08-22");
    expect(rows).toEqual([{ user_id: "alice" }, { user_id: "bob" }, { user_id: "carol" }]);
  });

  it("§56 atomicity: 2人目のparticipant INSERTがtriggerで失敗するとevent row・先行participant行ごとrollbackされる", () => {
    const { db, events } = setup();
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS block_bob_participation
      BEFORE INSERT ON public_event_participations
      WHEN NEW.user_id = 'bob'
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure for bob');
      END;
    `);
    expect(() => events.recordFinalizedEvent(baseInput())).toThrow(/simulated failure for bob/);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_event_participations`).get()).toEqual({ c: 0 });
  });
});

describe("§17, §58 participant dedupe", () => {
  it("alice,bob,alice → 2 rows(最初のappearance順)", () => {
    const { events, db } = setup();
    const result = events.recordFinalizedEvent(baseInput({ participantUserIds: ["alice", "bob", "alice"] }));
    expect(result.participantCount).toBe(2);
    const rows = db.prepare(`SELECT user_id FROM public_event_participations WHERE event_key = ? ORDER BY user_id`).all("gf-2026-08-22");
    expect(rows).toEqual([{ user_id: "alice" }, { user_id: "bob" }]);
  });

  it("空participant listはreject", () => {
    const { events } = setup();
    expect(() => events.recordFinalizedEvent(baseInput({ participantUserIds: [] }))).toThrow(PublicEventsError);
    expect(() => events.recordFinalizedEvent(baseInput({ participantUserIds: [] }))).toThrow(/empty_participants|at least one/);
  });

  it("空文字列/空白だけのidはfail-closedでreject", () => {
    const { events } = setup();
    expect(() => events.recordFinalizedEvent(baseInput({ participantUserIds: ["alice", "  "] }))).toThrow(PublicEventsError);
  });
});

describe("§57 exact idempotency / conflict", () => {
  it("A. 同event/key/name/date/roster再実行 → alreadyRecorded、rows増えない、timestamp不変", () => {
    const { events, db } = setup();
    const first = events.recordFinalizedEvent(baseInput());
    vi.setSystemTime(new Date((BASE + 1000) * 1000));
    const second = events.recordFinalizedEvent(baseInput());
    expect(second.alreadyRecorded).toBe(true);
    expect(second.recordedAt).toBe(first.recordedAt); // 既存値維持、再実行時刻を使わない
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_events`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM public_event_participations`).get()).toEqual({ c: 3 });
  });

  it("B. roster順序だけ違う → same event扱い（alreadyRecorded）", () => {
    const { events } = setup();
    events.recordFinalizedEvent(baseInput({ participantUserIds: ["alice", "bob", "carol"] }));
    const result = events.recordFinalizedEvent(baseInput({ participantUserIds: ["carol", "alice", "bob"] }));
    expect(result.alreadyRecorded).toBe(true);
  });

  it("C. 1人増える → conflict", () => {
    const { events } = setup();
    events.recordFinalizedEvent(baseInput());
    expect(() => events.recordFinalizedEvent(baseInput({ participantUserIds: ["alice", "bob", "carol", "dave"] }))).toThrow(
      /already recorded with a different/,
    );
  });

  it("D. name違い → conflict", () => {
    const { events } = setup();
    events.recordFinalizedEvent(baseInput());
    expect(() => events.recordFinalizedEvent(baseInput({ name: "別の名前" }))).toThrow(/already recorded with a different/);
  });

  it("E. date違い → conflict", () => {
    const { events } = setup();
    events.recordFinalizedEvent(baseInput());
    expect(() => events.recordFinalizedEvent(baseInput({ eventDate: "2026-08-23" }))).toThrow(/already recorded with a different/);
  });

  it("conflictでは既存rowを上書きしない", () => {
    const { events, db } = setup();
    events.recordFinalizedEvent(baseInput());
    try {
      events.recordFinalizedEvent(baseInput({ name: "別の名前" }));
    } catch {
      // expected
    }
    const row = db.prepare(`SELECT name FROM public_events WHERE event_key = ?`).get("gf-2026-08-22") as { name: string };
    expect(row.name).toBe("God Field大会");
  });
});

describe("§59 recordedAt timestamp semantics", () => {
  it("fake clockで、event rowと全participant rowが同一snapshot、callerからtimestamp injection不可", () => {
    const { events, db } = setup();
    events.recordFinalizedEvent(baseInput());
    const eventRow = db.prepare(`SELECT recorded_at FROM public_events WHERE event_key = ?`).get("gf-2026-08-22") as {
      recorded_at: number;
    };
    const participantRows = db
      .prepare(`SELECT recorded_at FROM public_event_participations WHERE event_key = ?`)
      .all("gf-2026-08-22") as Array<{ recorded_at: number }>;
    expect(eventRow.recorded_at).toBe(BASE);
    expect(participantRows.every((r) => r.recorded_at === BASE)).toBe(true);
  });

  it("§13 過去イベントを後から登録してもrecordedAtはservice clock、eventDateではbackdateしない", () => {
    const { events } = setup();
    const result = events.recordFinalizedEvent(baseInput({ eventDate: "2020-01-01" }));
    expect(result.recordedAt).toBe(BASE); // 2020年ではない
  });
});

describe("§18 eventKey validation", () => {
  it("有効なslugは通る", () => {
    const { events } = setup();
    expect(() => events.recordFinalizedEvent(baseInput({ eventKey: "bingo-2026-09-05" }))).not.toThrow();
  });

  for (const invalid of ["GF-2026", "gf 2026", "gf:2026", "gf/2026", "<@123456789012345678>", "", "a".repeat(65)]) {
    it(`invalid eventKey ${JSON.stringify(invalid)} はreject`, () => {
      const { events } = setup();
      expect(() => events.recordFinalizedEvent(baseInput({ eventKey: invalid }))).toThrow(PublicEventsError);
    });
  }
});

describe("§20 name validation", () => {
  it("trim後empty はreject", () => {
    const { events } = setup();
    expect(() => events.recordFinalizedEvent(baseInput({ name: "   " }))).toThrow(PublicEventsError);
  });

  it("200文字超はreject", () => {
    const { events } = setup();
    expect(() => events.recordFinalizedEvent(baseInput({ name: "a".repeat(201) }))).toThrow(PublicEventsError);
  });

  it("200文字ちょうどは通る", () => {
    const { events } = setup();
    expect(() => events.recordFinalizedEvent(baseInput({ name: "a".repeat(200), eventKey: "name-200" }))).not.toThrow();
  });
});

describe("§60 eventDate strict validation", () => {
  it("valid: 2026-08-22", () => {
    const { events } = setup();
    expect(() => events.recordFinalizedEvent(baseInput({ eventDate: "2026-08-22" }))).not.toThrow();
  });

  for (const invalid of ["2026-8-22", "2026-02-30", "2026-13-01", "garbage", "2026/08/22", ""]) {
    it(`invalid: ${JSON.stringify(invalid)}`, () => {
      const { events } = setup();
      expect(() => events.recordFinalizedEvent(baseInput({ eventDate: invalid }))).toThrow(PublicEventsError);
    });
  }
});

describe("§21 recordedByはpayloadへ出さない（service層の最小確認）", () => {
  it("recordFinalizedEvent()の戻り値にrecordedByが含まれない", () => {
    const { events } = setup();
    const result = events.recordFinalizedEvent(baseInput());
    expect(Object.keys(result).sort()).toEqual(["alreadyRecorded", "eventKey", "participantCount", "recordedAt"]);
  });
});

describe("§22 immutability", () => {
  it("公開APIにUPDATE/DELETEが存在しない", () => {
    const { events } = setup();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(events)).filter((m) => m !== "constructor");
    expect(methods).toEqual(["recordFinalizedEvent", "getEventCompletionSummary", "recordCompletedEvent"]);
  });
});

function recordRoster(events: PublicEvents, overrides: Partial<Parameters<PublicEvents["recordFinalizedEvent"]>[0]> = {}) {
  return events.recordFinalizedEvent(baseInput({ eventDate: "2026-08-20", ...overrides }));
}

describe("recordCompletedEvent() — explicit immutable completion", () => {
  it("existing rosterへcompletionを1 rowだけ記録し、resultへcompletedByを出さない", () => {
    const { events, db } = setup();
    recordRoster(events);
    const result = events.recordCompletedEvent({ eventKey: "gf-2026-08-22", completedBy: "staff-completer" });
    expect(result).toEqual({ eventKey: "gf-2026-08-22", participantCount: 3, completedAt: BASE, alreadyRecorded: false });
    expect(Object.keys(result).sort()).toEqual(["alreadyRecorded", "completedAt", "eventKey", "participantCount"]);
    expect(db.prepare(`SELECT * FROM public_event_completions`).all()).toEqual([
      { event_key: "gf-2026-08-22", roster_recorded_at: BASE, completed_by: "staff-completer", completed_at: BASE },
    ]);
  });

  it("missing event / rosterはfail-closed", () => {
    const { events, db } = setup();
    expect(() => events.recordCompletedEvent({ eventKey: "missing-event", completedBy: "staff" })).toThrow(/does not exist/);
    db.prepare(`INSERT INTO public_events (event_key, name, event_date, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?)`).run(
      "rosterless", "Rosterless", "2026-08-20", "staff", BASE,
    );
    expect(() => events.recordCompletedEvent({ eventKey: "rosterless", completedBy: "staff" })).toThrow(/no participant roster/);
  });

  it("clockがrosterより前ならreject、同時刻ならsuccess", () => {
    const db = openDb(":memory:");
    let now = BASE;
    const events = new PublicEvents(db, () => now);
    recordRoster(events);
    now = BASE - 1;
    expect(() => events.recordCompletedEvent({ eventKey: "gf-2026-08-22", completedBy: "staff" })).toThrow(
      /before its roster/,
    );
    now = BASE;
    expect(events.recordCompletedEvent({ eventKey: "gf-2026-08-22", completedBy: "staff" }).completedAt).toBe(BASE);
  });

  it("completion JST dateより未来のevent_dateはreject、同じJST dateは許可", () => {
    const db = openDb(":memory:");
    const sameDayAtJstMidnight = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000); // JST 2026-08-20 00:00
    const events = new PublicEvents(db, () => sameDayAtJstMidnight);
    recordRoster(events, { eventKey: "same-day", eventDate: "2026-08-20" });
    expect(() => events.recordCompletedEvent({ eventKey: "same-day", completedBy: "staff" })).not.toThrow();

    recordRoster(events, { eventKey: "future-day", eventDate: "2026-08-21" });
    expect(() => events.recordCompletedEvent({ eventKey: "future-day", completedBy: "staff" })).toThrow(/future JST event date/);
  });

  it("retryは時刻・最初のcompleted_byを保持し、別staffでもrowを増やさない", () => {
    const db = openDb(":memory:");
    let now = BASE;
    const events = new PublicEvents(db, () => now);
    recordRoster(events);
    const first = events.recordCompletedEvent({ eventKey: "gf-2026-08-22", completedBy: "staff-1" });
    now += 3600;
    const retry = events.recordCompletedEvent({ eventKey: "gf-2026-08-22", completedBy: "staff-2" });
    expect(retry).toEqual({ ...first, alreadyRecorded: true });
    expect(db.prepare(`SELECT completed_by, completed_at FROM public_event_completions`).all()).toEqual([
      { completed_by: "staff-1", completed_at: BASE },
    ]);
  });

  it("callerのcompletedAt injectionを無視し、service clockだけを使う", () => {
    const { events } = setup();
    recordRoster(events);
    const result = events.recordCompletedEvent({
      eventKey: "gf-2026-08-22",
      completedBy: "staff",
      completedAt: 1,
    } as Parameters<PublicEvents["recordCompletedEvent"]>[0]);
    expect(result.completedAt).toBe(BASE);
  });

  it("FK/CHECKを実DB constraintで拒否し、roster既存行を変更しない", () => {
    const { events, db } = setup();
    recordRoster(events);
    const rosterBefore = db.prepare(`SELECT * FROM public_event_participations ORDER BY user_id`).all();
    expect(() =>
      db.prepare(
        `INSERT INTO public_event_completions (event_key, roster_recorded_at, completed_by, completed_at) VALUES (?, ?, ?, ?)`,
      ).run("missing", BASE, "staff", BASE),
    ).toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO public_event_completions (event_key, roster_recorded_at, completed_by, completed_at) VALUES (?, ?, ?, ?)`,
      ).run("gf-2026-08-22", BASE + 1, "staff", BASE + 1),
    ).toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO public_event_completions (event_key, roster_recorded_at, completed_by, completed_at) VALUES (?, ?, ?, ?)`,
      ).run("gf-2026-08-22", BASE, "staff", BASE - 1),
    ).toThrow();
    expect(db.prepare(`SELECT * FROM public_event_participations ORDER BY user_id`).all()).toEqual(rosterBefore);
  });

  it("preview summaryはDB正本値だけを返す", () => {
    const { events } = setup();
    recordRoster(events);
    expect(events.getEventCompletionSummary("gf-2026-08-22")).toEqual({
      eventKey: "gf-2026-08-22",
      name: "God Field大会",
      eventDate: "2026-08-20",
      participantCount: 3,
    });
  });
});
