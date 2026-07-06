import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Chips } from "../src/chips/service.js";
import { Poker, PokerError, evaluateHand, compareHands } from "../src/poker/service.js";
import type { Card } from "../src/casino/service.js";

registerDefaultTxTypes();

const c = (rank: number, suit: string): Card => ({ rank, suit });

describe("ポーカー役判定", () => {
  it("役のカテゴリを正しく判定する", () => {
    expect(evaluateHand([c(1, "♠"), c(13, "♠"), c(12, "♠"), c(11, "♠"), c(10, "♠")]).name).toBe("ストレートフラッシュ");
    expect(evaluateHand([c(7, "♠"), c(7, "♥"), c(7, "♦"), c(7, "♣"), c(2, "♠")]).name).toBe("フォーカード");
    expect(evaluateHand([c(7, "♠"), c(7, "♥"), c(7, "♦"), c(2, "♣"), c(2, "♠")]).name).toBe("フルハウス");
    expect(evaluateHand([c(2, "♠"), c(5, "♠"), c(8, "♠"), c(11, "♠"), c(13, "♠")]).name).toBe("フラッシュ");
    expect(evaluateHand([c(1, "♠"), c(2, "♥"), c(3, "♦"), c(4, "♣"), c(5, "♠")]).name).toBe("ストレート"); // A-2-3-4-5
    expect(evaluateHand([c(9, "♠"), c(9, "♥"), c(9, "♦"), c(4, "♣"), c(2, "♠")]).name).toBe("スリーカード");
    expect(evaluateHand([c(9, "♠"), c(9, "♥"), c(4, "♦"), c(4, "♣"), c(2, "♠")]).name).toBe("ツーペア");
    expect(evaluateHand([c(9, "♠"), c(9, "♥"), c(7, "♦"), c(4, "♣"), c(2, "♠")]).name).toBe("ワンペア");
    expect(evaluateHand([c(13, "♠"), c(9, "♥"), c(7, "♦"), c(4, "♣"), c(2, "♠")]).name).toBe("ハイカード");
  });

  it("同カテゴリはキッカーで比較（ペアの高い方が勝ち）", () => {
    const kk = evaluateHand([c(13, "♠"), c(13, "♥"), c(7, "♦"), c(4, "♣"), c(2, "♠")]);
    const qq = evaluateHand([c(12, "♠"), c(12, "♥"), c(1, "♦"), c(4, "♣"), c(2, "♠")]);
    expect(compareHands(kk, qq)).toBeGreaterThan(0);
  });

  it("エースハイ・ストレートは A-2-3-4-5 より強い", () => {
    const broadway = evaluateHand([c(1, "♠"), c(13, "♥"), c(12, "♦"), c(11, "♣"), c(10, "♠")]);
    const wheel = evaluateHand([c(1, "♠"), c(2, "♥"), c(3, "♦"), c(4, "♣"), c(5, "♠")]);
    expect(compareHands(broadway, wheel)).toBeGreaterThan(0);
  });
});

describe("ポーカーのテーブル進行", () => {
  function setup() {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const chips = new Chips(db, ledger, events);
    const poker = new Poker(db, chips, events, () => 0);
    for (const u of ["host", "p2", "p3"]) {
      ledger.ensureAccount(`user:${u}`, "user");
      ledger.transfer({ from: TREASURY, to: `user:${u}`, amount: 100_000, type: "initial", actor: "t", idempotencyKey: `f:${u}` });
      chips.buy(u, 50_000, `b:${u}`);
    }
    return { db, ledger, chips, poker };
  }

  it("参加費が pot に集まり、ショーダウンで勝者が総取り（テラ銭のぶん引く）＝総量保存", () => {
    const ctx = setup();
    const total0 = ctx.chips.outstanding();
    const t = ctx.poker.create("host", 1_000);
    ctx.poker.join(t.id, "p2");
    ctx.poker.join(t.id, "p3");
    expect(ctx.chips.balanceOf(t.potHolder)).toBe(3_000);

    ctx.poker.deal(t.id, "host");
    ctx.poker.swap(t.id, "host", []);
    ctx.poker.swap(t.id, "p2", []);
    ctx.poker.swap(t.id, "p3", []);
    const res = ctx.poker.showdown(t.id, "host");

    expect(res.pot).toBe(3_000);
    expect(res.rake).toBe(150); // 端数含む（5%=150）
    expect(res.winners.length).toBeGreaterThanOrEqual(1);
    // ポットは空に、チップ総量は不変（非インフレ）
    expect(ctx.chips.balanceOf(t.potHolder)).toBe(0);
    expect(ctx.chips.outstanding()).toBe(total0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("2人未満で配ろうとすると弾く / 解散で全額返金", () => {
    const ctx = setup();
    const t = ctx.poker.create("host", 2_000);
    expect(() => ctx.poker.deal(t.id, "host")).toThrow(PokerError); // 1人
    const before = ctx.chips.balanceOf("host");
    ctx.poker.cancel(t.id, "host");
    expect(ctx.chips.balanceOf("host")).toBe(before + 2_000); // 返金
  });
});
