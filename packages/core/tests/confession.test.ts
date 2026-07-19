import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import { Confessions } from "../src/confession/service.js";

function setup() {
  const db = openDb(":memory:");
  const events = new EventLog(db);
  const confessions = new Confessions(db, events);
  return { db, events, confessions };
}

describe("Confessions", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("受付番号を発行し、種別・返信希望・本文を保存する（§4/§5/§18）", () => {
    const row = ctx.confessions.create("user:alice", {
      type: "houkoku",
      replyWish: "yes",
      body: "規約違反を見ました",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.status).toBe("open");
    expect(row.type).toBe("houkoku");
    expect(row.reply_wish).toBe("yes");
    expect(row.body).toBe("規約違反を見ました");
    // 投稿者IDはDBには保持されるが（匿名中継のため）UI表示は別責務
    expect(row.user_id).toBe("user:alice");
  });

  it("メタ未指定でも従来通り受け付けられる（後方互換）", () => {
    const row = ctx.confessions.create("user:bob");
    expect(row.type).toBeNull();
    expect(row.reply_wish).toBeNull();
    expect(row.body).toBeNull();
    expect(row.status).toBe("open");
  });

  it("claim でスレッドを紐付け、byThread で引ける", () => {
    const row = ctx.confessions.create("user:carol", { type: "soudan" });
    const claimed = ctx.confessions.claim(row.id, "thread:123", "user:staff");
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.thread_id).toBe("thread:123");
    expect(claimed?.claimed_by).toBe("user:staff");
    // claim後もメタは保持される
    expect(claimed?.type).toBe("soudan");
    expect(ctx.confessions.byThread("thread:123")?.id).toBe(row.id);
  });

  it("close で終結し、closed_at が入る", () => {
    const row = ctx.confessions.create("user:dave");
    const closed = ctx.confessions.close(row.id, "user:staff");
    expect(closed?.status).toBe("closed");
    expect(closed?.closed_at).not.toBeNull();
  });

  it("出禁はサイレントに記録・照会できる（裏機能として維持）", () => {
    expect(ctx.confessions.isBlocked("user:evil")).toBe(false);
    ctx.confessions.block("user:evil", "user:staff");
    expect(ctx.confessions.isBlocked("user:evil")).toBe(true);
    ctx.confessions.unblock("user:evil", "user:staff");
    expect(ctx.confessions.isBlocked("user:evil")).toBe(false);
  });

  // ── Phase 2: 対応先・状態・担当者・クローズ・本文purge ──
  it("対応先(disposition)と状態(stage)を記録できる", () => {
    const row = ctx.confessions.create("user:a", { type: "soudan" });
    ctx.confessions.claim(row.id, "thread:1", "user:staff");
    const d = ctx.confessions.setDisposition(row.id, "church", "user:staff");
    expect(d?.disposition).toBe("church");
    const s = ctx.confessions.setStage(row.id, "awaiting_poster", "user:staff");
    expect(s?.stage).toBe("awaiting_poster");
  });

  it("担当者の追加・解除・一覧が正しく動く（主担当はclaimで登録される）", () => {
    const row = ctx.confessions.create("user:a");
    ctx.confessions.claim(row.id, "thread:1", "user:staff1");
    expect(ctx.confessions.assignees(row.id)).toEqual(["user:staff1"]);
    ctx.confessions.addAssignee(row.id, "user:staff2", "user:staff1");
    expect(ctx.confessions.assignees(row.id)).toContain("user:staff2");
    expect(ctx.confessions.isAssignee(row.id, "user:staff2")).toBe(true);
    ctx.confessions.removeAssignee(row.id, "user:staff2", "user:staff1");
    expect(ctx.confessions.isAssignee(row.id, "user:staff2")).toBe(false);
    // 主担当は残る
    expect(ctx.confessions.assignees(row.id)).toEqual(["user:staff1"]);
  });

  it("クローズは理由・担当者・purge予定を記録し、reopenで戻せる", () => {
    const row = ctx.confessions.create("user:a", { body: "秘密" });
    ctx.confessions.claim(row.id, "thread:1", "user:staff");
    const closed = ctx.confessions.close(row.id, "user:staff", "resolved", 90);
    expect(closed?.status).toBe("closed");
    expect(closed?.close_reason).toBe("resolved");
    expect(closed?.closed_by).toBe("user:staff");
    expect(closed?.body_purge_at).toBeGreaterThan(closed!.closed_at!);
    const re = ctx.confessions.reopen(row.id, "user:staff");
    expect(re?.status).toBe("claimed");
    expect(re?.close_reason).toBeNull();
  });

  it("本文purge: 本文だけNULL化しメタは残る。listPurgeable/extendRetention", () => {
    const row = ctx.confessions.create("user:a", { body: "秘密の相談" });
    ctx.confessions.claim(row.id, "thread:1", "user:staff");
    // 過去のpurge予定でクローズ（既に期限超過）
    ctx.confessions.close(row.id, "user:staff", "resolved", 0);
    ctx.confessions.extendRetention(row.id, Math.floor(Date.now() / 1000) - 10, "テスト", "user:staff");
    const due = ctx.confessions.listPurgeable();
    expect(due.map((r) => r.id)).toContain(row.id);
    const purged = ctx.confessions.purgeBody(row.id, "user:admin");
    expect(purged?.body).toBeNull();
    expect(purged?.body_purged_at).not.toBeNull();
    // メタは残る
    expect(purged?.id).toBe(row.id);
    expect(purged?.close_reason).toBe("resolved");
    // 一度purgeしたら二度と対象にならない
    expect(ctx.confessions.listPurgeable().map((r) => r.id)).not.toContain(row.id);
  });

  // ── Phase 3: 冥府裁判所への送致 ──
  it("裁判所送致: 起案→送致投稿→事件番号→取消 の記録", () => {
    const row = ctx.confessions.create("user:a", { type: "houkoku", body: "報告" });
    ctx.confessions.claim(row.id, "thread:1", "user:staff");
    const r1 = ctx.confessions.recordCourtReferral(row.id, {
      category: "criminal",
      consent: "confirmed",
      staffId: "user:staff",
      form: { reason: "理由", summary: "概要", wants: "求めること" },
    });
    expect(r1?.court_status).toBe("pending_consent");
    expect(r1?.court_category).toBe("criminal");
    expect(r1?.stage).toBe("court_review");
    const r2 = ctx.confessions.recordCourtPost(row.id, { threadId: "court:9", url: "https://x/9", staffId: "user:staff" });
    expect(r2?.court_status).toBe("sent");
    expect(r2?.court_thread_id).toBe("court:9");
    expect(r2?.stage).toBe("court_sent");
    const r3 = ctx.confessions.setCourtCaseNo(row.id, "冥府刑事第003号", "user:staff");
    expect(r3?.court_case_no).toBe("冥府刑事第003号");
    const r4 = ctx.confessions.cancelCourtReferral(row.id, "user:staff");
    expect(r4?.court_status).toBe("canceled");
  });

  // ── Phase 4: 緊急対応 ──
  it("緊急対応: 登録→確認→終了、openEmergencyFor", () => {
    const row = ctx.confessions.create("user:a", { type: "kinkyu" });
    ctx.confessions.claim(row.id, "thread:1", "user:staff");
    const emg = ctx.confessions.createEmergency({
      confessionId: row.id,
      createdBy: "user:staff",
      reason: "危険",
      target: "誰か",
      dangerOngoing: true,
      measures: "notify,isolate",
      reviewNote: "3日後",
      note: null,
    });
    expect(emg.status).toBe("open");
    expect(ctx.confessions.get(row.id)?.stage).toBe("emergency");
    expect(ctx.confessions.openEmergencyFor(row.id)?.id).toBe(emg.id);
    const confirmed = ctx.confessions.confirmEmergency(emg.id, "user:emgstaff");
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.confirmed_by).toBe("user:emgstaff");
    const closed = ctx.confessions.closeEmergency(emg.id, "user:staff");
    expect(closed?.status).toBe("closed");
    expect(ctx.confessions.openEmergencyFor(row.id)).toBeUndefined();
  });

  it("旧スキーマ（type/reply_wish/body 列なし）のDBに後付けマイグレーションできる", () => {
    // 旧バージョン相当の最小テーブルを持つDBを用意
    const db = openDb(":memory:") as unknown as Database.Database;
    db.exec(`
      CREATE TABLE confession_tickets (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        thread_id   TEXT,
        claimed_by  TEXT,
        created_at  INTEGER NOT NULL,
        claimed_at  INTEGER,
        closed_at   INTEGER
      );
    `);
    db.prepare("INSERT INTO confession_tickets (user_id, status, created_at) VALUES ('user:old', 'open', 1)").run();

    // コンストラクタで列が後付けされる
    const events = new EventLog(db);
    const confessions = new Confessions(db, events);

    // 既存行は Phase1〜3 の新列がすべてNULLで読める
    const cols = db.prepare("PRAGMA table_info(confession_tickets)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "type",
        "reply_wish",
        "body",
        "stage",
        "disposition",
        "close_reason",
        "body_purge_at",
        "panel_msg_id",
        "court_status",
        "court_case_no",
        "court_form",
      ]),
    );
    const old = confessions.get(1);
    expect(old?.type).toBeNull();
    expect(old?.stage).toBeNull();
    expect(old?.court_status).toBeNull();

    // 旧DBでも Phase2〜4 の操作が一通り通る（assignees/emergency テーブルも作られる）
    confessions.claim(1, "thread:old", "user:staff");
    confessions.setDisposition(1, "record", "user:staff");
    expect(confessions.assignees(1)).toEqual(["user:staff"]);
    const emg = confessions.createEmergency({
      confessionId: 1,
      createdBy: "user:staff",
      reason: "r",
      target: "t",
      dangerOngoing: false,
      measures: "notify",
      reviewNote: null,
      note: null,
    });
    expect(confessions.getEmergency(emg.id)?.confession_id).toBe(1);

    // 新規作成はメタ込みで通る
    const fresh = confessions.create("user:new", { type: "iken", replyWish: "no", body: "要望です" });
    expect(fresh.type).toBe("iken");
    expect(fresh.body).toBe("要望です");
  });
});
