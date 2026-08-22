import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { CasinoParticipationError, CasinoParticipationHistory } from "../src/casino/participation-history.js";

const BASE = Math.floor(Date.UTC(2026, 7, 20, 0, 0, 0) / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  const history = new CasinoParticipationHistory(db);
  return { db, history };
}

function baseInput(overrides: Partial<Parameters<CasinoParticipationHistory["recordCommittedParticipation"]>[0]> = {}) {
  return {
    participationKey: "solo:blackjack:op-1",
    activityKey: "blackjack" as const,
    participantUserIds: ["alice"],
    ...overrides,
  };
}

describe("A. 1 user / 1 participation正常記録", () => {
  it("正常入力で1回だけ記録される", () => {
    const { db, history } = setup();
    const result = history.recordCommittedParticipation(baseInput());
    expect(result).toEqual({
      participationKey: "solo:blackjack:op-1",
      activityKey: "blackjack",
      participantCount: 1,
      occurredAt: BASE,
      alreadyRecorded: false,
    });
    const rows = db.prepare(`SELECT user_id, activity_key, occurred_at FROM casino_participations`).all();
    expect(rows).toEqual([{ user_id: "alice", activity_key: "blackjack", occurred_at: BASE }]);
  });
});

describe("B. PVP 2 usersを1 call", () => {
  it("同timestamp・2 rows", () => {
    const { db, history } = setup();
    const result = history.recordCommittedParticipation(
      baseInput({ participationKey: "pvp:sess-1", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    expect(result.participantCount).toBe(2);
    const rows = db.prepare(`SELECT user_id, occurred_at FROM casino_participations ORDER BY user_id`).all();
    expect(rows).toEqual([
      { user_id: "alice", occurred_at: BASE },
      { user_id: "bob", occurred_at: BASE },
    ]);
  });
});

describe("C. participant dedupe", () => {
  it("alice,bob,alice → 2 rows(最初のappearance順)", () => {
    const { db, history } = setup();
    const result = history.recordCommittedParticipation(
      baseInput({ participationKey: "pvp:sess-2", activityKey: "indian", participantUserIds: ["alice", "bob", "alice"] }),
    );
    expect(result.participantCount).toBe(2);
    const rows = db.prepare(`SELECT user_id FROM casino_participations ORDER BY user_id`).all();
    expect(rows).toEqual([{ user_id: "alice" }, { user_id: "bob" }]);
  });
});

describe("D. empty participants reject", () => {
  it("空participant listはCasinoParticipationErrorでreject", () => {
    const { history } = setup();
    expect(() => history.recordCommittedParticipation(baseInput({ participantUserIds: [] }))).toThrow(
      CasinoParticipationError,
    );
  });

  it("空白だけのidはfail-closedでreject", () => {
    const { history } = setup();
    expect(() => history.recordCommittedParticipation(baseInput({ participantUserIds: ["alice", "  "] }))).toThrow(
      CasinoParticipationError,
    );
  });
});

describe("E. same key/activity/set → idempotent", () => {
  it("rows増えない、timestamp不変", () => {
    const { db, history } = setup();
    const first = history.recordCommittedParticipation(baseInput());
    vi.setSystemTime(new Date((BASE + 1000) * 1000));
    const second = history.recordCommittedParticipation(baseInput());
    expect(second.alreadyRecorded).toBe(true);
    expect(second.occurredAt).toBe(first.occurredAt);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM casino_participations`).get()).toEqual({ c: 1 });
  });
});

describe("F. participant order change → idempotent", () => {
  it("順序だけ違うroster再送はsame participation扱い", () => {
    const { history } = setup();
    history.recordCommittedParticipation(
      baseInput({ participationKey: "pvp:sess-3", activityKey: "chinchiro", participantUserIds: ["alice", "bob"] }),
    );
    const result = history.recordCommittedParticipation(
      baseInput({ participationKey: "pvp:sess-3", activityKey: "chinchiro", participantUserIds: ["bob", "alice"] }),
    );
    expect(result.alreadyRecorded).toBe(true);
  });
});

describe("G. same key / different activity → conflict", () => {
  it("activityKey違いはCasinoParticipationError(conflict)", () => {
    const { history } = setup();
    history.recordCommittedParticipation(baseInput({ participationKey: "solo:x:op-1", activityKey: "blackjack" }));
    expect(() =>
      history.recordCommittedParticipation(baseInput({ participationKey: "solo:x:op-1", activityKey: "poker" })),
    ).toThrow(/already recorded with a different/);
  });
});

describe("H. same key / participant added/removed → conflict", () => {
  it("participant追加はconflict", () => {
    const { history } = setup();
    history.recordCommittedParticipation(
      baseInput({ participationKey: "pvp:sess-4", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    expect(() =>
      history.recordCommittedParticipation(
        baseInput({ participationKey: "pvp:sess-4", activityKey: "sashi", participantUserIds: ["alice", "bob", "carol"] }),
      ),
    ).toThrow(/already recorded with a different/);
  });

  it("participant削除もconflict", () => {
    const { history } = setup();
    history.recordCommittedParticipation(
      baseInput({ participationKey: "pvp:sess-5", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
    );
    expect(() =>
      history.recordCommittedParticipation(
        baseInput({ participationKey: "pvp:sess-5", activityKey: "sashi", participantUserIds: ["alice"] }),
      ),
    ).toThrow(/already recorded with a different/);
  });

  it("conflictでは既存rowを上書きしない", () => {
    const { db, history } = setup();
    history.recordCommittedParticipation(baseInput({ participationKey: "solo:x:op-2", activityKey: "blackjack" }));
    try {
      history.recordCommittedParticipation(baseInput({ participationKey: "solo:x:op-2", activityKey: "poker" }));
    } catch {
      // expected
    }
    const row = db.prepare(`SELECT activity_key FROM casino_participations WHERE participation_key = ?`).get("solo:x:op-2") as {
      activity_key: string;
    };
    expect(row.activity_key).toBe("blackjack");
  });
});

describe("I. forced second participant INSERT failure → all rollback", () => {
  it("triggerで2人目のINSERTを失敗させると全rollback", () => {
    const { db, history } = setup();
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS block_bob_participation
      BEFORE INSERT ON casino_participations
      WHEN NEW.user_id = 'bob'
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure for bob');
      END;
    `);
    expect(() =>
      history.recordCommittedParticipation(
        baseInput({ participationKey: "pvp:sess-6", activityKey: "sashi", participantUserIds: ["alice", "bob"] }),
      ),
    ).toThrow(/simulated failure for bob/);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM casino_participations`).get()).toEqual({ c: 0 });
  });
});

describe("J. caller timestampを渡せない", () => {
  it("service clockのみが正本——inputにoccurredAt/timestampフィールドが存在しない", () => {
    const { history } = setup();
    const result = history.recordCommittedParticipation(baseInput());
    expect(result.occurredAt).toBe(BASE);
    // 型レベルでもRecordCommittedParticipationInputにoccurredAt等は存在しない
    // （baseInput()のoverridesにcallerがoccurredAtを混ぜようとしてもコンパイルできない設計）
  });
});

describe("K. unknown activity key reject", () => {
  it("allowlist外のactivityKeyはCasinoParticipationErrorでreject", () => {
    const { history } = setup();
    expect(() =>
      history.recordCommittedParticipation(baseInput({ activityKey: "future_unknown_game" as never })),
    ).toThrow(CasinoParticipationError);
  });
});

describe("L. stored columnsにwager/payout/net/result/opponent等が存在しない", () => {
  it("casino_participationsのカラムはparticipation_key/user_id/activity_key/occurred_atだけ", () => {
    const { db, history } = setup();
    history.recordCommittedParticipation(baseInput());
    const columns = (db.prepare(`PRAGMA table_info(casino_participations)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns.sort()).toEqual(["activity_key", "occurred_at", "participation_key", "user_id"]);
  });
});
