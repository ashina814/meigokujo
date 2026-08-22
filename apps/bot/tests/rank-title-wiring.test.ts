import { describe, expect, it, vi } from "vitest";
import {
  openDb,
  RankEngine,
  Settings,
  TitleV2Store,
  TEXT_TIERS,
  tierFor,
  textLevel,
  voiceLevel,
  type RankAward,
} from "@meigokujo/core";
import {
  recordLiveRankTitleUnlock,
  reconcileTrackedRankTitles,
  runDailyRankTitleReconcile,
  startupReconcileRankTitles,
} from "../src/rank-title-wiring.js";

/**
 * PR D2: rank-title live wiring / historical reconcileの統合テスト。
 * real RankEngine + real TitleV2Store（in-memory DB）を使い、実際のwiring経路を検証する。
 */

/** levelFn(xp)がlevel以上になる最小のxpを二分探索する（`rank/tiers.js`はpackage exportsの
 * subpath公開対象外のため、`textXpPerLevel`等の内部関数を直接importできない——
 * 公開済みの`textLevel`/`voiceLevel`だけを使ってテスト用に逆算する）。 */
function minXpForLevel(level: number, levelFn: (xp: number) => number): number {
  if (level === 0) return 0;
  let lo = 0;
  let hi = 1;
  while (levelFn(hi) < level) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (levelFn(mid) >= level) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
function cumulativeTextXpForLevel(level: number): number {
  return minXpForLevel(level, textLevel);
}
function cumulativeVoiceXpForLevel(level: number): number {
  return minXpForLevel(level, voiceLevel);
}

function setup() {
  const db = openDb(":memory:");
  const ranks = new RankEngine(db);
  let clock = 5000;
  const titleV2 = new TitleV2Store(db, () => clock);
  const settings = new Settings(db);
  const setClock = (value: number) => {
    clock = value;
  };
  return { db, ranks, titleV2, settings, setClock };
}

function fakeAward(beforeLevel: number, afterLevel: number): RankAward {
  return {
    awarded: 0,
    before: { userId: "", xp: 0, level: beforeLevel, tier: tierFor(beforeLevel, TEXT_TIERS), progress: { inLevel: 0, toNext: 0 } },
    after: { userId: "", xp: 0, level: afterLevel, tier: tierFor(afterLevel, TEXT_TIERS), progress: { inLevel: 0, toNext: 0 } },
    tierUp: tierFor(beforeLevel, TEXT_TIERS).key !== tierFor(afterLevel, TEXT_TIERS).key,
  };
}

describe("recordLiveRankTitleUnlock() — live crossing", () => {
  it("text threshold crossing (beforeLevel=49→afterLevel=50): 新tierはStore clock、欠損していた過去tierはNULL", () => {
    const { ranks, titleV2, setClock } = setup();
    setClock(7777);
    const userId = "dave";
    ranks.awardText(userId, cumulativeTextXpForLevel(49), 0); // pre-v2相当: live wiringをまだ呼ばない
    const crossing = ranks.awardText(userId, cumulativeTextXpForLevel(50) - cumulativeTextXpForLevel(49), 0);
    expect(crossing?.before.level).toBe(49);
    expect(crossing?.after.level).toBe(50);

    recordLiveRankTitleUnlock({ titleV2 }, userId, "text", crossing!);

    expect(titleV2.rankTitleUnlock(userId, "rank.text.lv050")?.unlockedAt).toBe(7777);
    for (const key of ["rank.text.lv000", "rank.text.lv005", "rank.text.lv015", "rank.text.lv030"] as const) {
      expect(titleV2.rankTitleUnlock(userId, key)?.unlockedAt).toBeNull();
    }
  });

  it("voice threshold crossing: text用のtypoを見逃さないための独立確認", () => {
    const { ranks, titleV2, setClock } = setup();
    setClock(8888);
    const userId = "voice-dave";
    ranks.awardVoice(userId, cumulativeVoiceXpForLevel(49), 5);
    const crossing = ranks.awardVoice(userId, cumulativeVoiceXpForLevel(50) - cumulativeVoiceXpForLevel(49), 5);
    expect(crossing.before.level).toBe(49);
    expect(crossing.after.level).toBe(50);

    recordLiveRankTitleUnlock({ titleV2 }, userId, "voice", crossing);

    expect(titleV2.rankTitleUnlock(userId, "rank.voice.lv050")?.unlockedAt).toBe(8888);
    for (const key of ["rank.voice.lv000", "rank.voice.lv005", "rank.voice.lv015", "rank.voice.lv030"] as const) {
      expect(titleV2.rankTitleUnlock(userId, key)?.unlockedAt).toBeNull();
    }
    // textとkeyが衝突しないことも確認
    expect(titleV2.hasRankTitleUnlock(userId, "rank.text.lv050")).toBe(false);
  });

  it("current-tier missing self-heal: tierUp=falseでも現在tierのunlockが無ければrecordされる", () => {
    const { ranks, titleV2 } = setup();
    const userId = "frank";
    ranks.awardText(userId, cumulativeTextXpForLevel(75), 0); // 既存Lv75、rank_title_unlocksは空のまま
    expect(titleV2.hasRankTitleUnlock(userId, "rank.text.lv075")).toBe(false);

    const sameTier = ranks.awardText(userId, 1, 0);
    expect(sameTier?.tierUp).toBe(false);
    expect(sameTier?.before.level).toBe(75);
    expect(sameTier?.after.level).toBe(75);

    recordLiveRankTitleUnlock({ titleV2 }, userId, "text", sameTier!);

    for (const t of TEXT_TIERS) {
      if (t.minLevel <= 75) expect(titleV2.hasRankTitleUnlock(userId, t.key)).toBe(true);
    }
    expect(titleV2.rankTitleUnlock(userId, "rank.text.lv075")?.unlockedAt).toBeNull();
  });

  it("ordinary same-tier fast-path: 既にcurrent tierまでunlock済みならrecordRankTitleTransition()を呼ばない", () => {
    const { ranks, titleV2 } = setup();
    const userId = "gina";
    const first = ranks.awardText(userId, cumulativeTextXpForLevel(75), 0);
    recordLiveRankTitleUnlock({ titleV2 }, userId, "text", first!); // Lv75まで補完済みにする

    const spy = vi.spyOn(titleV2, "recordRankTitleTransition");
    const sameTier = ranks.awardText(userId, 1, 0);
    expect(sameTier?.tierUp).toBe(false);
    recordLiveRankTitleUnlock({ titleV2 }, userId, "text", sameTier!);

    expect(spy).not.toHaveBeenCalled();
  });

  it("recross: 既存unlockへ後から再度tierUp=trueが来てもUPDATEしない（unlockedAt/recordedAt不変）", () => {
    const { titleV2, setClock } = setup();
    setClock(1000);
    const userId = "recross-user";
    titleV2.recordRankTitleTransition(userId, "text", 0, 50);
    const before = titleV2.rankTitleUnlock(userId, "rank.text.lv050");
    expect(before?.unlockedAt).toBe(1000);

    setClock(9999);
    recordLiveRankTitleUnlock({ titleV2 }, userId, "text", fakeAward(10, 50));

    expect(titleV2.rankTitleUnlock(userId, "rank.text.lv050")).toEqual(before);
  });

  it("v2 failure isolation: TitleV2Store側がthrowしてもerrorをlogしてreturnする（外へ漏らさない）", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fakeTitleV2 = {
      hasRankTitleUnlock: () => {
        throw new Error("boom");
      },
      recordRankTitleTransition: () => {
        throw new Error("should not reach");
      },
    };

    expect(() =>
      recordLiveRankTitleUnlock({ titleV2: fakeTitleV2 as unknown as TitleV2Store }, "eve", "text", fakeAward(0, 0)),
    ).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("reconcileTrackedRankTitles()", () => {
  it("reconcile repair: liveで補完されなかったuserも、missing tierが補完される（unlockedAt=NULL）", () => {
    const { ranks, titleV2 } = setup();
    const userId = "frank2";
    ranks.awardText(userId, cumulativeTextXpForLevel(75), 0); // XPだけ、live wiringは一切呼ばない

    const summary = reconcileTrackedRankTitles({ ranks, titleV2 });
    expect(summary.usersScanned).toBe(1);
    expect(summary.newlyUnlocked).toBeGreaterThan(0);
    expect(titleV2.rankTitleUnlock(userId, "rank.text.lv075")?.unlockedAt).toBeNull();
  });

  it("reconcile idempotency: 2回目はnewlyUnlocked=0、既存行は不変", () => {
    const { ranks, titleV2 } = setup();
    ranks.awardText("gina2", cumulativeTextXpForLevel(30), 0);

    const first = reconcileTrackedRankTitles({ ranks, titleV2 });
    expect(first.newlyUnlocked).toBeGreaterThan(0);
    const before = titleV2.listRankTitleUnlocks("gina2");

    const second = reconcileTrackedRankTitles({ ranks, titleV2 });
    expect(second.newlyUnlocked).toBe(0);
    expect(titleV2.listRankTitleUnlocks("gina2")).toEqual(before);
  });

  it("both-track reconcile: text onlyのuserもvoice Lv0、voice onlyのuserもtext Lv0が補完される", () => {
    const { ranks, titleV2 } = setup();
    ranks.awardText("alice2", cumulativeTextXpForLevel(15), 0);
    ranks.awardVoice("bob2", cumulativeVoiceXpForLevel(15), 5);

    reconcileTrackedRankTitles({ ranks, titleV2 });

    expect(titleV2.hasRankTitleUnlock("alice2", "rank.text.lv015")).toBe(true);
    expect(titleV2.hasRankTitleUnlock("alice2", "rank.voice.lv000")).toBe(true);
    expect(titleV2.hasRankTitleUnlock("bob2", "rank.voice.lv015")).toBe(true);
    expect(titleV2.hasRankTitleUnlock("bob2", "rank.text.lv000")).toBe(true);
  });

  it("reconcileはrank_title_unlocks以外のv2 stateへ一切mutationしない", () => {
    const { db, ranks, titleV2 } = setup();
    ranks.awardText("henry2", cumulativeTextXpForLevel(50), 0);

    const tables = [
      "title_awards",
      "title_award_facts",
      "title_ownerships",
      "title_series_masteries",
      "title_collection_editions",
      "title_relationship_private_evidence",
      "profile_identity_equips",
    ];
    const countOf = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
    const before = Object.fromEntries(tables.map((t) => [t, countOf(t)]));

    reconcileTrackedRankTitles({ ranks, titleV2 });

    const after = Object.fromEntries(tables.map((t) => [t, countOf(t)]));
    expect(after).toEqual(before);
  });

  it("reconcileでauto-equipしない: profile_identity_equipsが空のまま", () => {
    const { db, ranks, titleV2 } = setup();
    ranks.awardText("ivan3", cumulativeTextXpForLevel(30), 0);
    reconcileTrackedRankTitles({ ranks, titleV2 });
    const count = (db.prepare(`SELECT COUNT(*) c FROM profile_identity_equips`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("reconcileでcurrent levelより上の既存unlockを削除・downgradeしない", () => {
    const { ranks, titleV2 } = setup();
    const userId = "judy3";
    ranks.awardText(userId, cumulativeTextXpForLevel(100), 0);
    reconcileTrackedRankTitles({ ranks, titleV2 });
    expect(titleV2.hasRankTitleUnlock(userId, "rank.text.lv100")).toBe(true);

    // XPが下がる状況は実運用では起きないが、reconcile自体はcurrent levelより高い
    // 既存unlockを一切見に行かない(削除ロジックが無いことを直接保証する)。
    reconcileTrackedRankTitles({ ranks, titleV2 });
    expect(titleV2.hasRankTitleUnlock(userId, "rank.text.lv100")).toBe(true);
  });

  it("no catalog dependency: SYSTEM_EPOCH/CATALOG_EPOCH未施行でもreconcileが成立する", () => {
    const { db, ranks, titleV2 } = setup();
    expect(new TitleV2Store(db).systemEpoch !== undefined).toBe(true);
    // applyCatalog/applySystemEpochは一切呼んでいない状態のまま。
    ranks.awardText("kate", cumulativeTextXpForLevel(5), 0);
    expect(() => reconcileTrackedRankTitles({ ranks, titleV2 })).not.toThrow();
    expect(titleV2.hasRankTitleUnlock("kate", "rank.text.lv005")).toBe(true);
  });

  it("rank rowが一度も無いDBでは0 usersScanned", () => {
    const { ranks, titleV2 } = setup();
    const summary = reconcileTrackedRankTitles({ ranks, titleV2 });
    expect(summary).toEqual({ usersScanned: 0, tracksReconciled: 0, newlyUnlocked: 0 });
  });
});

describe("runDailyRankTitleReconcile() — scheduler marker/retry", () => {
  it("marker無し→reconcile実行→marker成功、同date再呼び出しは実行しない", async () => {
    const { ranks, titleV2, settings } = setup();
    ranks.awardText("liam", cumulativeTextXpForLevel(30), 0);

    const first = await runDailyRankTitleReconcile({ ranks, titleV2, settings }, "2026-08-22");
    expect(first).toBe(true);
    expect(settings.getString("rank_title_v2:reconciled:2026-08-22")).toBe("1");
    expect(titleV2.hasRankTitleUnlock("liam", "rank.text.lv030")).toBe(true);

    const spy = vi.spyOn(titleV2, "reconcileRankTitleUnlocks");
    const second = await runDailyRankTitleReconcile({ ranks, titleV2, settings }, "2026-08-22");
    expect(second).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("失敗時はmarkerを立てず、次回のtickでretryできる", async () => {
    const { settings } = setup();
    let shouldThrow = true;
    const flakyRanks = {
      listTrackedLevels: () => {
        if (shouldThrow) throw new Error("boom");
        return [];
      },
    };
    const noopTitleV2 = {};

    await expect(
      runDailyRankTitleReconcile(
        { ranks: flakyRanks as unknown as RankEngine, titleV2: noopTitleV2 as unknown as TitleV2Store, settings },
        "2026-08-22",
      ),
    ).rejects.toThrow("boom");
    expect(settings.getString("rank_title_v2:reconciled:2026-08-22")).toBeUndefined();

    shouldThrow = false;
    const retry = await runDailyRankTitleReconcile(
      { ranks: flakyRanks as unknown as RankEngine, titleV2: noopTitleV2 as unknown as TitleV2Store, settings },
      "2026-08-22",
    );
    expect(retry).toBe(true);
    expect(settings.getString("rank_title_v2:reconciled:2026-08-22")).toBe("1");
  });
});

describe("startupReconcileRankTitles()", () => {
  it("成功時: reconcileが実際に実行される", () => {
    const { ranks, titleV2 } = setup();
    ranks.awardText("mike2", cumulativeTextXpForLevel(5), 0);
    startupReconcileRankTitles({ ranks, titleV2 });
    expect(titleV2.hasRankTitleUnlock("mike2", "rank.text.lv005")).toBe(true);
  });

  it("失敗時: throwを外へ漏らさず、console.errorする（Bot起動を止めない）", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwingRanks = {
      listTrackedLevels: () => {
        throw new Error("boom");
      },
    };
    expect(() =>
      startupReconcileRankTitles({
        ranks: throwingRanks as unknown as RankEngine,
        titleV2: {} as unknown as TitleV2Store,
      }),
    ).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
