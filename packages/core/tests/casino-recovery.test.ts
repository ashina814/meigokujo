import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  Casino,
  CasinoIntegrity,
  CasinoStatus,
  ChipTx,
  ESCROW_QUARANTINE,
  Escrow,
  EtherExchange,
  EventLog,
  HOUSE_HOLDER,
  HouseReservations,
  Ledger,
  RecoveryRegistry,
  TREASURY,
  escrowHolderFor,
  marketEscrowHolder,
  openDb,
  recoverCasino,
  registerDefaultTxTypes,
} from "../src/index.js";

registerDefaultTxTypes();

/**
 * PR7（登録型復旧）。
 *
 * 「分からないときは動かさない」が守られているかを見る。
 * 自動返金は「所有元が確実に存在しない」と証明できた場合だけ。
 */

function setup() {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const ether = new EtherExchange(db, ledger, events, { baseRate: 1, chipTx });
  const escrow = new Escrow(db, ether, events);
  const casino = new Casino(db, ether, events);
  const integrity = new CasinoIntegrity(db, ledger, ether, escrow);
  const status = new CasinoStatus(db);
  const reservations = new HouseReservations(db, ether, events);
  const registry = new RecoveryRegistry();
  chipTx.captureLegacyOpening({ poolLand: ledger.balanceOf("sys:escrow:ether"), fromLedgerTxId: ledger.lastTransactionId() });
  return { db, ledger, events, chipTx, ether, escrow, casino, integrity, status, reservations, registry };
}

type Ctx = ReturnType<typeof setup>;

/** Land を経由して利用者にチップを配る（検算が通る形で下ごしらえする） */
function fundUser(ctx: Ctx, userId: string, amount: number): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY, to: `user:${userId}`, amount, type: "initial", actor: "t", idempotencyKey: `seed:${userId}:${amount}`,
  });
  ctx.ether.buy(userId, amount, `buy:${userId}:${amount}`);
}

const run = (ctx: Ctx) =>
  recoverCasino({
    db: ctx.db,
    status: ctx.status,
    integrity: ctx.integrity,
    chipTx: ctx.chipTx,
    escrow: ctx.escrow,
    reservations: ctx.reservations,
    registry: ctx.registry,
    events: ctx.events,
  });

describe("レジストリは所有元が自分で申告する", () => {
  it("同じ種別を二重登録できない", () => {
    const r = new RecoveryRegistry();
    r.register({ type: "market", listLiveEscrowHolders: () => [] });
    expect(() => r.register({ type: "market", listLiveEscrowHolders: () => [] })).toThrow("既に登録済み");
    expect(r.types()).toEqual(["market"]);
  });

  it("1つの申告が落ちても他の申告は集まる", () => {
    const r = new RecoveryRegistry();
    r.register({ type: "market", listLiveEscrowHolders: () => ["escrow:market:1"] });
    r.register({
      type: "table",
      listLiveEscrowHolders: () => {
        throw new Error("テーブルが壊れている");
      },
    });
    const live = r.liveHolders();
    expect([...live.holders]).toEqual(["escrow:market:1"]);
    expect(live.failed).toEqual([{ type: "table", error: "テーブルが壊れている" }]);
  });

  it("復旧の実装は casino_tables を直接参照していない（登録型に閉じている）", () => {
    const src = readFileSync(new URL("../src/casino/recovery.ts", import.meta.url), "utf8");
    expect(src).not.toContain("casino_tables");
    expect(src).not.toContain("casino_markets");
    const escrowSrc = readFileSync(new URL("../src/casino/escrow.ts", import.meta.url), "utf8");
    // 掃除の側から板テーブルへの直接参照が消えていること（旧 sweepAll の分岐）
    expect(escrowSrc.match(/casino_markets/g) ?? []).toHaveLength(1); // 旧 sweepAll の1箇所だけ
  });
});

