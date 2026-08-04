/**
 * PR11 本監査の敵対的テスト。
 *
 * ユーザー指定の3論点を直接検証する。
 * 1. `2 × bet` の session escrow 移動と、所有権・round記録の原子性（crash window）
 * 2. prehold が active ownership・CasinoChipAssets・check C/D・RecoveryRegistry・S10 で
 *    「既存の卓預託と同じ所有集合」として扱われること（専用テーブルを増やしていないことの証明）
 * 3. Discord 表示失敗と資金状態の分離（精算済み資金を表示失敗で再精算・返還しない）
 */
import { describe, expect, it, vi } from "vitest";
import {
  Casino,
  CasinoChipAssets,
  CasinoChipFlow,
  CasinoIntegrity,
  CasinoStatus,
  ChipLedger,
  ChipTx,
  Escrow,
  EventLog,
  FORMAL_OPENING_VERSION,
  CHIP_ESCROW,
  HOUSE_HOLDER,
  HouseReservations,
  Items,
  Ledger,
  RecoveryRegistry,
  TREASURY,
  chinchiroMaxPlayerLoss,
  openDb,
  recoverCasino,
  registerDefaultTxTypes,
  scriptedRng,
  type CasinoRng,
} from "@meigokujo/core";
import type { Services } from "../src/services.js";
import {
  ChinchiroPreholdError,
  beginChinchiroPrehold,
  chinchiroPreholdSessionId,
  refundChinchiroPreholdOnFailure,
  settleChinchiroRound,
} from "../src/casino/chinchiro.js";

registerDefaultTxTypes();

function setup(rng: CasinoRng = scriptedRng([0.5])) {
  const db = openDb(":memory:");
  const ledger = new Ledger(db);
  const events = new EventLog(db);
  const chipTx = new ChipTx(db);
  const chips = new ChipLedger(db, ledger, events, { chipTx });
  chipTx.captureOpening(FORMAL_OPENING_VERSION, [], {
    poolLand: ledger.balanceOf(CHIP_ESCROW),
    fromLedgerTxId: ledger.lastTransactionId(),
  });
  const items = new Items(db);
  const reservations = new HouseReservations(db, chips, events);
  chips.setReservedProvider((holderId) => (holderId === HOUSE_HOLDER ? reservations.totalReserved() : 0));
  const escrow = new Escrow(db, chips, events);
  const casino = new Casino(db, chips, events, { items, reservations });
  const chipAssets = new CasinoChipAssets(db, chips);
  const chipFlow = new CasinoChipFlow(db, chips, events, chipAssets);
  const integrity = new CasinoIntegrity(db, ledger, chips, escrow, chipAssets);
  const status = new CasinoStatus(db);
  const registry = new RecoveryRegistry();
  registry.register({ type: "market", listLiveEscrowHolders: () => [] });
  const services = {
    db, ledger, events, chipTx, chips, ether: chips, items, reservations, escrow, casino,
    chipAssets, chipFlow, rng,
  } as unknown as Services;
  const runRecovery = () =>
    recoverCasino({ db, status, integrity, chipTx, escrow, reservations, registry, events, chipFlow });
  return { db, ledger, chipTx, chips, escrow, casino, chipAssets, chipFlow, integrity, status, services, runRecovery };
}

type Ctx = ReturnType<typeof setup>;

function fund(ctx: Ctx, uid: string, land: number, chips = land): void {
  ctx.ledger.ensureAccount(`user:${uid}`, "user");
  ctx.ledger.transfer({ from: TREASURY, to: `user:${uid}`, amount: land, type: "initial", actor: "test", idempotencyKey: `seed:${uid}` });
  if (chips > 0) ctx.chips.deposit(uid, chips, `deposit:${uid}`);
}

/** 監査経路を通さず house へ配当原資を積む（テストの下ごしらえ専用） */
function fundHouse(ctx: Ctx, amount = 1_000_000): void {
  ctx.db
    .prepare(
      "INSERT INTO ether_balances (user_id, amount, updated_at) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET amount = excluded.amount",
    )
    .run(HOUSE_HOLDER, amount);
}

// ── 論点1: session escrow 移動と所有権・round記録の原子性 ──────────────

