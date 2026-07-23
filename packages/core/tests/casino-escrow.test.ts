import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { EtherExchange, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Casino } from "../src/casino/service.js";
import { Escrow, escrowHolderFor, ESCROW_QUARANTINE } from "../src/casino/escrow.js";
import { Markets, marketEscrowHolder } from "../src/casino/market.js";
import { deptAccount, Departments } from "../src/departments/service.js";

registerDefaultTxTypes();

/**
 * エスクロー資金分離のテスト。
 *
 * ゴール:
 * 1. 対人・板の預り金が胴元(house)残高と混ざらないこと
 * 2. 中止・再起動時に全額返金できること
 * 3. 精算後にエスクロー保有者に残額が残らないこと
 * 4. エスクローの資金がソロゲームの配当余力に含まれないこと
 * 5. 総量保存（Land も エテル も動かさない構造）
 */

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const ether = new EtherExchange(db, ledger, new EventLog(db));
  const casino = new Casino(db, ether, new EventLog(db));
  const escrow = new Escrow(db, ether, new EventLog(db));
  const markets = new Markets(db, ether, new EventLog(db));
  const departments = new Departments(db, ledger);
  // 胴元シード: 賭博場部署 → house へ 100,000 Land = 1,000,000 エテル
  departments.upsert("賭博場", "賭博場", null);
  ledger.transfer({ from: TREASURY, to: deptAccount("賭博場"), amount: 100_000, type: "adjust", actor: "t", approvedBy: "t", idempotencyKey: "seed:dept" });
  ether.fundFromAccount(deptAccount("賭博場"), 100_000, HOUSE_HOLDER, "seed:house");
  // プレイヤー a,b にエテルを配る（それぞれ 10,000 Land → 100,000 エテル）
  for (const uid of ["a", "b"]) {
    ledger.ensureAccount(`user:${uid}`, "user");
    ledger.transfer({ from: TREASURY, to: `user:${uid}`, amount: 10_000, type: "initial", actor: "t", idempotencyKey: `seed:${uid}` });
    ether.buy(uid, 10_000, `seed:buy:${uid}`);
  }
  return { db, ledger, ether, casino, escrow, markets };
}

