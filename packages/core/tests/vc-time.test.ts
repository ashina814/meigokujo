import { describe, expect, it } from "vitest";
import {
  coveredDays,
  crossMidnightCount,
  daysOverlappingWindow,
  jstDateString,
  jstDayIndex,
  longestIntervalSeconds,
  longestStreak,
  mergeIntervals,
  totalSeconds,
  type Interval,
} from "../src/vc/time.js";

/** JSTの日時 → unix秒 */
function jst(y: number, m: number, d: number, h = 0, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) / 1000 - 9 * 3600;
}

function seg(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  durationMinutes: number,
): Interval {
  const start = jst(y, m, d, h, min);
  return { start, end: start + durationMinutes * 60 };
}

const HOUR = 3600;
/** 深夜2時〜4時台 */
const NIGHT: [number, number] = [2, 5];
/** 朝5時〜6時台 */
const DAWN: [number, number] = [5, 7];

describe("JST日付演算", () => {
  it("日番号は連続し、日付文字列と対応する", () => {
    const d = jstDayIndex(jst(2026, 7, 30, 12, 0));
    expect(jstDateString(d)).toBe("2026-07-30");
    expect(jstDateString(d + 1)).toBe("2026-07-31");
    expect(jstDateString(d + 2)).toBe("2026-08-01");
  });

  it("JST 00:00 直前と直後で日番号が変わる", () => {
    expect(jstDayIndex(jst(2026, 7, 30, 23, 59))).toBe(jstDayIndex(jst(2026, 7, 30, 0, 0)));
    expect(jstDayIndex(jst(2026, 7, 31, 0, 0))).toBe(jstDayIndex(jst(2026, 7, 30, 0, 0)) + 1);
  });

  it("月末・年末・うるう日を跨いでも日番号は連続する", () => {
    expect(jstDayIndex(jst(2026, 8, 1)) - jstDayIndex(jst(2026, 7, 31))).toBe(1);
    expect(jstDayIndex(jst(2027, 1, 1)) - jstDayIndex(jst(2026, 12, 31))).toBe(1);
    // 2028年はうるう年
    expect(jstDateString(jstDayIndex(jst(2028, 2, 28)) + 1)).toBe("2028-02-29");
    expect(jstDayIndex(jst(2028, 3, 1)) - jstDayIndex(jst(2028, 2, 29))).toBe(1);
  });
});

describe("区間の結合（状態変化による分割の復元）", () => {
  it("0秒で接する分割セグメントを1回の滞在に戻す", () => {
    // ミュート切替で 10:00-10:30 / 10:30-11:00 / 11:00-18:00 に割れたケース
    const merged = mergeIntervals([
      seg(2026, 7, 30, 10, 0, 30),
      seg(2026, 7, 30, 10, 30, 30),
      seg(2026, 7, 30, 11, 0, 7 * 60),
    ]);
    expect(merged).toHaveLength(1);
    expect(longestIntervalSeconds(merged)).toBe(8 * HOUR);
    // 結合しなければ最長は7時間にしか見えない（回帰の要点）
    expect(longestIntervalSeconds([seg(2026, 7, 30, 11, 0, 7 * 60)])).toBe(7 * HOUR);
  });

  it("本当に間が空いている滞在は結合しない", () => {
    const merged = mergeIntervals([seg(2026, 7, 30, 10, 0, 30), seg(2026, 7, 30, 11, 0, 30)]);
    expect(merged).toHaveLength(2);
  });

  it("重なった区間を潰すので合計が実時間を超えない", () => {
    const merged = mergeIntervals([seg(2026, 7, 30, 10, 0, 60), seg(2026, 7, 30, 10, 30, 60)]);
    expect(totalSeconds(merged)).toBe(90 * 60);
  });

  it("順不同で渡しても結果は同じ", () => {
    const a = mergeIntervals([seg(2026, 7, 30, 11, 0, 30), seg(2026, 7, 30, 10, 0, 60)]);
    expect(a).toHaveLength(1);
    expect(totalSeconds(a)).toBe(90 * 60);
  });

  it("長さ0の区間は無視する", () => {
    const zero = { start: jst(2026, 7, 30, 5, 0), end: jst(2026, 7, 30, 5, 0) };
    expect(mergeIntervals([zero])).toEqual([]);
    expect(coveredDays([zero]).size).toBe(0);
  });
});