describe("PR11監査1: crash windowの原子性", () => {
  it("hold成功後に決着前で例外が起きても、資金は1 Ldも動かず同じ鍵で再開できる", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const holder = ctx.escrow.holderId(sessionId);
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);

    // 決着前の失敗（Discordのタイムアウト・中止など）をシミュレート
    const beforeSettle = new Error("collector timeout");
    expect(() => refundChinchiroPreholdOnFailure(ctx.services, sessionId, beforeSettle)).toThrow("collector timeout");

    // 事前預託が丸ごと利用者へ返っている。house は1 Ldも受け取っていない
    expect(ctx.chips.balanceOf("u1")).toBe(2_000);
    expect(ctx.chips.balanceOf(holder)).toBe(0);
    expect(ctx.escrow.list(sessionId)).toEqual([]);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
  });

  it("settle()の内部で例外が起きたら、bet徴収を含めグループごと巻き戻る", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fundHouse(ctx);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const holder = ctx.escrow.holderId(chinchiroPreholdSessionId("u1", "op-1"));
    const houseBefore = ctx.chips.balanceOf(HOUSE_HOLDER);

    // settle() が bet を徴収した直後、連鎖ボーナス計算より前で例外を注入する
    const spy = vi.spyOn(ctx.casino, "recordGameNet" as never);
    const originalTransfer = ctx.chips.transfer.bind(ctx.chips);
    let calls = 0;
    const transferSpy = vi.spyOn(ctx.chips, "transfer").mockImplementation((...args: Parameters<typeof ctx.chips.transfer>) => {
      calls++;
      if (calls === 1) return originalTransfer(...args); // 賭け金の徴収は通す
      throw new Error("injected failure after bet collected");
    });

    expect(() => settleChinchiroRound(ctx.services, "u1", 1_000, 1, "op-1")).toThrow("injected failure");
    transferSpy.mockRestore();
    spy.mockRestore();

    // bet の徴収も含めて、グループ全体が巻き戻っている
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(houseBefore);
    expect(ctx.chipTx.getGroup("chinchiro:round:u1:op-1")).toBeUndefined();

    // 再試行すれば正常に決着する
    const retried = settleChinchiroRound(ctx.services, "u1", 1_000, 1, "op-1");
    expect(retried.branch).toBe("win");
    expect(ctx.chips.balanceOf(holder)).toBe(0);
  });

  it("casino_escrowの帳簿額が事前預託の期待値と食い違っていたら、資金を動かさず例外にする", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    // 帳簿（casino_escrow）だけを書き換える。想定外の乖離（何らかの理由で
    // 台帳と主張額がずれた状態）を再現する
    ctx.db.prepare("UPDATE casino_escrow SET amount = amount - 100 WHERE session_id = ?").run(sessionId);

    expect(() => settleChinchiroRound(ctx.services, "u1", 1_000, 1, "op-1")).toThrow(/帳簿不一致/);
    // 例外前に資金が1 Ldも動いていない
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(sessionId))).toBe(2_000);
  });

  it("台帳は一致していてもholderの実残高がbetに届かなければ、settle()自身がfail-closedで止める", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const holder = ctx.escrow.holderId(sessionId);
    // casino_escrow の帳簿は 2,000 のまま（settleChinchiroRound の pool チェックは通る）。
    // holder の実残高だけ bet(1,000) に届かないところまで壊す。settle() 自身の
    // holder残高==expectedAmount の完全照合が「balance mismatch」として検出する
    // （betとの比較まで届く前に、より厳密な一致チェックで先に落ちる）
    ctx.db.prepare("UPDATE ether_balances SET amount = 500 WHERE user_id = ?").run(holder);

    expect(() => settleChinchiroRound(ctx.services, "u1", 1_000, -1, "op-1")).toThrow(/holder balance mismatch/);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(0);
    expect(ctx.chips.balanceOf(holder)).toBe(500);
  });

  it("同じoperationIdでの事前預託は二重に徴収しない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    // 同じ操作の再試行（Discordの再送などを想定）
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(sessionId))).toBe(2_000);
  });
});

// ── 論点2: prehold が既存の所有集合と同じ扱いを受ける ────────────────

