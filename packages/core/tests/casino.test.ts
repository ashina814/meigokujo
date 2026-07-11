import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino, JACKPOT_HOLDER } from "../src/casino/service.js";
import { deptAccount, Departments } from "../src/departments/service.js";

registerDefaultTxTypes();

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const ether = new EtherExchange(db, ledger, new EventLog(db));
  const casino = new Casino(db, ether, new EventLog(db));
  const departments = new Departments(db, ledger);
  // 賭博場部署 → 胴元に元手 100,000 Land = 1,000,000 ◈
  departments.upsert("賭博場", "賭博場", null);
  ledger.transfer({ from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
  ether.fundFromAccount(deptAccount("賭博場"), 100_000, HOUSE_HOLDER, "seed:house");
  // プレイヤー a: 10,000 Land → 100,000 ◈
  ledger.ensureAccount("user:a", "user");
  ledger.transfer({ from: TREASURY, to: "user:a", amount: 10_000, type: "initial", actor: "t", idempotencyKey: "seed:a" });
  ether.buy("a", 10_000, "seed:buy:a");
  return { db, ledger, ether, casino };
}

describe("賭場の土台", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("負け: 賭け額が胴元へ移り、戦績に記録される", () => {
    const house0 = ctx.casino.houseBalance();
    const r = ctx.casino.settle("a", "slots", 1_000, 0);
    expect(r.net).toBe(-1_000);
    expect(ctx.ether.balanceOf("a")).toBe(99_000);
    expect(ctx.casino.houseBalance()).toBe(house0 + 1_000);
    const s = ctx.casino.stats("a");
    expect(s.games).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.total_wagered).toBe(1_000);
  });

  it("勝ち: 配当が支払われ、biggest_win と連勝が更新される", () => {
    ctx.casino.settle("a", "slots", 1_000, 5_000);
    ctx.casino.settle("a", "slots", 1_000, 2_000);
    const s = ctx.casino.stats("a");
    expect(s.wins).toBe(2);
    expect(s.biggest_win).toBe(4_000); // 純益ベース
    expect(s.current_win_streak).toBe(2);
    expect(s.best_win_streak).toBe(2);
    expect(ctx.ether.balanceOf("a")).toBe(100_000 - 2_000 + 5_000 + 2_000);
  });

  it("負けで連勝が切れ、連敗が伸びる", () => {
    ctx.casino.settle("a", "slots", 1_000, 3_000);
    ctx.casino.settle("a", "slots", 1_000, 0);
    ctx.casino.settle("a", "slots", 1_000, 0);
    const s = ctx.casino.stats("a");
    expect(s.current_win_streak).toBe(0);
    expect(s.current_lose_streak).toBe(2);
    expect(s.best_win_streak).toBe(1);
  });

  it("引き分け（返金）は勝敗にカウントしない", () => {
    ctx.casino.settle("a", "bj", 1_000, 1_000);
    const s = ctx.casino.stats("a");
    expect(s.games).toBe(1);
    expect(s.wins).toBe(0);
    expect(s.losses).toBe(0);
    expect(ctx.ether.balanceOf("a")).toBe(100_000);
  });

  it("テーブルリミット: 胴元残高を超える配当は受けられない", () => {
    expect(ctx.casino.canAccept(ctx.casino.houseBalance() + 1)).toBe(false);
    expect(ctx.casino.canAccept(ctx.casino.houseBalance())).toBe(true);
  });

  it("エテル不足の賭けは弾かれる", () => {
    expect(() => ctx.casino.settle("a", "slots", 999_999_999, 0)).toThrow();
  });

  it("JP積立と払い出し", () => {
    ctx.casino.settle("a", "slots", 1_000, 0, 10); // 10◈ JPへ
    expect(ctx.casino.jackpotPool()).toBe(10);
    const won = ctx.casino.seizeJackpot("a", "slots");
    expect(won).toBe(10);
    expect(ctx.casino.jackpotPool()).toBe(0);
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(0);
  });

  it("賭け・配当ではエテル総量が変わらない（総量保存）", () => {
    const total0 = ctx.ether.outstanding();
    ctx.casino.settle("a", "slots", 5_000, 12_000, 50);
    ctx.casino.settle("a", "slots", 5_000, 0);
    expect(ctx.ether.outstanding()).toBe(total0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("番付: 残高・勝率・最大勝ちのTopが取れる（house/jackpotは除外）", () => {
    ctx.casino.settle("a", "slots", 1_000, 3_000);
    const byBalance = ctx.casino.top("balance");
    expect(byBalance.some((r) => r.user_id === HOUSE_HOLDER)).toBe(false);
    expect(byBalance[0]!.user_id).toBe("a");
    const byWin = ctx.casino.top("biggest_win");
    expect(byWin[0]).toMatchObject({ user_id: "a", value: 2_000 });
  });
});
