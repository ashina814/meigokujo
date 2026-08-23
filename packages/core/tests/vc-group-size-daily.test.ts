import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import {
  computeGroupSizeDailySeconds,
  computeGroupSizeSeconds,
  type OccupancyBucket,
} from "../src/vc/derived.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const BUCKETS: readonly OccupancyBucket[] = ["solo", "oneToOne", "smallGroup", "largeGroup"];

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
  const statement = db.prepare(
    `INSERT INTO vc_segments
       (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
  );
  const insert = (
    userId: string,
    channelId: string,
    start: number,
    end: number | null,
    quality: "observed" | "recovered_estimate" | null = "observed",
    startReason: "join" | "move" | "state_change" | null = "join",
    parentId: string | null = null,
  ) => statement.run(userId, channelId, parentId, start, end, quality, startReason);
  return { db, insert };
}

function addOccupancy(
  insert: ReturnType<typeof setup>["insert"],
  channelId: string,
  start: number,
  end: number,
  occupancy: number,
  subject = "alice",
) {
  insert(subject, channelId, start, end);
  for (let i = 1; i < occupancy; i++) insert(`${channelId}-peer-${i}`, channelId, start, end);
}

function rowFor<T extends { userId: string }>(rows: readonly T[], userId = "alice"): T {
  const row = rows.find((candidate) => candidate.userId === userId);
  if (!row) throw new Error(`missing row for ${userId}`);
  return row;
}

function totalDailyByBucket(days: ReturnType<typeof computeGroupSizeDailySeconds>[number]["days"]) {
  const totals: Record<OccupancyBucket, number> = { solo: 0, oneToOne: 0, smallGroup: 0, largeGroup: 0 };
  for (const day of days) for (const bucket of BUCKETS) totals[bucket] += day.trustedSecondsByBucket[bucket];
  return totals;
}

describe("vc_group_size_daily_safe — daily semantics A-N", () => {
  it("A. 同日の1対1 600秒をJST date 1行へ集計する", () => {
    const { db, insert } = setup();
    addOccupancy(insert, "secret-channel", BASE + 100, BASE + 700, 2);
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 1000 }, ["alice"])).days).toEqual([
      {
        date: "2026-08-20",
        trustedSecondsByBucket: { solo: 0, oneToOne: 600, smallGroup: 0, largeGroup: 0 },
      },
    ]);
  });

  it("B. JST midnightを23:59:50→00:00:10で正確に10秒ずつへ分ける", () => {
    const { db, insert } = setup();
    const midnight = BASE + 86_400;
    addOccupancy(insert, "vc", midnight - 10, midnight + 10, 2);
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: midnight + 20 }, ["alice"])).days).toEqual([
      { date: "2026-08-20", trustedSecondsByBucket: { solo: 0, oneToOne: 10, smallGroup: 0, largeGroup: 0 } },
      { date: "2026-08-21", trustedSecondsByBucket: { solo: 0, oneToOne: 10, smallGroup: 0, largeGroup: 0 } },
    ]);

    const { db: exactDb, insert: exactInsert } = setup();
    addOccupancy(exactInsert, "exact", midnight - 10, midnight, 2);
    expect(rowFor(computeGroupSizeDailySeconds(exactDb, { start: BASE, end: midnight + 20 }, ["alice"])).days).toHaveLength(1);
  });

  it("C. 同日occupancy transitionを4bucketへexact集計する", () => {
    const { db, insert } = setup();
    insert("alice", "vc", BASE, BASE + 100);
    insert("p1", "vc", BASE + 10, BASE + 100);
    insert("p2", "vc", BASE + 30, BASE + 100);
    insert("p3", "vc", BASE + 60, BASE + 100);
    insert("p4", "vc", BASE + 60, BASE + 100);
    const day = rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 100 }, ["alice"])).days[0]!;
    expect(day.trustedSecondsByBucket).toEqual({ solo: 10, oneToOne: 20, smallGroup: 30, largeGroup: 40 });
  });

  it("D/E. occupancy=4はsmallGroup、occupancy=5はlargeGroup", () => {
    const { db, insert } = setup();
    addOccupancy(insert, "four", BASE, BASE + 10, 4);
    addOccupancy(insert, "five", BASE + 10, BASE + 20, 5);
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 20 }, ["alice"])).days[0]!.trustedSecondsByBucket).toEqual({
      solo: 0,
      oneToOne: 0,
      smallGroup: 10,
      largeGroup: 10,
    });
  });

  it("F. subjectのuntrusted終了はdaily bucketへ推測せず、untrusted-only dayも作らない", () => {
    const { db, insert } = setup();
    insert("alice", "vc", BASE, BASE + 30, "recovered_estimate");
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 40 }, ["alice"])).days).toEqual([]);
    expect(rowFor(computeGroupSizeSeconds(db, { start: BASE, end: BASE + 40 }, ["alice"])).untrustedSeconds).toBe(30);
  });

  it("G. 他者のuntrusted終了によるtaint前だけをdaily trustedへ残す", () => {
    const { db, insert } = setup();
    insert("alice", "vc", BASE, BASE + 100);
    insert("bob-secret", "vc", BASE + 10, BASE + 40, "recovered_estimate");
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 100 }, ["alice"])).days[0]!.trustedSecondsByBucket).toEqual({
      solo: 10,
      oneToOne: 0,
      smallGroup: 0,
      largeGroup: 0,
    });
    expect(rowFor(computeGroupSizeSeconds(db, { start: BASE, end: BASE + 100 }, ["alice"])).untrustedSeconds).toBe(90);
  });

  it("H. partial_observation subjectも既存duration measurementと同じ扱い", () => {
    const { db, insert } = setup();
    insert("alice", "vc", BASE, BASE + 25, "observed", "state_change");
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 30 }, ["alice"])).days[0]!.trustedSecondsByBucket.solo).toBe(25);
    expect(rowFor(computeGroupSizeSeconds(db, { start: BASE, end: BASE + 30 }, ["alice"])).trustedSecondsByBucket.solo).toBe(25);
  });

  it("I. 0秒visitから秒数やday rowを捏造しない", () => {
    const { db, insert } = setup();
    insert("alice", "vc", BASE + 10, BASE + 10);
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 20 }, ["alice"])).days).toEqual([]);
  });

  it("J. windowは[start,end)でclipし、end開始rowを除外する", () => {
    const { db, insert } = setup();
    insert("alice", "inside", BASE - 10, BASE + 20);
    insert("alice", "at-end", BASE + 30, BASE + 40);
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 30 }, ["alice"])).days[0]!.trustedSecondsByBucket.solo).toBe(20);
  });

  it("K. window clippingとJST midnight分割を同時に正確に適用する", () => {
    const { db, insert } = setup();
    const midnight = BASE + 86_400;
    insert("alice", "vc", midnight - 10, midnight + 10);
    const days = rowFor(computeGroupSizeDailySeconds(db, { start: midnight - 5, end: midnight + 5 }, ["alice"])).days;
    expect(days.map((d) => [d.date, d.trustedSecondsByBucket.solo])).toEqual([
      ["2026-08-20", 5],
      ["2026-08-21", 5],
    ]);
  });

  it("L/M. observedAtより未来のrowを読まず、open visitをobservedAtでclampする", () => {
    const { db, insert } = setup();
    insert("alice", "open", BASE, null);
    insert("alice", "future", BASE + 40, BASE + 50);
    const days = rowFor(
      computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 100, observedAt: BASE + 30 }, ["alice"]),
    ).days;
    expect(days[0]!.trustedSecondsByBucket.solo).toBe(30);
  });

  it("N. 同じobservedAtなら後からDBが進んでもhistorical resultは不変", () => {
    const { db, insert } = setup();
    insert("alice", "vc1", BASE, BASE + 20);
    const window = { start: BASE, end: BASE + 100, observedAt: BASE + 30 };
    const before = computeGroupSizeDailySeconds(db, window, ["alice"]);
    insert("alice", "vc2", BASE + 40, BASE + 50);
    expect(computeGroupSizeDailySeconds(db, window, ["alice"])).toEqual(before);
  });
});

describe("vc_group_size_daily_safe — structural invariants O-Z", () => {
  it("O/P. daily保存則を全4bucketで満たし、既存whole-window payloadを変更しない", () => {
    const { db, insert } = setup();
    const midnight = BASE + 86_400;
    addOccupancy(insert, "solo", BASE, BASE + 11, 1);
    addOccupancy(insert, "duo", midnight - 7, midnight + 13, 2);
    addOccupancy(insert, "small", midnight + 20, midnight + 43, 4);
    addOccupancy(insert, "large", midnight + 50, midnight + 79, 5);
    const window = { start: BASE, end: midnight + 100 };
    const whole = rowFor(computeGroupSizeSeconds(db, window, ["alice"]));
    const daily = rowFor(computeGroupSizeDailySeconds(db, window, ["alice"]));
    expect(totalDailyByBucket(daily.days)).toEqual(whole.trustedSecondsByBucket);
    expect(whole).toEqual({
      userId: "alice",
      trustedSecondsByBucket: { solo: 11, oneToOne: 20, smallGroup: 23, largeGroup: 29 },
      untrustedSeconds: 0,
    });
  });

  it("R. userIds undefinedは全subject、[]は対象なし", () => {
    const { db, insert } = setup();
    insert("alice", "a", BASE, BASE + 10);
    insert("bob", "b", BASE, BASE + 10);
    expect(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 20 }).map((row) => row.userId)).toEqual(["alice", "bob"]);
    expect(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 20 }, [])).toEqual([]);
  });

  it("Z. 1200 historical channel IDsでもchannel bindを300件ずつに制限し意味を保つ", () => {
    const { db, insert } = setup();
    db.transaction(() => {
      for (let i = 0; i < 1200; i++) insert("alice", `historical-${i}`, BASE + i * 2, BASE + i * 2 + 1);
    })();
    const prepareSpy = vi.spyOn(db, "prepare");
    const result = rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 2500 }, ["alice"]));
    expect(result.days[0]!.trustedSecondsByBucket.solo).toBe(1200);

    const channelQueries = prepareSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("AND channel_id IN"));
    expect(channelQueries).toHaveLength(4);
    expect(Math.max(...channelQueries.map((sql) => sql.match(/\?/g)?.length ?? 0))).toBe(303);
  });

  it("100年超のintervalを黙ってtruncateせず明示的に拒否する", () => {
    const { db, insert } = setup();
    const end = BASE + (365 * 100 + 1) * 86_400;
    insert("alice", "century", BASE, end);
    expect(() => computeGroupSizeDailySeconds(db, { start: BASE, end, observedAt: end }, ["alice"])).toThrow(/more than 36500 days/);
  });
});

describe("readiness false-positive counterexamples", () => {
  it("1. 2時間が1日に集中した事実を複数日と誤読できない", () => {
    const { db, insert } = setup();
    addOccupancy(insert, "duo", BASE, BASE + 7200, 2);
    const days = rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 8000 }, ["alice"])).days;
    expect(days.filter((day) => day.trustedSecondsByBucket.oneToOne > 0)).toHaveLength(1);
  });

  it("2. 同じtotalでも10日分散と1日集中を区別する", () => {
    const { db, insert } = setup();
    for (let day = 0; day < 10; day++) addOccupancy(insert, `a-${day}`, BASE + day * 86_400, BASE + day * 86_400 + 60, 2, "alice");
    addOccupancy(insert, "b", BASE, BASE + 600, 2, "bob");
    const rows = computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 10 * 86_400 + 100 }, ["alice", "bob"]);
    expect(totalDailyByBucket(rowFor(rows, "alice").days).oneToOne).toBe(600);
    expect(totalDailyByBucket(rowFor(rows, "bob").days).oneToOne).toBe(600);
    expect(rowFor(rows, "alice").days).toHaveLength(10);
    expect(rowFor(rows, "bob").days).toHaveLength(1);
  });

  it("3. oneToOne totalだけでなく全bucketを返し、後段でshare分母を選べる", () => {
    const { db, insert } = setup();
    addOccupancy(insert, "duo", BASE, BASE + 100, 2);
    addOccupancy(insert, "small", BASE + 100, BASE + 300, 4);
    addOccupancy(insert, "large", BASE + 300, BASE + 600, 5);
    expect(rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 600 }, ["alice"])).days[0]!.trustedSecondsByBucket).toEqual({
      solo: 0,
      oneToOne: 100,
      smallGroup: 200,
      largeGroup: 300,
    });
  });

  it("4. 3 social帯total>0でも帯ごとの日数・span差を失わない", () => {
    const { db, insert } = setup();
    addOccupancy(insert, "duo", BASE, BASE + 10, 2);
    for (let day = 0; day < 5; day++) {
      addOccupancy(insert, `small-${day}`, BASE + day * 86_400 + 20, BASE + day * 86_400 + 30, 4);
      addOccupancy(insert, `large-${day}`, BASE + day * 86_400 + 40, BASE + day * 86_400 + 50, 5);
    }
    const days = rowFor(computeGroupSizeDailySeconds(db, { start: BASE, end: BASE + 5 * 86_400 }, ["alice"])).days;
    expect(days.filter((day) => day.trustedSecondsByBucket.oneToOne > 0)).toHaveLength(1);
    expect(days.filter((day) => day.trustedSecondsByBucket.smallGroup > 0)).toHaveLength(5);
    expect(days.filter((day) => day.trustedSecondsByBucket.largeGroup > 0)).toHaveLength(5);
  });
});
