import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { TitleV2Store } from "../src/titles/v2-store.js";
import { TEXT_TIERS, type RankTitleKey } from "../src/rank/tiers.js";

/** JST 2026-08-20 00:00:00 を秒0とする、rank title unlockテスト用の基準時刻。 */
const BASE = Math.floor(Date.UTC(2026, 7, 19, 15, 0, 0) / 1000);

function setup() {
  const db = openDb(":memory:");
  let clock = BASE;
  const store = new TitleV2Store(db, () => clock);
  const setClock = (value: number) => {
    clock = value;
  };
  return { db, store, setClock };
}

const KEY0: RankTitleKey = "rank.text.lv000";
const KEY5: RankTitleKey = "rank.text.lv005";
const KEY15: RankTitleKey = "rank.text.lv015";
const KEY30: RankTitleKey = "rank.text.lv030";
const KEY50: RankTitleKey = "rank.text.lv050";
const KEY75: RankTitleKey = "rank.text.lv075";

describe("rank_title_unlocks（§34）", () => {
  it("A. reconcile Lv0 → Lv0 unlockのみ、unlockedAt NULL", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    const result = store.reconcileRankTitleUnlocks("alice", "text", 0);
    expect(result.newlyUnlocked).toEqual([{ rankTitleKey: KEY0, unlockedAt: null, recordedAt: BASE + 1000 }]);
    expect(store.hasRankTitleUnlock("alice", KEY0)).toBe(true);
    expect(store.rankTitleUnlock("alice", KEY0)?.unlockedAt).toBeNull();
  });

  it("B. reconcile Lv50 → 0/5/15/30/50を全部unlock、全部unlockedAt NULL", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    const result = store.reconcileRankTitleUnlocks("bob", "text", 50);
    const keys = result.newlyUnlocked.map((u) => u.rankTitleKey).sort();
    expect(keys).toEqual([KEY0, KEY15, KEY30, KEY5, KEY50].sort());
    expect(result.newlyUnlocked.every((u) => u.unlockedAt === null)).toBe(true);
    for (const key of [KEY0, KEY5, KEY15, KEY30, KEY50]) {
      expect(store.hasRankTitleUnlock("bob", key)).toBe(true);
    }
    expect(store.hasRankTitleUnlock("bob", KEY75)).toBe(false);
  });

  it("C. observed 4→16 → Lv5/Lv15はexact now、lower missing Lv0はNULL", () => {
    const { store, setClock } = setup();
    setClock(BASE + 2000);
    const result = store.recordRankTitleTransition("carol", "text", 4, 16);
    const byKey = new Map(result.newlyUnlocked.map((u) => [u.rankTitleKey, u]));
    expect(byKey.get(KEY0)).toEqual({ rankTitleKey: KEY0, unlockedAt: null, recordedAt: BASE + 2000 });
    expect(byKey.get(KEY5)).toEqual({ rankTitleKey: KEY5, unlockedAt: BASE + 2000, recordedAt: BASE + 2000 });
    expect(byKey.get(KEY15)).toEqual({ rankTitleKey: KEY15, unlockedAt: BASE + 2000, recordedAt: BASE + 2000 });
    expect(byKey.has(KEY30)).toBe(false);
  });

  it("D. observed 50→75、過去tier rowが全部欠損 → <=50はNULL、Lv75だけexact now", () => {
    const { store, setClock } = setup();
    setClock(BASE + 3000);
    const result = store.recordRankTitleTransition("dave", "text", 50, 75);
    const byKey = new Map(result.newlyUnlocked.map((u) => [u.rankTitleKey, u]));
    for (const key of [KEY0, KEY5, KEY15, KEY30, KEY50]) {
      expect(byKey.get(key)?.unlockedAt).toBeNull();
    }
    expect(byKey.get(KEY75)).toEqual({ rankTitleKey: KEY75, unlockedAt: BASE + 3000, recordedAt: BASE + 3000 });
  });

  it("E. second reconcileはidempotent（timestampsが変わらない）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    store.reconcileRankTitleUnlocks("erin", "text", 30);
    const before = store.listRankTitleUnlocks("erin");

    setClock(BASE + 5000);
    const second = store.reconcileRankTitleUnlocks("erin", "text", 30);
    expect(second.newlyUnlocked).toEqual([]);
    expect(store.listRankTitleUnlocks("erin")).toEqual(before);
  });

  it("F. 既存unlockedAt=NULLは、後のtransitionでもnon-nullへUPDATEされない", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    store.reconcileRankTitleUnlocks("frank", "text", 5); // Lv0/Lv5がunlockedAt=NULLで成立
    expect(store.rankTitleUnlock("frank", KEY5)?.unlockedAt).toBeNull();

    setClock(BASE + 9000);
    store.recordRankTitleTransition("frank", "text", 5, 15); // Lv5は既存のはず、UPDATEされない
    expect(store.rankTitleUnlock("frank", KEY5)?.unlockedAt).toBeNull();
    expect(store.rankTitleUnlock("frank", KEY5)?.recordedAt).toBe(BASE + 1000); // recorded_atも不変
    expect(store.rankTitleUnlock("frank", KEY15)?.unlockedAt).toBe(BASE + 9000); // 新規はlive
  });

  it("G. downward observed transitionはreject", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    expect(() => store.recordRankTitleTransition("grace", "text", 50, 30)).toThrow(/afterLevel.*cannot be less than/);
    expect(store.listRankTitleUnlocks("grace")).toEqual([]);
  });

  it("H. currentLevel低下後にreconcileしても、高位unlockを削除しない", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    store.reconcileRankTitleUnlocks("henry", "text", 100);
    expect(store.hasRankTitleUnlock("henry", "rank.text.lv100")).toBe(true);

    setClock(BASE + 2000);
    // XPが下がってcurrentLevelが50相当になったとしても、reconcile(50)は既存unlockを
    // 削除しない——unlockは永久。
    store.reconcileRankTitleUnlocks("henry", "text", 50);
    expect(store.hasRankTitleUnlock("henry", "rank.text.lv100")).toBe(true);
  });

  it("I. unknown rank title key DB rowはconstructor fail", () => {
    const { db, store, setClock } = setup();
    setClock(BASE + 1000);
    store.reconcileRankTitleUnlocks("ivan", "text", 0);
    db.prepare(`UPDATE rank_title_unlocks SET rank_title_key = 'rank.text.lv999' WHERE user_id = 'ivan'`).run();

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/unknown rank_title_key/);
  });

  it("J. unlockedAt > recordedAtはconstructor fail", () => {
    const { db, store, setClock } = setup();
    setClock(BASE + 1000);
    store.recordRankTitleTransition("jack", "text", 0, 5); // Lv5がunlockedAt=BASE+1000で成立

    db.pragma("foreign_keys = OFF");
    db.exec(`
      ALTER TABLE rank_title_unlocks RENAME TO rank_title_unlocks_orig;
      CREATE TABLE rank_title_unlocks (
        user_id TEXT NOT NULL, rank_title_key TEXT NOT NULL, unlocked_at INTEGER, recorded_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, rank_title_key)
      );
      INSERT INTO rank_title_unlocks SELECT * FROM rank_title_unlocks_orig;
      DROP TABLE rank_title_unlocks_orig;
    `);
    db.pragma("foreign_keys = ON");
    // CHECK(unlocked_at<=recorded_at)を迂回して、unlocked_atをrecorded_atより後にする。
    db.prepare(`UPDATE rank_title_unlocks SET unlocked_at = ? WHERE user_id = 'jack'`).run(BASE + 9999);

    expect(() => new TitleV2Store(db, () => BASE + 3000)).toThrow(/unlocked_at.*after recorded_at/);
  });

  it("同じ秒levelでbeforeLevel===afterLevelを渡してもreconcile相当として動く（境界値）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    const result = store.recordRankTitleTransition("kelly", "text", 30, 30);
    expect(result.newlyUnlocked.every((u) => u.unlockedAt === null)).toBe(true);
  });

  it("voice trackも独立して動く（textとkey衝突しない）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    store.reconcileRankTitleUnlocks("laura", "voice", 5);
    expect(store.hasRankTitleUnlock("laura", "rank.voice.lv005")).toBe(true);
    expect(store.hasRankTitleUnlock("laura", KEY5)).toBe(false);
  });

  it("registry上のtierと一致するkey集合であることの間接確認（TEXT_TIERSを totalに使う）", () => {
    const { store, setClock } = setup();
    setClock(BASE + 1000);
    store.reconcileRankTitleUnlocks("mallory", "text", 150);
    for (const t of TEXT_TIERS) {
      expect(store.hasRankTitleUnlock("mallory", t.key)).toBe(true);
    }
  });
});

describe("atomicity（§36.1）", () => {
  it("multi-tier transition: 途中unlock INSERT失敗 → 全unlock rollback", () => {
    const { db, store, setClock } = setup();
    db.exec(`
      CREATE TRIGGER sabotage_rank_unlock_insert
      BEFORE INSERT ON rank_title_unlocks
      WHEN NEW.rank_title_key = 'rank.text.lv050'
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged for rank unlock atomicity test');
      END;
    `);
    setClock(BASE + 1000);
    expect(() => store.recordRankTitleTransition("nathan", "text", 4, 76)).toThrow(/sabotaged for rank unlock/);
    // Lv5/Lv15/Lv30等、Lv50より前に処理されたはずのtierも含め、全部rollbackされている。
    expect(store.listRankTitleUnlocks("nathan")).toEqual([]);
  });
});
