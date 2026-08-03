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
  Vip,
  ChipLedgerError as EtherError,
  FreeSpins,
  TREASURY,
  SLOT_MAX_PAYOUT_MULT,
  deptAccount,
  liabilityModelFor,
  slotsJackpotCutFor,
  slotsPaidSpinLiability,
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
  reserveFreeSpinLiability,
  reserveHouseLiability,
  reserveSlotsLiability,
  HouseCapacityError,
  UnknownLiabilityModelError,
} from "../src/casino/common.js";
import { resolveFreeSpin, resumeFreeSpin, spinPaid } from "../src/casino/slots.js";
import { isCasinoPlayButton } from "../src/casino/play-route.js";
import { isCasinoInteraction } from "../src/casino/gate.js";

registerDefaultTxTypes();

/**
 * PR5 の bot 側。表示上限・押せる金額の提示・ブラックジャックのダブル制御を見る。
 */

function setup(rng = scriptedRng([0.5])) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new ChipLedger(db, ledger, events, { chipTx, requireOpeningV1: false });
  const items = new Items(db);
  const reservations = new HouseReservations(db, ether, events);
  // 本番（services.ts）と同じ配線。売上精算も予約分は出せない
  ether.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const casino = new Casino(db, ether, events, { items, reservations });
  const vip = new Vip(db, ether, events);
  const freeSpins = new FreeSpins(db);
  const services = { db, ether, casino, items, vip, reservations, freeSpins, events, rng } as unknown as Services;
  return { db, ledger, ether, casino, items, vip, reservations, freeSpins, services };
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
  it("予約額はモデル（有料 + フリースピン1回）そのもの", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100_000_000);
    const bet = 1_000;
    const ctx = { ...liabilityCtx(c.services, "u1"), bet };
    const model = liabilityModelFor("スロット")!;
    const r = reserveSlotsLiability(c.services, "u1", bet, "int-1");

    // 上限表示・事前検証・予約 INSERT が同じ1つの式を通る（PR5 レビュー指摘）
    expect(r.amount).toBe(model.maxHouseLiability(ctx));
    // 内訳: 有料スピンの純債務（JP積立込み） + フリースピンの丸ごと支払い
    expect(r.amount).toBe(slotsPaidSpinLiability.maxHouseLiability(ctx) + bet * SLOT_MAX_PAYOUT_MULT);
    expect(r.key).toBe("slots:reserve:u1:int-1");
  });

  /**
   * レビュー指摘の本体。「表示された上限では予約が取れない」が起きないことを、
   * 提示額ちょうど / +1 の両方で押さえる。
   */
  it("提示された最大額はちょうど予約でき、+1 は予約できない", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 3_000_000);
    seed(c.db, "u1", 100_000_000);

    const max = effectiveMaxBet(c.services, "u1", "スロット");
    expect(max).toBeGreaterThan(MIN_BET);

    // ちょうどなら通る
    const ok = reserveSlotsLiability(c.services, "u1", max, "int-max");
    expect(ok.amount).toBeGreaterThan(0);
    c.reservations.release(ok.key);

    // +1 は通らない
    expect(() => reserveSlotsLiability(c.services, "u1", max + 1, "int-over")).toThrow(HouseCapacityError);
    expect(c.reservations.get("slots:reserve:u1:int-over")).toBeUndefined();
  });

  it("house 100万・賭け5,000 では同時1人しか受けられない", () => {
    // PR本文にあった「5,000なら495,000予約、同時2人」の訂正（レビュー指摘）。
    // 実際はフリースピンぶんを足して 995,050 なので、100万では1人で埋まる
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const bet = 5_000;
    const first = reserveSlotsLiability(c.services, "u1", bet, "int-1");
    expect(first.amount).toBe(995_050);
    expect(() => reserveSlotsLiability(c.services, "u2", bet, "int-2")).toThrow(HouseCapacityError);
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

/**
 * レビュー指摘: 予約を取った処理は、その予約の範囲内で払えなければならない。
 * `canAccept` は全予約を house 残高から引くので、自分で確保した枠まで
 * 「利用不可」と数えてしまい、十分な予約があるのに未払いになっていた。
 */
describe("自分の予約は支払保証として使える", () => {
  it("availableIncludingOwn は自己予約ぶんを戻す", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    c.reservations.reserve("own", 900_000, "スロット", "u1");
    c.reservations.reserve("other", 50_000, "ポーカー", "u2");

    expect(c.reservations.available()).toBe(50_000);
    // 自分の 900,000 は使ってよい（他人の 50,000 は使えない）
    expect(c.reservations.availableIncludingOwn("own")).toBe(950_000);
    // 知らない鍵なら available と同じ
    expect(c.reservations.availableIncludingOwn("nope")).toBe(50_000);
  });

  it("予約済みのフリースピンは自分の枠から満額払われる", () => {
    // 魂片3つ → フリースピンで王冠3つ（25倍）
    const c = setup(scriptedRng([0.98, 0.98, 0.98, 0.85, 0.85, 0.85]));
    const bet = 1_000;
    seed(c.db, "u1", 100_000);
    // 有料スピン + フリースピンぶんちょうどしか無い胴元（余裕は1 Ldも無い）
    const need = liabilityModelFor("スロット")!.maxHouseLiability({ ...liabilityCtx(c.services, "u1"), bet });
    seed(c.db, HOUSE_HOLDER, need);
    const res = reserveSlotsLiability(c.services, "u1", bet, "int-1");
    expect(res.amount).toBe(need);
    // この時点で available() は 0。予約鍵を渡さなければフリースピンは払えない判定になる
    expect(c.reservations.available()).toBe(0);

    const paid = spinPaid(c.services, "u1", bet, "int-1");
    const before = c.ether.balanceOf("u1");
    const free = resolveFreeSpin(c.services, paid.pendingFreeSpin!, res.key);

    expect(free.payout).toBe(bet * 25);
    expect(c.ether.balanceOf("u1")).toBe(before + bet * 25);
  });
});

/**
 * レビュー指摘: 進行中ゲームの予約があっても house 全残高を売上精算できてしまい、
 * 予約が支払保証になっていなかった。UI ではなく資金処理層で止める。
 */
describe("売上精算は予約済み資金を抜けない", () => {
  const DEPT = deptAccount("賭博場");

  function fundedHouse(houseAmount: number) {
    const c = setup();
    c.ledger.ensureAccount(DEPT, "system");
    c.ledger.transfer({
      from: TREASURY, to: DEPT, amount: houseAmount, type: "adjust", actor: "t", approvedBy: "t",
      idempotencyKey: `seed:dept:${houseAmount}`,
    });
    c.ether.fundFromAccount(DEPT, houseAmount, HOUSE_HOLDER, "fund:test");
    return c;
  }

  it("予約中は全額精算を要求しても予約分が残る", () => {
    const c = fundedHouse(1_000_000);
    const house = c.ether.balanceOf(HOUSE_HOLDER);
    c.reservations.reserve("live", 400_000, "スロット", "u1");

    expect(c.ether.settleableBalance(HOUSE_HOLDER)).toBe(house - 400_000);
    expect(() => c.ether.redeemFairToAccount(HOUSE_HOLDER, house, DEPT, "settle:all")).toThrow(EtherError);
    // 1 Ld も動いていない
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(house);
  });

  it("精算可能額ちょうどは通り、+1 は拒否される", () => {
    const c = fundedHouse(1_000_000);
    const house = c.ether.balanceOf(HOUSE_HOLDER);
    c.reservations.reserve("live", 400_000, "スロット", "u1");
    const settleable = c.ether.settleableBalance(HOUSE_HOLDER);

    expect(() => c.ether.redeemFairToAccount(HOUSE_HOLDER, settleable + 1, DEPT, "settle:over")).toThrow(EtherError);
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(house);

    c.ether.redeemFairToAccount(HOUSE_HOLDER, settleable, DEPT, "settle:exact");
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(400_000);
  });

  it("精算後も予約済みゲームの最大配当を払える", () => {
    const c = fundedHouse(1_000_000);
    seed(c.db, "u1", 100_000);
    const bet = 2_000;
    const res = reserveHouseLiability(c.services, "丁半", "u1", bet, "op-1");

    // 精算できるだけ精算する
    const settleable = c.ether.settleableBalance(HOUSE_HOLDER);
    if (settleable > 0) c.ether.redeemFairToAccount(HOUSE_HOLDER, settleable, DEPT, "settle:max");

    // それでも予約した最大配当は払える
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBeGreaterThanOrEqual(res.amount);
    const r = c.services.casino.settleSolo("u1", "丁半", bet, Math.floor(bet * 1.94), {
      chain: false,
      fuku: false,
      operationId: "op-1",
      reservationKey: res.key,
    });
    expect(r.payout).toBeGreaterThan(bet);
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBeGreaterThanOrEqual(0);
  });

  it("予約が無ければ従来どおり全額戻せる", () => {
    const c = fundedHouse(1_000_000);
    const house = c.ether.balanceOf(HOUSE_HOLDER);
    c.ether.redeemFairToAccount(HOUSE_HOLDER, house, DEPT, "settle:all");
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(0);
  });
});

/**
 * PR8監査・ブロッカーB: `redeemFairToAccount` はdeprecatedであり、新規コードは
 * `redeemToAccount` を使う案内になっている。予約保護は新APIそのものが持つことを、
 * 上のdescribeとは別に明示的な `redeemToAccount` 呼び出しで固定する。
 */
describe("redeemToAccount自身が予約済み資金を抜けない（新API）", () => {
  const DEPT = deptAccount("賭博場");

  function fundedHouse(houseAmount: number) {
    const c = setup();
    c.ledger.ensureAccount(DEPT, "system");
    c.ledger.transfer({
      from: TREASURY, to: DEPT, amount: houseAmount, type: "adjust", actor: "t", approvedBy: "t",
      idempotencyKey: `seed:dept2:${houseAmount}`,
    });
    c.ether.fundFromAccount(DEPT, houseAmount, HOUSE_HOLDER, "fund:test2");
    return c;
  }

  it("house残高100・予約80で、21は拒否・20は成功し、予約は維持される", () => {
    const c = fundedHouse(100);
    c.reservations.reserve("live-game", 80, "スロット", "u1");
    const poolBefore = c.ledger.balanceOf(c.ether.reserveHolder());

    expect(() => c.ether.redeemToAccount(HOUSE_HOLDER, 21, DEPT, "test:redeem", "settle:21")).toThrow(EtherError);
    let error: unknown;
    try {
      c.ether.redeemToAccount(HOUSE_HOLDER, 21, DEPT, "test:redeem", "settle:21-check");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EtherError);
    expect((error as { code: string }).code).toBe("ERR_RESERVED_FUNDS");
    // 予約80は維持、house残高もLand準備口座も動いていない
    expect(c.reservations.totalReserved()).toBe(80);
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(100);
    expect(c.ledger.balanceOf(c.ether.reserveHolder())).toBe(poolBefore);

    // ちょうど精算可能額（20）は成功する
    c.ether.redeemToAccount(HOUSE_HOLDER, 20, DEPT, "test:redeem", "settle:20");
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(80);
    expect(c.reservations.totalReserved()).toBe(80);
    expect(c.ledger.balanceOf(c.ether.reserveHolder())).toBe(poolBefore - 20);

    // house残高が負にならない・予約済みゲームがその後80を全額支払える
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBeGreaterThanOrEqual(0);
    expect(c.ether.settleableBalance(HOUSE_HOLDER)).toBe(0);
    c.ether.runGroup({ groupKey: "test:payout", kind: "solo_game", actorId: "u1" }, () =>
      c.ether.transfer(HOUSE_HOLDER, "u1", 80, { reason: "予約済みゲームの配当", game: "スロット" }),
    );
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(0);
  });

  it("同じ冪等キーで再実行しても二重精算しない", () => {
    const c = fundedHouse(100);
    const before = c.ether.balanceOf(HOUSE_HOLDER);
    const poolBefore = c.ledger.balanceOf(c.ether.reserveHolder());
    const first = c.ether.redeemToAccount(HOUSE_HOLDER, 30, DEPT, "test:redeem", "settle:idem");
    const second = c.ether.redeemToAccount(HOUSE_HOLDER, 30, DEPT, "test:redeem", "settle:idem");
    expect(second).toEqual(first);
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(before - 30);
    expect(c.ledger.balanceOf(c.ether.reserveHolder())).toBe(poolBefore - 30);
  });
});

/**
 * レビュー指摘: JP積立を含む house からのすべての流出が、
 * 他人の予約済み資金を侵食しないこと。
 */
describe("JP積立と予約が競合しない", () => {
  it("2件の予約が並ぶ状況で、片方が最大配当+JP積立を出しても、もう片方も満額払える", () => {
    const c = setup();
    seed(c.db, "a", 1_000_000);
    seed(c.db, "b", 1_000_000);
    const bet = 1_000;

    // 2人ぶんの予約がちょうど収まる house
    const ctxA = { ...liabilityCtx(c.services, "a"), bet };
    const need = liabilityModelFor("スロット")!.maxHouseLiability(ctxA);
    seed(c.db, HOUSE_HOLDER, need * 2);

    const ra = reserveSlotsLiability(c.services, "a", bet, "int-a");
    const rb = reserveSlotsLiability(c.services, "b", bet, "int-b");
    expect(c.reservations.available()).toBe(0);

    // a が最大配当（マモン³ 100倍）+ JP積立を実行
    c.services.casino.settleSolo("a", "スロット", bet, bet * SLOT_MAX_PAYOUT_MULT, {
      chain: false,
      fuku: false,
      operationId: "int-a:paid",
      jackpotCut: slotsJackpotCutFor(bet),
    });
    // JP積立が黙って飛ばされていない
    expect(c.ether.balanceOf("jackpot")).toBe(slotsJackpotCutFor(bet));

    // b も最大配当を全額払える
    c.reservations.release(ra.key);
    const settled = c.services.casino.settleSolo("b", "スロット", bet, bet * SLOT_MAX_PAYOUT_MULT, {
      chain: false,
      fuku: false,
      operationId: "int-b:paid",
      jackpotCut: slotsJackpotCutFor(bet),
      reservationKey: rb.key,
    });
    expect(settled.payout).toBe(bet * SLOT_MAX_PAYOUT_MULT);
    expect(settled.jackpotUnfunded).toBe(0);
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBeGreaterThanOrEqual(0);
  });
});

/**
 * レビュー指摘の本体。ダブル無しで予約になった操作を再実行したとき、
 * 要求額（ダブル込み）ではなく**保存済みの額**から doubleAllowed を決める。
 */
describe("ブラックジャックの再実行で doubleAllowed が復元される", () => {
  it("ダブル無し予約になった操作を再実行しても doubleAllowed=false のまま", () => {
    const c = setup();
    const bet = 10_000;
    // ダブル込み（2×bet=20,000）は無理だが、ダブル無し（1.5×bet=15,000）なら足りる
    seed(c.db, HOUSE_HOLDER, 16_000);

    const first = reserveBlackjackLiability(c.services, "u1", bet, "op1");
    expect(first.doubleAllowed).toBe(false);
    expect(first.amount).toBe(15_000);

    // 同じ操作の再実行。要求はダブル込みだが、保存済みは 15,000
    const again = reserveBlackjackLiability(c.services, "u1", bet, "op1");
    expect(again.doubleAllowed).toBe(false);
    expect(again.amount).toBe(15_000);
    expect(c.reservations.get(first.key)!.amount).toBe(15_000);
    expect(c.reservations.count()).toBe(1);
  });

  it("ダブル込みで取れた操作は再実行でも doubleAllowed=true", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const first = reserveBlackjackLiability(c.services, "u1", 10_000, "op1");
    const again = reserveBlackjackLiability(c.services, "u1", 10_000, "op1");
    expect(first.doubleAllowed).toBe(true);
    expect(again).toEqual(first);
  });
});