describe("エスクロー資金分離", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("Escrow.hold は house ではなくセッション専用保有者へ移す", () => {
    const house0 = ctx.ether.balanceOf(HOUSE_HOLDER);
    ctx.escrow.hold("sess1", "a", 5_000, "duel");
    ctx.escrow.hold("sess1", "b", 5_000, "duel");
    // house 残高は変わらない
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(house0);
    // セッション保有者にちょうど 10,000 溜まっている
    expect(ctx.ether.balanceOf(escrowHolderFor("sess1"))).toBe(10_000);
    // 帳簿と保有者残高が一致
    expect(ctx.escrow.verify().ok).toBe(true);
    expect(ctx.escrow.poolOf("sess1")).toBe(10_000);
  });

  it("refund でセッションから全額返金・保有者残高が 0 になる", () => {
    ctx.escrow.hold("sess1", "a", 3_000, "duel");
    ctx.escrow.hold("sess1", "b", 3_000, "duel");
    const before = { a: ctx.ether.balanceOf("a"), b: ctx.ether.balanceOf("b") };
    const n = ctx.escrow.refund("sess1");
    expect(n).toBe(2);
    expect(ctx.ether.balanceOf("a")).toBe(before.a + 3_000);
    expect(ctx.ether.balanceOf("b")).toBe(before.b + 3_000);
    expect(ctx.ether.balanceOf(escrowHolderFor("sess1"))).toBe(0);
    expect(ctx.escrow.list("sess1")).toEqual([]);
  });

  it("sweepAll: 台帳に記録がある行は本人へ返金する", () => {
    ctx.escrow.hold("sess1", "a", 3_000, "duel");
    ctx.escrow.hold("sess1", "b", 2_000, "duel");
    const beforeA = ctx.ether.balanceOf("a");
    const beforeB = ctx.ether.balanceOf("b");
    const r = ctx.escrow.sweepAll("test:startup");
    expect(r.users).toBe(2);
    expect(r.total).toBe(5_000);
    expect(r.orphans).toBe(0);
    expect(ctx.ether.balanceOf("a")).toBe(beforeA + 3_000);
    expect(ctx.ether.balanceOf("b")).toBe(beforeB + 2_000);
  });

  it("sweepAll: 孤児残高は house ではなく sys:escrow:quarantine へ隔離する", () => {
    ctx.escrow.hold("sess1", "a", 4_000, "duel");
    // 孤児残高: 帳簿だけ消えて保有者に残ってしまったケースを人為的に作る
    ctx.escrow.clear("sess1");
    expect(ctx.ether.balanceOf(escrowHolderFor("sess1"))).toBe(4_000);
    const house0 = ctx.ether.balanceOf(HOUSE_HOLDER);
    const r = ctx.escrow.sweepAll("test:startup");
    // 孤児は house に流れず、隔離口座に集約される
    expect(r.orphans).toBe(1);
    expect(r.orphanTotal).toBe(4_000);
    expect(ctx.ether.balanceOf(escrowHolderFor("sess1"))).toBe(0);
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(house0);
    expect(ctx.ether.balanceOf(ESCROW_QUARANTINE)).toBe(4_000);
    expect(ctx.escrow.quarantineBalance()).toBe(4_000);
  });

  it("隔離残高は Casino.canAccept が見る house 残高に含まれない", () => {
    ctx.escrow.hold("sess1", "a", 4_000, "duel");
    ctx.escrow.clear("sess1"); // 孤児化
    const house0 = ctx.casino.houseBalance();
    ctx.escrow.sweepAll("test:startup");
    // 隔離に 4000 積まれても canAccept の判定基準は house 残高のまま
    expect(ctx.casino.houseBalance()).toBe(house0);
    expect(ctx.casino.canAccept(house0 + 1)).toBe(false);
  });

  it("settle: 原子的に全分配が成功する（合計 == プールで正常終了）", () => {
    ctx.escrow.hold("sess1", "a", 6_000, "duel");
    ctx.escrow.hold("sess1", "b", 4_000, "duel");
    const beforeA = ctx.ether.balanceOf("a");
    const beforeB = ctx.ether.balanceOf("b");
    const jp0 = ctx.ether.balanceOf("jackpot");
    ctx.escrow.settle(
      "sess1",
      [
        { to: "jackpot", amount: 300, reason: "場代" },
        { to: "a", amount: 5_700, reason: "勝者" },
        { to: "b", amount: 4_000, reason: "引き分け返金" },
      ],
      "test",
      "atomic settle ok",
    );
    expect(ctx.ether.balanceOf("a")).toBe(beforeA + 5_700);
    expect(ctx.ether.balanceOf("b")).toBe(beforeB + 4_000);
    expect(ctx.ether.balanceOf("jackpot")).toBe(jp0 + 300);
    expect(ctx.escrow.list("sess1")).toEqual([]);
    // 保有者残高は 0
    expect(ctx.ether.balanceOf(escrowHolderFor("sess1"))).toBe(0);
  });

  it("settle: 合計 != プールなら例外・状態変わらず（プリチェック）", () => {
    ctx.escrow.hold("sess1", "a", 5_000, "duel");
    const beforeA = ctx.ether.balanceOf("a");
    const pool0 = ctx.ether.balanceOf(escrowHolderFor("sess1"));
    expect(() =>
      ctx.escrow.settle("sess1", [{ to: "a", amount: 4_999, reason: "誤配分" }], "test", "wrong total"),
    ).toThrowError(/distribution total/);
    // 例外前後で状態は変わらない
    expect(ctx.ether.balanceOf("a")).toBe(beforeA);
    expect(ctx.ether.balanceOf(escrowHolderFor("sess1"))).toBe(pool0);
    expect(ctx.escrow.list("sess1")).toHaveLength(1);
  });

  it("settle: 中間送金で例外を注入するとトランザクション全体がロールバックする", () => {
    ctx.escrow.hold("sess1", "a", 6_000, "duel");
    ctx.escrow.hold("sess1", "b", 4_000, "duel");
    const beforeA = ctx.ether.balanceOf("a");
    const beforeB = ctx.ether.balanceOf("b");
    const jp0 = ctx.ether.balanceOf("jackpot");
    const pool0 = ctx.ether.balanceOf(escrowHolderFor("sess1"));

    // 2 番目の送金 (index=1) で例外を注入
    expect(() =>
      ctx.escrow.settle(
        "sess1",
        [
          { to: "jackpot", amount: 300 },
          { to: "a", amount: 5_700 },
          { to: "b", amount: 4_000 },
        ],
        "test",
        "inject failure",
        (index) => {
          if (index === 1) throw new Error("simulated network failure mid-settle");
        },
      ),
    ).toThrow(/simulated network failure/);

    // ロールバック: 何も動いていないはず
    expect(ctx.ether.balanceOf("a")).toBe(beforeA);
    expect(ctx.ether.balanceOf("b")).toBe(beforeB);
    expect(ctx.ether.balanceOf("jackpot")).toBe(jp0);
    expect(ctx.ether.balanceOf(escrowHolderFor("sess1"))).toBe(pool0);
    // 帳簿もそのまま
    expect(ctx.escrow.list("sess1")).toHaveLength(2);
    // 整合性: Ledger identity は壊れていない
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });

  it("releaseFromQuarantine: 隔離残高を手動で返金または帳消しできる", () => {
    ctx.escrow.hold("sess1", "a", 4_000, "duel");
    ctx.escrow.clear("sess1");
    ctx.escrow.sweepAll("test:startup");
    const beforeA = ctx.ether.balanceOf("a");
    // 調査でユーザ a のものだと判明 → a に返す
    ctx.escrow.releaseFromQuarantine("a", 4_000, "admin", "sess1 の預入元と判明");
    expect(ctx.ether.balanceOf("a")).toBe(beforeA + 4_000);
    expect(ctx.escrow.quarantineBalance()).toBe(0);
  });

  it("預り金は Casino.canAccept(=house残高) に含まれない → ソロ配当は house だけで賄う", () => {
    const house0 = ctx.casino.houseBalance();
    ctx.escrow.hold("sess1", "a", 30_000, "duel");
    ctx.escrow.hold("sess1", "b", 30_000, "duel");
    // 預り 60,000 溜まっても house 残高は 1 も動いていない
    expect(ctx.casino.houseBalance()).toBe(house0);
    // canAccept は house 残高だけで判定するので、預り金の混入は起きない
    expect(ctx.casino.canAccept(house0)).toBe(true);
    expect(ctx.casino.canAccept(house0 + 1)).toBe(false);
  });

  it("エテル総量は預入・返金の全過程で保存される（合計 = 発行済み）", () => {
    const total0 = ctx.ether.outstanding();
    ctx.escrow.hold("sess1", "a", 7_000, "duel");
    ctx.escrow.hold("sess1", "b", 7_000, "duel");
    ctx.escrow.refund("sess1");
    ctx.escrow.hold("sess2", "a", 1_000, "duel");
    ctx.escrow.refundOne("sess2", "a");
    expect(ctx.ether.outstanding()).toBe(total0);
    expect(ctx.ledger.verifyIntegrity().ok).toBe(true);
  });
});

