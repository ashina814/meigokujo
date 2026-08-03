import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Casino, JACKPOT_HOLDER } from "../src/casino/service.js";
import { ETHER_ESCROW, EtherExchange, HOUSE_HOLDER, POOL_SWEEP_REASON } from "../src/casino/exchange.js";
import { Escrow, ESCROW_QUARANTINE } from "../src/casino/escrow.js";
import { Items } from "../src/casino/items.js";
import { Markets } from "../src/casino/market.js";
import { Stocks } from "../src/casino/stocks.js";
import { ChipTx, ChipTxError } from "../src/casino/chip-tx.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus, OPENING_RESET_SEAL } from "../src/casino/status.js";
import { deterministicRng } from "../src/casino/rng.js";
import { deptAccount } from "../src/departments/service.js";
import { opId } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * PR2（検算A〜Dと稼働状態）の受入テスト。
 *
 * 見るのは3つ:
 * - 4つの検算が「正常系で通る」だけでなく**壊したときに気づく**こと
 * - 止まった理由が残り、**自動で開くのは起動時の点検だけ**であること
 * - 停止が Discord の入口ではなく**資金処理層**で効いていること
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const items = new Items(db);
  const casino = new Casino(db, ether, events, { items });
  const escrow = new Escrow(db, ether, events);
  const integrity = new CasinoIntegrity(db, ledger, ether, escrow);
  const status = new CasinoStatus(db);
  return { db, ledger, events, chipTx, ether, casino, escrow, integrity, status, items };
}

type Ctx = ReturnType<typeof setup>;

/** 稼働状態を資金処理層へ繋ぐ（本番の services.ts と同じ配線） */
function wireStatus(ctx: Ctx): void {
  ctx.chipTx.setClosedReason(() => ctx.status.denyMessage());
}

function fundHouse(ctx: Ctx, amount: number): void {
  ctx.ledger.ensureAccount(deptAccount("賭博場"), "system");
  ctx.ledger.transfer({
    from: TREASURY, to: deptAccount("賭博場"), amount, type: "adjust", actor: "t", approvedBy: "t",
    idempotencyKey: `seed:dept:${amount}`,
  });
  ctx.ether.fundFromAccount(deptAccount("賭博場"), amount, HOUSE_HOLDER, `seed:house:${amount}`);
}

function fundUser(ctx: Ctx, userId: string, land: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY, to: `user:${userId}`, amount: land, type: "initial", actor: "t",
    idempotencyKey: `seed:user:${userId}`,
  });
  ctx.ether.buy(userId, land, `buy:${userId}`);
}

/** 開始残高と Land 基準を取ってから一通り遊んだ状態 */
function busyCasino(): Ctx {
  const ctx = setup();
  ctx.chipTx.captureLegacyOpening({
    poolLand: ctx.ledger.balanceOf(ETHER_ESCROW),
    fromLedgerTxId: ctx.ledger.lastTransactionId(),
  });
  fundHouse(ctx, 100_000);
  fundUser(ctx, "alice", 20_000);
  fundUser(ctx, "bob", 20_000);
  ctx.casino.settle("alice", "スロット", 1_000, 2_000, 10, { operationId: opId() });
  ctx.escrow.holdAll("sess1", ["alice", "bob"], 3_000, "丁半", opId());
  return ctx;
}

