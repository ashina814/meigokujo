import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import {
  CONFESSION_FOLLOW_UP_MAX_ATTEMPTS,
  CONFESSION_SENDER_REPLY_DEADLINE_DAYS,
  CONFESSION_SENDER_REPLY_DEADLINE_SECONDS,
  Confessions,
  confessionBall,
  type ConfessionRow,
} from "../src/confession/service.js";

/**
 * 会話の終端（Task #219）の中核。
 *
 * ここで固定したいのは「受領確認 / 内容への回答 / 会話の終了 が別物である」ことと、
 * 「自動終了できるのは、運営が返答を待つと**決めた**案件だけ」であること。
 */

let db: Database.Database;
let confessions: Confessions;
/** restart を再現するため、実ファイルDBを使う（:memory: は開き直せない） */
let dbPath: string;
let tmpDir: string;
let reopenedDbs: Database.Database[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "confession-closure-"));
  dbPath = join(tmpDir, "bot.db");
  db = openDb(dbPath);
  confessions = new Confessions(db, new EventLog(db));
  reopenedDbs = [];
});

afterEach(() => {
  for (const handle of reopenedDbs) handle.close();
  db.close();
  // Windows では掴んだままの一時ファイルを消せないことがある。テストの結果とは無関係
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 環境要因。ここでテストを落とさない */
  }
});

const seed = (wish: "yes" | "either" | "no" | null = "yes"): ConfessionRow => {
  const row = confessions.create("sender-1", { type: "soudan", replyWish: wish ?? undefined, body: "本文" });
  confessions.claim(row.id, "thread-1", "staff-1");
  return confessions.get(row.id)!;
};
const eventsOf = (type: string): number =>
  (db.prepare("SELECT COUNT(*) n FROM events WHERE type=?").get(type) as { n: number }).n;

/** 受領確認を1往復ぶん動かす。outcome は Discord から返ってきた結末。 */
const ack = (id: number, staffId: string, outcome: "delivered" | "failed" | "unknown" = "delivered") => {
  const begun = confessions.beginAcknowledgement(id, staffId);
  if (!begun.ok) return begun;
  confessions.settleAcknowledgement(begun.attemptId, outcome, staffId);
  return begun;
};

