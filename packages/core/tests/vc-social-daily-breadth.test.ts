import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { computeSafeSocialAggregates } from "../src/vc/derived.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((BASE + 10_000_000) * 1000));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup() {
  const db = openDb(":memory:");
  const insert = (
    userId: string,
    channelId: string,
    start: number,
    end: number | null,
    quality: "observed" | "recovered_estimate" | null = "observed",
    parentId = "private-parent-marker",
  ) =>
    db
      .prepare(
        `INSERT INTO vc_segments
           (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'join')`,
      )
      .run(userId, channelId, parentId, start, end, quality);
  return { db, insert };
}

function rowFor<T extends { userId: string }>(rows: readonly T[], userId = "alice"): T {
  const row = rows.find((candidate) => candidate.userId === userId);
  if (!row) throw new Error(`missing row for ${userId}`);
  return row;
}

describe("vc_social_safe dailyBreadth — daily semantics A-L", () => {
  it("A. 同日の異なるcounterpartをdistinct countする", () => {
    const { db, insert } = setup();
    insert("alice", "secret-a", BASE, BASE + 100);
    insert("bob-secret", "secret-a", BASE, BASE + 40);
    insert("carol-secret", "secret-a", BASE + 60, BASE + 100);

    expect(rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 200 }, ["alice"])).dailyBreadth).toEqual([
      { date: "2026-08-20", distinctCoPresentUsers: 2 },
    ]);
  });

  it("B. 同じcounterpartの同日複数visit・複数channelを一人として数える", () => {
    const { db, insert } = setup();
    for (const [channel, offset] of [["secret-a", 0], ["secret-b", 100]] as const) {
      insert("alice", channel, BASE + offset, BASE + offset + 20);
      insert("bob-secret", channel, BASE + offset, BASE + offset + 20);
    }
    const row = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 200 }, ["alice"]));
    expect(row.dailyBreadth).toEqual([{ date: "2026-08-20", distinctCoPresentUsers: 1 }]);
    expect(row.maxRepeatedDaysWithOneCounterpart).toBe(1);
    expect(row.trustedOverlapSeconds).toBe(40);
  });

  it("C. 同じcounterpartでも異なるJST日は各日のdistinctへ数える", () => {
    const { db, insert } = setup();
    for (const day of [0, 2]) {
      insert("alice", `secret-${day}`, BASE + day * 86_400, BASE + day * 86_400 + 10);
      insert("bob-secret", `secret-${day}`, BASE + day * 86_400, BASE + day * 86_400 + 10);
    }
    const row = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 3 * 86_400 }, ["alice"]));
    expect(row.dailyBreadth).toEqual([
      { date: "2026-08-20", distinctCoPresentUsers: 1 },
      { date: "2026-08-22", distinctCoPresentUsers: 1 },
    ]);
  });

  it("D/E. JST midnightをまたぐoverlapは両日に入り、UTC日では分けない", () => {
    const { db, insert } = setup();
    const midnight = BASE + 86_400;
    insert("alice", "secret-midnight", midnight - 10, midnight + 10);
    insert("bob-secret", "secret-midnight", midnight - 10, midnight + 10);
    expect(rowFor(computeSafeSocialAggregates(db, { start: BASE, end: midnight + 20 }, ["alice"])).dailyBreadth).toEqual([
      { date: "2026-08-20", distinctCoPresentUsers: 1 },
      { date: "2026-08-21", distinctCoPresentUsers: 1 },
    ]);
  });

  it("F. interactionの無い日は0行を補わず、date ASCで返す", () => {
    const { db, insert } = setup();
    for (const day of [3, 0]) {
      insert("alice", `secret-${day}`, BASE + day * 86_400, BASE + day * 86_400 + 10);
      insert(`peer-${day}-secret`, `secret-${day}`, BASE + day * 86_400, BASE + day * 86_400 + 10);
    }
    expect(rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 4 * 86_400 }, ["alice"])).dailyBreadth).toEqual([
      { date: "2026-08-20", distinctCoPresentUsers: 1 },
      { date: "2026-08-23", distinctCoPresentUsers: 1 },
    ]);
  });

  it("G. recovered_estimateを除外し、snapshotでboundedなopen visitは既存契約どおり数える", () => {
    const { db, insert } = setup();
    insert("alice", "secret", BASE, BASE + 100);
    insert("trusted-secret", "secret", BASE, BASE + 100);
    insert("recovered-secret", "secret", BASE, BASE + 100, "recovered_estimate");
    insert("open-secret", "secret", BASE, null, null);
    const row = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 100, observedAt: BASE + 100 }, ["alice"]));
    expect(row.dailyBreadth).toEqual([{ date: "2026-08-20", distinctCoPresentUsers: 2 }]);
    expect(row.distinctCoPresentUsers).toBe(2);
  });

  it("H. overlapが無い訪問はdaily rowを作らない", () => {
    const { db, insert } = setup();
    insert("alice", "secret", BASE, BASE + 10);
    insert("bob-secret", "secret", BASE + 10, BASE + 20);
    expect(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 20 }, ["alice"])).toEqual([]);
  });

  it("I. observedAtより未来のrowを読まない", () => {
    const { db, insert } = setup();
    insert("alice", "past", BASE, BASE + 10);
    insert("bob-secret", "past", BASE, BASE + 10);
    insert("alice", "future", BASE + 30, BASE + 40);
    insert("carol-secret", "future", BASE + 30, BASE + 40);
    const row = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 100, observedAt: BASE + 20 }, ["alice"]));
    expect(row.dailyBreadth).toEqual([{ date: "2026-08-20", distinctCoPresentUsers: 1 }]);
    expect(row.distinctCoPresentUsers).toBe(1);
  });

  it("J. 同じobservedAtなら後からDBが進んでも結果が変わらない", () => {
    const { db, insert } = setup();
    insert("alice", "past", BASE, BASE + 10);
    insert("bob-secret", "past", BASE, BASE + 10);
    const window = { start: BASE, end: BASE + 100, observedAt: BASE + 20 };
    const before = computeSafeSocialAggregates(db, window, ["alice"]);
    insert("alice", "future", BASE + 30, BASE + 40);
    insert("carol-secret", "future", BASE + 30, BASE + 40);
    expect(computeSafeSocialAggregates(db, window, ["alice"])).toEqual(before);
  });

  it("K. window [start,end)へoverlap secondsとdaily presenceをclipする", () => {
    const { db, insert } = setup();
    insert("alice", "clip", BASE - 20, BASE + 40);
    insert("bob-secret", "clip", BASE - 10, BASE + 30);
    const row = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 20 }, ["alice"]));
    expect(row.trustedOverlapSeconds).toBe(20);
    expect(row.dailyBreadth).toEqual([{ date: "2026-08-20", distinctCoPresentUsers: 1 }]);
  });

  it("userIds undefined=全員、[]=対象なし、指定時=指定subjectだけ", () => {
    const { db, insert } = setup();
    insert("alice", "secret", BASE, BASE + 10);
    insert("bob-secret", "secret", BASE, BASE + 10);
    insert("carol-secret", "secret", BASE, BASE + 10);
    expect(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 20 }).map((row) => row.userId).sort()).toEqual([
      "alice",
      "bob-secret",
      "carol-secret",
    ]);
    expect(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 20 }, [])).toEqual([]);
    expect(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 20 }, ["alice"]).map((row) => row.userId)).toEqual(["alice"]);
  });

  it("指定subjectのchannel内にいる第三者同士のpairを混入させない", () => {
    const { db, insert } = setup();
    insert("alice", "secret", BASE, BASE + 10);
    insert("bob-secret", "secret", BASE, BASE + 20);
    insert("carol-secret", "secret", BASE + 10, BASE + 20);
    const rows = computeSafeSocialAggregates(db, { start: BASE, end: BASE + 20 }, ["alice"]);
    expect(rows).toHaveLength(1);
    expect(rowFor(rows).distinctCoPresentUsers).toBe(1);
  });

  it("L. 100年超のoverlapを黙ってtruncateせず拒否する", () => {
    const { db, insert } = setup();
    const end = BASE + (365 * 100 + 1) * 86_400;
    insert("alice", "secret", BASE, end);
    insert("bob-secret", "secret", BASE, end);
    expect(() => computeSafeSocialAggregates(db, { start: BASE, end, observedAt: end }, ["alice"])).toThrow(/more than 36500 days/);
  });
});

