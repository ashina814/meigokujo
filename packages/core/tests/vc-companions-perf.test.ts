import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { VcTracker } from "../src/vc/service.js";

/**
 * 同席台帳の全再計算（初回バックフィル）の負荷を実測する。
 *
 * 本番DBそのものには触れないため、住人数と観測されるセグメント生成頻度から
 * 悲観的な規模を組み立てて測る。セグメントは入退室だけでなく
 * ミュート/デフン切替・チャンネル移動でも増える（vc-tracking.ts）ため、
 * 「1人あたり1日20本」を想定の上限として置いている。
 *
 * 目的は絶対値の保証ではなく、計算量が線形から外れたときに気づくこと。
 * しきい値はCIの遅いランナーでも落ちない程度に緩めてある。
 */

const USERS = 80;
const CHANNELS = 20;
/** 80人 × 1日20本 × 1年 ≒ 58万。CI時間の都合で20万で測り、線形性から外挿する */
const SEGMENTS = 200_000;
const MAX_CONCURRENT = 10;

function buildFixture(segments: number) {
  const db = openDb(":memory:");
  const vc = new VcTracker(db);
  const insert = db.prepare(
    "INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at, self_muted, self_deafened) VALUES (?, ?, ?, ?, 0, 0)",
  );

  // 決定的な擬似乱数（seed固定）。テストの実行ごとに結果が揺れないようにする。
  // 乗算は Math.imul を使う（素朴な乗算では 2^53 を超えて精度が落ち、周期が壊れる）
  let seed = 20260730;
  const rand = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };

  const base = 1_700_000_000;
  db.transaction(() => {
    for (let i = 0; i < segments; i++) {
      // 同時接続を実際に発生させる: 同じスロットの MAX_CONCURRENT 人を同じVCに重ねる
      const slot = Math.floor(i / MAX_CONCURRENT);
      const channel = `vc:${slot % CHANNELS}`;
      const start = base + slot * 900 + rand(120);
      const duration = 1800 + rand(3600); // スロット幅より長くして必ず重なるようにする
      insert.run(`u${rand(USERS)}`, channel, start, start + duration);
    }
  })();
  return { db, vc };
}

describe("同席台帳の初回バックフィル負荷", () => {
  it(`${SEGMENTS.toLocaleString("ja-JP")}件のセグメントを現実的な時間で再計算できる`, () => {
    const { db, vc } = buildFixture(SEGMENTS);
    expect(vc.segmentCount()).toBe(SEGMENTS);

    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = Date.now();
    const pairs = vc.rebuildCompanions();
    const elapsedMs = Date.now() - startedAt;
    const heapPeak = process.memoryUsage().heapUsed;

    const rows = vc.companionRowCount();
    console.log(
      [
        `[同席台帳バックフィル実測]`,
        `  セグメント     ${SEGMENTS.toLocaleString("ja-JP")}件`,
        `  住人           ${USERS}人 / VC ${CHANNELS}本`,
        `  生成ペア       ${pairs.toLocaleString("ja-JP")}組（テーブル行数 ${rows.toLocaleString("ja-JP")}）`,
        `  所要時間       ${elapsedMs}ms`,
        `  heap増加       ${Math.round((heapPeak - heapBefore) / 1024 / 1024)}MB`,
      ].join("\n"),
    );

    // 行数は住人数で決まる（ペア数の上限は N*(N-1)/2 の双方向）。セグメント数では増えない
    expect(rows).toBeLessThanOrEqual(USERS * (USERS - 1));
    // 20万件で30秒を超えるなら計算量が想定から外れている
    expect(elapsedMs).toBeLessThan(30_000);

    db.close();
  }, 180_000);

  it("再計算は冪等（複数回実行しても結果が変わらない）", () => {
    const { db, vc } = buildFixture(20_000);
    vc.rebuildCompanions();
    const first = db
      .prepare("SELECT user_id, other_id, seconds FROM vc_companions ORDER BY user_id, other_id")
      .all();
    vc.rebuildCompanions();
    vc.rebuildCompanions();
    const again = db
      .prepare("SELECT user_id, other_id, seconds FROM vc_companions ORDER BY user_id, other_id")
      .all();
    expect(again).toEqual(first);
    db.close();
  }, 120_000);

  it("同時接続が多いチャンネルでもペア数が住人数の上限を超えない", () => {
    const db = openDb(":memory:");
    const vc = new VcTracker(db);
    const insert = db.prepare(
      "INSERT INTO vc_segments (user_id, channel_id, started_at, ended_at, self_muted, self_deafened) VALUES (?, 'vc:party', ?, ?, 0, 0)",
    );
    // 40人が完全に同じ時間、同じVCに居るケース（全ペアが成立する最悪ケース）
    const base = 1_700_000_000;
    db.transaction(() => {
      for (let u = 0; u < 40; u++) insert.run(`u${u}`, base, base + 3600);
    })();

    const startedAt = Date.now();
    const pairs = vc.rebuildCompanions();
    const elapsedMs = Date.now() - startedAt;
    console.log(`[全ペア成立ケース] 40人同時 → ${pairs}組 / ${elapsedMs}ms`);

    expect(pairs).toBe((40 * 39) / 2);
    expect(vc.companionRowCount()).toBe(40 * 39);
    db.close();
  }, 60_000);
});
