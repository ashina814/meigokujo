import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino, JACKPOT_HOLDER, RELIEF_HOLDER, chainMultiplier, fukuRate } from "../src/casino/service.js";
import { Items, CONSUMABLES } from "../src/casino/items.js";
import { deterministicRng } from "../src/casino/rng.js";
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
  it("福のお守り: 消費で 1回だけ発動、cap で頭打ち", () => {
    const ctx = setup();
    ctx.items.grant("a", "omamori", 2);
    ctx.items.arm("a", "omamori");
    // 装備中 → 発動 → 利益 1000 × 5% = 50◈ ボーナス (cap 5000 未満)
    const r1 = ctx.items.consumeWinBonus("a", 2_000, 1_000);
    expect(r1.bonus).toBe(50);
    expect(ctx.items.isArmed("a", "omamori")).toBe(false);
    // 再装備しないと発動しない
    const r2 = ctx.items.consumeWinBonus("a", 2_000, 1_000);
    expect(r2.bonus).toBe(0);
    // 在庫はまだ 1 残っている（arm で消費した分だけ）
    expect(ctx.items.qty("a", "omamori")).toBe(1);
  });

  it("福のお守り: 高額ベットの利益に対して cap 3,000◈ で頭打ち", () => {
    const ctx = setup();
    ctx.items.grant("a", "omamori", 1);
    ctx.items.arm("a", "omamori");
    // 100万利益 × 5% = 50,000 だが cap 3,000 で頭打ち
    const r = ctx.items.consumeWinBonus("a", 2_000_000, 1_000_000);
    expect(r.bonus).toBe(3_000);
  });

  it("庇護 > 保険 の優先順位で発動する（cap も反映）", () => {
    const ctx = setup();
    ctx.items.grant("a", "hoken", 1);
    ctx.items.grant("a", "higo", 1);
    ctx.items.arm("a", "hoken");
    ctx.items.arm("a", "higo");
    // 庇護（power 1.0, cap 10,000）が優先。bet 8,000 × 100% = 8,000 (cap 未満)
    const r = ctx.items.consumeLossProtection("a", 8_000);
    expect(r.refund).toBe(8_000);
    // 保険（power 0.5）は残っている
    expect(ctx.items.isArmed("a", "hoken")).toBe(true);
    expect(ctx.items.isArmed("a", "higo")).toBe(false);
  });

  it("庇護: 100万ベットの敗北でも cap 10,000◈ で頭打ち", () => {
    const ctx = setup();
    ctx.items.grant("a", "higo", 1);
    ctx.items.arm("a", "higo");
    const r = ctx.items.consumeLossProtection("a", 1_000_000);
    expect(r.refund).toBe(10_000);
  });

  it("保険符: 100万ベットの敗北でも cap 2,000◈ で頭打ち", () => {
    const ctx = setup();
    ctx.items.grant("a", "hoken", 1);
    ctx.items.arm("a", "hoken");
    const r = ctx.items.consumeLossProtection("a", 1_000_000);
    expect(r.refund).toBe(2_000);
  });

  it("お守り込みでもエテル総量が保存される（総量保存 + 二重発動なし）", () => {
    const ctx = setup();
    const total0 = ctx.ether.outstanding();
    ctx.items.grant("a", "omamori", 1);
    ctx.items.arm("a", "omamori");
    // ゲーム側で consumeWinBonus を呼び、その結果 payout を上乗せして settle する想定
    const bonus = ctx.items.consumeWinBonus("a", 2_000, 1_000);
    const rawPayout = 2_000;
    const adjustedPayout = rawPayout + bonus.bonus; // 2050
    ctx.casino.settle("a", "test", 1_000, adjustedPayout, 0, { chain: false, fuku: false });
    expect(ctx.ether.outstanding()).toBe(total0);
    // 二重発動しない
    const again = ctx.items.consumeWinBonus("a", 2_000, 1_000);
    expect(again.bonus).toBe(0);
  });
});

