import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { EventLog } from "../src/events/service.js";
import {
  CONFESSION_FOLLOW_UP_MAX_ATTEMPTS,
  CONFESSION_INSTANCE_LEASE_SECONDS,
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

/**
 * 追記の中継を「所有権を取った世代で決着させる」——本番の経路と同じ形。
 * 世代を渡さずに決着させる API はもう無い（型で漏れが止まる）。
 */
const settleFollow = (followUpId: number, outcome: "delivered" | "failed" | "unknown", generation?: number) => {
  const gen = generation ?? confessions.getFollowUp(followUpId)!.generation;
  return confessions.settleFollowUpRelay({ followUpId, generation: gen, outcome });
};
const settleFollowVia = (
  svc: Confessions,
  followUpId: number,
  outcome: "delivered" | "failed" | "unknown",
  generation?: number,
) => {
  const gen = generation ?? svc.getFollowUp(followUpId)!.generation;
  return svc.settleFollowUpRelay({ followUpId, generation: gen, outcome });
};
/** 返信も同じ。いま現役の世代で決着させる */
const finishDraft = (draftId: number, outcome: "delivered" | "failed" | "unknown") =>
  confessions.finishReplyDraft({ draftId, generation: confessions.getReplyDraft(draftId)!.generation, outcome });


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
    finishDraft(draft.id, "delivered");

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
    finishDraft(draft.id, "unknown");
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
    settleFollow(result.followUpId, "failed");

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
    settleFollow(result.followUpId, "failed");

    expect(confessions.listRelayableFollowUps().map((r: { id: number }) => r.id)).toEqual([result.followUpId]);
    const claimed = confessions.claimFollowUpRelay(result.followUpId);
    expect(claimed).toBeDefined();
    // 所有権は1つだけ（同時に2回中継しない）
    expect(confessions.claimFollowUpRelay(result.followUpId)).toBeUndefined();

    settleFollow(result.followUpId, "delivered");
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
    settleFollow(result.followUpId, "unknown");
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
    settleFollow(result.followUpId, "unknown");
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
  /**
   * 「前のプロセスはもういない」時刻。
   *
   * 起動時回収は**鼓動が途切れた所有者の行だけ**を回収するので、実際の再起動と同じく
   * 貸出期限を過ぎた時点で見る。ここを今の時刻のままにすると、回収は正しく
   * 「まだ生きているかもしれない」と判断して何もしない。
   */
  const afterLease = () => Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1;

  // R12: 受領確認の送信中に落ちた
  it("送信中の受領確認は unknown として回収され、索引が永久に塞がない", () => {
    const row = seed("yes");
    const begun = confessions.beginAcknowledgement(row.id, "staff-1");
    expect(begun.ok).toBe(true);
    expect(confessions.ackState(row.id)).toBe("in_flight");

    const after = restart();
    // 起動時回収の前は「送信中」のまま＝新しい試行を始められない
    expect(after.beginAcknowledgement(row.id, "staff-1")).toMatchObject({ ok: false, code: "attempt_in_flight" });

    expect(after.recoverOrphanedEffects("system:startup", afterLease()).ackAttempts).toBe(1);
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
    expect(after.recoverOrphanedEffects("system:startup", afterLease()).ackAttempts).toBe(0);
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
    expect(after.recoverOrphanedEffects("system:startup", afterLease()).replyDrafts).toBe(1);
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
    const finalized = confessions.finalizeStaffReply({ draftId: draft.id, generation: confessions.getReplyDraft(draft.id)!.generation, intent: "wait", actorId: "staff-1", retentionDays: 90 });
    expect(finalized.transition).toBe("waiting");

    const after = restart();
    const d = after.getReplyDraft(draft.id)!;
    expect(d.outcome).toBe("delivered");
    expect(d.body).toBeNull();
    expect(after.get(row.id)!.reply_deadline_at).toBe(finalized.deadlineAt);
    expect(after.recoverOrphanedEffects("system:startup", afterLease()).replyDrafts).toBe(0);
  });

  it("会話の遷移に負けても、届いた事実と本文の消去は確定する", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "行き違いの返信", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "close");
    // 送っている間に投稿者が終了した
    confessions.senderCloseAtomic(row.id, "sender-1");

    const finalized = confessions.finalizeStaffReply({ draftId: draft.id, generation: confessions.getReplyDraft(draft.id)!.generation, intent: "close", actorId: "staff-1", retentionDays: 90 });
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
    expect(after.recoverOrphanedEffects("system:startup", afterLease()).followUps).toBe(1);
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
    settleFollow(f.followUpId, "delivered");

    const after = restart();
    expect(after.recoverOrphanedEffects("system:startup", afterLease())).toEqual({ ackAttempts: 0, replyDrafts: 0, followUps: 0, renders: 0 });
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
    settleFollow(f.followUpId, "delivered");
    expect(confessions.getFollowUp(f.followUpId)!.body).toBeNull();
    expect(confessions.followUpTriage(row.id).total).toBe(0);
  });
});

