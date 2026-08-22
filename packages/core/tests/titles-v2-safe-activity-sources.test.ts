import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Settings } from "../src/settings/service.js";
import { EventLog } from "../src/events/service.js";
import { Entry } from "../src/entry/service.js";
import { TextActivity } from "../src/text-activity/service.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

registerDefaultTxTypes();

/** JST 2026-08-20 00:00:00 を秒0とする、E1テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);
const OBSERVED_AT = BASE + 100_000;

// Entry.creditInvite()はreal Date.now()（内部now()）でcredited_atを刻む——
// scope window（[BASE-100_000, OBSERVED_AT)）内にDate.now()を固定し、
// 招待テストのcredited_atがscope内へ収まるようにする。
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((BASE + 50_000) * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "test-setup" }); // SYSTEM_EPOCH = BASE-100_000
  clock = BASE + 10_000_000;
  const textActivity = new TextActivity(db);
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  return { db, store, textActivity, entry };
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

const TEXT_ACTIVE_DAYS_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.text-active-days",
    name: "test",
    description: "テスト用fixture",
    sources: ["text_active_days"] as const,
    triggers: ["text_activity"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

const CONFIRMED_INVITES_RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.confirmed-invites",
    name: "test",
    description: "テスト用fixture",
    sources: ["confirmed_invites"] as const,
    triggers: ["invite_confirmed"],
    lifecycle: "active",
    ...COMMON_FIXTURE_FIELDS,
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

function insertTextActiveDay(db: ReturnType<typeof openDb>, userId: string, activityDate: string, observedAt: number) {
  db.prepare(`INSERT INTO text_active_days (user_id, activity_date, observed_at) VALUES (?, ?, ?)`).run(
    userId,
    activityDate,
    observedAt,
  );
}

function insertInvite(db: ReturnType<typeof openDb>, inviterId: string, inviteeId: string, creditedAt: number) {
  db.prepare(`INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, ?)`).run(
    inviterId,
    inviteeId,
    creditedAt,
  );
}

// ─────────────────────────────────────────────────────────────

describe("source contract（§42）", () => {
  it("text_active_days: persisted / safe / history / orderable / titleUsable / point at observed_at", () => {
    expect(TITLE_SOURCES.text_active_days).toMatchObject({
      origin: "persisted",
      kind: "history",
      privacy: "safe",
      orderable: true,
      titleUsable: true,
      epochPolicy: { type: "point", at: "observed_at" },
    });
  });

  it("confirmed_invites: persisted / safe / history / orderable / titleUsable / point at credited_at", () => {
    expect(TITLE_SOURCES.confirmed_invites).toMatchObject({
      origin: "persisted",
      kind: "history",
      privacy: "safe",
      orderable: true,
      titleUsable: true,
      epochPolicy: { type: "point", at: "credited_at" },
    });
  });
});

describe("zero-result normalization（§34）", () => {
  it("text_active_days: 0件userはdays:[]を明示的に返す", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, TEXT_ACTIVE_DAYS_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "text_active_days", "nobody", scope)).toEqual({ days: [] });
  });

  it("confirmed_invites: 0件userはcreditedAt:[]を明示的に返す", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "confirmed_invites", "nobody", scope)).toEqual({ creditedAt: [] });
  });
});

describe("text_active_days payload shape（§22-23）", () => {
  it("dateとobservedAtだけを含む。message数・channel・messageIdは含まない", () => {
    const { db, store } = setup();
    insertTextActiveDay(db, "alice", "2026-08-20", OBSERVED_AT - 100);
    const scope = resolveTitleScope(store, TEXT_ACTIVE_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "text_active_days", "alice", scope);
    expect(payload).toEqual({ days: [{ date: "2026-08-20", observedAt: OBSERVED_AT - 100 }] });
    expect(Object.keys(payload.days[0]!).sort()).toEqual(["date", "observedAt"]);
  });
});

describe("scope filtering: [start, end) exclusive end（§53）", () => {
  it("text_active_days: scope開始前は除外・開始ちょうどは含む・終了ちょうどは除外", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, TEXT_ACTIVE_DAYS_RULE.definition, OBSERVED_AT);
    insertTextActiveDay(db, "alice", "2020-01-01", scope.start - 1); // scope開始前
    insertTextActiveDay(db, "alice", "2020-01-02", scope.start); // scope開始ちょうど(inclusive)
    insertTextActiveDay(db, "alice", "2020-01-03", OBSERVED_AT - 1); // effectiveEnd直前
    insertTextActiveDay(db, "alice", "2020-01-04", OBSERVED_AT); // effectiveEndちょうど(exclusive、observedAt自体)

    const payload = readTitleSource(db, "text_active_days", "alice", scope);
    expect(payload.days.map((d) => d.date)).toEqual(["2020-01-02", "2020-01-03"]);
  });

  it("confirmed_invites: scope開始前は除外・開始ちょうどは含む・終了ちょうどは除外", () => {
    const { db, store } = setup();
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    insertInvite(db, "alice", "invitee-before", scope.start - 1);
    insertInvite(db, "alice", "invitee-at-start", scope.start);
    insertInvite(db, "alice", "invitee-before-end", OBSERVED_AT - 1);
    insertInvite(db, "alice", "invitee-at-end", OBSERVED_AT);

    const payload = readTitleSource(db, "confirmed_invites", "alice", scope);
    expect(payload.creditedAt).toEqual([scope.start, OBSERVED_AT - 1]);
  });
});

describe("single-vs-bulk equivalence（D1と同じ方式）", () => {
  it("text_active_days: fresh single get == bulk prefetch → get（複数user）", () => {
    const { db, store } = setup();
    insertTextActiveDay(db, "alice", "2026-08-10", BASE - 50_000);
    insertTextActiveDay(db, "alice", "2026-08-15", BASE);
    insertTextActiveDay(db, "bob", "2026-08-12", BASE - 30_000);
    const scope = resolveTitleScope(store, TEXT_ACTIVE_DAYS_RULE.definition, OBSERVED_AT);

    const single = new TitleSourceCache();
    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "text_active_days", ["alice", "bob"], scope);
    for (const userId of ["alice", "bob"]) {
      expect(bulk.get(db, "text_active_days", userId, scope)).toEqual(single.get(db, "text_active_days", userId, scope));
    }
  });

  it("confirmed_invites: fresh single get == bulk prefetch → get（複数user）", () => {
    const { db, store } = setup();
    insertInvite(db, "alice", "invitee-1", BASE - 50_000);
    insertInvite(db, "alice", "invitee-2", BASE);
    insertInvite(db, "bob", "invitee-3", BASE - 30_000);
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);

    const single = new TitleSourceCache();
    const bulk = new TitleSourceCache();
    bulk.prefetch(db, "confirmed_invites", ["alice", "bob"], scope);
    for (const userId of ["alice", "bob"]) {
      expect(bulk.get(db, "confirmed_invites", userId, scope)).toEqual(single.get(db, "confirmed_invites", userId, scope));
    }
  });
});

describe("deep freeze（§35）", () => {
  it("text_active_days payloadはnested arrayまでfreezeされる", () => {
    const { db, store } = setup();
    insertTextActiveDay(db, "alice", "2026-08-20", BASE);
    const scope = resolveTitleScope(store, TEXT_ACTIVE_DAYS_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "text_active_days", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.days)).toBe(true);
    expect(Object.isFrozen(payload.days[0])).toBe(true);
    expect(() => {
      (payload.days as unknown[]).push({});
    }).toThrow();
  });

  it("confirmed_invites payloadはcreditedAt配列までfreezeされる", () => {
    const { db, store } = setup();
    insertInvite(db, "alice", "invitee-1", BASE);
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "confirmed_invites", "alice", scope);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.creditedAt)).toBe(true);
    expect(() => {
      (payload.creditedAt as number[]).push(999);
    }).toThrow();
  });
});

describe("invite correctness（§50）", () => {
  it("A. inviter hintだけ保存（creditInvite未到達）→ confirmed_invites 0件", () => {
    const { db, store, entry } = setup();
    entry.recordInviterHint("newbie", { userId: "alice", source: "user" }, "auto", "system:test");
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "confirmed_invites", "alice", scope)).toEqual({ creditedAt: [] });
  });

  it("B. creditInvite成功 → confirmed_invites 1件", () => {
    const { db, store, entry } = setup();
    entry.creditInvite("newbie", "alice", "user", null);
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "confirmed_invites", "alice", scope).creditedAt).toHaveLength(1);
  });

  it("C. 同じinviteeを再creditしてもduplicateされない", () => {
    const { db, store, entry } = setup();
    entry.creditInvite("newbie", "alice", "user", null);
    entry.creditInvite("newbie", "alice", "user", null); // 同じinviteeへの再credit
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "confirmed_invites", "alice", scope).creditedAt).toHaveLength(1);
  });

  it("D. 別inviteeをcreditすると2件になる", () => {
    const { db, store, entry } = setup();
    entry.creditInvite("newbie1", "alice", "user", null);
    entry.creditInvite("newbie2", "alice", "user", null);
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    expect(readTitleSource(db, "confirmed_invites", "alice", scope).creditedAt).toHaveLength(2);
  });
});

describe("invite identity非開示（§26-27, §51）", () => {
  it("bobがaliceを招待しても、payloadのJSON.stringifyへ'alice'は含まれない（DB rowには存在する）", () => {
    const { db, store, entry } = setup();
    entry.creditInvite("alice", "bob", "user", null);

    const dbRow = db.prepare(`SELECT invitee_id FROM invites WHERE inviter_id = 'bob'`).get() as {
      invitee_id: string;
    };
    expect(dbRow.invitee_id).toBe("alice"); // DB rowには存在する（正本）

    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "confirmed_invites", "bob", scope);
    expect(payload.creditedAt).toHaveLength(1); // 実際にconfirmed invite 1件が読めていることを保証してから非開示を確認する
    expect(JSON.stringify(payload)).not.toContain("alice");
  });

  it("readerがinviterId自身もpayloadへ含めない（呼び出し側で既知のsubject userId以外を返さない）", () => {
    const { db, store, entry } = setup();
    entry.creditInvite("alice", "bob", "user", null);
    const scope = resolveTitleScope(store, CONFIRMED_INVITES_RULE.definition, OBSERVED_AT);
    const payload = readTitleSource(db, "confirmed_invites", "bob", scope);
    expect(payload.creditedAt).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain("bob");
  });
});

describe("forged scope rejection（§54、既存provenance契約を維持）", () => {
  it("text_active_days: 手書きscopeはfail-closed", () => {
    const { db } = setup();
    const forged = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    expect(() => readTitleSource(db, "text_active_days", "alice", forged as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });

  it("confirmed_invites: 手書きscopeはfail-closed", () => {
    const { db } = setup();
    const forged = { scopeKey: "global", start: BASE, endExclusive: null, observedAt: OBSERVED_AT };
    expect(() => readTitleSource(db, "confirmed_invites", "alice", forged as never)).toThrow(
      /not produced by resolveTitleScope/,
    );
  });
});
