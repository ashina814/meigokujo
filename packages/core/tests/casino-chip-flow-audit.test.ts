/**
 * PR10 本監査の敵対的テスト。
 *
 * ここに集めてあるのは「通常経路では起きないが、起きたときに資金・復旧完了条件を
 * 壊す」組合せだけ。正常系は casino-chip-flow.test.ts 側にある。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  CasinoStatus,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  HouseReservations,
  Ledger,
  RecoveryRegistry,
  TREASURY,
  openDb,
  recoverCasino,
  registerDefaultTxTypes,
} from "../src/index.js";
import { openFormally } from "./helpers/chip-ctx.js";

registerDefaultTxTypes();

function setup(options: { isSeatOccupied?: (userId: string) => boolean } = {}) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  openFormally(chipTx, ledger);
  const escrow = new Escrow(db, chips, events);
  const assets = new CasinoChipAssets(db, chips);
  const flow = new CasinoChipFlow(db, chips, events, assets, options);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, assets);
  const status = new CasinoStatus(db);
  const reservations = new HouseReservations(db, chips, events);
  const registry = new RecoveryRegistry();
  registry.register({ type: "market", listLiveEscrowHolders: () => [] });
  const run = () =>
    recoverCasino({ db, status, integrity, chipTx, escrow, reservations, registry, events, chipFlow: flow });
  return { db, ledger, events, chipTx, chips, assets, flow, integrity, status, run };
}

type Ctx = ReturnType<typeof setup>;

function fund(ctx: Ctx, userId: string, land: number, chips = land): void {
  ctx.ledger.ensureAccount(`user:${userId}`, "user");
  ctx.ledger.transfer({
    from: TREASURY,
    to: `user:${userId}`,
    amount: land,
    type: "initial",
    actor: "test",
    idempotencyKey: `seed:${userId}`,
  });
  if (chips > 0) ctx.chips.deposit(userId, chips, `deposit:${userId}`);
}

function reserve(ctx: Ctx, userId: string): void {
  ctx.db.prepare(
    "INSERT INTO casino_house_reservations (key,amount,game,user_id,created_at) VALUES (?,100,'slots',?,0)",
  ).run(`active:${userId}`, userId);
}

// ── ブロッカーA: active ownership を成功扱いしない ─────────────────────────

describe("PR10監査A: active ownership skip", () => {
  it("S10のskipはredeemedへ入らず、種類・理由・残高が構造化して残る", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    fund(ctx, "bob", 100);
    reserve(ctx, "bob");

    const result = ctx.flow.redeemAllFreeChips("startup");

    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["alice"]);
    // 資金が動いていないbobを「返還済み」へ混ぜない
    expect(result.redeemed.some((entry) => entry.userId === "bob")).toBe(false);
    expect(result.skipped).toEqual([{ userId: "bob", amount: 100, reason: "active_ownership" }]);
    expect(ctx.assets.freeChips("bob")).toBe(100);
    ctx.db.close();
  });

  it("skipは0円groupをsettleせず、所有解消後に同じoperationIdで再試行できる", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    reserve(ctx, "alice");

    const first = ctx.flow.redeemFreeChips("alice", "leave-1", "退場");
    expect(first).toMatchObject({ redeemed: 0, skipped: "active_ownership" });
    // 0円のgroupが確定していると、以後この鍵は永久に「返還済み(0円)」を返す
    expect(ctx.chipTx.hasGroup("chip:free-redeem:alice:leave-1")).toBe(false);

    ctx.db.prepare("DELETE FROM casino_house_reservations WHERE user_id='alice'").run();
    const second = ctx.flow.redeemFreeChips("alice", "leave-1", "退場");
    expect(second.redeemed).toBe(100);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    ctx.db.close();
  });

  it("外側確認の後・内側確認の前に所有が生まれても、groupごと巻き戻って再試行できる", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);

    // 外側の hasActiveOwnership を通過した直後、group の本体が走る前に所有が生まれる
    // 競合をこの窓で正確に再現する
    const originalRunGroup = ctx.chips.runGroup.bind(ctx.chips);
    const spy = vi.spyOn(ctx.chips, "runGroup").mockImplementation(((input: { groupKey: string }, body: () => unknown) => {
      if (input.groupKey.startsWith("chip:free-redeem:alice")) reserve(ctx, "alice");
      return originalRunGroup(input as never, body as never);
    }) as never);

    const result = ctx.flow.redeemInactive(Math.floor(Date.now() / 1000) + 60, "idle");
    spy.mockRestore();

    expect(result.redeemed).toEqual([]);
    expect(result.skipped).toEqual([{ userId: "alice", amount: 100, reason: "active_ownership" }]);
    // 資金は1 Ldも動かず、groupも残らない
    expect(ctx.assets.freeChips("alice")).toBe(100);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(0);
    ctx.db.close();
  });

  it("既に確定済みの操作は、所有が生まれた後でもreplayで同じ結果を返す", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    expect(ctx.flow.redeemFreeChips("alice", "leave-1", "退場").redeemed).toBe(100);
    reserve(ctx, "alice");
    // 確定済みの鍵は skip ではなく保存済みの結果を返す（資金は動かない）
    const replayed = ctx.flow.redeemFreeChips("alice", "leave-1", "退場");
    expect(replayed.redeemed).toBe(100);
    expect(replayed.skipped).toBeUndefined();
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    ctx.db.close();
  });
});

// ── ブロッカーB: 一人の失敗を全体へ波及させない ───────────────────────────

describe("PR10監査B: 失敗の隔離", () => {
  it("中央の利用者のassets例外で全体が抜けず、前後は処理され失敗者だけfailedへ残る", () => {
    const ctx = setup();
    for (const id of ["aaa", "mmm", "zzz"]) fund(ctx, id, 100);

    const original = ctx.assets.freeChips.bind(ctx.assets);
    vi.spyOn(ctx.assets, "freeChips").mockImplementation((userId: string) => {
      if (userId === "mmm") throw new Error("corrupt balance row");
      return original(userId);
    });

    const result = ctx.flow.redeemAllFreeChips("startup");
    vi.restoreAllMocks();

    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["aaa", "zzz"]);
    expect(result.failed).toEqual([
      { userId: "mmm", amount: 100, error: expect.stringContaining("corrupt balance row") },
    ]);
    expect(ctx.ledger.balanceOf("user:aaa")).toBe(100);
    expect(ctx.ledger.balanceOf("user:zzz")).toBe(100);
    ctx.db.close();
  });

  it("catch内のevent記録が例外でも、資金処理結果と後続の利用者を失わない", () => {
    const ctx = setup();
    for (const id of ["aaa", "mmm", "zzz"]) fund(ctx, id, 100);

    const originalAssets = ctx.assets.freeChips.bind(ctx.assets);
    vi.spyOn(ctx.assets, "freeChips").mockImplementation((userId: string) => {
      if (userId === "mmm") throw new Error("corrupt balance row");
      return originalAssets(userId);
    });
    // 監査記録そのものが落ちる状況。ここで例外が外へ出るとループ全体が抜ける
    vi.spyOn(ctx.events, "log").mockImplementation(((name: string) => {
      if (name === "casino_free_chips_redeem_failed") throw new Error("event log is broken");
      return undefined;
    }) as never);

    const result = ctx.flow.redeemAllFreeChips("startup");
    vi.restoreAllMocks();

    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["aaa", "zzz"]);
    expect(result.failed.map((entry) => entry.userId)).toEqual(["mmm"]);
    // 候補取得時に固定した額を使うので、破損した残高の再読込には依存しない
    expect(result.failed[0]?.amount).toBe(100);
    ctx.db.close();
  });

  it("Land利用者口座を持たないholderは候補集合から外れる（推測で資産へ配らない）", () => {
    const ctx = setup();
    for (const id of ["aaa", "mmm", "zzz"]) fund(ctx, id, 100);
    ctx.db.prepare("UPDATE accounts SET kind='system' WHERE id='user:mmm'").run();

    const result = ctx.flow.redeemAllFreeChips("startup");
    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["aaa", "zzz"]);
    expect(result.failed).toEqual([]);
    expect(ctx.chips.balanceOf("mmm")).toBe(100);
    ctx.db.close();
  });
});

// ── 冪等キーの状態識別力 ──────────────────────────────────────────────

describe("PR10監査: 冪等キー", () => {
  it("同じ秒・同じ額でも、別の資金状態なら別キーになり実際に返還される", () => {
    const ctx = setup();
    fund(ctx, "alice", 300, 100);
    const fixedNow = Math.floor(Date.now() / 1000);

    // 1回目: 100 を返還
    expect(ctx.flow.redeemAllFreeChips("startup").redeemed[0]?.redeemed).toBe(100);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(300);

    // 同じ秒のうちに同額を預け直す（updated_at は秒精度なので時刻では区別できない）
    ctx.chips.deposit("alice", 100, "redeposit:alice");
    const updatedAt = ctx.db
      .prepare("SELECT updated_at FROM ether_balances WHERE user_id='alice'")
      .get() as { updated_at: number };
    expect(updatedAt.updated_at).toBeLessThanOrEqual(fixedNow + 2);

    // 2回目: 時刻ベースの鍵だと replay されて資金が動かない
    const second = ctx.flow.redeemAllFreeChips("startup");
    expect(second.redeemed[0]?.redeemed).toBe(100);
    expect(ctx.assets.freeChips("alice")).toBe(0);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(300);
    ctx.db.close();
  });

  it("同一operationIdで異なるrequiredの自動預入はconflictで拒否する", () => {
    const ctx = setup();
    fund(ctx, "alice", 1_000, 0);
    expect(ctx.flow.ensureFreeChips("alice", 100, "op-1")).toMatchObject({ deposited: 100, freeAfter: 100 });
    // 同じ鍵で別の額を要求すると、保存済みの結果が「満たされている」と誤読される
    expect(() => ctx.flow.ensureFreeChips("alice", 500, "op-1")).toThrow(/operation conflict/);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    ctx.db.close();
  });

  it("同一operationId・同一requiredの再実行は二重預入しない", () => {
    const ctx = setup();
    fund(ctx, "alice", 1_000, 0);
    ctx.flow.ensureFreeChips("alice", 100, "op-1");
    ctx.flow.ensureFreeChips("alice", 100, "op-1");
    expect(ctx.assets.freeChips("alice")).toBe(100);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(900);
    ctx.db.close();
  });

  it("同一operationIdを別利用者が使ってもgroupが分かれ、混線しない", () => {
    const ctx = setup();
    fund(ctx, "alice", 1_000, 0);
    fund(ctx, "bob", 1_000, 0);
    ctx.flow.ensureFreeChips("alice", 100, "shared-op");
    ctx.flow.ensureFreeChips("bob", 100, "shared-op");
    expect(ctx.assets.freeChips("alice")).toBe(100);
    expect(ctx.assets.freeChips("bob")).toBe(100);
    ctx.db.close();
  });

  it("区切り文字を注入したoperationIdは鍵を壊す前に拒否する", () => {
    const ctx = setup();
    fund(ctx, "alice", 1_000, 0);
    expect(() => ctx.flow.ensureFreeChips("alice", 100, "a:b")).toThrow(/must not contain/);
    expect(() => ctx.flow.ensureFreeChips("alice", 100, "")).toThrow(/required/);
    ctx.db.close();
  });
});

// ── 活動記録と対象集合 ────────────────────────────────────────────────

describe("PR10監査: 無操作返還の対象集合", () => {
  it("activity行が無い自由チップ保有者も残高更新時刻で対象になる", () => {
    const ctx = setup();
    fund(ctx, "legacy", 100);
    // PR10 以前からの残高保有者を再現する
    ctx.db.prepare("DELETE FROM casino_chip_activity WHERE user_id='legacy'").run();
    expect(ctx.flow.lastActiveAt("legacy")).toBeNull();

    const result = ctx.flow.redeemInactive(Math.floor(Date.now() / 1000) + 60, "idle");
    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["legacy"]);
    expect(ctx.ledger.balanceOf("user:legacy")).toBe(100);
    ctx.db.close();
  });

  it("house・JP・relief・quarantine・system holderは候補に入らない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    const systemHolders = [
      "house",
      "jackpot",
      "sys:casino:relief",
      "sys:casino:quarantine",
      "sys:casino:free-spin-jp-claims",
      "sys:escrow:casino",
      "escrow:session:live",
    ];
    for (const holder of systemHolders) {
      ctx.db.prepare(
        "INSERT INTO ether_balances (user_id,amount,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET amount=excluded.amount",
      ).run(holder, 5_000, 0);
    }

    const result = ctx.flow.redeemAllFreeChips("startup");
    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["alice"]);
    for (const holder of systemHolders) {
      expect(ctx.chips.balanceOf(holder)).toBe(5_000);
    }
    ctx.db.close();
  });

  it("他人の預託や帳簿の無い孤児残高を本人資産として返さない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    // Land 利用者口座を持たない孤児 holder
    ctx.db.prepare("INSERT INTO ether_balances (user_id,amount,updated_at) VALUES ('orphan-999',7_000,0)").run();
    const result = ctx.flow.redeemAllFreeChips("startup");
    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["alice"]);
    expect(ctx.chips.balanceOf("orphan-999")).toBe(7_000);
    ctx.db.close();
  });
});

// ── scheduler 停止条件 ──────────────────────────────────────────────

describe("PR10監査: 停止状態", () => {
  it("chip group処理中は資金を動かさず、全体停止として構造化して返す", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    const result = ctx.flow.redeemInactive(Math.floor(Date.now() / 1000) + 60, "idle", {
      processingGroup: () => true,
    });
    expect(result.redeemed).toEqual([]);
    expect(result.skipped).toEqual([{ userId: null, amount: 0, reason: "chip_group_active" }]);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    ctx.db.close();
  });

  it("検算停止中は1 Ldも動かさない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    const result = ctx.flow.redeemAllFreeChips("startup", { integrityBlocked: () => true });
    expect(result.skipped).toEqual([{ userId: null, amount: 0, reason: "integrity_blocked" }]);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    ctx.db.close();
  });
});

// ── process-local seat ─────────────────────────────────────────────

describe("PR10監査: プロセス内着席", () => {
  it("着席中は確認票を作らせない", () => {
    const seated = new Set(["alice"]);
    const ctx = setup({ isSeatOccupied: (userId) => seated.has(userId) });
    fund(ctx, "alice", 100, 10);

    expect(() => ctx.flow.createExternalConfirmation({
      id: "c-seat",
      userId: "alice",
      operationKind: "shop",
      operationId: "op",
      requiredLand: 10,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })).toThrow(/進行中/);
    ctx.db.close();
  });

  it("作成後に着席したら実行を拒否し、自由チップをLandへ戻さない", () => {
    const seated = new Set<string>();
    const ctx = setup({ isSeatOccupied: (userId) => seated.has(userId) });
    fund(ctx, "alice", 200, 100);

    ctx.flow.createExternalConfirmation({
      id: "c-seat2",
      userId: "alice",
      operationKind: "shop",
      operationId: "op",
      requiredLand: 100,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    seated.add("alice");

    expect(() => ctx.flow.executeExternalConfirmation("c-seat2", "alice", () => "done")).toThrow(/進行中/);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    expect(ctx.flow.externalConfirmation("c-seat2")?.status).toBe("pending");

    // 席を降りれば安全に再試行できる
    seated.delete("alice");
    expect(ctx.flow.executeExternalConfirmation("c-seat2", "alice", () => "done")).toBe("done");
    expect(ctx.assets.freeChips("alice")).toBe(0);
    ctx.db.close();
  });

  it("着席中の利用者は無操作返還・緊急返還の対象にならない", () => {
    const ctx = setup({ isSeatOccupied: (userId) => userId === "alice" });
    fund(ctx, "alice", 100);
    fund(ctx, "bob", 100);
    const result = ctx.flow.redeemAllFreeChips("startup");
    expect(result.redeemed.map((entry) => entry.userId)).toEqual(["bob"]);
    expect(result.skipped).toEqual([{ userId: "alice", amount: 100, reason: "active_ownership" }]);
    ctx.db.close();
  });
});

// ── 域外確認票 ─────────────────────────────────────────────────────

describe("PR10監査: 域外確認票", () => {
  it("返還しても不足するなら確認票を作らない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100, 10);

    expect(() => ctx.flow.createExternalConfirmation({
      id: "c-short",
      userId: "alice",
      operationKind: "shop",
      operationId: "op",
      requiredLand: 500,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    })).toThrow(/不足/);
    expect(ctx.assets.freeChips("alice")).toBe(10);
    ctx.db.close();
  });

  it("旧DB由来の chip_amount=0 な生存中確認票を正常扱いしない", () => {
    const ctx = setup();
    fund(ctx, "alice", 200, 100);
    // 旧DBは chip_amount を ensureColumn（DEFAULT 0）で後付けしているため、
    // CREATE TABLE 側の CHECK(chip_amount > 0) が効いていない行が残りうる
    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare(
      `INSERT INTO casino_chip_external_confirmations
       (id,user_id,operation_kind,operation_id,required_land,chip_amount,status,created_at,expires_at)
       VALUES ('legacy0','alice','shop','op',100,0,'pending',0,?)`,
    ).run(Math.floor(Date.now() / 1000) + 600);
    ctx.db.pragma("ignore_check_constraints = OFF");

    expect(() => ctx.flow.externalConfirmation("legacy0")).toThrow(/not verifiable/);
    expect(() => ctx.flow.executeExternalConfirmation("legacy0", "alice", () => "done")).toThrow(/not verifiable/);
    ctx.db.close();
  });

  it("期限切れのexecutingは回収され、永久に触れない行として残らない", () => {
    const ctx = setup();
    fund(ctx, "alice", 200, 100);
    const expires = Math.floor(Date.now() / 1000) + 60;
    ctx.flow.createExternalConfirmation({
      id: "c-stale",
      userId: "alice",
      operationKind: "shop",
      operationId: "op",
      requiredLand: 100,
      expiresAt: expires,
    });
    // 返還だけ済んで元操作が落ちた状態
    expect(() => ctx.flow.executeExternalConfirmation("c-stale", "alice", () => {
      throw new Error("shop failed");
    })).toThrow("shop failed");
    expect(ctx.flow.externalConfirmation("c-stale")?.status).toBe("executing");
    // 返還は済んでいる（Land 100 + 返還 100）
    expect(ctx.ledger.balanceOf("user:alice")).toBe(200);
    expect(ctx.assets.freeChips("alice")).toBe(0);

    const reaped = ctx.flow.expireStaleConfirmations(expires + 1);
    expect(reaped.executing).toBe(1);
    expect(ctx.flow.externalConfirmation("c-stale")?.status).toBe("expired");
    // 資金は Land 側にあり、失われていない
    expect(ctx.ledger.balanceOf("user:alice")).toBe(200);
    ctx.db.close();
  });

  it("別利用者は他人の確認票を実行・取消できない", () => {
    const ctx = setup();
    fund(ctx, "alice", 200, 100);
    ctx.flow.createExternalConfirmation({
      id: "c-owner",
      userId: "alice",
      operationKind: "shop",
      operationId: "op",
      requiredLand: 100,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    expect(() => ctx.flow.executeExternalConfirmation("c-owner", "bob", () => "done")).toThrow();
    expect(ctx.flow.cancelExternalConfirmation("c-owner", "bob")).toBe(false);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    ctx.db.close();
  });
});

// ── 緊急返還 saga ───────────────────────────────────────────────────

describe("PR10監査: 緊急返還saga", () => {
  function draft(ctx: Ctx, id = "saga-1") {
    return ctx.flow.createRefundSaga({ id, requestedBy: "user:admin", scope: "all" });
  }

  it("draft作成は資金を1 Ldも動かさない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    const before = ctx.assets.freeChips("alice");
    const saga = draft(ctx);
    expect(saga.status).toBe("draft");
    expect(saga.targetTotal).toBe(100);
    expect(ctx.assets.freeChips("alice")).toBe(before);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(0);
    ctx.db.close();
  });

  it("未知statusのsagaは資金を動かさず停止する", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    draft(ctx);
    ctx.db.pragma("ignore_check_constraints = ON");
    ctx.db.prepare("UPDATE casino_chip_refund_sagas SET status='weird' WHERE id='saga-1'").run();
    ctx.db.pragma("ignore_check_constraints = OFF");

    expect(() => ctx.flow.executeRefundSaga("saga-1", "user:admin")).toThrow(/corrupt saga.status/);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    ctx.db.close();
  });

  it("破損した数値・不正JSONをfail-closedにする", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    draft(ctx, "saga-num");
    ctx.db.prepare("UPDATE casino_chip_refund_sagas SET target_total=9007199254740993 WHERE id='saga-num'").run();
    expect(() => ctx.flow.refundSaga("saga-num")).toThrow(/corrupt saga.target_total/);

    ctx.db.prepare("UPDATE casino_chip_refund_sagas SET target_total=100 WHERE id='saga-num'").run();
    ctx.db.prepare("UPDATE casino_chip_refund_saga_targets SET result_json='{oops' WHERE saga_id='saga-num'").run();
    expect(() => ctx.flow.refundSaga("saga-num")).toThrow(/corrupt saga_target.result_json/);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    ctx.db.close();
  });

  it("依頼者以外は実行も取消もできない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    draft(ctx);
    expect(() => ctx.flow.executeRefundSaga("saga-1", "user:other")).toThrow();
    expect(ctx.flow.cancelRefundSaga("saga-1", "user:other")).toBe(false);
    expect(ctx.assets.freeChips("alice")).toBe(100);
    ctx.db.close();
  });

  it("取消済みsagaは実行できず、二重実行でも二重返還しない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    draft(ctx, "saga-x");
    expect(ctx.flow.cancelRefundSaga("saga-x", "user:admin")).toBe(true);
    expect(() => ctx.flow.executeRefundSaga("saga-x", "user:admin")).toThrow();
    expect(ctx.assets.freeChips("alice")).toBe(100);

    draft(ctx, "saga-y");
    expect(ctx.flow.executeRefundSaga("saga-y", "user:admin").status).toBe("completed");
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    // 同じsagaをもう一度実行しても資金は動かない
    expect(ctx.flow.executeRefundSaga("saga-y", "user:admin").status).toBe("completed");
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    ctx.db.close();
  });

  it("draft作成後に残高が変わったsagaは、誰にも返さずblockedにする", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    fund(ctx, "bob", 200, 100);
    draft(ctx, "saga-stale");
    ctx.chips.deposit("bob", 50, "extra:bob");

    const saga = ctx.flow.executeRefundSaga("saga-stale", "user:admin");
    expect(saga.status).toBe("blocked");
    // 一件でも stale なら誰の資金も動かさない
    expect(ctx.assets.freeChips("alice")).toBe(100);
    expect(ctx.assets.freeChips("bob")).toBe(150);
    ctx.db.close();
  });

  it("進行中所有の利用者が混ざっていれば全体を止める", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    fund(ctx, "bob", 100);
    draft(ctx, "saga-active");
    reserve(ctx, "bob");

    const saga = ctx.flow.executeRefundSaga("saga-active", "user:admin");
    expect(saga.status).toBe("blocked");
    expect(ctx.assets.freeChips("alice")).toBe(100);
    expect(ctx.assets.freeChips("bob")).toBe(100);
    ctx.db.close();
  });

  it("クラッシュ後の再実行で完了済みtargetを二重返還しない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    fund(ctx, "bob", 100);
    draft(ctx, "saga-crash");

    // alice の返還グループだけ確定し、saga 側の記録は pending のまま落ちた状態
    const target = ctx.flow.refundSaga("saga-crash")!.targets.find((t) => t.userId === "alice")!;
    ctx.flow.redeemExactFreeChips("alice", 100, `emergency:saga-crash:alice`, "緊急返還", true);
    expect(target.status).toBe("pending");
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);

    const saga = ctx.flow.executeRefundSaga("saga-crash", "user:admin");
    expect(saga.status).toBe("completed");
    // alice は replay されるだけ。二重に Land は増えない
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(100);
    ctx.db.close();
  });
});

// ── 復旧の複合失敗 ──────────────────────────────────────────────────

describe("PR10監査: S10と復旧完了条件", () => {
  it("S10成功後にpostflightが例外でも、返還済みの部分結果を失わない", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    vi.spyOn(ctx.integrity, "runFull").mockImplementation(() => {
      throw new Error("postflight exploded");
    });

    const result = ctx.run();
    vi.restoreAllMocks();

    expect(result.outcome).toBe("exception_failed");
    // 実際に動いた資金の記録を catch で空へ戻さない
    expect(result.redeemedFreeChips.redeemed.map((entry) => entry.userId)).toEqual(["alice"]);
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    expect(ctx.status.current().status).toBe("recovery_halt");
    ctx.db.close();
  });

  it("S10失敗とpostflight NGが同時なら、両方の義務を理由へ残す", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    const original = ctx.assets.freeChips.bind(ctx.assets);
    vi.spyOn(ctx.assets, "freeChips").mockImplementation((userId: string) => {
      if (userId === "alice") throw new Error("corrupt balance row");
      return original(userId);
    });
    vi.spyOn(ctx.integrity, "runFull").mockReturnValue({
      ok: false,
      ledger: { ok: true, detail: "" },
      checks: [{ id: "C", name: "エスクロー突合", ok: false, detail: "不一致1件" }],
      failed: ["C"],
      checkedAt: 0,
    } as never);

    const result = ctx.run();
    vi.restoreAllMocks();

    expect(result.outcome).toBe("chip_redeem_failed");
    expect(result.reason).toContain("S10自由チップ返還失敗");
    // 優先順位の低い義務が報告から消えない
    expect(result.reason).toContain("後検NG");
    expect(ctx.status.current().status).toBe("recovery_halt");
    ctx.db.close();
  });

  it("S10でskipが残っても、未返還額が構造化して残る", () => {
    // S9 が予約を全解放するため、S10 まで残る所有としてプロセス内着席を使う
    const ctx = setup({ isSeatOccupied: (userId) => userId === "bob" });
    fund(ctx, "alice", 100);
    fund(ctx, "bob", 100);

    const result = ctx.run();
    expect(result.redeemedFreeChips.redeemed.map((entry) => entry.userId)).toEqual(["alice"]);
    expect(result.redeemedFreeChips.skipped).toEqual([
      { userId: "bob", amount: 100, reason: "active_ownership" },
    ]);
    expect(ctx.assets.freeChips("bob")).toBe(100);
    ctx.db.close();
  });

  it("recovery_haltからの再実行で、成功者は二重返還されず失敗者だけ再試行される", () => {
    const ctx = setup();
    fund(ctx, "alice", 100);
    fund(ctx, "bob", 100);

    const original = ctx.assets.freeChips.bind(ctx.assets);
    const spy = vi.spyOn(ctx.assets, "freeChips").mockImplementation((userId: string) => {
      if (userId === "bob") throw new Error("corrupt balance row");
      return original(userId);
    });
    expect(ctx.run().outcome).toBe("chip_redeem_failed");
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    spy.mockRestore();

    const retry = ctx.run();
    // alice は replay、bob だけが新しく返る
    expect(ctx.ledger.balanceOf("user:alice")).toBe(100);
    expect(ctx.ledger.balanceOf("user:bob")).toBe(100);
    expect(retry.redeemedFreeChips.failed).toEqual([]);
    ctx.db.close();
  });
});