describe("未解決の追記には、人が決められる出口がある", () => {
  const exhaust = (followUpId: number) => {
    for (let i = 0; i < CONFESSION_FOLLOW_UP_MAX_ATTEMPTS; i += 1) {
      confessions.claimFollowUpRelay(followUpId);
      settleFollow(followUpId, "failed");
    }
  };

  // U25
  it("unknown は自動では拾わないが、担当者は重複を承知で送り直せる", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "不明な追記", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(f.followUpId);
    settleFollow(f.followUpId, "unknown");

    expect(confessions.listRelayableFollowUps()).toEqual([]);
    expect(confessions.claimFollowUpRelay(f.followUpId)).toBeUndefined();
    // 手動なら取れる
    expect(confessions.listFollowUpsNeedingDecision(row.id).map((r) => r.id)).toEqual([f.followUpId]);
    const claimed = confessions.claimFollowUpManualRetry(row.id, f.followUpId);
    expect(claimed).toBeDefined();
    // 二重には取れない
    expect(confessions.claimFollowUpManualRetry(row.id, f.followUpId)).toBeUndefined();
    settleFollow(f.followUpId, "delivered");
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
    expect(confessions.claimFollowUpManualRetry(row.id, f.followUpId)).toBeDefined();
    settleFollow(f.followUpId, "delivered");
    expect(confessions.followUpTriage(row.id).total).toBe(0);
  });

  it("もう渡さなくてよいと判断したら、届いたことにせず閉じられる", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "諦める追記", 90) as { ok: true; followUpId: number };
    confessions.claimFollowUpRelay(f.followUpId);
    settleFollow(f.followUpId, "unknown");

    confessions.resolveFollowUpManually(row.id, f.followUpId, "staff-1");
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

describe("投稿者が終わらせた会話を、あとからの対応開始が開き直さない", () => {
  // C1（core 側）
  it("対応開始前に投稿者が終了したら、claim は負けて終了がそのまま残る", () => {
    const row = confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    expect(confessions.senderCloseAtomic(row.id, "sender-1", 90).ok).toBe(true);
    const sealed = confessions.get(row.id)!;

    const claimed = confessions.claim(row.id, "thread-late", "staff-1");
    expect(claimed).toMatchObject({ ok: false, code: "already_closed" });

    const after = confessions.get(row.id)!;
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
    expect(after.close_reason).toBe("poster_ended");
    expect(after.closed_at).toBe(sealed.closed_at);
    // スレッドは結ばれない／対応開始の記録も残らない
    expect(after.thread_id).toBeNull();
    expect(eventsOf("confession_claim")).toBe(0);
  });

  it("既に対応中の案件を、もう一度 claim できない", () => {
    const row = seed("yes"); // seed が claim 済み
    expect(confessions.claim(row.id, "thread-2", "staff-2")).toMatchObject({ ok: false, code: "already_claimed" });
    expect(confessions.get(row.id)!.thread_id).toBe("thread-1");
    expect(confessions.get(row.id)!.claimed_by).toBe("staff-1");
  });

  it("再オープンだけが、終わった会話を開き直せる", () => {
    const row = confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    confessions.senderCloseAtomic(row.id, "sender-1", 90);
    const reopened = confessions.reopen(row.id, "staff-1")!;
    expect(reopened.status).toBe("claimed");
    // **終了の印は全部落ちる**（status=claimed なのに closed_side=sender を残さない）
    expect(reopened.closed_side).toBeNull();
    expect(reopened.close_reason).toBeNull();
    expect(reopened.closed_at).toBeNull();
    expect(reopened.closed_by).toBeNull();
    expect(reopened.reply_deadline_at).toBeNull();
  });

  it("終了済みでも未処理の内容があれば、再開せずにスレッドを結べる", () => {
    const row = confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    confessions.recordSenderFollowUp(row.id, "sender-1", "対応前に送った追記", 90);
    confessions.senderCloseAtomic(row.id, "sender-1", 90);

    const bound = confessions.bindRecoveryThread(row.id, "thread-recovery", "staff-1");
    expect(bound.ok).toBe(true);
    const after = confessions.get(row.id)!;
    // **開き直していない**
    expect(after.status).toBe("closed");
    expect(after.closed_side).toBe("sender");
    // それでも宛先はできたので、預かった追記を渡せる
    expect(after.thread_id).toBe("thread-recovery");
    expect(confessions.listRelayableFollowUps().map((r) => r.confession_id)).toEqual([row.id]);
  });

  it("片付いている終了済み案件には、スレッドを結ばない", () => {
    const row = confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    confessions.senderCloseAtomic(row.id, "sender-1", 90);
    expect(confessions.bindRecoveryThread(row.id, "thread-x", "staff-1")).toMatchObject({
      ok: false,
      code: "no_obligations",
    });
    expect(confessions.get(row.id)!.thread_id).toBeNull();
  });
});

describe("追記・下書きの所属案件はDBだけが決める", () => {
  const twoCases = () => {
    const a = seed("yes");
    const bRow = confessions.create("sender-2", { type: "soudan", replyWish: "yes", body: "B の本文" });
    confessions.claim(bRow.id, "thread-b", "staff-2");
    const b = confessions.get(bRow.id)!;
    const f = confessions.recordSenderFollowUp(b.id, "sender-2", "Bだけの秘密", 90) as {
      ok: true;
      followUpId: number;
    };
    confessions.claimFollowUpRelay(f.followUpId);
    settleFollow(f.followUpId, "unknown");
    return { a, b, followUpId: f.followUpId };
  };

  // S1
  it("別案件のIDを渡しても、その追記は取れない（本文も動かない）", () => {
    const { a, b, followUpId } = twoCases();
    // A への権限しか無い担当者が、B の追記IDを A として渡してくる
    expect(confessions.claimFollowUpManualRetry(a.id, followUpId)).toBeUndefined();
    const untouched = confessions.getFollowUp(followUpId)!;
    expect(untouched.outcome).toBe("unknown");
    expect(untouched.body).toBe("Bだけの秘密");
    expect(untouched.confession_id).toBe(b.id);
    // 正しい案件でなら取れる
    expect(confessions.claimFollowUpManualRetry(b.id, followUpId)).toBeDefined();
  });

  // S2
  it("別案件のIDでは、手動決着もできない", () => {
    const { a, b, followUpId } = twoCases();
    expect(confessions.resolveFollowUpManually(a.id, followUpId, "staff-1")?.outcome).toBe("unknown");
    expect(confessions.getFollowUp(followUpId)!.resolved_at).toBeNull();
    expect(eventsOf("confession_followup_resolved")).toBe(0);
    // 正しい案件でなら通る
    confessions.resolveFollowUpManually(b.id, followUpId, "staff-2");
    expect(confessions.getFollowUp(followUpId)!.outcome).toBe("resolved_manually");
  });

  // S3
  it("所属案件はDBから引ける（customId を根拠にしない）", () => {
    const { b, followUpId } = twoCases();
    expect(confessions.followUpCase(followUpId)).toBe(b.id);
    const draft = confessions.createReplyDraft(b.id, "staff-2", "本文", 90);
    expect(confessions.replyDraftCase(draft.id)).toBe(b.id);
  });

  it("返信の下書きも、別案件のIDでは触れない", () => {
    const a = seed("yes");
    const bRow = confessions.create("sender-2", { type: "soudan", replyWish: "yes", body: "B" });
    confessions.claim(bRow.id, "thread-b", "staff-2");
    const draft = confessions.createReplyDraft(bRow.id, "staff-2", "Bへの返信", 90);
    confessions.claimReplyDraft(draft.id, "staff-2", "wait");
    finishDraft(draft.id, "unknown");

    expect(confessions.claimReplyDraftManualRetry(a.id, draft.id, "staff-1")).toBeUndefined();
    expect(confessions.resolveReplyDraftManually(a.id, draft.id, "staff-1")?.outcome).toBe("unknown");
    expect(confessions.getReplyDraft(draft.id)!.body).toBe("Bへの返信");
    // 正しい案件でなら通る
    expect(confessions.claimReplyDraftManualRetry(bRow.id, draft.id, "other-staff")).toBeDefined();
  });
});

describe("未確定の返信にも、人が決められる出口がある", () => {
  const stuck = (outcome: "failed" | "unknown") => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "届いたか分からない返信", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    finishDraft(draft.id, outcome);
    return { row, draft };
  };

  it("未確定の返信は担当者の判断待ちとして並ぶ", () => {
    const { row, draft } = stuck("unknown");
    expect(confessions.listReplyDraftsNeedingDecision(row.id).map((d) => d.id)).toEqual([draft.id]);
    expect(confessions.obligations(row.id).replyDrafts).toBe(1);
  });

  it("もう一度送ると決めたら所有権を取り直す", () => {
    const { row, draft } = stuck("unknown");
    const claimed = confessions.claimReplyDraftManualRetry(row.id, draft.id, "staff-2");
    expect(claimed?.outcome).toBe("sending");
    // 二重には取れない
    expect(confessions.claimReplyDraftManualRetry(row.id, draft.id, "staff-2")).toBeUndefined();
  });

  it("これ以上送らないと決めても、届いたことにはしない", () => {
    const { row, draft } = stuck("unknown");
    const resolved = confessions.resolveReplyDraftManually(row.id, draft.id, "staff-1")!;
    expect(resolved.outcome).toBe("resolved_manually");
    expect(resolved.outcome).not.toBe("delivered");
    expect(resolved.body).toBeNull();
    expect(resolved.resolved_by).toBe("staff-1");
    expect(confessions.obligations(row.id).replyDrafts).toBe(0);
  });
});

