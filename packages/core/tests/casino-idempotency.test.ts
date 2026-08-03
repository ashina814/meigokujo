import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Casino, JACKPOT_HOLDER } from "../src/casino/service.js";
import { ChipLedger, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { Items } from "../src/casino/items.js";
import { Markets } from "../src/casino/market.js";
import { Stocks } from "../src/casino/stocks.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { deterministicRng } from "../src/casino/rng.js";
import { deptAccount } from "../src/departments/service.js";
import { testTransfer, opId } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * 「外部操作1回 = 最外部グループ1個」の受入テスト。
 *
 * 見るのは4点:
 * - その1回ぶんの資金移動と副作用（お守り・預り台帳・保有株）が同じグループに入っている
 * - 可変状態の判定（残高・保有数・板の状態）がグループの**中**にある
 * - 途中で例外が出たら、資金も副作用も全部戻る
 * - 同じ operationId は常に最初の結果を返す（二重に動かない）
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new ChipLedger(db, ledger, events, { chipTx });
  const items = new Items(db);
  const casino = new Casino(db, ether, events, { items });
  const escrow = new Escrow(db, ether, events);
  return { db, ledger, events, chipTx, ether, items, casino, escrow };
}

function fundHouse(ctx: ReturnType<typeof setup>, amount: number): void {
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: `seed:dept:${amount}`,
  });
  ctx.ether.fundFromAccount(deptAccount("賭博場"), amount, HOUSE_HOLDER, `seed:house:${amount}`);
}

function fundUser(ctx: ReturnType<typeof setup>, userId: string, land: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY, to: `user:${userId}`, amount: land, type: "initial", actor: "t",
    idempotencyKey: `seed:user:${userId}`,
  });
  ctx.ether.buy(userId, land, `buy:${userId}`);
}

describe("お守りの消費は精算と同じグループ", () => {
  it("精算が落ちたらお守りも残高も戦績も明細も元へ戻る", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 10_000);
    ctx.items.grant("alice", "omamori", 1);
    expect(ctx.items.arm("alice", "omamori").ok).toBe(true);

    const balanceBefore = ctx.ether.balanceOf("alice");
    const txCountBefore = (ctx.db.prepare("SELECT COUNT(*) AS c FROM casino_tx").get() as { c: number }).c;
    // 胴元がほぼ空なので、賭け金を取り込んだ後の配当で必ず落ちる
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(0);

    expect(() =>
      ctx.casino.settleSolo("alice", "スロット", 1_000, 5_000, { operationId: "op-boom" }),
    ).toThrow();

    // お守りは装備されたまま（消費だけ通っていない）
    expect(ctx.items.isArmed("alice", "omamori")).toBe(true);
    expect(ctx.ether.balanceOf("alice")).toBe(balanceBefore);
    expect(ctx.casino.stats("alice").games).toBe(0);
    expect(ctx.chipTx.getGroup("solo:スロット:alice:op-boom")).toBeUndefined();
    expect((ctx.db.prepare("SELECT COUNT(*) AS c FROM casino_tx").get() as { c: number }).c).toBe(txCountBefore);
    ctx.db.close();
  });

  it("成功した精算はお守りを1回だけ消費し、再試行は同じ結果を返す", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);
    ctx.items.grant("alice", "omamori", 2);
    expect(ctx.items.arm("alice", "omamori").ok).toBe(true);

    const first = ctx.casino.settleSolo("alice", "スロット", 1_000, 5_000, { operationId: "op-1" });
    expect(first.amuletNote).toBeDefined();
    expect(ctx.items.isArmed("alice", "omamori")).toBe(false);
    const after = ctx.ether.balanceOf("alice");

    // 再装備してから同じ操作をもう一度 → 保存済みの結果が返り、2枚目は消費されない
    expect(ctx.items.arm("alice", "omamori").ok).toBe(true);
    expect(ctx.casino.settleSolo("alice", "スロット", 1_000, 5_000, { operationId: "op-1" })).toEqual(first);
    expect(ctx.items.isArmed("alice", "omamori")).toBe(true);
    expect(ctx.ether.balanceOf("alice")).toBe(after);
    expect(ctx.casino.stats("alice").games).toBe(1);
    ctx.db.close();
  });

  it("グループの外でお守りを消費できない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 10_000);
    ctx.items.grant("alice", "omamori", 1);
    ctx.items.arm("alice", "omamori");

    expect(() => ctx.casino.consumeAmulets("alice", 1_000, 5_000)).toThrow();
    expect(ctx.items.isArmed("alice", "omamori")).toBe(true);
    ctx.db.close();
  });
});