describe("全点検（正常系）", () => {
  it("一通り遊んだ後でも Land 台帳と検算A〜D が通る", () => {
    const ctx = busyCasino();
    const report = ctx.integrity.runFull();
    expect(report.ledger.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(["A", "B", "C", "D"]);
    expect(report.failed).toEqual([]);
    expect(report.ok).toBe(true);
    ctx.db.close();
  });

  it("全額を返還して端数プールを回収しても検算Bは通る", () => {
    const ctx = setup();
    ctx.chipTx.captureLegacyOpening({
      poolLand: ctx.ledger.balanceOf(ETHER_ESCROW),
      fromLedgerTxId: ctx.ledger.lastTransactionId(),
    });
    fundUser(ctx, "alice", 5_000);

    ctx.ether.sell("alice", ctx.ether.balanceOf("alice"), "sell:all");

    expect(ctx.ether.outstanding()).toBe(0);
    expect(ctx.ether.pool()).toBe(0); // 端数は国庫へ回収済み
    expect(ctx.integrity.checkB().ok).toBe(true);
    expect(ctx.integrity.runFull().ok).toBe(true);
    ctx.db.close();
  });

  it("検算は何も書き換えない（読み取り専用）", () => {
    const ctx = setup();
    ctx.chipTx.captureLegacyOpening(); // 基準なし
    fundUser(ctx, "alice", 5_000);
    const before = ctx.db.prepare("SELECT COUNT(*) AS c FROM casino_tx").get() as { c: number };

    ctx.integrity.runFull();
    ctx.integrity.runFull();

    // 基準を勝手に埋めない・取引も増やさない
    expect(ctx.chipTx.openingLandBaseline()).toBeNull();
    expect((ctx.db.prepare("SELECT COUNT(*) AS c FROM casino_tx").get() as { c: number }).c).toBe(before.c);
    ctx.db.close();
  });
});

describe("検算A（記録と残高）", () => {
  it("記録を通さず残高を書き換えると気づく", () => {
    const ctx = busyCasino();
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run("alice");

    const report = ctx.integrity.runFull();
    expect(report.ok).toBe(false);
    expect(report.failed).toContain("A");
    expect(report.checks.find((c) => c.id === "A")!.mismatches[0]!.subject).toBe("alice");
    ctx.db.close();
  });
});

describe("検算B（経路監査）", () => {
  it("基準が未設定なら自動承認せずNGにする", () => {
    const ctx = setup();
    ctx.chipTx.captureLegacyOpening(); // pool_land / from_ledger_tx_id なし
    fundUser(ctx, "alice", 5_000);

    const b = ctx.integrity.checkB();
    expect(b.ok).toBe(false);
    expect(b.mismatches[0]!.note).toBe("baseline_missing");
    expect(ctx.chipTx.openingLandBaseline()).toBeNull(); // 検算は埋めない
    ctx.db.close();
  });

  it("500抜いて500戻しても、差引が合うだけではNGのまま", () => {
    const ctx = busyCasino();
    expect(ctx.integrity.checkB().ok).toBe(true);

    ctx.ledger.transfer({
      from: ETHER_ESCROW, to: TREASURY, amount: 500, type: "adjust", actor: "t", approvedBy: "t",
      idempotencyKey: "sneaky-out",
    });
    ctx.ledger.transfer({
      from: TREASURY, to: ETHER_ESCROW, amount: 500, type: "adjust", actor: "t", approvedBy: "t",
      idempotencyKey: "sneaky-back",
    });

    expect(ctx.integrity.checkB().ok).toBe(false);
    const notes = ctx.integrity.checkB().mismatches.map((m) => m.note);
    expect(notes).toEqual(["unknown_type:adjust", "unknown_type:adjust"]);
    // プール残高そのものは合っている（差引一致だけでは見抜けない不正）
    expect(notes).not.toContain("balance_mismatch");
    ctx.db.close();
  });

  it("正しい理由文を真似た手動取引でもNGになる", () => {
    const ctx = busyCasino();
    // 端数回収と同じ type・宛先・理由文で手動送金する
    ctx.ledger.transfer({
      from: ETHER_ESCROW, to: TREASURY, amount: 300, type: "ether_burn", actor: "system:ether", approvedBy: "system:ether",
      reason: POOL_SWEEP_REASON, idempotencyKey: "forged:sweep",
    });

    const b = ctx.integrity.checkB();
    expect(b.ok).toBe(false);
    // 冪等キーが chip グループを指していないので落ちる（理由文だけでは通らない）
    expect(b.mismatches.some((m) => m.note === "missing_key_suffix" || m.note === "no_chip_group")).toBe(true);
    ctx.db.close();
  });

  it("実在しないグループ名を付けた偽装取引もNG", () => {
    const ctx = busyCasino();
    ctx.ledger.transfer({
      from: ETHER_ESCROW, to: "user:alice", amount: 200, type: "ether_sell", actor: "user:alice", approvedBy: "system:ether",
      reason: "エテル換金", idempotencyKey: "sell:alice:forged",
    });

    const b = ctx.integrity.checkB();
    expect(b.ok).toBe(false);
    expect(b.mismatches.some((m) => m.note === "no_chip_group")).toBe(true);
    ctx.db.close();
  });

  it("版を切り替えたら、旧版の端数回収を新版で二重計上しない", () => {
    const ctx = setup();
    ctx.chipTx.captureLegacyOpening({
      poolLand: ctx.ledger.balanceOf(ETHER_ESCROW),
      fromLedgerTxId: ctx.ledger.lastTransactionId(),
    });
    fundUser(ctx, "alice", 5_000);
    // 全額返還 → 端数回収がここで起きる（旧版の窓の中）
    ctx.ether.sell("alice", ctx.ether.balanceOf("alice"), "sell:all");
    expect(ctx.ether.pool()).toBe(0);
    const sweeps = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM transactions WHERE reason = ?")
      .get(POOL_SWEEP_REASON) as { c: number };
    expect(sweeps.c).toBeGreaterThan(0);

    // 新版へ切替（新しい Land 境界を置く）
    ctx.chipTx.captureOpening("opening_v1", [], {
      poolLand: ctx.ether.pool(),
      fromLedgerTxId: ctx.ledger.lastTransactionId(),
    });
    expect(ctx.chipTx.currentVersion()).toBe("opening_v1");

    // 新版では旧版の回収を数えないので、そのままでも通る
    expect(ctx.integrity.checkB().ok).toBe(true);
    // 旧版側も自分の窓だけで完結している
    ctx.db.close();
  });
});

describe("検算C（預託）", () => {
  it("預り所の残高が帳簿とずれると気づく（卓・板の両方）", () => {
    const ctx = busyCasino();
    const markets = new Markets(ctx.db, ctx.ether, ctx.events);
    const market = markets.create({
      operationId: opId(), guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 0,
    });
    markets.bet(market.id, "bob", 0, 1_000, opId());
    expect(ctx.integrity.checkC().ok).toBe(true);

    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 100 WHERE user_id = ?").run("escrow:session:sess1");
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 200 WHERE user_id = ?").run(`escrow:market:${market.id}`);

    const c = ctx.integrity.checkC();
    expect(c.ok).toBe(false);
    expect(c.mismatches.map((m) => m.subject).sort()).toEqual([`market:${market.id}`, "session:sess1"]);
    ctx.db.close();
  });
});

describe("検算D（帰属）", () => {
  it("台帳に口座の無い保有者は利用者として通さない", () => {
    const ctx = busyCasino();
    expect(ctx.integrity.checkD().ok).toBe(true);

    // 打ち間違い（houes）と、素性の分からない保有者
    ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('houes', 900, 1)").run();
    ctx.db.prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('mystery-holder', 50, 1)").run();

    const d = ctx.integrity.checkD();
    expect(d.ok).toBe(false);
    expect(d.mismatches.map((m) => m.subject)).toEqual(expect.arrayContaining(["houes", "mystery-holder"]));
    expect(d.mismatches.every((m) => m.note !== undefined)).toBe(true);
    ctx.db.close();
  });

  it("帳簿の無い預り所に残ったチップに気づく", () => {
    const ctx = busyCasino();
    ctx.db
      .prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('escrow:session:ghost', 700, 1)")
      .run();

    const d = ctx.integrity.checkD();
    expect(d.ok).toBe(false);
    expect(d.mismatches.some((m) => m.subject === "escrow:session:ghost")).toBe(true);
    ctx.db.close();
  });

  it("隔離口座と胴元・JP・救済は帰属済みとして扱う", () => {
    const ctx = busyCasino();
    ctx.ether.ensureHolder(ESCROW_QUARANTINE);
    ctx.ether.runGroup({ groupKey: "q1", kind: "table_refund", actorId: "system:test" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, ESCROW_QUARANTINE, 500, { reason: "隔離テスト" }),
    );
    expect(ctx.ether.balanceOf(ESCROW_QUARANTINE)).toBe(500);
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBeGreaterThan(0);
    expect(ctx.integrity.checkD().ok).toBe(true);
    ctx.db.close();
  });
});

describe("稼働状態", () => {
  it("初期状態は営業中で、止めるには理由と実行者が要る", () => {
    const ctx = setup();
    expect(ctx.status.isOpen()).toBe(true);
    expect(ctx.status.denyMessage()).toBeNull();

    expect(() => ctx.status.haltManually("  ", "boss")).toThrow();
    ctx.status.haltManually("様子見", "boss");

    expect(ctx.status.current()).toMatchObject({ status: "manual_halt", reason: "様子見", changedBy: "boss" });
    expect(ctx.status.isOpen()).toBe(false);
    expect(ctx.status.denyMessage()).toContain("様子見");
    ctx.db.close();
  });

  it("状態変更は履歴と監査ログに残る", () => {
    const ctx = setup();
    ctx.status.beginMaintenance("改装", "boss");
    ctx.status.endMaintenance("改装おわり", "boss");

    expect(ctx.status.history().map((h) => h.status)).toEqual(["open", "maintenance"]);
    const events = (
      ctx.db.prepare("SELECT payload FROM outbox WHERE kind = 'audit_log' ORDER BY id").all() as Array<{ payload: string }>
    ).map((a) => JSON.parse(a.payload) as { event: string; to?: string });
    expect(events.filter((e) => e.event === "casino_status_changed").map((e) => e.to)).toEqual(["maintenance", "open"]);
    ctx.db.close();
  });

  it("自動で解除されるのは起動時の点検だけ", () => {
    const ctx = setup();
    ctx.status.haltManually("人が止めた", "boss");
    expect(ctx.status.beginStartupCheck()).toBe(false);
    expect(ctx.status.finishStartupCheck()).toBe(false);
    expect(ctx.status.current().status).toBe("manual_halt");
    ctx.db.close();

    const ctx2 = setup();
    ctx2.status.beginMaintenance("改装", "boss");
    expect(ctx2.status.beginStartupCheck()).toBe(false);
    expect(ctx2.status.current().status).toBe("maintenance");
    ctx2.db.close();

    const ctx3 = setup();
    expect(ctx3.status.beginStartupCheck()).toBe(true);
    expect(ctx3.status.current().status).toBe("startup_check");
    expect(ctx3.status.finishStartupCheck()).toBe(true);
    expect(ctx3.status.current().status).toBe("open");
    ctx3.db.close();
  });

  it("開ける経路は状態ごとに1本ずつで、他の導線からは開けられない", () => {
    const ctx = setup();
    ctx.status.haltForIntegrity("検算A(記録と残高): ずれている");

    // メンテ終了・開業初期化完了・手動再開のどれでも開かない
    expect(ctx.status.endMaintenance("改装おわり", "boss").ok).toBe(false);
    expect(ctx.status.finishOpeningReset("初期化おわり", "boss", OPENING_RESET_SEAL).ok).toBe(false);
    expect(ctx.status.reopenFromManualHalt("開ける", "boss").ok).toBe(false);
    expect(ctx.status.isOpen()).toBe(false);

    // 検算が通っていない再開も断る
    expect(ctx.status.reopenAfterIntegrity("開ける", "boss", false).ok).toBe(false);
    expect(ctx.status.isOpen()).toBe(false);

    // 全点検を通した再開だけが通る
    expect(ctx.status.reopenAfterIntegrity("直した", "boss", true).ok).toBe(true);
    expect(ctx.status.isOpen()).toBe(true);
    ctx.db.close();
  });

  it("改装中は改装終了からしか開かない", () => {
    const ctx = setup();
    ctx.status.beginMaintenance("改装", "boss");
    expect(ctx.status.reopenFromManualHalt("開ける", "boss").ok).toBe(false);
    expect(ctx.status.reopenAfterIntegrity("開ける", "boss", true).ok).toBe(false);
    expect(ctx.status.endMaintenance("改装おわり", "boss").ok).toBe(true);
    expect(ctx.status.isOpen()).toBe(true);
    ctx.db.close();
  });

  it("開業準備中は通常の再開導線のどれでも開かない", () => {
    const ctx = setup();
    ctx.status.beginOpeningReset("正式開業初期化", "boss");

    // 運営卓が持っている「開ける」経路は全部断られる
    expect(ctx.status.reopenFromManualHalt("開ける", "boss").ok).toBe(false);
    expect(ctx.status.reopenAfterIntegrity("開ける", "boss", true).ok).toBe(false);
    expect(ctx.status.endMaintenance("改装おわり", "boss").ok).toBe(false);
    expect(ctx.status.finishStartupCheck("boss")).toBe(false);
    expect(ctx.status.current().status).toBe("opening_reset");
    expect(ctx.status.isOpen()).toBe(false);
    ctx.db.close();
  });

  it("全点検A〜Dが正常でも、開業準備中は通常再開では解除できない", () => {
    const ctx = busyCasino();
    // 帳簿はどこも壊れていない（＝運営卓の再開ボタンなら通ってしまう条件）
    expect(ctx.integrity.runFull().ok).toBe(true);

    ctx.status.beginOpeningReset("正式開業初期化", "boss");
    expect(ctx.status.reopenAfterIntegrity("全点検が通ったので開ける", "boss", true).ok).toBe(false);
    expect(ctx.status.reopenFromManualHalt("開ける", "boss").ok).toBe(false);
    expect(ctx.status.endMaintenance("開ける", "boss").ok).toBe(false);
    expect(ctx.status.isOpen()).toBe(false);
    ctx.db.close();
  });

  it("開業準備中を open にできるのは正式開業初期化の完了経路だけ", () => {
    const ctx = setup();
    ctx.status.beginOpeningReset("正式開業初期化", "boss");

    // 印を持たない呼び出し（＝正式開業初期化の外）は断る
    const forged = ctx.status.finishOpeningReset("初期化おわり", "boss", Symbol("にせの印") as never);
    expect(forged.ok).toBe(false);
    expect(ctx.status.isOpen()).toBe(false);

    // PR12 の完了処理（core 内部の印を持つ経路）だけが open にできる
    expect(ctx.status.finishOpeningReset("正式開業初期化 完了", "boss", OPENING_RESET_SEAL).ok).toBe(true);
    expect(ctx.status.current().status).toBe("open");
    expect(ctx.status.current().reason).toBe("正式開業初期化 完了");
    ctx.db.close();
  });

  it("未知の状態値は fail-closed（開いていると誤認しない）", () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE casino_status SET status = 'なにこれ' WHERE id = 1").run();
    expect(ctx.status.isOpen()).toBe(false);
    expect(ctx.status.denyMessage()).not.toBeNull();
    ctx.db.close();
  });

  it("人が止めている状態は検算NGでも上書きしない", () => {
    for (const halt of ["haltManually", "beginMaintenance", "beginOpeningReset"] as const) {
      const ctx = setup();
      ctx.status[halt]("人の判断で止めた", "boss");
      expect(ctx.status.haltForIntegrity("検算A: ずれている")).toBe(false);
      expect(ctx.status.current().reason).toBe("人の判断で止めた");
      ctx.db.close();
    }
  });
});