describe("配送の時刻は、人の決着で埋めない", () => {
  // B5
  it("手動で畳んだ追記に relayed_at は入らない", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "諦める追記", 90) as {
      ok: true;
      followUpId: number;
    };
    confessions.claimFollowUpRelay(f.followUpId);
    settleFollow(f.followUpId, "unknown");

    confessions.resolveFollowUpManually(row.id, f.followUpId, "staff-1");
    const after = confessions.getFollowUp(f.followUpId)!;
    // **relayed_at != NULL は「実際に渡せた」の意味だけを持つ**
    expect(after.relayed_at).toBeNull();
    expect(after.outcome).toBe("resolved_manually");
    expect(after.resolved_at).not.toBeNull();
    expect(after.resolved_by).toBe("staff-1");
    // 未処理としては数えない
    expect(confessions.listUnrelayedFollowUps(row.id)).toEqual([]);
  });

  it("実際に渡せたときだけ relayed_at が入る", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "届く追記", 90) as {
      ok: true;
      followUpId: number;
    };
    confessions.claimFollowUpRelay(f.followUpId);
    settleFollow(f.followUpId, "delivered");
    expect(confessions.getFollowUp(f.followUpId)!.relayed_at).not.toBeNull();
  });
});

describe("古い実行の帰りが、新しい状態を壊さない", () => {
  const afterLease2 = () => Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1;

  // R24: 起動時回収が unknown にしたあと、古い callback が delivered で帰る
  it("回収後に帰ってきた受領確認の delivered を受け付けない", () => {
    const row = seed("yes");
    const begun = confessions.beginAcknowledgement(row.id, "staff-1") as { ok: true; attemptId: number };
    confessions.recoverOrphanedEffects("system:startup", afterLease2());
    expect(confessions.ackState(row.id)).toBe("unknown");

    confessions.settleAcknowledgement(begun.attemptId, "delivered", "staff-1");
    expect(confessions.get(row.id)!.acknowledged_at).toBeNull();
    expect(confessions.ackState(row.id)).toBe("unknown");
    expect(eventsOf("confession_acknowledge")).toBe(0);
  });

  it("回収後に帰ってきた返信の確定を受け付けない", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "本文", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    confessions.recoverOrphanedEffects("system:startup", afterLease2());
    expect(confessions.getReplyDraft(draft.id)!.outcome).toBe("unknown");

    const finalized = confessions.finalizeStaffReply({ draftId: draft.id, generation: confessions.getReplyDraft(draft.id)!.generation, intent: "wait", actorId: "staff-1" });
    // **`lost`（会話が終わっていた）ではなく `superseded`（この試行が現役でない）。**
    // 会話は終わっていないので、担当者へ「終了していました」と言ってはならない。
    expect(finalized.transition).toBe("superseded");
    expect(confessions.getReplyDraft(draft.id)!.outcome).toBe("unknown");
    expect(confessions.get(row.id)!.reply_deadline_at).toBeNull();
    expect(eventsOf("confession_reply_wait")).toBe(0);
  });

  it("送り直しが始まったあとの古い確定は、会話にも本文にも触れない", () => {
    // 回収（outcome が動く）だけでなく、**世代そのもの**でも止まることを見る。
    // 手動の送り直しは outcome を `sending` に戻すので、世代が無ければ素通りする。
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "本文", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    const stale = confessions.getReplyDraft(draft.id)!.generation;
    confessions.recoverOrphanedEffects("system:startup", afterLease2());
    // 別の担当者が送り直す＝新しい世代が現役になる
    confessions.claimReplyDraftManualRetry(row.id, draft.id, "staff-2");
    expect(confessions.getReplyDraft(draft.id)!.outcome).toBe("sending");

    const late = confessions.finalizeStaffReply({ draftId: draft.id, generation: stale, intent: "wait", actorId: "staff-1" });
    expect(late.transition).toBe("superseded");
    expect(confessions.get(row.id)!.reply_deadline_at).toBeNull();
    expect(confessions.getReplyDraft(draft.id)!.body).toBe("本文");
    expect(confessions.listPendingRenders()).toHaveLength(0);
    expect(eventsOf("confession_reply_wait")).toBe(0);

    // 現役の世代なら通る
    const live = confessions.finalizeStaffReply({
      draftId: draft.id,
      generation: confessions.getReplyDraft(draft.id)!.generation,
      intent: "wait",
      actorId: "staff-2",
    });
    expect(live.transition).toBe("waiting");
    expect(confessions.get(row.id)!.reply_deadline_at).not.toBeNull();
  });

  it("人が畳んだ追記を、あとから帰ってきた中継結果が掘り返さない", () => {
    // **決着していない試行にしか書けない。** ここを緩めると、遅れて帰ってきた結果が
    // `resolved_manually` を `unknown` へ戻し、本文の無い「判断待ち」が永久に残る。
    // 責務が消えないので、その案件のスレッドは二度と畳めなくなる。
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "本文", 90) as { ok: true; followUpId: number };
    const claimed = confessions.claimFollowUpRelay(f.followUpId)!;
    confessions.recoverOrphanedEffects("system:startup", afterLease2());
    confessions.resolveFollowUpManually(row.id, f.followUpId, "staff-1");
    expect(confessions.getFollowUp(f.followUpId)!.outcome).toBe("resolved_manually");
    expect(confessions.obligations(row.id).followUps).toBe(0);

    // ここで、その中継の結果がようやく帰ってくる
    confessions.settleFollowUpRelay({ followUpId: f.followUpId, generation: claimed.generation, outcome: "unknown" });

    const after = confessions.getFollowUp(f.followUpId)!;
    expect(after.outcome).toBe("resolved_manually");
    expect(after.resolved_at).not.toBeNull();
    expect(confessions.obligations(row.id).followUps).toBe(0);

    // 「届いた」で帰ってきても同じ（人が畳んだ事実を配送で塗り替えない）
    confessions.settleFollowUpRelay({ followUpId: f.followUpId, generation: claimed.generation, outcome: "delivered" });
    expect(confessions.getFollowUp(f.followUpId)!.outcome).toBe("resolved_manually");
    expect(confessions.getFollowUp(f.followUpId)!.relayed_at).toBeNull();
  });

  it("回収後に帰ってきた追記の中継結果を受け付けない", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "本文", 90) as { ok: true; followUpId: number };
    const claimed = confessions.claimFollowUpRelay(f.followUpId)!;
    confessions.recoverOrphanedEffects("system:startup", afterLease2());
    expect(confessions.getFollowUp(f.followUpId)!.outcome).toBe("unknown");

    settleFollow(f.followUpId, "delivered", claimed.generation);
    expect(confessions.getFollowUp(f.followUpId)!.outcome).toBe("unknown");
    expect(confessions.getFollowUp(f.followUpId)!.relayed_at).toBeNull();
  });

  // R25: 手動再送の2回目が始まったあとに1回目が帰ってくる
  it("2回目の試行が始まったあと、1回目の結果で上書きしない", () => {
    const row = seed("yes");
    const f = confessions.recordSenderFollowUp(row.id, "sender-1", "本文", 90) as { ok: true; followUpId: number };
    const first = confessions.claimFollowUpRelay(f.followUpId)!;
    settleFollow(f.followUpId, "failed", first.generation);
    const second = confessions.claimFollowUpRelay(f.followUpId)!;
    expect(second.generation).toBeGreaterThan(first.generation);

    // 1回目の callback がいまごろ delivered で帰ってきた
    settleFollow(f.followUpId, "delivered", first.generation);
    expect(confessions.getFollowUp(f.followUpId)!.outcome).toBe("sending"); // 2回目のまま
    expect(confessions.getFollowUp(f.followUpId)!.relayed_at).toBeNull();

    // 2回目の結果は通る
    settleFollow(f.followUpId, "delivered", second.generation);
    expect(confessions.getFollowUp(f.followUpId)!.relayed_at).not.toBeNull();
  });
});

