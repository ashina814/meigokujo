import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Settings } from "../src/settings/service.js";
import {
  SessionCalendar,
  SessionCalendarError,
  describeSessionSchedule,
  sessionSchedule,
} from "../src/entry/sessions.js";

// JST基準。2026-08-01 は土曜、08-03 は月曜（通常は休み）
const FRI_2030 = new Date("2026-07-31T11:30:00Z"); // 金 20:30 JST
const SAT_1200 = new Date("2026-08-01T03:00:00Z"); // 土 12:00 JST

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(path = ":memory:") {
  const db = openDb(path);
  const settings = new Settings(db);
  const events = new EventLog(db);
  return { db, settings, events, calendar: new SessionCalendar(db, settings, events) };
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "meigokujo-sessions-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

/** 開催予定を 'MM-DD HH(+)' の読みやすい形にする（+ は臨時追加） */
function render(calendar: SessionCalendar, from: Date, days = 4): string[] {
  return calendar
    .occurrences({ from, days })
    .map((o) => `${o.date.slice(5)} ${o.hour}${o.extra ? "+" : ""}`);
}

describe("通常枠の設定", () => {
  it("未設定なら現行運用（月・木を除く 21/22/23時）のまま", () => {
    const { db, settings } = setup();
    const schedule = sessionSchedule(settings);

    expect(schedule).toEqual({ hours: [21, 22, 23], skipDow: [1, 4] });
    expect(describeSessionSchedule(schedule)).toBe("月・木を除く 21 / 22 / 23 時");
    db.close();
  });

  it("JSON配列でもカンマ区切りでも受け付け、範囲外・数値でない値は捨てる", () => {
    const { db, settings } = setup();
    settings.set("entry:session_hours", "23, 21, 21, 24, あ", "test");
    settings.set("entry:session_skip_dow", "[0, 6]", "test");

    expect(sessionSchedule(settings)).toEqual({ hours: [21, 23], skipDow: [0, 6] });
    expect(describeSessionSchedule({ hours: [20, 22], skipDow: [0, 6] })).toBe("日・土を除く 20 / 22 時");
    db.close();
  });

  it("整数以外は数値に化かさず捨てる（true/null/小数/16進表記など）", () => {
    const { db, settings } = setup();
    // Number(true)===1 / Number(null)===0 で通してしまうと、意図しない時刻に説明会が立つ
    const hoursFor = (raw: string) => {
      settings.set("entry:session_hours", raw, "test");
      return sessionSchedule(settings).hours;
    };

    expect(hoursFor("[true, 21]")).toEqual([21]);
    expect(hoursFor("[null, 22]")).toEqual([22]);
    expect(hoursFor("[true]")).toEqual([21, 22, 23]);
    expect(hoursFor("[null]")).toEqual([21, 22, 23]);
    expect(hoursFor("[21.5, 23]")).toEqual([23]);
    expect(hoursFor('["0x15", " 21 "]')).toEqual([21]);
    expect(hoursFor('[{"hour":21}]')).toEqual([21, 22, 23]);

    settings.set("entry:session_skip_dow", "[true, false]", "test");
    expect(sessionSchedule(settings).skipDow).toEqual([1, 4]);
    db.close();
  });

  it("休みなしと認めるのは明示的な [] だけ、時刻が全滅した設定は既定値へ落とす", () => {
    const { db, settings } = setup();
    settings.set("entry:session_skip_dow", "[]", "test");
    expect(sessionSchedule(settings)).toEqual({ hours: [21, 22, 23], skipDow: [] });
    expect(describeSessionSchedule(sessionSchedule(settings))).toBe("毎日 21 / 22 / 23 時");

    // 区切り文字だけ・整数が1つも無い値は「休みなし」ではなく誤設定として扱う
    for (const raw of [",", "　", "毎日", "[9]", '[""]']) {
      settings.set("entry:session_skip_dow", raw, "test");
      expect(sessionSchedule(settings).skipDow).toEqual([1, 4]);
    }

    // 説明会が黙って消えるほうが害が大きいので、壊れた値は既定値で運転を続ける
    settings.set("entry:session_hours", "[99]", "test");
    expect(sessionSchedule(settings).hours).toEqual([21, 22, 23]);
    settings.set("entry:session_hours", "[]", "test");
    expect(sessionSchedule(settings).hours).toEqual([21, 22, 23]);
    db.close();
  });
});

describe("開催予定の合成", () => {
  it("例外が無ければ通常枠どおりに並び、休みの曜日は飛ばす", () => {
    const { db, calendar } = setup();

    expect(render(calendar, FRI_2030)).toEqual([
      "07-31 21",
      "07-31 22",
      "07-31 23",
      "08-01 21",
      "08-01 22",
      "08-01 23",
      "08-02 21",
      "08-02 22",
      "08-02 23",
      // 08-03(月) は休み
    ]);
    expect(calendar.nextOccurrence(FRI_2030)?.at.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    db.close();
  });

  it("通常枠を1つ休止すると、その枠だけ消えて通知対象からも外れる", () => {
    const { db, calendar } = setup();
    calendar.skip({ date: "2026-07-31", hour: 21, reason: "門番不在", actor: "user:1", now: FRI_2030 });

    expect(render(calendar, FRI_2030, 1)).toEqual(["07-31 22", "07-31 23"]);
    expect(calendar.isOccurring("2026-07-31", 21)).toBe(false);
    expect(calendar.isOccurring("2026-07-31", 22)).toBe(true);
    expect(calendar.nextOccurrence(FRI_2030)?.hour).toBe(22);
    db.close();
  });

  it("日付を全休すると通常枠が全部消え、翌日は元どおり", () => {
    const { db, calendar } = setup();
    calendar.skip({ date: "2026-08-01", actor: "user:1", now: FRI_2030 });

    expect(render(calendar, SAT_1200, 2)).toEqual(["08-02 21", "08-02 22", "08-02 23"]);
    expect(calendar.isOccurring("2026-08-01", 22)).toBe(false);
    db.close();
  });

  it("休みの曜日にも臨時枠を足せる", () => {
    const { db, calendar } = setup();
    calendar.add({ date: "2026-08-03", hour: 20, reason: "臨時", actor: "user:1", now: FRI_2030 });

    expect(render(calendar, SAT_1200, 3)).toEqual([
      "08-01 21",
      "08-01 22",
      "08-01 23",
      "08-02 21",
      "08-02 22",
      "08-02 23",
      "08-03 20+", // 月曜は通常休みだが、この枠だけ開催
    ]);
    expect(calendar.isOccurring("2026-08-03", 20)).toBe(true);
    db.close();
  });

  it("取り消すと通常予定へ戻り、臨時枠の取消はその枠が消える", () => {
    const { db, calendar } = setup();
    const skipped = calendar.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: FRI_2030 });
    const added = calendar.add({ date: "2026-08-03", hour: 20, actor: "user:1", now: FRI_2030 });
    expect(render(calendar, SAT_1200, 3)).toEqual([
      "08-01 22",
      "08-01 23",
      "08-02 21",
      "08-02 22",
      "08-02 23",
      "08-03 20+",
    ]);

    calendar.cancel(skipped.id, "user:2", SAT_1200);
    calendar.cancel(added.id, "user:2", SAT_1200);

    expect(render(calendar, SAT_1200, 3)).toEqual([
      "08-01 21",
      "08-01 22",
      "08-01 23",
      "08-02 21",
      "08-02 22",
      "08-02 23",
    ]);
    expect(calendar.getOverride(skipped.id)?.canceled_by).toBe("user:2");
    db.close();
  });

  it("0時開催は日付をまたいでも正しい日の枠として並ぶ", () => {
    const { db, settings, calendar } = setup();
    settings.set("entry:session_hours", "[0]", "test");
    settings.set("entry:session_skip_dow", "[]", "test");

    const at = calendar.nextOccurrence(FRI_2030);
    expect(at?.date).toBe("2026-08-01");
    expect(at?.at.toISOString()).toBe("2026-07-31T15:00:00.000Z"); // 08-01 00:00 JST
    expect(calendar.isOccurring("2026-08-01", 0)).toBe(true);
    db.close();
  });

  it("全曜日が休みなら開催予定は空", () => {
    const { db, settings, calendar } = setup();
    settings.set("entry:session_skip_dow", "[0,1,2,3,4,5,6]", "test");

    expect(calendar.occurrences({ from: FRI_2030, days: 8 })).toEqual([]);
    expect(calendar.nextOccurrence(FRI_2030)).toBeNull();
    db.close();
  });

  it("全曜日が休みでも、ずっと先の臨時枠を「次の説明会」として拾う", () => {
    const { db, settings, calendar } = setup();
    settings.set("entry:session_skip_dow", "[0,1,2,3,4,5,6]", "test");
    // 既定の探索範囲（60日）より内と外に1つずつ置く
    calendar.add({ date: "2026-08-10", hour: 21, actor: "user:1", now: FRI_2030 });
    const far = calendar.add({ date: "2026-12-24", hour: 21, actor: "user:1", now: FRI_2030 });

    expect(calendar.nextOccurrence(FRI_2030)?.date).toBe("2026-08-10");

    // 近いほうを取り消すと、範囲外に残った臨時枠が次の予定になる（予定なし、にしない）
    calendar.cancel(calendar.listOverrides("2026-08-10", "2026-08-10")[0]!.id, "user:1", FRI_2030);
    const next = calendar.nextOccurrence(FRI_2030);
    expect(next?.date).toBe(far.date);
    expect(next?.extra).toBe(true);
    db.close();
  });

  it("毎日開催の設定なら休みの曜日が無くなる", () => {
    const { db, settings, calendar } = setup();
    settings.set("entry:session_skip_dow", "[]", "test");

    expect(render(calendar, SAT_1200, 3).filter((s) => s.startsWith("08-03"))).toEqual([
      "08-03 21",
      "08-03 22",
      "08-03 23",
    ]);
    db.close();
  });
});

