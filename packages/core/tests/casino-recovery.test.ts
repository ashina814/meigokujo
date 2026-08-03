import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  Casino,
  CasinoIntegrity,
  CasinoStatus,
  ChipTx,
  ESCROW_QUARANTINE,
  Escrow,
  ChipLedger,
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
  const ether = new ChipLedger(db, ledger, events, { chipTx });
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
  ctx.ether.deposit(userId, amount, `buy:${userId}:${amount}`);
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
    expect(r.releasedReservations).toEqual({ released: true, count: 2, total: 15_000 });
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

  /**
   * レビュー指摘: 所有元の申告が取れなかったのに、その後の全点検が通れば
   * open へ戻していた。掃除を見送った以上、復旧が完了したとは判断できない。
   */
  it("生存中エスクローの収集に失敗したら掃除も再開もしない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("market:7", "alice", 5_000, "板", "op-1");
    // 予約が取れるように胴元へ元手を入れておく（予約は house.available の範囲でしか取れない）
    ctx.ether.runGroup({ groupKey: "test:house", kind: "table_hold", actorId: "t" }, () =>
      ctx.ether.transfer("alice", HOUSE_HOLDER, 10_000, { reason: "胴元の元手" }),
    );
    expect(ctx.reservations.reserve("残骸", 3_000, "スロット", "u1").ok).toBe(true);
    ctx.registry.register({
      type: "market",
      listLiveEscrowHolders: () => {
        throw new Error("板テーブルが読めない");
      },
    });

    const r = run(ctx);

    // 営業を再開しない。**通常の検算停止とは別の状態**にする
    expect(r.outcome).toBe("source_failed");
    expect(ctx.status.current().status).not.toBe("open");
    expect(ctx.status.current().status).toBe("recovery_halt");
    // S12 は実行していない
    expect(r.steps).not.toContain("S12:再開");
    expect(r.steps).not.toContain("S9:予約解放");
    // 資金が動いていない（返金も隔離もしていない）
    expect(r.refundedSessions).toBe(0);
    expect(r.quarantined).toBe(0);
    expect(ctx.escrow.poolOf("market:7")).toBe(5_000);
    expect(ctx.ether.balanceOf(escrowHolderFor("market:7"))).toBe(5_000);
    expect(ctx.ether.balanceOf(ESCROW_QUARANTINE)).toBe(0);
    // 既存の予約が勝手に復旧済み扱いにならない（解放していないことも結果に出る）
    expect(r.releasedReservations).toEqual({ released: false, count: 0, total: 0 });
    expect(ctx.reservations.count()).toBe(1);
    // 運営向けイベントとログに失敗元が残る
    expect(r.reason).toContain("収集に失敗");
    expect(r.reason).toContain("market");
    const src = ctx.db
      .prepare("SELECT payload_json FROM events WHERE type = 'casino_recovery_source_failed'")
      .all() as Array<{ payload_json: string }>;
    expect(src).toHaveLength(1);
    expect(src[0]!.payload_json).toContain("板テーブルが読めない");
    const halted = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'casino_recovery_halted'")
      .get() as { n: number };
    expect(halted.n).toBe(1);
    // 停止理由にも「掃除・予約解放とも未実行」が残る
    expect(ctx.status.current().reason).toContain("未実行");
    ctx.db.close();
  });
});

/**
 * レビュー指摘: `Escrow.recoverSessions` は failed を返しているのに、
 * `recoverCasino` の返却値にもログにも含まれていなかった。
 * 1件の失敗で他の復旧は止めないが、失敗が起動ログから消えてはいけない。
 */