describe("PR11監査2: prehold は既存の所有・検算・復旧の仕組みだけで拾われる", () => {
  it("prehold中はhasActiveOwnership経由で自由チップ返還の対象から自動的に外れる", () => {
    const ctx = setup();
    // 事前預託(2,000)ぶんを超える自由チップも持たせる。prehold中の利用者が
    // 「返還候補にすら挙がらない（残高0）」のではなく「候補だが所有中でskipされる」
    // ことを見るため、prehold後もfreeChips>0が残るようにする
    fund(ctx, "u1", 3_000);
    fund(ctx, "u2", 500);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    expect(ctx.chips.balanceOf("u1")).toBe(1_000);

    // PR10 の自由チップ返還（10分無操作・起動時等）。専用の除外コードを一切足していない
    const result = ctx.chipFlow.redeemAllFreeChips("test");
    expect(result.redeemed.map((r) => r.userId)).toEqual(["u2"]);
    expect(result.skipped).toEqual([{ userId: "u1", amount: 1_000, reason: "active_ownership" }]);
    // u1 の自由チップ（prehold外の1,000）はskipされ、動いていない
    expect(ctx.chips.balanceOf("u1")).toBe(1_000);
  });

  it("CasinoChipAssetsのescrowedにprehold額が正しく計上され、totalが保存される", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    const before = ctx.chipAssets.forUser("u1");
    expect(before).toEqual({ userId: "u1", freeChips: 2_000, escrowed: 0, total: 2_000 });

    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const during = ctx.chipAssets.forUser("u1");
    expect(during).toEqual({ userId: "u1", freeChips: 0, escrowed: 2_000, total: 2_000 });
  });

  it("prehold中もcheckC・checkDが正常のまま通る（孤児・不一致として誤検出しない）", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");

    const checkC = ctx.integrity.checkC();
    const checkD = ctx.integrity.checkD();
    expect(checkC.ok).toBe(true);
    expect(checkD.ok).toBe(true);
  });

  it("他人のprehold escrowを自分の資産として計上しない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fund(ctx, "u2", 500);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");

    const u2 = ctx.chipAssets.forUser("u2");
    expect(u2).toEqual({ userId: "u2", freeChips: 500, escrowed: 0, total: 500 });
  });

  it("起動時復旧: 決着前にプロセスが落ちたprehold(登録されていないセッション)は孤児として自動返金される", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const holder = ctx.escrow.holderId(chinchiroPreholdSessionId("u1", "op-1"));
    expect(ctx.chips.balanceOf(holder)).toBe(2_000);

    // Bot再起動を模す。チンチロのprehold sessionはRecoveryRegistryに登録されていない
    // ＝生存を申告する経路が無いので、既存のS4-S9がそのまま孤児として扱い自動返金する。
    // 専用の復旧コードをPR11で足す必要がないことの証明。
    // （返った先は一旦「利用者の自由チップ」。formal openingではS10が続けてLandへ
    //  戻すので、その最終着地はPR11監査2の別テストで検証する）
    const result = ctx.runRecovery();
    expect(result.outcome).toBe("opened");
    expect(ctx.chips.balanceOf(holder)).toBe(0);
    expect(ctx.escrow.list(chinchiroPreholdSessionId("u1", "op-1"))).toEqual([]);
  });

  it("起動時復旧のS10は、決着前のprehold中利用者の自由チップを二重に扱わない", () => {
    // S7（孤児返金）でprehold escrowが利用者の自由チップへ戻った後、
    // 同じ復旧パスのS10（自由チップ返還）がそれをもう一度動かしていないか確認する
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");

    const result = ctx.runRecovery();
    expect(result.outcome).toBe("opened");
    // S7 で escrow から自由チップへ戻った 2,000 が、S10 でさらに Land へ返還されている
    // （S10 は「自由チップ→Land」なので、これは二重処理ではなく正しい直列処理）
    expect(ctx.ledger.balanceOf("user:u1")).toBe(2_000);
    expect(ctx.chips.balanceOf("u1")).toBe(0);
  });
});

// ── 論点3: Discord表示失敗と資金状態の分離 ────────────────────────

