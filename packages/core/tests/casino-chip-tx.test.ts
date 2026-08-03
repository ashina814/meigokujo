import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Casino, JACKPOT_HOLDER, RELIEF_HOLDER } from "../src/casino/service.js";
import { ChipLedgerCore, ETHER_ESCROW, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow } from "../src/casino/escrow.js";
import { Daily } from "../src/casino/daily.js";
import { Vip } from "../src/casino/vip.js";
import { Markets } from "../src/casino/market.js";
import { Stocks } from "../src/casino/stocks.js";
import { deterministicRng } from "../src/casino/rng.js";
import { ChipTx, ChipTxError, LEGACY_OPENING_VERSION } from "../src/casino/chip-tx.js";
import { deptAccount } from "../src/departments/service.js";
import { testTransfer, opId } from "./helpers/chip-ctx.js";

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
  const ether = new ChipLedgerCore(db, ledger, events, { chipTx });
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
  ctx.ether.deposit(userId, land, `buy:${userId}`);
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

    ctx.ether.redeem("alice", 1_000, "sell:alice");

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
          `INSERT INTO casino_tx
             (group_key, seq, tx_kind, from_holder, to_holder, amount, reason, actor_id, opening_version, created_at)
           VALUES ('missing', 1, 'internal_transfer', 'a', 'b', 1, '理由', 'x', 'legacy_pre_reset', 1)`,
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

    ctx.casino.settle("alice", "スロット", 1_000, 2_500, 50, { operationId: opId() });
    ctx.ether.redeem("alice", 500, "sell:alice");
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

    ctx.ether.deposit("alice", 4_000, "buy:alice");

    expect(ctx.ether.pool() - poolBefore).toBe(4_000);
    expect(ctx.ether.outstanding() - outstandingBefore).toBe(4_000);
    ctx.db.close();
  });

  it("返還で準備Landと発行チップが同額減る", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    const poolBefore = ctx.ether.pool();
    const outstandingBefore = ctx.ether.outstanding();

    ctx.ether.redeem("alice", 2_000, "sell:alice");

    expect(outstandingBefore - ctx.ether.outstanding()).toBe(2_000);
    // 準備Landは払い戻し + 焼却ぶん減る（1:1化はPR8。ここでは"Landも同時に減る"ことを見る）
    expect(ctx.ether.pool()).toBeLessThan(poolBefore);
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    ctx.db.close();
  });

  it("Land側が通らなければチップは発行されない", () => {
    const ctx = setup();
    // 残高0のまま買おうとする → Land送金で失敗
    expect(() => ctx.ether.deposit("alice", 1_000, "buy:alice")).toThrow();

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
    expect(() => ctx.ether.redeem("alice", 99_999, "sell:too-much")).toThrow();

    expect(ctx.ledger.balanceOf("user:alice")).toBe(landBefore);
    expect(ctx.ether.pool()).toBe(poolBefore);
    ctx.db.close();
  });

  it("内部移動ではチップ総量が変わらない", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    fundUser(ctx, "alice", 3_000);
    const total = ctx.ether.outstanding();

    ctx.casino.settle("alice", "スロット", 1_000, 3_000, 50, { operationId: opId() });

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

    ctx.casino.settle("alice", "スロット", 1_000, 5_000, 50, { operationId: "op-1" });

    const rows = ctx.chipTx.listByGroup("solo:スロット:alice:op-1");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.reason.trim().length > 0)).toBe(true);
    expect(rows.every((r) => r.game === "スロット")).toBe(true);
    expect(ctx.chipTx.getGroup("solo:スロット:alice:op-1")?.kind).toBe("solo_game");
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

    daily.claim("alice", opId());
    vip.join("alice", opId());
    const market = markets.create({ operationId: opId(),
      guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 100,
    });
    markets.bet(market.id, "bob", 0, 1_000, opId());
    ctx.escrow.hold("sess1", "alice", 2_000, "丁半", opId());
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
    const result = ctx.casino.settle("alice", "スロット", 1_000, 3_000, 0, { chain: false, fuku: false, operationId: opId() });

    expect(result.wagered).toBe(1_000);
    expect(result.payout).toBe(3_000);
    expect(result.net).toBe(2_000);
    expect(ctx.ether.balanceOf("alice")).toBe(10_000 + 2_000);
    ctx.db.close();
  });

  it("同じ操作IDでの精算の再試行は、二度目も同じ結果で資金を動かさない", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);

    const first = ctx.casino.settle("alice", "スロット", 1_000, 3_000, 0, { operationId: "retry-1" });
    const balanceAfterFirst = ctx.ether.balanceOf("alice");
    const second = ctx.casino.settle("alice", "スロット", 1_000, 3_000, 0, { operationId: "retry-1" });

    expect(second).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(balanceAfterFirst);
    expect(ctx.chipTx.listByGroup("solo:スロット:alice:retry-1").length).toBe(
      ctx.chipTx.listByGroup("solo:スロット:alice:retry-1").length,
    );
    // 戦績も1回分（二重カウントしない）
    const stats = ctx.casino.stats("alice");
    expect(stats.wins + stats.losses).toBe(1);
    ctx.db.close();
  });
});