describe("停止は資金処理層で効く", () => {
  it("手動停止のあとはサービスAPIから直接送金できない", () => {
    const ctx = busyCasino();
    wireStatus(ctx);
    const before = ctx.ether.balanceOf(HOUSE_HOLDER);
    ctx.status.haltManually("様子見", "boss");

    expect(() =>
      ctx.ether.runGroup({ groupKey: "sneaky:move", kind: "solo_game", actorId: "alice" }, () =>
        ctx.ether.transfer(HOUSE_HOLDER, "alice", 1_000, { reason: "こっそり" }),
      ),
    ).toThrow(ChipTxError);
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(before);
    expect(ctx.chipTx.getGroup("sneaky:move")).toBeUndefined();
    ctx.db.close();
  });

  it("停止前に始まったゲームは、停止後に精算できない", () => {
    const ctx = busyCasino();
    wireStatus(ctx);
    const before = ctx.ether.balanceOf("alice");
    const gamesBefore = ctx.casino.stats("alice").games;
    // 演出中に賭場が止まった、という状況
    ctx.status.haltManually("不整合の調査", "boss");

    expect(() => ctx.casino.settleSolo("alice", "スロット", 1_000, 3_000, { operationId: "mid-game" })).toThrow(
      ChipTxError,
    );
    expect(ctx.ether.balanceOf("alice")).toBe(before);
    expect(ctx.casino.stats("alice").games).toBe(gamesBefore); // 戦績も増えない
    ctx.db.close();
  });

  it("停止中は株の強制売却も板の自動精算も動かない", () => {
    const ctx = busyCasino();
    const markets = new Markets(ctx.db, ctx.ether, ctx.events);
    const stocks = new Stocks(ctx.db, ctx.ether, ctx.events, { rng: deterministicRng(1) });
    const stock = stocks.list()[0]!;
    stocks.buy("alice", stock.id, 1, "op-buy");
    ctx.db
      .prepare("UPDATE casino_holdings SET bought_at = 1 WHERE user_id = ? AND stock_id = ?")
      .run("alice", stock.id);
    const market = markets.create({
      operationId: opId(), guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 0,
    });
    markets.bet(market.id, "bob", 0, 1_000, opId());
    markets.close(market.id, "admin");
    markets.report(market.id, "alice", 0);

    wireStatus(ctx);
    ctx.status.haltManually("不整合の調査", "boss");
    const aliceBefore = ctx.ether.balanceOf("alice");
    const bobBefore = ctx.ether.balanceOf("bob");

    expect(() => stocks.forceSellExpired()).toThrow(ChipTxError);
    expect(() => markets.finalizeIfNoDispute(market.id)).toThrow(ChipTxError);

    expect(ctx.ether.balanceOf("alice")).toBe(aliceBefore);
    expect(ctx.ether.balanceOf("bob")).toBe(bobBefore);
    expect(stocks.holdings("alice")).toHaveLength(1);
    expect(markets.get(market.id)!.status).toBe("reported");
    ctx.db.close();
  });

  it("停止中は運営卓の資金投入・売上精算も通らない", () => {
    const ctx = busyCasino();
    wireStatus(ctx);
    ctx.status.haltManually("改装前の締め", "boss");
    const houseBefore = ctx.ether.balanceOf(HOUSE_HOLDER);
    const poolBefore = ctx.ether.pool();

    expect(() => ctx.ether.fundFromAccount(deptAccount("賭博場"), 1_000, HOUSE_HOLDER, "fund:halted")).toThrow(
      ChipTxError,
    );
    expect(() =>
      ctx.ether.redeemFairToAccount(HOUSE_HOLDER, 1_000, deptAccount("賭博場"), "settle:halted"),
    ).toThrow(ChipTxError);

    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(houseBefore);
    expect(ctx.ether.pool()).toBe(poolBefore);
    ctx.db.close();
  });

  it("復旧・初期化だけは明示的な許可経路（runMaintenance）で通る", () => {
    const ctx = busyCasino();
    wireStatus(ctx);
    ctx.status.haltManually("起動時の掃除", "system");

    // actor を system と名乗るだけでは通らない
    expect(() =>
      ctx.ether.runGroup({ groupKey: "fake:system", kind: "table_refund", actorId: "system:startup" }, () =>
        ctx.ether.transfer(HOUSE_HOLDER, "alice", 100, { reason: "名乗るだけ" }),
      ),
    ).toThrow(ChipTxError);

    // runMaintenance を通った区間だけが動かせる
    const refunded = ctx.chipTx.runMaintenance("起動時の未精算返金", () => ctx.escrow.refund("sess1"));
    expect(refunded).toBe(2);
    expect(ctx.escrow.poolOf("sess1")).toBe(0);
    // 区間を抜けたらまた止まる
    expect(ctx.chipTx.isMaintenance()).toBe(false);
    expect(() =>
      ctx.ether.runGroup({ groupKey: "after:maintenance", kind: "solo_game", actorId: "alice" }, () =>
        ctx.ether.transfer(HOUSE_HOLDER, "alice", 100, { reason: "区間の外" }),
      ),
    ).toThrow(ChipTxError);
    ctx.db.close();
  });

  it("停止中でも、処理済みの再試行は保存済みの結果を返す（資金は動かない）", () => {
    const ctx = busyCasino();
    wireStatus(ctx);
    const first = ctx.casino.settleSolo("alice", "スロット", 1_000, 2_000, { operationId: "done-1" });
    const after = ctx.ether.balanceOf("alice");
    ctx.status.haltManually("停止", "boss");

    expect(ctx.casino.settleSolo("alice", "スロット", 1_000, 2_000, { operationId: "done-1" })).toEqual(first);
    expect(ctx.ether.balanceOf("alice")).toBe(after);
    ctx.db.close();
  });
});

