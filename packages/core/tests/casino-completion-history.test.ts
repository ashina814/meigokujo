import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { CasinoParticipationError, CasinoParticipationHistory } from "../src/casino/participation-history.js";

/**
 * PR F2b: `recordCompletedParticipation()`（`casino_participation_completions`）の
 * persistence test。既存`recordCommittedParticipation()`（`casino_participations`）
 * のsemantics/schema/occurred_atは一切変更していない——このfileは新規APIだけを
 * 対象にする。
 */

const BASE = Math.floor(Date.UTC(2026, 7, 20, 0, 0, 0) / 1000);

function setup() {
  const db = openDb(":memory:");
  let clock = BASE;
  const history = new CasinoParticipationHistory(db, () => clock);
  const setClock = (t: number) => {
    clock = t;
  };
  return { db, history, setClock };
}

function commitInput(overrides: Partial<Parameters<CasinoParticipationHistory["recordCommittedParticipation"]>[0]> = {}) {
  return {
    participationKey: "solo:blackjack:op-1",
    activityKey: "blackjack" as const,
    participantUserIds: ["alice"],
    ...overrides,
  };
}

function completeInput(overrides: Partial<Parameters<CasinoParticipationHistory["recordCompletedParticipation"]>[0]> = {}) {
  return {
    participationKey: "solo:blackjack:op-1",
    activityKey: "blackjack" as const,
    participantUserIds: ["alice"],
    ...overrides,
  };
}

describe("A. commitment無しcompletion → reject", () => {
  it("participationKeyに対応するcasino_participations行が無ければmissing_commitmentでreject", () => {
    const { history } = setup();
    let caught: unknown;
    try {
      history.recordCompletedParticipation(completeInput());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CasinoParticipationError);
    expect((caught as CasinoParticipationError).code).toBe("missing_commitment");
  });
});

describe("B. normal single-user completion", () => {
  it("commitment後、completionが1件記録される", () => {
    const { db, history, setClock } = setup();
    history.recordCommittedParticipation(commitInput());
    setClock(BASE + 10);
    const result = history.recordCompletedParticipation(completeInput());
    expect(result).toEqual({
      participationKey: "solo:blackjack:op-1",
      activityKey: "blackjack",
      participantCount: 1,
      completedAt: BASE + 10,
      alreadyRecorded: false,
    });
    const rows = db.prepare(`SELECT user_id, completed_at FROM casino_participation_completions`).all();
    expect(rows).toEqual([{ user_id: "alice", completed_at: BASE + 10 }]);
  });
});

