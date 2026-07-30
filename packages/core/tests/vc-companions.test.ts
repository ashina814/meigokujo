import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/bootstrap.js";
import { VcTracker } from "../src/vc/service.js";

/**
 * 同席台帳（vc_companions）。
 * 増分更新はペアの二重計上が起きやすいので、「増分の結果 == 全再計算の結果」を軸に確かめる。
 */

function pairSeconds(db: Database.Database, a: string, b: string): number {
  const row = db.prepare("SELECT seconds FROM vc_companions WHERE user_id = ? AND other_id = ?").get(a, b) as
    | { seconds: number }
    | undefined;
  return row?.seconds ?? 0;
}

function snapshotPairs(db: Database.Database): Array<[string, string, number]> {
  return (
    db.prepare("SELECT user_id, other_id, seconds FROM vc_companions ORDER BY user_id, other_id").all() as Array<{
      user_id: string;
      other_id: string;
      seconds: number;
    }>
  ).map((r) => [r.user_id, r.other_id, r.seconds]);
}

/** 実時間に依存せずセグメントを作るため、直接INSERTしてから close 相当の処理を通す */
function setup() {
  const db = openDb(":memory:");
  const vc = new VcTracker(db);
  return { db, vc };
}

describe("同席台帳", () => {
  it("重なった2人ぶんを、双方向に一度だけ計上する", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;

    // A: t0 〜 t0+600 / B: t0+300 〜 t0+900 （重なり300秒）
    db.prepare(
      "INSERT INTO vc_segments (user_id, channel_id, started_at) VALUES ('A', 'vc:1', ?)",
    ).run(t0);
    db.prepare(
      "INSERT INTO vc_segments (user_id, channel_id, started_at) VALUES ('B', 'vc:1', ?)",
    ).run(t0 + 300);

    // A が先に抜ける → このときBはまだ開いているのでペア計上される
    db.prepare("UPDATE vc_segments SET ended_at = ? WHERE user_id = 'A'").run(t0 + 600);
    (vc as unknown as { rollUpCompanions: (u: string, c: string, s: number, e: number) => void }).rollUpCompanions(
      "A",
      "vc:1",
      t0,
      t0 + 600,
    );

    expect(pairSeconds(db, "A", "B")).toBe(300);
    expect(pairSeconds(db, "B", "A")).toBe(300);

    // 後から B が抜けても、A は既に閉じているので二重計上しない
    db.prepare("UPDATE vc_segments SET ended_at = ? WHERE user_id = 'B'").run(t0 + 900);
    (vc as unknown as { rollUpCompanions: (u: string, c: string, s: number, e: number) => void }).rollUpCompanions(
      "B",
      "vc:1",
      t0 + 300,
      t0 + 900,
    );

    expect(pairSeconds(db, "A", "B")).toBe(300);
    expect(pairSeconds(db, "B", "A")).toBe(300);
  });

  it("別チャンネルに同時刻で居ても同席にはならない", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('A','vc:1',?,?)").run(
      t0,
      t0 + 600,
    );
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('B','vc:2',?,?)").run(
      t0,
      t0 + 600,
    );
    vc.rebuildCompanions();
    expect(pairSeconds(db, "A", "B")).toBe(0);
  });

  it("接していない区間（重なり0）は計上しない", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('A','vc:1',?,?)").run(
      t0,
      t0 + 300,
    );
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('B','vc:1',?,?)").run(
      t0 + 300,
      t0 + 600,
    );
    vc.rebuildCompanions();
    expect(pairSeconds(db, "A", "B")).toBe(0);
  });

  it("3人が重なると3ペアぶん記録される", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    for (const u of ["A", "B", "C"]) {
      db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES (?,'vc:1',?,?)").run(
        u,
        t0,
        t0 + 600,
      );
    }
    vc.rebuildCompanions();
    expect(pairSeconds(db, "A", "B")).toBe(600);
    expect(pairSeconds(db, "A", "C")).toBe(600);
    expect(pairSeconds(db, "B", "C")).toBe(600);
    expect(snapshotPairs(db)).toHaveLength(6); // 3ペア × 双方向
  });

  it("増分更新の結果が、全再計算の結果と一致する", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 100_000;

    // A,B,C が入れ替わりで出入りする現実的な並び。open/close を実際に通す
    const events: Array<[string, string, number]> = [
      ["A", "vc:1", 0],
      ["B", "vc:1", 100],
      ["C", "vc:1", 250],
    ];
    for (const [user, ch, offset] of events) {
      db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at) VALUES (?,?,?)").run(
        user,
        ch,
        t0 + offset,
      );
    }
    // B → A → C の順で退出させる（増分更新の経路）
    const closes: Array<[string, number, number]> = [
      ["B", 100, 400],
      ["A", 0, 700],
      ["C", 250, 900],
    ];
    for (const [user, start, end] of closes) {
      db.prepare("UPDATE vc_segments SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL").run(t0 + end, user);
      (vc as unknown as { rollUpCompanions: (u: string, c: string, s: number, e: number) => void }).rollUpCompanions(
        user,
        "vc:1",
        t0 + start,
        t0 + end,
      );
    }

    const incremental = snapshotPairs(db);
    vc.rebuildCompanions();
    const rebuilt = snapshotPairs(db);

    expect(incremental).toEqual(rebuilt);
    // A-B は 100〜400 の300秒、A-C は 250〜700 の450秒、B-C は 250〜400 の150秒
    expect(pairSeconds(db, "A", "B")).toBe(300);
    expect(pairSeconds(db, "A", "C")).toBe(450);
    expect(pairSeconds(db, "B", "C")).toBe(150);
  });

  it("全再計算は何度走らせても同じ結果になる（重複加算しない）", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('A','vc:1',?,?)").run(
      t0,
      t0 + 600,
    );
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('B','vc:1',?,?)").run(
      t0,
      t0 + 600,
    );
    vc.rebuildCompanions();
    const first = snapshotPairs(db);
    vc.rebuildCompanions();
    vc.rebuildCompanions();
    expect(snapshotPairs(db)).toEqual(first);
  });

  it("退出処理は原子的（台帳更新が失敗すればセグメントも閉じない）", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at) VALUES ('A','vc:1',?)").run(t0);
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at) VALUES ('B','vc:1',?)").run(t0);

    // 台帳への書き込みを壊して異常終了を模す
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("INSERT INTO vc_companions")) throw new Error("disk full");
      return original(sql);
    }) as typeof db.prepare);

    expect(() => vc.close("A")).toThrow("disk full");
    spy.mockRestore();

    // セグメントは閉じられていない → 起動時に dangling として復旧できる
    const open = db.prepare("SELECT COUNT(*) AS n FROM vc_segments WHERE ended_at IS NULL").get() as { n: number };
    expect(open.n).toBe(2);
    expect(pairSeconds(db, "A", "B")).toBe(0);
  });

  it("一括クローズは dirty を立て、再計算が必要と判定される", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at) VALUES ('A','vc:1',?)").run(t0);
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at) VALUES ('B','vc:1',?)").run(t0);

    // 先に正常な世代を記録しておく（empty 判定ではなく dirty で拾えることを示す）
    vc.rebuildCompanions();
    expect(vc.companionsRebuildReason()).toBeNull();

    expect(vc.closeAllDangling()).toBe(2);
    expect(vc.companionsRebuildReason()).toBe("dirty");

    vc.rebuildCompanions();
    expect(vc.companionsRebuildReason()).toBeNull();
  });

  it("導入直後（世代マーカー未記録）は再計算が必要と判定される", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('A','vc:1',?,?)").run(
      t0,
      t0 + 600,
    );
    expect(vc.companionsRebuildReason()).toBe("generation");
    vc.rebuildCompanions();
    expect(vc.companionsRebuildReason()).toBeNull();
  });

  it("同席相手が一人もいなくても、再計算後は再実行を要求しない", () => {
    // 台帳が空であることを理由にすると、独りで浮上している人しか居ない城では
    // 毎回の起動で全再計算が走ってしまう（回帰の要点）
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('solo','vc:1',?,?)").run(
      t0,
      t0 + 3600,
    );
    vc.rebuildCompanions();
    expect(vc.companionRowCount()).toBe(0);
    expect(vc.companionsRebuildReason()).toBeNull();
    expect(vc.companionsRebuildReason()).toBeNull();
  });

  it("セグメントが1件も無ければ再計算後は不要", () => {
    const { vc } = setup();
    vc.rebuildCompanions();
    expect(vc.companionsRebuildReason()).toBeNull();
  });

  it("集計世代が上がったら再計算が必要と判定される", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('A','vc:1',?,?)").run(
      t0,
      t0 + 600,
    );
    vc.rebuildCompanions();
    // 旧世代で記録された状態を模す
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'vc_companions:generation'").run();
    expect(vc.companionsRebuildReason()).toBe("generation");
  });

  it("companionSummary が人数・総時間・最長ペアを返す", () => {
    const { db, vc } = setup();
    const t0 = Math.floor(Date.now() / 1000) - 10_000;
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('A','vc:1',?,?)").run(
      t0,
      t0 + 1000,
    );
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('B','vc:1',?,?)").run(
      t0,
      t0 + 600,
    );
    db.prepare("INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at) VALUES ('C','vc:1',?,?)").run(
      t0,
      t0 + 200,
    );
    vc.rebuildCompanions();

    const summary = vc.companionSummary("A");
    expect(summary.uniqueCount).toBe(2);
    expect(summary.totalSeconds).toBe(800); // B と600秒 + C と200秒
    expect(summary.bestSeconds).toBe(600);
  });
});