describe("受領確認は回答でも終了でもなく、届いたときだけ届いたと言う", () => {
  // U1 / U2 / U3: 回答希望に関係なく受領確認できる。U2 が元バグの回帰テスト。
  for (const wish of ["yes", "either", "no", null] as const) {
    it(`回答希望=${wish ?? "未選択"} でも受領確認を送れて、案件は開いたまま`, () => {
      const row = seed(wish);
      expect(ack(row.id, "staff-1").ok).toBe(true);

      const after = confessions.get(row.id)!;
      expect(after.acknowledged_at).not.toBeNull();
      expect(after.acknowledged_by).toBe("staff-1");
      expect(confessions.ackState(row.id)).toBe("delivered");
      // 状態はひとつも動かない
      expect(after.status).toBe("claimed");
      expect(after.stage).toBe("active");
      expect(after.closed_at).toBeNull();
      expect(after.close_reason).toBeNull();
      expect(after.reply_deadline_at).toBeNull();
      // U15: 受領しただけでは、まだ運営の番のまま
      expect(confessionBall(after)).toBe("staff_attention");
      // 回答希望そのものは書き換えない
      expect(after.reply_wish).toBe(wish);
    });
  }

  // U16: 届かなかったものを「届いた」ことにしない
  it("DM が明確に失敗したら acknowledged_at は入らない（送信済みにしない）", () => {
    const row = seed("yes");
    expect(ack(row.id, "staff-1", "failed").ok).toBe(true);
    const after = confessions.get(row.id)!;
    expect(after.acknowledged_at).toBeNull();
    expect(after.acknowledged_by).toBeNull();
    expect(confessions.ackState(row.id)).toBe("failed");
    // 「届いた」イベントも残さない
    expect(eventsOf("confession_acknowledge")).toBe(0);
    expect(eventsOf("confession_acknowledge_failed")).toBe(1);
  });

  // U16: 結果不明も delivered ではない
  it("送信結果が不明なときも acknowledged_at は入らず、不明として区別される", () => {
    const row = seed("yes");
    expect(ack(row.id, "staff-1", "unknown").ok).toBe(true);
    expect(confessions.get(row.id)!.acknowledged_at).toBeNull();
    expect(confessions.ackState(row.id)).toBe("unknown");
    expect(eventsOf("confession_acknowledge")).toBe(0);
  });

  // U17: 明確な失敗のあとは、担当者の操作でやり直せる
  it("失敗のあとは再試行でき、成功したときだけ acknowledged_at が入る", () => {
    const row = seed("either");
    ack(row.id, "staff-1", "failed");
    expect(confessions.get(row.id)!.acknowledged_at).toBeNull();

    expect(ack(row.id, "staff-1", "delivered").ok).toBe(true);
    expect(confessions.get(row.id)!.acknowledged_at).not.toBeNull();
    expect(confessions.ackState(row.id)).toBe("delivered");
    // 「届いた」記録は最後の1回だけ
    expect(eventsOf("confession_acknowledge")).toBe(1);
  });

  // R5: 送信中の二度押しは行レベルで負ける（時刻の書き込み順に頼らない）
  it("送信中の試行は案件につき1つ。二人目は attempt_in_flight で負ける", () => {
    const row = seed("either");
    const first = confessions.beginAcknowledgement(row.id, "staff-1");
    expect(first.ok).toBe(true);
    expect(confessions.beginAcknowledgement(row.id, "staff-2")).toMatchObject({
      ok: false,
      code: "attempt_in_flight",
    });
    expect(confessions.ackState(row.id)).toBe("in_flight");
    // 送信中は「送信済み」に見えない
    expect(confessions.get(row.id)!.acknowledged_at).toBeNull();
  });

  it("届いたあとは、もう一度送ろうとしても始まらない", () => {
    const row = seed("either");
    ack(row.id, "staff-1");
    expect(confessions.beginAcknowledgement(row.id, "staff-2")).toMatchObject({
      ok: false,
      code: "already_delivered",
    });
    expect(confessions.get(row.id)!.acknowledged_by).toBe("staff-1");
  });

  /**
   * **決着の途中で落ちても、片方だけ書かれた状態を残さない。**
   *
   * ここが分割されていると「試行は delivered なのに acknowledged_at は NULL」が生まれ、
   * `ackState` が none へ落ちて**届いている DM をもう一通送れてしまう**。
   * プロセスを本当に殺すことはできないので、決着の途中で確実に失敗する箇所
   * （監査記録の書き込み）を壊して同じ境界を作る。
   */
  it("決着の途中で失敗したら、試行も案件側も書かれない", () => {
    const row = seed("yes");
    const begun = confessions.beginAcknowledgement(row.id, "staff-1") as { ok: true; attemptId: number };
    expect(begun.ok).toBe(true);

    const events = new EventLog(db);
    const broken = new Confessions(db, events);
    const original = events.log.bind(events);
    events.log = ((type: string, opts: unknown) => {
      if (type === "confession_acknowledge") throw new Error("監査記録の書き込みに失敗");
      return original(type, opts as never);
    }) as typeof events.log;

    expect(() => broken.settleAcknowledgement(begun.attemptId, "delivered", "staff-1")).toThrow();

    // 片方だけ進んだ状態が残っていない
    expect(confessions.get(row.id)!.acknowledged_at).toBeNull();
    expect(confessions.lastAckAttempt(row.id)!.outcome).toBeNull();
    // したがって「送信中」のまま＝二重送信の窓が開かない
    expect(confessions.ackState(row.id)).toBe("in_flight");
  });

  it("終了済みの案件へは受領確認を始められない", () => {
    const row = seed("no");
    confessions.close(row.id, "staff-1", "resolved");
    expect(confessions.beginAcknowledgement(row.id, "staff-1")).toMatchObject({ ok: false, code: "already_closed" });
  });
});

describe("自由返信は、待つのか終えるのかを明示してはじめて成立する", () => {
  it("「返答を待つ」は投稿者待ち＋期限を置く。期限は canonical constant から導く", () => {
    const row = seed("yes");
    const at = 1_800_000_000;
    confessions.applyStaffReplyWaiting(row.id, "staff-1", at);
    const after = confessions.get(row.id)!;
    expect(after.stage).toBe("awaiting_poster");
    expect(after.reply_deadline_at).toBe(at + CONFESSION_SENDER_REPLY_DEADLINE_SECONDS);
    expect(CONFESSION_SENDER_REPLY_DEADLINE_SECONDS).toBe(CONFESSION_SENDER_REPLY_DEADLINE_DAYS * 86_400);
    expect(confessionBall(after)).toBe("waiting_sender");
  });

  // R4: 「返信して終了」の二度押しで、本文が二重に届かない
  it("下書きを消費できるのは一度だけ（送信権は1人分しか出ない）", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "確認しました。");
    expect(confessions.claimReplyDraft(draft.id, "staff-1", "close").ok).toBe(true);
    expect(confessions.claimReplyDraft(draft.id, "staff-1", "close")).toMatchObject({
      ok: false,
      code: "already_consumed",
    });
  });

  // P1: 届いた本文を DB に残さない
  it("届いたと確定した返信本文は DB から消え、監査メタだけが残る", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "確認しました。", 90);
    expect(confessions.getReplyDraft(draft.id)!.body).toBe("確認しました。");
    expect(confessions.getReplyDraft(draft.id)!.body_purge_at).not.toBeNull();

    confessions.claimReplyDraft(draft.id, "staff-1", "close");
    confessions.finishReplyDraft(draft.id, "delivered");

    const after = confessions.getReplyDraft(draft.id)!;
    expect(after.body).toBeNull();
    expect(after.outcome).toBe("delivered");
    expect(after.confession_id).toBe(row.id);
    expect(after.staff_id).toBe("staff-1");
    expect(after.intent).toBe("close");
  });

  // P2: 届かなかった本文も、案件と同じ保持期限の内側にある
  it("届かなかった返信本文は再試行のため残るが、保持期限を過ぎたら消える", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "秘密の連絡", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    confessions.finishReplyDraft(draft.id, "unknown");
    expect(confessions.getReplyDraft(draft.id)!.body).toBe("秘密の連絡");

    const purgeAt = confessions.getReplyDraft(draft.id)!.body_purge_at!;
    expect(confessions.purgeExpiredConversationBodies(purgeAt - 1).drafts).toBe(0);
    expect(confessions.purgeExpiredConversationBodies(purgeAt).drafts).toBe(1);
    expect(confessions.getReplyDraft(draft.id)!.body).toBeNull();
    expect(confessions.getReplyDraft(draft.id)!.outcome).toBe("unknown");
  });

  it("下書きを書いた本人以外は送信できない", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "本文");
    expect(confessions.claimReplyDraft(draft.id, "staff-2", "wait")).toMatchObject({ ok: false, code: "not_owner" });
    expect(confessions.getReplyDraft(draft.id)!.consumed_at).toBeNull();
  });

  // R1: モーダルを開いている間に投稿者が終了 → 返信で再オープンさせない
  it("下書き中に投稿者が終了したら、その返信は送れず案件も再開しない", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "本文");
    confessions.senderCloseAtomic(row.id, "sender-1");
    const claim = confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    expect(claim).toMatchObject({ ok: false, code: "case_closed" });
    const after = confessions.get(row.id)!;
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
  });
});

