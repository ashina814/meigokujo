import { describe, expect, it } from "vitest";
import {
  Casino,
  ChipTx,
  ChipLedger,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  Ledger,
  RESERVATION_STALE_SEC,
  ReservationConflictError,
  ReservationInputError,
  SLOT_MAX_PAYOUT_MULT,
  chinchiroLiability,
  crashLiability,
  liabilityModelFor,
  openDb,
  registerDefaultTxTypes,
  slotsJackpotCutFor,
  slotsLiability,
  soloGroupKey,
  type LiabilityContext,
} from "../src/index.js";

import { openFormally } from "./helpers/chip-ctx.js";

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
  const ether = new ChipLedger(db, ledger, events, { chipTx });
  // 正式開業ロックは外せない（PR8監査・ブロッカーA）。資金を動かす前に opening_v1 を確定させる
  openFormally(ether.chipTx, ledger);
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

  it("amount=0 は不正入力として拒否する（マージ直前レビュー対応: 債務0は予約APIを呼ばない設計）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000);
    expect(() => c.reservations.reserve("k0", 0, "何か", "u1")).toThrow(ReservationInputError);
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
    // スロットは1セット（有料 + フリースピン1回）ぶん = 995,050
    const per = model.maxHouseLiability(ctx(bet));

    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (c.reservations.reserve(`k${i}`, per, "スロット", `u${i}`).ok) accepted++;
    }
    // house 100万では1件で埋まる
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
    seed(c.db, HOUSE_HOLDER, 1_200_000);
    // スロットは1セット（有料 + フリースピン1回）で予約する。賭け 5,000 なら 995,050
    const small = slotsLiability.maxHouseLiability(ctx(5_000));
    expect(small).toBe(995_050);
    expect(c.reservations.reserve("small", small, "スロット", "u1").ok).toBe(true);
    const big = slotsLiability.maxHouseLiability(ctx(10_000));
    const r = c.reservations.reserve("big", big, "スロット", "u2");
    expect(r.ok).toBe(false);
    expect(r.available).toBe(1_200_000 - small);
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

/**
 * レビュー指摘: 予約を取った処理が、自分で確保した枠に弾かれないこと。
 * `available()` は全予約を引くので、そのままだと自己予約まで「利用不可」になる。
 */
describe("availableIncludingOwn（自己予約を支払保証として使う）", () => {
  it("自分の予約ぶんだけ戻し、他人の予約は引いたまま", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("mine", 700_000, "スロット", "u1");
    c.reservations.reserve("theirs", 200_000, "ポーカー", "u2");

    expect(c.reservations.available()).toBe(100_000);
    expect(c.reservations.availableIncludingOwn("mine")).toBe(800_000);
    expect(c.reservations.availableIncludingOwn("theirs")).toBe(300_000);
    // 知らない鍵は available と同じ（自己予約なし）
    expect(c.reservations.availableIncludingOwn("unknown")).toBe(100_000);
    c.db.close();
  });

  it("解放後は自己予約ぶんが戻らない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("mine", 700_000, "スロット", "u1");
    c.reservations.release("mine");
    expect(c.reservations.availableIncludingOwn("mine")).toBe(1_000_000);
    c.db.close();
  });
});

/**
 * レビュー指摘: JP積立を含む house からのすべての流出が、
 * 他人の予約済み資金を侵食しないこと。
 */
describe("JP積立を含めても予約済み資金を侵食しない", () => {
  it("2件の予約が並び、片方が最大配当+JP積立を出しても、もう片方も満額払える", () => {
    const c = setup();
    const bet = 1_000;
    const need = slotsLiability.maxHouseLiability(ctx(bet));
    seed(c.db, HOUSE_HOLDER, need * 2);
    seed(c.db, "a", 100_000);
    seed(c.db, "b", 100_000);

    expect(c.reservations.reserve("a", need, "スロット", "a").ok).toBe(true);
    expect(c.reservations.reserve("b", need, "スロット", "b").ok).toBe(true);
    expect(c.reservations.available()).toBe(0);

    const jpCut = slotsJackpotCutFor(bet);
    // a が最大配当 + JP積立
    const ra = c.casino.settle("a", "スロット", bet, bet * SLOT_MAX_PAYOUT_MULT, jpCut, {
      chain: false, fuku: false, operationId: "a1", reservationKey: "a",
    });
    expect(ra.jackpotContributed).toBe(jpCut);
    expect(ra.jackpotUnfunded).toBe(0);

    // b も最大配当 + JP積立を全額払える
    const rb = c.casino.settle("b", "スロット", bet, bet * SLOT_MAX_PAYOUT_MULT, jpCut, {
      chain: false, fuku: false, operationId: "b1", reservationKey: "b",
    });
    expect(rb.payout).toBe(bet * SLOT_MAX_PAYOUT_MULT);
    expect(rb.jackpotUnfunded).toBe(0);

    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBeGreaterThanOrEqual(0);
    c.db.close();
  });

  it("JP積立が払えなかったら黙って飛ばさず記録する", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 0);
    seed(c.db, "u1", 100_000);
    // 賭け金の回収で house は bet になるが、配当で全部出ていくので積立が払えない
    const r = c.casino.settle("u1", "スロット", 1_000, 1_000, 500, {
      chain: false, fuku: false, operationId: "op1",
    });
    expect(r.jackpotContributed).toBe(0);
    expect(r.jackpotUnfunded).toBe(500);
    const logged = c.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'casino_house_insufficient'")
      .get() as { n: number };
    expect(logged.n).toBe(1);
    c.db.close();
  });
});