describe("孤児返金の技術失敗が結果に残る", () => {
  it("失敗したセッションは failedSessions に出て、帳簿と残高は維持される", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    fundUser(ctx, "bob", 30_000);
    ctx.escrow.hold("卓:壊れる", "alice", 5_000, "丁半", "op-1");
    ctx.escrow.hold("卓:正常", "bob", 4_000, "丁半", "op-2");
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });

    // 「卓:壊れる」の返金だけ技術的に失敗させる（送金の直前で投げる）
    const realTransfer = ctx.ether.transfer.bind(ctx.ether);
    ctx.ether.transfer = ((from: string, to: string, amount: number, info: never) => {
      if (from === escrowHolderFor("卓:壊れる")) throw new Error("送金に失敗した");
      return realTransfer(from, to, amount, info);
    }) as typeof ctx.ether.transfer;

    const r = run(ctx);
    ctx.ether.transfer = realTransfer;

    // 失敗が結果に残る（件数・sessionId・expected・actual・error）
    expect(r.failedSessions).toHaveLength(1);
    const f = r.failedSessions[0]!;
    expect(f.sessionId).toBe("卓:壊れる");
    expect(f.expected).toBe(5_000);
    expect(f.actual).toBe(5_000);
    expect(f.error).toContain("送金に失敗した");

    // 失敗した帳簿と残高は維持
    expect(ctx.escrow.poolOf("卓:壊れる")).toBe(5_000);
    expect(ctx.ether.balanceOf(escrowHolderFor("卓:壊れる"))).toBe(5_000);
    expect(ctx.ether.balanceOf(ESCROW_QUARANTINE)).toBe(0);

    // 他の正常セッションは続行している
    expect(r.refundedSessions).toBe(1);
    expect(ctx.escrow.list("卓:正常")).toEqual([]);

    // 監査イベントに詳細が残る
    const logged = ctx.db
      .prepare("SELECT payload_json FROM events WHERE type = 'casino_escrow_sweep_failed'")
      .all() as Array<{ payload_json: string }>;
    expect(logged).toHaveLength(1);
    expect(logged[0]!.payload_json).toContain("卓:壊れる");
    expect(logged[0]!.payload_json).toContain("送金に失敗した");

    // レビュー指摘（PR7監査）: 帳簿と残高が一致したまま残るので postflight A〜D は
    // 通り得るが、それでも「復旧未完了」として営業を再開してはいけない
    expect(r.outcome).toBe("refund_failed");
    expect(ctx.status.current().status).toBe("recovery_halt");
    ctx.db.close();
  });

  it("failedSessionsが残る限り営業を再開しない。再実行では失敗分だけ再試行し、成功済みは二重返金しない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    fundUser(ctx, "bob", 30_000);
    ctx.escrow.hold("卓:壊れる", "alice", 5_000, "丁半", "op-1");
    ctx.escrow.hold("卓:正常", "bob", 4_000, "丁半", "op-2");
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });

    const realTransfer = ctx.ether.transfer.bind(ctx.ether);
    ctx.ether.transfer = ((from: string, to: string, amount: number, info: never) => {
      if (from === escrowHolderFor("卓:壊れる")) throw new Error("送金に失敗した");
      return realTransfer(from, to, amount, info);
    }) as typeof ctx.ether.transfer;

    const first = run(ctx);
    ctx.ether.transfer = realTransfer;

    // 技術失敗が残っている限り open にしない
    expect(first.outcome).toBe("refund_failed");
    expect(ctx.status.current().status).toBe("recovery_halt");
    // 正常なほうは既に返金済み
    expect(ctx.ether.balanceOf("bob")).toBe(30_000);
    const bobBalanceAfterFirst = ctx.ether.balanceOf("bob");

    // 再実行: 今度は送金が通る。失敗していたセッションだけが再試行対象になる
    const second = run(ctx);
    expect(second.outcome).toBe("opened");
    expect(second.failedSessions).toHaveLength(0);
    expect(second.refundedSessions).toBe(1); // 「卓:壊れる」だけ（正常分の帳簿はもう無い）
    expect(ctx.ether.balanceOf("alice")).toBe(30_000);
    // bob は二重返金されていない
    expect(ctx.ether.balanceOf("bob")).toBe(bobBalanceAfterFirst);
    expect(ctx.status.current().status).toBe("open");
    ctx.db.close();
  });
});

/**
 * 最終レビュー指摘（二次レビュー）: failedSessions と、それとは無関係な postflight 検算NG が
 * 同時に起きたとき、postflight NG が先に integrity_halt を確定させてしまうと、
 * 「別件の検算だけ直して reopenAfterIntegrity() で開ける」＝孤児返金の再試行義務が
 * 消えてしまう。failedSessions の判定は postflight の成否より優先し、常に recovery_halt にする。
 */
