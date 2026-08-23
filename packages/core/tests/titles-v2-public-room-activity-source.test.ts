import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { computePublicRoomActivitySafe } from "../src/rooms/derived.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule, evaluateTitle } from "../src/titles/v2-evaluator.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const END = BASE + 10 * 86_400;
const WINDOW = { start: BASE - 86_400, end: END, observedAt: END };

const RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.public-room-activity-safe",
    catalog: "test",
    name: "test",
    emoji: "x",
    description: "test",
    sources: ["public_room_activity_safe"] as const,
    triggers: ["room_activity"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey: "test-theme",
    groupKey: "test-group",
    collectionDomainKey: "test-domain",
    scope: { type: "global" },
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

type Db = ReturnType<typeof openDb>;
type RoomKind = "normal" | "game" | "mitsugetsu" | "oborozuki";

function setup() {
  const db = openDb(":memory:");
  // Sourceはhistorical sessionを扱う。runtimeの「同時にopenな所有枠は1つ」guardは
  // fixtureで複数の過去sessionを組み立てる妨げになるため、この専用read-only testでは外す。
  db.exec("DROP INDEX idx_rooms_owner_normal_open; DROP INDEX idx_rooms_owner_special_open");
  let clock = BASE - 100_000;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "setup" });
  clock = END;
  return { db, store, scope: () => resolveTitleScope(store, RULE.definition, END) };
}