describe("runGroup の防御", () => {
  it("非同期の本体は受け付けない（コミット後に資金が動くのを防ぐ）", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);

    expect(() =>
      ctx.ether.runGroup({ groupKey: "g:async", kind: "solo_game", actorId: "alice" }, () =>
        Promise.resolve("あとで動かす"),
      ),
    ).toThrow(ChipTxError);
    expect(ctx.chipTx.getGroup("g:async")).toBeUndefined();
    ctx.db.close();
  });

  it("同じキーで種別や実行者が違えば、鍵の取り違えとして拒否する", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    ctx.ether.runGroup({ groupKey: "g:key", kind: "solo_game", actorId: "alice" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, JACKPOT_HOLDER, 100, { reason: "最初の操作" }),
    );

    expect(() =>
      ctx.ether.runGroup({ groupKey: "g:key", kind: "table_settle", actorId: "alice" }, () => undefined),
    ).toThrow(ChipTxError);
    expect(() =>
      ctx.ether.runGroup({ groupKey: "g:key", kind: "solo_game", actorId: "bob" }, () => undefined),
    ).toThrow(ChipTxError);
    // 同じ種別・同じ実行者なら保存済みの結果を返す
    expect(() =>
      ctx.ether.runGroup({ groupKey: "g:key", kind: "solo_game", actorId: "alice" }, () => undefined),
    ).not.toThrow();
    ctx.db.close();
  });

  it("空のグループキーは受け付けない", () => {
    const ctx = setup();
    expect(() => ctx.ether.runGroup({ groupKey: "  ", kind: "solo_game", actorId: "alice" }, () => undefined)).toThrow(
      ChipTxError,
    );
    ctx.db.close();
  });
});