/**
 * レビュー指摘: 保留中の無料スピンを再開するときは、予約を安全に取り直す。
 * 元の予約は起動時に全解放されている。
 */
describe("保留中の無料スピンは予約を取り直してから払う", () => {
  const REELS = [0.98, 0.98, 0.98, 0.85, 0.85, 0.85]; // 魂片3つ → 王冠3つ（25倍）

  it("再起動で予約が消えていても、取り直して同じ出目で払える", () => {
    const c = setup(scriptedRng(REELS));
    seed(c.db, "u1", 100_000);
    seed(c.db, HOUSE_HOLDER, 10_000_000);
    const bet = 1_000;

    const res = reserveSlotsLiability(c.services, "u1", bet, "int-1");
    const paid = spinPaid(c.services, "u1", bet, "int-1");
    expect(paid.pendingFreeSpin).not.toBeNull();

    // 起動時の全解放（正本 §8.2 S9）
    c.reservations.releaseAll("テストの再起動");
    expect(c.reservations.get(res.key)).toBeUndefined();

    const before = c.ether.balanceOf("u1");
    const free = resumeFreeSpin(c.services, paid.pendingFreeSpin!);
    expect(free.reels).toEqual(paid.pendingFreeSpin!.reels);
    expect(free.payout).toBe(bet * 25);
    expect(c.ether.balanceOf("u1")).toBe(before + bet * 25);
    // 取り直した予約は払い終わったら解放されている
    expect(c.reservations.count()).toBe(0);
  });

  it("取り直す予約が取れないときは権利を残す", () => {
    const c = setup(scriptedRng(REELS));
    seed(c.db, "u1", 100_000);
    seed(c.db, HOUSE_HOLDER, 10_000_000);
    const paid = spinPaid(c.services, "u1", 1_000, "int-1");
    c.reservations.releaseAll("テストの再起動");

    // 胴元を細らせる（確定済み無料スピン配当 25,000 を予約できない）
    seed(c.db, HOUSE_HOLDER, 24_999);
    expect(() => resumeFreeSpin(c.services, paid.pendingFreeSpin!)).toThrow(HouseCapacityError);
    expect(c.freeSpins.get(paid.pendingFreeSpin!.id)!.status).toBe("pending");
    // 取れなかった予約行は残らない
    expect(c.reservations.count()).toBe(0);
  });

  it("外れ（配当0）の無料スピンは予約API自体を呼ばない（マージ直前レビュー対応: amount=0はfail-closed）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    const r = reserveFreeSpinLiability(c.services, { id: 999, userId: "u1", payout: 0 });
    expect(r).toEqual({ key: "slots:freespin:999", amount: 0 });
    expect(c.reservations.count()).toBe(0);
  });
});