describe("vc_social_safe dailyBreadth — existing metrics M-O", () => {
  it("M/N/O. global union・最大pair日数・pair-secondsを維持し、daily sumをglobal distinctと同一視しない", () => {
    const { db, insert } = setup();
    for (const day of [0, 1]) {
      insert("alice", `bob-${day}`, BASE + day * 86_400, BASE + day * 86_400 + 10);
      insert("bob-secret", `bob-${day}`, BASE + day * 86_400, BASE + day * 86_400 + 10);
    }
    insert("alice", "carol", BASE + 20, BASE + 40);
    insert("carol-secret", "carol", BASE + 20, BASE + 40);

    const row = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 2 * 86_400 + 100 }, ["alice"]));
    expect(row).toEqual({
      userId: "alice",
      distinctCoPresentUsers: 2,
      maxRepeatedDaysWithOneCounterpart: 2,
      trustedOverlapSeconds: 40,
      dailyBreadth: [
        { date: "2026-08-20", distinctCoPresentUsers: 2 },
        { date: "2026-08-21", distinctCoPresentUsers: 1 },
      ],
    });
    expect(row.dailyBreadth.reduce((sum, day) => sum + day.distinctCoPresentUsers, 0)).toBe(3);
    expect(row.distinctCoPresentUsers).toBe(2);
  });

  it("N. 3人VCのtrustedOverlapSecondsはwall-clock unionでなくpairごとの延べ秒を維持する", () => {
    const { db, insert } = setup();
    for (const userId of ["alice", "bob-secret", "carol-secret"]) insert(userId, "three-person", BASE, BASE + 60);
    const row = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 100 }, ["alice"]));
    expect(row.trustedOverlapSeconds).toBe(120);
    expect(row.distinctCoPresentUsers).toBe(2);
    expect(row.dailyBreadth).toEqual([{ date: "2026-08-20", distinctCoPresentUsers: 2 }]);
  });
});