describe("Markets: 資金分離と精算", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("bet は houseではなく板専用エスクローへ移動する", () => {
    const m = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "テスト", options: ["○", "×"], durationMin: 10, fee: 0,
    });
    const house0 = ctx.ether.balanceOf(HOUSE_HOLDER);
    ctx.markets.bet(m.id, "a", 0, 5_000);
    ctx.markets.bet(m.id, "b", 1, 3_000);
    // house 残高は 1 も動いていない
    expect(ctx.ether.balanceOf(HOUSE_HOLDER)).toBe(house0);
    // 板の預り所にちょうど pot 分（8,000）が溜まっている
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(8_000);
  });

  it("adminVoid で全額返金・板エスクローが 0 になる", () => {
    const m = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "テスト", options: ["○", "×"], durationMin: 10, fee: 0,
    });
    ctx.markets.bet(m.id, "a", 0, 5_000);
    ctx.markets.bet(m.id, "b", 1, 3_000);
    const beforeA = ctx.ether.balanceOf("a");
    const beforeB = ctx.ether.balanceOf("b");
    ctx.markets.close(m.id, "admin");
    ctx.markets.report(m.id, "a", 0);
    ctx.markets.dispute(m.id, "b");
    ctx.markets.adminVoid(m.id, "admin");
    expect(ctx.ether.balanceOf("a")).toBe(beforeA + 5_000);
    expect(ctx.ether.balanceOf("b")).toBe(beforeB + 3_000);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(0);
  });

  it("refundAllPending 後に板エスクロー残高が 0 になる（Bot再起動シナリオ）", () => {
    const m1 = ctx.markets.create({ guildId: "g", creatorId: "a", title: "T1", options: ["A", "B"], durationMin: 10, fee: 0 });
    const m2 = ctx.markets.create({ guildId: "g", creatorId: "a", title: "T2", options: ["A", "B"], durationMin: 10, fee: 0 });
    ctx.markets.bet(m1.id, "a", 0, 2_000);
    ctx.markets.bet(m2.id, "b", 1, 4_000);
    const beforeA = ctx.ether.balanceOf("a");
    const beforeB = ctx.ether.balanceOf("b");
    const r = ctx.markets.refundAllPending("system:startup");
    expect(r.total).toBe(2);
    expect(r.refunded).toBe(2);
    expect(r.failed).toEqual([]);
    expect(ctx.ether.balanceOf("a")).toBe(beforeA + 2_000);
    expect(ctx.ether.balanceOf("b")).toBe(beforeB + 4_000);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m1.id))).toBe(0);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m2.id))).toBe(0);
  });

  it("パリミュチュエル精算後、板エスクロー残高が 0 になる", () => {
    const m = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "T", options: ["○", "×"], durationMin: 10, fee: 0, payoutMode: "parimutuel",
    });
    ctx.markets.bet(m.id, "a", 0, 5_000);
    ctx.markets.bet(m.id, "b", 0, 3_000);
    ctx.markets.close(m.id, "admin");
    ctx.markets.report(m.id, "a", 0);
    ctx.markets.approve(m.id, "a");
    ctx.markets.approve(m.id, "b");
    // 精算後、エスクロー残高が 0（勝者と JP に配布し尽くした）
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(0);
  });

  it("孤児検出: escrow:market:* も対象になる（settled 済みなのに残高が残っているケース）", () => {
    const m = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "T", options: ["○", "×"], durationMin: 10, fee: 0,
    });
    // 板を精算完了状態にする
    ctx.markets.bet(m.id, "a", 0, 1_000);
    ctx.markets.close(m.id, "admin");
    ctx.markets.report(m.id, "a", 0);
    ctx.markets.approve(m.id, "a");
    // 精算後の状態: エスクロー残高 0、status='settled'
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(0);
    // 人為的に残高を戻す（精算バグ or 手動介入で発生し得る孤児）
    // fund で人為的に注入
    ctx.ether.transfer(HOUSE_HOLDER, marketEscrowHolder(m.id), 500);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(500);
    // sweep で隔離に移る（house 直行ではない）
    const r = ctx.escrow.sweepAll("test:startup");
    expect(r.orphans).toBe(1);
    expect(r.orphanTotal).toBe(500);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(0);
    expect(ctx.escrow.quarantineBalance()).toBe(500);
  });

  it("孤児検出: 未精算の open 板は孤児扱いしない（有効な帳簿がある）", () => {
    const m = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "T", options: ["○", "×"], durationMin: 10, fee: 0,
    });
    ctx.markets.bet(m.id, "a", 0, 2_000);
    // 未精算 (status='open') → 保有者残高は正当
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(2_000);
    const r = ctx.escrow.sweepAll("test:startup");
    // orphans = 0（有効な帳簿がある market は残す）
    expect(r.orphans).toBe(0);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(2_000);
  });

  it("underfunded escrow: refund/settle が黙って house にフォールバックせず例外を投げる", async () => {
    const m = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "T", options: ["○", "×"], durationMin: 10, fee: 0,
    });
    ctx.markets.bet(m.id, "a", 0, 3_000);
    // 人為的にエスクロー残高を減らす（バグでずれた状態を再現）
    ctx.ether.transfer(marketEscrowHolder(m.id), HOUSE_HOLDER, 1_000);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(2_000);
    // refund 呼び出し → underfunded escrow で throw
    expect(() => ctx.markets.refund(m.id, "test")).toThrowError(/ERR_UNDERFUNDED_ESCROW/);
    // 状態は変わらない (open のまま)
    const after = ctx.markets.get(m.id)!;
    expect(after.status).toBe("open");
  });

  it("refundAllPending: 個別 market の失敗が他の板の返金を止めない", () => {
    const m1 = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "T1", options: ["A", "B"], durationMin: 10, fee: 0,
    });
    const m2 = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "T2", options: ["A", "B"], durationMin: 10, fee: 0,
    });
    ctx.markets.bet(m1.id, "a", 0, 1_000);
    ctx.markets.bet(m2.id, "b", 0, 2_000);
    // m1 を意図的に underfunded にする
    ctx.ether.transfer(marketEscrowHolder(m1.id), HOUSE_HOLDER, 500);
    const beforeB = ctx.ether.balanceOf("b");
    const r = ctx.markets.refundAllPending("test:startup");
    // m2 は返金成功、m1 は失敗
    expect(r.total).toBe(2);
    expect(r.refunded).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.id).toBe(m1.id);
    expect(r.failed[0]!.error).toMatch(/ERR_UNDERFUNDED_ESCROW/);
    // m2 のプレイヤー b は返金されている
    expect(ctx.ether.balanceOf("b")).toBe(beforeB + 2_000);
  });

  it("的中者なし → void で全額返金し、エスクロー残高 0", () => {
    const m = ctx.markets.create({
      guildId: "g", creatorId: "a", title: "T", options: ["○", "×"], durationMin: 10, fee: 0,
    });
    ctx.markets.bet(m.id, "a", 0, 3_000);
    ctx.markets.bet(m.id, "b", 0, 2_000);
    ctx.markets.close(m.id, "admin");
    ctx.markets.report(m.id, "a", 1); // 誰も張っていない側を勝ちに
    const beforeA = ctx.ether.balanceOf("a");
    const beforeB = ctx.ether.balanceOf("b");
    ctx.markets.approve(m.id, "a");
    ctx.markets.approve(m.id, "b"); // 全員承認で自動精算 → 的中者0 → void
    expect(ctx.ether.balanceOf("a")).toBe(beforeA + 3_000);
    expect(ctx.ether.balanceOf("b")).toBe(beforeB + 2_000);
    expect(ctx.ether.balanceOf(marketEscrowHolder(m.id))).toBe(0);
  });
});