describe("PR11監査3: 表示失敗と資金状態の分離", () => {
  it("精算成功後の表示失敗はrefundを再実行させない（no-op）", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const round = settleChinchiroRound(ctx.services, "u1", 1_000, -1, "op-1");
    expect(round.branch).toBe("loss");
    const balanceAfterSettle = ctx.chips.balanceOf("u1");
    const houseAfterSettle = ctx.chips.balanceOf(HOUSE_HOLDER);
    expect(ctx.escrow.list(sessionId)).toEqual([]);

    // 精算後、結果画面の表示（broadcastBigWin・reply.edit等）が例外を投げた状況を再現
    const displayError = new Error("reply.edit failed");
    expect(() => refundChinchiroPreholdOnFailure(ctx.services, sessionId, displayError)).toThrow("reply.edit failed");

    // 資金は1 Ldも動いていない（refundは空セッションに対するno-op）
    expect(ctx.chips.balanceOf("u1")).toBe(balanceAfterSettle);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(houseAfterSettle);
  });

  it("勝ちの表示失敗でも配当を再送金しない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    fundHouse(ctx);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const round = settleChinchiroRound(ctx.services, "u1", 1_000, 1, "op-1");
    expect(round.branch).toBe("win");
    const balanceAfterWin = ctx.chips.balanceOf("u1");

    expect(() => refundChinchiroPreholdOnFailure(ctx.services, sessionId, new Error("broadcastBigWin failed"))).toThrow();
    expect(ctx.chips.balanceOf("u1")).toBe(balanceAfterWin);
  });

  it("倍付け負けの表示失敗でも追加損失を再徴収しない", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const round = settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1");
    expect(round.branch).toBe("double_loss");
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    const houseAfter = ctx.chips.balanceOf(HOUSE_HOLDER);

    expect(() => refundChinchiroPreholdOnFailure(ctx.services, sessionId, new Error("display failed"))).toThrow();
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(houseAfter);
  });
});

// ── 資金安全: 残高不足フォールバックの禁止・自動預入との整合 ──────────

describe("PR11監査: 資金安全", () => {
  it("Land不足なら資金を1 Ldも動かさずChinchiroPreholdErrorを投げる", () => {
    const ctx = setup();
    fund(ctx, "u1", 500, 500); // 2×1,000=2,000に届かない
    expect(() => beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1")).toThrow(ChinchiroPreholdError);
    expect(ctx.chips.balanceOf("u1")).toBe(500);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(0);
    expect(ctx.escrow.list(chinchiroPreholdSessionId("u1", "op-1"))).toEqual([]);
  });

  it("自由チップ不足だがLandは十分なら、不足分だけ自動預入してから事前預託する", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000, 300); // 自由チップ300、残り1,700はLand
    const sessionId = beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    expect(ctx.chips.balanceOf("u1")).toBe(0);
    expect(ctx.chips.balanceOf(ctx.escrow.holderId(sessionId))).toBe(2_000);
    expect(ctx.ledger.balanceOf("user:u1")).toBe(0); // Landは自動預入で使い切られた
  });

  it("結果後の追加徴収・残高不足フォールバックが存在しない: 倍付け負けは常に全額houseへ確定する", () => {
    const ctx = setup();
    fund(ctx, "u1", 2_000);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-1");
    const round = settleChinchiroRound(ctx.services, "u1", 1_000, -2, "op-1");
    // "fallback_loss" のような分岐自体が型に存在しない（コンパイル時に保証済み）。
    // 実行時にも常に double_loss として確定し、資金は必ず全額動く
    expect(round.branch).toBe("double_loss");
    expect(ctx.chips.balanceOf(HOUSE_HOLDER)).toBe(2_000);
  });

  it("倍率・払戻計算はPR11で変更していない（coreのchinchiroPayout/chinchiroMaxPlayerLossをそのまま使う）", () => {
    const ctx = setup();
    fund(ctx, "u1", 20_000);
    fundHouse(ctx);
    beginChinchiroPrehold(ctx.services, "u1", 1_000, "op-pinzoro");
    const round = settleChinchiroRound(ctx.services, "u1", 1_000, 5, "op-pinzoro"); // ピンゾロ勝ち
    expect(round.settled.rawPayout).toBe(1_000 + Math.floor(1_000 * 5 * (1 - 0.15)));
    expect(chinchiroMaxPlayerLoss(1_000)).toBe(2_000);
  });
});