describe("投稿者自身が終われる", () => {
  // U6
  it("投稿者の終了は履歴を残したまま終端へ移し、終了側も記録する", () => {
    const row = seed("yes");
    const result = confessions.senderCloseAtomic(row.id, "sender-1", 90);
    expect(result.ok).toBe(true);
    const after = confessions.get(row.id)!;
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
    expect(after.close_reason).toBe("poster_ended");
    expect(after.closed_by).toBe("sender-1");
    // 履歴は消えない
    expect(after.body).toBe("本文");
    expect(after.thread_id).toBe("thread-1");
    expect(after.body_purge_at).not.toBeNull();
    expect(confessionBall(after)).toBe("closed");
  });

  // U7: 本人以外は拒否
  it("投稿者以外は終了できない（状態も変わらない）", () => {
    const row = seed("yes");
    expect(confessions.senderCloseAtomic(row.id, "someone-else")).toMatchObject({ ok: false, code: "not_sender" });
    expect(confessions.get(row.id)!.status).toBe("claimed");
    expect(eventsOf("confession_close")).toBe(0);
  });

  // R3: 二度押し
  it("投稿者の終了は一度だけ成立する", () => {
    const row = seed("yes");
    expect(confessions.senderCloseAtomic(row.id, "sender-1").ok).toBe(true);
    expect(confessions.senderCloseAtomic(row.id, "sender-1")).toMatchObject({ ok: false, code: "already_closed" });
    expect(eventsOf("confession_close")).toBe(1);
  });
});

