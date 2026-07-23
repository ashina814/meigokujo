import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino, JACKPOT_HOLDER, RELIEF_HOLDER, chainMultiplier, fukuRate } from "../src/casino/service.js";
import { Items } from "../src/casino/items.js";
import { deptAccount, Departments } from "../src/departments/service.js";

registerDefaultTxTypes();

/**
 * 連鎖・福の重み・お守りの経済メカニクスと総量保存の統合テスト。
 */

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const ether = new EtherExchange(db, ledger, new EventLog(db));
  const casino = new Casino(db, ether, new EventLog(db));
  const items = new Items(db);
  const departments = new Departments(db, ledger);
  departments.upsert("賭博場", "賭博場", null);
  ledger.transfer({ from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
  ether.fundFromAccount(deptAccount("賭博場"), 100_000, HOUSE_HOLDER, "seed:house");
  for (const uid of ["a", "b"]) {
    ledger.ensureAccount(`user:${uid}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${uid}`, amount: 50_000, type: "initial", actor: "t", idempotencyKey: `seed:${uid}` });
    ether.buy(uid, 50_000, `seed:buy:${uid}`);
  }
  return { db, ledger, ether, casino, items };
}

describe("連鎖ボーナス（chain）", () => {
  it("chainMultiplier: 段階が定義通りに切り替わる", () => {
    expect(chainMultiplier(0).mult).toBe(1.0);
    expect(chainMultiplier(1).mult).toBe(1.0);
    expect(chainMultiplier(2).mult).toBeCloseTo(1.05);
    expect(chainMultiplier(3).mult).toBeCloseTo(1.1);
    expect(chainMultiplier(5).mult).toBeCloseTo(1.2);
    expect(chainMultiplier(10).mult).toBeCloseTo(1.5);
    expect(chainMultiplier(20).mult).toBeCloseTo(2.0);
    expect(chainMultiplier(100).mult).toBeCloseTo(2.0); // 20 以降は頭打ち
  });

  it("連勝を積んでいくと胴元収支が悪化していく（プレイヤー期待払戻増）", () => {
    const ctx = setup();
    const house0 = ctx.casino.houseBalance();
    // 5連勝させる: 1000 賭けて 2000 払戻。fuku 適用があると分析が複雑になるので off にする。
    // chainStreak は「この勝ちで何連勝目か」＝現在の勝ち連 +1。1連目から chainMultiplier(1)=1.0。
    for (let i = 0; i < 5; i++) {
      ctx.casino.settle("a", "test", 1_000, 2_000, 0, { chain: true, fuku: false });
    }
    const house1 = ctx.casino.houseBalance();
    // 5 spin 各 -1000 = -5000 の元手ぶん + 連鎖ボーナス
    // chainMultiplier: 1連目=1.0(0), 2連目=1.05(+100), 3連目=1.1(+200), 4連目=1.1(+200), 5連目=1.2(+400)
    // 合計連鎖 = 900。ただし settle 内の Math.floor(2000 * 1.2 * ...) で 1 誤差が出るケースあり
    const diff = house1 - house0;
    // 期待 -5900 前後（floor 誤差 ±5 に収める）
    expect(diff).toBeLessThanOrEqual(-5_895);
    expect(diff).toBeGreaterThanOrEqual(-5_905);
  });

  it("連鎖はエテル総量を保存する（house と player 間の移動だけ）", () => {
    const ctx = setup();
    const total0 = ctx.ether.outstanding();
    for (let i = 0; i < 5; i++) ctx.casino.settle("a", "test", 1_000, 2_000, 0, { chain: true, fuku: false });
    expect(ctx.ether.outstanding()).toBe(total0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("福の重み（fuku）", () => {
  it("fukuRate: しきい値 (scale=10) 通りに切り替わる", () => {
    // scale 10 → 10000ld = 100000◈, 50000ld = 500000◈, ...
    expect(fukuRate(50_000, 10)).toBe(0); // 10,000×10 = 100,000 以下
    expect(fukuRate(100_000, 10)).toBe(0); // 境界: <= 100,000 は 0
    expect(fukuRate(150_000, 10)).toBeCloseTo(0.05); // 10,000×10 < x <= 50,000×10
    expect(fukuRate(500_000, 10)).toBeCloseTo(0.05); // <= 500,000
    expect(fukuRate(600_000, 10)).toBeCloseTo(0.1);
    expect(fukuRate(1_100_000, 10)).toBeCloseTo(0.2);
    expect(fukuRate(4_000_000, 10)).toBeCloseTo(0.3);
  });

  it("勝ち利益への奉納が JP と 救済プールに半々で流れる", () => {
    const ctx = setup();
    // 初期残高: a=500,000◈。payout=20,000 → 勝ち後残高 510,000（10% 帯: 500,000 < x <= 1,000,000）
    // 純益 10,000 × 10% = 1,000 奉納。JP と 救済 が floor(1000/2)=500 ずつ。
    const jp0 = ctx.ether.balanceOf(JACKPOT_HOLDER);
    const relief0 = ctx.ether.balanceOf(RELIEF_HOLDER);
    ctx.casino.settle("a", "test", 10_000, 20_000, 0, { chain: false, fuku: true });
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(jp0 + 500);
    expect(ctx.ether.balanceOf(RELIEF_HOLDER)).toBe(relief0 + 500);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("低残高（しきい値未満）では奉納 0（新規プレイヤー保護）", () => {
    const ctx = setup();
    // b の残高を 100,000 未満まで減らす（fuku scale=10, しきい値100,000）
    // 初期 500,000 → 401,000 を house に送って残 99,000
    ctx.ether.transfer("b", HOUSE_HOLDER, 401_000);
    const jp0 = ctx.ether.balanceOf(JACKPOT_HOLDER);
    // bet 1000, payout 3000 → 純益 +2000。b の勝ち後残高 = 99,000 - 1000 + 3000 = 101,000
    // しきい値 100,000 を超えるので 5% 帯。奉納が発生してしまう。
    // ここは「勝つ前の残高が低い」ではなく「勝った後の残高が低い」で判定される仕様なので、
    // 勝った後も 100,000 以下に収まるように payout を絞る。
    ctx.casino.settle("b", "test", 1_000, 1_500, 0, { chain: false, fuku: true });
    // 勝ち後残高 = 99,000 - 1000 + 1500 = 99,500 ≤ 100,000 → 奉納 0
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(jp0);
  });
});

describe("お守り（amulet）", () => {
  it("福のお守り: 消費で 1回だけ +5% 補正、以後は無効", () => {
    const ctx = setup();
    ctx.items.grant("a", "omamori", 2);
    ctx.items.arm("a", "omamori");
    // 装備中 → 発動 → mult=1.05, 消費で剥がれる
    const r1 = ctx.items.consumeWinBonus("a");
    expect(r1.mult).toBeCloseTo(1.05);
    expect(ctx.items.isArmed("a", "omamori")).toBe(false);
    // 再装備しないと発動しない
    const r2 = ctx.items.consumeWinBonus("a");
    expect(r2.mult).toBe(1);
    // 在庫はまだ 1 残っている（arm で消費した分だけ）
    expect(ctx.items.qty("a", "omamori")).toBe(1);
  });

  it("庇護 > 保険 の優先順位で発動する", () => {
    const ctx = setup();
    ctx.items.grant("a", "hoken", 1);
    ctx.items.grant("a", "higo", 1);
    ctx.items.arm("a", "hoken");
    ctx.items.arm("a", "higo");
    const r = ctx.items.consumeLossProtection("a");
    // 庇護（power 1.0）が優先
    expect(r.refundRate).toBe(1.0);
    // 保険（power 0.5）は残っている
    expect(ctx.items.isArmed("a", "hoken")).toBe(true);
    expect(ctx.items.isArmed("a", "higo")).toBe(false);
  });

  it("お守り込みでもエテル総量が保存される（総量保存 + 二重発動なし）", () => {
    const ctx = setup();
    const total0 = ctx.ether.outstanding();
    // 勝ち補正（+5%）
    ctx.items.grant("a", "omamori", 1);
    ctx.items.arm("a", "omamori");
    // ゲーム側で consumeWinBonus を呼び、その結果 payout を上乗せして settle する想定
    const bonus = ctx.items.consumeWinBonus("a");
    const rawPayout = 2_000;
    const adjustedPayout = Math.floor(rawPayout * bonus.mult); // 2100
    ctx.casino.settle("a", "test", 1_000, adjustedPayout, 0, { chain: false, fuku: false });
    expect(ctx.ether.outstanding()).toBe(total0);
    // 二重発動しない
    const again = ctx.items.consumeWinBonus("a");
    expect(again.mult).toBe(1);
  });
});

describe("胴元収支の総量保存（統合）", () => {
  it("100 ハンドの混合プレイでも Ledger の identity が壊れない", () => {
    const ctx = setup();
    for (let i = 0; i < 100; i++) {
      const bet = 100 + (i % 5) * 100;
      const payout = i % 3 === 0 ? bet * 2 : i % 3 === 1 ? 0 : bet;
      ctx.casino.settle("a", "mix", bet, payout, i % 7 === 0 ? 10 : 0, { chain: i % 2 === 0, fuku: i % 2 === 1 });
    }
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });
});
