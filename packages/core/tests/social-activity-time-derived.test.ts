import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { computeSocialActivityTimeSafe } from "../src/social-activity-time/derived.js";
import { computeTcConversationSafe } from "../src/tc-social/derived.js";
import { TcSocialObservations, type TcSurfaceKind } from "../src/tc-social/service.js";
import {
  computeTrustedSocialPresenceIntervals,
  splitIntervalByJstHour,
} from "../src/vc/derived.js";

const BASE = Math.floor(new Date("2026-08-20T00:00:00+09:00").getTime() / 1000);
const DAY = 86_400;

function setup(windowStart = BASE, windowEnd = BASE + 20 * DAY) {
  const db = openDb(":memory:");
  const tc = new TcSocialObservations(db);
  const window = { start: windowStart, end: windowEnd, observedAt: windowEnd };
  const message = (
    id: string,
    authorId: string,
    at: number,
    options: {
      surfaceId?: string;
      areaId?: string;
      surfaceKind?: TcSurfaceKind;
      observedAt?: number;
    } = {},
  ) =>
    tc.recordMessage({
      messageId: id,
      authorId,
      surfaceId: options.surfaceId ?? "channel-secret-marker",
      areaId: options.areaId ?? options.surfaceId ?? "area-secret-marker",
      surfaceKind: options.surfaceKind ?? "channel",
      replyToMessageId: null,
      createdAtMs: at * 1000,
      observedAtMs: (options.observedAt ?? at) * 1000 + 1,
      threadOwnerId: null,
      threadCreatedAtMs: null,
    });
  const visit = (
    userId: string,
    channelId: string,
    start: number,
    end: number | null,
    quality: "observed" | "recovered_estimate" | null = "observed",
    startReason: "join" | "move" | "state_change" | null = "join",
  ) =>
    db
      .prepare(
        `INSERT INTO vc_segments
          (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
         VALUES (?, ?, 'parent-secret-marker', ?, ?, 0, 0, ?, ?)`,
      )
      .run(userId, channelId, start, end, quality, startReason);
  const payload = (userId = "subject") => computeSocialActivityTimeSafe(db, window, [userId])[0]!.payload;
  return { db, window, message, visit, payload };
}