describe("対人卓の徴収・返金・精算は一業務一グループ", () => {
  it("2人徴収の2人目が足りなければ、1人目も預託されない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    fundUser(ctx, "bob", 100);

    expect(ctx.escrow.holdAll("sess1", ["alice", "bob"], 2_000, "丁半", "op-1")).toBe(false);

    expect(ctx.ether.balanceOf("alice")).toBe(5_000);
    expect(ctx.ether.balanceOf("bob")).toBe(100);
    expect(ctx.escrow.poolOf("sess1")).toBe(0);
    expect(ctx.ether.balanceOf(ctx.escrow.holderId("sess1"))).toBe(0);
    // グループごと巻き戻っているので、資金が増えれば同じ鍵で再試行できる
    expect(ctx.chipTx.getGroup("escrow:hold_all:sess1:op-1")).toBeUndefined();
    ctx.db.close();
  });

  it("成功済みの徴収を再試行しても、事前残高確認で false にならない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 2_000);
    fundUser(ctx, "bob", 2_000);

    expect(ctx.escrow.holdAll("sess1", ["alice", "bob"], 2_000, "丁半", "op-1")).toBe(true);
    expect(ctx.ether.balanceOf("alice")).toBe(0);

    // 所持額ちょうどを預けた後（残高0）でも、同じ操作の再試行は true
    expect(ctx.escrow.holdAll("sess1", ["alice", "bob"], 2_000, "丁半", "op-1")).toBe(true);
    expect(ctx.escrow.poolOf("sess1")).toBe(4_000);
    expect(ctx.ether.balanceOf(ctx.escrow.holderId("sess1"))).toBe(4_000);
    ctx.db.close();
  });

  it("2人返金の途中で落ちたら、両者とも未返金のまま残る", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 3_000);
    fundUser(ctx, "bob", 3_000);
    ctx.escrow.holdAll("sess1", ["alice", "bob"], 1_000, "丁半", "op-1");

    expect(() =>
      ctx.escrow.refundMany("sess1", ["alice", "bob"], "op-refund", (i) => {
        if (i === 1) throw new Error("2人目で落ちる");
      }),
    ).toThrow("2人目で落ちる");

    expect(ctx.ether.balanceOf("alice")).toBe(2_000);
    expect(ctx.ether.balanceOf("bob")).toBe(2_000);
    expect(ctx.escrow.poolOf("sess1")).toBe(2_000);
    expect(ctx.ether.balanceOf(ctx.escrow.holderId("sess1"))).toBe(2_000);

    // 巻き戻っているので同じ鍵で再試行でき、今度は両者に返る
    expect(ctx.escrow.refundMany("sess1", ["alice", "bob"], "op-refund")).toBe(2);
    expect(ctx.ether.balanceOf("alice")).toBe(3_000);
    expect(ctx.ether.balanceOf("bob")).toBe(3_000);
    expect(ctx.escrow.poolOf("sess1")).toBe(0);
    ctx.db.close();
  });

  it("成功済みの精算を再試行しても、pool 確認で落ちず同じ結果を返す", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 3_000);
    fundUser(ctx, "bob", 3_000);
    ctx.escrow.holdAll("sess1", ["alice", "bob"], 1_000, "丁半", "op-1");

    const dist = [{ to: "alice", amount: 2_000 }];
    const first = ctx.escrow.settle("sess1", dist, "system:test", "テスト精算");
    expect(ctx.ether.balanceOf("alice")).toBe(4_000);
    expect(ctx.ether.balanceOf(ctx.escrow.holderId("sess1"))).toBe(0);

    // 預り所は空になっているが、同じセッションの再試行は保存済みの結果を返す
    expect(ctx.escrow.settle("sess1", dist, "system:test", "テスト精算")).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(4_000);
    ctx.db.close();
  });
});