describe("誤操作の防止", () => {
  it("過ぎた枠は休止も追加もできない", () => {
    const { db, calendar } = setup();

    expect(() => calendar.skip({ date: "2026-07-30", hour: 21, actor: "user:1", now: FRI_2030 })).toThrow(
      SessionCalendarError,
    );
    expect(() => calendar.add({ date: "2026-07-31", hour: 9, actor: "user:1", now: FRI_2030 })).toThrow(/過ぎています/);
    db.close();
  });

  it("通常枠に無い時刻の休止と、もともと開催がない日の全休は弾く", () => {
    const { db, calendar } = setup();

    expect(() => calendar.skip({ date: "2026-08-01", hour: 20, actor: "user:1", now: FRI_2030 })).toThrow(
      /通常の開催枠ではありません/,
    );
    // 08-03(月) は休みの曜日
    expect(() => calendar.skip({ date: "2026-08-03", actor: "user:1", now: FRI_2030 })).toThrow(
      /もともと通常の説明会がありません/,
    );
    db.close();
  });

  it("すでに開催予定の枠は臨時追加できない", () => {
    const { db, calendar } = setup();

    expect(() => calendar.add({ date: "2026-08-01", hour: 21, actor: "user:1", now: FRI_2030 })).toThrow(
      /すでに開催予定です/,
    );
    db.close();
  });

  it("同じ枠の二重登録を弾き、取り消した後なら登録し直せる", () => {
    const { db, calendar } = setup();
    const first = calendar.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: FRI_2030 });

    expect(() => calendar.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: FRI_2030 })).toThrow(
      /すでに登録されています/,
    );

    calendar.cancel(first.id, "user:1", FRI_2030);
    const again = calendar.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: FRI_2030 });
    expect(again.id).not.toBe(first.id);
    db.close();
  });

  it("取消済み・存在しない予定変更の取消はエラーになる", () => {
    const { db, calendar } = setup();
    const row = calendar.skip({ date: "2026-08-01", hour: 21, actor: "user:1", now: FRI_2030 });
    calendar.cancel(row.id, "user:1", FRI_2030);

    expect(() => calendar.cancel(row.id, "user:1", FRI_2030)).toThrow(/見つかりません/);
    expect(() => calendar.cancel(9999, "user:1", FRI_2030)).toThrow(/見つかりません/);
    db.close();
  });

  it("日付・時刻の形式が不正なら受け付けない", () => {
    const { db, calendar } = setup();

    expect(() => calendar.skip({ date: "2026/08/01", hour: 21, actor: "user:1", now: FRI_2030 })).toThrow(
      /YYYY-MM-DD/,
    );
    expect(() => calendar.skip({ date: "2026-02-30", hour: 21, actor: "user:1", now: FRI_2030 })).toThrow(
      /実在しない日付/,
    );
    expect(() => calendar.add({ date: "2026-08-01", hour: 24, actor: "user:1", now: FRI_2030 })).toThrow(/0〜23/);
    db.close();
  });
});