/**
 * レビュー指摘: 同じ鍵の予約が既にあるとき、要求額・ゲーム・利用者を比較せず
 * 成功扱いにしていた。呼び出し側が「要求どおり取れた」と誤解して状態を復元できてしまう。
 */
describe("同じ予約鍵は内容まで一致したときだけ冪等成功", () => {
  it("同じ鍵・同じ内容は冪等成功で、保存済みの行が返る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const first = c.reservations.reserve("k1", 30_000, "スロット", "u1");
    const again = c.reservations.reserve("k1", 30_000, "スロット", "u1");

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    expect(again.row?.amount).toBe(30_000);
    expect(again.row?.game).toBe("スロット");
    expect(again.row?.userId).toBe("u1");
    expect(c.reservations.totalReserved()).toBe(30_000);
    c.db.close();
  });

  it("同じ鍵・異なる amount は拒否する（資金も予約も動かない）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("k1", 15_000, "ブラックジャック", "u1");

    expect(() => c.reservations.reserve("k1", 20_000, "ブラックジャック", "u1")).toThrow(ReservationConflictError);
    expect(c.reservations.get("k1")!.amount).toBe(15_000);
    expect(c.reservations.totalReserved()).toBe(15_000);
    c.db.close();
  });

  it("同じ鍵・異なる game は拒否する", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("k1", 15_000, "スロット", "u1");
    expect(() => c.reservations.reserve("k1", 15_000, "ポーカー", "u1")).toThrow(ReservationConflictError);
    expect(c.reservations.get("k1")!.game).toBe("スロット");
    c.db.close();
  });

  it("同じ鍵・異なる userId は拒否する", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("k1", 15_000, "スロット", "u1");
    expect(() => c.reservations.reserve("k1", 15_000, "スロット", "u2")).toThrow(ReservationConflictError);
    expect(c.reservations.get("k1")!.userId).toBe("u1");
    c.db.close();
  });

  it("同じ鍵を何度実行しても、全呼出が同じ保存結果を受け取る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const results = Array.from({ length: 20 }, () => c.reservations.reserve("k1", 40_000, "スロット", "u1"));
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.row?.amount).toBe(40_000);
      expect(r.row?.key).toBe("k1");
    }
    expect(c.reservations.count()).toBe(1);
    expect(c.reservations.totalReserved()).toBe(40_000);
    c.db.close();
  });

  it("余力不足は conflict ではなく capacity として返る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 10_000);
    const r = c.reservations.reserve("k1", 20_000, "スロット", "u1");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("capacity");
    expect(r.available).toBe(10_000);
    c.db.close();
  });
});

/**
 * マージ直前レビュー対応: ルーレットの張り増し・張り直しのように、既存の予約額を
 * 「一旦解放してから取り直す」と、その隙に他の予約へ枠を取られる。
 * `resize()` は既存額と available の再確認・書き込みを同一トランザクションで行う。
 */