describe("浮上日数と連続日数", () => {
  it("72時間の1区間で中間日が欠落しない", () => {
    const start = jst(2026, 7, 1, 10, 0);
    const days = coveredDays([{ start, end: start + 72 * HOUR }]);
    expect([...days].map(jstDateString).sort()).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
    expect(longestStreak(days)).toBe(4);
  });

  it("ちょうど24時間（00:00→翌00:00）は1日として数える", () => {
    const start = jst(2026, 7, 30, 0, 0);
    const days = coveredDays([{ start, end: start + 24 * HOUR }]);
    expect([...days].map(jstDateString)).toEqual(["2026-07-30"]);
  });

  it("1秒でも翌日に入れば翌日も数える", () => {
    const start = jst(2026, 7, 30, 23, 59);
    const days = coveredDays([{ start, end: jst(2026, 7, 31, 0, 0) + 1 }]);
    expect([...days].map(jstDateString).sort()).toEqual(["2026-07-30", "2026-07-31"]);
  });

  it("年末・うるう日を跨ぐ滞在も連続日として扱う", () => {
    const nyStart = jst(2026, 12, 31, 22, 0);
    const nyDays = coveredDays([{ start: nyStart, end: jst(2027, 1, 1, 2, 0) }]);
    expect([...nyDays].map(jstDateString).sort()).toEqual(["2026-12-31", "2027-01-01"]);
    expect(longestStreak(nyDays)).toBe(2);

    const leapDays = coveredDays([{ start: jst(2028, 2, 28, 20, 0), end: jst(2028, 2, 29, 10, 0) }]);
    expect([...leapDays].map(jstDateString).sort()).toEqual(["2028-02-28", "2028-02-29"]);
    expect(longestStreak(leapDays)).toBe(2);
  });

  it("連続していない日は途切れとして数える", () => {
    const days = coveredDays([
      seg(2026, 7, 1, 12, 0, 60),
      seg(2026, 7, 2, 12, 0, 60),
      seg(2026, 7, 4, 12, 0, 60), // 3日が抜けている
      seg(2026, 7, 5, 12, 0, 60),
      seg(2026, 7, 6, 12, 0, 60),
    ]);
    expect(days.size).toBe(5);
    expect(longestStreak(days)).toBe(3); // 7/4-7/6
  });

  it("日を跨いだ滞在の回数は結合後の区間で数える", () => {
    // 分割された3本が実際には1回の日跨ぎ滞在
    const raw = [
      seg(2026, 7, 30, 23, 0, 30),
      seg(2026, 7, 30, 23, 30, 30),
      seg(2026, 7, 31, 0, 0, 6 * 60),
    ];
    expect(crossMidnightCount(mergeIntervals(raw))).toBe(1);
    // 生セグメントのまま数えると膨らむ（回帰の要点）
    expect(crossMidnightCount(raw)).toBe(0);
  });
});

describe("時刻窓の判定", () => {
  it("23:00→翌06:00 は翌日の深夜帯と朝帯に該当する", () => {
    const i = [{ start: jst(2026, 7, 30, 23, 0), end: jst(2026, 7, 31, 6, 0) }];
    expect([...daysOverlappingWindow(i, ...NIGHT)].map(jstDateString)).toEqual(["2026-07-31"]);
    expect([...daysOverlappingWindow(i, ...DAWN)].map(jstDateString)).toEqual(["2026-07-31"]);
  });

  it("06:00→翌04:00 は初日の朝帯と翌日の深夜帯に該当する", () => {
    const i = [{ start: jst(2026, 7, 30, 6, 0), end: jst(2026, 7, 31, 4, 0) }];
    expect([...daysOverlappingWindow(i, ...DAWN)].map(jstDateString)).toEqual(["2026-07-30"]);
    expect([...daysOverlappingWindow(i, ...NIGHT)].map(jstDateString)).toEqual(["2026-07-31"]);
  });

  it("05:59→06:00 は朝帯に該当する（窓に居たかで判定する）", () => {
    const i = [{ start: jst(2026, 7, 30, 5, 59), end: jst(2026, 7, 30, 6, 0) }];
    expect(daysOverlappingWindow(i, ...DAWN).size).toBe(1);
    expect(daysOverlappingWindow(i, ...NIGHT).size).toBe(0);
  });

  it("窓の外で終わった滞在は該当しない（退出時刻だけでは判定しない）", () => {
    // 07:00 以降に退出しただけの滞在は、朝帯に居たかどうかで決まる
    const passedThrough = [{ start: jst(2026, 7, 30, 4, 0), end: jst(2026, 7, 30, 9, 0) }];
    expect(daysOverlappingWindow(passedThrough, ...DAWN).size).toBe(1); // 5-7時に居た

    const afterWindow = [{ start: jst(2026, 7, 30, 8, 0), end: jst(2026, 7, 30, 12, 0) }];
    expect(daysOverlappingWindow(afterWindow, ...DAWN).size).toBe(0);
  });

  it("窓の境界にちょうど接する滞在は該当しない", () => {
    // [00:00, 02:00) は窓 [02:00, 05:00) に触れているだけ
    const touchingStart = [{ start: jst(2026, 7, 30, 0, 0), end: jst(2026, 7, 30, 2, 0) }];
    expect(daysOverlappingWindow(touchingStart, ...NIGHT).size).toBe(0);

    // [05:00, 06:00) は窓 [02:00, 05:00) の終端に接しているだけ
    const touchingEnd = [{ start: jst(2026, 7, 30, 5, 0), end: jst(2026, 7, 30, 6, 0) }];
    expect(daysOverlappingWindow(touchingEnd, ...NIGHT).size).toBe(0);

    // 1秒でも窓に入れば該当する
    const oneSecond = [{ start: jst(2026, 7, 30, 4, 59), end: jst(2026, 7, 30, 5, 0) + 0 }];
    expect(daysOverlappingWindow(oneSecond, ...NIGHT).size).toBe(1);
  });

  it("72時間の滞在では該当日が複数になる", () => {
    const start = jst(2026, 7, 1, 10, 0);
    const i = [{ start, end: start + 72 * HOUR }];
    // 7/2, 7/3, 7/4 の深夜帯と朝帯に居た（7/1 は10時開始なので含まない）
    expect([...daysOverlappingWindow(i, ...NIGHT)].map(jstDateString).sort()).toEqual([
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
    expect(daysOverlappingWindow(i, ...DAWN).size).toBe(3);
  });
});