describe("板の可変状態はグループの中で見る", () => {
  it("賭けた後に板を締め切っても、同じ operationId は保存済みの結果を返す", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 50_000);
    const markets = new Markets(ctx.db, ctx.ether, ctx.events);
    const market = markets.create({
      operationId: opId(), guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 0,
    });

    const first = markets.bet(market.id, "alice", 0, 1_000, "op-bet");
    const balanceAfter = ctx.ether.balanceOf("alice");
    markets.close(market.id, "admin");
    expect(markets.get(market.id)!.status).toBe("closed");

    expect(markets.bet(market.id, "alice", 0, 1_000, "op-bet")).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(balanceAfter);
    expect(markets.bets(market.id)).toHaveLength(1);

    // 別の操作IDでの新規ベットは、締切済みなのできちんと弾かれる
    expect(() => markets.bet(market.id, "alice", 0, 1_000, "op-bet-2")).toThrow("ERR_NOT_OPEN");
    ctx.db.close();
  });

  it("エスクロー不整合の板は資金を動かさず凍結される（凍結は巻き戻さない）", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 50_000);
    const markets = new Markets(ctx.db, ctx.ether, ctx.events);
    const market = markets.create({
      operationId: opId(), guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 0,
    });
    markets.bet(market.id, "alice", 0, 1_000, "op-bet");

    // 板の預り所から資金だけ抜いて不整合を作る
    testTransfer(ctx.ether, `escrow:market:${market.id}`, HOUSE_HOLDER, 400, "不整合を作る");
    const balanceBefore = ctx.ether.balanceOf("alice");

    expect(() => markets.bet(market.id, "alice", 0, 2_000, "op-bet-2")).toThrow("ERR_UNDERFUNDED_ESCROW");
    expect(ctx.ether.balanceOf("alice")).toBe(balanceBefore);
    expect(markets.get(market.id)!.status).toBe("frozen");
    ctx.db.close();
  });
});