describe("投稿者の追記は運営の番へ戻し、期限を消す", () => {
  // U8 / R6
  it("投稿者待ちからの追記で、本文が確定し、担当者の番へ戻り期限が消える", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    expect(confessionBall(confessions.get(row.id)!)).toBe("waiting_sender");

    const result = confessions.recordSenderFollowUp(row.id, "sender-1", "こういう状況です。", 90);
    expect(result.ok).toBe(true);
    const after = confessions.get(row.id)!;
    expect(after.stage).toBe("awaiting_staff");
    expect(after.reply_deadline_at).toBeNull();
    expect(confessionBall(after)).toBe("staff_attention");
    // **本文は Discord へ渡す前に DB 上で確定している**
    const stored = confessions.getFollowUp((result as { followUpId: number }).followUpId)!;
    expect(stored.body).toBe("こういう状況です。");
    expect(stored.relayed_at).toBeNull();
    expect(stored.outcome).toBeNull();
  });

  // U18: 中継に失敗しても本文は残り、案件は運営の番のまま
  it("中継に失敗しても追記本文は残り、期限も戻らない", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    const result = confessions.recordSenderFollowUp(row.id, "sender-1", "助けてほしい", 90) as { ok: true; followUpId: number };
    // 実際の経路と同じく、所有権を取ってから送る（試行回数はここで増える）
    expect(confessions.claimFollowUpRelay(result.followUpId)).toBeDefined();
    confessions.settleFollowUpRelay(result.followUpId, "failed");

    const stored = confessions.getFollowUp(result.followUpId)!;
    expect(stored.body).toBe("助けてほしい"); // 失われない
    expect(stored.relayed_at).toBeNull();
    expect(stored.attempts).toBe(1);
    expect(confessions.get(row.id)!.reply_deadline_at).toBeNull();
    expect(confessions.listUnrelayedFollowUps(row.id)).toHaveLength(1);
  });

  // U19: 明確な失敗だけを自動で拾い直し、届いたら本文を残さない
  it("明確な失敗は再試行の対象になり、届いた時点で本文が消える", () => {
    const row = seed("yes");
    const result = confessions.recordSenderFollowUp(row.id, "sender-1", "追記", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(result.followUpId);
    confessions.settleFollowUpRelay(result.followUpId, "failed");

    expect(confessions.listRelayableFollowUps().map((r: { id: number }) => r.id)).toEqual([result.followUpId]);
    const claimed = confessions.claimFollowUpRelay(result.followUpId);
    expect(claimed).toBeDefined();
    // 所有権は1つだけ（同時に2回中継しない）
    expect(confessions.claimFollowUpRelay(result.followUpId)).toBeUndefined();

    confessions.settleFollowUpRelay(result.followUpId, "delivered");
    const after = confessions.getFollowUp(result.followUpId)!;
    expect(after.relayed_at).not.toBeNull();
    expect(after.body).toBeNull(); // P1: 届いた本文は残さない
    expect(confessions.listUnrelayedFollowUps(row.id)).toEqual([]);
  });

  // unknown ≠ failed。届いている可能性のある本文を勝手にもう一度送らない
  it("送信結果が不明な追記は、自動再試行の対象に入らない", () => {
    const row = seed("yes");
    const result = confessions.recordSenderFollowUp(row.id, "sender-1", "追記", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(result.followUpId);
    confessions.settleFollowUpRelay(result.followUpId, "unknown");
    expect(confessions.listRelayableFollowUps()).toEqual([]);
    expect(confessions.claimFollowUpRelay(result.followUpId)).toBeUndefined();
    // ただし担当者からは見える
    expect(confessions.listUnrelayedFollowUps(row.id)).toHaveLength(1);
  });

  // P2: 未引き渡しの本文も保持期限の内側
  it("未引き渡しの追記本文も、保持期限を過ぎたら消える", () => {
    const row = seed("yes");
    const result = confessions.recordSenderFollowUp(row.id, "sender-1", "秘密", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(result.followUpId);
    confessions.settleFollowUpRelay(result.followUpId, "unknown");
    const purgeAt = confessions.getFollowUp(result.followUpId)!.body_purge_at!;
    expect(confessions.purgeExpiredConversationBodies(purgeAt - 1).followUps).toBe(0);
    expect(confessions.purgeExpiredConversationBodies(purgeAt).followUps).toBe(1);
    expect(confessions.getFollowUp(result.followUpId)!.body).toBeNull();
  });

  it("投稿者以外は追記できない（本文も残らない）", () => {
    const row = seed("yes");
    expect(confessions.recordSenderFollowUp(row.id, "not-the-sender", "本文")).toMatchObject({
      ok: false,
      code: "not_sender",
    });
    expect(confessions.listUnrelayedFollowUps(row.id)).toEqual([]);
  });

  it("終了済みには追記できない（本文も残らない）", () => {
    const row = seed("yes");
    confessions.senderCloseAtomic(row.id, "sender-1");
    expect(confessions.recordSenderFollowUp(row.id, "sender-1", "本文")).toMatchObject({
      ok: false,
      code: "already_closed",
    });
    expect(confessions.listUnrelayedFollowUps(row.id)).toEqual([]);
  });
});

describe("自動終了の対象は「運営が返答を待つと決めた案件」だけ", () => {
  const future = () => Math.floor(Date.now() / 1000) + CONFESSION_SENDER_REPLY_DEADLINE_SECONDS + 10;

  it("期限が来た投稿者待ちだけを抽出する", () => {
    const waiting = seed("yes");
    confessions.applyStaffReplyWaiting(waiting.id, "staff-1");

    const untouched = seed("yes"); // 未対応→対応中のまま
    const held = seed("yes");
    confessions.setInternalHold(held.id, "staff-1");

    const due = confessions.listDueSenderTimeouts(future());
    expect(due.map((r) => r.id)).toEqual([waiting.id]);
    expect(due.map((r) => r.id)).not.toContain(untouched.id);
    expect(due.map((r) => r.id)).not.toContain(held.id);
  });

  // U10 / M4: 運営側の確認待ちは絶対に自動終了しない
  it("運営側の確認待ちは、いくら時間が経っても自動終了の対象に入らない", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    confessions.setInternalHold(row.id, "staff-1"); // 期限も消える
    expect(confessions.get(row.id)!.reply_deadline_at).toBeNull();
    expect(confessions.listDueSenderTimeouts(future() + 86_400 * 365)).toEqual([]);
    expect(confessionBall(confessions.get(row.id)!)).toBe("waiting_staff");
  });

  // U13 / M6: 期限の根拠が無い既存 awaiting_poster を勝手に畳まない
  it("期限を持たない既存の投稿者待ちは、何年経っても自動終了しない", () => {
    const row = seed(null);
    // 旧実装が付けていた形をそのまま再現する（stage だけがあり、期限が無い）
    db.prepare("UPDATE confession_tickets SET stage='awaiting_poster', created_at=1 WHERE id=?").run(row.id);
    const legacy = confessions.get(row.id)!;
    expect(confessionBall(legacy)).toBe("legacy_open");
    expect(confessions.listDueSenderTimeouts(future() + 86_400 * 3650)).toEqual([]);
  });

  // U9
  it("期限が来たら自動終了し、終了側は timeout として残る", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    const deadline = confessions.get(row.id)!.reply_deadline_at!;
    const result = confessions.autoCloseExpiredAtomic(row.id, deadline, 90);
    expect(result.ok).toBe(true);
    const after = confessions.get(row.id)!;
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("timeout");
    expect(after.close_reason).toBe("no_response");
    expect(after.body).toBe("本文"); // 削除ではない
  });

  // R2: 追記と自動終了の競合
  it("追記が受理された後は、直前に読まれた古い期限では閉じられない", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    const staleDeadline = confessions.get(row.id)!.reply_deadline_at!;

    // worker が期限を読んだ「あと」に投稿者が追記した
    expect(confessions.recordSenderFollowUp(row.id, "sender-1", "まだ困っています").ok).toBe(true);

    expect(confessions.autoCloseExpiredAtomic(row.id, staleDeadline)).toMatchObject({ ok: false });
    const after = confessions.get(row.id)!;
    expect(after.status).toBe("claimed");
    expect(confessionBall(after)).toBe("staff_attention");
  });

  // R7: 古い worker が新しい会話を閉じない
  it("期限が更新された後は、古い期限を持つ実行が新しい会話を閉じない", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1", 1_800_000_000);
    const oldDeadline = confessions.get(row.id)!.reply_deadline_at!;

    // 投稿者が追記し、担当者がもう一度返信して期限が引き直された
    confessions.recordSenderFollowUp(row.id, "sender-1", "追記");
    confessions.applyStaffReplyWaiting(row.id, "staff-1", 1_900_000_000);
    const newDeadline = confessions.get(row.id)!.reply_deadline_at!;
    expect(newDeadline).not.toBe(oldDeadline);

    expect(confessions.autoCloseExpiredAtomic(row.id, oldDeadline)).toMatchObject({ ok: false });
    expect(confessions.get(row.id)!.status).toBe("claimed");
    // 正しい期限でなら閉じられる
    expect(confessions.autoCloseExpiredAtomic(row.id, newDeadline).ok).toBe(true);
  });

  it("自動終了は二重に走らない", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    const deadline = confessions.get(row.id)!.reply_deadline_at!;
    expect(confessions.autoCloseExpiredAtomic(row.id, deadline).ok).toBe(true);
    expect(confessions.autoCloseExpiredAtomic(row.id, deadline).ok).toBe(false);
    expect(eventsOf("confession_close")).toBe(1);
  });
});

