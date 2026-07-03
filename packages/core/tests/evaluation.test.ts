import { beforeEach, describe, expect, it } from "vitest";
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

function submit(ctx: ReturnType<typeof setup>, target: string, conclusion: "promotion" | "demotion" | "none", evaluator = SWORDSMAN) {
  return ctx.evaluation.submitEvaluation({
    targetId: target,
    evaluatorId: evaluator,
    scores: SCORES,
    texts: { detail: "テスト" },
    conclusion,
  });
}

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
