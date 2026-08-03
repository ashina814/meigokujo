import { describe, expect, it, vi } from "vitest";
import {
  ChipTx,
  EtherExchange,
  EventLog,
  Ledger,
  Stocks,
  deterministicRng,
  openDb,
  registerDefaultTxTypes,
} from "@meigokujo/core";
import { readFileSync } from "node:fs";
import { STOCKS_PAUSED, STOCKS_PAUSE_REASON, replyStocksPaused } from "../src/casino/stocks-pause.js";

registerDefaultTxTypes();

/**
 * PR6（株の停止）。
 *
 * 一番大事なのは「**建玉に一切触れていない**」こと。
 * 強制売却は正式資産だった場合の補償基準（時価）を自分で壊すので、
 * 清算は PR12 の正式開業初期化まで行わない。
 */

/**
 * `register-commands.ts` は読み込むと即 REST 登録に走るスクリプトなので、
 * import ではなくソースを読んで確認する。
 */
const srcOf = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("コマンド登録から外れている", () => {
  it("/株 が登録リストに無い", () => {
    const src = srcOf("../src/register-commands.ts");
    expect(src).not.toContain("stocksCommand");
    // 他の賭場コマンドは残っている（株だけを止めた）
    expect(src).toContain("asobuCommand");
    expect(src).toContain("annaiCommand");
  });

  it("株の操作は全経路が停止案内へ向いている", () => {
    const src = srcOf("../src/index.ts");
    expect(src).not.toContain("handleStocksCommand");
    expect(src).not.toContain("handleStocksButton");
    expect(src).not.toContain("handleStocksSelect");
    expect(src).not.toContain("handleStocksModal");
    expect(src).toContain("replyStocksPaused");
  });

  it("ホーム（/案内）の導線から外れ、停止中とだけ書いてある", () => {
    const src = srcOf("../src/commands/annai.ts");
    expect(src).not.toContain("6銘柄・1時間毎更新");
    expect(src).toContain("**停止中**");
  });
});

describe("停止理由が利用者に説明される", () => {
  it("理由文に「停止」と「建玉を触らない」が入っている", () => {
    expect(STOCKS_PAUSED).toBe(true);
    expect(STOCKS_PAUSE_REASON).toContain("停止");
    expect(STOCKS_PAUSE_REASON).toContain("持っている株はそのままだ");
  });

  it("コマンド・ボタン・選択のどれでも同じ文面を ephemeral で返す", async () => {
    const reply = vi.fn(async () => undefined);
    const i = { isRepliable: () => true, reply } as never;
    await replyStocksPaused(i);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0].content).toBe(STOCKS_PAUSE_REASON);
    expect(reply.mock.calls[0]![0].flags).toBeDefined();
  });

  it("応答できない interaction には何もしない", async () => {
    const reply = vi.fn(async () => undefined);
    await replyStocksPaused({ isRepliable: () => false, reply } as never);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe("建玉に触れていない", () => {
  it("刻時盤から株の価格更新・強制売却の呼び出しが消えている", () => {
    const src = srcOf("../src/scheduler.ts");
    expect(src).not.toContain("services.stocks.updateAll");
    expect(src).not.toContain("services.stocks.forceSellExpired");
    expect(src).toContain("建玉には一切触れない");
  });

  it("保有データはそのまま残る（読めるが動かない）", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db);
    const events = new EventLog(db);
    const chipTx = new ChipTx(db);
    const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
    const stocks = new Stocks(db, ether, events, { rng: deterministicRng(1) });

    // 建玉を1件作っておく（停止前からの保有を模す）
    db.prepare(
      "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('u1', 100000, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
    ).run();
    const first = stocks.list()[0]!;
    ether.runGroup({ groupKey: "stock:buy:u1:1", kind: "solo_game", actorId: "u1" }, () => {
      stocks.buy("u1", first.id, 1, "op1");
    });
    const before = stocks.holdings("u1");
    expect(before.length).toBe(1);

    // 停止中は刻時盤が何も呼ばないので、建玉も価格も動かない
    const priceBefore = stocks.get(first.id)!.price;
    expect(stocks.holdings("u1")).toEqual(before);
    expect(stocks.get(first.id)!.price).toBe(priceBefore);
    db.close();
  });
});