describe("次に誰の番か", () => {
  it("未対応・対応中・担当者待ちは運営の番", () => {
    const open = confessions.create("s", {});
    expect(confessionBall(confessions.get(open.id)!)).toBe("staff_attention");
    const claimed = seed("yes");
    expect(confessionBall(claimed)).toBe("staff_attention");
    confessions.setStage(claimed.id, "awaiting_staff", "staff-1");
    expect(confessionBall(confessions.get(claimed.id)!)).toBe("staff_attention");
  });

  it("終了済みは closed", () => {
    const row = seed("yes");
    expect(confessions.close(row.id, "staff-1", "resolved").ok).toBe(true);
    expect(confessionBall(confessions.get(row.id)!)).toBe("closed");
    expect(confessions.get(row.id)!.closed_side).toBe("staff");
  });

  // R8 の核: 既に終わっている会話を、あとから来た確定が塗り替えない
  it("投稿者が終えた会話を、担当者側の終了が上書きしない", () => {
    const row = seed("yes");
    expect(confessions.senderCloseAtomic(row.id, "sender-1").ok).toBe(true);
    const sealed = confessions.get(row.id)!;

    const late = confessions.close(row.id, "staff-1", "resolved", 90, "staff");
    expect(late).toMatchObject({ ok: false, code: "already_closed" });

    const after = confessions.get(row.id)!;
    expect(after.closed_side).toBe("sender");
    expect(after.close_reason).toBe("poster_ended");
    expect(after.closed_by).toBe("sender-1");
    expect(after.closed_at).toBe(sealed.closed_at);
    // 偽の終了ログも残らない
    expect(eventsOf("confession_close")).toBe(1);
  });

  // R9 の核: 終わった会話に「待っている」を生やさない
  it("終了済みの会話へ返答待ちを付けようとしても、期限もイベントも作らない", () => {
    const row = seed("yes");
    confessions.senderCloseAtomic(row.id, "sender-1");
    expect(confessions.applyStaffReplyWaiting(row.id, "staff-1")).toMatchObject({
      ok: false,
      code: "already_closed",
    });
    expect(confessions.get(row.id)!.reply_deadline_at).toBeNull();
    expect(confessions.get(row.id)!.stage).not.toBe("awaiting_poster");
    expect(eventsOf("confession_reply_wait")).toBe(0);
  });

  it("終了済みの会話へ運営側の待機を付けようとしても負ける", () => {
    const row = seed("yes");
    confessions.senderCloseAtomic(row.id, "sender-1");
    expect(confessions.setInternalHold(row.id, "staff-1")).toMatchObject({ ok: false, code: "already_closed" });
    expect(eventsOf("confession_internal_hold")).toBe(0);
  });

  // R10 の核: 自動終了が先に成立していたら、担当者側の確定は勝てない
  it("自動終了が先に成立した会話を、あとから来た担当者の確定が壊さない", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    const deadline = confessions.get(row.id)!.reply_deadline_at!;
    expect(confessions.autoCloseExpiredAtomic(row.id, deadline).ok).toBe(true);

    expect(confessions.close(row.id, "staff-1", "resolved", 90, "staff")).toMatchObject({ ok: false });
    expect(confessions.applyStaffReplyWaiting(row.id, "staff-1")).toMatchObject({ ok: false });
    const after = confessions.get(row.id)!;
    expect(after.closed_side).toBe("timeout");
    expect(after.reply_deadline_at).toBeNull();
  });

  it("終了すると、残っていた返答期限は必ず消える", () => {
    const row = seed("yes");
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    expect(confessions.close(row.id, "staff-1", "resolved").ok).toBe(true);
    expect(confessions.get(row.id)!.reply_deadline_at).toBeNull();
  });
});