describe("板の最終処理（返金・無効化）も1グループ", () => {
  function openMarketWithBets(ctx: ReturnType<typeof setup>) {
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 50_000);
    fundUser(ctx, "bob", 50_000);
    const markets = new Markets(ctx.db, ctx.ether, ctx.events);
    const market = markets.create({
      operationId: opId(), guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 0,
    });
    markets.bet(market.id, "alice", 0, 1_000, "op-a");
    markets.bet(market.id, "bob", 1, 2_000, "op-b");
    return { markets, market };
  }

  it("返金の成功後に再試行しても、保存済みの結果が返り資金は二度動かない", () => {
    const ctx = setup();
    const { markets, market } = openMarketWithBets(ctx);

    const first = markets.refund(market.id, "admin-1");
    expect(first).toEqual({ id: market.id, refunded: 3_000, users: 2, alreadyClosed: false });
    expect(ctx.ether.balanceOf("alice")).toBe(50_000);
    expect(markets.get(market.id)!.status).toBe("void");

    // 別の管理者・起動時掃除から再試行しても、鍵の取り違えにならず同じ結果を返す
    expect(markets.refund(market.id, "admin-2")).toEqual(first);
    expect(markets.refund(market.id, "system:startup")).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(50_000);
    expect(ctx.ether.balanceOf("bob")).toBe(50_000);
    expect(ctx.ether.balanceOf(`escrow:market:${market.id}`)).toBe(0);
    ctx.db.close();
  });

  it("無効化の成功後に再試行しても、ERR_NOT_DISPUTED にならず同じ結果を返す", () => {
    const ctx = setup();
    const { markets, market } = openMarketWithBets(ctx);
    markets.close(market.id, "admin");
    markets.report(market.id, "alice", 0);
    markets.dispute(market.id, "bob");

    const first = markets.adminVoid(market.id, "admin-1");
    expect(first).toEqual({ id: market.id, refunded: 3_000, users: 2, alreadyClosed: false });
    expect(markets.get(market.id)!.status).toBe("void");

    expect(markets.adminVoid(market.id, "admin-2")).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(50_000);
    expect(ctx.ether.balanceOf("bob")).toBe(50_000);
    ctx.db.close();
  });

  it("途中で落ちたら、返金も status もイベントもすべて戻る", () => {
    const ctx = setup();
    const { markets, market } = openMarketWithBets(ctx);
    const escrowHolder = `escrow:market:${market.id}`;
    const eventsBefore = (ctx.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;

    expect(() =>
      markets.refund(market.id, "admin-1", (i) => {
        if (i === 1) throw new Error("2人目で落ちる");
      }),
    ).toThrow("2人目で落ちる");

    expect(ctx.ether.balanceOf("alice")).toBe(49_000);
    expect(ctx.ether.balanceOf("bob")).toBe(48_000);
    expect(ctx.ether.balanceOf(escrowHolder)).toBe(3_000);
    expect(markets.get(market.id)!.status).toBe("open");
    expect((ctx.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c).toBe(eventsBefore);
    expect(ctx.chipTx.getGroup(`market:refund:${market.id}`)).toBeUndefined();

    // 巻き戻っているので同じ鍵で再試行でき、今度は最後まで通る
    expect(markets.refund(market.id, "admin-1").refunded).toBe(3_000);
    expect(ctx.ether.balanceOf("alice")).toBe(50_000);
    expect(ctx.ether.balanceOf("bob")).toBe(50_000);
    ctx.db.close();
  });
});

describe("胴元不足の強制売却は保留する（false を保存しない）", () => {
  it("資金を補充すれば次の tick で売却できる", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 50_000);
    const stocks = new Stocks(ctx.db, ctx.ether, ctx.events, { rng: deterministicRng(1) });
    const stock = stocks.list()[0]!;
    stocks.buy("alice", stock.id, 1, "op-buy");
    // 保有期限を過ぎた建玉にする
    ctx.db
      .prepare("UPDATE casino_holdings SET bought_at = ? WHERE user_id = ? AND stock_id = ?")
      .run(1, "alice", stock.id);

    // 胴元を空にする（払えない状態）
    const houseHas = ctx.ether.balanceOf(HOUSE_HOLDER);
    testTransfer(ctx.ether, HOUSE_HOLDER, JACKPOT_HOLDER, houseHas, "胴元を空にする");
    expect(stocks.forceSellExpired()).toEqual([]);
    // 保留なのでグループを残さない（残すと以後ずっと「売れなかった」が再生される）
    const groupKey = `stock:force_sell:alice:${stock.id}:1`;
    expect(ctx.chipTx.getGroup(groupKey)).toBeUndefined();
    expect(stocks.holdings("alice")).toHaveLength(1);

    // 資金を戻すと、次の tick で同じ建玉が売れる
    testTransfer(ctx.ether, JACKPOT_HOLDER, HOUSE_HOLDER, houseHas, "胴元へ資金補充");
    const sold = stocks.forceSellExpired();
    expect(sold).toHaveLength(1);
    expect(sold[0]!.userId).toBe("alice");
    expect(ctx.chipTx.getGroup(groupKey)).toBeDefined();
    expect(stocks.holdings("alice")).toHaveLength(0);

    // もう一度 tick を回しても二重に払わない（保有行が消えているので対象外）
    expect(stocks.forceSellExpired()).toEqual([]);
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    ctx.db.close();
  });
});