describe("C. multi-user completion atomic", () => {
  it("PVP 2usersのcommitment後、completionも同timestampで2件記録される", () => {
    const { db, history, setClock } = setup();
    history.recordCommittedParticipation(
      commitInput({ participationKey: "pvp:sess-1", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    setClock(BASE + 20);
    const result = history.recordCompletedParticipation(
      completeInput({ participationKey: "pvp:sess-1", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    expect(result.participantCount).toBe(2);
    const rows = db
      .prepare(`SELECT user_id, completed_at FROM casino_participation_completions ORDER BY user_id`)
      .all();
    expect(rows).toEqual([
      { user_id: "alice", completed_at: BASE + 20 },
      { user_id: "bob", completed_at: BASE + 20 },
    ]);
  });
});

describe("D. identical retry idempotent、completed_at不変", () => {
  it("同一入力の再送はalreadyRecorded:true、completed_atは最初の値を維持", () => {
    const { history, setClock } = setup();
    history.recordCommittedParticipation(commitInput());
    setClock(BASE + 5);
    const first = history.recordCompletedParticipation(completeInput());
    expect(first.alreadyRecorded).toBe(false);

    setClock(BASE + 999);
    const second = history.recordCompletedParticipation(completeInput());
    expect(second.alreadyRecorded).toBe(true);
    expect(second.completedAt).toBe(first.completedAt);
    expect(second.completedAt).toBe(BASE + 5);
  });
});

describe("E. activity mismatch conflict", () => {
  it("commitmentと異なるactivityKeyのcompletionはconflict", () => {
    const { history } = setup();
    history.recordCommittedParticipation(commitInput());
    expect(() => history.recordCompletedParticipation(completeInput({ activityKey: "poker" }))).toThrow(
      CasinoParticipationError,
    );
    try {
      history.recordCompletedParticipation(completeInput({ activityKey: "poker" }));
    } catch (e) {
      expect((e as CasinoParticipationError).code).toBe("conflict");
    }
  });
});

describe("F. participant-set mismatch conflict", () => {
  it("commitmentと異なるparticipant setのcompletionはconflict", () => {
    const { history } = setup();
    history.recordCommittedParticipation(
      commitInput({ participationKey: "pvp:sess-2", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    expect(() =>
      history.recordCompletedParticipation(
        completeInput({ participationKey: "pvp:sess-2", activityKey: "sashi", participantUserIds: ["alice"] }),
      ),
    ).toThrow(CasinoParticipationError);
  });

  it("commitmentに存在しないuserを含むcompletionもconflict", () => {
    const { history } = setup();
    history.recordCommittedParticipation(commitInput());
    expect(() =>
      history.recordCompletedParticipation(completeInput({ participantUserIds: ["alice", "mallory"] })),
    ).toThrow(CasinoParticipationError);
  });
});

describe("G. partial/corrupt existing completion rows fail-closed", () => {
  it("completion行が一部だけ存在する(corruption想定)場合、idempotent扱いせずconflict", () => {
    const { db, history } = setup();
    history.recordCommittedParticipation(
      commitInput({ participationKey: "pvp:sess-3", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    // recordCompletedParticipation()のAPIを経由せず直接INSERTしてDB corruptionを再現する
    // ——aliceだけcompletion済みという通常経路では発生し得ない状態。
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("pvp:sess-3", "alice", BASE);

    expect(() =>
      history.recordCompletedParticipation(
        completeInput({ participationKey: "pvp:sess-3", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
      ),
    ).toThrow(CasinoParticipationError);
  });

  it("completion行のcompleted_atが割れている(corruption想定)場合もconflict", () => {
    const { db, history } = setup();
    history.recordCommittedParticipation(
      commitInput({ participationKey: "pvp:sess-4", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("pvp:sess-4", "alice", BASE);
    db.prepare(
      `INSERT INTO casino_participation_completions (participation_key, user_id, completed_at) VALUES (?, ?, ?)`,
    ).run("pvp:sess-4", "bob", BASE + 999);

    expect(() =>
      history.recordCompletedParticipation(
        completeInput({ participationKey: "pvp:sess-4", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
      ),
    ).toThrow(CasinoParticipationError);
  });
});

describe("H. completed_at < occurred_at reject", () => {
  it("completed_atがcommitment occurred_atより前になる場合reject", () => {
    const { history, setClock } = setup();
    setClock(BASE + 100);
    history.recordCommittedParticipation(commitInput());
    setClock(BASE + 50); // 巻き戻るclockという異常ケース
    let caught: unknown;
    try {
      history.recordCompletedParticipation(completeInput());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CasinoParticipationError);
    expect((caught as CasinoParticipationError).code).toBe("completed_before_committed");
  });

  it("completed_at === occurred_at（同秒）は許可される", () => {
    const { history, setClock } = setup();
    setClock(BASE + 100);
    history.recordCommittedParticipation(commitInput());
    // clockは進めない——同秒でのcompletionもrejectしない
    const result = history.recordCompletedParticipation(completeInput());
    expect(result.completedAt).toBe(BASE + 100);
  });
});

describe("I. caller timestamp注入不可", () => {
  it("service clockのみが正本——RecordCompletedParticipationInputにcompletedAt等のtimestampフィールドが存在しない", () => {
    const { history, setClock } = setup();
    history.recordCommittedParticipation(commitInput());
    setClock(BASE + 42);
    const result = history.recordCompletedParticipation(completeInput());
    expect(result.completedAt).toBe(BASE + 42);
    // 型レベルでもRecordCompletedParticipationInputにcompletedAt等は存在しない
    // （completeInput()のoverridesにcallerがcompletedAtを混ぜようとしてもコンパイルできない設計）
  });
});

describe("J. completion insert途中失敗 → 全participant rollback", () => {
  it("triggerで2人目のcompletion INSERTを失敗させると全rollback", () => {
    const { db, history } = setup();
    history.recordCommittedParticipation(
      commitInput({ participationKey: "pvp:sess-5", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS block_bob_completion
      BEFORE INSERT ON casino_participation_completions
      WHEN NEW.user_id = 'bob'
      BEGIN
        SELECT RAISE(ABORT, 'simulated completion failure for bob');
      END;
    `);
    expect(() =>
      history.recordCompletedParticipation(
        completeInput({ participationKey: "pvp:sess-5", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
      ),
    ).toThrow(/simulated completion failure for bob/);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM casino_participation_completions`).get()).toEqual({ c: 0 });
  });
});

describe("K. commitment rowはcompletion時にUPDATEされない", () => {
  it("completion記録後もcasino_participationsの内容は不変", () => {
    const { db, history, setClock } = setup();
    history.recordCommittedParticipation(commitInput());
    const before = db.prepare(`SELECT * FROM casino_participations`).all();
    setClock(BASE + 10);
    history.recordCompletedParticipation(completeInput());
    const after = db.prepare(`SELECT * FROM casino_participations`).all();
    expect(after).toEqual(before);
  });
});

describe("stored columnsにwager/payout/result/winner/loser等が存在しない", () => {
  it("casino_participation_completionsのカラムはparticipation_key/user_id/completed_atだけ", () => {
    const { db, history } = setup();
    history.recordCommittedParticipation(commitInput());
    history.recordCompletedParticipation(completeInput());
    const columns = (db.prepare(`PRAGMA table_info(casino_participation_completions)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns.sort()).toEqual(["completed_at", "participation_key", "user_id"]);
  });
});

describe("unknown activity keyはreject（既存assertActivityKeyの共有）", () => {
  it("allowlist外のactivityKeyはCasinoParticipationErrorでreject", () => {
    const { history } = setup();
    history.recordCommittedParticipation(commitInput());
    expect(() =>
      history.recordCompletedParticipation(completeInput({ activityKey: "future_unknown_game" as never })),
    ).toThrow(CasinoParticipationError);
  });
});