describe("既存DBへの後付け", () => {
  // U13 の schema 側。既存行を触らずに列だけ増える。
  it("Task #219 の列が無い旧DBでも、既存行を書き換えずに移行できる", () => {
    const legacy = openDb(":memory:");
    legacy.exec(`CREATE TABLE confession_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', thread_id TEXT, claimed_by TEXT,
      created_at INTEGER NOT NULL, claimed_at INTEGER, closed_at INTEGER,
      stage TEXT)`);
    legacy
      .prepare("INSERT INTO confession_tickets (user_id, status, stage, created_at) VALUES ('u', 'claimed', 'awaiting_poster', 1)")
      .run();

    const migrated = new Confessions(legacy, new EventLog(legacy));
    const row = migrated.get(1)!;
    expect(row.status).toBe("claimed");
    expect(row.stage).toBe("awaiting_poster");
    // 推測で投稿者待ち＋期限にしない
    expect(row.reply_deadline_at).toBeNull();
    expect(row.acknowledged_at).toBeNull();
    expect(row.closed_side).toBeNull();
    expect(confessionBall(row)).toBe("legacy_open");
    expect(migrated.listDueSenderTimeouts(9_999_999_999)).toEqual([]);
    legacy.close();
  });
});

describe("プロセスが落ちても、送信中が永遠に残らない", () => {
  /**
   * **同じ file DB を開き直して「プロセスが消えた」を作る。**
   *
   * in-memory の service を使い回すと、プロセス内の変数が生き残ってしまい
   * 「前のプロセスの置き土産」という状況そのものが作れない。sleep も使わない。
   */
  const restart = (): Confessions => {
    const reopened = openDb(dbPath);
    reopenedDbs.push(reopened);
    return new Confessions(reopened, new EventLog(reopened));
  };

  // R12: 受領確認の送信中に落ちた
  it("送信中の受領確認は unknown として回収され、索引が永久に塞がない", () => {
    const row = seed("yes");
    const begun = confessions.beginAcknowledgement(row.id, "staff-1");
    expect(begun.ok).toBe(true);
    expect(confessions.ackState(row.id)).toBe("in_flight");

    const after = restart();
    // 起動時回収の前は「送信中」のまま＝新しい試行を始められない
    expect(after.beginAcknowledgement(row.id, "staff-1")).toMatchObject({ ok: false, code: "attempt_in_flight" });

    expect(after.recoverOrphanedEffects().ackAttempts).toBe(1);
    // delivered でも failed でもなく unknown
    expect(after.ackState(row.id)).toBe("unknown");
    expect(after.get(row.id)!.acknowledged_at).toBeNull();
    // 索引が空いて、あらためて送れる（自動再送ではなく、担当者の操作で）
    expect(after.beginAcknowledgement(row.id, "staff-1").ok).toBe(true);
  });

  // R13: 外部は delivered、DB 確定の前に落ちた
  it("受領確認の決着は分割されない（届いた記録と案件側が食い違わない）", () => {
    const row = seed("yes");
    const begun = confessions.beginAcknowledgement(row.id, "staff-1");
    confessions.settleAcknowledgement((begun as { attemptId: number }).attemptId, "delivered", "staff-1");

    const after = restart();
    // 片方だけ書かれた状態は存在しない
    expect(after.get(row.id)!.acknowledged_at).not.toBeNull();
    expect(after.lastAckAttempt(row.id)!.outcome).toBe("delivered");
    expect(after.ackState(row.id)).toBe("delivered");
    // 回収しても delivered を unknown へ落とさない
    expect(after.recoverOrphanedEffects().ackAttempts).toBe(0);
    expect(after.ackState(row.id)).toBe("delivered");
    // もう送れない
    expect(after.beginAcknowledgement(row.id, "staff-2")).toMatchObject({ ok: false, code: "already_delivered" });
  });

  // R14: 下書きを消費した直後に落ちた
  it("消費済みの返信下書きは unknown として回収され、本文は保持期限の内側に残る", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "送ったかもしれない返信", 90);
    expect(confessions.claimReplyDraft(draft.id, "staff-1", "wait").ok).toBe(true);
    expect(confessions.getReplyDraft(draft.id)!.outcome).toBe("sending");

    const after = restart();
    expect(after.recoverOrphanedEffects().replyDrafts).toBe(1);
    const recovered = after.getReplyDraft(draft.id)!;
    expect(recovered.outcome).toBe("unknown");
    expect(recovered.body).toBe("送ったかもしれない返信"); // 失わない
    expect(recovered.body_purge_at).not.toBeNull(); // 無期限に残しもしない
    // 会話は動いていない（勝手に待機にも終了にもしない）
    expect(after.get(row.id)!.status).toBe("claimed");
    expect(after.get(row.id)!.reply_deadline_at).toBeNull();
    // 担当者に見える出口がある
    expect(after.listUnresolvedReplyDrafts(row.id).map((d) => d.id)).toEqual([draft.id]);
  });

  // R15: 外部は delivered、会話の遷移の前に落ちない（1トランザクション）
  it("届いた事実・本文の消去・会話の遷移は分割されない", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "確認しました", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    const finalized = confessions.finalizeStaffReply({ draftId: draft.id, intent: "wait", staffId: "staff-1", retentionDays: 90 });
    expect(finalized.transition).toBe("waiting");

    const after = restart();
    const d = after.getReplyDraft(draft.id)!;
    expect(d.outcome).toBe("delivered");
    expect(d.body).toBeNull();
    expect(after.get(row.id)!.reply_deadline_at).toBe(finalized.deadlineAt);
    expect(after.recoverOrphanedEffects().replyDrafts).toBe(0);
  });

  it("会話の遷移に負けても、届いた事実と本文の消去は確定する", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "行き違いの返信", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "close");
    // 送っている間に投稿者が終了した
    confessions.senderCloseAtomic(row.id, "sender-1");

    const finalized = confessions.finalizeStaffReply({ draftId: draft.id, intent: "close", staffId: "staff-1", retentionDays: 90 });
    expect(finalized.transition).toBe("lost");
    // DM は届いている：その事実は残す
    expect(confessions.getReplyDraft(draft.id)!.outcome).toBe("delivered");
    expect(confessions.getReplyDraft(draft.id)!.body).toBeNull();
    // 投稿者の終了は無傷
    expect(confessions.get(row.id)!.closed_side).toBe("sender");
    expect(confessions.get(row.id)!.close_reason).toBe("poster_ended");
    // 偽の close/wait イベントを残さない
    expect(eventsOf("confession_close")).toBe(1);
    expect(eventsOf("confession_reply_wait")).toBe(0);
  });

  // R16 / R17: 追記の中継中に落ちた
  it("中継中の追記は unknown として回収され、自動では送り直さない", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "届いたか分からない追記", 90) as { ok: true; followUpId: number };
    expect(confessions.claimFollowUpRelay(f.followUpId)).toBeDefined();
    expect(confessions.getFollowUp(f.followUpId)!.outcome).toBe("sending");

    const after = restart();
    expect(after.recoverOrphanedEffects().followUps).toBe(1);
    expect(after.getFollowUp(f.followUpId)!.outcome).toBe("unknown");
    expect(after.getFollowUp(f.followUpId)!.body).toBe("届いたか分からない追記");
    // 自動再試行の対象に入らない
    expect(after.listRelayableFollowUps()).toEqual([]);
    // 運営の箱では unknown として見える
    expect(after.followUpTriage(row.id)).toMatchObject({ unknown: 1, total: 1 });
  });

  it("起動時回収は、決着済みの行に触らない", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "届いた追記", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(f.followUpId);
    confessions.settleFollowUpRelay(f.followUpId, "delivered");

    const after = restart();
    expect(after.recoverOrphanedEffects()).toEqual({ ackAttempts: 0, replyDrafts: 0, followUps: 0 });
    expect(after.getFollowUp(f.followUpId)!.outcome).toBe("delivered");
  });
});