describe("failedSessionsはpostflightの成否より優先される", () => {
  it("孤児返金の技術失敗と、それとは無関係な帳簿不一致が同時に起きても、recovery_haltを優先する", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    fundUser(ctx, "bob", 30_000);
    ctx.escrow.hold("卓:壊れる", "alice", 5_000, "丁半", "op-1"); // これを技術失敗させる
    ctx.escrow.hold("卓:不一致", "bob", 4_000, "丁半", "op-2"); // これとは独立に不一致を作る
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });

    // 「卓:不一致」の保有者から外部で1,000だけ抜く（failedSessionsとは無関係な独立した検算NG）
    ctx.ether.runGroup({ groupKey: "test:independent-leak", kind: "table_refund", actorId: "t" }, () =>
      ctx.ether.transfer(escrowHolderFor("卓:不一致"), HOUSE_HOLDER, 1_000, { reason: "テストの細工（独立した不一致）" }),
    );

    // 「卓:壊れる」の返金だけ技術的に失敗させる
    const realTransfer = ctx.ether.transfer.bind(ctx.ether);
    ctx.ether.transfer = ((from: string, to: string, amount: number, info: never) => {
      if (from === escrowHolderFor("卓:壊れる")) throw new Error("送金に失敗した");
      return realTransfer(from, to, amount, info);
    }) as typeof ctx.ether.transfer;

    const r = run(ctx);
    ctx.ether.transfer = realTransfer;

    // 両方とも検出されている
    expect(r.failedSessions).toHaveLength(1);
    expect(r.mismatched).toHaveLength(1);
    // failedSessionsがpostflight（不一致によるNG）より優先され、recovery_haltになる
    expect(r.outcome).toBe("refund_failed");
    expect(ctx.status.current().status).toBe("recovery_halt");
    // reasonに両方の情報が残っている
    expect(r.reason).toContain("送金に失敗した");
    expect(r.reason).toContain("検算NG");

    // 通常の再点検（reopenAfterIntegrity）では、たとえ検算が通っても開けない
    ctx.ether.runGroup({ groupKey: "test:fix-independent", kind: "table_hold", actorId: "t" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, escrowHolderFor("卓:不一致"), 1_000, { reason: "テスト後始末" }),
    );
    const report = ctx.integrity.runFull();
    const reopened = ctx.status.reopenAfterIntegrity("直った", "admin", report.ok);
    expect(reopened.ok).toBe(false);
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 原因（送金失敗）も直して再実行すると、S4〜S12 が完走する。
    // 「卓:壊れる」（alice）は再試行で返金され、不一致が解消した「卓:不一致」（bob）は
    // このタイミングで初めて（一度だけ）孤児として返金される
    const second = run(ctx);
    expect(second.outcome).toBe("opened");
    expect(second.failedSessions).toHaveLength(0);
    expect(second.mismatched).toHaveLength(0);
    expect(second.refundedSessions).toBe(2); // 卓:壊れる + 卓:不一致
    expect(ctx.ether.balanceOf("alice")).toBe(30_000);
    expect(ctx.ether.balanceOf("bob")).toBe(30_000);
    expect(ctx.status.current().status).toBe("open");

    // 3回目を回しても、もう返す対象が無いので二重返金は起きない
    const third = run(ctx);
    expect(third.outcome).toBe("opened");
    expect(third.refundedSessions).toBe(0);
    expect(ctx.ether.balanceOf("alice")).toBe(30_000);
    expect(ctx.ether.balanceOf("bob")).toBe(30_000);
    ctx.db.close();
  });
});

/**
 * 最終レビュー指摘（二次レビュー）: S1（beginStartupCheck）以降で予期しない例外が
 * 外へ抜けると、status が S1 で書き換えた startup_check のまま残ってしまい、
 * 元が recovery_halt だった文脈が失われる。必ず recovery_halt へ着地させる。
 */