/**
 * マージ直前レビュー対応: モデルの無いゲーム名は「設定上限」「予約額0で成功」へ
 * 黙ってフォールバックせず、UnknownLiabilityModelError で fail-closed にする。
 */
describe("未知のゲーム名はfail-closed（マージ直前レビュー対応）", () => {
  it("effectiveMaxBet: game を渡したのにモデルが無ければ例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    expect(() => effectiveMaxBet(c.services, "u1", "存在しないゲーム")).toThrow(UnknownLiabilityModelError);
    expect(() => effectiveMaxBet(c.services, "u1", "")).toThrow(UnknownLiabilityModelError);
    expect(() => effectiveMaxBet(c.services, "u1", "__proto__")).toThrow(UnknownLiabilityModelError);
  });

  it("effectiveMaxBet: game を渡さない呼び出しは例外にせず設定上限を返す（既存の意図的な用途）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    expect(effectiveMaxBet(c.services, "u1")).toBe(configuredMaxBet(c.services, "u1"));
  });

  it("reserveHouseLiability: 未知ゲームは予約額0で成功させず例外にする", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    expect(() => reserveHouseLiability(c.services, "存在しないゲーム", "u1", 1_000, "op1")).toThrow(
      UnknownLiabilityModelError,
    );
    expect(c.reservations.count()).toBe(0);
  });
});
