import { describe, expect, it } from "vitest";
import {
  CHINCHIRO_DEALER_POLICY,
  CHINCHIRO_HOUSE_EDGE,
  CHINCHIRO_LOSS_MULT_BASE,
  CHINCHIRO_MAX_LOSS_MULT,
  CHINCHIRO_WIN_MULT,
  chinchiroCompare,
  chinchiroEvaluate,
  chinchiroLossMult,
  chinchiroMaxPayout,
  chinchiroMaxPlayerLoss,
  chinchiroPayout,
  chinchiroPlayTurn,
  chinchiroPlayerLoss,
  chinchiroSimulateRtp,
  deterministicRng,
  type ChinchiroHand,
  type ChinchiroPolicy,
} from "../src/index.js";

/**
 * PR4: チンチロの core モデルと、敗北倍率2倍化にともなう RTP 調整の根拠。
 *
 * 正本 §1.5:
 *   「敗北倍率を最大2倍へ変更する。PR4で現行RTPを測定し、敗北倍率変更後も基準RTPとの差を
 *     ±0.5ポイント以内に収めるよう、勝利側倍率を最小限調整する。」
 *
 * ここでは調整後の実装で RTP を実測し、旧規則を同じ乱数・同じ方針で再現した値と比べる。
 */

const hand = (a: number, b: number, c: number): ChinchiroHand => chinchiroEvaluate([a, b, c] as const);

describe("役判定と順位", () => {
  it("役を正しく判定する", () => {
    expect(hand(1, 1, 1)).toEqual({ type: "pinzoro" });
    expect(hand(4, 4, 4)).toEqual({ type: "zorome", value: 4 });
    expect(hand(6, 4, 5)).toEqual({ type: "shigoro" });
    expect(hand(3, 1, 2)).toEqual({ type: "hifumi" });
    expect(hand(2, 2, 6)).toEqual({ type: "me", score: 6 });
    expect(hand(1, 3, 5)).toEqual({ type: "menashi" });
  });

  it("ピンゾロ > ゾロ目 > シゴロ > 目 > メナシ > ヒフミ", () => {
    expect(chinchiroCompare(hand(1, 1, 1), hand(4, 4, 4)).result).toBe("player_win");
    expect(chinchiroCompare(hand(4, 4, 4), hand(4, 5, 6)).result).toBe("player_win");
    expect(chinchiroCompare(hand(4, 5, 6), hand(2, 2, 6)).result).toBe("player_win");
    expect(chinchiroCompare(hand(2, 2, 6), hand(1, 3, 5)).result).toBe("player_win");
    expect(chinchiroCompare(hand(1, 3, 5), hand(1, 2, 3)).result).toBe("player_win");
  });

  it("同点はマモン勝ちで賭け額だけ失う", () => {
    const c = chinchiroCompare(hand(2, 2, 6), hand(3, 3, 6));
    expect(c.result).toBe("dealer_win");
    expect(c.mul).toBe(-1);
  });

  it("両者ヒフミは引き分け", () => {
    expect(chinchiroCompare(hand(1, 2, 3), hand(1, 2, 3))).toEqual({ result: "push", mul: 0 });
  });
});

describe("敗北倍率は最大2倍（正本 §1.5）", () => {
  it("マモンのピンゾロでも支払いは 2×bet（旧実装は 5×bet だった）", () => {
    const c = chinchiroCompare(hand(2, 2, 6), hand(1, 1, 1));
    expect(c.result).toBe("dealer_win");
    expect(c.mul).toBe(-CHINCHIRO_MAX_LOSS_MULT);
    expect(chinchiroPlayerLoss(500, c.mul)).toBe(1_000);
    // 旧規則なら 2,500 だった
    expect(CHINCHIRO_LOSS_MULT_BASE.pinzoro * 500).toBe(2_500);
  });

  it("ゾロ目・シゴロ・自分のヒフミもすべて2倍で頭打ち", () => {
    expect(chinchiroLossMult(hand(4, 4, 4))).toBe(2);
    expect(chinchiroLossMult(hand(4, 5, 6))).toBe(2);
    expect(chinchiroCompare(hand(1, 2, 3), hand(2, 2, 5)).mul).toBe(-2);
  });

  it("目・メナシに負けたときは1倍のまま（構造的な値）", () => {
    expect(chinchiroLossMult(hand(2, 2, 6))).toBe(1);
    expect(chinchiroLossMult(hand(1, 3, 5))).toBe(1);
  });

  it("最大損失は常に 2×bet", () => {
    for (const bet of [50, 500, 123_456]) {
      expect(chinchiroMaxPlayerLoss(bet)).toBe(bet * 2);
    }
  });
});