describe("生きている預託は維持し、孤児だけ返金する", () => {
  it("登録済みの板は触らず、登録の無いセッションだけ返金する", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    fundUser(ctx, "bob", 30_000);
    // 生きている板（登録する）と、所有元の無い競馬セッション（登録しない）
    ctx.escrow.hold("market:7", "alice", 5_000, "板", "op-m");
    ctx.escrow.hold("keiba:123", "bob", 3_000, "競馬", "op-k");
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [escrowHolderFor("market:7")] });

    const r = run(ctx);
    expect(r.outcome).toBe("opened");
    expect(r.keptHolders).toBe(1);
    expect(r.refundedSessions).toBe(1);
    expect(r.refundedTotal).toBe(3_000);

    // 板の預託はそのまま
    expect(ctx.escrow.poolOf("market:7")).toBe(5_000);
    expect(ctx.ether.balanceOf(escrowHolderFor("market:7"))).toBe(5_000);
    // 競馬は返金されて帳簿ごと消える
    expect(ctx.escrow.list("keiba:123")).toEqual([]);
    expect(ctx.ether.balanceOf("bob")).toBe(30_000);
    ctx.db.close();
  });

  it("競馬は登録しないので、再起動のたびに返金される（意図した挙動）", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("keiba:999", "alice", 8_000, "競馬", "op-1");
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    expect(run(ctx).refundedSessions).toBe(1);
    expect(ctx.ether.balanceOf("alice")).toBe(20_000);
    ctx.db.close();
  });

  it("帳簿が無いのに残高がある escrow:* は隔離する", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    // 帳簿を作らずに保有者へ直接移す（過去の事故を模す）
    ctx.ether.runGroup({ groupKey: "test:orphan", kind: "table_hold", actorId: "t" }, () =>
      ctx.ether.transfer("alice", escrowHolderFor("消えた卓"), 4_000, { reason: "テストの細工" }),
    );
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });

    const r = run(ctx);
    expect(r.quarantined).toBe(1);
    expect(ctx.ether.balanceOf(ESCROW_QUARANTINE)).toBe(4_000);
    expect(ctx.ether.balanceOf(escrowHolderFor("消えた卓"))).toBe(0);
    ctx.db.close();
  });

  it("生きている板の保有者は、帳簿が無くても隔離しない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    const holder = marketEscrowHolder(3);
    ctx.ether.runGroup({ groupKey: "test:live-market", kind: "table_hold", actorId: "t" }, () =>
      ctx.ether.transfer("alice", holder, 6_000, { reason: "テストの細工" }),
    );
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [holder] });

    const r = run(ctx);
    expect(r.quarantined).toBe(0);
    expect(ctx.ether.balanceOf(holder)).toBe(6_000);
    ctx.db.close();
  });
});

describe("不一致は返金も隔離もせず記録だけ残す", () => {
  it("帳簿と保有者残高が合わないセッションは凍結される", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    ctx.escrow.hold("卓:壊れた", "alice", 5_000, "丁半", "op-1");
    // 保有者から 1,000 だけ抜いて不一致を作る
    ctx.ether.runGroup({ groupKey: "test:leak", kind: "table_refund", actorId: "t" }, () =>
      ctx.ether.transfer(escrowHolderFor("卓:壊れた"), HOUSE_HOLDER, 1_000, { reason: "テストの細工" }),
    );
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });

    const r = run(ctx);
    expect(r.mismatched).toEqual([{ sessionId: "卓:壊れた", expected: 5_000, actual: 4_000 }]);
    expect(r.refundedSessions).toBe(0);
    // 掃除で直らない不一致が残っているので、掃除後の全点検（検算C）が落ちて賭場は停止する。
    // 「凍結して人間の判断を待つ」＝営業も止める（正本 §6）
    expect(r.outcome).toBe("halted");
    expect(ctx.status.current().status).toBe("integrity_halt");
    // 返金も隔離もしていない。帳簿も残高も残っている
    expect(ctx.escrow.poolOf("卓:壊れた")).toBe(5_000);
    expect(ctx.ether.balanceOf(escrowHolderFor("卓:壊れた"))).toBe(4_000);
    expect(ctx.ether.balanceOf(ESCROW_QUARANTINE)).toBe(0);

    const logged = ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'casino_escrow_mismatch'").get() as { n: number };
    expect(logged.n).toBe(1);
    ctx.db.close();
  });

  it("1セッションの不一致が他のセッションの復旧を止めない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    fundUser(ctx, "bob", 30_000);
    ctx.escrow.hold("卓:壊れた", "alice", 5_000, "丁半", "op-1");
    ctx.escrow.hold("卓:正常", "bob", 4_000, "丁半", "op-2");
    ctx.ether.runGroup({ groupKey: "test:leak", kind: "table_refund", actorId: "t" }, () =>
      ctx.ether.transfer(escrowHolderFor("卓:壊れた"), HOUSE_HOLDER, 1_000, { reason: "テストの細工" }),
    );
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });

    const r = run(ctx);
    expect(r.mismatched).toHaveLength(1);
    // 正常なほうは返金されている
    expect(r.refundedSessions).toBe(1);
    expect(ctx.ether.balanceOf("bob")).toBe(30_000);
    expect(ctx.escrow.list("卓:正常")).toEqual([]);
    ctx.db.close();
  });
});