describe("記録と永続化", () => {
  it("誰が休止・追加・取消したかを事件録に残す", () => {
    const { db, calendar } = setup();
    const skipped = calendar.skip({ date: "2026-08-01", hour: 21, reason: "門番不在", actor: "user:1", now: FRI_2030 });
    calendar.add({ date: "2026-08-03", hour: 20, actor: "user:2", now: FRI_2030 });
    calendar.cancel(skipped.id, "user:3", SAT_1200);

    const rows = db
      .prepare("SELECT type, actor_id, payload_json FROM events WHERE type LIKE 'session_%' ORDER BY id")
      .all() as Array<{ type: string; actor_id: string; payload_json: string }>;

    expect(rows.map((r) => [r.type, r.actor_id])).toEqual([
      ["session_skipped", "user:1"],
      ["session_added", "user:2"],
      ["session_override_canceled", "user:3"],
    ]);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ date: "2026-08-01", hour: 21, reason: "門番不在" });
    db.close();
  });

  it("Bot再起動後も予定変更が残る", () => {
    const path = tempDbPath();
    const first = setup(path);
    first.calendar.skip({ date: "2026-08-01", hour: 21, reason: "門番不在", actor: "user:1", now: FRI_2030 });
    first.calendar.add({ date: "2026-08-03", hour: 20, actor: "user:1", now: FRI_2030 });
    first.db.close();

    const restarted = setup(path);
    const after = render(restarted.calendar, SAT_1200, 3);
    const extraKept = restarted.calendar.isOccurring("2026-08-03", 20);
    restarted.db.close();

    expect(after).toEqual(["08-01 22", "08-01 23", "08-02 21", "08-02 22", "08-02 23", "08-03 20+"]);
    expect(extraKept).toBe(true);
  });
});
