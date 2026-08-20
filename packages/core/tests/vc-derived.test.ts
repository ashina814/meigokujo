import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** JST 2026-08-20 00:00:00 を秒0とする、テスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);

// derived.ts の各exported関数はobservedAt省略時にDate.now()をデフォルトとして使う。
// これがテスト実行時の実際の壁時計時刻へ依存すると、BASE（今日基準の定数）に近い
// window.endを使うテストが実行タイミングによって化ける（flakeになる）。
// ここでBASEより十分先（かつ後述の「100年超」テストの範囲よりは手前）へ固定し、
// テストごとに個別のvi.setSystemTime()で上書きできるようにする。
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((BASE + 500_000) * 1000));
});
afterEach(() => vi.useRealTimers());

function setup() {
  const db = openDb(":memory:");
  const insertRaw = (
    userId: string,
    channelId: string,
    startedAt: number,
    endedAt: number | null,
    endQuality: "observed" | "recovered_estimate" | null,
    parentId: string | null = null,
    startReason: "join" | "move" | "state_change" | null = null,
  ) =>
    db
      .prepare(
        `INSERT INTO vc_segments (user_id, channel_id, parent_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(userId, channelId, parentId, startedAt, endedAt, endQuality, startReason);
  return { db, insertRaw };
}

describe("A. logical visit の合成", () => {
  it("mute変更で3 raw segmentになっても1 logical visitへ合成される", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date((BASE + 0) * 1000));
    vc.open("alice", "vc1", "cat1", false, false, "join");
    vi.setSystemTime(new Date((BASE + 10) * 1000));
    vc.open("alice", "vc1", "cat1", true, false, "state_change"); // mute変更
    vi.setSystemTime(new Date((BASE + 20) * 1000));
    vc.open("alice", "vc1", "cat1", true, true, "state_change"); // deafen変更
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
        startKind: "arrival",
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
    vc.open("alice", "vc1", null, false, false, "join");
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
    vc.open("alice", "vc1", null, false, false, "join");
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

  it("同一秒の退出→再入室は、reasonがjoinなら時刻が一致しても1 visitへ合成しない", () => {
    const { db, insertRaw } = setup();
    // aliceはBASE+10にvisit1をobservedで終え、全く同じ秒に再入室(join)している。
    // 時刻だけを見るとmute変更による分割と区別がつかないが、start_reasonが'join'
    // （切断を経た新規入室）なので継続とみなしてはいけない。
    insertRaw("alice", "vc1", BASE, BASE + 10, "observed", null, "join");
    insertRaw("alice", "vc1", BASE + 10, BASE + 20, "observed", null, "join");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits.map((v) => [v.startedAt, v.endedAt])).toEqual([
      [BASE, BASE + 10],
      [BASE + 10, BASE + 20],
    ]);
  });

  it("直前segmentがrecovered_estimateで終わっている場合、次がstate_changeでも合成しない（推定区間の洗浄防止）", () => {
    const { db, insertRaw } = setup();
    // クラッシュ復旧の推定終了(recovered_estimate)の直後、mute変更(state_change)が
    // 偶然同じ秒で起きた場合でも、推定区間を含んだままobservedへ格上げしてはいけない。
    insertRaw("alice", "vc1", BASE, BASE + 10, "recovered_estimate", null, "join");
    insertRaw("alice", "vc1", BASE + 10, BASE + 20, "observed", null, "state_change");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits.map((v) => [v.startedAt, v.endedAt, v.endQuality])).toEqual([
      [BASE, BASE + 10, "recovered_estimate"],
      [BASE + 10, BASE + 20, "observed"],
    ]);
  });

  it("state_changeかつ直前がobservedのときだけ合成する（正常系の再確認）", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 10, "observed", null, "join");
    insertRaw("alice", "vc1", BASE + 10, BASE + 20, "observed", null, "state_change");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100 });
    expect(visits).toEqual([
      {
        userId: "alice",
        channelId: "vc1",
        parentId: null,
        startedAt: BASE,
        endedAt: BASE + 20,
        endQuality: "observed",
        segmentCount: 2,
        startClipped: false,
        startKind: "arrival",
      },
    ]);
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
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed", null, "join");
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed", null, "join");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([{ userId: "alice", channelId: "vc1", visitStartedAt: BASE, joinedAt: BASE + 50 }]);
  });

  it("同一秒に2人がstartしたら、どちらにもfactを付けない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed", null, "join");
    insertRaw("bob", "vc1", BASE, BASE + 100, "observed", null, "join"); // 完全に同時start

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("window開始前から継続していた訪問は開始イベントとして扱わない", () => {
    const { db, insertRaw } = setup();
    // aliceの本当の入室はwindowの外（BASE-1000）。windowはBASEから。
    insertRaw("alice", "vc1", BASE - 1000, BASE + 100, "observed", null, "join");
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed", null, "join");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    // aliceの開始はclipされただけの偽イベントなので、bobが後から来てもfactにしない
    expect(facts).toEqual([]);
  });

  it("subjectの終了が信頼できない場合はfactにしない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "recovered_estimate", null, "join");
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed", null, "join");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("先行者の終了が信頼できない場合、記録上先に退出していても『空だった』と断定しない", () => {
    const { db, insertRaw } = setup();
    // bobは記録上BASE+10に退出しているが、終了がrecovered_estimateで不確か。
    // aliceがBASE+30に入室した時点で、bobが本当にもう居なかったとは証明できない。
    insertRaw("bob", "vc1", BASE - 100, BASE + 10, "recovered_estimate");
    insertRaw("alice", "vc1", BASE + 30, BASE + 130, "observed", null, "join");
    insertRaw("carol", "vc1", BASE + 60, BASE + 90, "observed", null, "join");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("孤立したstate_change（既に在室していただけ）は入室イベントとして扱わない", () => {
    const { db, insertRaw } = setup();
    // aliceは本当は空VCへ入室(join)している。
    insertRaw("alice", "vc1", BASE, BASE + 200, "observed", null, "join");
    // bobは実は前からそこにいたが、記録上はクラッシュ補正で切れており、
    // BASE+50時点のmute変更(state_change)がbobについて観測できた最初の行になっている。
    // これは「BASE+50に入室してきた」わけではない——孤立state_changeなのでarrivalではない。
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed", null, "state_change");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("subject自身の開始が孤立state_changeの場合もfactにしない", () => {
    const { db, insertRaw } = setup();
    // aliceは本当は前からそこにいたが、観測できた最初の行がstate_change。
    // 「BASEに空VCへ入室した」わけではないので、開始イベントとして使えない。
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed", null, "state_change");
    insertRaw("bob", "vc1", BASE + 50, BASE + 80, "observed", null, "join");

    const facts = computeEmptyStartThenJoined(db, { start: BASE, end: BASE + 200 });
    expect(facts).toEqual([]);
  });

  it("0秒segmentもarrival証拠として保持し、同一秒tieを安全側へ倒す", () => {
    const { db, insertRaw } = setup();
    // bobはBASE時点に一瞬だけ現れて即退出（0秒）。aliceも同じBASEに入室。
    // 順序を証明できないので、aliceの「空VCから始めた」は成立させない。
    insertRaw("bob", "vc1", BASE, BASE, "observed", null, "join");
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed", null, "join");
    insertRaw("carol", "vc1", BASE + 50, BASE + 80, "observed", null, "join");

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

  it("同室者の終了が信頼できない場合、その時点以降はtrustedSecondsByBucketではなくuntrustedSecondsへ計上する", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed"); // aliceは0-100ずっと在室（終了は信頼できる）
    // bobの退出(記録上40)はrecovered_estimateで不確か。本当は40より後まで居たかもしれない。
    insertRaw("bob", "vc1", BASE + 10, BASE + 40, "recovered_estimate");

    const result = computeGroupSizeSeconds(db, { start: BASE, end: BASE + 200 }, ["alice"]);
    const alice = result.find((r) => r.userId === "alice")!;
    // 0-10: alice単独。bobが現れる前なので人数帯は確実にsolo。
    // 10以降: bobの本当の退出時刻が不明なので、以降ずっと「本当は何人だったか」を
    // trustedとは主張できない。
    expect(alice.trustedSecondsByBucket).toEqual({ solo: 10, oneToOne: 0, smallGroup: 0, largeGroup: 0 });
    expect(alice.untrustedSeconds).toBe(90);
  });
});

describe("userIds filterの契約: undefined=全員、[]=対象なし", () => {
  it("userIds=[]（空配列）は『絞り込みなし』ではなく『対象なし』を意味する", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 200 }, []);
    expect(visits).toEqual([]);
  });

  it("userIds未指定(undefined)は従来通り全員を対象にする", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 200 }, undefined);
    expect(visits).toHaveLength(1);
  });

  it("computeSafeSocialAggregatesはuserIds指定時、指定ユーザー以外の不完全な行を返さない", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");
    insertRaw("bob", "vc1", BASE, BASE + 100, "observed");

    // aliceだけを指定しても、内部的にはbobとの重なりが見つかるため touch() はbob側にも働く。
    // しかしbobの集計はalice分しか反映していない不完全なものなので、返り値には含めない。
    const aggregates = computeSafeSocialAggregates(db, { start: BASE, end: BASE + 200 }, ["alice"]);
    expect(aggregates.map((a) => a.userId)).toEqual(["alice"]);
  });

  it("computeSafeSocialAggregatesにuserIds=[]を渡すと空配列を返す", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, BASE + 100, "observed");

    const aggregates = computeSafeSocialAggregates(db, { start: BASE, end: BASE + 200 }, []);
    expect(aggregates).toEqual([]);
  });
});

describe("jstDatesInIntervalの安全策", () => {
  it("非常に長い区間（100年超）は黙って打ち切らず例外にする", () => {
    const { db, insertRaw } = setup();
    const start = BASE;
    const end = BASE + 200 * 365 * 86_400; // 約200年
    insertRaw("alice", "vc1", start, end, "observed");
    insertRaw("bob", "vc1", start, end, "observed");

    // observedAtを明示してwindow.end全体を「実際に見た」ことにする——省略時はDate.now()が
    // デフォルトになり、この200年区間全体を評価する前提が崩れてしまう。
    expect(() =>
      computeCoPresenceOverlaps(db, { start: start - 10, end: end + 10, observedAt: end + 10 }),
    ).toThrow(/more than/);
  });
});

describe("open visitの未来window clamp", () => {
  it("window.endが未来でも、open visitはobservedAt（既定=現在時刻）より先までtrustedにしない", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE * 1000));
    vc.open("alice", "vc1", null, false, false, "join"); // 今もまだ在室中（未クローズ）

    vi.setSystemTime(new Date((BASE + 500) * 1000)); // 「現在時刻」はBASE+500

    // window.endはさらに先の未来（「今月」「今日」等のカタログ境界を模す）
    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100_000 });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.endedAt).toBe(BASE + 500); // window.endではなく「今」で打ち切られる
    expect(visits[0]!.endQuality).toBe("open");
  });

  it("observedAtを明示すれば、その時刻でクランプされる（reconcileの再現性）", () => {
    const { db, insertRaw } = setup();
    insertRaw("alice", "vc1", BASE, null, null, null, "join"); // まだ開いている訪問

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 100_000, observedAt: BASE + 40 });
    expect(visits).toHaveLength(1);
    expect(visits[0]!.endedAt).toBe(BASE + 40);
  });

  it("2人ともopen visitでも、window.endの未来分をco-presenceの重なりとして数えない", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE * 1000));
    vc.open("alice", "vc1", null, false, false, "join");
    vc.open("bob", "vc1", null, false, false, "join");

    vi.setSystemTime(new Date((BASE + 300) * 1000)); // 「現在」はBASE+300

    const overlaps = computeCoPresenceOverlaps(db, { start: BASE, end: BASE + 100_000 });
    expect(overlaps).toEqual([{ userA: "alice", userB: "bob", overlapSeconds: 300, jstDays: expect.any(Array) }]);
  });

  it("observedAtより後に開始した行は、クエリの読み込み段階から一切見えない", () => {
    const { db, insertRaw } = setup();
    const observedAt = BASE + 100;
    insertRaw("alice", "vc1", BASE, BASE + 150, "observed", null, "join");
    // bobの入室(120)はobservedAt(100)より後——12:00時点ではまだ起きていなかった出来事
    insertRaw("bob", "vc1", BASE + 120, BASE + 140, "observed", null, "join");

    const visits = computeLogicalVisits(db, { start: BASE, end: BASE + 1000, observedAt });
    expect(visits).toEqual([
      expect.objectContaining({ userId: "alice", startedAt: BASE, endedAt: observedAt, endQuality: "open" }),
    ]);
    // bobはalice側のfactからも見えない（empty-start-then-joinedのlaterJoin候補にもならない）
    expect(visits.some((v) => v.userId === "bob")).toBe(false);
  });

  it("同じobservedAtで再評価すれば、後からDB状態が進んでも結果が変わらない（reconcileの再現性）", () => {
    const { db, insertRaw } = setup();
    const observedAt = BASE + 100;
    const window = { start: BASE, end: BASE + 1000, observedAt };

    // 12:00時点で評価: aliceはまだ開いている（実際にはこの後12:30に退出する）
    insertRaw("alice", "vc1", BASE, null, null, null, "join");
    const before = computeLogicalVisits(db, window);
    expect(before).toEqual([
      expect.objectContaining({ userId: "alice", startedAt: BASE, endedAt: observedAt, endQuality: "open" }),
    ]);

    // 後からDB状態が進む: aliceが実際にBASE+130で退出、bobがBASE+150で入室
    db.prepare("UPDATE vc_segments SET ended_at = ?, end_quality = 'observed' WHERE user_id = 'alice'").run(
      BASE + 130,
    );
    insertRaw("bob", "vc1", BASE + 150, BASE + 200, "observed", null, "join");

    // 同じobservedAtで再評価すると、DBがどれだけ進んでいても「12:00時点で分かっていたこと」
    // と同じ結果になる——実際の退出時刻(130)がobservedAt(100)より後でも、それを先取りして
    // 見せない（endQualityも'open'のまま。'observed'へ格上げすると再現性が壊れる）。
    const after = computeLogicalVisits(db, window);
    expect(after).toEqual(before);
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