describe("検算NGなら以降のステップを実行しない", () => {
  it("チップ残高を1 Ld ずらすと integrity_halt になり、返金も隔離も走らない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("keiba:1", "alice", 3_000, "競馬", "op-1");
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    // 記録を通さずに残高を書き換える（検算Aが落ちる）
    ctx.db.prepare("UPDATE ether_balances SET amount = amount + 1 WHERE user_id = 'alice'").run();

    const r = run(ctx);
    expect(r.outcome).toBe("halted");
    expect(r.steps).toEqual(["S2:Land台帳", "S3:チップ検算AB"]);
    expect(r.refundedSessions).toBe(0);
    expect(r.quarantined).toBe(0);
    expect(ctx.status.current().status).toBe("integrity_halt");
    // 預託はそのまま（検算NGのときはチップを1 Ld も動かさない）
    expect(ctx.escrow.poolOf("keiba:1")).toBe(3_000);
    ctx.db.close();
  });

  it("人が止めている状態では検算だけ行い、資金も状態も触らない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("keiba:1", "alice", 3_000, "競馬", "op-1");
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    ctx.status.haltManually("様子見", "boss");

    const r = run(ctx);
    expect(r.outcome).toBe("held");
    expect(r.refundedSessions).toBe(0);
    expect(ctx.status.current().status).toBe("manual_halt");
    expect(ctx.status.current().reason).toBe("様子見");
    expect(ctx.escrow.poolOf("keiba:1")).toBe(3_000);
    ctx.db.close();
  });

  it("integrity_halt のままなら自動では開けない（人の確認を待つ）", () => {
    const ctx = setup();
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    ctx.status.haltForIntegrity("前回の検算NG");

    const r = run(ctx);
    expect(r.outcome).toBe("manual");
    expect(ctx.status.current().status).toBe("integrity_halt");
    ctx.db.close();
  });
});

describe("債務予約の解放（S9）と再開（S12）", () => {
  it("復旧の中で予約が全解放される", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 50_000);
    ctx.ether.runGroup({ groupKey: "test:house", kind: "table_hold", actorId: "t" }, () =>
      ctx.ether.transfer("alice", HOUSE_HOLDER, 40_000, { reason: "胴元の元手" }),
    );
    ctx.reservations.reserve("残骸1", 10_000, "スロット", "u1");
    ctx.reservations.reserve("残骸2", 5_000, "丁半", "u2");
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });

    const r = run(ctx);
    expect(r.releasedReservations).toEqual({ count: 2, total: 15_000 });
    expect(ctx.reservations.count()).toBe(0);
    ctx.db.close();
  });

  it("正常終了なら open へ戻り、手順が記録される", () => {
    const ctx = setup();
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    const r = run(ctx);
    expect(r.outcome).toBe("opened");
    expect(r.steps).toEqual([
      "S2:Land台帳",
      "S3:チップ検算AB",
      "S1:startup_check",
      "S4:生存収集",
      "S5:照合",
      "S6:維持",
      "S7:孤児返金",
      "S8:隔離",
      "S9:予約解放",
      "S12:再開",
    ]);
    expect(ctx.status.current().status).toBe("open");
    ctx.db.close();
  });

  it("生存中エスクローの収集に失敗したら掃除を見送る（孤児と誤認しない）", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("market:7", "alice", 5_000, "板", "op-1");
    ctx.registry.register({
      type: "market",
      listLiveEscrowHolders: () => {
        throw new Error("板テーブルが読めない");
      },
    });

    const r = run(ctx);
    // 返金は一切していない（申告が読めない = 生きているかも分からない）
    expect(r.refundedSessions).toBe(0);
    expect(r.quarantined).toBe(0);
    expect(ctx.escrow.poolOf("market:7")).toBe(5_000);
    expect(r.reason).toContain("収集に失敗");
    ctx.db.close();
  });
});