describe("TC canonical same-surface exchange → JST hour", () => {
  it("A. normal surfaceの09:00 subject + 09:03 otherを3分候補へする", () => {
    const { message, payload } = setup();
    message("message-secret-marker", "subject", BASE + 9 * 3600);
    message("counterpart-secret-marker", "other", BASE + 9 * 3600 + 180);
    expect(payload()).toEqual({
      days: [{ date: "2026-08-20", hours: [{ hour: 9, tcBestOtherGapMs: 180_000, vcTrustedSocialSeconds: 0 }] }],
    });
  });

  it("B. same hour複数subjectを1 entryのminimum gapへ畳み、count fieldを作らない", () => {
    const { message, payload } = setup();
    for (const [index, minute, gapMinute] of [[0, 0, 12], [1, 20, 3], [2, 35, 20]] as const) {
      const surfaceId = `surface-${index}`;
      message(`subject-${index}`, "subject", BASE + 9 * 3600 + minute * 60, { surfaceId });
      message(`other-${index}`, `other-${index}`, BASE + 9 * 3600 + (minute + gapMinute) * 60, { surfaceId });
    }
    const hour = payload().days[0]!.hours[0]!;
    expect(hour).toEqual({ hour: 9, tcBestOtherGapMs: 180_000, vcTrustedSocialSeconds: 0 });
    expect(Object.keys(hour).sort()).toEqual(["hour", "tcBestOtherGapMs", "vcTrustedSocialSeconds"]);
  });

  it("C. standalone subject投稿はsocial hourを作らない", () => {
    const { message, payload } = setup();
    message("subject-only", "subject", BASE + 9 * 3600);
    expect(payload()).toEqual({ days: [] });
  });

  it("D/E/G. forum parentをarea共有してもcross-threadは除外し、same-threadだけをF2hと共有する", () => {
    const { db, window, message, payload } = setup();
    const shared = { areaId: "forum-parent", surfaceKind: "forum_post" as const };
    message("subject-a", "subject", BASE + 10 * 3600, { ...shared, surfaceId: "thread-a" });
    message("other-b", "other", BASE + 10 * 3600 + 1, { ...shared, surfaceId: "thread-b" });
    expect(payload()).toEqual({ days: [] });
    expect(computeTcConversationSafe(db, window, ["subject"])[0]!.payload.socialDays).toEqual([]);

    message("other-a", "other-2", BASE + 10 * 3600 + 10, { ...shared, surfaceId: "thread-a" });
    expect(payload().days[0]!.hours[0]!.tcBestOtherGapMs).toBe(10_000);
    expect(computeTcConversationSafe(db, window, ["subject"])[0]!.payload.socialDays).toEqual([
      { date: "2026-08-20", bestOtherGapMs: 10_000 },
    ]);
  });

  it("F. 6時間gapをsource layerでfilterせず保持する", () => {
    const { message, payload } = setup();
    message("subject", "subject", BASE + 9 * 3600);
    message("other", "other", BASE + 15 * 3600);
    expect(payload().days[0]!.hours[0]!.tcBestOtherGapMs).toBe(6 * 3600 * 1000);
  });

  it("H/I. UTC→JST変換と23時→翌日0時をdate/hourへ正確に配置する", () => {
    const start = Math.floor(new Date("2026-08-20T00:00:00Z").getTime() / 1000);
    const { message, payload } = setup(start, start + 3 * DAY);
    const utc1530 = Math.floor(new Date("2026-08-20T15:30:00Z").getTime() / 1000);
    message("next-day-subject", "subject", utc1530, { surfaceId: "utc-surface" });
    message("next-day-other", "other", utc1530 + 1, { surfaceId: "utc-surface" });
    const jst2359 = Math.floor(new Date("2026-08-21T23:59:00+09:00").getTime() / 1000);
    message("late-subject", "subject", jst2359, { surfaceId: "late" });
    message("late-other", "other", jst2359 + 1, { surfaceId: "late" });
    const jst0001 = Math.floor(new Date("2026-08-22T00:01:00+09:00").getTime() / 1000);
    message("midnight-subject", "subject", jst0001, { surfaceId: "midnight" });
    message("midnight-other", "other", jst0001 + 1, { surfaceId: "midnight" });
    expect(payload().days.map((day) => [day.date, day.hours.map((hour) => hour.hour)])).toEqual([
      ["2026-08-21", [0, 23]],
      ["2026-08-22", [0]],
    ]);
  });

  it("snapshot/end-exclusive. future-observed TC rowとexact endのsubjectを除外する", () => {
    const { db, message } = setup(BASE, BASE + 100);
    const fixed = { start: BASE, end: BASE + 100, observedAt: BASE + 50 };
    message("subject", "subject", BASE + 10, { surfaceId: "surface" });
    message("future-observed-other", "other", BASE + 20, { surfaceId: "surface", observedAt: BASE + 60 });
    const before = computeSocialActivityTimeSafe(db, fixed, ["subject"])[0]!.payload;
    expect(before).toEqual({ days: [] });
    expect(computeSocialActivityTimeSafe(db, fixed, ["subject"])[0]!.payload).toEqual(before);

    const exact = setup(BASE, BASE + 100);
    exact.message("exact-end-subject", "subject", BASE + 100, { surfaceId: "end", observedAt: BASE + 101 });
    exact.message("exact-end-other", "other", BASE + 99, { surfaceId: "end", observedAt: BASE + 101 });
    expect(
      computeSocialActivityTimeSafe(exact.db, { start: BASE, end: BASE + 100, observedAt: BASE + 200 }, ["subject"])[0]!.payload,
    ).toEqual({ days: [] });
  });
});

