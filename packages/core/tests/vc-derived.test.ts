import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { VcTracker } from "../src/vc/service.js";
import {
  computeCoPresenceOverlaps,
  computeEmptyStartThenJoined,
  computeGroupSizeSeconds,
  computeLastOccupant,
  computeLogicalVisits,
  computeSafeSocialAggregates,
  isTrustedVisitEnd,
} from "../src/vc/derived.js";

afterEach(() => vi.useRealTimers());

/** JST 2026-08-20 00:00:00 を秒0とする、テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);

function setup() {
  const db = openDb(":memory:");
  const insertRaw = (
    userId: string,
    channelId: string,
    startedAt: number,
    endedAt: number | null,
    endQuality: "observed" | "recovered_estimate" | null,
    parentId: string | null = null,
  ) =>
    db
      .prepare(
        `INSERT INTO vc_segments (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(userId, channelId, parentId, startedAt, endedAt, endQuality);
  return { db, insertRaw };
}

describe("A. logical visit の合成", () => {
  it("mute変更で3 raw segmentになっても1 logical visitへ合成される", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date((BASE + 0) * 1000));
    vc.open("alice", "vc1", "cat1", false, false);
    vi.setSystemTime(new Date((BASE + 10) * 1000));
    vc.open("alice", "vc1", "cat1", true, false); // mute変更
    vi.setSystemTime(new Date((BASE + 20) * 1000));
    vc.open("alice", "vc1", "cat1", true, true); // deafen変更
    vi.setSystemTime(new Date((BASE + 30) * 1000));
    vc.close("alice");

    const rawCount = db.prepare("SELECT COUNT(*) AS n FROM vc_segments WHERE user_id='alice'").get() as { n: number };
    expect(rawCount.n).toBe(3);

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits).toEqual([
      {
        userId: "alice",
        channelId: "vc1",
        parentId: "cat1",
        startedAt: BASE + 0,
        endedAt: BASE + 30,
        endQuality: "observed",
        segmentCount: 3,
        startClipped: false,
      },
    ]);
  });

  it("チャンネル移動は別visitになる", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 10, "observed");
    insertRaw("alice", "vc2", BASE + 10, BASE + 20, "observed");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits.map((v) => [v.channelId, v.startedAt, v.endedAt])).toEqual([
      ["vc1", BASE, BASE + 10],
      ["vc2", BASE + 10, BASE + 20],
    ]);
  });

  it("退出→再入室（同じチャンネルでも間が空く）は別visitになる", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 10, "observed");
    insertRaw("alice", "vc1", BASE + 20, BASE + 30, "observed"); // 10〜20の間は退出していた
    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits.map((v) => [v.startedAt, v.endedAt])).toEqual([
      [BASE, BASE + 10],
      [BASE + 20, BASE + 30],
    ]);
  });

  it("通常のclose()はend_quality=observedを記録する", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE * 1000));
    vc.open("alice", "vc1", null, false, false);
    vi.setSystemTime(new Date((BASE + 10) * 1000));
    vc.close("alice");
    const row = db.prepare("SELECT end_quality FROM vc_segments WHERE user_id='alice'").get() as {
      end_quality: string;
    };
    expect(row.end_quality).toBe("observed");
  });

  it("closeAllDangling()はend_quality=recovered_estimateを記録する", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE * 1000));
    vc.open("alice", "vc1", null, false, false);
    vi.setSystemTime(new Date((BASE + 4 * 3600) * 1000)); // 4時間後、closeせずbotがクラッシュした想定
    vc.closeAllDangling();
    const row = db.prepare("SELECT ended_at, end_quality FROM vc_segments WHERE user_id='alice'").get() as {
      ended_at: number;
      end_quality: string;
    };
    expect(row.end_quality).toBe("recovered_estimate");
    expect(row.ended_at).toBe(BASE + 4 * 3600);
  });

  it("legacy行（end_quality未設定でclosed）はtrusted扱いしない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 10, null); // 列追加前のlegacy行を模す
    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits[0]!.endQuality).toBe("unknown");
    expect(isTrustedVisitEnd(visits[0]!.endQuality)).toBe(false);
  });
});

describe("B/F. co-presence", () => {
  it("segment分割（mute変更）で重なり秒数を二重加算しない", () => {
    const { db, insertRaw } = setup();
    // aliceはmute変更で3 raw segmentに分かれているが、在室していたのは0〜100の1本
    insertRaw("alice", "vc1", BASE, BASE + 30, "observed");
    insertRaw("alice", "vc1", BASE + 30, BASE + 60, "observed");
    insertRaw("alice", "vc1", BASE + 60, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE, BASE + 100, "observed");

    const overlaps = computeCoPresenceOverlaps(db, { start: BASE, end: BASE + 200 });
    expect(overlaps).toEqual([{ userA: "alice", userB: "bob", overlapSeconds: 100, jstDays: expect.any(Array) }]);
  });

  it("pair identityをsafe aggregate APIから返さない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE, BASE + 100, "observed");

    const aggregates = computeSafeSocialAggregates(db, { start: BASE, end: BASE + 200 });
    const alice = aggregates.find((a) => a.userId === "alice")!;
    expect(alice.distinctCoPresentUsers).toBe(1);
    expect(alice.trustedOverlapSeconds).toBe(100);
    // 相手のuserId("bob")が値のどこにも出てこないことを構造的に確認する
    expect(JSON.stringify(alice)).not.toContain("bob");
  });

  it("JST日境界をまたぐ重なりはdistinct 2日として数える", () => {
    const { db, insertRaw } = setup();
    // JST 23:50 開始 → 翌日 00:10 終了（20分）
    const jstMidnightUtcSec = Date.UTC(2026, 7, 19, 15, 0, 0) / 1000; // 2026-08-20 00:00 JST
    const start = jstMidnightUtcSec - 10 * 60; // 08-19 23:50 JST
    const end = jstMidnightUtcSec + 10 * 60; // 08-20 00:10 JST
    insertRaw("alice", "vc1", start, end, "observed");
    insertRaw("bob", "vc1", start, end, "observed");

    const overlaps = computeCoPresenceOverlaps(db, { start: start - 100, end: end + 100 });
    expect(overlaps[0]!.jstDays).toEqual(["2026-08-19", "2026-08-20"]);
  });
});

describe("C. empty-start → later joined", () => {
  it("誰もいないVCへ入り、別の時刻に誰かが来たら成立する", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([{ userId: "alice", channelId: "vc1", visitStartedAt: BASE, joinedAt: BASE + 50 }]);
  });

  it("同一秒に2人がstartしたら、どちらにもfactを付けない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE, BASE + 100, "observed"); // 完全に同時start

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("window開始前から継続していた訪問は開始イベントとして扱わない", () => {
    const { db, insertRaw } = setup();
    // aliceの本当の入室はwindowの外（BASE-1000）。windowはBASEから。
    insertRaw("alice", "vc1", BASE - 1000, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    // aliceの開始はclipされただけの偽イベントなので、bobが後から来てもfactにしない
    expect(facts).toEqual([]);
  });

  it("subjectの終了が信頼できない場合はfactにしない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "recovered_estimate");
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });
});

describe("D. last occupant", () => {
  it("occupancyが2から1に減り、subjectだけが残ったら成立する", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE + 10, BASE + 50, "observed"); // bobが50で退出

    const facts = computeLastOccupant(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([{ userId: "alice", channelId: "vc1", becameLastAt: BASE + 50 }]);
  });

  it("最初から1人きりの訪問はfactにしない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");

    const facts = computeLastOccupant(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("同一秒に複数が退出するtieでは、subject自身の終了と重なる場合は断定しない", () => {
    const { db, insertRaw } = setup();
    // alice, bobが同じ瞬間(BASE+50)に退出する。どちらも「相手が抜けて自分が最後」を主張できない
    insertRaw("alice", "vc1", BASE, BASE + 50, "observed");
    insertRaw("bob", "vc1", BASE, BASE + 50, "observed");

    const facts = computeLastOccupant(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("退出した他者の終了が信頼できない場合は断定しない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE + 10, BASE + 50, "recovered_estimate"); // 本当の退出時刻は不明

    const facts = computeLastOccupant(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("信頼できない終了を持つ第三者が居るかもしれない場合も断定しない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE + 10, BASE + 50, "observed"); // bobは50できれいに退出
    // carolは本当は50時点でまだ居たかもしれない（終了が推定値で不確か）
    insertRaw("carol", "vc1", BASE + 5, BASE + 60, "recovered_estimate");

    const facts = computeLastOccupant(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });
});

describe("E. group-size seconds", () => {
  it("solo/1:1/小人数/大人数の帯ごとに秒数を積算する", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 40, "observed"); // aliceは0-40ずっと在室
    insertRaw("p1", "vc1", BASE + 10, BASE + 20, "observed"); // 10-20: alice+p1 = 1:1
    insertRaw("p2", "vc1", BASE + 20, BASE + 30, "observed"); // 20-30: alice+p2+p3 = 3人
    insertRaw("p3", "vc1", BASE + 20, BASE + 30, "observed");
    insertRaw("p4", "vc1", BASE + 30, BASE + 40, "observed"); // 30-40: alice+p4..p7 = 5人
    insertRaw("p5", "vc1", BASE + 30, BASE + 40, "observed");
    insertRaw("p6", "vc1", BASE + 30, BASE + 40, "observed");
    insertRaw("p7", "vc1", BASE + 30, BASE + 40, "observed");

    const result = computeGroupSizeSeconds(db, { start: BASE, end: BASE + 100 }, ["alice"]);
    const alice = result.find((r) => r.userId === "alice")!;
    expect(alice.trustedSecondsByBucket).toEqual({
      solo: 10, // 0-10
      oneToOne: 10, // 10-20
      smallGroup: 10, // 20-30 (3人)
      largeGroup: 10, // 30-40 (5人)
    });
    expect(alice.untrustedSeconds).toBe(0);
  });

  it("recovered_estimate/unknown区間はtrusted secondsへ混ぜない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 30, "observed");
    insertRaw("alice", "vc2", BASE + 100, BASE + 150, "recovered_estimate");

    const result = computeGroupSizeSeconds(db, { start: BASE, end: BASE + 200 }, ["alice"]);
    const alice = result.find((r) => r.userId === "alice")!;
    const trustedTotal = Object.values(alice.trustedSecondsByBucket).reduce((a, b) => a + b, 0);
    expect(trustedTotal).toBe(30);
    expect(alice.untrustedSeconds).toBe(50);
  });
});

describe("window semantics [start, end)", () => {
  it("windowの外側はclipされ、endは排他的境界になる", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE - 50, BASE + 150, "observed");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.startedAt).toBe(BASE);
    expect(visits[0]!.endedAt).toBe(BASE + 100);
    expect(visits[0]!.startClipped).toBe(true);
  });

  it("window.endちょうどに開始したsegmentは含まれない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE + 100, BASE + 200, "observed");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits).toEqual([]);
  });

  it("不正なwindow（start>=end）はエラーにする", () => {
    const db = openDb(":memory:");
    expect(() => computeLogicalVisits(db, { start: 100, end: 100 })).toThrow(/invalid title window/);
    expect(() => computeLogicalVisits(db, { start: 200, end: 100 })).toThrow(/invalid title window/);
  });
});
