/**
 * VC計測の時間演算（JST基準）。
 *
 * ここに集約している理由:
 *   1. 「浮上日数」の定義がプロフィール・評価添付・称号でバラバラになるのを防ぐ。
 *   2. 1本のセグメントが複数日を跨ぐ場合、開始日と終了日だけを見ると中間日が丸ごと欠落する。
 *      日境界を跨ぐ計算は必ずここを通す。
 *   3. ミュート/デフン切替・チャンネル移動のたびに vc_segments は分割される
 *      （apps/bot/src/vc-tracking.ts）。「一度の滞在」を測るには結合が必須。
 */

export const DAY = 86_400;
export const JST_OFFSET = 9 * 3600;

/** 連続した滞在として結合する許容ギャップ。状態変化による分割は0秒で接するため小さくて足りる */
const MERGE_GAP_SECONDS = 5;

/**
 * 1本の区間が跨げる日数の上限。データ破損（ended_at が極端な未来など）で
 * 日ループが暴走するのを防ぐ安全弁。実運用の滞在がこれを超えることはない。
 */
const MAX_DAYS_PER_INTERVAL = 400;

export interface Interval {
  start: number;
  end: number;
}

/** JSTでの日番号（1970-01-01 JST を 0 とする連番）。月末・年末・うるう日は暦計算を経ないので影響しない */
export function jstDayIndex(unixSec: number): number {
  return Math.floor((unixSec + JST_OFFSET) / DAY);
}

/** JST日番号 → その日の 00:00 JST の unix 秒 */
export function jstDayStart(dayIndex: number): number {
  return dayIndex * DAY - JST_OFFSET;
}

/** JST日番号 → "YYYY-MM-DD"（表示・既存データとの突合用） */
export function jstDateString(dayIndex: number): string {
  return new Date(jstDayStart(dayIndex) * 1000 + JST_OFFSET * 1000).toISOString().slice(0, 10);
}

/**
 * 区間の集合を、重なり・隣接を潰した昇順の集合にする。
 * 状態変化で分割されたセグメントを「一度の滞在」に戻すのが主目的。
 * チャンネルを跨いだ移動も、浮上が途切れていないなら1回の滞在として扱う。
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const cur of valid) {
    const last = merged[merged.length - 1];
    if (last && cur.start - last.end <= MERGE_GAP_SECONDS) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      merged.push({ start: cur.start, end: cur.end });
    }
  }
  return merged;
}

/** 区間の合計秒数（結合済みを渡せば重複計上が起きない） */
export function totalSeconds(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + Math.max(0, i.end - i.start), 0);
}

/**
 * 区間が触れているJST日番号の集合。中間日も落とさない。
 * 終端は排他的に扱うので、ちょうど 00:00 に退出した場合に翌日を数えない。
 */
export function coveredDays(intervals: Interval[]): Set<number> {
  const days = new Set<number>();
  for (const i of intervals) {
    if (i.end <= i.start) continue;
    const first = jstDayIndex(i.start);
    const last = jstDayIndex(i.end - 1);
    const limit = Math.min(last, first + MAX_DAYS_PER_INTERVAL);
    for (let d = first; d <= limit; d++) days.add(d);
  }
  return days;
}

/**
 * 「その日の時刻窓に滞在していた」日番号の集合。
 * 窓は [fromHour, toHour) の半開区間で、日ごとに突き合わせる。
 * 例: 深夜2時〜4時台 = window(2, 5) / 朝5時〜6時台 = window(5, 7)
 */
export function daysOverlappingWindow(intervals: Interval[], fromHour: number, toHour: number): Set<number> {
  const days = new Set<number>();
  for (const i of intervals) {
    if (i.end <= i.start) continue;
    const first = jstDayIndex(i.start);
    const last = jstDayIndex(i.end - 1);
    const limit = Math.min(last, first + MAX_DAYS_PER_INTERVAL);
    for (let d = first; d <= limit; d++) {
      const base = jstDayStart(d);
      const windowStart = base + fromHour * 3600;
      const windowEnd = base + toHour * 3600;
      if (Math.min(i.end, windowEnd) > Math.max(i.start, windowStart)) days.add(d);
    }
  }
  return days;
}

/** 日番号集合から最長の連続ラン（連続浮上日数） */
export function longestStreak(days: Set<number>): number {
  const sorted = [...days].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of sorted) {
    run = prev !== null && d - prev === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/** 日付を跨いだ滞在の回数（結合済み区間を渡すこと。分割セグメントで数えると膨らむ） */
export function crossMidnightCount(intervals: Interval[]): number {
  let count = 0;
  for (const i of intervals) {
    if (i.end <= i.start) continue;
    if (jstDayIndex(i.start) !== jstDayIndex(i.end - 1)) count += 1;
  }
  return count;
}

/** 最長の連続滞在秒数（結合済み区間の最大長） */
export function longestIntervalSeconds(intervals: Interval[]): number {
  let best = 0;
  for (const i of intervals) {
    const seconds = i.end - i.start;
    if (seconds > best) best = seconds;
  }
  return best;
}
