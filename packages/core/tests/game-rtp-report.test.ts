import { describe, it } from "vitest";
import {
  chohanRtp, CHOHAN_PAYOUT,
  rouletteRtp,
  crashRtp,
  marketPlayerRtp, MARKET_HOUSE_CUT,
  keibaPlayerRtp, KEIBA_HOUSE_RATE,
  bjSimulateRtp,
  pokerSimulateRtp,
  holdemSimulateRtp,
  stockBuyThenSellRtp, STOCK_SELL_FEE,
} from "../src/casino/game-models.js";
import { computeRtp as slotsRtp } from "../src/casino/slots-model.js";
import { deterministicRng } from "../src/casino/rng.js";

/**
 * 全ゲームの RTP 一覧を stdout に出す（人間確認用のワンショット出力）。
 * CI では通常テストとして緑になるが、期待値の比較ではなく数値の可視化が目的。
 */
describe("全ゲームRTPレポート", () => {
  it("一覧", () => {
    const lines: string[] = [];
    const pushT = (game: string, kind: string, val: number, note = "") =>
      lines.push(`  ${game.padEnd(14)} ${kind.padEnd(20)} ${(val * 100).toFixed(2).padStart(7)}%  ${note}`);

    // 理論値
    const s = slotsRtp();
    pushT("スロット", "regular（理論）", s.regular);
    pushT("スロット", "+freeSpin（理論）", s.withFreeSpin);
    pushT("スロット", "+JP（理論）", s.withJackpot, `winRate=${(s.winRate * 100).toFixed(1)}%, jpHit=${(s.jpHitRate * 1_000_000).toFixed(1)}/1M`);
    pushT("丁半", "理論（配当×勝率）", chohanRtp(), `配当=${CHOHAN_PAYOUT}`);
    const rr = rouletteRtp();
    pushT("ルーレット", "赤/黒/奇偶/大小（理論）", rr.red);
    pushT("ルーレット", "零(単発36倍)（理論）", rr.single0);
    pushT("クラッシュ", "cashout=2.0 理論", crashRtp(2.0), "全 M 共通で 95.04%");
    pushT("板", "理論", marketPlayerRtp(), `場代 ${(MARKET_HOUSE_CUT * 100)}%`);
    pushT("競馬", "理論", keibaPlayerRtp(), `場代 ${(KEIBA_HOUSE_RATE * 100)}%`);
    pushT("株", "買って即売る", stockBuyThenSellRtp(), `売却手数料 ${(STOCK_SELL_FEE * 100)}%`);

    // シミュレーション
    const bj1 = bjSimulateRtp(deterministicRng(1), 40_000, "always_stand");
    pushT("BJ", "always_stand（40k）", bj1.rtp);
    const bj2 = bjSimulateRtp(deterministicRng(2), 40_000, "mimic_dealer");
    pushT("BJ", "mimic_dealer（40k）", bj2.rtp);
    const bj3 = bjSimulateRtp(deterministicRng(3), 40_000, "hard17", { doubleOnHard9to11: true });
    pushT("BJ", "hard17+double（40k）", bj3.rtp);
    const pk1 = pokerSimulateRtp(deterministicRng(1), 20_000, "hold_all");
    pushT("ポーカー", "hold_all（20k）", pk1.rtp);
    const pk2 = pokerSimulateRtp(deterministicRng(2), 20_000, "hold_pairs");
    pushT("ポーカー", "hold_pairs（20k）", pk2.rtp);
    const hd = holdemSimulateRtp(deterministicRng(4), 20_000);
    pushT("ホールデム", "check-only vs マモン（20k）", hd.rtp, `勝${hd.wins}/負${hd.losses}/引${hd.ties}`);

    console.log("\n=== ゲーム別 RTP 一覧 ===\n" + lines.join("\n"));
  });
});
