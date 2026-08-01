import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Ledger, TREASURY } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { EventLog } from "../src/events/service.js";
import { Casino, JACKPOT_HOLDER } from "../src/casino/service.js";
import { ETHER_ESCROW, EtherExchange, HOUSE_HOLDER } from "../src/casino/exchange.js";
import { Escrow, ESCROW_QUARANTINE } from "../src/casino/escrow.js";
import { Markets } from "../src/casino/market.js";
import { ChipTx } from "../src/casino/chip-tx.js";
import { CasinoIntegrity } from "../src/casino/integrity.js";
import { CasinoStatus } from "../src/casino/status.js";
import { deptAccount } from "../src/departments/service.js";
import { opId } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

/**
 * PR2（検算A〜Dと稼働状態）の受入テスト。
 *
 * 見るのは2つ:
 * - 4つの検算が「正常系で通る」だけでなく「壊したときに気づく」こと
 * - 止まった理由が残り、**自動で開くのは起動時の点検だけ**であること
 */
function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const casino = new Casino(db, ether, events);
  const escrow = new Escrow(db, ether, events);
  const integrity = new CasinoIntegrity(db, ledger, ether, escrow);
  const status = new CasinoStatus(db);
  return { db, ledger, events, chipTx, ether, casino, escrow, integrity, status };
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

/** 賭場が一通り動いた状態（開始残高を取ってから遊ぶ・預ける） */
function busyCasino() {
  const ctx = setup();
  ctx.chipTx.captureLegacyOpening(ctx.ledger.balanceOf(ETHER_ESCROW));
  fundHouse(ctx, 100_000);
  fundUser(ctx, "alice", 20_000);
  fundUser(ctx, "bob", 20_000);
  ctx.casino.settle("alice", "スロット", 1_000, 2_000, 10, { operationId: opId() });
  ctx.escrow.holdAll("sess1", ["alice", "bob"], 3_000, "丁半", opId());
  return ctx;
}

describe("検算A〜D（正常系）", () => {
  it("一通り遊んだ後でも4つとも通る", () => {
    const ctx = busyCasino();
    const report = ctx.integrity.run();
    expect(report.checks.map((c) => c.id)).toEqual(["A", "B", "C", "D"]);
    expect(report.failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(ctx.integrity.checkLedger().ok).toBe(true);
    ctx.db.close();
  });

  it("開始プールが未設定でも、初回の検算Bが基準を1度だけ置く", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 5_000);
    // 開始残高だけ取って、プールの基準は入れない（PR1より前から動いていたDB相当）
    ctx.chipTx.captureLegacyOpening();
    expect(ctx.chipTx.openingPoolLand()).toBeNull();

    expect(ctx.integrity.checkB().ok).toBe(true);
    const baseline = ctx.chipTx.openingPoolLand();
    expect(baseline).not.toBeNull();

    // 基準は後から書き換わらない（開始残高と同じ扱い）
    ctx.ether.sell("alice", 1_000, "sell:alice");
    expect(ctx.integrity.checkB().ok).toBe(true);
    expect(ctx.chipTx.openingPoolLand()).toBe(baseline);
    ctx.db.close();
  });

  it("全額を返還して端数プールを回収しても検算Bは通る", () => {
    const ctx = setup();
    ctx.chipTx.captureLegacyOpening(ctx.ledger.balanceOf(ETHER_ESCROW));
    fundUser(ctx, "alice", 5_000);

    ctx.ether.sell("alice", ctx.ether.balanceOf("alice"), "sell:all");

    expect(ctx.ether.outstanding()).toBe(0);
    expect(ctx.ether.pool()).toBe(0); // 端数は国庫へ回収済み
    expect(ctx.integrity.checkB().ok).toBe(true);
    expect(ctx.integrity.run().ok).toBe(true);
    ctx.db.close();
  });
});