describe("S1以降の予期しない例外はrecovery_haltへ着地する", () => {
  /** casino_house_reservations を直接破損させ、totalReserved() が例外を投げる状態を作る */
  function corruptReservations(ctx: Ctx): void {
    ctx.db
      .prepare(
        "INSERT INTO casino_house_reservations (key, amount, game, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("corrupt", Number.MAX_SAFE_INTEGER + 2, "test", "u1", Math.floor(Date.now() / 1000));
  }

  it("open由来の正常起動でS9へ例外が起きた場合、recovery_haltになりS12を実行しない", () => {
    const ctx = setup();
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    corruptReservations(ctx);

    const r = run(ctx);
    expect(r.outcome).toBe("exception_failed");
    expect(r.steps).not.toContain("S12:再開");
    expect(ctx.status.current().status).toBe("recovery_halt");
    ctx.db.close();
  });

  it("recovery_halt再実行中にS9へ例外が起きても、recovery_haltを維持し理由が失われない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("keiba:1", "alice", 5_000, "競馬", "op-1");
    const broken = { value: true };
    ctx.registry.register({
      type: "market",
      listLiveEscrowHolders: () => {
        if (broken.value) throw new Error("板テーブルが読めない");
        return [];
      },
    });

    // 1. source失敗でrecovery_haltになる
    expect(run(ctx).outcome).toBe("source_failed");
    expect(ctx.status.current().status).toBe("recovery_halt");
    const reasonAfterFirst = ctx.status.current().reason;
    expect(reasonAfterFirst).toContain("収集に失敗");

    // 2. sourceは直すが、予約テーブルを破損させてS9で例外を起こす
    broken.value = false;
    corruptReservations(ctx);

    const r = run(ctx);
    expect(r.outcome).toBe("exception_failed");
    // **recovery_haltのまま**（startup_checkのまま放置されたり、integrity_haltに化けたりしない）
    expect(ctx.status.current().status).toBe("recovery_halt");
    // 元の理由（1回目のsource失敗）が失われず、新しい異常が追記されている
    expect(ctx.status.current().reason).toContain("収集に失敗");
    expect(ctx.status.current().reason).toContain("予期しない例外");

    // 3. DBを読み直しても復旧義務は残る
    expect(new CasinoStatus(ctx.db).current().status).toBe("recovery_halt");

    // 4. 通常の再点検では解除できない
    const report = ctx.integrity.runFull();
    expect(ctx.status.reopenAfterIntegrity("直した", "admin", report.ok).ok).toBe(false);
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 5. 原因（予約テーブル破損）を直して再実行すると、S4〜S12が完走してopenになる。
    //    S4〜S8で既に成功していた孤児返金（keiba:1）が二重に返金・隔離されないことも確認する
    const aliceBalanceBeforeThird = ctx.ether.balanceOf("alice");
    ctx.db.prepare("DELETE FROM casino_house_reservations WHERE key = 'corrupt'").run();
    const third = run(ctx);
    expect(third.outcome).toBe("opened");
    expect(ctx.status.current().status).toBe("open");
    // keiba:1 は最初の成功した実行時点で既に返金済みなので、3回目は返す対象が無い
    expect(third.refundedSessions).toBe(0);
    expect(ctx.ether.balanceOf("alice")).toBe(aliceBalanceBeforeThird);
    ctx.db.close();
  });

  it("同じ異常で再実行を繰り返しても、reasonへ同じ行を無限に重複追加しない", () => {
    const ctx = setup();
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    corruptReservations(ctx);

    run(ctx);
    const reasonAfterFirst = ctx.status.current().reason;
    run(ctx);
    const reasonAfterSecond = ctx.status.current().reason;
    run(ctx);
    const reasonAfterThird = ctx.status.current().reason;

    // 同じ例外が繰り返し起きても、reason文字列は増え続けない（1回目以降は不変）
    expect(reasonAfterSecond).toBe(reasonAfterFirst);
    expect(reasonAfterThird).toBe(reasonAfterFirst);
    ctx.db.close();
  });
});

/**
 * レビュー指摘: source 取得失敗は通常の integrity_halt と分ける。
 *
 * A〜D がたまたま通っても、
 * 「生存中の預託を確認していない・孤児掃除をしていない・予約解放をしていない」
 * 状態なので、運営卓の「再点検」からは開けてはいけない。
 * 出口は復旧をやり直して S12 まで通すことだけ。
 */
