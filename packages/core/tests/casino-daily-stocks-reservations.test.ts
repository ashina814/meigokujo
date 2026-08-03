import { describe, expect, it } from "vitest";
import {
  ChipTx,
  ChipLedger,
  Daily,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  RELIEF_HOLDER,
  Stocks,
  StockError,
  openDb,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

/**
 * マージ直前レビュー対応: 福分け（Daily）と株式市場（Stocks）は house の生残高を見て
 * 直接支払っていた。進行中ゲームの予約（HouseReservations）を考慮しないと、
 * 「予約は取れたのに、後で settle しようとしたら house が薄くなっていて払えない」
 * という事故が起こりうる。ここでは両方とも `ChipLedger.settleableBalance()`
 * （house 残高 − 予約合計）だけを対象にすることを確かめる。
 */

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new ChipLedger(db, ledger, events, { chipTx, requireOpeningV1: false });
  const reservations = new HouseReservations(db, ether, events);
  // services.ts と同じ配線: house だけ予約合計を反映する
  ether.setReservedProvider((holderId: string) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const daily = new Daily(db, ether, events, { base: 100, reliefThreshold: 0, reliefMax: 500 });
  const stocks = new Stocks(db, ether, events);
  return { db, ledger, events, chipTx, ether, reservations, daily, stocks };
}

function seed(db: ReturnType<typeof openDb>, holder: string, amount: number): void {
  db.prepare(
    "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
  ).run(holder, amount);
}

describe("福分け（Daily）は予約済み資金を侵食しない", () => {
  it("house残高100・予約80のとき、houseからは最大20までしか出さない（残りは救済プールへ）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100);
    seed(c.db, RELIEF_HOLDER, 1_000);
    c.reservations.reserve("game:1", 80, "スロット", "other-user");

    const r = c.daily.claim("u1", "op1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // base=100 を要求。house から出せるのは settleable=20 まで、残り80は救済プールから。
    // house 残高は 100 → 20 出て 80 残る（予約80の裏付けはそのまま残る）
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(80);
    expect(r.claim.total).toBeGreaterThanOrEqual(100); // 満額は届く（救済でカバー）
    c.db.close();
  });

  it("福分け後も予約80のゲームを満額精算できる（houseの裏付けが残っている）", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100);
    seed(c.db, RELIEF_HOLDER, 1_000);
    const key = c.reservations.reserve("game:1", 80, "スロット", "other-user");
    expect(key.ok).toBe(true);

    c.daily.claim("u1", "op1");
    // 予約ぶんの80は house に残っているはず
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBeGreaterThanOrEqual(80);
    // 実際にその80を配当として払い切れる（予約を使う側の精算を模した runGroup）
    c.ether.runGroup({ groupKey: "settle:1", kind: "solo_game", actorId: "winner" }, () => {
      c.ether.transfer(HOUSE_HOLDER, "winner", 80, { reason: "配当（テスト）" });
    });
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(0);
    c.db.close();
  });

  it("予約が house 残高すべてを占めていても、救済プールだけで満額支給できる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 100);
    seed(c.db, RELIEF_HOLDER, 1_000);
    c.reservations.reserve("game:1", 100, "スロット", "other-user");

    const r = c.daily.claim("u1", "op1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(c.ether.balanceOf(HOUSE_HOLDER)).toBe(100); // house は一切減らない
    expect(r.claim.total).toBeGreaterThanOrEqual(100); // 満額は救済プールから届く
    c.db.close();
  });
});

describe("株式市場（Stocks）は予約済み資金を侵食しない", () => {
  /**
   * 買い注文はその代金を house へ入れる（house 残高を増やす）ので、
   * 「house が薄い」状況を作るには、買った**後**に house 残高を作り直す
   * （他ゲームの精算等で house が既に費消された状態を模す）。
   */
  function buyThenDrainHouse(c: ReturnType<typeof setup>, shares: number, houseAfter: number) {
    seed(c.db, "u1", 1_000_000_000);
    c.stocks.buy("u1", "hone", shares, "buy-op");
    seed(c.db, HOUSE_HOLDER, houseAfter);
  }

  it("house残高100・予約80のとき、代金29,700の売却は拒否され株数は減らない", () => {
    const c = setup();
    buyThenDrainHouse(c, 30, 100);
    c.reservations.reserve("game:1", 80, "スロット", "other-user");

    // 売却代金は 30株 × 1000 × (1-0.01) = 29,700。settleable=20 では払えない
    expect(() => c.stocks.sell("u1", "hone", 30, "sell-op")).toThrow(StockError);
    const holdings = c.stocks.holdings("u1");
    expect(holdings.find((h) => h.stock_id === "hone")?.shares).toBe(30);
    c.db.close();
  });

  it("予約解放後は同じ売却が成功する", () => {
    const c = setup();
    // 代金は 1×1000×0.99=990。house=1000・予約900なら settleable=100 で足りず拒否、
    // 解放後は settleable=1000 に戻り足りる
    buyThenDrainHouse(c, 1, 1_000);
    c.reservations.reserve("game:1", 900, "スロット", "other-user");

    expect(() => c.stocks.sell("u1", "hone", 1, "sell-op")).toThrow(StockError);
    c.reservations.release("game:1");
    const r = c.stocks.sell("u1", "hone", 1, "sell-op-2");
    expect(r.proceeds).toBeGreaterThan(0);
    expect(c.stocks.holdings("u1").find((h) => h.stock_id === "hone")).toBeUndefined();
    c.db.close();
  });

  it("強制売却も同じ条件で保留され、次回再試行できる", () => {
    const c = setup();
    // 代金は 30×1000×0.99=29,700。house=30,000・予約1,000なら settleable=29,000 で足りず保留、
    // 解放後は settleable=30,000 に戻り足りる
    buyThenDrainHouse(c, 30, 30_000);
    c.reservations.reserve("game:1", 1_000, "スロット", "other-user");
    // 保有期限を過ぎさせる
    c.db
      .prepare("UPDATE casino_holdings SET bought_at = ? WHERE user_id = ? AND stock_id = ?")
      .run(Math.floor(Date.now() / 1000) - 4 * 86_400, "u1", "hone");

    const first = c.stocks.forceSellExpired();
    expect(first).toEqual([]); // settleable不足で保留、株は残る
    expect(c.stocks.holdings("u1").find((h) => h.stock_id === "hone")?.shares).toBe(30);

    c.reservations.release("game:1");
    const second = c.stocks.forceSellExpired();
    expect(second).toHaveLength(1);
    expect(c.stocks.holdings("u1").find((h) => h.stock_id === "hone")).toBeUndefined();
    c.db.close();
  });

  it("予約が無ければ従来どおり house 全額を対象にできる", () => {
    const c = setup();
    seed(c.db, HOUSE_HOLDER, 1_000_000);
    seed(c.db, "u1", 1_000_000);
    c.stocks.buy("u1", "hone", 100, "buy-op");
    const r = c.stocks.sell("u1", "hone", 100, "sell-op");
    expect(r.proceeds).toBeGreaterThan(0);
    c.db.close();
  });
});
