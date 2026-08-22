import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { RankEngine } from "../src/rank/service.js";
import { textLevel, voiceLevel } from "../src/rank/tiers.js";

/**
 * `RankEngine.listTrackedLevels()`（PR D2 §7-12, §42-43）——rank title historical
 * reconcile用のread-only current-level API。`last_tier`を正本にせず、必ずXPから
 * `textLevel()`/`voiceLevel()`で再計算することを固定する。
 */

describe("RankEngine.listTrackedLevels()", () => {
  it("A. text onlyのuserはtext=current level、voice=0", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    engine.awardText("alice", 1000, 0);

    const rows = engine.listTrackedLevels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ userId: "alice", textLevel: textLevel(1000), voiceLevel: 0 });
  });

  it("B. voice onlyのuserはtext=0、voice=current level", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    engine.awardVoice("bob", 2000, 5);

    const rows = engine.listTrackedLevels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ userId: "bob", textLevel: 0, voiceLevel: voiceLevel(2000) });
  });

  it("C. 両方持つuserは両方current level", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    engine.awardText("carol", 500, 0);
    engine.awardVoice("carol", 800, 5);

    const rows = engine.listTrackedLevels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ userId: "carol", textLevel: textLevel(500), voiceLevel: voiceLevel(800) });
  });

  it("D. user_id ASCのdeterministic order", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    engine.awardVoice("zed", 100, 1);
    engine.awardText("alice", 100, 0);
    engine.awardText("mike", 100, 0);

    const rows = engine.listTrackedLevels();
    expect(rows.map((r) => r.userId)).toEqual(["alice", "mike", "zed"]);
  });

  it("E. rank table 0 rowsなら空配列", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    expect(engine.listTrackedLevels()).toEqual([]);
  });

  it("last_tier poison test: rank_text.xpがLv50相当でもlast_tierへ不正値を直接入れても、textLevelは正しくXPから計算される（§43）", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    engine.awardText("poisoned", 1_000_000, 0); // Lv50を大きく超えるXP

    const correctLevel = textLevel(engine.getText("poisoned").xp);
    // last_tierへ意味の無い(存在しないtier index相当の)値を直接書き込む。
    db.prepare(`UPDATE rank_text SET last_tier = 999 WHERE user_id = 'poisoned'`).run();

    const rows = engine.listTrackedLevels();
    expect(rows[0]?.textLevel).toBe(correctLevel);
    // last_tierの値(999)を一切参照していないことの直接証明——999のような
    // 意味のない値が結果へ現れない。
    expect(rows[0]?.textLevel).not.toBe(999);
  });

  it("1 queryで完結する(userごとのN+1 queryにならない)ことの間接確認: 複数user分をまとめて取得できる", () => {
    const db = openDb(":memory:");
    const engine = new RankEngine(db);
    for (let i = 0; i < 50; i++) {
      engine.awardText(`user-${String(i).padStart(3, "0")}`, 100 * i, 0);
    }
    const rows = engine.listTrackedLevels();
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.voiceLevel === 0)).toBe(true);
  });
});