describe("recovery_halt は通常の再開導線から開けられない", () => {
  /** source が読めない状態を作る（毎回投げる登録元を1つ入れる） */
  function brokenSource(ctx: Ctx, broken = { value: true }) {
    ctx.registry.register({
      type: "market",
      listLiveEscrowHolders: () => {
        if (broken.value) throw new Error("板テーブルが読めない");
        return [];
      },
    });
    return broken;
  }

  it("A〜Dが通っても通常の再開（reopenAfterIntegrity）では開かない", () => {
    const ctx = setup();
    brokenSource(ctx);
    expect(run(ctx).outcome).toBe("source_failed");
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 全点検は通る（掃除対象が無いので当然通ってしまう）
    const report = ctx.integrity.runFull();
    expect(report.ok).toBe(true);

    // それでも通常の再開導線は断る
    const reopened = ctx.status.reopenAfterIntegrity("再点検で通った", "admin", report.ok);
    expect(reopened.ok).toBe(false);
    expect(ctx.status.current().status).toBe("recovery_halt");
    ctx.db.close();
  });

  it("Bot 再起動後も専用停止状態が残る", () => {
    const ctx = setup();
    brokenSource(ctx);
    run(ctx);
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 同じ DB から状態を読み直す（＝再起動）
    const restarted = new CasinoStatus(ctx.db);
    expect(restarted.current().status).toBe("recovery_halt");
    expect(restarted.isOpen()).toBe(false);
    expect(restarted.denyMessage()).toContain("点検");
    ctx.db.close();
  });

  it("復旧再実行の前検NGでも復旧義務を保持し、S12成功時だけ解除する", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    const broken = brokenSource(ctx);

    // 1. source 取得失敗で recovery_halt になる
    expect(run(ctx).outcome).toBe("source_failed");
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 2. S2/S3 の前検も壊した状態で再実行する
    ctx.db.prepare("UPDATE ether_balances SET amount = amount - 1 WHERE user_id = ?").run("alice");
    const precheckFailed = run(ctx);
    expect(precheckFailed.outcome).toBe("halted");
    expect(precheckFailed.steps).toEqual(["S2:Land台帳", "S3:チップ検算AB"]);
    expect(ctx.status.current().status).toBe("recovery_halt");
    expect(ctx.status.current().reason).toContain("検算NG");

    // DBを読み直しても、未完了の復旧義務は残る
    expect(new CasinoStatus(ctx.db).current().status).toBe("recovery_halt");

    // 3. 検算だけ直しても、通常の再点検経路では開かない
    ctx.db.prepare("UPDATE ether_balances SET amount = amount + 1 WHERE user_id = ?").run("alice");
    const report = ctx.integrity.runFull();
    expect(report.ok).toBe(true);
    expect(ctx.status.reopenAfterIntegrity("検算を直した", "admin", report.ok).ok).toBe(false);
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 4. 復旧を再実行して S4〜S12 を完走したときだけ解除される
    broken.value = false;
    const completed = run(ctx);
    expect(completed.outcome).toBe("opened");
    expect(completed.steps).toContain("S4:生存収集");
    expect(completed.steps).toContain("S12:再開");
    expect(ctx.status.current().status).toBe("open");
    ctx.db.close();
  });

  it("source が直ったあとに復旧を再実行すると S4〜S12 が動いて open になる", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("keiba:1", "alice", 5_000, "競馬", "op-1"); // 所有元の無い孤児
    ctx.ether.runGroup({ groupKey: "test:house", kind: "table_hold", actorId: "t" }, () =>
      ctx.ether.transfer("alice", HOUSE_HOLDER, 5_000, { reason: "胴元の元手" }),
    );
    ctx.reservations.reserve("残骸", 3_000, "スロット", "u1");
    const broken = brokenSource(ctx);

    // 1回目: source が読めない → 何もせず recovery_halt
    const first = run(ctx);
    expect(first.outcome).toBe("source_failed");
    expect(first.refundedSessions).toBe(0);
    expect(ctx.reservations.count()).toBe(1);

    // source が直った → 復旧を再実行
    broken.value = false;
    const second = run(ctx);

    expect(second.outcome).toBe("opened");
    expect(ctx.status.current().status).toBe("open");
    expect(second.steps).toContain("S4:生存収集");
    expect(second.steps).toContain("S7:孤児返金");
    expect(second.steps).toContain("S9:予約解放");
    expect(second.steps).toContain("S12:再開");
    // 孤児返金も予約解放もこのときに一度だけ行われる
    expect(second.refundedSessions).toBe(1);
    expect(second.releasedReservations).toEqual({ released: true, count: 1, total: 3_000 });
    expect(ctx.reservations.count()).toBe(0);
    expect(ctx.escrow.list("keiba:1")).toEqual([]);
    ctx.db.close();
  });

  it("復旧が成功したときだけ open になる（もう一度回しても二重返金しない）", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 20_000);
    ctx.escrow.hold("keiba:1", "alice", 5_000, "競馬", "op-1");
    const broken = brokenSource(ctx);
    run(ctx);
    broken.value = false;
    run(ctx);
    const balanceAfter = ctx.ether.balanceOf("alice");

    // 3回目（もう返すものが無い）
    const third = run(ctx);
    expect(third.outcome).toBe("opened");
    expect(third.refundedSessions).toBe(0);
    expect(ctx.ether.balanceOf("alice")).toBe(balanceAfter);
    ctx.db.close();
  });

  /**
   * レビュー指摘（PR7監査）: S1（beginStartupCheck）が status を startup_check へ
   * 書き換えたあとに postflight や不一致を見つけて `haltForIntegrity` を単純に呼ぶと、
   * 「recovery_halt から再実行していた」事実が消えて通常の integrity_halt に化ける。
   * そうなると通常の「再点検」（reopenAfterIntegrity）から開けてしまい、
   * 復旧義務（S4〜S12 の再実行）が二度と要求されなくなる。
   */
  it("recovery_halt再実行中にpostflight不一致が見つかっても、通常のintegrity_haltへすり替えない", () => {
    const ctx = setup();
    fundUser(ctx, "alice", 30_000);
    const broken = brokenSource(ctx);

    // 1. source 失敗で recovery_halt になる
    expect(run(ctx).outcome).toBe("source_failed");
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 2. source は直すが、帳簿不一致を仕込む（S5照合とpostflight検算Cの両方で検出される）
    broken.value = false;
    ctx.escrow.hold("卓:壊れた", "alice", 5_000, "丁半", "op-1");
    ctx.ether.runGroup({ groupKey: "test:leak2", kind: "table_refund", actorId: "t" }, () =>
      ctx.ether.transfer(escrowHolderFor("卓:壊れた"), HOUSE_HOLDER, 1_000, { reason: "テストの細工" }),
    );

    const r = run(ctx);
    expect(r.outcome).toBe("halted");
    // **recovery_halt のまま**。integrity_halt へすり替わっていない
    expect(ctx.status.current().status).toBe("recovery_halt");

    // 通常の再点検経路（reopenAfterIntegrity）ではやはり開けない
    ctx.ether.runGroup({ groupKey: "test:fix", kind: "table_hold", actorId: "t" }, () =>
      ctx.ether.transfer(HOUSE_HOLDER, escrowHolderFor("卓:壊れた"), 1_000, { reason: "テストの後始末" }),
    );
    const report = ctx.integrity.runFull();
    const reopened = ctx.status.reopenAfterIntegrity("再点検で通った", "admin", report.ok);
    expect(reopened.ok).toBe(false);
    expect(ctx.status.current().status).toBe("recovery_halt");
    ctx.db.close();
  });

  it("予約テーブルが破損してtotalReserved()が失敗した場合、例外を構造化結果へ変換しrecovery_haltへ着地する", () => {
    const ctx = setup();
    ctx.registry.register({ type: "market", listLiveEscrowHolders: () => [] });
    // Number.MAX_SAFE_INTEGER を超える行を直接仕込む（reserve() のsafe-integer検証を経由しない破損を模す）
    ctx.db
      .prepare(
        "INSERT INTO casino_house_reservations (key, amount, game, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("corrupt", Number.MAX_SAFE_INTEGER + 2, "test", "u1", Math.floor(Date.now() / 1000));

    // S9 (releaseAll → totalReserved) の例外は外へ漏らさず、構造化結果へ変換する（PR7監査・二次レビュー）
    const r = run(ctx);
    expect(r.outcome).toBe("exception_failed");
    expect(r.reason).toContain("ERR_BAD_AMOUNT");
    // 例外で止まった以上、営業は絶対に開いておらず、必ず recovery_halt にする
    expect(ctx.status.current().status).toBe("recovery_halt");

    // DBを読み直しても復旧義務は残る（S1で書き換わったstartup_checkのまま放置されない）
    expect(new CasinoStatus(ctx.db).current().status).toBe("recovery_halt");
    // 通常の再点検経路では開かない
    const report = ctx.integrity.runFull();
    expect(ctx.status.reopenAfterIntegrity("直した", "admin", report.ok).ok).toBe(false);
    expect(ctx.status.current().status).toBe("recovery_halt");
    ctx.db.close();
  });
});

