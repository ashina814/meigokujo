import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Settings } from "../src/settings/service.js";
import { EventLog } from "../src/events/service.js";
import { Entry } from "../src/entry/service.js";
import { Evaluation, type EvalScores } from "../src/evaluation/service.js";

registerDefaultTxTypes();

const SCORES: EvalScores = { voice: 4, communication: 3, presence: 5, understanding: 4 };
const SWORDSMAN = "user:swordsman";

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const settings = new Settings(db);
  const events = new EventLog(db);
  const entry = new Entry(db, ledger, settings, events);
  const evaluation = new Evaluation(db, settings, events);
  return { db, ledger, settings, events, entry, evaluation };
}

function submit(
  ctx: ReturnType<typeof setup>,
  target: string,
  conclusion: "promotion" | "demotion" | "none",
  evaluator = SWORDSMAN,
  markWeight?: number,
) {
  return ctx.evaluation.submitEvaluation({
    targetId: target,
    evaluatorId: evaluator,
    scores: SCORES,
    texts: { detail: "テスト", merit: "メリット", concern: "不安", feedback: "FB", others: "高い人/低い人" },
    conclusion,
    markWeight,
  });
}

describe("評価DB移行", () => {
  it("旧スキーマの既存evaluations.mark_weightを結論とlinked markからバックフィルする", () => {
    const dir = mkdtempSync(join(tmpdir(), "meigokujo-eval-migration-"));
    const dbPath = join(dir, "bot.db");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          delivered_at INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE marks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          ref TEXT,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE evaluations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_id TEXT NOT NULL,
          evaluator_id TEXT NOT NULL,
          scores_json TEXT NOT NULL,
          texts_json TEXT NOT NULL,
          conclusion TEXT NOT NULL,
          mark_id INTEGER,
          thread_id TEXT,
          created_at INTEGER NOT NULL
        );
      `);
      legacy
        .prepare("INSERT INTO marks (target_id, kind, granted_by, ref, created_at) VALUES (?, 'promotion', ?, 'evaluation', ?)")
        .run("legacy", "user:evaluator", 1);
      const markId = Number(legacy.prepare("SELECT id FROM marks").pluck().get());
      const scores = JSON.stringify(SCORES);
      const texts = JSON.stringify({ detail: "legacy" });
      legacy
        .prepare(
          "INSERT INTO evaluations (target_id, evaluator_id, scores_json, texts_json, conclusion, mark_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .run("legacy", "user:evaluator", scores, texts, "promotion", markId, 2);
      legacy
        .prepare(
          "INSERT INTO evaluations (target_id, evaluator_id, scores_json, texts_json, conclusion, mark_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
        )
        .run("legacy2", "user:evaluator", scores, texts, "demotion", 3);
      legacy
        .prepare(
          "INSERT INTO evaluations (target_id, evaluator_id, scores_json, texts_json, conclusion, mark_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
        )
        .run("legacy3", "user:evaluator", scores, texts, "none", 4);
      legacy.close();

      const db = openDb(dbPath);
      const settings = new Settings(db);
      const events = new EventLog(db);
      const evaluation = new Evaluation(db, settings, events);
      const rows = db
        .prepare("SELECT conclusion, mark_weight FROM evaluations ORDER BY id")
        .all() as Array<{ conclusion: string; mark_weight: number }>;
      expect(rows).toEqual([
        { conclusion: "promotion", mark_weight: 1 },
        { conclusion: "demotion", mark_weight: 1 },
        { conclusion: "none", mark_weight: 0 },
      ]);
      expect(evaluation.latestByEvaluator("legacy", "user:evaluator")?.markWeight).toBe(1);
      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may keep SQLite files locked briefly after close; cleanup failure is not test-relevant.
      }
    }
  });
});

describe("印台帳と閾値", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("昇格印5個で面談待ちフラグが立つ", () => {
    for (let i = 0; i < 4; i++) {
      const r = submit(ctx, "alice", "promotion", `user:sw${i}`);
      expect(r.promotionReached).toBe(false);
    }
    const fifth = submit(ctx, "alice", "promotion");
    expect(fifth.promotion.total).toBe(5);
    expect(fifth.promotionReached).toBe(true);
  });

  it("既存印は1印として扱い、weight付き印は加重集計される", () => {
    ctx.evaluation.addMark("weighted", "promotion", "old", "legacy");
    ctx.evaluation.addMark("weighted", "promotion", "senior", "evaluation", 3);
    ctx.evaluation.addMark("weighted", "demotion", "strict", "evaluation", 2);

    expect(ctx.evaluation.promotionScore("weighted").evalMarks).toBe(4);
    expect(ctx.evaluation.demotionCount("weighted")).toBe(2);
  });

  it("招待は0.5個/人・上限1.0個として昇格スコアに加算される", () => {
    // alice が3人招待（実績は invites テーブル）→ 0.5×3 = 1.5 だが上限1.0
    ctx.entry.book("alice", "flex", { source: "none" });
    ctx.entry.ghostify("alice", "staff");
    for (const guest of ["g1", "g2", "g3"]) {
      ctx.entry.book(guest, "flex", { userId: "alice", source: "user" });
      ctx.entry.ghostify(guest, "staff");
    }
    const score = ctx.evaluation.promotionScore("alice");
    expect(score.inviteCount).toBe(3);
    expect(score.inviteScore).toBe(1.0);

    // 評価印4個 + 招待1.0 = 5.0 で到達
    for (let i = 0; i < 3; i++) submit(ctx, "alice", "promotion", `user:sw${i}`);
    const r = submit(ctx, "alice", "promotion");
    expect(r.promotion.total).toBe(5);
    expect(r.promotionReached).toBe(true);
  });

  it("対象者ごとの必要印数は評価開始時点で固定される", () => {
    ctx.settings.set("promotion_marks_required", 6, "staff");
    ctx.settings.set("demotion_marks_threshold", 3, "staff");
    ctx.settings.set("invite_mark_per_person", 0.5, "staff");
    ctx.settings.set("invite_mark_cap", 1, "staff");
    ctx.entry.book("frozen", "flex", { source: "none" });
    ctx.entry.ghostify("frozen", "staff");

    ctx.settings.set("promotion_marks_required", 2, "staff");
    ctx.settings.set("demotion_marks_threshold", 2, "staff");
    ctx.settings.set("invite_mark_per_person", 2, "staff");
    ctx.settings.set("invite_mark_cap", 10, "staff");

    const thresholds = ctx.evaluation.thresholdsFor("frozen");
    expect(thresholds.promotionRequired).toBe(6);
    expect(thresholds.demotionThreshold).toBe(3);
    expect(thresholds.inviteMarkPerPerson).toBe(0.5);
    expect(thresholds.inviteMarkCap).toBe(1);
    expect(thresholds.snapshotted).toBe(true);

    for (const guest of ["fg1", "fg2", "fg3"]) {
      ctx.entry.book(guest, "flex", { userId: "frozen", source: "user" });
      ctx.entry.ghostify(guest, "staff");
    }
    expect(ctx.evaluation.promotionScore("frozen").inviteScore).toBe(1);

    const r1 = submit(ctx, "frozen", "promotion", "user:a", 2);
    expect(r1.promotionReached).toBe(false);
    const r2 = submit(ctx, "frozen", "promotion", "user:b", 4);
    expect(r2.promotionReached).toBe(true);
    expect(r2.thresholds.promotionRequired).toBe(6);
  });

  it("制度変更後の新規対象者には新基準が適用される", () => {
    ctx.settings.set("promotion_marks_required", 7, "staff");
    ctx.settings.set("demotion_marks_threshold", 5, "staff");
    ctx.entry.book("new_ghost", "flex", { source: "none" });
    ctx.entry.ghostify("new_ghost", "staff");

    expect(ctx.evaluation.thresholdsFor("new_ghost").promotionRequired).toBe(7);
    expect(ctx.evaluation.thresholdsFor("new_ghost").demotionThreshold).toBe(5);
  });

  it("対象rowがない場合は現在設定を使うがスナップショット扱いにしない", () => {
    const thresholds = ctx.evaluation.thresholdsFor("missing");
    expect(thresholds.promotionRequired).toBe(5);
    expect(thresholds.demotionThreshold).toBe(4);
    expect(thresholds.snapshotted).toBe(false);
  });

  it("低評価印4個で迷霊落ちフラグが立ち、demoteToMeirei で魂台帳が変わる", () => {
    ctx.entry.book("bob", "flex", { source: "none" });
    ctx.entry.ghostify("bob", "staff");
    for (let i = 0; i < 3; i++) {
      expect(submit(ctx, "bob", "demotion", `user:sw${i}`).demotionReached).toBe(false);
    }
    const fourth = submit(ctx, "bob", "demotion");
    expect(fourth.demotionReached).toBe(true);

    ctx.evaluation.demoteToMeirei("bob", "system:marks", "低評価印4個");
    expect(ctx.entry.getSoul("bob")!.status).toBe("meirei");
    expect(ctx.events.listByTarget("bob").map((e) => e.type)).toContain("demotion");
  });

  it("同一評価員の再評価は上書き（印が重複しない）", () => {
    // 同じ評価員が3回昇格印を付けても1個
    for (let i = 0; i < 3; i++) submit(ctx, "dave", "promotion");
    expect(ctx.evaluation.promotionScore("dave").evalMarks).toBe(1);
    expect(ctx.evaluation.evaluationCount("dave")).toBe(1);

    // 結論を変えたら古い印は消えて新しい印だけが残る
    submit(ctx, "dave", "demotion");
    expect(ctx.evaluation.promotionScore("dave").evalMarks).toBe(0);
    expect(ctx.evaluation.demotionCount("dave")).toBe(1);

    // 印なしに変えたら両方消える
    submit(ctx, "dave", "none");
    expect(ctx.evaluation.promotionScore("dave").evalMarks).toBe(0);
    expect(ctx.evaluation.demotionCount("dave")).toBe(0);

    // 別の評価員の印は影響を受けない
    submit(ctx, "dave", "promotion", "user:other");
    submit(ctx, "dave", "promotion");
    expect(ctx.evaluation.promotionScore("dave").evalMarks).toBe(2);
    expect(ctx.evaluation.evaluationCount("dave")).toBe(2);
  });

  it("再評価時に旧印が無効化され、新しい印数へ置換される", () => {
    submit(ctx, "redo", "promotion", "user:evaluator", 3);
    expect(ctx.evaluation.promotionScore("redo").evalMarks).toBe(3);

    const second = submit(ctx, "redo", "demotion", "user:evaluator", 2);
    expect(second.promotion.evalMarks).toBe(0);
    expect(second.demotionCount).toBe(2);
    expect(ctx.evaluation.evaluationCount("redo")).toBe(1);

    const rows = ctx.db
      .prepare("SELECT conclusion, mark_weight FROM evaluations WHERE target_id='redo' ORDER BY id")
      .all() as Array<{ conclusion: string; mark_weight: number }>;
    expect(rows).toEqual([
      { conclusion: "promotion", mark_weight: 3 },
      { conclusion: "demotion", mark_weight: 2 },
    ]);
  });

  it("評価記帳はtransactionで、履歴INSERT失敗時に旧印を維持する", () => {
    submit(ctx, "atomic", "promotion", "user:evaluator", 2);
    expect(ctx.evaluation.promotionScore("atomic").evalMarks).toBe(2);

    ctx.db.exec(`
      CREATE TRIGGER fail_evaluations_insert
      BEFORE INSERT ON evaluations
      BEGIN
        SELECT RAISE(FAIL, 'forced evaluation insert failure');
      END;
    `);

    expect(() => submit(ctx, "atomic", "demotion", "user:evaluator", 3)).toThrow(/forced evaluation insert failure/);
    expect(ctx.evaluation.promotionScore("atomic").evalMarks).toBe(2);
    expect(ctx.evaluation.demotionCount("atomic")).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) AS c FROM evaluations WHERE target_id='atomic'").get() as { c: number }).c).toBe(1);
  });

  it("前回評価内容を取得でき、履歴は追記で残る", () => {
    submit(ctx, "history", "promotion", "user:evaluator", 2);
    submit(ctx, "history", "none", "user:evaluator");

    const latest = ctx.evaluation.latestByEvaluator("history", "user:evaluator")!;
    expect(latest.conclusion).toBe("none");
    expect(latest.scores).toEqual(SCORES);
    expect(latest.texts.detail).toBe("テスト");
    expect(latest.texts.merit).toBe("メリット");
    expect(latest.markWeight).toBe(0);
    expect((ctx.db.prepare("SELECT COUNT(*) AS c FROM evaluations WHERE target_id='history'").get() as { c: number }).c).toBe(2);
  });

  it("取り消した印は集計に入らない", () => {
    const r1 = submit(ctx, "carol", "demotion");
    expect(ctx.evaluation.demotionCount("carol")).toBe(1);
    // 直近の印を取消
    const markId = (r1 as { evaluationId: number }).evaluationId; // eval id ≠ mark id の可能性があるため markを直接引く
    void markId;
    const mark = (ctx.db.prepare("SELECT id FROM marks WHERE target_id = 'carol'").get() as { id: number });
    ctx.evaluation.revokeMark(mark.id, "staff");
    expect(ctx.evaluation.demotionCount("carol")).toBe(0);
  });
});

describe("カロン（期限管理）", () => {
  it("期限一覧と期限切れ（昇格到達者は除外）が取れる", () => {
    const ctx = setup();
    const nowTs = Math.floor(Date.now() / 1000);

    // ghost 3人: 期限切れ / 期限切れだが昇格到達 / まだ先
    for (const u of ["expired", "reached", "future"]) {
      ctx.entry.book(u, "flex", { source: "none" });
      ctx.entry.ghostify(u, "staff");
    }
    ctx.db.prepare("UPDATE souls SET eval_deadline_at = ? WHERE user_id IN ('expired','reached')").run(nowTs - 3600);
    for (let i = 0; i < 5; i++) {
      ctx.evaluation.addMark("reached", "promotion", `user:sw${i}`, "evaluation");
    }

    const overdue = ctx.evaluation.overdue();
    expect(overdue.map((r) => r.user_id)).toEqual(["expired"]);

    const due = ctx.evaluation.dueBetween(nowTs, nowTs + 15 * 86400);
    expect(due.map((r) => r.user_id)).toEqual(["future"]);
  });

  it("スレッド対応表は上書き保存できる", () => {
    const ctx = setup();
    ctx.evaluation.setThread("alice", "th1");
    ctx.evaluation.setThread("alice", "th2");
    expect(ctx.evaluation.threadFor("alice")).toBe("th2");
  });
});