describe("払戻", () => {
  it("勝ちは元金 + 利益×(1−エッジ)", () => {
    const bet = 10_000;
    expect(chinchiroPayout(bet, CHINCHIRO_WIN_MULT.pinzoro)).toBe(
      bet + Math.floor(bet * CHINCHIRO_WIN_MULT.pinzoro * (1 - CHINCHIRO_HOUSE_EDGE)),
    );
    expect(chinchiroMaxPayout(bet)).toBe(chinchiroPayout(bet, CHINCHIRO_WIN_MULT.pinzoro));
  });

  it("引き分けは返金、負けは0", () => {
    expect(chinchiroPayout(500, 0)).toBe(500);
    expect(chinchiroPayout(500, -2)).toBe(0);
  });
});

// ─── RTP 実測 ───────────────────────────────────────────

/**
 * 旧規則（敗北倍率の上限なし・エッジ5%）と新規則を **同じ対局サンプルから** 比べる。
 *
 * 別々にシミュレーションすると、比べたい差（1pt 未満）よりサンプリング誤差のほうが大きくなる。
 * そこで対局は1回だけ回して「どの役でどちらが勝ったか」の頻度表を作り、
 * RTP は頻度表から閉じた式で出す。倍率が変わっても対局はやり直さない。
 */

type Slot = "pinzoro" | "zorome" | "shigoro" | "hifumiAgainst" | "plain";
const SLOTS: readonly Slot[] = ["pinzoro", "zorome", "shigoro", "hifumiAgainst", "plain"];

interface Tally {
  push: number;
  win: Record<Slot, number>;
  loss: Record<Slot, number>;
}

const emptySlots = (): Record<Slot, number> => ({ pinzoro: 0, zorome: 0, shigoro: 0, hifumiAgainst: 0, plain: 0 });

const slotOf = (h: ChinchiroHand): Slot =>
  h.type === "pinzoro" ? "pinzoro" : h.type === "zorome" ? "zorome" : h.type === "shigoro" ? "shigoro" : "plain";

/** 対局を回して頻度表を作る。進行は本番モデル（`chinchiroPlayTurn`）そのもの */
function tally(policy: ChinchiroPolicy, rounds: number, seeds: readonly number[]): Tally {
  const t: Tally = { push: 0, win: emptySlots(), loss: emptySlots() };
  for (const seed of seeds) {
    const rng = deterministicRng(seed);
    for (let i = 0; i < rounds; i++) {
      const p = chinchiroPlayTurn(rng, policy).hand;
      const d = chinchiroPlayTurn(rng, CHINCHIRO_DEALER_POLICY).hand;
      if (p.type === "hifumi" && d.type === "hifumi") { t.push++; continue; }
      if (p.type === "hifumi") { t.loss.hifumiAgainst++; continue; } // 自爆
      if (d.type === "hifumi") { t.win.hifumiAgainst++; continue; }
      const cmp = chinchiroCompare(p, d);
      if (cmp.result === "player_win") t.win[slotOf(p)]++;
      else t.loss[slotOf(d)]++; // 同点も plain（賭け額だけ失う）に入る
    }
  }
  return t;
}

/** 勝ち倍率・エッジ・負け上限を与えて RTP を出す（受取総額 / 支払総額） */
function rtpOf(
  t: Tally,
  opts: { win: Record<Slot, number>; edge: number; lossCap: number },
): number {
  let paid = t.push;
  let received = t.push;
  for (const s of SLOTS) {
    paid += t.win[s];
    received += t.win[s] * (1 + opts.win[s] * (1 - opts.edge));
    // 負け側の素の倍率は勝ち側と別。自爆ヒフミは hifumiSelf
    const lossBase = s === "hifumiAgainst" ? CHINCHIRO_LOSS_MULT_BASE.hifumiSelf : CHINCHIRO_LOSS_MULT_BASE[s];
    paid += t.loss[s] * Math.min(opts.lossCap, lossBase);
  }
  return received / paid;
}

const WIN_TABLE: Record<Slot, number> = {
  pinzoro: CHINCHIRO_WIN_MULT.pinzoro,
  zorome: CHINCHIRO_WIN_MULT.zorome,
  shigoro: CHINCHIRO_WIN_MULT.shigoro,
  hifumiAgainst: CHINCHIRO_WIN_MULT.hifumiAgainst,
  plain: CHINCHIRO_WIN_MULT.plain,
};

/** 旧規則: 勝ち倍率は同じ・エッジ5%・敗北倍率の上限なし */
const OLD_RULES = { win: WIN_TABLE, edge: 0.05, lossCap: Number.POSITIVE_INFINITY };
/** 新規則: 勝ち倍率は据え置き・エッジは実装値・敗北倍率は実装の上限 */
const NEW_RULES = { win: WIN_TABLE, edge: CHINCHIRO_HOUSE_EDGE, lossCap: CHINCHIRO_MAX_LOSS_MULT };

const POLICIES: Array<[string, ChinchiroPolicy]> = [
  ["目が出たら必ず止める", { kind: "always_stop" }],
  ["スコア4以上で止める", { kind: "stop_at", threshold: 4 }],
  ["スコア5以上で止める（マモン同）", { kind: "stop_at", threshold: 5 }],
  ["スコア6以上で止める", { kind: "stop_at", threshold: 6 }],
  ["投数まで振り続ける", { kind: "always_reroll" }],
];

