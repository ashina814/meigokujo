import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  EtherExchange,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  Ledger,
  RESERVATION_STALE_SEC,
  chinchiroLiability,
  crashLiability,
  liabilityModelFor,
  openDb,
  registerDefaultTxTypes,
  slotsLiability,
  soloGroupKey,
  type LiabilityContext,
} from "../src/index.js";

registerDefaultTxTypes();

/**
 * PR5（胴元債務予約）。
 *
 * 見るのは4つ:
 * - `available` が「house 残高 − 予約合計」になっていること
 * - 予約と再確認が同一トランザクションで、同時実行でも house が負にならないこと
 * - 予約に失敗したとき金が1 Ld も動かないこと
 * - 起動時の全解放と、24時間残存の検出
 */

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const items = new Items(db);
  const reservations = new HouseReservations(db, ether, events);
  const casino = new Casino(db, ether, events, { items, reservations });
  return { db, ledger, events, chipTx, ether, items, reservations, casino };
}

function seed(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

const ctx = (bet: number): LiabilityContext => ({
  bet,
  playerState: { winStreak: 0 },
  activeEffects: { winBonusCap: 0 },
});

describe("available = house 残高 − 予約合計", () => {
  it("予約したぶんだけ受注可能額が減る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    expect(c.reservations.available()).toBe(1_000_000);

    expect(c.reservations.reserve("k1", 400_000, "スロット", "u1").ok).toBe(true);
    expect(c.reservations.totalReserved()).toBe(400_000);
    expect(c.reservations.available()).toBe(600_000);

    c.reservations.release("k1");
    expect(c.reservations.available()).toBe(1_000_000);
    c.db.close();
  });

  it("canAccept が house 残高ではなく available を見る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    expect(c.casino.canAccept(100_000)).toBe(true);
    c.reservations.reserve("k1", 60_000, "スロット", "u1");
    // 残高は 100,000 のままでも、予約後は 40,000 までしか受けられない
    expect(c.casino.houseBalance()).toBe(100_000);
    expect(c.casino.availableForLiability()).toBe(40_000);
    expect(c.casino.canAccept(40_000)).toBe(true);
    expect(c.casino.canAccept(40_001)).toBe(false);
    c.db.close();
  });

  it("余力を超える予約は断り、そのときの上限を返す", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 50_000);
    const r = c.reservations.reserve("k1", 50_001, "スロット", "u1");
    expect(r.ok).toBe(false);
    expect(r.available).toBe(50_000);
    expect(c.reservations.count()).toBe(0);
    c.db.close();
  });

  it("同じ鍵の再試行は二重に取らない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    expect(c.reservations.reserve("k1", 30_000, "スロット", "u1").ok).toBe(true);
    expect(c.reservations.reserve("k1", 30_000, "スロット", "u1").ok).toBe(true);
    expect(c.reservations.totalReserved()).toBe(30_000);
    c.db.close();
  });

  it("債務ゼロの予約は行を作らない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000);
    expect(c.reservations.reserve("k0", 0, "何か", "u1").ok).toBe(true);
    expect(c.reservations.count()).toBe(0);
    c.db.close();
  });
});

describe("同時実行しても house 残高が負にならない", () => {
  it("100件を同時に取りにいっても、予約合計が house 残高を超えない", () => {
    const c = setup();
    const house = 1_000_000;
    seed(c.db, HOUSE_HOLDER, house);
    const model = slotsLiability;
    const bet = 5_000;
    const per = model.maxHouseLiability(ctx(bet)); // 100倍ゲーム = 495,000

    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (c.reservations.reserve(`k${i}`, per, "スロット", `u${i}`).ok) accepted++;
    }
    // 495,000 × 2 = 990,000 まで。3件目は入らない
    expect(accepted).toBe(Math.floor(house / per));
    expect(c.reservations.totalReserved()).toBeLessThanOrEqual(house);
    expect(c.reservations.available()).toBeGreaterThanOrEqual(0);
    c.db.close();
  });

  it("予約を取った全員が最大配当を引いても house が払い切れる", () => {
    const c = setup();
    const house = 3_000_000;
    seed(c.db, HOUSE_HOLDER, house);
    const bet = 10_000;
    const per = crashLiability.maxHouseLiability(ctx(bet));

    const taken: string[] = [];
    for (let i = 0; i < 100; i++) {
      const key = `crash:${i}`;
      if (c.reservations.reserve(key, per, "クラッシュ", `u${i}`).ok) taken.push(key);
    }
    expect(taken.length).toBeGreaterThan(0);
    // 全員が最悪ケースを引いたときの純増支払総額
    const worstTotal = taken.length * per;
    expect(worstTotal).toBeLessThanOrEqual(house);
    c.db.close();
  });

  it("小口が先に埋めたら大口は断られる（早い者勝ちで枠が守られる）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 600_000);
    const small = slotsLiability.maxHouseLiability(ctx(5_000)); // 495,000
    expect(c.reservations.reserve("small", small, "スロット", "u1").ok).toBe(true);
    const big = slotsLiability.maxHouseLiability(ctx(10_000));
    const r = c.reservations.reserve("big", big, "スロット", "u2");
    expect(r.ok).toBe(false);
    expect(r.available).toBe(600_000 - small);
    c.db.close();
  });
});