describe("VC trusted social-presence wall-clock union", () => {
  it("J/K. 2人でも3人同時でも10秒を10秒だけ数える", () => {
    const { visit, payload } = setup();
    visit("subject", "vc", BASE, BASE + 10);
    visit("bob", "vc", BASE, BASE + 10);
    visit("carol", "vc", BASE, BASE + 10);
    expect(payload().days[0]!.hours[0]).toEqual({ hour: 0, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 10 });
  });

  it("L. Bob 00-10 + Carol 05-15を15秒へunionする", () => {
    const { db, window, visit, payload } = setup();
    visit("subject", "vc", BASE, BASE + 15);
    visit("bob", "vc", BASE, BASE + 10);
    visit("carol", "vc", BASE + 5, BASE + 15);
    expect(payload().days[0]!.hours[0]!.vcTrustedSocialSeconds).toBe(15);
    expect(computeTrustedSocialPresenceIntervals(db, window, ["subject"])[0]!.intervals).toEqual([{ start: BASE, end: BASE + 15 }]);
  });

  it("M. Bob 00-10 + Carol 20-30を20秒として保持する", () => {
    const { visit, payload } = setup();
    visit("subject", "vc", BASE, BASE + 30);
    visit("bob", "vc", BASE, BASE + 10);
    visit("carol", "vc", BASE + 20, BASE + 30);
    expect(payload().days[0]!.hours[0]!.vcTrustedSocialSeconds).toBe(20);
  });

  it("N/X. touching [0,10)+[10,20)をdouble countせず、zero intersectionを除く", () => {
    const { db, window, visit, payload } = setup();
    visit("subject", "vc", BASE, BASE + 20);
    visit("bob", "vc", BASE, BASE + 10);
    visit("carol", "vc", BASE + 10, BASE + 20);
    visit("zero", "vc", BASE + 20, BASE + 30);
    expect(payload().days[0]!.hours[0]!.vcTrustedSocialSeconds).toBe(20);
    expect(computeTrustedSocialPresenceIntervals(db, window, ["subject"])[0]!.intervals).toEqual([{ start: BASE, end: BASE + 20 }]);
  });

  it("O/P. untrusted counterpartだけを局所除外しtrusted siblingを残す", () => {
    const onlyUntrusted = setup();
    onlyUntrusted.visit("subject", "vc", BASE, BASE + 20);
    onlyUntrusted.visit("carol", "vc", BASE, BASE + 20, "recovered_estimate");
    expect(onlyUntrusted.payload()).toEqual({ days: [] });

    const { visit, payload } = setup();
    visit("subject", "vc", BASE, BASE + 20);
    visit("bob", "vc", BASE, BASE + 10, "observed");
    visit("carol", "vc", BASE, BASE + 20, "recovered_estimate");
    expect(payload().days[0]!.hours[0]!.vcTrustedSocialSeconds).toBe(10);
  });

  it("Q/R. untrusted subject visitだけを除外し別trusted visitを残す", () => {
    const onlyUntrusted = setup();
    onlyUntrusted.visit("subject", "vc", BASE, BASE + 10, "recovered_estimate");
    onlyUntrusted.visit("bob", "vc", BASE, BASE + 10);
    expect(onlyUntrusted.payload()).toEqual({ days: [] });

    const { visit, payload } = setup();
    visit("subject", "vc-a", BASE, BASE + 10, "recovered_estimate");
    visit("bob", "vc-a", BASE, BASE + 10);
    visit("subject", "vc-b", BASE + 20, BASE + 30, "observed");
    visit("carol", "vc-b", BASE + 20, BASE + 30);
    expect(payload().days[0]!.hours[0]!.vcTrustedSocialSeconds).toBe(10);
  });

  it("S. partial_observation subjectをpresence measurementとして数える", () => {
    const { visit, payload } = setup();
    visit("subject", "vc", BASE, BASE + 10, "observed", "state_change");
    visit("bob", "vc", BASE, BASE + 10);
    expect(payload().days[0]!.hours[0]!.vcTrustedSocialSeconds).toBe(10);
  });

  it("T/snapshot. open visitをobservedAtでclipし、未来row追加でもfixed snapshotを変えない", () => {
    const { db, visit } = setup(BASE, BASE + 100);
    visit("subject", "vc", BASE, null, null);
    visit("bob", "vc", BASE + 10, null, null);
    const fixed = { start: BASE, end: BASE + 100, observedAt: BASE + 40 };
    const before = computeSocialActivityTimeSafe(db, fixed, ["subject"])[0]!.payload;
    expect(before.days[0]!.hours[0]!.vcTrustedSocialSeconds).toBe(30);
    visit("future", "vc", BASE + 50, BASE + 90);
    expect(computeSocialActivityTimeSafe(db, fixed, ["subject"])[0]!.payload).toEqual(before);
  });

  it("U/V/W. JST hour/day boundaryを半開区間でsplitする", () => {
    const start = Math.floor(new Date("2026-08-20T09:59:50+09:00").getTime() / 1000);
    const { visit, payload } = setup(start - 60, start + DAY);
    visit("subject", "vc", start, start + 20);
    visit("bob", "vc", start, start + 20);
    expect(payload().days[0]!.hours.map((hour) => [hour.hour, hour.vcTrustedSocialSeconds])).toEqual([[9, 10], [10, 10]]);
    expect(splitIntervalByJstHour(start + 10, start + 20)).toEqual([{ date: "2026-08-20", hour: 10, seconds: 10 }]);

    const midnight = Math.floor(new Date("2026-08-21T00:00:00+09:00").getTime() / 1000);
    expect(splitIntervalByJstHour(midnight - 10, midnight + 10)).toEqual([
      { date: "2026-08-20", hour: 23, seconds: 10 },
      { date: "2026-08-21", hour: 0, seconds: 10 },
    ]);
  });

  it("Z. corrupt simultaneous multi-channel visitsもsubject-global unionし各hour<=3600", () => {
    const { visit, payload } = setup();
    visit("subject", "vc-a", BASE, BASE + 3600);
    visit("subject", "vc-b", BASE, BASE + 3600);
    visit("bob", "vc-a", BASE, BASE + 3600);
    visit("carol", "vc-b", BASE, BASE + 3600);
    const hours = payload().days.flatMap((day) => day.hours);
    expect(hours[0]!.vcTrustedSocialSeconds).toBe(3600);
    expect(hours.every((hour) => hour.vcTrustedSocialSeconds >= 0 && hour.vcTrustedSocialSeconds <= 3600)).toBe(true);
  });
});

