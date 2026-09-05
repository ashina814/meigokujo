import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import {
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

beforeEach(() => {
  db = openDb(":memory:");
  confessions = new Confessions(db, new EventLog(db));
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
    confessions.settleFollowUpRelay(result.followUpId, "failed");

    expect(confessions.listRetryableFollowUps().map((r) => r.id)).toEqual([result.followUpId]);
    const claimed = confessions.claimFollowUpRetry(result.followUpId);
    expect(claimed).toBeDefined();
    // 所有権は1つだけ（同時に2回中継しない）
    expect(confessions.claimFollowUpRetry(result.followUpId)).toBeUndefined();

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
    confessions.settleFollowUpRelay(result.followUpId, "unknown");
    expect(confessions.listRetryableFollowUps()).toEqual([]);
    expect(confessions.claimFollowUpRetry(result.followUpId)).toBeUndefined();
    // ただし担当者からは見える
    expect(confessions.listUnrelayedFollowUps(row.id)).toHaveLength(1);
  });

  // P2: 未引き渡しの本文も保持期限の内側
  it("未引き渡しの追記本文も、保持期限を過ぎたら消える", () => {
    const row = seed("yes");
    const result = confessions.recordSenderFollowUp(row.id, "sender-1", "秘密", 90) as { ok: true; followUpId: number };
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