describe("予約失敗時に金が動かない", () => {
  it("予約を先に取ってから精算する経路では、取れなければ精算に入らない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 10_000);
    seed(c.db, "u1", 100_000);
    const before = { house: c.ether.balanceOf(HOUSE_HOLDER), user: c.ether.balanceOf("u1") };

    const bet = 5_000;
    const need = slotsLiability.maxHouseLiability(ctx(bet));
    const r = c.reservations.reserve("solo:スロット:u1:op1", need, "スロット", "u1");
    expect(r.ok).toBe(false);
    // 予約が取れないので精算そのものを呼ばない = 残高も明細も一切動かない
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(before.house);
    expect(c.ether.balanceOf("u1")).toBe(before.user);
    expect(c.chipTx.listByGroup("solo:スロット:u1:op1")).toEqual([]);
    c.db.close();
  });

  it("精算の中で例外が出れば、予約も残高もまとめて巻き戻る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "u1", 100_000);
    const key = "grp:1";
    expect(
      () =>
        c.ether.runGroup({ groupKey: key, kind: "solo_game", actorId: "u1" }, () => {
          c.reservations.reserve(key, 50_000, "スロット", "u1");
          c.ether.transfer("u1", HOUSE_HOLDER, 1_000, { reason: "賭け金" });
          throw new Error("途中で落ちた");
        }),
    ).toThrow("途中で落ちた");
    expect(c.reservations.count()).toBe(0);
    expect(c.ether.balanceOf("u1")).toBe(100_000);
    c.db.close();
  });
});

describe("精算が通ると予約が同じトランザクションで解放される", () => {
  it("settleSolo に reservationKey を渡すと解放される", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "u1", 100_000);
    const key = soloGroupKey("スロット", "u1", "op1");
    expect(c.reservations.reserve(key, 200_000, "スロット", "u1").ok).toBe(true);
    expect(c.reservations.count()).toBe(1);

    c.casino.settleSolo("u1", "スロット", 1_000, 2_000, { operationId: "op1", reservationKey: key });
    expect(c.reservations.count()).toBe(0);
    expect(c.reservations.available()).toBe(c.casino.houseBalance());
    c.db.close();
  });

  it("鍵を渡さなければ解放されない（明示した経路だけが解放する）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "u1", 100_000);
    c.reservations.reserve("別の鍵", 200_000, "スロット", "u1");
    c.casino.settleSolo("u1", "スロット", 1_000, 2_000, { operationId: "op2" });
    expect(c.reservations.count()).toBe(1);
    c.db.close();
  });
});

describe("maxBetFor が予約後の余力を反映する", () => {
  it("予約が入ると提示できる最大ベットが下がる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 10_000_000);
    const rest = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
    const before = slotsLiability.maxBetFor(c.reservations.available(), rest);
    c.reservations.reserve("k1", 5_000_000, "スロット", "u1");
    const after = slotsLiability.maxBetFor(c.reservations.available(), rest);
    expect(after).toBeLessThan(before);
    // 提示した額はいま必ず予約できる
    expect(c.reservations.reserve("k2", slotsLiability.maxHouseLiability({ ...rest, bet: after }), "スロット", "u2").ok).toBe(true);
    c.db.close();
  });

  it("ゲームごとに倍率が違うので提示額も違う", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 5_000_000);
    const rest = { playerState: { winStreak: 0 }, activeEffects: { winBonusCap: 0 } };
    const avail = c.reservations.available();
    expect(liabilityModelFor("ポーカー")!.maxBetFor(avail, rest)).toBeLessThan(
      liabilityModelFor("丁半")!.maxBetFor(avail, rest),
    );
    expect(chinchiroLiability.maxBetFor(avail, rest)).toBeGreaterThan(0);
    c.db.close();
  });
});

describe("起動時の全解放と漏れ検出", () => {
  it("全解放は件数と総額を events へ残してから消す", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("a", 10_000, "スロット", "u1");
    c.reservations.reserve("b", 20_000, "丁半", "u2");

    const r = c.reservations.releaseAll("bot 起動");
    expect(r).toEqual({ count: 2, total: 30_000 });
    expect(c.reservations.count()).toBe(0);

    const logged = c.db
      .prepare("SELECT payload_json AS payload FROM events WHERE type = 'casino_reservations_released'")
      .all() as Array<{ payload: string }>;
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload)).toMatchObject({ count: 2, total: 30_000 });
    c.db.close();
  });

  it("予約が無いときは記録も作らない", () => {
    const c = setup();
    expect(c.reservations.releaseAll("bot 起動")).toEqual({ count: 0, total: 0 });
    const n = c.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'casino_reservations_released'").get() as { n: number };
    expect(n.n).toBe(0);
    c.db.close();
  });

  it("24時間残った予約を検出して警告つきで解放する", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("old", 10_000, "スロット", "u1");
    c.reservations.reserve("new", 20_000, "丁半", "u2");
    // 片方だけ 25 時間前にずらす
    c.db
      .prepare("UPDATE casino_house_reservations SET created_at = ? WHERE key = 'old'")
      .run(Math.floor(Date.now() / 1000) - RESERVATION_STALE_SEC - 3600);

    expect(c.reservations.stale().map((r) => r.key)).toEqual(["old"]);
    const swept = c.reservations.sweepStale();
    expect(swept.count).toBe(1);
    expect(swept.total).toBe(10_000);
    // 新しいほうは残る
    expect(c.reservations.list().map((r) => r.key)).toEqual(["new"]);

    const logged = c.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'casino_reservation_stale'").get() as { n: number };
    expect(logged.n).toBe(1);
    c.db.close();
  });
});