describe("combined sparse payload / Theme9 false-positive structure", () => {
  it("AA-AF. TC+VC coexist、single modality zero、inactive省略、ASC、zero payload", () => {
    const { message, visit, payload } = setup();
    message("tc-subject", "subject", BASE + 21 * 3600);
    message("tc-other", "other", BASE + 21 * 3600 + 120);
    visit("subject", "vc", BASE + 21 * 3600, BASE + 21 * 3600 + 1800);
    visit("bob", "vc", BASE + 21 * 3600, BASE + 21 * 3600 + 1800);
    const hour = payload().days[0]!.hours[0]!;
    expect(hour).toEqual({ hour: 21, tcBestOtherGapMs: 120_000, vcTrustedSocialSeconds: 1800 });

    const tcOnly = setup();
    tcOnly.message("tc-only-subject", "subject", BASE + 8 * 3600);
    tcOnly.message("tc-only-other", "other", BASE + 8 * 3600 + 1);
    expect(tcOnly.payload().days[0]!.hours[0]).toEqual({ hour: 8, tcBestOtherGapMs: 1000, vcTrustedSocialSeconds: 0 });

    const vcOnly = setup();
    vcOnly.visit("subject", "vc", BASE + 7 * 3600, BASE + 7 * 3600 + 10);
    vcOnly.visit("bob", "vc", BASE + 7 * 3600, BASE + 7 * 3600 + 10);
    expect(vcOnly.payload().days[0]!.hours[0]).toEqual({ hour: 7, tcBestOtherGapMs: null, vcTrustedSocialSeconds: 10 });
    expect(setup().payload()).toEqual({ days: [] });
  });

  it("No.32-36: daypart/share/linear statisticsを焼かずraw hour 0..23だけを保持する", () => {
    const { message, payload } = setup();
    for (const [index, hour] of [23, 0, 1].entries()) {
      const at = BASE + index * DAY + hour * 3600;
      message(`subject-${index}`, "subject", at, { surfaceId: `surface-${index}` });
      message(`other-${index}`, "other", at + 1, { surfaceId: `surface-${index}` });
    }
    const value = payload();
    expect(value.days.flatMap((day) => day.hours.map((entry) => entry.hour))).toEqual([23, 0, 1]);
    expect(JSON.stringify(value)).not.toMatch(/morning|afternoon|evening|lateNight|daypart|Share|dominant|mean|standardDeviation/);
  });

  it("No.37: 一晩4hourと10 distinct daysの分布をdate構造で区別する", () => {
    const { message, db, window } = setup();
    for (const hour of [0, 6, 12, 18]) {
      message(`a-${hour}`, "user-a", BASE + hour * 3600, { surfaceId: `a-${hour}` });
      message(`a-other-${hour}`, "other", BASE + hour * 3600 + 1, { surfaceId: `a-${hour}` });
    }
    for (let day = 0; day < 10; day += 1) {
      for (const hour of [6, 18]) {
        message(`b-${day}-${hour}`, "user-b", BASE + day * DAY + hour * 3600, { surfaceId: `b-${day}-${hour}` });
        message(`b-other-${day}-${hour}`, "other", BASE + day * DAY + hour * 3600 + 1, { surfaceId: `b-${day}-${hour}` });
      }
    }
    const rows = computeSocialActivityTimeSafe(db, window, ["user-a", "user-b"]);
    expect(rows.find((row) => row.userId === "user-a")!.payload.days).toHaveLength(1);
    expect(rows.find((row) => row.userId === "user-b")!.payload.days).toHaveLength(10);
  });
});