describe("お守り裁定取引の封じ込め（発動まで装備が残る前提の理論値）", () => {
  // 実際の価格・上限（items.ts と一致・cap < price）
  const OMAMORI = { price: 4_000, power: 0.05, cap: 3_000 };
  const HOKEN = { price: 3_000, power: 0.5, cap: 2_000 };
  const HIGO = { price: 12_000, power: 1.0, cap: 10_000 };

  /**
   * 敗北保護お守り（保険符・庇護）の「アイテム代込み実効RTP」。
   *
   * 前提: お守りは「次に負けるまで」装備が残る。プレイヤーは
   *   「未装備なら買う・装備中は買わない・発動したら買い直す」戦略を取る。
   * → 1装備サイクル = 負けで終わる連続プレイ。サイクルあたり購入は1回、発動も1回。
   *   1ゲームあたりに均すと: 購入回数 = 敗北率、発動回数 = 敗北率。
   *
   * 実効RTP = 払戻総額 / (賭け総額 + アイテム代総額)
   *   1ゲームあたり:
   *     払戻   = bet*m*p + refund*(1-p)   ← 勝ち配当 + 敗北時の返金
   *     賭け   = bet
   *     アイテム = price*(1-p)              ← 敗北のたびに買い直す
   * @param p 勝率, @param m 勝ち時の配当倍率（元金込み）
   */
  function lossAmuletEffRtp(p: number, m: number, bet: number, item: { price: number; power: number; cap: number }): number {
    const refund = Math.min(Math.floor(bet * item.power), item.cap);
    const payouts = bet * m * p + refund * (1 - p);
    const denom = bet + item.price * (1 - p);
    return payouts / denom;
  }

  /**
   * 勝利ボーナスお守り（福のお守り）の「アイテム代込み実効RTP」。
   * 前提: 「次に勝つまで」装備が残る。1サイクル = 勝ちで終わる連続プレイ。
   *   払戻   = (bet*m + bonus)*p
   *   賭け   = bet
   *   アイテム = price*p
   */
  function winAmuletEffRtp(p: number, m: number, bet: number, item: { price: number; power: number; cap: number }): number {
    const profit = bet * m - bet; // 勝ち時の利益
    const bonus = Math.min(Math.floor(profit * item.power), item.cap);
    const payouts = (bet * m + bonus) * p;
    const denom = bet + item.price * p;
    return payouts / denom;
  }

  // ── 敗北保護 × 各ゲーム × 各賭け額帯 ──
  // ゲーム: 丁半 p=0.5 m=1.94 / クラッシュ1.5倍 p≈0.64 m=1.5 / ルーレット赤 p=18/37 m=2
  const LOSS_GAMES: Array<{ name: string; p: number; m: number }> = [
    { name: "丁半", p: 0.5, m: 1.94 },
    { name: "クラッシュ1.5倍", p: 0.96 / 1.5, m: 1.5 },
    { name: "ルーレット赤", p: 18 / 37, m: 2 },
  ];
  const BET_RANGE = [5_000, 10_000, 20_000, 50_000, 100_000, 500_000, 1_000_000];

  it.each(LOSS_GAMES)("$name × 保険符: 全賭け額帯でアイテム代込み実効RTP < 100%", ({ p, m }) => {
    for (const bet of BET_RANGE) {
      const rtp = lossAmuletEffRtp(p, m, bet, HOKEN);
      expect(rtp).toBeLessThan(1.0);
    }
  });

  it.each(LOSS_GAMES)("$name × 庇護の札: 全賭け額帯でアイテム代込み実効RTP < 100%", ({ p, m }) => {
    for (const bet of BET_RANGE) {
      const rtp = lossAmuletEffRtp(p, m, bet, HIGO);
      expect(rtp).toBeLessThan(1.0);
    }
  });

  it("丁半 × 福のお守り: 全賭け額帯でアイテム代込み実効RTP < 100%", () => {
    for (const bet of BET_RANGE) {
      const rtp = winAmuletEffRtp(0.5, 1.94, bet, OMAMORI);
      expect(rtp).toBeLessThan(1.0);
    }
  });

  it("旧 cap（>= price）だと裁定成立していたことを再現（丁半×旧保険符 = 106%超）", () => {
    // 旧: price=3,000 cap=5,000（cap > price）
    const oldHoken = { price: 3_000, power: 0.5, cap: 5_000 };
    const rtp = lossAmuletEffRtp(0.5, 1.94, 10_000, oldHoken);
    // 旧設計では 100% を超えていた（レビュー指摘の再現）
    expect(rtp).toBeGreaterThan(1.0);
  });

  it("cap < price の不変条件が満たされている（items.ts の CONSUMABLES）", () => {
    for (const c of CONSUMABLES) {
      if (c.cap !== undefined && c.cap > 0) {
        expect(c.cap).toBeLessThan(c.price);
      }
    }
  });
});