describe("起動時回収は、生きている所有者を奪わない", () => {
  // R26
  it("鼓動が続いている所有者の実行は unknown にしない", () => {
    const row = seed("yes");
    const owner = new Confessions(db, new EventLog(db), "instance-A");
    const begun = owner.beginAcknowledgement(row.id, "staff-1") as { ok: true; attemptId: number };
    expect(begun.ok).toBe(true);

    // 別インスタンスが起動して回収を試みる。A はまだ鼓動している
    const other = new Confessions(db, new EventLog(db), "instance-B");
    owner.heartbeatInstance("instance-A");
    const recovered = other.recoverOrphanedEffects("system:startup");
    expect(recovered.ackAttempts).toBe(0);
    expect(other.ackState(row.id)).toBe("in_flight");

    // A の実行はそのまま完了できる
    owner.settleAcknowledgement(begun.attemptId, "delivered", "staff-1");
    expect(other.get(row.id)!.acknowledged_at).not.toBeNull();
  });

  // R27
  it("鼓動が途絶えた所有者の実行だけを unknown へ収束する", () => {
    const row = seed("yes");
    const owner = new Confessions(db, new EventLog(db), "instance-A");
    owner.beginAcknowledgement(row.id, "staff-1");

    const other = new Confessions(db, new EventLog(db), "instance-B");
    const gone = Math.floor(Date.now() / 1000) + CONFESSION_INSTANCE_LEASE_SECONDS + 1;
    expect(other.recoverOrphanedEffects("system:startup", gone).ackAttempts).toBe(1);
    expect(other.ackState(row.id)).toBe("unknown");
  });

  it("生きている所有者が2つあっても、自分以外の生存を尊重する", () => {
    const row = seed("yes");
    const a = new Confessions(db, new EventLog(db), "instance-A");
    const f = a.recordSenderFollowUp(row.id, "sender-1", "本文", 90) as { ok: true; followUpId: number };
    a.claimFollowUpRelay(f.followUpId);

    const b = new Confessions(db, new EventLog(db), "instance-B");
    a.heartbeatInstance("instance-A");
    expect(b.recoverOrphanedEffects("system:startup").followUps).toBe(0);
    expect(b.getFollowUp(f.followUpId)!.outcome).toBe("sending");
  });
});