describe("検算A〜D（異常系）", () => {
  it("A: 記録を通さず残高を書き換えると気づく", () => {
    const ctx = busyCasino();
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run("alice");

    const report = ctx.integrity.run();
    expect(report.ok).toBe(false);
    expect(report.failed).toContain("A");
    expect(report.checks.find((c) => c.id === "A")!.mismatches[0]!.subject).toBe("alice");
    ctx.db.close();
  });

  it("B: 記録を通さず準備プールの Land を抜くと気づく", () => {
    const ctx = busyCasino();
    expect(ctx.integrity.checkB().ok).toBe(true);
    // 賭場の経路を通さずに準備Landを動かす（チップの裏付けが崩れる）
    ctx.ledger.transfer({
      from: ETHER_ESCROW, to: TREASURY, amount: 500, type: "adjust", actor: "t", approvedBy: "t",
      idempotencyKey: "sneaky-drain",
    });

    const b = ctx.integrity.checkB();
    expect(b.ok).toBe(false);
    expect(b.mismatches[0]).toMatchObject({ subject: ETHER_ESCROW, actual: ctx.ether.pool() });
    expect(ctx.integrity.run().failed).toContain("B");
    ctx.db.close();
  });

  it("C: 預り所の残高が帳簿とずれると気づく（卓・板の両方）", () => {
    const ctx = busyCasino();
    const markets = new Markets(ctx.db, ctx.ether, ctx.events);
    const market = markets.create({
      operationId: opId(), guildId: "g", creatorId: "alice", title: "どっち", options: ["A", "B"], durationMin: 60, fee: 0,
    });
    markets.bet(market.id, "bob", 0, 1_000, opId());
    expect(ctx.integrity.checkC().ok).toBe(true);

    // 卓と板の預り所からそれぞれ資金だけ抜く
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 100 WHERE user_id = ?").run("escrow:session:sess1");
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 200 WHERE user_id = ?").run(`escrow:market:${market.id}`);

    const c = ctx.integrity.checkC();
    expect(c.ok).toBe(false);
    expect(c.mismatches.map((m) => m.subject).sort()).toEqual([`market:${market.id}`, "session:sess1"]);
    ctx.db.close();
  });

  it("D: 帰属先の無い保有者にチップが乗ると気づく", () => {
    const ctx = busyCasino();
    expect(ctx.integrity.checkD().ok).toBe(true);

    // 帳簿の無い預り所にチップが残っている（孤児）
    ctx.db
      .prepare("INSERT INTO ether_balances (user_id, amount, updated_at) VALUES ('escrow:session:ghost', 700, 1)")
      .run();
    const d = ctx.integrity.checkD();
    expect(d.ok).toBe(false);
    expect(d.mismatches.some((m) => m.subject.includes("escrow:session:ghost"))).toBe(true);
    ctx.db.close();
  });

  it("D: 隔離口座と胴元・JP・救済は帰属済みとして扱う", () => {
    const ctx = busyCasino();
    ctx.ether.ensureHolder(ESCROW_QUARANTINE);
    ctx.ether.runGroup({ groupKey: "q1", kind: "table_refund", actorId: "system:test" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, ESCROW_QUARANTINE, 500, { reason: "隔離テスト" }),
    );
    expect(ctx.ether.balanceOf(ESCROW_QUARANTINE)).toBe(500);
    expect(ctx.integrity.checkD().ok).toBe(true);
    expect(ctx.ether.balanceOf(JACKPOT_HOLDER)).toBeGreaterThan(0);
    ctx.db.close();
  });
});