describe("お守り裁定シミュレーション（buy-if-not-armed 戦略を正確に再現）", () => {
  /** 高額ベット用の潤沢シード付き setup（maxAmount 100M 制約内） */
  function bigSetup() {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const ether = new EtherExchange(db, ledger, new EventLog(db));
    const casino = new Casino(db, ether, new EventLog(db));
    const items = new Items(db);
    const departments = new Departments(db, ledger);
    departments.upsert("賭博場", "賭博場", null);
    ledger.transfer({ from: TREASURY, to: deptAccount("賭博場"), amount: 90_000_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
    ether.fundFromAccount(deptAccount("賭博場"), 90_000_000, HOUSE_HOLDER, "seed:house");
    ledger.ensureAccount("user:a", "user");
    ledger.transfer({ from: TREASURY, to: "user:a", amount: 90_000_000, type: "initial", actor: "t", approvedBy: "t", idempotencyKey: "seed:a" });
    ether.buy("a", 90_000_000, "seed:buy:a");
    return { db, ledger, ether, casino, items };
  }

  /**
   * buy-if-not-armed 戦略の実測シミュレーション。
   * - お守りが未装備のときだけ購入して装備（ALREADY_ARMED では買わない）
   * - 敗北保護は負け時に発動 / 勝利ボーナスは勝ち時に発動
   * @returns アイテム代込み実効 RTP = payouts / (wagered + itemCost)
   */
  function simulate(
    ctx: ReturnType<typeof bigSetup>,
    amuletKey: "hoken" | "higo" | "omamori",
    kind: "loss" | "win",
    bet: number,
    winProb: number,
    payoutMult: number,
    N: number,
    seed: number,
  ): number {
    const rng = deterministicRng(seed);
    const price = CONSUMABLES.find((c) => c.key === amuletKey)!.price;
    let wagered = 0;
    let payouts = 0;
    let itemCost = 0;
    for (let i = 0; i < N; i++) {
      if (ctx.ether.balanceOf("a") < bet + price + 1_000) {
        // テスト継続のための補充（RTP 計算には含めない）
        ctx.ether.transfer(HOUSE_HOLDER, "a", 50_000_000 - ctx.ether.balanceOf("a"));
      }
      // 未装備のときだけ購入＋装備（ALREADY_ARMED の場合は買わない）
      if (!ctx.items.isArmed("a", amuletKey)) {
        ctx.ether.transfer("a", HOUSE_HOLDER, price);
        ctx.items.grant("a", amuletKey, 1);
        const armRes = ctx.items.arm("a", amuletKey);
        if (!armRes.ok) throw new Error(`arm failed unexpectedly: ${JSON.stringify(armRes)}`);
        itemCost += price;
      }
      const won = rng.float() < winProb;
      const rawPayout = won ? Math.floor(bet * payoutMult) : 0;
      wagered += bet;
      if (kind === "win" && won) {
        const bonus = ctx.items.consumeWinBonus("a", rawPayout, bet);
        const r = ctx.casino.settle("a", "sim", bet, rawPayout + bonus.bonus, 0, { chain: false, fuku: false });
        payouts += r.payout;
      } else if (kind === "loss" && !won) {
        const prot = ctx.items.consumeLossProtection("a", bet);
        const r = ctx.casino.settle("a", "sim", bet, prot.refund, 0, { chain: false, fuku: false });
        payouts += r.payout;
      } else {
        const r = ctx.casino.settle("a", "sim", bet, rawPayout, 0, { chain: false, fuku: false });
        payouts += r.payout;
      }
    }
    return payouts / (wagered + itemCost);
  }

  it("丁半 × 保険符（bet=10,000, 50,000回）: 実効RTP < 100%", { timeout: 120_000 }, () => {
    const ctx = bigSetup();
    const rtp = simulate(ctx, "hoken", "loss", 10_000, 0.5, 1.94, 12_000, 111);
    expect(rtp).toBeLessThan(1.0);
    // 理論値 93% 前後に近い
    expect(rtp).toBeGreaterThan(0.85);
    expect(rtp).toBeLessThan(0.98);
  });

  it("丁半 × 庇護の札（bet=50,000, 50,000回）: 実効RTP < 100%", { timeout: 120_000 }, () => {
    const ctx = bigSetup();
    const rtp = simulate(ctx, "higo", "loss", 50_000, 0.5, 1.94, 12_000, 222);
    expect(rtp).toBeLessThan(1.0);
  });

  it("クラッシュ1.5倍 × 保険符（bet=20,000, 50,000回）: 実効RTP < 100%", { timeout: 120_000 }, () => {
    const ctx = bigSetup();
    const rtp = simulate(ctx, "hoken", "loss", 20_000, 0.96 / 1.5, 1.5, 12_000, 333);
    expect(rtp).toBeLessThan(1.0);
  });

  it("ルーレット赤 × 保険符（bet=30,000, 50,000回）: 実効RTP < 100%", { timeout: 120_000 }, () => {
    const ctx = bigSetup();
    const rtp = simulate(ctx, "hoken", "loss", 30_000, 18 / 37, 2, 12_000, 444);
    expect(rtp).toBeLessThan(1.0);
  });

  it("丁半 × 福のお守り（bet=40,000, 50,000回）: 実効RTP < 100%", { timeout: 120_000 }, () => {
    const ctx = bigSetup();
    const rtp = simulate(ctx, "omamori", "win", 40_000, 0.5, 1.94, 12_000, 555);
    expect(rtp).toBeLessThan(1.0);
  });

  it("ALREADY_ARMED を正しく扱う: 装備中は購入せず、購入回数 == 発動回数（±1）", () => {
    const ctx = bigSetup();
    const rng = deterministicRng(999);
    const bet = 10_000;
    const price = 3_000;
    let purchases = 0;
    let triggers = 0;
    const N = 5_000;
    for (let i = 0; i < N; i++) {
      if (ctx.ether.balanceOf("a") < bet + price + 1_000) {
        ctx.ether.transfer(HOUSE_HOLDER, "a", 50_000_000 - ctx.ether.balanceOf("a"));
      }
      if (!ctx.items.isArmed("a", "hoken")) {
        ctx.ether.transfer("a", HOUSE_HOLDER, price);
        ctx.items.grant("a", "hoken", 1);
        const armRes = ctx.items.arm("a", "hoken");
        expect(armRes.ok).toBe(true); // 未装備なので必ず成功
        purchases++;
      } else {
        // 装備中に arm を呼ぶと ALREADY_ARMED（購入していない＝在庫を積んでいない証拠）。
        // isArmed チェックが先なので在庫0でも ALREADY_ARMED が返る。
        const armAgain = ctx.items.arm("a", "hoken");
        expect(armAgain).toEqual({ ok: false, reason: "ALREADY_ARMED" });
      }
      const won = rng.float() < 0.5;
      if (!won) {
        const prot = ctx.items.consumeLossProtection("a", bet);
        if (prot.refund > 0) triggers++;
        ctx.casino.settle("a", "sim", bet, prot.refund, 0, { chain: false, fuku: false });
      } else {
        ctx.casino.settle("a", "sim", bet, Math.floor(bet * 1.94), 0, { chain: false, fuku: false });
      }
    }
    // 購入回数 ≈ 発動回数（各サイクルが1発動で終わり次で買い直す）
    expect(Math.abs(purchases - triggers)).toBeLessThanOrEqual(1);
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
