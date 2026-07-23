import { beforeEach, describe, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino, JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { Items } from "../src/casino/items.js";
import { deptAccount, Departments } from "../src/departments/service.js";
import {
  crashPoint,
  rouletteSpin,
  chohanRollAndPay,
} from "../src/casino/game-models.js";
import {
  slotsSpinReel as spinReel,
  slotsEvaluate as evaluate,
  SLOTS_JP_CONTRIBUTION,
  SLOTS_JP_WIN_SHARE,
  type SlotSymbol,
} from "../src/index.js";
import { deterministicRng } from "../src/casino/rng.js";

registerDefaultTxTypes();

/**
 * 実効 RTP レポート（Casino.settle 経由・全レイヤー込み）。
 *
 * 各ゲームで以下を分けて記録する:
 *   baseRtp             通常配当のみ（chain/fuku/JP/items なし）
 *   withChainRtp        連勝ボーナス込み
 *   withFukuRtp         福の重み（プレイヤー→JP/救済）込み
 *   withJackpotRtp      JP 積立 + 当選込み
 *   withItemsRtp        お守り込み（毎回購入・装備戦略）
 *   effectiveHouseReturn  1 - withJackpotRtp（またはアイテム込みの実収支）
 *
 * すべて Casino.settle() を通した実測値。ペイアウトの整数丸めも反映される。
 */

interface Ctx {
  db: ReturnType<typeof openDb>;
  ledger: Ledger;
  ether: EtherExchange;
  casino: Casino;
  items: Items;
}

function setup(seedHouseEther = 50_000_000, seedPlayerEther = 5_000_000): Ctx {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const ether = new EtherExchange(db, ledger, new EventLog(db));
  const casino = new Casino(db, ether, new EventLog(db));
  const items = new Items(db);
  const departments = new Departments(db, ledger);
  departments.upsert("賭博場", "賭博場", null);
  const seedLand = Math.max(seedHouseEther, 10_000_000);
  ledger.transfer({ from: TREASURY, to: deptAccount("賭博場"), amount: seedLand, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
  ether.fundFromAccount(deptAccount("賭博場"), seedLand, HOUSE_HOLDER, "seed:house");
  ledger.ensureAccount("user:a", "user");
  ledger.transfer({ from: TREASURY, to: "user:a", amount: seedPlayerEther, type: "initial", actor: "t", approvedBy: "t", idempotencyKey: "seed:a" });
  ether.buy("a", seedPlayerEther, "seed:buy:a");
  return { db, ledger, ether, casino, items };
}

/** プレイヤー残高を fuku しきい値未満（<100,000 ether）に維持しつつ N 回プレイ */
function keepLowBalance(ctx: Ctx) {
  const bal = ctx.ether.balanceOf("a");
  if (bal < 5_000) ctx.ether.transfer(HOUSE_HOLDER, "a", 50_000);
  if (bal > 90_000) ctx.ether.transfer("a", HOUSE_HOLDER, bal - 50_000);
}

/** 実測 RTP を計算するヘルパ。settle の payout を集計 */
function measureRtp(N: number, bet: number, oneRound: () => { payout: number }): number {
  let wagered = 0;
  let received = 0;
  for (let i = 0; i < N; i++) {
    wagered += bet;
    received += oneRound().payout;
  }
  return received / wagered;
}

// ─── スロット ───────────────────────────────────────────
function slotsRoundBase(ctx: Ctx, rng: ReturnType<typeof deterministicRng>, bet: number, opts: { chain: boolean; fuku: boolean; jpCut: number }): { payout: number } {
  keepLowBalance(ctx);
  const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(rng), spinReel(rng), spinReel(rng)];
  const out = evaluate(reels, bet);
  const r = ctx.casino.settle("a", "slots", bet, out.payout, opts.jpCut, { chain: opts.chain, fuku: opts.fuku });
  let extra = 0;
  if (out.kind === "jackpot") extra = ctx.casino.seizeJackpot("a", "slots", SLOTS_JP_WIN_SHARE);
  return { payout: r.payout + extra };
}

// ─── 丁半 ───────────────────────────────────────────────
function chohanRoundBase(ctx: Ctx, rng: ReturnType<typeof deterministicRng>, bet: number, opts: { chain: boolean; fuku: boolean }): { payout: number } {
  keepLowBalance(ctx);
  const payout = chohanRollAndPay(rng, bet, "cho");
  const r = ctx.casino.settle("a", "chohan", bet, payout, 0, { chain: opts.chain, fuku: opts.fuku });
  return { payout: r.payout };
}

// ─── ルーレット ─────────────────────────────────────────
function rouletteRoundBase(ctx: Ctx, rng: ReturnType<typeof deterministicRng>, bet: number, opts: { chain: boolean; fuku: boolean }): { payout: number } {
  keepLowBalance(ctx);
  const n = rouletteSpin(rng);
  // 赤ベット固定
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const won = RED.has(n);
  const payout = won ? bet * 2 : 0;
  const r = ctx.casino.settle("a", "roulette", bet, payout, 0, { chain: opts.chain, fuku: opts.fuku });
  return { payout: r.payout };
}

// ─── クラッシュ ─────────────────────────────────────────
function crashRoundBase(ctx: Ctx, rng: ReturnType<typeof deterministicRng>, bet: number, opts: { chain: boolean; fuku: boolean }, M = 2.0): { payout: number } {
  keepLowBalance(ctx);
  const crash = crashPoint(rng);
  const won = crash >= M;
  const payout = won ? Math.floor(bet * M) : 0;
  const r = ctx.casino.settle("a", "crash", bet, payout, 0, { chain: opts.chain, fuku: opts.fuku });
  return { payout: r.payout };
}

// ─── レポート本体 ───────────────────────────────────────
const N_FAST = 3_000; // レポート用（統計収束＋実行時間バランス）
const REPORT_BET = 200; // fuku しきい値 100,000 未満を維持しやすい

function report(name: string, layer: string, rtp: number, note = ""): string {
  return `  ${name.padEnd(12)} ${layer.padEnd(22)} ${(rtp * 100).toFixed(2).padStart(7)}%  ${note}`;
}

describe("実効 RTP レポート（Casino.settle 経由）", () => {
  let ctx: Ctx;
  beforeEach(() => (ctx = setup()));

  it("スロット: base / +chain / +fuku / +JP", { timeout: 30_000 }, () => {
    const lines: string[] = [];
    const runOne = (opts: { chain: boolean; fuku: boolean; jpCut: number }) => {
      // 独立実験のため setup をやり直す
      ctx = setup();
      const rng = deterministicRng(2026);
      return measureRtp(N_FAST, REPORT_BET, () => slotsRoundBase(ctx, rng, REPORT_BET, opts));
    };
    lines.push(report("スロット", "base", runOne({ chain: false, fuku: false, jpCut: 0 })));
    lines.push(report("スロット", "+chain", runOne({ chain: true, fuku: false, jpCut: 0 })));
    lines.push(report("スロット", "+fuku", runOne({ chain: false, fuku: true, jpCut: 0 })));
    const jpCut = Math.max(1, Math.floor(REPORT_BET * SLOTS_JP_CONTRIBUTION));
    lines.push(report("スロット", "+JP", runOne({ chain: false, fuku: false, jpCut }), `jpCut=${jpCut}◈/spin (bet=${REPORT_BET})`));
    lines.push(report("スロット", "+chain+fuku+JP", runOne({ chain: true, fuku: true, jpCut }), "実効"));
    console.log("\n=== スロット効果別 RTP ===\n" + lines.join("\n"));
  });

  it("スロット: 賭け額 50/100/1,000/最大 で JP 積立整数丸めの影響", { timeout: 30_000 }, () => {
    const buckets = [50, 100, 1_000, 100_000];
    const lines: string[] = [];
    for (const bet of buckets) {
      ctx = setup(90_000_000, 90_000_000); // 高額 bet 用に潤沢シード（Ledger maxAmount 内）
      const rng = deterministicRng(bet);
      const jpCut = Math.max(1, Math.floor(bet * SLOTS_JP_CONTRIBUTION));
      const jpRate = jpCut / bet;
      // 低残高維持ロジックだと大額 bet で fail するので、シード後は放置（fuku 帯に入る可能性あり）
      let wagered = 0;
      let received = 0;
      for (let i = 0; i < 500; i++) {
        const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [spinReel(rng), spinReel(rng), spinReel(rng)];
        const out = evaluate(reels, bet);
        const r = ctx.casino.settle("a", "slots", bet, out.payout, jpCut, { chain: false, fuku: false });
        wagered += bet;
        received += r.payout;
        if (out.kind === "jackpot") received += ctx.casino.seizeJackpot("a", "slots", SLOTS_JP_WIN_SHARE);
        if (ctx.ether.balanceOf("a") < bet) break; // 破産で終了
      }
      const rtp = wagered > 0 ? received / wagered : 0;
      lines.push(report("スロット", `bet=${bet.toLocaleString()}`, rtp, `jpCut=${jpCut}◈ (実効積立率 ${(jpRate * 100).toFixed(2)}%)`));
    }
    console.log("\n=== スロット bet 額別 RTP（JP 積立整数丸め影響） ===\n" + lines.join("\n"));
  });

  it("丁半: base / +chain / +fuku", { timeout: 30_000 }, () => {
    const lines: string[] = [];
    const runOne = (opts: { chain: boolean; fuku: boolean }) => {
      ctx = setup();
      const rng = deterministicRng(1300);
      return measureRtp(N_FAST, REPORT_BET, () => chohanRoundBase(ctx, rng, REPORT_BET, opts));
    };
    lines.push(report("丁半", "base", runOne({ chain: false, fuku: false })));
    lines.push(report("丁半", "+chain", runOne({ chain: true, fuku: false })));
    lines.push(report("丁半", "+fuku", runOne({ chain: false, fuku: true })));
    lines.push(report("丁半", "+chain+fuku（実効）", runOne({ chain: true, fuku: true })));
    console.log("\n=== 丁半効果別 RTP ===\n" + lines.join("\n"));
  });

  it("ルーレット（赤ベット）: base のみ（chain/fuku は無効化されている実装）", { timeout: 30_000 }, () => {
    ctx = setup();
    const rng = deterministicRng(3737);
    const rtp = measureRtp(N_FAST, REPORT_BET, () =>
      rouletteRoundBase(ctx, rng, REPORT_BET, { chain: false, fuku: false }),
    );
    console.log("\n=== ルーレット RTP ===\n" + report("ルーレット", "base", rtp, "赤ベット・実装は chain/fuku off"));
  });

  it("クラッシュ（cashout=2.0）: base / +fuku （chain は無効化・回帰済み）", { timeout: 30_000 }, () => {
    const lines: string[] = [];
    const runOne = (opts: { chain: boolean; fuku: boolean }) => {
      ctx = setup();
      const rng = deterministicRng(2020);
      return measureRtp(N_FAST, REPORT_BET, () => crashRoundBase(ctx, rng, REPORT_BET, opts, 2.0));
    };
    lines.push(report("クラッシュ", "base", runOne({ chain: false, fuku: false })));
    lines.push(report("クラッシュ", "+fuku", runOne({ chain: false, fuku: true })));
    // 参考: chain 有効時（本来はハウスが赤字化する構造）
    lines.push(report("クラッシュ", "+chain（参考・実装off）", runOne({ chain: true, fuku: false }), "実装では chain:false"));
    console.log("\n=== クラッシュ RTP ===\n" + lines.join("\n"));
  });

  it("お守り込み: 保険符・庇護・お守り（cap 適用）で効果検証", { timeout: 30_000 }, () => {
    // 高額ベット下で毎回買って装備する戦略
    ctx = setup(90_000_000, 90_000_000);
    const bet = 100_000;
    const iters = 200;
    let wagered = 0;
    let received = 0;
    let houseFromItems = 0; // アイテム販売収入
    const rng = deterministicRng(9);
    for (let i = 0; i < iters; i++) {
      // ランダムに保険符 or お守りを買って装備
      if (i % 2 === 0) {
        ctx.items.grant("a", "omamori", 1);
        ctx.items.arm("a", "omamori");
        ctx.ether.transfer("a", HOUSE_HOLDER, 4_000);
        houseFromItems += 4_000;
      } else {
        ctx.items.grant("a", "hoken", 1);
        ctx.items.arm("a", "hoken");
        ctx.ether.transfer("a", HOUSE_HOLDER, 3_000);
        houseFromItems += 3_000;
      }
      // 勝率 50% 想定（rng でシミュ）
      const won = rng.int(0, 1) === 0;
      wagered += bet;
      if (won) {
        const bonus = ctx.items.consumeWinBonus("a", bet * 2, bet);
        const adjustedPayout = bet * 2 + bonus.bonus;
        const r = ctx.casino.settle("a", "amuletsim", bet, adjustedPayout, 0, { chain: false, fuku: false });
        received += r.payout;
      } else {
        const prot = ctx.items.consumeLossProtection("a", bet);
        const r = ctx.casino.settle("a", "amuletsim", bet, prot.refund, 0, { chain: false, fuku: false });
        received += r.payout;
      }
    }
    const rtp = received / wagered; // ゲームだけの RTP（アイテム代を差し引かない）
    const itemsCost = houseFromItems;
    const netPlayer = received - wagered - itemsCost; // 実質プレイヤー損益
    const effectiveHouseReturn = -netPlayer / wagered; // 胴元収益率（対 wagered）
    console.log(
      `\n=== お守り込み実効 RTP (bet=${bet.toLocaleString()}, ${iters}回, 保険符/お守り交互) ===\n` +
        report("お守り込み", "game RTP", rtp) +
        "\n" + report("お守り込み", "アイテム代総額", itemsCost / wagered, `${itemsCost.toLocaleString()}◈`) +
        "\n" + report("お守り込み", "effective house return", effectiveHouseReturn, "(-プレイヤー損 / wagered)"),
    );
  });
});

// 未使用参照抑制
void RELIEF_HOLDER;
void JACKPOT_HOLDER;