describe("開始残高の版切替", () => {
  it("版ごとの窓で区切って、旧版・新版をそれぞれ検算できる", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);
    ctx.chipTx.captureLegacyOpening();

    // 旧版の窓での取引
    ctx.casino.settle("alice", "スロット", 1_000, 2_000, 0, { chain: false, fuku: false, operationId: "v0-1" });
    const balancesAtSwitch = new Map(
      (ctx.db.prepare("SELECT user_id, amount FROM ether_balances").all() as Array<{ user_id: string; amount: number }>)
        .map((r) => [r.user_id, r.amount] as const),
    );

    // 新版へ切り替え（正式開業初期化の R10 に相当）
    expect(ctx.chipTx.captureOpening("opening_v1", balancesAtSwitch)).toBe(true);
    expect(ctx.chipTx.currentVersion()).toBe("opening_v1");

    // 新版の窓での取引
    ctx.casino.settle("alice", "スロット", 2_000, 0, 0, { chain: false, fuku: false, operationId: "v1-1" });

    // 新版: 現在の実残高と一致する
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    // 旧版: 「切替時点の姿」を再現でき、新版の開始残高と一致する
    const legacyReplay = ctx.chipTx.replayBalances(LEGACY_OPENING_VERSION);
    for (const [holder, amount] of balancesAtSwitch) {
      expect(legacyReplay.get(holder) ?? 0).toBe(amount);
    }
    expect(ctx.chipTx.verifyBalances(LEGACY_OPENING_VERSION).ok).toBe(true);
    // 旧版の再現に新版の取引を混ぜない（混ざると切替時点と食い違う）
    expect(legacyReplay.get("alice")).not.toBe(ctx.ether.balanceOf("alice"));
    expect(ctx.chipTx.listOpeningVersions().map((v) => v.version)).toEqual([LEGACY_OPENING_VERSION, "opening_v1"]);
    ctx.db.close();
  });

  it("取引を挟まず版を切り替えても、新しい版が古い版を飲み込まない", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    ctx.chipTx.captureLegacyOpening();
    // 取引を1件も挟まずに切り替える（境界の取引IDが両版で同じになる）
    expect(ctx.chipTx.captureOpening("opening_v1", [[HOUSE_HOLDER, 10_000]])).toBe(true);

    testTransfer(ctx.ether, HOUSE_HOLDER, JACKPOT_HOLDER, 1_000, "切替後の移動");

    const versions = ctx.chipTx.listOpeningVersions();
    expect(versions.map((v) => v.version)).toEqual([LEGACY_OPENING_VERSION, "opening_v1"]);
    expect(versions[0]!.fromTxId).toBe(versions[1]!.fromTxId); // 取引IDでは前後が付かない
    expect(versions[0]!.seq).toBeLessThan(versions[1]!.seq); // 版の順序は別に持っている

    // 切替後の取引は新版の窓にだけ入る
    expect(ctx.chipTx.replayBalances(LEGACY_OPENING_VERSION).get(HOUSE_HOLDER)).toBe(10_000);
    expect(ctx.chipTx.replayBalances("opening_v1").get(JACKPOT_HOLDER)).toBe(1_000);
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    expect(ctx.chipTx.verifyBalances(LEGACY_OPENING_VERSION).ok).toBe(true);
    ctx.db.close();
  });

  // 取引を初期化した後の旧版は「開始残高そのもの」へ戻る。旧制度の取引再現は初期化前
  // （R9 前の preflight）限定で、初期化後の追跡先は R1-b の CSV とスナップショット。
  it("取引を初期化した後は、旧版の再現が開始残高へ戻り、新版だけが実残高と一致する", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);
    ctx.chipTx.captureLegacyOpening();
    ctx.casino.settle("alice", "スロット", 1_000, 2_000, 0, { chain: false, fuku: false, operationId: "v0-1" });

    const legacyReplay = ctx.chipTx.replayBalances(LEGACY_OPENING_VERSION);
    const legacyRows = ctx.db.prepare("SELECT COUNT(*) AS c FROM casino_tx").get() as { c: number };
    expect(legacyRows.c).toBeGreaterThan(0);

    // 正式開業初期化（R9）相当: 取引を初期化してから新版を置く。
    // 採番が巻き戻るので、新版の境界IDは旧版より小さくなる
    ctx.db.exec("DELETE FROM casino_tx; DELETE FROM casino_tx_groups; DELETE FROM sqlite_sequence WHERE name='casino_tx'");
    const openingBalances = new Map<string, number>([[HOUSE_HOLDER, 50_000], ["alice", 5_000]]);
    ctx.db.exec("DELETE FROM ether_balances");
    for (const [holder, amount] of openingBalances) {
      ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 0)").run(holder, amount);
    }
    expect(ctx.chipTx.captureOpening("opening_v1", openingBalances)).toBe(true);
    const versions = ctx.chipTx.listOpeningVersions();
    expect(versions[1]!.fromTxId).toBeLessThan(versions[0]!.fromTxId); // 境界IDは巻き戻っている

    ctx.casino.settle("alice", "スロット", 1_000, 0, 0, { chain: false, fuku: false, operationId: "v1-1" });

    // 新版は実残高と一致する
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    expect(ctx.ether.balanceOf("alice")).toBe(4_000);
    // 旧版の再現結果は、初期化で取引が消えた分だけ開始残高そのものへ戻る（新版の取引は混ざらない）
    const legacyAfterReset = ctx.chipTx.replayBalances(LEGACY_OPENING_VERSION);
    expect(legacyAfterReset.get("alice")).toBe(ctx.chipTx.openingBalances(LEGACY_OPENING_VERSION).get("alice"));
    expect(legacyAfterReset.get("alice")).not.toBe(legacyReplay.get("alice"));
    ctx.db.close();
  });

  it("同じ版を二度記録しない", () => {
    const ctx = setup();
    fundHouse(ctx, 10_000);
    ctx.chipTx.captureLegacyOpening();

    expect(ctx.chipTx.captureOpening(LEGACY_OPENING_VERSION, [["house", 999]])).toBe(false);
    expect(ctx.chipTx.openingBalances(LEGACY_OPENING_VERSION).get("house")).toBe(10_000);
    ctx.db.close();
  });
});