describe("担当者が「対応する」を押す前の追記", () => {
  // U24 の core 側
  it("宛先がまだ無い追記は、失敗にも自動再試行にもならない", () => {
    const row = confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    expect(confessions.get(row.id)!.thread_id).toBeNull();

    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "先に伝えておきたいこと", 90) as {
      ok: true;
      followUpId: number;
    };
    // 本文は預かっている
    expect(confessions.getFollowUp(f.followUpId)!.body).toBe("先に伝えておきたいこと");
    // 自動中継の対象に入らない＝試行回数を焼かない
    for (let i = 0; i < 10; i += 1) expect(confessions.listRelayableFollowUps()).toEqual([]);
    expect(confessions.getFollowUp(f.followUpId)!.attempts).toBe(0);
    expect(confessions.getFollowUp(f.followUpId)!.outcome).toBeNull();
    // 運営から見ると「宛先未確定」であって失敗ではない
    expect(confessions.followUpTriage(row.id)).toMatchObject({ notReady: 1, failed: 0, exhausted: 0, total: 1 });

    // 担当者が対応を開始すると、初めて中継の対象になる
    confessions.claim(row.id, "thread-late", "staff-1");
    expect(confessions.listRelayableFollowUps().map((r: { id: number }) => r.id)).toEqual([f.followUpId]);
    expect(confessions.claimFollowUpRelay(f.followUpId)!.attempts).toBe(1);
    confessions.settleFollowUpRelay(f.followUpId, "delivered");
    expect(confessions.getFollowUp(f.followUpId)!.body).toBeNull();
    expect(confessions.followUpTriage(row.id).total).toBe(0);
  });
});

