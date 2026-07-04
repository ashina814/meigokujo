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
});
