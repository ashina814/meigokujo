import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Casino, JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { EtherExchange, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { Daily } from "../src/casino/daily.js";
import { Vip } from "../src/casino/vip.js";
import { Markets } from "../src/casino/market.js";
import { ChipTx, ChipTxError, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { deptAccount } from "../src/departments/service.js";
import { testTransfer } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * PR1（取引監査基盤）の受入テスト。
 * 「いくら動いたか」だけでなく「なぜ・誰が・どの業務操作で動いたか」が残ること、
 * 同じ業務操作が二度実行されないこと、開始残高から現在残高を再現できることを見る。
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const casino = new Casino(db, ether, events);
  const escrow = new Escrow(db, ether, events);
  return { db, ledger, events, chipTx, ether, casino, escrow };
}

/** 賭博場部署に元手Landを入れ、house へチップを発行する */
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

describe("取引明細", () => {
  it("内部移動が1行だけ、理由・実行者付きで記録される", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);

    ctx.ether.runGroup({ groupKey: "g1", kind: "solo_game", actorId: "alice" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 300, { reason: "JP積立", game: "スロット" }),
    );

    const rows = ctx.chipTx.listByGroup("g1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tx_kind: "internal_transfer",
      from_holder: HOUSE_HOLDER,
      to_holder: JACKPOT_HOLDER,
      amount: 300,
      reason: "JP積立",
      game: "スロット",
      actor_id: "alice",
      ledger_tx_id: null,
    });
    ctx.db.close();
  });

  it("預入はLand取引IDを伴って記録される", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);

    const row = ctx.chipTx.listByGroup("buy:alice")[0]!;
    expect(row.tx_kind).toBe("deposit");
    expect(row.from_holder).toBeNull();
    expect(row.to_holder).toBe("alice");
    expect(row.ledger_tx_id).not.toBeNull();
    const land = ctx.db.prepare("SELECT amount, to_account FROM transactions WHERE id = ?").get(row.ledger_tx_id!) as {
      amount: number;
      to_account: string;
    };
    expect(land).toEqual({ amount: 5_000, to_account: ETHER_ESCROW });
    ctx.db.close();
  });

  it("返還はLand取引IDを伴って記録される", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);

    ctx.ether.sell("alice", 1_000, "sell:alice");

    const row = ctx.chipTx.listByGroup("sell:alice")[0]!;
    expect(row.tx_kind).toBe("redeem");
    expect(row.from_holder).toBe("alice");
    expect(row.to_holder).toBeNull();
    expect(row.ledger_tx_id).not.toBeNull();
    ctx.db.close();
  });

  it("理由が空の移動は受け付けない", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000);

    expect(() =>
      ctx.ether.runGroup({ groupKey: "g:empty", kind: "solo_game", actorId: "alice" }, () =>
        ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 10, { reason: "   " }),
      ),
    ).toThrow(ChipTxError);
    expect(ctx.chipTx.listByGroup("g:empty")).toHaveLength(0);
    ctx.db.close();
  });

  it("グループ内の seq が1から連番になる", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);

    ctx.ether.runGroup({ groupKey: "g:seq", kind: "solo_game", actorId: "alice" }, () => {
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 10, { reason: "1件目" });
      ctx.ether.transfer(HOUSE_HOLDER, RELIEF_HOLDER, 20, { reason: "2件目" });
      ctx.ether.transfer(JACKPOT_HOLDER, HOUSE_HOLDER, 5, { reason: "3件目" });
    });

    expect(ctx.chipTx.listByGroup("g:seq").map((r) => r.seq)).toEqual([1, 2, 3]);
    ctx.db.close();
  });

  it("グループの外ではチップを動かせない（記録できない移動を作らない）", () => {
    const ctx = setup();
    fundHouse(ctx, 1_000);

    expect(() => ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 10, { reason: "野良の移動" })).toThrow(ChipTxError);
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(0);
    ctx.db.close();
  });

  it("例外時はグループも明細も残高も残らない", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    const before = ctx.ether.balanceOf(HOUSE_HOLDER);

    expect(() =>
      ctx.ether.runGroup({ groupKey: "g:boom", kind: "solo_game", actorId: "alice" }, () => {
        ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 100, { reason: "途中まで成功" });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(ctx.chipTx.getGroup("g:boom")).toBeUndefined();
    expect(ctx.chipTx.listByGroup("g:boom")).toHaveLength(0);
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(before);
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(0);
    ctx.db.close();
  });

  it("明細は必ずグループに属する（孤立した明細を作れない）", () => {
    const ctx = setup();
    expect(() =>
      ctx.db
        .prepare(
          `INSERT INTO casino_tx (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, actor_id, created_at)
           VALUES ('missing', 1, 'internal_transfer', 'a', 'b', 1, '理由', 'x', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    ctx.db.close();
  });
});

describe("冪等性", () => {
  it("同じグループを二度実行しても資金は一度しか動かず、同じ結果を返す", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    const run = () =>
      ctx.ether.runGroup({ groupKey: "g:once", kind: "solo_game", actorId: "alice" }, () => {
        ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 500, { reason: "JP積立" });
        return { moved: 500 };
      });

    const first = run();
    const second = run();

    expect(first).toEqual({ moved: 500 });
    expect(second).toEqual({ moved: 500 });
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(500);
    expect(ctx.chipTx.listByGroup("g:once")).toHaveLength(1);
    ctx.db.close();
  });

  it("本体が例外で終わった後は、同じキーで再実行できる", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);

    expect(() =>
      ctx.ether.runGroup({ groupKey: "g:retry", kind: "solo_game", actorId: "alice" }, () => {
        ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 100, { reason: "JP積立" });
        throw new Error("一時的な失敗");
      }),
    ).toThrow("一時的な失敗");

    ctx.ether.runGroup({ groupKey: "g:retry", kind: "solo_game", actorId: "alice" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 100, { reason: "JP積立" }),
    );

    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(100);
    expect(ctx.chipTx.listByGroup("g:retry")).toHaveLength(1);
    ctx.db.close();
  });

  it("同じキーで100回叩いても記録は1回分だけ", async () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);

    await Promise.all(
      Array.from({ length: 100 }, async () =>
        ctx.ether.runGroup({ groupKey: "g:burst", kind: "solo_game", actorId: "alice" }, () =>
          ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 7, { reason: "JP積立" }),
        ),
      ),
    );

    expect(ctx.chipTx.listByGroup("g:burst")).toHaveLength(1);
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBe(7);
    ctx.db.close();
  });

  it("入れ子のグループは外側に合流し、二重にグループを作らない", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);

    ctx.ether.runGroup({ groupKey: "g:outer", kind: "table_settle", actorId: "staff" }, () => {
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 10, { reason: "外側" });
      ctx.ether.runGroup({ groupKey: "g:inner", kind: "solo_game", actorId: "alice" }, () =>
        ctx.ether.transfer(HOUSE_HOLDER, RELIEF_HOLDER, 20, { reason: "内側" }),
      );
    });

    expect(ctx.chipTx.getGroup("g:inner")).toBeUndefined();
    expect(ctx.chipTx.listByGroup("g:outer").map((r) => r.reason)).toEqual(["外側", "内側"]);
    ctx.db.close();
  });
});

describe("開始残高", () => {
  it("導入時の残高を一度だけ記録し、再実行しても二重登録しない", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    fundUser(ctx, "alice", 3_000);

    expect(ctx.chipTx.captureLegacyOpening()).toBe(true);
    expect(ctx.chipTx.captureLegacyOpening()).toBe(false);

    const opening = ctx.chipTx.openingBalances(LEGACY_OPENING_VERSION);
    expect(opening.get(HOUSE_HOLDER)).toBe(10_000);
    expect(opening.get("alice")).toBe(3_000);
    expect(ctx.chipTx.currentVersion()).toBe(LEGACY_OPENING_VERSION);
    ctx.db.close();
  });

  it("開始残高 + 取引 で現在残高を再現できる", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    fundUser(ctx, "alice", 3_000);
    ctx.chipTx.captureLegacyOpening();

    ctx.casino.settle("alice", "スロット", 1_000, 2_500, 50);
    ctx.ether.sell("alice", 500, "sell:alice");
    testTransfer(ctx.ether, HOUSE_HOLDER, RELIEF_HOLDER, 200, "救済プールへ補充");

    const replay = ctx.chipTx.replayBalances();
    for (const holder of [HOUSE_HOLDER, "alice", JACKPOT_HOLDER, RELIEF_HOLDER]) {
      expect(replay.get(holder) ?? 0).toBe(ctx.ether.balanceOf(holder));
    }
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    ctx.db.close();
  });

  it("1 Ld の食い違いを検出する", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    ctx.chipTx.captureLegacyOpening();

    // 記録を通さずに残高だけ書き換える（帳簿の外での改竄）
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run(HOUSE_HOLDER);

    const result = ctx.chipTx.verifyBalances();
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([{ holder: HOUSE_HOLDER, expected: 10_000, actual: 9_999 }]);
    ctx.db.close();
  });
});

describe("預入・返還と総量保存", () => {
  it("預入で準備Landと発行チップが同額増える", () => {
    const ctx = setup();
    ctx.ledger.ensureAccount("user:alice", "user");
    ctx.ledger.transfer({
      from: TREASURY, to: "user:alice", amount: 5_000, type: "initial", actor: "t", idempotencyKey: "seed:alice",
    });
    const poolBefore = ctx.ether.pool();
    const outstandingBefore = ctx.ether.outstanding();

    ctx.ether.buy("alice", 4_000, "buy:alice");

    expect(ctx.ether.pool() - poolBefore).toBe(4_000);
    expect(ctx.ether.outstanding() - outstandingBefore).toBe(4_000);
    ctx.db.close();
  });

  it("返還で準備Landと発行チップが同額減る", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    const poolBefore = ctx.ether.pool();
    const outstandingBefore = ctx.ether.outstanding();

    ctx.ether.sell("alice", 2_000, "sell:alice");

    expect(outstandingBefore - ctx.ether.outstanding()).toBe(2_000);
    // 準備Landは払い戻し + 焼却ぶん減る（1:1化はPR8。ここでは"Landも同時に減る"ことを見る）
    expect(ctx.ether.pool()).toBeLessThan(poolBefore);
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    ctx.db.close();
  });

  it("Land側が通らなければチップは発行されない", () => {
    const ctx = setup();
    // 残高0のまま買おうとする → Land送金で失敗
    expect(() => ctx.ether.buy("alice", 1_000, "buy:alice")).toThrow();

    expect(ctx.ether.balanceOf("alice")).toBe(0);
    expect(ctx.chipTx.getGroup("buy:alice")).toBeUndefined();
    ctx.db.close();
  });

  it("チップ側が通らなければLandも動かない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    const landBefore = ctx.ledger.balanceOf("user:alice");
    const poolBefore = ctx.ether.pool();

    // 持っていない額の返還は弾かれ、Land も動かない
    expect(() => ctx.ether.sell("alice", 99_999, "sell:too-much")).toThrow();

    expect(ctx.ledger.balanceOf("user:alice")).toBe(landBefore);
    expect(ctx.ether.pool()).toBe(poolBefore);
    ctx.db.close();
  });

  it("内部移動ではチップ総量が変わらない", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    fundUser(ctx, "alice", 3_000);
    const total = ctx.ether.outstanding();

    ctx.casino.settle("alice", "スロット", 1_000, 3_000, 50);

    expect(ctx.ether.outstanding()).toBe(total);
    const internal = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM casino_tx WHERE tx_kind = 'internal_transfer'")
      .get() as { c: number };
    expect(internal.c).toBeGreaterThan(0);
    ctx.db.close();
  });
});

describe("既存経路のグループ化", () => {
  it("ソロゲームの精算は1グループにまとまり、全ての移動に理由が付く", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);

    ctx.casino.settle("alice", "スロット", 1_000, 5_000, 50, { groupKey: "solo:1" });

    const rows = ctx.chipTx.listByGroup("solo:1");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.reason.trim().length > 0)).toBe(true);
    expect(rows.every((r) => r.game === "スロット")).toBe(true);
    expect(ctx.chipTx.getGroup("solo:1")?.kind).toBe("solo_game");
    ctx.db.close();
  });

  it("福分け・VIP・板・エスクローの操作が業務単位で記録される", () => {
    const ctx = setup();
    fundHouse(ctx, 500_000);
    fundUser(ctx, "alice", 50_000);
    fundUser(ctx, "bob", 50_000);
    const events = ctx.events;
    const daily = new Daily(ctx.db, ctx.ether, events, { base: () => 1_000, reliefThreshold: () => 0, reliefMax: () => 0 });
    const vip = new Vip(ctx.db, ctx.ether, events, { price: () => 3_000, days: () => 30, betCapMult: () => 2 });
    const markets = new Markets(ctx.db, ctx.ether, events);

    daily.claim("alice");
    vip.join("alice");
    const market = markets.create({
      guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 100,
    });
    markets.bet(market.id, "bob", 0, 1_000);
    ctx.escrow.hold("sess1", "alice", 2_000, "丁半");
    ctx.escrow.settle("sess1", [{ to: HOUSE_HOLDER, amount: 2_000 }], "system:test", "テスト精算");

    const kinds = ctx.db
      .prepare("SELECT DISTINCT kind FROM casino_tx_groups ORDER BY kind")
      .all() as Array<{ kind: string }>;
    expect(kinds.map((k) => k.kind)).toEqual(
      expect.arrayContaining(["daily", "deposit", "market_bet", "table_hold", "table_settle", "vip"]),
    );
    // 記録漏れがあれば残高の再現が崩れる
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    const orphan = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM casino_tx WHERE group_key NOT IN (SELECT group_key FROM casino_tx_groups)")
      .get() as { c: number };
    expect(orphan.c).toBe(0);
    ctx.db.close();
  });

  it("賭けの結果（配当・戦績）は監査基盤の導入で変わらない", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);

    // 勝ち: 賭け1,000 → 配当3,000（連鎖1回目は倍率1.0・福の重みは残高次第）
    const result = ctx.casino.settle("alice", "スロット", 1_000, 3_000, 0, { chain: false, fuku: false });

    expect(result.wagered).toBe(1_000);
    expect(result.payout).toBe(3_000);
    expect(result.net).toBe(2_000);
    expect(ctx.ether.balanceOf("alice")).toBe(10_000 + 2_000);
    ctx.db.close();
  });
});