const ROUNDS = 250_000;
const SEEDS = [11, 22, 33];

/**
 * 頻度表は**最初に必要になったときに1度だけ**作る。
 * モジュールの読み込み中に長い同期ループを回すと、collect フェーズがブロックされて
 * vitest のワーカーが親へ進捗を返せなくなる（`Timeout calling "onTaskUpdate"`）。
 */
let talliesCache: Map<string, Tally> | undefined;
function tallies(): Map<string, Tally> {
  talliesCache ??= new Map(POLICIES.map(([n, p]) => [n, tally(p, ROUNDS, SEEDS)]));
  return talliesCache;
}

describe("敗北倍率2倍化にともなうRTP調整（正本 §1.5）", () => {
  it("閉じた式が実装（chinchiroPayout / chinchiroCompare）と一致する", () => {
    // 頻度表からの計算が実装からずれていたら、下の比較は意味を失う。
    // 代表役について「実装の払戻」と「式の払戻」が一致することを押さえておく。
    const bet = 1_000_000; // 端数丸めの影響を無視できる大きさ
    for (const s of SLOTS) {
      const expected = bet * (1 + WIN_TABLE[s] * (1 - CHINCHIRO_HOUSE_EDGE));
      expect(chinchiroPayout(bet, WIN_TABLE[s]), s).toBe(Math.floor(expected));
    }
    // 負け側: マモンのピンゾロでも上限2倍
    expect(chinchiroPlayerLoss(bet, chinchiroCompare(hand(2, 2, 6), hand(1, 1, 1)).mul)).toBe(bet * 2);
  });

  it("どの方針でも基準RTPとの差が ±0.5pt 以内に収まっている", () => {
    const rows: string[] = [];
    let worst = 0;
    for (const [label] of POLICIES) {
      const t = tallies().get(label)!;
      const oldRtp = rtpOf(t, OLD_RULES);
      const newRtp = rtpOf(t, NEW_RULES);
      const diff = (newRtp - oldRtp) * 100;
      worst = Math.max(worst, Math.abs(diff));
      rows.push(
        `  ${label.padEnd(20)} 旧 ${(oldRtp * 100).toFixed(2)}%  →  新 ${(newRtp * 100).toFixed(2)}%  (${diff >= 0 ? "+" : ""}${diff.toFixed(2)}pt)`,
      );
    }
    console.log(
      `=== チンチロ RTP: 敗北倍率 最大5倍→2倍 / エッジ ${(0.05 * 100).toFixed(0)}%→${(CHINCHIRO_HOUSE_EDGE * 100).toFixed(0)}%` +
        `（各方針 ${(ROUNDS * SEEDS.length).toLocaleString()} 対局・同一サンプル）===`,
    );
    for (const row of rows) console.log(row);
    for (const [label] of POLICIES) {
      const t = tallies().get(label)!;
      const diff = (rtpOf(t, NEW_RULES) - rtpOf(t, OLD_RULES)) * 100;
      expect(Math.abs(diff), `${label}: ${diff.toFixed(2)}pt`).toBeLessThanOrEqual(0.5);
    }
    // 方針間のばらつきは残る（1つの定数で全方針を完全一致させることはできない）
    expect(worst).toBeGreaterThan(0.2);
  });

  it("エッジを戻さないと RTP が +5pt 以上 上振れする（調整が要る理由の回帰）", () => {
    for (const [label] of POLICIES) {
      const t = tallies().get(label)!;
      const noAdjust = rtpOf(t, { win: WIN_TABLE, edge: 0.05, lossCap: CHINCHIRO_MAX_LOSS_MULT });
      const diff = (noAdjust - rtpOf(t, OLD_RULES)) * 100;
      expect(diff, label).toBeGreaterThan(4.5);
    }
  });

  it("エッジを上げただけ（敗北倍率そのまま）では RTP が下がりすぎる", () => {
    const t = tallies().get("スコア5以上で止める（マモン同）")!;
    const edgeOnly = rtpOf(t, { win: WIN_TABLE, edge: CHINCHIRO_HOUSE_EDGE, lossCap: Number.POSITIVE_INFINITY });
    expect((edgeOnly - rtpOf(t, OLD_RULES)) * 100).toBeLessThan(-4);
  });

  it("倍付け負けの発生率と勝率は常識的な範囲", () => {
    const r = chinchiroSimulateRtp(deterministicRng(7), 200_000, { kind: "stop_at", threshold: 5 });
    expect(r.doubleLossRate).toBeGreaterThan(0.12);
    expect(r.doubleLossRate).toBeLessThan(0.22);
    expect(r.winRate + r.pushRate).toBeGreaterThan(0.3);
    // シミュレータの RTP も閉じた式とほぼ一致する（別実装での相互検算）。
    // 別サンプル同士の比較なので許容は広め。式がずれていれば 4pt 以上開く
    const closed = rtpOf(tallies().get("スコア5以上で止める（マモン同）")!, NEW_RULES);
    expect(Math.abs(r.rtp - closed) * 100).toBeLessThan(1.5);
  });
});