describe("会話が終わっても、未処理の内容は残り続ける", () => {
  // B8
  it("投稿者が終了しても、預かった追記は責務として残る", () => {
    const row = confessions.create("sender-1", { type: "soudan", replyWish: "yes", body: "本文" });
    confessions.recordSenderFollowUp(row.id, "sender-1", "終了前に送った追記", 90);
    confessions.senderCloseAtomic(row.id, "sender-1", 90);

    const ob = confessions.obligations(row.id);
    expect(ob.followUps).toBe(1);
    expect(ob.total).toBeGreaterThan(0);
    // 担当者が拾える一覧に出る
    expect(confessions.listClosedWithObligations().map((r) => r.id)).toContain(row.id);
  });

  it("片付いた終了済み案件は責務ゼロ", () => {
    const row = seed("yes");
    confessions.close(row.id, "staff-1", "resolved", 90, "staff");
    expect(confessions.obligations(row.id).total).toBe(0);
    expect(confessions.listClosedWithObligations().map((r) => r.id)).not.toContain(row.id);
  });

  it("緊急対応・未確定の返信・未収束の表示も責務に数える", () => {
    const row = seed("yes");
    confessions.createEmergency({
      confessionId: row.id,
      createdBy: "staff-1",
      reason: "危険",
      target: "対象",
      dangerOngoing: true,
      measures: "watch",
      reviewNote: null,
      note: null,
    });
    const draft = confessions.createReplyDraft(row.id, "staff-1", "本文", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    finishDraft(draft.id, "unknown");

    const ob = confessions.obligations(row.id);
    expect(ob.openEmergency).toBe(true);
    expect(ob.replyDrafts).toBe(1);
    expect(ob.total).toBeGreaterThanOrEqual(2);
  });
});

describe("投稿者に見える最終形は、再起動しても収束する", () => {
  const restartFor = (): Confessions => {
    const reopened = openDb(dbPath);
    reopenedDbs.push(reopened);
    return new Confessions(reopened, new EventLog(reopened));
  };

  // R20 / R21 の core 側
  it("確定と同時に、同じメッセージを直す指示が durable に残る", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "確認しました", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    const finalized = confessions.finalizeStaffReply({ draftId: draft.id, generation: confessions.getReplyDraft(draft.id)!.generation, intent: "wait", actorId: "staff-1",
      retentionDays: 90,
      renderTarget: { channelId: "dm-1", messageId: "msg-1" },
    });
    expect(finalized.transition).toBe("waiting");

    // 編集の前に落ちた、という状況
    const after = restartFor();
    const pending = after.listPendingRenders();
    expect(pending).toHaveLength(1);
    // **行が持つのは宛先だけ。** 見せる中身は収束のたびに現在の案件から導く。
    expect(pending[0]!).toMatchObject({
      confession_id: row.id,
      channel_id: "dm-1",
      message_id: "msg-1",
      state: "pending",
    });
    expect(after.desiredRender(row.id)).toEqual({
      kind: "reply_waiting",
      deadlineAt: finalized.deadlineAt,
      closedBySender: false,
    });
  });

  it("終了で確定したときも、終了の表示へ収束する指示が残る", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "対応しました", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "close");
    confessions.finalizeStaffReply({ draftId: draft.id, generation: confessions.getReplyDraft(draft.id)!.generation, intent: "close", actorId: "staff-1",
      retentionDays: 90,
      renderTarget: { channelId: "dm-1", messageId: "msg-2" },
    });
    expect(confessions.listPendingRenders()).toHaveLength(1);
    expect(confessions.desiredRender(row.id)).toEqual({
      kind: "reply_closed",
      deadlineAt: null,
      closedBySender: false,
    });
  });

  // R22
  it("競合に負けたときは、終了済みの表示へ収束する指示になる", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "行き違い", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    confessions.senderCloseAtomic(row.id, "sender-1", 90);
    const finalized = confessions.finalizeStaffReply({ draftId: draft.id, generation: confessions.getReplyDraft(draft.id)!.generation, intent: "wait", actorId: "staff-1",
      renderTarget: { channelId: "dm-1", messageId: "msg-3" },
    });
    expect(finalized.transition).toBe("lost");
    expect(confessions.listPendingRenders()).toHaveLength(1);
    expect(confessions.desiredRender(row.id)).toEqual({
      kind: "reply_after_close",
      deadlineAt: null,
      closedBySender: true,
    });
  });

  it("収束の所有権は1つだけ。書き換えられなければ担当者から見える形で残る", () => {
    const row = seed("yes");
    const draft = confessions.createReplyDraft(row.id, "staff-1", "本文", 90);
    confessions.claimReplyDraft(draft.id, "staff-1", "wait");
    confessions.finalizeStaffReply({ draftId: draft.id, generation: confessions.getReplyDraft(draft.id)!.generation, intent: "wait", actorId: "staff-1",
      renderTarget: { channelId: "dm-1", messageId: "msg-4" },
    });
    const render = confessions.listPendingRenders()[0]!;
    expect(confessions.claimRender(render.id)).toBeDefined();
    expect(confessions.claimRender(render.id)).toBeUndefined(); // 二重には取れない

    // R23: 明確に書き換えられなかった場合
    confessions.settleRender(render.id, "failed");
    expect(confessions.pendingRendersFor(row.id)).toHaveLength(1);
    expect(confessions.obligations(row.id).pendingRenders).toBe(1);
    // 会話そのものの真実は動かない
    expect(confessions.get(row.id)!.reply_deadline_at).not.toBeNull();

    confessions.settleRender(render.id, "settled");
    expect(confessions.pendingRendersFor(row.id)).toEqual([]);
    expect(confessions.obligations(row.id).pendingRenders).toBe(0);
  });
});
