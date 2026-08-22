import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { TextActivity } from "../src/text-activity/service.js";

/**
 * PR E1: TextActivity service（`text_active_days`の正本）。
 * rank_text（XP/level/cooldown）とは独立したsubsystem——rank logicは一切使わない。
 */

/** JST 2026-08-20 12:00:00 を基準にした、テスト用の基準時刻（unix秒）。 */
const NOON_JST = Math.floor(new Date("2026-08-20T12:00:00+09:00").getTime() / 1000);

function setup() {
  const db = openDb(":memory:");
  const textActivity = new TextActivity(db);
  return { db, textActivity };
}

describe("TextActivity.recordActiveDay()", () => {
  it("初回recordはrecorded=trueでactivityDateを返す", () => {
    const { textActivity } = setup();
    const result = textActivity.recordActiveDay("alice", NOON_JST);
    expect(result.recorded).toBe(true);
    expect(result.activityDate).toBe("2026-08-20");
  });

  it("idempotency: 同user同JST日に10回recordしてもrowは1件、2回目以降はrecorded=false", () => {
    const { db, textActivity } = setup();
    for (let i = 0; i < 10; i++) {
      textActivity.recordActiveDay("alice", NOON_JST + i);
    }
    const rows = db.prepare(`SELECT * FROM text_active_days WHERE user_id = 'alice'`).all();
    expect(rows).toHaveLength(1);

    const second = textActivity.recordActiveDay("alice", NOON_JST + 100);
    expect(second.recorded).toBe(false);
    expect(second.activityDate).toBe("2026-08-20");
  });

  it("翌JST日には別rowが作られる", () => {
    const { db, textActivity } = setup();
    textActivity.recordActiveDay("alice", NOON_JST);
    const nextDay = NOON_JST + 86_400;
    const result = textActivity.recordActiveDay("alice", nextDay);
    expect(result.recorded).toBe(true);
    expect(result.activityDate).toBe("2026-08-21");

    const rows = db.prepare(`SELECT activity_date FROM text_active_days WHERE user_id = 'alice' ORDER BY activity_date`).all();
    expect(rows).toEqual([{ activity_date: "2026-08-20" }, { activity_date: "2026-08-21" }]);
  });

  it("first observation immutable: 既存rowがある場合、observed_atをUPDATEしない（古いtimestampの遅延イベントが来ても）", () => {
    const { db, textActivity } = setup();
    const first = textActivity.recordActiveDay("alice", NOON_JST + 500);
    expect(first.recorded).toBe(true);

    // 同じJST日の、より早いobservedAt(=先に起きたはずのevent)が後から届いても、
    // 既に記録済みのobserved_atは変わらない(first-persisted-truthを保持)。
    textActivity.recordActiveDay("alice", NOON_JST);

    const row = db.prepare(`SELECT observed_at FROM text_active_days WHERE user_id = 'alice'`).get() as {
      observed_at: number;
    };
    expect(row.observed_at).toBe(NOON_JST + 500);
  });

  it("JST midnight boundary: 2026-08-21 23:59:59 JSTと2026-08-22 00:00:00 JSTは別activity_date（UTC日で切っていない）", () => {
    const { textActivity } = setup();
    const beforeMidnight = Math.floor(new Date("2026-08-21T23:59:59+09:00").getTime() / 1000);
    const afterMidnight = Math.floor(new Date("2026-08-22T00:00:00+09:00").getTime() / 1000);

    const r1 = textActivity.recordActiveDay("bob", beforeMidnight);
    const r2 = textActivity.recordActiveDay("bob", afterMidnight);

    expect(r1.activityDate).toBe("2026-08-21");
    expect(r2.activityDate).toBe("2026-08-22");
    expect(r1.activityDate).not.toBe(r2.activityDate);
  });

  it("userId空文字はreject", () => {
    const { textActivity } = setup();
    expect(() => textActivity.recordActiveDay("", NOON_JST)).toThrow(/userId/);
    expect(() => textActivity.recordActiveDay("   ", NOON_JST)).toThrow(/userId/);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["negative", -1],
    ["fractional", 123.5],
  ])("observedAtが%sならreject", (_label, badValue) => {
    const { textActivity } = setup();
    expect(() => textActivity.recordActiveDay("alice", badValue)).toThrow(RangeError);
  });

  it("複数userが同日にrecordしても、userごとに独立して1行ずつ作られる", () => {
    const { db, textActivity } = setup();
    textActivity.recordActiveDay("alice", NOON_JST);
    textActivity.recordActiveDay("bob", NOON_JST);
    const rows = db.prepare(`SELECT user_id FROM text_active_days ORDER BY user_id`).all();
    expect(rows).toEqual([{ user_id: "alice" }, { user_id: "bob" }]);
  });
});