describe("検算NGによる自動停止", () => {
  it("1 Ld ずらすと停止し、直して全点検を通すまで開かない", () => {
    const ctx = busyCasino();
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run("alice");

    const report = ctx.integrity.runFull();
    expect(report.ok).toBe(false);
    expect(ctx.status.haltForIntegrity(CasinoIntegrity.describeFailure(report))).toBe(true);

    expect(ctx.status.current().status).toBe("integrity_halt");
    expect(ctx.status.current().reason).toContain("検算A");
    expect(ctx.status.beginStartupCheck()).toBe(false);
    expect(ctx.status.finishStartupCheck()).toBe(false);

    // 直せば全点検が通り、その経路でだけ開けられる
    ctx.db.prepare("UPDATE ether_balances SET amount = amount + 1 WHERE user_id = ?").run("alice");
    const fixed = ctx.integrity.runFull();
    expect(fixed.ok).toBe(true);
    expect(ctx.status.reopenAfterIntegrity("直した", "boss", fixed.ok).ok).toBe(true);
    expect(ctx.status.isOpen()).toBe(true);
    ctx.db.close();
  });

  it("停止理由にはNGだった点検がすべて並ぶ", () => {
    const ctx = busyCasino();
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run("alice");
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 100 WHERE user_id = ?").run("escrow:session:sess1");

    const reason = CasinoIntegrity.describeFailure(ctx.integrity.runFull());
    expect(reason).toContain("検算A");
    expect(reason).toContain("検算C");
    ctx.db.close();
  });
});