describe("RecoveryRegistryの入力検証（fail-closed）", () => {
  it("空のtypeは登録を拒否する", () => {
    const r = new RecoveryRegistry();
    expect(() => r.register({ type: "", listLiveEscrowHolders: () => [] })).toThrow("type は空にできない");
  });

  it("空白のみのtypeは登録を拒否する", () => {
    const r = new RecoveryRegistry();
    expect(() => r.register({ type: "   ", listLiveEscrowHolders: () => [] })).toThrow("type は空にできない");
  });

  it("配列以外を返すsourceはfailedへ（生存holderなしと誤解しない）", () => {
    const r = new RecoveryRegistry();
    r.register({ type: "broken", listLiveEscrowHolders: () => "not-an-array" as unknown as string[] });
    const live = r.liveHolders();
    expect([...live.holders]).toEqual([]);
    expect(live.failed).toHaveLength(1);
    expect(live.failed[0]!.type).toBe("broken");
  });

  it("holderがstring以外の要素を含むsourceは丸ごとfailedへ（部分採用しない）", () => {
    const r = new RecoveryRegistry();
    r.register({
      type: "mixed",
      listLiveEscrowHolders: () => ["escrow:market:1", 123 as unknown as string],
    });
    const live = r.liveHolders();
    // 有効に見える "escrow:market:1" も含めて一切採用しない（fail-closed）
    expect([...live.holders]).toEqual([]);
    expect(live.failed).toHaveLength(1);
    expect(live.failed[0]!.type).toBe("mixed");
  });

  it("空文字のholderは丸ごとfailedへ", () => {
    const r = new RecoveryRegistry();
    r.register({ type: "empty-holder", listLiveEscrowHolders: () => ["escrow:market:1", ""] });
    const live = r.liveHolders();
    expect([...live.holders]).toEqual([]);
    expect(live.failed.map((f) => f.type)).toEqual(["empty-holder"]);
  });

  it("空白のみのholderは丸ごとfailedへ", () => {
    const r = new RecoveryRegistry();
    r.register({ type: "blank-holder", listLiveEscrowHolders: () => ["escrow:market:1", "   "] });
    const live = r.liveHolders();
    expect([...live.holders]).toEqual([]);
    expect(live.failed.map((f) => f.type)).toEqual(["blank-holder"]);
  });

  it("__proto__ という文字列のholderも通常の文字列として扱われる（特別扱いしない）", () => {
    const r = new RecoveryRegistry();
    r.register({ type: "market", listLiveEscrowHolders: () => ["__proto__", "escrow:market:1"] });
    const live = r.liveHolders();
    expect(live.failed).toEqual([]);
    expect([...live.holders].sort()).toEqual(["__proto__", "escrow:market:1"].sort());
    expect(live.holders.has("__proto__")).toBe(true);
    // Set のプロトタイプが汚染されていない
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("複数の登録元が重複したholderを申告してもSetで一意化される", () => {
    const r = new RecoveryRegistry();
    r.register({ type: "a", listLiveEscrowHolders: () => ["escrow:market:1"] });
    r.register({ type: "b", listLiveEscrowHolders: () => ["escrow:market:1", "escrow:market:2"] });
    const live = r.liveHolders();
    expect([...live.holders].sort()).toEqual(["escrow:market:1", "escrow:market:2"]);
  });

  it("sourceが返した配列を後から変更しても、既に収集した結果は変わらない", () => {
    const mutable = ["escrow:market:1"];
    const r = new RecoveryRegistry();
    r.register({ type: "market", listLiveEscrowHolders: () => mutable });
    const live = r.liveHolders();
    mutable.push("escrow:market:99");
    mutable[0] = "tampered";
    expect([...live.holders]).toEqual(["escrow:market:1"]);
  });

  it("登録順を変えても収集結果（holders・failed）は変わらない", () => {
    const build = (order: "ab" | "ba") => {
      const r = new RecoveryRegistry();
      const regA = () => r.register({ type: "a", listLiveEscrowHolders: () => ["escrow:market:1"] });
      const regB = () =>
        r.register({
          type: "b",
          listLiveEscrowHolders: () => {
            throw new Error("bが壊れている");
          },
        });
      if (order === "ab") {
        regA();
        regB();
      } else {
        regB();
        regA();
      }
      return r.liveHolders();
    };
    const ab = build("ab");
    const ba = build("ba");
    expect([...ab.holders]).toEqual([...ba.holders]);
    expect(ab.failed).toEqual(ba.failed);
  });
});