describe("vc_social_safe dailyBreadth — semantic false positives", () => {
  function addDay(insert: ReturnType<typeof setup>["insert"], subject: string, day: number, peers: number, peerOffset = 0) {
    for (let i = 0; i < peers; i++) {
      const channel = `${subject}-day-${day}-peer-${i}`;
      const start = BASE + day * 86_400 + i * 2;
      insert(subject, channel, start, start + 1);
      insert(`${subject}-secret-peer-${peerOffset + i}`, channel, start, start + 1);
    }
  }

  it("1. day1 spike + day2-30同一Bobと、30日uniform breadthを区別する", () => {
    const { db, insert } = setup();
    addDay(insert, "spike", 0, 100);
    for (let day = 1; day < 30; day++) addDay(insert, "spike", day, 1);
    for (let day = 0; day < 10; day++) addDay(insert, "uniform", day, 10, day * 10);
    const rows = computeSafeSocialAggregates(db, { start: BASE, end: BASE + 30 * 86_400 }, ["spike", "uniform"]);
    expect(rowFor(rows, "spike").dailyBreadth.map((day) => day.distinctCoPresentUsers)).toEqual([100, ...Array(29).fill(1)]);
    expect(rowFor(rows, "uniform").distinctCoPresentUsers).toBe(100);
    expect(rowFor(rows, "uniform").dailyBreadth.map((day) => day.distinctCoPresentUsers)).toEqual(Array(10).fill(10));
  });

  it("2. 同じglobal distinctでも一日集中と複数日分散を区別する", () => {
    const { db, insert } = setup();
    addDay(insert, "single", 0, 100);
    for (let day = 0; day < 10; day++) addDay(insert, "spread", day, 10, day * 10);
    const rows = computeSafeSocialAggregates(db, { start: BASE, end: BASE + 11 * 86_400 }, ["single", "spread"]);
    expect(rowFor(rows, "single").distinctCoPresentUsers).toBe(100);
    expect(rowFor(rows, "spread").distinctCoPresentUsers).toBe(100);
    expect(rowFor(rows, "single").dailyBreadth).toHaveLength(1);
    expect(rowFor(rows, "spread").dailyBreadth).toHaveLength(10);
  });

  it("3. date列からgapを含むfirst→last spanを後段評価できる", () => {
    const { db, insert } = setup();
    addDay(insert, "alice", 0, 2);
    addDay(insert, "alice", 29, 2);
    const days = rowFor(computeSafeSocialAggregates(db, { start: BASE, end: BASE + 30 * 86_400 }, ["alice"])).dailyBreadth;
    expect(days.map((day) => day.date)).toEqual(["2026-08-20", "2026-09-18"]);
  });
});