describe("1:1返還", () => {
  it("最小額でも同額の Land を返還し、対応するLand取引を記録する", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 10_000);
    const landBefore = ctx.ledger.balanceOf("user:alice");

    const quote = ctx.ether.redeem("alice", 5, "sell:tiny");

    expect(quote.output).toBe(5);
    expect(quote.burned).toBe(0);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(landBefore + 5);
    expect(ctx.ether.balanceOf("alice")).toBe(9_995); // チップだけ減る

    const row = ctx.chipTx.listByGroup("sell:tiny")[0]!;
    expect(row.tx_kind).toBe("redeem");
    expect(row.land_amount).toBe(5);
    expect(row.ledger_tx_id).not.toBeNull();
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    ctx.db.close();
  });

  it("Land が1 Ldでも動く返還は取引IDを必ず持つ", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 10_000);

    ctx.ether.redeem("alice", 1_000, "sell:normal");

    const row = ctx.chipTx.listByGroup("sell:normal")[0]!;
    expect(row.land_amount).toBeGreaterThan(0);
    expect(row.ledger_tx_id).not.toBeNull();
    ctx.db.close();
  });
});

describe("再試行時の資金安全性（可変状態はグループの中で見る）", () => {
  it("全額を返還した後でも、同じキーの再試行は同じ結果を返す", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 10_000);
    const held = ctx.ether.balanceOf("alice");

    const first = ctx.ether.redeem("alice", held, "sell:all");
    expect(ctx.ether.balanceOf("alice")).toBe(0);

    // 残高が 0 になっていても、同じ操作の再試行は残高不足で落ちない
    expect(ctx.ether.redeem("alice", held, "sell:all")).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(0);
    expect(ctx.chipTx.listByGroup("sell:all")).toHaveLength(1);
    ctx.db.close();
  });

  it("所持額ちょうどのVIP加入でも、再試行は同じ成功結果を返す", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 3_000);
    const vip = new Vip(ctx.db, ctx.ether, ctx.events, { price: () => 3_000, days: () => 30, betCapMult: () => 2 });

    const first = vip.join("alice", "op-vip");
    expect(first.ok).toBe(true);
    expect(ctx.ether.balanceOf("alice")).toBe(0);

    const again = vip.join("alice", "op-vip");
    expect(again).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(0); // 二重徴収しない
    expect(ctx.chipTx.listByGroup("vip:alice:op-vip")).toHaveLength(1);
    ctx.db.close();
  });

  it("所持額ちょうどの預託でも、再試行は true を返し預託は1回分のまま", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 2_000);

    expect(ctx.escrow.hold("sess1", "alice", 2_000, "丁半", "op-hold")).toBe(true);
    expect(ctx.ether.balanceOf("alice")).toBe(0);

    expect(ctx.escrow.hold("sess1", "alice", 2_000, "丁半", "op-hold")).toBe(true);
    expect(ctx.escrow.poolOf("sess1")).toBe(2_000); // 二重預託しない
    expect(ctx.ether.balanceOf(ctx.escrow.holderId("sess1"))).toBe(2_000);
    ctx.db.close();
  });

  it("預託の巻き戻しは局面ごとに効く（返金→再預託→再返金ができる）", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);

    ctx.escrow.hold("sess1", "alice", 1_000, "ルーレット", "bet-1");
    expect(ctx.escrow.refundOne("sess1", "alice", "rebet-1")).toBe(true);
    ctx.escrow.hold("sess1", "alice", 2_000, "ルーレット", "bet-2");
    // 局面ごとに別の鍵なので、2回目の返金も過去結果の再生にならない
    expect(ctx.escrow.refundOne("sess1", "alice", "rebet-2")).toBe(true);

    expect(ctx.ether.balanceOf("alice")).toBe(5_000);
    expect(ctx.escrow.poolOf("sess1")).toBe(0);
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    ctx.db.close();
  });

  it("株の売却も、保有が減った後の再試行で同じ結果を返す", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);
    const stocks = new Stocks(ctx.db, ctx.ether, ctx.events, { rng: deterministicRng(1) });
    const stock = stocks.list()[0]!;
    stocks.buy("alice", stock.id, 1, "op-buy");

    const first = stocks.sell("alice", stock.id, 1, "op-sell");
    const balanceAfter = ctx.ether.balanceOf("alice");

    expect(stocks.sell("alice", stock.id, 1, "op-sell")).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(balanceAfter);
    ctx.db.close();
  });
});

