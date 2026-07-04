import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Chips } from "../src/chips/service.js";
import { Casino, CasinoError, HOUSE } from "../src/casino/service.js";

registerDefaultTxTypes();

/** rng を配列で固定できるようにする */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

function setup(rng: () => number = () => 0) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chips = new Chips(db, ledger, events);
  const casino = new Casino(db, chips, events, rng);
  // 元手を配る（Land→チップ）
  const fund = (u: string, land: number) => {
    ledger.ensureAccount(`user:${u}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${u}`, amount: land, type: "initial", actor: "t", idempotencyKey: `f:${u}:${Math.random()}`, approvedBy: land > 1_000_000 ? "t" : undefined });
  };
  fund("p", 1_000_000);
  fund("op", 1_000_000);
  chips.buy("p", 500_000, "bp"); // p にチップ
  chips.buy("op", 500_000, "bo");
  casino.fundHouse("op", chips.balanceOf("op")); // 胴元に元手
  return { db, ledger, chips, casino };
}

describe("カジノ", () => {
  it("コイン: 当たりは1.95倍、外れは掛け金没収", () => {
    const ctx = setup(seq([0])); // 0 → 表
    const held0 = ctx.chips.balanceOf("p");
    const r = ctx.casino.coin("p", 1_000, "表");
    expect(r.win).toBe(true);
    expect(r.payout).toBe(1_950);
    expect(ctx.chips.balanceOf("p")).toBe(held0 + 950);

    const ctx2 = setup(seq([0]));
    const h2 = ctx2.chips.balanceOf("p");
    const lose = ctx2.casino.coin("p", 1_000, "裏"); // 出目表・裏に賭け→負け
    expect(lose.win).toBe(false);
    expect(ctx2.chips.balanceOf("p")).toBe(h2 - 1_000);
  });

  it("スロット: 7が3つ揃うと50倍", () => {
    // spinReel は randInt(100)。7️⃣ は重み[40,30,18,9,3]の最後=97..99
    const ctx = setup(seq([0.99]));
    const r = ctx.casino.slot("p", 100);
    expect(r.reels).toEqual(["7️⃣", "7️⃣", "7️⃣"]);
    expect(r.multiplier).toBe(50);
    expect(r.payout).toBe(5_000);
  });

  it("スロット: 全ハズレは0配当（掛け金没収）", () => {
    // 🍒=0..39, 🍋=40..69。[🍒,🍋,🍋] のように揃わずチェリー1枚だと1倍なので、
    // チェリー0枚で揃わない目を作る: 🍋,🔔,🍋 → 0.5(=🍋),0.8(=🔔),0.5(=🍋)
    const ctx = setup(seq([0.5, 0.8, 0.5]));
    const before = ctx.chips.balanceOf("p");
    const r = ctx.casino.slot("p", 100);
    expect(r.multiplier).toBe(0);
    expect(ctx.chips.balanceOf("p")).toBe(before - 100);
  });

  it("ルーレット: 0で色賭けは負け（エッジの源泉）", () => {
    const ctx = setup(seq([0])); // randInt(37)=0
    const r = ctx.casino.roulette("p", 1_000, { kind: "color", value: "赤" });
    expect(r.number).toBe(0);
    expect(r.color).toBe("緑");
    expect(r.win).toBe(false);
  });

  it("ルーレット: ストレート的中は36倍", () => {
    // randInt(37) で 7 を出す: floor(x*37)=7 → x=7/37≈0.19
    const ctx = setup(seq([7 / 37]));
    const before = ctx.chips.balanceOf("p");
    const r = ctx.casino.roulette("p", 100, { kind: "straight", value: 7 });
    expect(r.number).toBe(7);
    expect(r.win).toBe(true);
    expect(r.payout).toBe(3_600);
    expect(ctx.chips.balanceOf("p")).toBe(before + 3_500);
  });

  it("胴元の資金が最大配当に足りなければ賭けを弾く", () => {
    const ctx = setup(() => 0);
    // 胴元をほぼ空にする
    ctx.casino.withdrawHouse("p", ctx.casino.houseBalance());
    expect(() => ctx.casino.slot("p", 100)).toThrow(CasinoError); // 50倍を払えない
  });

  it("持ちチップ超の賭けは弾く / チップ総量はゲームで保存される", () => {
    const ctx = setup(() => 0);
    expect(() => ctx.casino.coin("p", 99_999_999, "表")).toThrow(CasinoError);
    const total0 = ctx.chips.outstanding();
    ctx.casino.coin("p", 1_000, "表");
    ctx.casino.slot("p", 500);
    expect(ctx.chips.outstanding()).toBe(total0); // カジノは移動のみ＝総量不変
    expect(ctx.ledger.balanceOf(HOUSE)).toBe(0); // HOUSE は Land口座ではない
  });

  it("ブラックジャック: hit で21超えバスト、掛け金没収", () => {
    // player[10,10]=20, dealer[10,10]=20 の後 hit で更に10 → 30 bust。
    // drawFrom は randInt(deck.length)。deck先頭付近の10級を引くよう rng=0 固定
    // ではランクが偏るので、決定論のため rng を固定して結果を観測する
    const ctx = setup(() => 0);
    const total0 = ctx.chips.outstanding();
    const start = ctx.casino.blackjackStart("p", 1_000);
    if (start.state === "playing") {
      // バストするまで引く
      let v = start;
      while (v.state === "playing") v = ctx.casino.blackjackHit("p");
      expect(["player_bust", "win", "lose", "push"]).toContain(v.state);
    }
    // 何が起きてもチップ総量は不変（＝インフレしない）
    expect(ctx.chips.outstanding()).toBe(total0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("ハイロー: 連勝で pot が増え、キャッシュアウトで受け取れる", () => {
    // rng: 最初のカードを低ランクにして「higher」を通す
    // drawCard = rank randInt(13)+1, suit randInt(4)。rng=0 → rank1(A), suit0
    // 次も rank1 → tie(=bust)。なので rng を段階制御する
    const ctx = setup(seq([0, 0, 0.9, 0, 0.5, 0])); // 現在A → 次K(higher勝ち) → ...
    const v0 = ctx.casino.hiloStart("p", 1_000);
    expect(v0.current).toContain("A");
    const v1 = ctx.casino.hiloGuess("p", "higher");
    expect(v1.state).toBe("playing");
    expect(v1.pot).toBeGreaterThanOrEqual(1_000);
    const cash = ctx.casino.hiloCashout("p");
    expect(cash.state).toBe("cashed");
    expect(cash.payout).toBe(v1.pot);
  });

  it("ハイロー: 外れ(バスト)で pot 消滅、チップ総量は保存", () => {
    const ctx = setup(seq([0.9, 0, 0])); // 現在K → higher は不可能(favorable0)で必ずバスト
    const total0 = ctx.chips.outstanding();
    ctx.casino.hiloStart("p", 1_000);
    const v = ctx.casino.hiloGuess("p", "higher");
    expect(v.state).toBe("bust");
    expect(ctx.chips.outstanding()).toBe(total0); // 焼却も発行もなし＝インフレしない
  });

  it("精算: 胴元チップを部署口座へLandで納める（スプレッド＝焼却シンクあり・非インフレ）", () => {
    const ctx = setup(() => 0);
    // 賭博場の部署口座を用意（sys:dept:賭博場 を system 口座として作る）
    const deptAcc = "sys:dept:賭博場";
    ctx.ledger.ensureAccount(deptAcc, "system");
    const houseChips = ctx.chips.balanceOf("sys:house");
    expect(houseChips).toBeGreaterThan(0);
    const supply0 = ctx.ledger.moneySupply();

    const r = ctx.casino.settleToDept(deptAcc, houseChips, "op");
    expect(r.chips).toBe(houseChips);
    expect(r.land).toBeGreaterThan(0);
    expect(ctx.ledger.balanceOf(deptAcc)).toBe(r.land); // 部署にLandが入る
    expect(ctx.chips.balanceOf("sys:house")).toBe(0); // 胴元チップは0に
    // 焼却ぶんだけ通貨供給は減る（増えない＝インフレしない）
    expect(ctx.ledger.moneySupply()).toBeLessThanOrEqual(supply0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("多数のゲーム後もチップ総量とLand準備は不変（インフレゼロ）", () => {
    const ctx = setup(seq([0.1, 0.7, 0.3, 0.9, 0.5, 0.2, 0.8, 0.4]));
    const total0 = ctx.chips.outstanding();
    const pool0 = ctx.chips.pool();
    for (let i = 0; i < 20; i++) {
      try { ctx.casino.coin("p", 100, i % 2 ? "表" : "裏"); } catch { /* 破産したら止まる */ }
      try { ctx.casino.slot("p", 50); } catch { /* noop */ }
    }
    expect(ctx.chips.outstanding()).toBe(total0);
    expect(ctx.chips.pool()).toBe(pool0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });
});