describe("未解決の追記には、人が決められる出口がある", () => {
  const exhaust = (followUpId: number) => {
    for (let i = 0; i < CONFESSION_FOLLOW_UP_MAX_ATTEMPTS; i += 1) {
      confessions.claimFollowUpRelay(followUpId);
      confessions.settleFollowUpRelay(followUpId, "failed");
    }
  };

  // U25
  it("unknown は自動では拾わないが、担当者は重複を承知で送り直せる", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "不明な追記", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(f.followUpId);
    confessions.settleFollowUpRelay(f.followUpId, "unknown");

    expect(confessions.listRelayableFollowUps()).toEqual([]);
    expect(confessions.claimFollowUpRelay(f.followUpId)).toBeUndefined();
    // 手動なら取れる
    expect(confessions.listFollowUpsNeedingDecision(row.id).map((r) => r.id)).toEqual([f.followUpId]);
    const claimed = confessions.claimFollowUpManualRetry(f.followUpId);
    expect(claimed).toBeDefined();
    // 二重には取れない
    expect(confessions.claimFollowUpManualRetry(f.followUpId)).toBeUndefined();
    confessions.settleFollowUpRelay(f.followUpId, "delivered");
    expect(confessions.followUpTriage(row.id).total).toBe(0);
  });

  // U26
  it("自動再試行の上限に達しても行き止まりにしない", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "何度も失敗した追記", 90) as {
      ok: true;
      followUpId: number;
    };
    exhaust(f.followUpId);
    expect(confessions.getFollowUp(f.followUpId)!.attempts).toBe(CONFESSION_FOLLOW_UP_MAX_ATTEMPTS);
    // 自動では拾わない
    expect(confessions.listRelayableFollowUps()).toEqual([]);
    // 運営には「上限到達」として見える
    expect(confessions.followUpTriage(row.id)).toMatchObject({ exhausted: 1, failed: 0 });
    // 手動で送り直せる
    expect(confessions.claimFollowUpManualRetry(f.followUpId)).toBeDefined();
    confessions.settleFollowUpRelay(f.followUpId, "delivered");
    expect(confessions.followUpTriage(row.id).total).toBe(0);
  });

  it("もう渡さなくてよいと判断したら、届いたことにせず閉じられる", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "諦める追記", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(f.followUpId);
    confessions.settleFollowUpRelay(f.followUpId, "unknown");

    confessions.resolveFollowUpManually(f.followUpId, "staff-1");
    const after = confessions.getFollowUp(f.followUpId)!;
    expect(after.outcome).toBe("resolved_manually"); // delivered とは言わない
    expect(after.body).toBeNull();
    expect(confessions.followUpTriage(row.id).total).toBe(0);
    expect(eventsOf("confession_followup_resolved")).toBe(1);
  });
});

describe("会話の終了は、緊急対応を勝手に解決しない", () => {
  const withEmergency = (id: number) =>
    confessions.createEmergency({
      confessionId: id,
      createdBy: "staff-1",
      reason: "危険が続いている",
      target: "対象",
      dangerOngoing: true,
      measures: "watch",
      reviewNote: null,
      note: null,
    });

  // E1
  it("投稿者が会話を終えても、緊急対応は open のまま", () => {
    const row = seed("yes");
    const emg = withEmergency(row.id);
    expect(confessions.senderCloseAtomic(row.id, "sender-1").ok).toBe(true);

    // 「もう大丈夫です」は会話を終える権限であって、
    // 「緊急の安全対応が完了した」と言える権限ではない
    expect(confessions.openEmergencyFor(row.id)?.id).toBe(emg.id);
    expect(confessions.getEmergency(emg.id)!.status).toBe("open");
    expect(confessions.get(row.id)!.status).toBe("closed");
  });

  // E2
  it("期限による自動終了でも、緊急対応は open のまま", () => {
    const row = seed("yes");
    const emg = withEmergency(row.id);
    confessions.applyStaffReplyWaiting(row.id, "staff-1");
    const deadline = confessions.get(row.id)!.reply_deadline_at!;
    expect(confessions.autoCloseExpiredAtomic(row.id, deadline).ok).toBe(true);

    expect(confessions.openEmergencyFor(row.id)?.id).toBe(emg.id);
    expect(confessions.getEmergency(emg.id)!.status).toBe("open");
  });
});