function room(
  db: Db,
  ownerId: string,
  channelId: string,
  opts: {
    kind?: RoomKind;
    createdAt?: number;
    closedAt?: number | null;
    expiresAt?: number | null;
    activatedAt?: number | null;
    capacity?: number;
  } = {},
): number {
  const createdAt = opts.createdAt ?? BASE;
  const result = db
    .prepare(
      `INSERT INTO rooms
         (kind, channel_id, owner_id, capacity, expires_at, activated_at, status, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.kind ?? "normal",
      channelId,
      ownerId,
      opts.capacity ?? 2,
      opts.expiresAt ?? null,
      opts.activatedAt ?? null,
      opts.closedAt === undefined || opts.closedAt === null ? "open" : "closed",
      opts.closedAt === undefined ? null : opts.closedAt,
      createdAt,
      createdAt,
    );
  return Number(result.lastInsertRowid);
}

function visit(
  db: Db,
  userId: string,
  channelId: string,
  start: number,
  end: number | null,
  opts: {
    quality?: "observed" | "recovered_estimate" | null;
    reason?: "join" | "move" | "state_change" | null;
    parentId?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO vc_segments
       (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  ).run(
    userId,
    channelId,
    opts.parentId ?? "parent-secret-marker",
    start,
    end,
    opts.quality === undefined ? "observed" : opts.quality,
    opts.reason === undefined ? "join" : opts.reason,
  );
}

function aggregate(db: Db, userId: string, window = WINDOW) {
  return computePublicRoomActivitySafe(db, window, [userId])[0]!;
}

function zero(userId: string) {
  return {
    userId,
    hosted: { distinctGuests: 0, sessionCount: 0, maxConcurrentGuests: 0, maxRepeatGuestDepth: 0, days: [] },
    guest: { distinctOwners: 0, sessionCount: 0, days: [] },
    ownUse: { sessionCount: 0, days: [] },
  };
}

function zeroPayload() {
  const { hosted, guest, ownUse } = zero("unused");
  return { hosted, guest, ownUse };
}

describe("A-I host semantics", () => {
  it.each(["normal", "game"] as const)("A/B. %s + trusted guestはeligible", (kind) => {
    const { db } = setup();
    room(db, "owner", `channel-${kind}`, { kind, expiresAt: kind === "game" ? BASE + 100 : null });
    visit(db, "guest", `channel-${kind}`, BASE + 10, BASE + 20);
    expect(aggregate(db, "owner").hosted).toMatchObject({ distinctGuests: 1, sessionCount: 1 });
  });

  it("C/D. room作成またはactivated_atだけではhosted activityにならない", () => {
    const { db } = setup();
    for (let index = 0; index < 100; index++) room(db, "owner", `created-only-${index}`);
    room(db, "owner", "activated-only", { activatedAt: BASE + 10 });
    expect(aggregate(db, "owner")).toEqual(zero("owner"));
  });

  it("E/F. owner本人だけならownUse、owner不在のguestでもhosted", () => {
    const { db } = setup();
    room(db, "owner", "self-room");
    room(db, "owner", "guest-room");
    visit(db, "owner", "self-room", BASE + 1, BASE + 20);
    visit(db, "guest", "guest-room", BASE + 1, BASE + 20);
    expect(aggregate(db, "owner")).toMatchObject({
      hosted: { distinctGuests: 1, sessionCount: 1 },
      guest: { distinctOwners: 0, sessionCount: 0 },
      ownUse: { sessionCount: 1 },
    });
  });

  it("G/H/I. guest/session/dayを正しくdistinct集計する", () => {
    const { db } = setup();
    room(db, "owner", "session-1");
    room(db, "owner", "session-2");
    visit(db, "bob", "session-1", BASE + 1, BASE + 10);
    visit(db, "bob", "session-1", BASE + 20, BASE + 30);
    visit(db, "bob", "session-2", BASE + 40, BASE + 50);
    visit(db, "carol", "session-2", BASE + 45, BASE + 55);
    expect(aggregate(db, "owner").hosted).toEqual({
      distinctGuests: 2,
      sessionCount: 2,
      maxConcurrentGuests: 2,
      maxRepeatGuestDepth: 1,
      days: [{ date: "2026-08-20", distinctGuests: 2, sessionsWithGuests: 2 }],
    });
  });

  it("canonical coalesceとpartial_observationのtrusted duration semanticsを再利用する", () => {
    const { db } = setup();
    room(db, "owner", "coalesced");
    room(db, "owner", "partial");
    visit(db, "guest", "coalesced", BASE + 1, BASE + 10);
    visit(db, "guest", "coalesced", BASE + 10, BASE + 20, { reason: "state_change" });
    visit(db, "partial-guest", "partial", BASE + 30, BASE + 40, { reason: "state_change" });
    expect(aggregate(db, "owner").hosted).toMatchObject({ distinctGuests: 2, sessionCount: 2 });
  });
});

describe("J-O concurrency / trust", () => {
  it("J/K/M. 2人・3人のoverlapをcapacityではなくtrusted distinct guestで数える", () => {
    const { db } = setup();
    room(db, "owner", "busy", { capacity: 10 });
    visit(db, "a", "busy", BASE + 1, BASE + 30);
    visit(db, "b", "busy", BASE + 10, BASE + 40);
    visit(db, "c", "busy", BASE + 20, BASE + 25);
    expect(aggregate(db, "owner").hosted.maxConcurrentGuests).toBe(3);
  });

  it("L. A.end === B.startは半開区間のため同時2人にしない", () => {
    const { db } = setup();
    room(db, "owner", "ties");
    visit(db, "a", "ties", BASE + 1, BASE + 10);
    visit(db, "b", "ties", BASE + 10, BASE + 20);
    expect(aggregate(db, "owner").hosted.maxConcurrentGuests).toBe(1);
  });

  it("N. recovered guestだけを除外しtrusted sibling concurrencyを残す", () => {
    const { db } = setup();
    room(db, "owner", "mixed-trust");
    visit(db, "a", "mixed-trust", BASE + 1, BASE + 30);
    visit(db, "b", "mixed-trust", BASE + 2, BASE + 25);
    visit(db, "untrusted", "mixed-trust", BASE + 3, BASE + 20, { quality: "recovered_estimate" });
    expect(aggregate(db, "owner").hosted).toMatchObject({ distinctGuests: 2, maxConcurrentGuests: 2 });
  });

  it("O. 0秒intersectionはactivityにしない", () => {
    const { db } = setup();
    room(db, "owner", "zero");
    visit(db, "guest", "zero", BASE + 10, BASE + 10);
    expect(aggregate(db, "owner")).toEqual(zero("owner"));
  });
});

describe("P-T repeat guest joint correlation", () => {
  it("P. same session / 2 JST daysはdepth 1", () => {
    const { db } = setup();
    room(db, "owner", "overnight", { createdAt: BASE - 100 });
    visit(db, "bob", "overnight", BASE - 10, BASE + 10);
    expect(aggregate(db, "owner").hosted.maxRepeatGuestDepth).toBe(1);
  });

  it("Q/R/T. session/dayの同一guest joint depthを返す", () => {
    const { db } = setup();
    for (let day = 0; day < 3; day++) {
      room(db, "owner", `bob-${day}`, { createdAt: BASE + day * 86_400 });
      visit(db, "bob", `bob-${day}`, BASE + day * 86_400 + 10, BASE + day * 86_400 + 20);
    }
    room(db, "owner", "same-day-extra");
    visit(db, "bob", "same-day-extra", BASE + 100, BASE + 110);
    expect(aggregate(db, "owner").hosted.maxRepeatGuestDepth).toBe(3);
  });

  it("S. 別guestのmax day/sessionを合成しない", () => {
    const { db } = setup();
    room(db, "owner", "bob-one-session", { createdAt: BASE - 100 });
    visit(db, "bob", "bob-one-session", BASE - 10, BASE + 10);
    visit(db, "bob", "bob-one-session", BASE + 86_400 + 10, BASE + 86_400 + 20);
    visit(db, "bob", "bob-one-session", BASE + 2 * 86_400 + 10, BASE + 2 * 86_400 + 20);
    for (let index = 0; index < 3; index++) {
      room(db, "owner", `carol-${index}`);
      visit(db, "carol", `carol-${index}`, BASE + 100 + index * 20, BASE + 110 + index * 20);
    }
    expect(aggregate(db, "owner").hosted.maxRepeatGuestDepth).toBe(1);
  });
});

describe("U-AC guest / ownUse", () => {
  it("U/V/W/X/Y. guest側はowner不在でもowner/session/dayをdistinct集計する", () => {
    const { db } = setup();
    room(db, "owner-a", "a1");
    room(db, "owner-a", "a2");
    room(db, "owner-b", "b1", { createdAt: BASE + 86_400 });
    visit(db, "traveler", "a1", BASE + 10, BASE + 20);
    visit(db, "traveler", "a2", BASE + 30, BASE + 40);
    visit(db, "traveler", "b1", BASE + 86_410, BASE + 86_420);
    expect(aggregate(db, "traveler").guest).toEqual({
      distinctOwners: 2,
      sessionCount: 3,
      days: [
        { date: "2026-08-20", distinctOwners: 1, sessionsVisited: 2 },
        { date: "2026-08-21", distinctOwners: 1, sessionsVisited: 1 },
      ],
    });
  });

  it("Z/AA/AB/AC. ownUseはowner本人のtrusted visitだけで成立する", () => {
    const { db } = setup();
    room(db, "owner", "own-day-1", { activatedAt: BASE + 1 });
    room(db, "owner", "own-day-2", { createdAt: BASE + 86_400 });
    room(db, "owner", "guest-only");
    visit(db, "owner", "own-day-1", BASE + 10, BASE + 20);
    visit(db, "owner", "own-day-2", BASE + 86_410, BASE + 86_420);
    visit(db, "guest", "guest-only", BASE + 30, BASE + 40);
    expect(aggregate(db, "owner")).toMatchObject({
      hosted: { distinctGuests: 1, sessionCount: 1 },
      ownUse: {
        sessionCount: 2,
        days: [
          { date: "2026-08-20", sessionsUsed: 1 },
          { date: "2026-08-21", sessionsUsed: 1 },
        ],
      },
    });
  });
});

describe("AD-AM private / lifecycle / snapshot", () => {
  it.each(["mitsugetsu", "oborozuki"] as const)("AD/AE. private kind %sは大量activityでも完全除外", (kind) => {
    const { db } = setup();
    room(db, "owner-secret-marker", `private-${kind}`, { kind });
    for (let index = 0; index < 20; index++) visit(db, `guest-${index}`, `private-${kind}`, BASE + index, BASE + 100);
    expect(aggregate(db, "owner-secret-marker")).toEqual(zero("owner-secret-marker"));
  });

  it("AF/AG. created_atより前だけは0、跨ぐvisitはpost-create部分だけactivity", () => {
    const { db } = setup();
    room(db, "owner", "before", { createdAt: BASE + 20 });
    room(db, "owner", "cross", { createdAt: BASE + 20 });
    visit(db, "before-guest", "before", BASE, BASE + 20);
    visit(db, "cross-guest", "cross", BASE + 10, BASE + 30);
    expect(aggregate(db, "owner").hosted).toMatchObject({ distinctGuests: 1, sessionCount: 1 });
  });

  it("AH/AI. closed_at以後だけは0、跨ぐvisitはpre-close部分だけactivity", () => {
    const { db } = setup();
    room(db, "owner", "after", { closedAt: BASE + 20 });
    room(db, "owner", "cross-close", { closedAt: BASE + 20 });
    visit(db, "after-guest", "after", BASE + 20, BASE + 30);
    visit(db, "cross-guest", "cross-close", BASE + 10, BASE + 30);
    expect(aggregate(db, "owner").hosted).toMatchObject({ distinctGuests: 1, sessionCount: 1 });
  });

  it("AJ/AK. future closeとfuture-created DB追加は同じobservedAtのsnapshotを書き換えない", () => {
    const { db } = setup();
    const roomId = room(db, "owner", "snapshot");
    visit(db, "guest", "snapshot", BASE + 10, null);
    const snapshot = { start: BASE, end: BASE + 1_000, observedAt: BASE + 100 };
    const before = aggregate(db, "owner", snapshot);
    db.prepare("UPDATE rooms SET status = 'closed', closed_at = ? WHERE id = ?").run(BASE + 200, roomId);
    room(db, "owner", "future-room", { createdAt: BASE + 101 });
    visit(db, "future-guest", "future-room", BASE + 101, BASE + 110);
    expect(aggregate(db, "owner", snapshot)).toEqual(before);
  });

  it("game expires_atはcleanup前でもpaid validity上限になる", () => {
    const { db } = setup();
    room(db, "owner", "expired-game", { kind: "game", expiresAt: BASE + 20 });
    visit(db, "after-expiry", "expired-game", BASE + 20, BASE + 30);
    expect(aggregate(db, "owner")).toEqual(zero("owner"));
  });

  it("AL. JST midnightを両日にsplitしglobal sessionは1のまま", () => {
    const { db } = setup();
    room(db, "owner", "midnight", { createdAt: BASE - 100 });
    visit(db, "owner", "midnight", BASE - 10, BASE + 10);
    expect(aggregate(db, "owner").ownUse).toEqual({
      sessionCount: 1,
      days: [
        { date: "2026-08-19", sessionsUsed: 1 },
        { date: "2026-08-20", sessionsUsed: 1 },
      ],
    });
  });

  it("AM. overlapするduplicate room sessionの曖昧範囲だけをfail-closed", () => {
    const { db } = setup();
    db.exec("DROP TABLE rooms");
    db.exec(`CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, channel_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, capacity INTEGER NOT NULL, expires_at INTEGER, activated_at INTEGER,
      status TEXT NOT NULL, closed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    room(db, "owner-a", "corrupt", { createdAt: BASE, closedAt: BASE + 30 });
    room(db, "owner-b", "corrupt", { createdAt: BASE + 10, closedAt: BASE + 20 });
    room(db, "clean-owner", "clean");
    visit(db, "guest", "corrupt", BASE + 10, BASE + 20);
    visit(db, "guest", "clean", BASE + 10, BASE + 20);
    expect(aggregate(db, "owner-a")).toEqual(zero("owner-a"));
    expect(aggregate(db, "owner-b")).toEqual(zero("owner-b"));
    expect(aggregate(db, "clean-owner").hosted.sessionCount).toBe(1);
  });
});

