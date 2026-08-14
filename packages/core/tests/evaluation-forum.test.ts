import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EvaluationForumStore, evaluationForumInternalsForTesting } from "../src/evaluation/forum.js";

function soul(
  db: ReturnType<typeof openDb>,
  userId: string,
  status: "ghost" | "majin" | "waiting",
  startedAt: number | null,
  deadlineAt: number | null = null,
  baseline = 0,
) {
  db.prepare(
    `INSERT INTO souls (user_id, status, eval_started_at, eval_deadline_at, eval_invite_baseline, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, status, startedAt, deadlineAt, baseline, startedAt ?? 1);
}

function event(db: ReturnType<typeof openDb>, type: string, targetId: string, at: number) {
  db.prepare("INSERT INTO events (type, target_id, created_at) VALUES (?, ?, ?)").run(type, targetId, at);
}

function vc(
  db: ReturnType<typeof openDb>,
  userId: string,
  parentId: string,
  start: number,
  end: number | null,
  channelId = "vc",
) {
  db.prepare(
    `INSERT INTO vc_segments (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  ).run(userId, channelId, parentId, start, end);
}

describe("EvaluationForumStore", () => {
  it("現在の亡霊かつ評価サイクルがある人だけを列挙する", () => {
    const db = openDb(":memory:");
    soul(db, "ghost", "ghost", 100, 500);
    soul(db, "no-cycle", "ghost", null, null);
    soul(db, "majin", "majin", 100, 500);
    const store = new EvaluationForumStore(db);

    expect(store.listCurrentCycles().map((c) => c.userId)).toEqual(["ghost"]);
  });

  it("旧 user_id 単位のthreadを一切変更せず、新しいサイクルthreadを別テーブルへ保存する", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO eval_threads (user_id, thread_id) VALUES (?, ?)").run("u", "old-thread");

    const store = new EvaluationForumStore(db);
    expect(store.legacyThreadFor("u")).toBe("old-thread");
    expect(store.threadFor("u", 100)).toBeNull();

    store.setThread("u", 100, "cycle-100", 101);
    store.setThread("u", 100, "cycle-100", 102);
    store.setThread("u", 200, "cycle-200", 201);
    expect(store.threadFor("u", 100)).toBe("cycle-100");
    expect(store.threadFor("u", 200)).toBe("cycle-200");
    expect(store.legacyThreadFor("u")).toBe("old-thread");

    // 旧テーブルはschemaも行もそのまま。既存Evaluation APIの ON CONFLICT(user_id) を壊さない。
    const legacyColumns = db.prepare("PRAGMA table_info(eval_threads)").all() as Array<{ name: string }>;
    expect(legacyColumns.map((c) => c.name)).toEqual(["user_id", "thread_id"]);
    expect(db.prepare("SELECT * FROM eval_threads WHERE user_id = ?").get("u")).toEqual({
      user_id: "u",
      thread_id: "old-thread",
    });

    const rows = db
      .prepare("SELECT cycle_started_at, thread_id FROM eval_cycle_threads WHERE user_id = ? ORDER BY cycle_started_at")
      .all("u");
    expect(rows).toEqual([
      { cycle_started_at: 100, thread_id: "cycle-100" },
      { cycle_started_at: 200, thread_id: "cycle-200" },
    ]);
  });

  it("出戻り判定は既存DB行ではなく既存の復帰イベントを正本にする", () => {
    const db = openDb(":memory:");
    soul(db, "plain", "ghost", 100, 500);
    soul(db, "returned", "ghost", 200, 600);
    soul(db, "reeval", "ghost", 300, 700);
    event(db, "entry_return_reinstated", "returned", 200);
    event(db, "reeval_reinstated", "reeval", 300);
    const store = new EvaluationForumStore(db);

    expect(store.currentCycle("plain")?.origin).toBe("entry");
    expect(store.currentCycle("returned")?.origin).toBe("return");
    expect(store.currentCycle("reeval")?.origin).toBe("reevaluation");
  });

  it("招待件数は今回の評価開始後に確定した実績だけを数える", () => {
    const db = openDb(":memory:");
    const store = new EvaluationForumStore(db);
    db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES ('u', 'old', 99)").run();
    db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES ('u', 'new1', 100)").run();
    db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES ('u', 'new2', 150)").run();

    expect(store.inviteCountSinceCycle("u", 100)).toBe(2);
  });

  it("冥獣の巣カテゴリ・評価開始後だけを集計し、魔剣士3人の重複を三重加算しない", () => {
    const db = openDb(":memory:");
    const store = new EvaluationForumStore(db);
    const start = 1_000;
    const end = 2_800;
    vc(db, "ghost", "den", 500, 900, "before");
    vc(db, "ghost", "other", start, end, "outside");
    vc(db, "ghost", "den", start, end, "den-main");
    for (const id of ["sw1", "sw2", "sw3"]) vc(db, id, "den", start, end, `${id}-vc`);

    const summary = store.presenceForCycle({
      userId: "ghost",
      swordsmanIds: ["sw1", "sw2", "sw3"],
      denParentId: "den",
      startedAt: start,
      now: 3_000,
    });
    expect(summary.denSeconds).toBe(1_800);
    expect(summary.swordsmanSeconds).toBe(1_800);
  });

  it("JSTの日付境界をまたぐ滞在は2日として数え、進行中セッションもnowまで含める", () => {
    const db = openDb(":memory:");
    const store = new EvaluationForumStore(db);
    const start = Math.floor(Date.parse("2026-08-14T14:50:00Z") / 1000); // JST 23:50
    const now = Math.floor(Date.parse("2026-08-14T15:10:00Z") / 1000); // JST 翌00:10
    vc(db, "ghost", "den", start, null, "ongoing");
    vc(db, "sw", "den", start, null, "ongoing-sw");

    const summary = store.presenceForCycle({
      userId: "ghost",
      swordsmanIds: ["sw"],
      denParentId: "den",
      startedAt: start,
      now,
    });
    expect(summary.denSeconds).toBe(20 * 60);
    expect(summary.denDays).toBe(2);
    expect(summary.swordsmanSeconds).toBe(20 * 60);
    expect(summary.swordsmanDays).toBe(2);
  });
});

describe("evaluation forum interval helpers", () => {
  it("終了時刻ちょうどの翌日は出現日に含めない", () => {
    const midnightJst = Math.floor(Date.parse("2026-08-14T15:00:00Z") / 1000);
    expect(evaluationForumInternalsForTesting.intervalJstDays([{ start: midnightJst - 60, end: midnightJst }])).toBe(1);
  });
});