describe("resize（既存予約の原子的な増減）", () => {
  it("新規keyへのresizeはreserveと同じ新規予約になる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const r = c.reservations.resize("k1", 30_000, "ルーレット", "u1");
    expect(r.ok).toBe(true);
    expect(r.row?.amount).toBe(30_000);
    expect(c.reservations.totalReserved()).toBe(30_000);
    c.db.close();
  });

  it("増額: 差額ぶんの余力があれば通る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    c.reservations.reserve("k1", 30_000, "ルーレット", "u1");
    const r = c.reservations.resize("k1", 50_000, "ルーレット", "u1");
    expect(r.ok).toBe(true);
    expect(r.row?.amount).toBe(50_000);
    expect(c.reservations.totalReserved()).toBe(50_000);
    c.db.close();
  });

  it("増額: 差額ぶんの余力が無ければ断り、元の額のまま", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 40_000);
    c.reservations.reserve("k1", 30_000, "ルーレット", "u1");
    // 余力は 10,000 しか無いので +30,000 は通らない
    const r = c.reservations.resize("k1", 60_000, "ルーレット", "u1");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("capacity");
    expect(r.available).toBe(10_000);
    expect(c.reservations.get("k1")!.amount).toBe(30_000); // 変わっていない
    expect(c.reservations.totalReserved()).toBe(30_000);
    c.db.close();
  });

  it("減額は必ず成功し、差額が即座に available へ戻る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    c.reservations.reserve("k1", 80_000, "ルーレット", "u1");
    expect(c.reservations.available()).toBe(20_000);
    const r = c.reservations.resize("k1", 30_000, "ルーレット", "u1");
    expect(r.ok).toBe(true);
    expect(r.row?.amount).toBe(30_000);
    expect(c.reservations.available()).toBe(70_000);
    c.db.close();
  });

  it("0へのresizeは行を削除する（releaseと同じ効果）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    c.reservations.reserve("k1", 50_000, "ルーレット", "u1");
    const r = c.reservations.resize("k1", 0, "ルーレット", "u1");
    expect(r.ok).toBe(true);
    expect(r.row).toBeUndefined();
    expect(c.reservations.get("k1")).toBeUndefined();
    expect(c.reservations.available()).toBe(100_000);
    c.db.close();
  });

  it("game/userIdが食い違うとConflictで、額は変わらない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    c.reservations.reserve("k1", 30_000, "ルーレット", "u1");
    expect(() => c.reservations.resize("k1", 40_000, "ルーレット", "u2")).toThrow(ReservationConflictError);
    expect(() => c.reservations.resize("k1", 40_000, "スロット", "u1")).toThrow(ReservationConflictError);
    expect(c.reservations.get("k1")!.amount).toBe(30_000);
    c.db.close();
  });

  it("同額へのresizeは冪等（何も変わらない）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    c.reservations.reserve("k1", 30_000, "ルーレット", "u1");
    const r = c.reservations.resize("k1", 30_000, "ルーレット", "u1");
    expect(r.ok).toBe(true);
    expect(c.reservations.totalReserved()).toBe(30_000);
    c.db.close();
  });

  it("不正な入力（空key/game/userId・負数・NaN・小数・unsafe integer）は例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    c.reservations.reserve("k1", 10_000, "ルーレット", "u1");
    expect(() => c.reservations.resize("", 10_000, "ルーレット", "u1")).toThrow(ReservationInputError);
    expect(() => c.reservations.resize("k1", 10_000, "", "u1")).toThrow(ReservationInputError);
    expect(() => c.reservations.resize("k1", 10_000, "ルーレット", "")).toThrow(ReservationInputError);
    for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => c.reservations.resize("k1", bad, "ルーレット", "u1"), `amount=${bad}`).toThrow(ReservationInputError);
    }
    expect(c.reservations.get("k1")!.amount).toBe(10_000); // どれも元の額を変えていない
    c.db.close();
  });
});

/**
 * マージ直前レビュー対応: key は元々検証していたが game / userId は素通りしていた。
 * 空文字が通ると、誰の・何の予約か分からない行が作れてしまう（fail-closed 化）。
 */
describe("予約APIの入力検証（マージ直前レビュー対応）", () => {
  it("key が空文字・空白のみは例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    expect(() => c.reservations.reserve("", 1_000, "スロット", "u1")).toThrow(ReservationInputError);
    expect(() => c.reservations.reserve("   ", 1_000, "スロット", "u1")).toThrow(ReservationInputError);
    expect(c.reservations.count()).toBe(0);
    c.db.close();
  });

  it("game が空文字・空白のみは例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    expect(() => c.reservations.reserve("k1", 1_000, "", "u1")).toThrow(ReservationInputError);
    expect(() => c.reservations.reserve("k1", 1_000, "   ", "u1")).toThrow(ReservationInputError);
    expect(c.reservations.count()).toBe(0);
    c.db.close();
  });

  it("userId が空文字・空白のみは例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    expect(() => c.reservations.reserve("k1", 1_000, "スロット", "")).toThrow(ReservationInputError);
    expect(() => c.reservations.reserve("k1", 1_000, "スロット", "   ")).toThrow(ReservationInputError);
    expect(c.reservations.count()).toBe(0);
    c.db.close();
  });

  it("amount に 0・負数・小数・NaN・Infinity・unsafe integer を渡すと例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const bad = [0, -1, -100, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
    for (const amount of bad) {
      expect(() => c.reservations.reserve(`k-${amount}`, amount, "スロット", "u1"), `amount=${amount}`).toThrow(
        ReservationInputError,
      );
    }
    expect(c.reservations.count()).toBe(0);
    c.db.close();
  });

  it("amount=Number.MAX_SAFE_INTEGER ちょうどは入力として通り、余力不足なら capacity で断る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const r = c.reservations.reserve("k-max", Number.MAX_SAFE_INTEGER, "スロット", "u1");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("capacity");
    c.db.close();
  });

  it("totalReserved は DB 内の破損した合計（safe integer を超える SUM）を例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    // 正規の reserve() を経由せず、テーブルへ直接 safe integer 超えの行を仕込む
    // （DB 破損・手動編集・別プロセスのバグ等を模す）
    c.db
      .prepare(
        "INSERT INTO casino_house_reservations (key, amount, game, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("corrupt", Number.MAX_SAFE_INTEGER, "スロット", "u1", Math.floor(Date.now() / 1000));
    c.db
      .prepare(
        "INSERT INTO casino_house_reservations (key, amount, game, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("corrupt2", Number.MAX_SAFE_INTEGER, "スロット", "u2", Math.floor(Date.now() / 1000));
    expect(() => c.reservations.totalReserved()).toThrow(ReservationInputError);
    expect(() => c.reservations.available()).toThrow(ReservationInputError);
    c.db.close();
  });
});