describe("稼働状態", () => {
  it("初期状態は営業中で、止めるには理由と実行者が要る", () => {
    const ctx = setup();
    expect(ctx.status.isOpen()).toBe(true);
    expect(ctx.status.denyMessage()).toBeNull();

    expect(() => ctx.status.set("manual_halt", "  ", "boss")).toThrow();
    ctx.status.set("manual_halt", "様子見", "boss");

    const cur = ctx.status.current();
    expect(cur).toMatchObject({ status: "manual_halt", reason: "様子見", changedBy: "boss" });
    expect(ctx.status.isOpen()).toBe(false);
    expect(ctx.status.denyMessage()).toContain("様子見");
    ctx.db.close();
  });

  it("状態変更は履歴と監査ログに残る", () => {
    const ctx = setup();
    ctx.status.set("maintenance", "改装", "boss");
    ctx.status.set("open", "改装おわり", "boss");

    expect(ctx.status.history().map((h) => h.status)).toEqual(["open", "maintenance"]);
    const audits = ctx.db
      .prepare("SELECT payload FROM outbox WHERE kind = 'audit_log' ORDER BY id")
      .all() as Array<{ payload: string }>;
    const events = audits.map((a) => JSON.parse(a.payload) as { event: string; to?: string });
    expect(events.filter((e) => e.event === "casino_status_changed").map((e) => e.to)).toEqual([
      "maintenance",
      "open",
    ]);
    ctx.db.close();
  });

  it("自動で解除されるのは起動時の点検だけ", () => {
    for (const held of ["manual_halt", "maintenance", "integrity_halt", "opening_reset"] as const) {
      const ctx = setup();
      ctx.status.set(held, "人が止めた", "boss");

      // 再起動相当: 点検に入ろうとしても人が止めた状態は触らない
      expect(ctx.status.beginStartupCheck()).toBe(false);
      expect(ctx.status.finishStartupCheck()).toBe(false);
      expect(ctx.status.current().status).toBe(held);
      ctx.db.close();
    }

    const ctx = setup();
    expect(ctx.status.beginStartupCheck()).toBe(true);
    expect(ctx.status.current().status).toBe("startup_check");
    expect(ctx.status.finishStartupCheck()).toBe(true);
    expect(ctx.status.current().status).toBe("open");
    ctx.db.close();
  });

  it("未知の状態値は fail-closed（開いていると誤認しない）", () => {
    const ctx = setup();
    ctx.db.prepare("UPDATE casino_status SET status = 'なにこれ' WHERE id = 1").run();
    expect(ctx.status.isOpen()).toBe(false);
    expect(ctx.status.denyMessage()).not.toBeNull();
    ctx.db.close();
  });
});

describe("検算NGによる自動停止", () => {
  it("1 Ld ずらすと停止し、直すまで開かない", () => {
    const ctx = busyCasino();
    ctx.status.beginStartupCheck();
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run("alice");

    const report = ctx.integrity.run();
    expect(report.ok).toBe(false);
    ctx.status.haltForIntegrity(CasinoIntegrity.describeFailure(report));

    expect(ctx.status.current().status).toBe("integrity_halt");
    expect(ctx.status.current().reason).toContain("検算A");
    // 再起動しても自動では開かない
    expect(ctx.status.beginStartupCheck()).toBe(false);
    expect(ctx.status.finishStartupCheck()).toBe(false);
    expect(ctx.status.isOpen()).toBe(false);

    // 直せば検算は通り、支配人の操作で開けられる
    ctx.db.prepare("UPDATE ether_balances SET amount = amount + 1 WHERE user_id = ?").run("alice");
    expect(ctx.integrity.run().ok).toBe(true);
    ctx.status.set("open", "帳簿を直した", "boss");
    expect(ctx.status.isOpen()).toBe(true);
    ctx.db.close();
  });

  it("停止理由にはNGだった検算がすべて並ぶ", () => {
    const ctx = busyCasino();
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run("alice");
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 100 WHERE user_id = ?").run("escrow:session:sess1");

    const report = ctx.integrity.run();
    const reason = CasinoIntegrity.describeFailure(report);
    expect(reason).toContain("検算A");
    expect(reason).toContain("検算C");
    ctx.db.close();
  });
});