describe("1ゲーム＝1グループ", () => {
  it("チンチロの倍付け負けは、賭け金と追加徴収が同じグループに入る", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);
    const bet = 1_000;
    const extra = 1_000;

    ctx.ether.runGroup({ groupKey: "chinchiro:double_loss:alice:op-1", kind: "solo_game", actorId: "alice" }, () => {
      ctx.casino.settle("alice", "チンチロ", bet, 0, 0, { operationId: "op-1" });
      ctx.ether.transfer("alice", HOUSE_HOLDER, extra, { reason: "倍付け負けの追加徴収", game: "チンチロ" });
    });

    const rows = ctx.chipTx.listByGroup("chinchiro:double_loss:alice:op-1");
    expect(rows.map((r) => r.reason)).toEqual(["賭け金", "倍付け負けの追加徴収"]);
    // 内側の精算が独自のグループを作らない（合流している）
    expect(ctx.chipTx.getGroup("solo:チンチロ:alice:op-1")).toBeUndefined();
    expect(ctx.ether.balanceOf("alice")).toBe(10_000 - bet - extra);
    ctx.db.close();
  });

  it("1スピンの精算とJP当選が同じグループに入る", () => {
    const ctx = setup();
    fundHouse(ctx, 100_000);
    fundUser(ctx, "alice", 10_000);
    // JPプールを作る
    testTransfer(ctx.ether, HOUSE_HOLDER, JACKPOT_HOLDER, 5_000, "JPプールの用意");

    ctx.ether.runGroup({ groupKey: "slots:spin:alice:op-1", kind: "solo_game", actorId: "alice" }, () => {
      ctx.casino.settle("alice", "スロット", 1_000, 0, 50, { operationId: "op-1" });
      ctx.casino.seizeJackpot("alice", "slots", "op-1", 1);
    });

    const rows = ctx.chipTx.listByGroup("slots:spin:alice:op-1");
    expect(rows.some((r) => r.reason === "賭け金")).toBe(true);
    expect(rows.some((r) => r.reason === "ジャックポット当選")).toBe(true);
    expect(ctx.chipTx.getGroup("jackpot:slots:alice:op-1")).toBeUndefined();
    expect(ctx.chipTx.verifyBalances().ok).toBe(true);
    ctx.db.close();
  });
});
