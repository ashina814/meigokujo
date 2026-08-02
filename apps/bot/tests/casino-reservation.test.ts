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
  Vip,
  liabilityModelFor,
  openDb,
  registerDefaultTxTypes,
  scriptedRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import {
  MAX_BET,
  MIN_BET,
  capacityRecoveryPayload,
  configuredMaxBet,
  effectiveMaxBet,
  liabilityCtx,
  reserveBlackjackLiability,
  reserveHouseLiability,
  reserveSlotsLiability,
  HouseCapacityError,
} from "../src/casino/common.js";
import { isCasinoPlayButton } from "../src/casino/play-route.js";
import { isCasinoInteraction } from "../src/casino/gate.js";

registerDefaultTxTypes();

/**
 * PR5 の bot 側。表示上限・押せる金額の提示・ブラックジャックのダブル制御を見る。
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
  const vip = new Vip(db, ether, events);
  const services = { db, ether, casino, items, vip, reservations, events, rng: scriptedRng([0.5]) } as unknown as Services;
  return { db, ether, casino, items, vip, reservations, services };
}

function seed(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

const makeVip = (db: ReturnType<typeof openDb>, uid: string) =>
  db.prepare("INSERT INTO casino_vip (user_id, expires_at) VALUES (?, ?)").run(uid, 4_102_444_800);

describe("effectiveMaxBet は VIP・胴元残高・ゲーム倍率の3つを反映する", () => {
  it("胴元が潤沢なら設定上限（VIPなら×2）で頭打ち", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000_000_000);
    makeVip(c.db, "vipper");
    expect(effectiveMaxBet(c.services, "normal", "丁半")).toBe(MAX_BET);
    expect(effectiveMaxBet(c.services, "vipper", "丁半")).toBe(MAX_BET * 2);
  });

  it("胴元が細ればゲームの最大倍率で割った額まで下がる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    // スロットは100倍。同じ余力でもポーカー（251倍）のほうが小さくなる
    const slots = effectiveMaxBet(c.services, "u1", "スロット");
    const poker = effectiveMaxBet(c.services, "u1", "ポーカー");
    expect(slots).toBeLessThan(configuredMaxBet(c.services, "u1"));
    expect(poker).toBeLessThan(slots);
    expect(poker).toBeGreaterThan(0);
  });

  it("他人の予約が入ると自分の上限も下がる（同じ余力を奪い合う）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 10_000_000);
    const before = effectiveMaxBet(c.services, "u1", "スロット");
    c.reservations.reserve("other", 9_000_000, "スロット", "u2");
    const after = effectiveMaxBet(c.services, "u1", "スロット");
    expect(after).toBeLessThan(before);
  });

  it("連勝中は連鎖ぶん債務が増えるので上限が下がる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const cold = effectiveMaxBet(c.services, "u1", "スロット");
    // 5連勝の状態を作る
    c.db
      .prepare("INSERT INTO casino_stats (user_id, current_win_streak, updated_at) VALUES ('u1', 5, 1)")
      .run();
    const hot = effectiveMaxBet(c.services, "u1", "スロット");
    expect(hot).toBeLessThan(cold);
  });

  it("ゲーム名を渡さなければ設定上限だけを返す", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1); // 胴元は空でも
    expect(effectiveMaxBet(c.services, "u1")).toBe(MAX_BET);
  });
});

describe("提示された金額は必ず予約できる（正本 §5.4 ③）", () => {
  it("どのゲームでも、提示額ちょうどなら通り、+1 なら通らない", () => {
    const c = setup();
    // 胴元をわざと細らせて、設定上限ではなく胴元の余力が縛る状態にする
    seed(c.db, HOUSE_HOLDER, 4_000_000);
    for (const game of ["スロット", "クラッシュ", "チンチロ", "ブラックジャック", "ポーカー", "ホールデム", "丁半"]) {
      const uid = `u_${game}`;
      const offered = effectiveMaxBet(c.services, uid, game);
      expect(offered, game).toBeGreaterThanOrEqual(MIN_BET);
      const model = liabilityModelFor(game)!;
      const ctx = liabilityCtx(c.services, uid);
      expect(model.maxHouseLiability({ ...ctx, bet: offered }), game).toBeLessThanOrEqual(c.reservations.available());
      // 胴元の余力が縛っている場合だけ「+1 は通らない」が成り立つ
      // （設定上限で頭打ちのときは、胴元にはまだ余裕がある）
      if (offered < configuredMaxBet(c.services, uid)) {
        expect(model.maxHouseLiability({ ...ctx, bet: offered + 1 }), game).toBeGreaterThan(c.reservations.available());
      }
    }
  });

  it("提示した額で実際に予約が取れる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 2_000_000);
    const offered = effectiveMaxBet(c.services, "u1", "スロット");
    expect(() => reserveHouseLiability(c.services, "スロット", "u1", offered, "op1")).not.toThrow();
    expect(c.reservations.count()).toBe(1);
  });

  it("余力を超える賭けは HouseCapacityError で断る（予約行は残らない）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000);
    expect(() => reserveHouseLiability(c.services, "スロット", "u1", 500_000, "op1")).toThrow(HouseCapacityError);
    expect(c.reservations.count()).toBe(0);
  });
});

describe("押せる金額の提示画面", () => {
  it("上限・半分・最低の3つを casino:play: ボタンで出す", () => {
    const c = setup();
    const payload = capacityRecoveryPayload(c.services, 4_000, "スロット");
    expect(payload.content).toContain("4,000");
    const ids = payload.components[0]!.components.map((b) => b.toJSON().custom_id);
    expect(ids).toEqual(["casino:play:スロット:4000", "casino:play:スロット:2000", `casino:play:スロット:${MIN_BET}`]);
    for (const id of ids) expect(isCasinoPlayButton(id!)).toBe(true);
  });

  it("最低賭け額にも届かないなら運営への案内だけ出す", () => {
    const c = setup();
    const payload = capacityRecoveryPayload(c.services, MIN_BET - 1, "スロット");
    expect(payload.components).toEqual([]);
    expect(payload.content).toContain("資金投入");
  });

  it("重複する額はまとめる（上限が最低額と同じとき）", () => {
    const c = setup();
    const ids = capacityRecoveryPayload(c.services, MIN_BET, "丁半").components[0]!.components.map(
      (b) => b.toJSON().custom_id,
    );
    expect(ids).toEqual([`casino:play:丁半:${MIN_BET}`]);
  });

  it("復帰ボタンは賭場の停止ガードの対象に入っている", () => {
    const fake = { isChatInputCommand: () => false, customId: "casino:play:スロット:500" } as never;
    expect(isCasinoInteraction(fake)).toBe(true);
  });
});

describe("ブラックジャックのダブルは予約が取れたときだけ", () => {
  it("余力が十分ならダブル込みで予約する", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const r = reserveBlackjackLiability(c.services, "u1", 10_000, "op1");
    expect(r.doubleAllowed).toBe(true);
    expect(r.amount).toBe(liabilityModelFor("ブラックジャック")!.maxHouseLiability({ ...liabilityCtx(c.services, "u1"), bet: 10_000 }));
  });

  it("ダブル分が取れないときはダブル無しで予約し、手は続行できる", () => {
    const c = setup();
    // ダブル込み（4×bet − 2×bet = 2×bet）は無理だが、ダブル無し（2.5×bet − bet = 1.5×bet）なら足りる余力
    const bet = 10_000;
    seed(c.db, HOUSE_HOLDER, 16_000);
    const r = reserveBlackjackLiability(c.services, "u1", bet, "op1");
    expect(r.doubleAllowed).toBe(false);
    expect(r.amount).toBe(15_000);
    expect(c.reservations.count()).toBe(1);
  });

  it("ダブル無しでも足りなければ手ごと断る", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000);
    expect(() => reserveBlackjackLiability(c.services, "u1", 10_000, "op1")).toThrow(HouseCapacityError);
    expect(c.reservations.count()).toBe(0);
  });
});

describe("スロットはフリースピンぶんまで予約する", () => {
  it("有料スピン + フリースピン1回の最悪ケースを1つの予約で押さえる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000_000);
    const bet = 1_000;
    const paid = liabilityModelFor("スロット")!.maxHouseLiability({ ...liabilityCtx(c.services, "u1"), bet });
    const r = reserveSlotsLiability(c.services, "u1", bet, "int-1");
    // フリースピンは賭け金を取らないので、回収ぶん（bet）を戻した額が上乗せされる
    expect(r.amount).toBe(paid + paid + bet);
    expect(r.key).toBe("slots:reserve:u1:int-1");
  });

  it("精算グループ鍵とは別の鍵にする（有料スピンの精算で解放されないように）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000_000);
    seed(c.db, "u1", 100_000);
    const r = reserveSlotsLiability(c.services, "u1", 1_000, "int-1");
    expect(r.key).not.toBe("solo:スロット:u1:int-1:paid");
    // 有料スピンの精算が通っても予約は残る（フリースピンがまだ走りうる）
    c.services.casino.settleSolo("u1", "スロット", 1_000, 0, {
      operationId: "int-1:paid",
      reservationKey: "solo:スロット:u1:int-1:paid",
    });
    expect(c.reservations.get(r.key)).toBeDefined();
  });
});