describe("AN-AW source runtime / privacy / boundedness", () => {
  it("AN/AO. single/bulk equivalenceとzero payload exact shape", () => {
    const { db, scope } = setup();
    room(db, "owner", "room");
    visit(db, "guest", "room", BASE + 10, BASE + 20);
    const resolved = scope();
    const single = readTitleSource(db, "public_room_activity_safe", "owner", resolved);
    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "public_room_activity_safe", ["owner", "nobody"], resolved)).toEqual({ loaded: 2, readCalls: 1 });
    expect(cache.get(db, "public_room_activity_safe", "owner", resolved)).toEqual(single);
    expect(cache.get(db, "public_room_activity_safe", "nobody", resolved)).toEqual(zeroPayload());
  });

  it("AP. requested user以外をcacheへ混入させない", () => {
    const { db, scope } = setup();
    room(db, "owner", "room");
    visit(db, "guest-secret-marker", "room", BASE + 10, BASE + 20);
    const cache = new TitleSourceCache();
    cache.prefetch(db, "public_room_activity_safe", ["owner"], scope());
    const spy = vi.spyOn(db, "prepare");
    cache.get(db, "public_room_activity_safe", "guest-secret-marker", scope());
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it("AQ. 300-user chunkを維持する", () => {
    const { db, scope } = setup();
    const users = Array.from({ length: 301 }, (_, index) => `user-${index}`);
    expect(new TitleSourceCache().prefetch(db, "public_room_activity_safe", users, scope())).toEqual({ loaded: 301, readCalls: 2 });
  });

  it("AR. 1200 room/channelを300 bind chunkで処理しN+1にしない", () => {
    const { db } = setup();
    for (let index = 0; index < 1200; index++) {
      const channel = `channel-${index}`;
      room(db, `owner-${index}`, channel);
      visit(db, "traveler", channel, BASE + 10, BASE + 20);
    }
    const spy = vi.spyOn(db, "prepare");
    expect(aggregate(db, "traveler").guest.sessionCount).toBe(1200);
    const relevantSql = spy.mock.calls.map(([sql]) => String(sql)).filter((sql) => /channel_id IN|user_id IN/.test(sql));
    expect(relevantSql.length).toBeLessThanOrEqual(9);
    expect(Math.max(...relevantSql.map((sql) => sql.match(/\?/g)?.length ?? 0))).toBeLessThanOrEqual(303);
  });

  it("AS. payload全階層をdeep freezeする", () => {
    const { db, scope } = setup();
    room(db, "owner", "room");
    visit(db, "owner", "room", BASE + 1, BASE + 20);
    visit(db, "guest", "room", BASE + 1, BASE + 20);
    const payload = readTitleSource(db, "public_room_activity_safe", "owner", scope());
    for (const value of [
      payload,
      payload.hosted,
      payload.hosted.days,
      payload.hosted.days[0],
      payload.guest,
      payload.guest.days,
      payload.ownUse,
      payload.ownUse.days,
      payload.ownUse.days[0],
    ]) expect(Object.isFrozen(value)).toBe(true);
  });

  it("AT/AU/AV. safe derivedとrestricted rawのexact contract、およびraw generic read拒否", () => {
    const { db, scope } = setup();
    expect(TITLE_SOURCES.public_room_activity_safe).toMatchObject({
      origin: "derived",
      derivedFrom: ["rooms", "vc_visits"],
      privacy: "safe",
      titleUsable: true,
      orderable: false,
      rawUnit: "public_room_safe_activity_aggregate",
    });
    expect(TITLE_SOURCES.rooms).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      titleUsable: false,
      orderable: false,
      restrictedUse: "public_room_safe_activity_classification",
      rawUnit: "room_lifecycle_session_record",
    });
    expect(() => readTitleSource(db, "rooms" as never, "owner", scope())).toThrow(/not usable/);
  });

  it("AW. non-orderable sourceだけのruleはnon-null earnedAtをfail-closed", () => {
    const { db, store } = setup();
    const badRule = defineTitleRule(
      { ...RULE.definition, key: "v2.test.public-room-bad-earned-at" },
      { awardFactsVersion: 1, evaluate: () => ({ matched: true, earnedAt: BASE + 1, awardFacts: {} }) },
    );
    expect(() => evaluateTitle(db, store, badRule, "owner", END)).toThrow(/non-orderable/);
  });

  it("privacy: safe payloadはidentity・room private metadataを一切漏らさない", () => {
    const { db, scope } = setup();
    room(db, "owner-secret-marker", "channel-secret-marker", { capacity: 99 });
    visit(db, "guest-secret-marker", "channel-secret-marker", BASE + 10, BASE + 20, { parentId: "parent-secret-marker" });
    const payload = readTitleSource(db, "public_room_activity_safe", "owner-secret-marker", scope());
    const json = JSON.stringify(payload);
    for (const marker of ["owner-secret-marker", "guest-secret-marker", "channel-secret-marker", "parent-secret-marker"]) {
      expect(json).not.toContain(marker);
    }
    for (const key of ["guestId", "ownerId", "userId", "roomId", "channelId", "pair", "counterpart", "matchedUser", "requester", "target", "capacity", "closeReason"]) {
      expect(json).not.toContain(key);
    }
  });

  it("recruits / oborozuki_invitesをpublic guest inferenceへ使わない", () => {
    const { db } = setup();
    const privateRoomId = room(db, "private-owner", "private", { kind: "mitsugetsu" });
    const oborozukiRoomId = room(db, "private-owner", "oborozuki-private", { kind: "oborozuki" });
    db.prepare(
      `INSERT INTO recruits (room_id, owner_id, target_gender, purpose, message, status, created_at, expires_at, matched_user_id)
       VALUES (?, 'private-owner', 'male', 'secret', 'secret', 'matched', ?, ?, 'matched-secret')`,
    ).run(privateRoomId, BASE, BASE + 100);
    db.prepare(
      `INSERT INTO oborozuki_invites
         (requester_id, target_id, status, token, price, expires_at, room_id, channel_id, created_at, updated_at, decided_at)
       VALUES ('private-owner', 'target-secret', 'accepted', 'token-secret', 0, ?, ?, 'oborozuki-private', ?, ?, ?)`,
    ).run(BASE + 100, oborozukiRoomId, BASE, BASE, BASE + 1);
    expect(aggregate(db, "private-owner")).toEqual(zero("private-owner"));
  });
});
